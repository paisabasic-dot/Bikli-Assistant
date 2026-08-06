import express from "express";
import http from "http";
import dns from "dns";
import os from "os";
import path from "path";
import { exec, spawn, execSync, execFile } from "child_process";
import { WebSocketServer, WebSocket as WsSocket } from "ws";
import { GoogleGenAI, Type } from "@google/genai";
import dotenv from "dotenv";
import * as fs from "fs";
import {
  loadMemories,
  saveMemories,
  mutateMemories,
  formatSystemInstructionsWithMemories,
  processConversationSlice
} from "./server_memory";
import { Memory } from "./src/lib/memoryTypes";
import {
  APP_ROOT,
  DATA_DIR,
  dataFile,
  getGeminiApiKey,
  getGeminiApiKeySource,
  hasGeminiApiKey,
  setGeminiApiKey,
  clearGeminiApiKey,
  resolveFrozenAgentExe,
} from "./server_paths";
import {
  OFFICE_TOOLS,
  createOfficeFileViaNode,
} from "./server_office";

dotenv.config();

// ---------------------------------------------------------------------------
// Resilience: never let ONE async error take down the whole backend.
// Without these handlers, an unhandled rejection / exception (a Gemini blip,
// a tool timeout, a background memory-consolidation error) crashes the Node
// process and the app shows "BIKLI backend stopped". Log loudly, keep serving.
// ---------------------------------------------------------------------------
process.on("unhandledRejection", (reason) => {
  console.error("[Backend] Unhandled rejection:", reason);
  try {
    const err = reason instanceof Error ? reason : new Error(String(reason));
    logStartup(`UNHANDLED_REJECTION ${err.stack || err.message}`);
  } catch {
    /* logging must never throw */
  }
});
process.on("uncaughtException", (err) => {
  console.error("[Backend] Uncaught exception:", err);
  try {
    logStartup(`UNCAUGHT_EXCEPTION ${err?.stack || err?.message || String(err)}`);
  } catch {
    /* ignore */
  }
});

// ---------------------------------------------------------------------------
// Real Windows user folders (Desktop / Documents / …).
// Fixes the bug where the AI created files under the agent install cwd
// (…\BIKLI\resources\agent\Desktop) instead of the user's real Desktop.
// ---------------------------------------------------------------------------
function resolveRealUserFolder(name: "Desktop" | "Documents" | "Downloads" | "Pictures" | "Music" | "Videos"): string {
  const home = os.homedir();
  const candidates = [
    path.join(home, name),
    process.env.OneDrive ? path.join(process.env.OneDrive, name) : "",
    process.env.OneDriveConsumer ? path.join(process.env.OneDriveConsumer, name) : "",
  ].filter(Boolean);
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return c;
    } catch { /* ignore */ }
  }
  return path.join(home, name);
}

const REAL_USER_FOLDERS: Record<string, string> = {
  desktop: resolveRealUserFolder("Desktop"),
  documents: resolveRealUserFolder("Documents"),
  docs: resolveRealUserFolder("Documents"),
  downloads: resolveRealUserFolder("Downloads"),
  download: resolveRealUserFolder("Downloads"),
  pictures: resolveRealUserFolder("Pictures"),
  photos: resolveRealUserFolder("Pictures"),
  music: resolveRealUserFolder("Music"),
  videos: resolveRealUserFolder("Videos"),
  home: os.homedir(),
  "~": os.homedir(),
};

/**
 * Expand friendly / relative paths to absolute paths under the REAL user
 * profile. "Desktop/notes.txt" → C:\Users\<you>\Desktop\notes.txt
 * Bare "notes.txt" → real Desktop\notes.txt
 * Absolute paths are left unchanged.
 */
function expandUserFacingPath(input: unknown): string {
  if (typeof input !== "string" || !input.trim()) return String(input ?? "");
  let raw = input.trim().replace(/^["']|["']$/g, "");
  // Expand ~
  if (raw === "~" || raw.startsWith("~/") || raw.startsWith("~\\")) {
    raw = path.join(os.homedir(), raw.slice(2));
  }
  // Natural-language drive references → drive root so Explorer can navigate them.
  //   "D" / "D:" / "D drive" / "the D drive" / "drive D"  →  "D:\\"
  // The regex above only matches "D:\\" / "D:/", so bare "D:" and spoken forms
  // used to fall through to Desktop\D drive → "Folder does not exist".
  const driveSpoken = raw.match(/^(?:the\s+)?(?:drive\s+)?([a-zA-Z]):?(?:\s+drive)?$/i);
  if (driveSpoken && driveSpoken[1]) {
    return `${driveSpoken[1].toUpperCase()}:\\`;
  }
  // Absolute Windows / POSIX path — keep as-is (normalize separators only).
  if (path.isAbsolute(raw) || /^[a-zA-Z]:[\\/]/.test(raw) || raw.startsWith("\\\\")) {
    return path.normalize(raw);
  }
  const parts = raw.replace(/\//g, path.sep).split(path.sep).filter((p) => p && p !== ".");
  if (parts.length === 0) return raw;
  const first = parts[0].toLowerCase();
  if (REAL_USER_FOLDERS[first]) {
    return path.join(REAL_USER_FOLDERS[first], ...parts.slice(1));
  }
  // Exact alias only (e.g. path="desktop" for openFolder).
  if (parts.length === 1 && REAL_USER_FOLDERS[first]) {
    return REAL_USER_FOLDERS[first];
  }
  // Bare relative path → real Desktop so it shows up for the user.
  return path.join(REAL_USER_FOLDERS.desktop, ...parts);
}

/** Tools whose path-like args should be rewritten to real user folders. */
const PATH_EXPAND_TOOLS = new Set([
  "createFile", "writeToNotepad", "readFile", "renameFile", "deleteFile", "moveFile",
  "openFolder", "listFiles", "searchFiles", "openLocalImage", "openFile",
  "createPythonFile", "runPythonScript", "createProjectFolder", "writeCodeFile",
  "createWordFile", "createExcelFile", "createPowerPointFile",
]);

/** Per-tool arg keys that hold filesystem paths. */
const PATH_ARGS_BY_TOOL: Record<string, string[]> = {
  createFile: ["path"],
  writeToNotepad: ["path", "filename"],
  readFile: ["path"],
  renameFile: ["path"],
  deleteFile: ["path"],
  moveFile: ["path", "destination"],
  openFolder: ["name", "path"],
  listFiles: ["name", "path"],
  searchFiles: ["folder", "under"],
  openLocalImage: ["folder", "path"], // never expand name — it is a filter string
  openFile: ["path", "folder"],
  createPythonFile: ["path"],
  runPythonScript: ["path"],
  createProjectFolder: ["path", "name"],
  writeCodeFile: ["path"],
  createWordFile: ["path"],
  createExcelFile: ["path"],
  createPowerPointFile: ["path"],
};

/**
 * Rewrite path-like tool arguments so the frozen Python agent always receives
 * absolute real-user paths (never agent-cwd-relative "Desktop/...").
 */
function expandDesktopToolArgs(
  toolName: string,
  args: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  const src = args && typeof args === "object" ? { ...args } : {};
  if (!PATH_EXPAND_TOOLS.has(toolName)) return src;

  const keys = PATH_ARGS_BY_TOOL[toolName] || ["path"];
  for (const key of keys) {
    if (typeof src[key] !== "string") continue;
    const original = src[key] as string;
    const expanded = expandUserFacingPath(original);
    if (expanded !== original) {
      console.log(`[PathFix] ${toolName}.${key}: "${original}" → "${expanded}"`);
      logCommand(`PATH_FIX ${toolName}.${key} "${original}" -> "${expanded}"`);
    }
    src[key] = expanded;
  }
  return src;
}

// ---------------------------------------------------------------------------
// BIKLI V2 — Logging (Feature 7).
// Appends timestamped lines to logs/{commands,startup,errors}.log.
// Never throws; logging failures are swallowed so they can't break the app.
// ---------------------------------------------------------------------------
const LOGS_DIR = path.join(DATA_DIR, "logs");
try { fs.mkdirSync(LOGS_DIR, { recursive: true }); } catch { /* already exists */ }

function appendLog(fileName: string, message: string): void {
  try {
    const line = `[${new Date().toISOString()}] ${message}\n`;
    fs.appendFile(path.join(LOGS_DIR, fileName), line, () => {});
  } catch {
    /* logging is best-effort */
  }
}
/**
 * Blocking variant for fatal paths. The async appendLog above never flushes
 * when the caller follows it with process.exit(), so the one line that explains
 * why BIKLI died was the line that got dropped.
 */
function appendLogSync(fileName: string, message: string): void {
  try {
    fs.appendFileSync(
      path.join(LOGS_DIR, fileName),
      `[${new Date().toISOString()}] ${message}\n`,
    );
  } catch {
    /* logging is best-effort */
  }
}
const logCommand = (m: string) => appendLog("commands.log", m);
const logStartup = (m: string) => appendLog("startup.log", m);
const logError = (m: string) => appendLog("errors.log", m);

// ---------------------------------------------------------------------------
// BIKLI Desktop Control Agent — HTTP bridge to the Python FastAPI backend.
// ---------------------------------------------------------------------------
const DESKTOP_AGENT_URL = process.env.DESKTOP_AGENT_URL || "http://127.0.0.1:8765";
const DESKTOP_AGENT_TIMEOUT = 4_000; // ms — fast background execution

// Rolling window for the per-session dialogue log used by memory extraction.
// Without a cap, a long session re-sends the ENTIRE transcript to Gemini on
// every turn (costly, can blow the context window) and grows memory forever.
const MAX_DIALOGUE_HISTORY = 40;

/** Push a transcript line onto the bounded dialogue window. */
function pushDialogue(
  history: { role: string; text: string }[],
  entry: { role: string; text: string },
): { role: string; text: string }[] {
  const next = [...history, entry];
  return next.length > MAX_DIALOGUE_HISTORY ? next.slice(-MAX_DIALOGUE_HISTORY) : next;
}

/**
 * The complete set of tool names routed to the Python desktop agent.
 * Kept in sync with desktop_agent/registry.py DESKTOP_TOOL_NAMES.
 */
const DESKTOP_TOOLS: ReadonlySet<string> = new Set([
  // applications
  "openApplication", "closeApplication",
  // websites / search — open the user's real default browser (Chrome/Edge).
  // Routed to the Python agent so packaged EXE does not depend on the fragile
  // in-app YouTube search proxy / Playwright Chromium bundle.
  "openWebsite", "searchWeb", "searchYouTube", "searchGoogle", "searchGitHub",
  // YouTube play — handled in Node (search + open watch URL). Also listed so
  // the live session routes it through the desktop-tool path.
  "playYouTube",
  // Open Nth image URL directly (not Google Images search page)
  "openImage",
  // Windows system settings: Bluetooth, Wi‑Fi, theme, Settings pages
  "systemSetting", "openWindowsSetting", "toggleBluetooth", "toggleWifi",
  // files
  "createFile", "writeToNotepad", "readFile", "renameFile", "deleteFile", "moveFile",
  "openFolder", "listFiles", "searchFiles", "openLocalImage", "openFile",
  // Office documents (real .docx / .xlsx / .pptx)
  "createWordFile", "createExcelFile", "createPowerPointFile",
  // pc control (volume + gated power + real-browser YouTube media)
  "volumeUp", "volumeDown", "muteToggle", "setVolume",
  // pause / resume / play for videos opened in Chrome/Edge via playYouTube
  "browserMediaControl",
  // scroll real Chrome/Edge / YouTube (NOT the empty in-app iframe)
  "browserScroll",
  "requestPowerAction", "executePowerAction",
  // windows
  "minimizeWindow", "maximizeWindow", "closeWindow", "switchApplication",
  // clipboard
  "copySelected", "pasteClipboard", "getClipboard", "clearClipboard",
  // screenshot / screen reading
  "takeScreenshot", "saveScreenshot", "analyzeScreenshot", "readScreen",
  // Playwright desktop automation (real Chromium window — only when explicitly needed)
  "desktopBrowserOpen", "desktopBrowserNavigate", "desktopBrowserOpenTab",
  "desktopBrowserCloseTab", "desktopBrowserSearch", "desktopBrowserClick",
  "desktopBrowserType", "desktopBrowserFillForm", "desktopBrowserGoBack",
  "desktopBrowserGoForward", "desktopBrowserScroll",
  // coding assistance
  "createPythonFile", "runPythonScript", "createProjectFolder", "writeCodeFile",
  // system information
  "systemInfo", "gpuInfo", "temperatureInfo", "batteryInfo", "getDateTime",
  // brightness control (V2)
  "brightnessUp", "brightnessDown", "setBrightness",
  // Windows auto-start management (V2)
  "enableAutoStart", "disableAutoStart", "getAutoStartStatus",
  // Computer control gate (control word unlocks full PC + cursor)
  "enableComputerControl", "disableComputerControl", "getComputerControlStatus",
  // Cursor + keyboard (require control mode)
  "getScreenSize", "getMousePosition", "moveMouse", "clickMouse",
  "doubleClick", "rightClick", "dragMouse", "scrollMouse",
  "typeText", "pressKey", "hotkey", "mouseMoveAndClick",
  // browserType → real browser (not in-app iframe)
  "browserType",
]);

/** Tools that work even when computer control is locked (must match Python agent). */
const CONTROL_ALWAYS_ALLOWED: ReadonlySet<string> = new Set([
  "enableComputerControl",
  "disableComputerControl",
  "getComputerControlStatus",
  "systemInfo",
  "gpuInfo",
  "temperatureInfo",
  "batteryInfo",
  "getDateTime",
  "takeScreenshot",
  "saveScreenshot",
  "analyzeScreenshot",
  "readScreen",
  "getClipboard",
  "getAutoStartStatus",
  // Real browser YouTube / web — no control word required.
  // NOTE: browserScroll is intentionally NOT here — its Node/agent
  // implementation moves the physical cursor, so it needs the control word.
  "browserMediaControl",
  "openWebsite",
  "searchYouTube",
  "playYouTube",
  "searchGoogle",
  "searchWeb",
  "searchGitHub",
  "openImage",
  // Stories / notes / files — silent write, no control word, no typeText
  "createFile",
  "writeToNotepad",
  "readFile",
  "listFiles",
  "searchFiles",
  "openFolder",
  "openLocalImage",
  "openFile",
  "createWordFile",
  "createExcelFile",
  "createPowerPointFile",
  // Quick system toggles — no control word (Bluetooth / Wi‑Fi / volume / brightness)
  "systemSetting",
  "openWindowsSetting",
  "toggleBluetooth",
  "toggleWifi",
  "volumeUp",
  "volumeDown",
  "muteToggle",
  "setVolume",
  "brightnessUp",
  "brightnessDown",
  "setBrightness",
]);

/** Cursor / keyboard tools implemented with a Node PowerShell fallback. */
const CURSOR_TOOLS: ReadonlySet<string> = new Set([
  "getScreenSize",
  "getMousePosition",
  "moveMouse",
  "clickMouse",
  "doubleClick",
  "rightClick",
  "dragMouse",
  "scrollMouse",
  "typeText",
  "pressKey",
  "hotkey",
  "mouseMoveAndClick",
  "clickByText",
]);

/**
 * Node-side control-word lock.
 * LOCKED by default — mouse/PC tools work only after the user says "control".
 * Authoritative even when the frozen Python agent is old and missing the new tools.
 */
let nodeComputerControlEnabled = false;
let nodeComputerControlReason = "locked until control word";
let nodeComputerControlSince: number | null = null;

function setNodeComputerControl(enabled: boolean, reason = ""): {
  result: string;
  enabled: boolean;
  reason: string;
  since: number | null;
} {
  nodeComputerControlEnabled = !!enabled;
  nodeComputerControlSince = enabled ? Date.now() : null;
  nodeComputerControlReason = reason || (enabled ? "enabled" : "disabled");
  const status = enabled ? "ENABLED" : "DISABLED";
  const msg = enabled
    ? "Full computer control is now ENABLED. I can move the cursor, click, type, and run desktop tasks."
    : "Full computer control is now DISABLED. Cursor and desktop automation are locked until you say the control word again.";
  logCommand(`COMPUTER_CONTROL ${status} (${nodeComputerControlReason})`);
  return {
    result: msg,
    enabled,
    reason: nodeComputerControlReason,
    since: nodeComputerControlSince,
  };
}

function controlLockedError(tool: string): { ok: false; error: string } {
  return {
    ok: false,
    error:
      `Computer control is LOCKED. Tool '${tool}' requires the control word. ` +
      "User must say 'control' (or 'take control'), then call enableComputerControl " +
      "before running desktop/cursor actions.",
  };
}

/**
 * Escape arbitrary text for PowerShell SendKeys so every character is typed
 * literally. SendKeys treats `+ ^ % ~ ( ) { }` as modifiers/keycodes; wrapping
 * them in braces sends the literal character. (Brace characters themselves are
 * doubled: `{{}` and `{}}`.)
 */
function escapeSendKeysForTyping(text: string): string {
  return text.replace(/[+^%~(){}]/g, (m) => `{${m}}`);
}

/**
 * Windows cursor/keyboard via PowerShell + user32 (no Python required).
 * Used when the frozen agent is old or unreachable.
 */
async function cursorControlViaNode(
  tool: string,
  args: Record<string, unknown>,
): Promise<{ ok: boolean; result?: unknown; error?: string }> {
  if (process.platform !== "win32") {
    return { ok: false, error: "Cursor control Node fallback is Windows-only." };
  }

  const runPs = (scriptBody: string): Promise<string> =>
    new Promise((resolve, reject) => {
      const scriptPath = path.join(os.tmpdir(), `bikli-cursor-${Date.now()}-${Math.random().toString(36).slice(2)}.ps1`);
      try {
        fs.writeFileSync(scriptPath, scriptBody, "utf8");
      } catch (e: any) {
        reject(e);
        return;
      }
      exec(
        `powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${scriptPath}"`,
        { windowsHide: true, timeout: 15000 },
        (err, stdout, stderr) => {
          try { fs.unlinkSync(scriptPath); } catch { /* ignore */ }
          if (err) reject(new Error(stderr || err.message));
          else resolve(String(stdout || "").trim());
        },
      );
    });

  // Shared C# type for mouse/keyboard (loaded once per script).
  const preamble = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
if (-not ("BikliInput" -as [type])) {
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class BikliInput {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, UIntPtr dwExtraInfo);
  [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
  [DllImport("user32.dll")] public static extern short VkKeyScan(char ch);
  public const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
  public const uint MOUSEEVENTF_LEFTUP = 0x0004;
  public const uint MOUSEEVENTF_RIGHTDOWN = 0x0008;
  public const uint MOUSEEVENTF_RIGHTUP = 0x0010;
  public const uint MOUSEEVENTF_MIDDLEDOWN = 0x0020;
  public const uint MOUSEEVENTF_MIDDLEUP = 0x0040;
  public const uint MOUSEEVENTF_WHEEL = 0x0800;
  public const uint MOUSEEVENTF_HWHEEL = 0x01000;
  public const uint KEYEVENTF_KEYUP = 0x0002;
}
"@
}
`.trim();

  try {
    if (tool === "getScreenSize") {
      const out = await runPs(`${preamble}
$b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
Write-Output ("$($b.Width),$($b.Height)")
`);
      const [w, h] = out.split(",").map((n) => parseInt(n, 10));
      return { ok: true, result: { result: `Screen size is ${w}x${h} pixels.`, width: w, height: h, via: "node-fallback" } };
    }

    if (tool === "getMousePosition") {
      const out = await runPs(`${preamble}
$p = [System.Windows.Forms.Cursor]::Position
Write-Output ("$($p.X),$($p.Y)")
`);
      const [x, y] = out.split(",").map((n) => parseInt(n, 10));
      return { ok: true, result: { result: `Mouse is at (${x}, ${y}).`, x, y, via: "node-fallback" } };
    }

    if (tool === "moveMouse" || tool === "mouseMoveAndClick") {
      let x = args.x != null ? Number(args.x) : NaN;
      let y = args.y != null ? Number(args.y) : NaN;
      if (args.dx != null || args.dy != null || args.relative === true) {
        const cur = await runPs(`${preamble}
$p = [System.Windows.Forms.Cursor]::Position
Write-Output ("$($p.X),$($p.Y)")
`);
        const [cx, cy] = cur.split(",").map((n) => parseInt(n, 10));
        const dx = Number(args.dx ?? (args.relative ? args.x : 0) ?? 0);
        const dy = Number(args.dy ?? (args.relative ? args.y : 0) ?? 0);
        x = cx + dx;
        y = cy + dy;
      }
      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        return { ok: false, error: `${tool} requires x and y (or dx/dy).` };
      }
      x = Math.round(x);
      y = Math.round(y);
      await runPs(`${preamble}
[BikliInput]::SetCursorPos(${x}, ${y}) | Out-Null
Write-Output "OK"
`);
      if (tool === "moveMouse") {
        return { ok: true, result: { result: `Moved mouse to (${x}, ${y}).`, x, y, via: "node-fallback" } };
      }
      // mouseMoveAndClick falls through to click at current pos
      args = { ...args, x, y };
    }

    if (
      tool === "clickMouse" ||
      tool === "doubleClick" ||
      tool === "rightClick" ||
      tool === "mouseMoveAndClick"
    ) {
      const button =
        tool === "rightClick"
          ? "right"
          : String(args.button || "left").toLowerCase();
      const clicks =
        tool === "doubleClick"
          ? 2
          : Math.max(1, Math.min(5, Number(args.clicks || 1) || 1));
      let move = "";
      if (args.x != null && args.y != null) {
        move = `[BikliInput]::SetCursorPos(${Math.round(Number(args.x))}, ${Math.round(Number(args.y))}) | Out-Null; Start-Sleep -Milliseconds 40;`;
      }
      const downUp =
        button === "right"
          ? "[BikliInput]::MOUSEEVENTF_RIGHTDOWN, [BikliInput]::MOUSEEVENTF_RIGHTUP"
          : button === "middle"
            ? "[BikliInput]::MOUSEEVENTF_MIDDLEDOWN, [BikliInput]::MOUSEEVENTF_MIDDLEUP"
            : "[BikliInput]::MOUSEEVENTF_LEFTDOWN, [BikliInput]::MOUSEEVENTF_LEFTUP";
      await runPs(`${preamble}
${move}
$down,$up = ${downUp}
for ($i=0; $i -lt ${clicks}; $i++) {
  [BikliInput]::mouse_event($down, 0, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 30
  [BikliInput]::mouse_event($up, 0, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 40
}
$p = [System.Windows.Forms.Cursor]::Position
Write-Output ("$($p.X),$($p.Y)")
`);
      const label =
        clicks === 2 ? "double-clicked" : clicks === 1 ? "clicked" : `${clicks}-clicked`;
      return {
        ok: true,
        result: {
          result: `${button.charAt(0).toUpperCase() + button.slice(1)} ${label}.`,
          button,
          clicks,
          via: "node-fallback",
        },
      };
    }

    if (tool === "scrollMouse") {
      const amount = Math.max(1, Math.min(50, Math.abs(Number(args.amount ?? args.clicks ?? 3) || 3)));
      const direction = String(args.direction || "down").toLowerCase();
      // WHEEL delta: +120 up, -120 down per notch
      let delta = -120 * amount;
      let horizontal = false;
      if (direction === "up") delta = 120 * amount;
      else if (direction === "down") delta = -120 * amount;
      else if (direction === "left") {
        horizontal = true;
        delta = -120 * amount;
      } else if (direction === "right") {
        horizontal = true;
        delta = 120 * amount;
      }
      const flag = horizontal ? "MOUSEEVENTF_HWHEEL" : "MOUSEEVENTF_WHEEL";
      let move = "";
      if (args.x != null && args.y != null) {
        move = `[BikliInput]::SetCursorPos(${Math.round(Number(args.x))}, ${Math.round(Number(args.y))}) | Out-Null;`;
      }
      await runPs(`${preamble}
${move}
[BikliInput]::mouse_event([BikliInput]::${flag}, 0, 0, [uint32]${delta < 0 ? delta >>> 0 : delta}, [UIntPtr]::Zero)
Write-Output "OK"
`);
      return {
        ok: true,
        result: { result: `Scrolled ${direction} by ${amount}.`, direction, amount, via: "node-fallback" },
      };
    }

    if (tool === "dragMouse") {
      const toX = args.to_x != null ? Math.round(Number(args.to_x)) : null;
      const toY = args.to_y != null ? Math.round(Number(args.to_y)) : null;
      const hasStart = args.x != null && args.y != null;
      const sx = hasStart ? Math.round(Number(args.x)) : null;
      const sy = hasStart ? Math.round(Number(args.y)) : null;
      if (toX == null || toY == null) {
        if (args.dx == null && args.dy == null) {
          return { ok: false, error: "dragMouse requires to_x/to_y or dx/dy." };
        }
      }
      await runPs(`${preamble}
$start = [System.Windows.Forms.Cursor]::Position
$sx = ${sx != null ? sx : "$start.X"}
$sy = ${sy != null ? sy : "$start.Y"}
$ex = ${toX != null ? toX : `$sx + ${Number(args.dx || 0)}`}
$ey = ${toY != null ? toY : `$sy + ${Number(args.dy || 0)}`}
[BikliInput]::SetCursorPos([int]$sx, [int]$sy) | Out-Null
Start-Sleep -Milliseconds 50
[BikliInput]::mouse_event([BikliInput]::MOUSEEVENTF_LEFTDOWN, 0, 0, 0, [UIntPtr]::Zero)
Start-Sleep -Milliseconds 40
$steps = 12
for ($i=1; $i -le $steps; $i++) {
  $nx = [int]($sx + ($ex - $sx) * $i / $steps)
  $ny = [int]($sy + ($ey - $sy) * $i / $steps)
  [BikliInput]::SetCursorPos($nx, $ny) | Out-Null
  Start-Sleep -Milliseconds 15
}
[BikliInput]::mouse_event([BikliInput]::MOUSEEVENTF_LEFTUP, 0, 0, 0, [UIntPtr]::Zero)
Write-Output ("$sx,$sy,$ex,$ey")
`);
      return { ok: true, result: { result: "Drag completed.", via: "node-fallback" } };
    }

    if (tool === "typeText") {
      const text = String(args.text ?? "");
      if (!text) return { ok: false, error: "Parameter 'text' is required." };
      // Escape SendKeys metacharacters (type literally) AND the single-quote
      // for the PowerShell string literal.
      const safe = escapeSendKeysForTyping(text).replace(/'/g, "''");
      await runPs(`${preamble}
[System.Windows.Forms.SendKeys]::SendWait('${safe}')
Write-Output "OK"
`);
      return {
        ok: true,
        result: { result: `Typed ${text.length} character(s).`, length: text.length, via: "node-fallback" },
      };
    }

    if (tool === "pressKey" || tool === "hotkey") {
      const raw = String(args.key || args.keys || args.combo || "").trim();
      if (!raw) return { ok: false, error: "Parameter 'key' or 'keys' is required." };
      // Map common names to SendKeys
      const map: Record<string, string> = {
        enter: "{ENTER}",
        return: "{ENTER}",
        tab: "{TAB}",
        esc: "{ESC}",
        escape: "{ESC}",
        backspace: "{BACKSPACE}",
        delete: "{DELETE}",
        del: "{DELETE}",
        space: " ",
        up: "{UP}",
        down: "{DOWN}",
        left: "{LEFT}",
        right: "{RIGHT}",
        home: "{HOME}",
        end: "{END}",
        pgup: "{PGUP}",
        pageup: "{PGUP}",
        pgdn: "{PGDN}",
        pagedown: "{PGDN}",
        f1: "{F1}", f2: "{F2}", f3: "{F3}", f4: "{F4}",
        f5: "{F5}", f6: "{F6}", f7: "{F7}", f8: "{F8}",
        f9: "{F9}", f10: "{F10}", f11: "{F11}", f12: "{F12}",
      };
      const parts = raw.toLowerCase().replace(/-/g, "+").split("+").map((p) => p.trim()).filter(Boolean);
      let seq = "";
      const mods: string[] = [];
      // SendKeys has no Win key, so a "win" part is handled with keybd_event.
      // It must stay HELD for the whole combo (win+r, win+e, win+l, …) rather
      // than being tapped and dropped — the old code returned after tapping the
      // bare Win key and never sent the remaining keys.
      let winHeld = false;
      for (const p of parts) {
        if (p === "ctrl" || p === "control") mods.push("^");
        else if (p === "alt") mods.push("%");
        else if (p === "shift") mods.push("+");
        else if (p === "win" || p === "meta" || p === "cmd") {
          winHeld = true;
        } else {
          seq += map[p] || (p.length === 1 ? p : `{${p.toUpperCase()}}`);
        }
      }
      const send = mods.join("") + seq;
      const safe = send.replace(/'/g, "''");
      const presses = Math.max(1, Math.min(10, Number(args.presses || 1) || 1));
      if (winHeld) {
        await runPs(`${preamble}
[BikliInput]::keybd_event(0x5B, 0, 0, [UIntPtr]::Zero)
Start-Sleep -Milliseconds 40
[System.Windows.Forms.SendKeys]::SendWait('${safe}')
Start-Sleep -Milliseconds 40
[BikliInput]::keybd_event(0x5B, 0, [BikliInput]::KEYEVENTF_KEYUP, [UIntPtr]::Zero)
Write-Output "OK"
`);
      } else {
        await runPs(`${preamble}
for ($i=0; $i -lt ${presses}; $i++) {
  [System.Windows.Forms.SendKeys]::SendWait('${safe}')
  Start-Sleep -Milliseconds 40
}
Write-Output "OK"
`);
      }
      return {
        ok: true,
        result: { result: `Pressed ${raw}` + (presses > 1 ? ` x${presses}.` : "."), keys: parts, via: "node-fallback" },
      };
    }

    if (tool === "clickByText") {
      const text = String(args.text || args.name || args.label || args.button || "").trim();
      if (!text) {
        return { ok: false, error: "Parameter 'text' is required (the button label, e.g. 'Continue', 'OK', 'Save')." };
      }
      const safe = text.replace(/'/g, "''");
      // Match clickable control types. Hyperlink/Button/MenuItem/ListItem are the
      // most common "Continue"-style targets. TreeScope.Descendants scans the
      // active window's subtree so we find the right control regardless of app.
      // Falling back to Name match when AutomationId/Name equals the label keeps
      // this reliable across web (Edge/Chrome) and native (Win32/UWP) windows.
      const matchMode = String(args.match || "contains").toLowerCase();
      const exact = matchMode === "exact";
      const ps = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes
Add-Type -AssemblyName System.Windows.Forms
$needle = '${safe}'
$exact = ${exact ? "$true" : "$false"}

$root = [System.Windows.Automation.AutomationElement]::RootElement
$cache = New-Object System.Windows.Automation.CacheRequest
$cache.TreeScope = [System.Windows.Automation.TreeScope]::Element
$cache.Add([System.Windows.Automation.AutomationElement]::NameProperty)
$cache.Add([System.Windows.Automation.AutomationElement]::ControlTypeProperty)
$cache.AutomationElementMode = [System.Windows.Automation.AutomationElementMode]::None

# Condition: control is a clickable type AND name matches the label.
$clickable = @(
  [System.Windows.Automation.ControlType]::Button,
  [System.Windows.Automation.ControlType]::Hyperlink,
  [System.Windows.Automation.ControlType]::MenuItem,
  [System.Windows.Automation.ControlType]::ListItem,
  [System.Windows.Automation.ControlType]::CheckBox,
  [System.Windows.Automation.ControlType]::RadioButton,
  [System.Windows.Automation.ControlType]::ComboBox,
  [System.Windows.Automation.ControlType]::TabItem,
  [System.Windows.Automation.ControlType]::Custom
)
$nameMatches = {
  param($n)
  if (-not $n) { return $false }
  if ($exact) { return $n -ieq $needle }
  return $n -ieq $needle -or $n.ToLower().Contains($needle.ToLower()) -or $needle.ToLower().Contains($n.ToLower())
}

$found = $null
foreach ($ct in $clickable) {
  $cond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, $ct)
  $els = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $cond)
  foreach ($el in $els) {
    try { $nm = $el.GetCurrentPropertyValue([System.Windows.Automation.AutomationElement]::NameProperty, $true) } catch { $nm = $null }
    if (& $nameMatches $nm) { $found = $el; break }
  }
  if ($found) { break }
}

if (-not $found) { Write-Output 'NOT_FOUND'; exit 0 }

# Prefer InvokePattern (most reliable — triggers the control's click handler).
$clickedVia = ''
try {
  $pat = $found.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
  $pat.Invoke()
  $clickedVia = 'invoke'
} catch {
  # Fallback: focus + physical click at the control's center (SetCursorPos + mouse_event).
  try {
    [void]$found.SetFocus()
  } catch {}
  Start-Sleep -Milliseconds 60
  $r = $found.Current.BoundingRectangle
  $cx = [int](($r.Left + $r.Right) / 2)
  $cy = [int](($r.Top + $r.Bottom) / 2)
  [System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point($cx, $cy)
  Start-Sleep -Milliseconds 80
  Add-Type @"
using System;
using System.Runtime.InteropServices;
public class BikliClickTxt {
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint dw, UIntPtr e);
}
"@
  [BikliClickTxt]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 40
  [BikliClickTxt]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
  $clickedVia = 'physical'
}
try { $lbl = $found.GetCurrentPropertyValue([System.Windows.Automation.AutomationElement]::NameProperty, $true) } catch { $lbl = '' }
Write-Output ("CLICKED|" + $clickedVia + "|" + $lbl)
`.trim();

      try {
        const out = (await runPs(ps)).trim();
        const line = out.split(/\r?\n/).pop() || "";
        if (line.startsWith("CLICKED|")) {
          const [, via, lbl] = line.split("|");
          logCommand(`CLICK_BY_TEXT "${text}" via ${via}`);
          return {
            ok: true,
            result: {
              result: `Clicked "${lbl || text}" button.`,
              text,
              via: `uiautomation-${via}`,
              ok: true,
            },
          };
        }
        if (line === "NOT_FOUND") {
          return {
            ok: false,
            error: `No button/control matching "${text}" is visible. Make sure its window is open and not minimized, then try again. You can also take a screenshot and click by coordinates.`,
          };
        }
        return { ok: false, error: `clickByText returned unexpected output: ${line}` };
      } catch (e: any) {
        return { ok: false, error: `clickByText failed: ${e?.message || e}` };
      }
    }

    return { ok: false, error: `No Node fallback for cursor tool '${tool}'.` };
  } catch (err: any) {
    logError(`CURSOR_NODE_FAILED ${tool}: ${err?.message || err}`);
    return { ok: false, error: `Cursor control failed: ${err?.message || err}` };
  }
}

/**
 * Call the Python desktop agent.  Returns the parsed JSON response.
 * If the agent is unreachable, returns a user-friendly error payload.
 */
/**
 * Whether the desktop agent has been confirmed alive in this process lifetime.
 * If false, callDesktopAgent will probe /health and attempt an auto-spawn.
 */
let desktopAgentVerified = false;

/**
 * Concurrency guard for ensureDesktopAgent — prevents multiple concurrent
 * spawn attempts when many tool calls arrive simultaneously.
 */
let desktopAgentEnsurePromise: Promise<void> | null = null;

/**
 * Auto-spawn the Python desktop agent as a detached child process if it is not
 * already listening. Prefers the frozen bikli-agent.exe (packaged or agent_dist),
 * then a local Python interpreter. Runs detached so it survives even if BIKLI's
 * node process is killed.
 */
function spawnDesktopAgent(): void {
  // spawn imported at top of file
  const agentEnv = {
    ...process.env,
    BIKLI_AGENT_HOST: "127.0.0.1",
    BIKLI_AGENT_PORT: "8765",
    // Ensure the agent can resolve project root for auto-start / paths
    BIKLI_APP_ROOT: process.env.BIKLI_APP_ROOT || APP_ROOT,
    BIKLI_DATA_DIR: process.env.BIKLI_DATA_DIR || DATA_DIR,
  };

  // Preferred: PyInstaller-frozen agent (env, packaged resources, or agent_dist).
  const frozenExe = resolveFrozenAgentExe();
  if (frozenExe) {
    try {
      const child = spawn(frozenExe, [], {
        cwd: path.dirname(frozenExe),
        detached: true,
        stdio: "ignore",
        windowsHide: true, // never flash a console window
        env: agentEnv,
      });
      child.unref();
      logStartup(`AGENT_SPAWN frozen exe pid=${child.pid} path=${frozenExe}`);
      console.log(`[Desktop Agent] Launched frozen agent (PID ${child.pid}).`);
      return;
    } catch (e: any) {
      logError(`AGENT_SPAWN_FROZEN_FAILED: ${e?.message || e}`);
      // fall through to the Python path below
    }
  }

  // Development fallback: run the agent from source using a local Python.
  // No machine-specific hardcoded paths — env override + PATH only.
  const localAppData = process.env.LOCALAPPDATA || "";
  const candidates = [
    process.env.BIKLI_PYTHON,
    localAppData
      ? path.join(localAppData, "Programs", "Python", "Python312", "python.exe")
      : "",
    localAppData
      ? path.join(localAppData, "Programs", "Python", "Python311", "python.exe")
      : "",
    "python",
    "python3",
    "py",
  ].filter(Boolean) as string[];
  const py = candidates.find((p) => {
    try {
      // Absolute paths: check existence; bare names: try --version on PATH.
      if (path.isAbsolute(p) || /^[a-zA-Z]:[\\/]/.test(p)) {
        if (!fs.existsSync(p)) return false;
      }
      execSync(
        p === "py" ? `py -3 --version` : `"${p}" --version`,
        { stdio: "ignore", windowsHide: true },
      );
      return true;
    } catch {
      return false;
    }
  });
  if (!py) {
    console.warn("[Desktop Agent] No frozen agent and no Python interpreter found; desktop control unavailable.");
    logError("AGENT_SPAWN_NO_RUNTIME: neither BIKLI_AGENT_EXE nor Python available");
    return;
  }
  try {
    const pyArgs =
      py === "py"
        ? ["-3", "-m", "uvicorn", "desktop_agent.main:app", "--host", "127.0.0.1", "--port", "8765"]
        : ["-m", "uvicorn", "desktop_agent.main:app", "--host", "127.0.0.1", "--port", "8765"];
    const child = spawn(py, pyArgs, {
      cwd: APP_ROOT,
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      env: agentEnv,
    });
    child.unref();
    logStartup(`AGENT_SPAWN python pid=${child.pid} via=${py}`);
    console.log(`[Desktop Agent] Auto-spawned via Python (PID ${child.pid}).`);
  } catch (e: any) {
    console.warn(`[Desktop Agent] Auto-spawn failed: ${e?.message || e}`);
    logError(`AGENT_SPAWN_PYTHON_FAILED: ${e?.message || e}`);
  }
}

/**
 * Probe the desktop agent /health endpoint. Returns true if it responds 200.
 */
async function isDesktopAgentAlive(): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2000);
  try {
    const res = await fetch(`${DESKTOP_AGENT_URL}/health`, { signal: controller.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    // The old code only cleared this on success, so every failed probe left a
    // live 2s timer behind — and ensureDesktopAgent probes up to 21 times.
    clearTimeout(timer);
  }
}

/**
 * Ensure the desktop agent is running. Probes /health; if down, auto-spawns
 * and polls until ready (or timeout). force=true is used after connection
 * failures so a dead agent is re-spawned without a full BIKLI restart
 * ("nothing listening on 8765").
 */
async function ensureDesktopAgent(force = false): Promise<void> {
  // Concurrency guard — coalesce simultaneous calls into one attempt.
  if (desktopAgentEnsurePromise) {
    return desktopAgentEnsurePromise;
  }

  desktopAgentEnsurePromise = (async (): Promise<void> => {
    // Fast path: already verified and not forced.
    if (desktopAgentVerified && !force) return;

    if (await isDesktopAgentAlive()) {
      desktopAgentVerified = true;
      if (force) {
        console.log("[Desktop Agent] Healthy after force-check.");
      } else {
        console.log("[Desktop Agent] Already running — desktop tools available.");
      }
      return;
    }

    desktopAgentVerified = false;
    console.log("[Desktop Agent] Not detected. Auto-starting...");
    spawnDesktopAgent();
    for (let i = 1; i <= 20; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      if (await isDesktopAgentAlive()) {
        desktopAgentVerified = true;
        console.log(`[Desktop Agent] Online after ${i}s — desktop tools available.`);
        return;
      }
      // Re-attempt spawn mid-wait (first attempt can race with a dying process).
      if (i === 5 || i === 12) {
        console.log(`[Desktop Agent] Still offline at ${i}s — re-spawning…`);
        spawnDesktopAgent();
      }
    }
    console.warn("[Desktop Agent] Did not come online within 20s. Desktop control will be unavailable.");
  })();

  try {
    await desktopAgentEnsurePromise;
  } finally {
    desktopAgentEnsurePromise = null;
  }
}

// ---------------------------------------------------------------------------
// YouTube search + play (Node-side so frozen Python agent can still "play")
// ---------------------------------------------------------------------------
interface YouTubeVideoHit {
  videoId: string;
  title: string;
  author: string;
  duration: string;
  views: string;
  thumbnail: string;
  published?: string;
}

/** Last successful YouTube search query — used for "play the first video". */
let lastYouTubeQuery = "";
/** Title of the last video we opened (detect watch-page vs new manual search). */
let lastPlayedVideoTitle = "";
/** When lastYouTubeQuery was set (stale cache guard). */
let lastYouTubeQueryAt = 0;

/** Debounce browser launches so one "play song" cannot open many tabs. */
let lastBrowserOpenAt = 0;
let lastBrowserOpenUrl = "";
let lastYouTubePlayAt = 0;
let lastYouTubePlayKey = "";

/** Timestamp when the YouTube desktop app was last opened (via openApplication).
 * Used by searchYouTube to decide whether to search inside the app instead of
 * opening a browser tab. Stale after 5 minutes so a fresh open overrides. */
let lastYouTubeAppOpenedAt = 0;
const YOUTUBE_APP_STALE_MS = 5 * 60 * 1000;

/**
 * Track media playback intent so PLAY_PAUSE toggles do not reverse a manual
 * user pause (agent "auto start" bug). playYouTube → playing; pause/stop → paused;
 * play/resume only when not already playing.
 */
let mediaPlaybackState: "unknown" | "playing" | "paused" = "unknown";
let lastMediaActionAt = 0;
// Intent-tracking for VK_VOLUME_MUTE (a pure toggle). "mute" when already muted
// or "unmute" when already unmuted must not flip the state the wrong way.
let mediaMuted = false;

const BROWSER_OPEN_DEBOUNCE_MS = 10000;
/** Block duplicate playYouTube for same song longer so agent cannot re-open after user pause. */
const YOUTUBE_PLAY_DEBOUNCE_MS = 45000;

/**
 * Global open-action debounce: Gemini often fires the same open tool 2–3 times
 * (same turn or next turn after tool response). Without this, "open notepad"
 * / "open youtube" / "open image" can spawn many windows of the same thing.
 */
const OPEN_ACTION_DEBOUNCE_MS = 12000;
const recentOpenActions = new Map<string, number>();

const OPEN_LIKE_TOOLS = new Set([
  "openApplication",
  "openWebsite",
  "openImage",
  "openLocalImage",
  "openFile",
  "openFolder",
  "playYouTube",
  "searchYouTube",
  "searchGoogle",
  "searchWeb",
  "searchGitHub",
  "browserOpen",
  "desktopBrowserOpen",
  "desktopBrowserSearch",
  "writeToNotepad",
]);

function normalizeOpenTarget(s: string): string {
  return String(s || "")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ")
    .replace(/\.exe$/i, "");
}

/** Stable key for an open-like tool call, or null if not open-like. */
function makeOpenActionKey(tool: string, args: Record<string, unknown> | undefined): string | null {
  const n = String(tool || "");
  const a = (args || {}) as Record<string, unknown>;
  if (n === "openApplication") {
    return `app:${normalizeOpenTarget(String(a.name || a.application || a.app || ""))}`;
  }
  if (n === "openWebsite") {
    const name = normalizeOpenTarget(String(a.name || ""));
    const url = normalizeOpenTarget(String(a.url || "").replace(/^https?:\/\//, "").replace(/\/+$/, ""));
    return `web:${name || url}`;
  }
  if (n === "openImage") {
    return `img:${normalizeOpenTarget(String(a.query || a.q || a.topic || ""))}|${a.index ?? a.n ?? 1}`;
  }
  if (n === "openLocalImage") {
    return `localimg:${normalizeOpenTarget(String(a.name || a.query || a.path || ""))}|${a.index ?? a.n ?? 1}|${normalizeOpenTarget(String(a.folder || ""))}`;
  }
  if (n === "openFile") {
    return `file:${normalizeOpenTarget(String(a.path || a.name || a.file || ""))}`;
  }
  if (n === "openFolder") {
    return `folder:${normalizeOpenTarget(String(a.name || a.path || a.folder || "explorer"))}`;
  }
  if (n === "playYouTube") {
    return `ytplay:${normalizeOpenTarget(String(a.query || a.q || lastYouTubeQuery || ""))}|${a.index ?? a.n ?? 1}`;
  }
  if (n === "searchYouTube") {
    return `ytsearch:${normalizeOpenTarget(String(a.query || a.q || ""))}`;
  }
  if (n === "searchGoogle" || n === "searchWeb" || n === "searchGitHub") {
    return `search:${n}:${normalizeOpenTarget(String(a.query || a.q || ""))}`;
  }
  if (n === "browserOpen" || n === "desktopBrowserOpen") {
    return `brow:${normalizeOpenTarget(String(a.url || a.query || a.name || ""))}`;
  }
  if (n === "desktopBrowserSearch") {
    return `browsearch:${normalizeOpenTarget(String(a.query || a.q || ""))}`;
  }
  if (n === "writeToNotepad") {
    // Same story/content open spam — debounce by path or content hash prefix
    const pathKey = normalizeOpenTarget(String(a.path || ""));
    const content = String(a.content || a.text || "").slice(0, 80);
    return `notepad:${pathKey || content.toLowerCase()}`;
  }
  return null;
}

/** Extra keys that should also be considered "already opened" for related opens. */
function relatedOpenKeys(tool: string, args: Record<string, unknown> | undefined, primary: string): string[] {
  const n = String(tool || "");
  const a = (args || {}) as Record<string, unknown>;
  const extra: string[] = [];
  if (n === "openWebsite" || n === "playYouTube" || n === "searchYouTube" || n === "searchWeb") {
    const blob = `${a.name || ""} ${a.url || ""} ${a.query || ""} ${a.q || ""} ${primary}`.toLowerCase();
    if (/youtube|youtu\.be/.test(blob) || n === "playYouTube" || n === "searchYouTube") {
      extra.push("web:youtube", "app:chrome", "app:edge", "app:msedge", "app:brave", "app:firefox", "app:browser", "app:youtube");
    }
    if (/google/.test(blob) && n === "openWebsite") {
      extra.push("web:google", "app:chrome", "app:edge");
    }
  }
  if (n === "openApplication") {
    const app = normalizeOpenTarget(String(a.name || a.application || a.app || ""));
    if (/^(chrome|msedge|edge|brave|firefox|browser)$/.test(app)) {
      extra.push("app:chrome", "app:edge", "app:msedge", "app:brave", "app:firefox", "app:browser");
    }
  }
  return extra;
}

/**
 * Claim an open action immediately (sync) so parallel tool calls cannot race.
 * Returns true if this call should RUN, false if it is a duplicate and should SKIP.
 *
 * Pass `recentUserText` so the same-utterance race rule can be inverted when
 * the user explicitly asked for the desktop app (e.g. "open in the YouTube app").
 */
function claimOpenAction(
  tool: string,
  args: Record<string, unknown> | undefined,
  recentUserText: string = "",
): boolean {
  if (!OPEN_LIKE_TOOLS.has(tool)) return true;
  const key = makeOpenActionKey(tool, args);
  if (!key || key.endsWith(":")) return true;

  const now = Date.now();
  // Prune old entries
  for (const [k, t] of recentOpenActions) {
    if (now - t > OPEN_ACTION_DEBOUNCE_MS * 3) recentOpenActions.delete(k);
  }

  const last = recentOpenActions.get(key);
  if (last != null && now - last < OPEN_ACTION_DEBOUNCE_MS) {
    console.log(`[Open Debounce] Blocked duplicate ${tool} key=${key} (${now - last}ms ago)`);
    return false;
  }

  const inAppTarget = detectOpenInAppIntent(recentUserText);

  // INVERTED RULE: user said "in the <X> app" → block the WEB call,
  // let the app call through. The LLM sometimes fires both openWebsite(X)
  // and openApplication(X); we drop the web one here when intent is clear.
  if (inAppTarget && (tool === "openWebsite" || tool === "playYouTube" || tool === "searchYouTube" || tool === "browserOpen" || tool === "desktopBrowserOpen")) {
    const a = (args || {}) as Record<string, unknown>;
    const blob = `${a.name || ""} ${a.url || ""} ${a.query || ""} ${a.q || ""}`.toLowerCase();
    if (blob.includes(inAppTarget) || (tool === "playYouTube" || tool === "searchYouTube")) {
      console.log(
        `[Open Debounce] Blocked ${tool} — user asked for "${inAppTarget} app" (use openApplication)`,
      );
      return false;
    }
  }

  // Same-utterance race: model opens YouTube AND Chrome together → keep web, drop browser app
  // UNLESS user explicitly said "in the <X> app" — then the app wins.
  if (
    !inAppTarget &&
    key.startsWith("app:") &&
    /^(app:chrome|app:edge|app:msedge|app:brave|app:firefox|app:browser|app:youtube|app:google chrome|app:microsoft edge)$/.test(
      key,
    )
  ) {
    const webJustOpened = [...recentOpenActions.entries()].some(
      ([k, t]) =>
        (k.startsWith("web:") ||
          k.startsWith("ytplay:") ||
          k.startsWith("ytsearch:") ||
          k.startsWith("brow:") ||
          k.startsWith("search:")) &&
        now - t < 5000,
    );
    if (webJustOpened) {
      console.log(`[Open Debounce] Blocked ${tool} key=${key} (web/YouTube already opening)`);
      return false;
    }
  }

  recentOpenActions.set(key, now);
  // Mark related keys (youtube ↔ chrome, etc.) so parallel opens of the same
  // intent cannot spawn extra windows within the debounce window.
  for (const rel of relatedOpenKeys(tool, args, key)) {
    if (!recentOpenActions.has(rel)) {
      recentOpenActions.set(rel, now);
    }
  }
  return true;
}

function openDebounceSkipResult(tool: string): { ok: true; result: Record<string, unknown> } {
  return {
    ok: true,
    result: {
      result: `Already opened that — skipped duplicate ${tool} so only one window/tab opens.`,
      debounced: true,
      ok: true,
    },
  };
}

function normalizeBrowserUrl(url: string): string {
  return String(url || "")
    .trim()
    .toLowerCase()
    .replace(/[?#].*$/, "")
    .replace(/\/+$/, "");
}

function isYouTubeRelatedToolCall(name: string, args: Record<string, unknown> | undefined): boolean {
  const n = String(name || "");
  if (n === "playYouTube" || n === "searchYouTube") return true;
  if (n === "openWebsite" || n === "browserOpen" || n === "desktopBrowserOpen" || n === "desktopBrowserSearch") {
    const blob = `${args?.name || ""} ${args?.url || ""} ${args?.query || ""} ${args?.q || ""}`.toLowerCase();
    return /youtube|youtu\.be|music\.youtube/.test(blob);
  }
  if (n === "searchWeb") {
    const engine = String(args?.engine || "").toLowerCase();
    const blob = `${args?.query || ""} ${args?.q || ""}`.toLowerCase();
    return engine === "youtube" || /youtube/.test(blob);
  }
  if (n === "openApplication") {
    const app = String(args?.name || args?.application || args?.app || "").toLowerCase();
    return /^(chrome|msedge|edge|brave|firefox|browser|youtube)$/.test(app);
  }
  return false;
}

/**
 * Detect "open in the <X> app" / "use the <X> app" / "<X> app me kholo" intent.
 * Returns the normalized target app name (e.g. "youtube", "spotify") when the
 * user clearly wants the desktop app, NOT the website. Returns "" otherwise.
 *
 * Examples that match → "youtube":
 *   "open the video in the YouTube app"
 *   "open Believer in the YouTube app"
 *   "use the YouTube app"
 *   "launch the youtube application"
 *   "youtube app me kholo"
 *   "spotify app me chalao"
 *
 * Examples that DO NOT match (return ""):
 *   "open YouTube"           (no "app" — defaults to openWebsite)
 *   "play Believer"          (no "app")
 *   "open a YouTube video"   (no "app")
 */
function detectOpenInAppIntent(userText: string): string {
  const t = String(userText || "").toLowerCase();
  if (!t.trim()) return "";
  // Quick reject: must mention "app" or "application"
  if (!/\b(app|application)\b/.test(t)) return "";
  // Targets that have a real desktop app (longest first so "youtube music"
  // wins over "youtube", "amazon prime" wins over "amazon", etc.)
  const APP_TARGETS = [
    "youtube music",
    "amazon prime", "prime video",
    "disney plus", "disney+",
    "apple music", "apple tv",
    "google maps", "google drive", "google photos",
    "microsoft teams", "ms teams",
    "youtube",
    "spotify", "whatsapp", "discord", "telegram", "signal",
    "netflix", "instagram", "twitter", "facebook", "linkedin",
    "amazon", "hotstar", "vlc", "x",
  ];
  for (const target of APP_TARGETS) {
    const esc = target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // "<target> app" / "<target> application"  (covers "in youtube app",
    // "use the youtube app", "open in youtube app", "youtube app me", etc.)
    if (new RegExp(`\\b${esc}\\s+(?:app|application)\\b`).test(t)) return target;
  }
  return "";
}

/**
 * Detect pure YouTube SEARCH intent (results page only — never autoplay a video).
 * "search X on youtube" / "youtube pe search" → search only.
 * "play/open/watch first video" → NOT search-only.
 */
function isYouTubeSearchOnlyIntent(userText: string): boolean {
  const t = String(userText || "").toLowerCase();
  if (!t.trim()) return false;
  // Explicit play/open/watch of a result wins over search
  if (
    /\b(play|open|watch|start)\b/.test(t) &&
    /\b(video|song|music|clip|mv|result|first|second|third|1st|2nd|3rd|\d+(st|nd|rd|th)?)\b/.test(t)
  ) {
    return false;
  }
  if (/\b(play|open|watch)\b.+\b(on\s+)?youtube\b/.test(t) && !/\bsearch\b/.test(t)) {
    return false;
  }
  return (
    /\b(search|find|look\s*up|browse)\b/.test(t) &&
    (/\byoutube\b|\byt\b/.test(t) || /\bvideo(s)?\b/.test(t))
  );
}

/** "open first/second video" / "play the 2nd result" while results are on screen. */
function isOpenNthVideoIntent(userText: string): boolean {
  const t = String(userText || "").toLowerCase().replace(/[^\w\s]/g, " ").replace(/\s+/g, " ").trim();
  if (!t) return false;
  // Bare "play video" / "open the video" / "play this one" — no ordinal and no
  // song named, so the user means whatever is on screen right now. Anchored so
  // a named request ("play Believer video") never matches and keeps its query.
  // The optional repeated noun absorbs the STT stutter "play video video".
  if (
    /^(please |ok |okay |bikli |now )*(play|open|watch|start)( the| a| this| that| some)?( video| one| result| clip| song)(s)?( video| one| result| clip)?( now| please)?$/.test(
      t,
    )
  ) {
    return true;
  }
  return (
    /\b(open|play|watch|click|select)\b/.test(t) &&
    /\b(first|1st|second|2nd|third|3rd|fourth|4th|fifth|5th|\d+(st|nd|rd|th)?)\b/.test(t) &&
    /\b(video|result|one|song|clip)\b/.test(t)
  );
}

function parseVideoIndexFromText(userText: string): number | null {
  const t = String(userText || "").toLowerCase();
  if (/\b(first|1st|number\s*one|#?\s*1)\b/.test(t)) return 1;
  if (/\b(second|2nd|number\s*two|#?\s*2)\b/.test(t)) return 2;
  if (/\b(third|3rd|number\s*three|#?\s*3)\b/.test(t)) return 3;
  if (/\b(fourth|4th|number\s*four|#?\s*4)\b/.test(t)) return 4;
  if (/\b(fifth|5th|number\s*five|#?\s*5)\b/.test(t)) return 5;
  const m = t.match(/\b(?:video|result|one)?\s*#?\s*(\d{1,2})\b/);
  if (m) {
    const n = parseInt(m[1], 10);
    if (n >= 1 && n <= 20) return n;
  }
  return null;
}

/**
 * Gemini often fires openWebsite + searchYouTube + playYouTube together for
 * "play a song", which opens many tabs. Keep ONE play action (or one search).
 * When user said SEARCH only, never keep playYouTube (that was auto-playing videos).
 */
function coalesceBrowserFunctionCalls<T extends { name?: string; args?: any; id?: string }>(
  calls: T[],
  recentUserText = "",
): T[] {
  if (!calls || calls.length === 0) return calls || [];

  const searchOnly = isYouTubeSearchOnlyIntent(recentUserText);
  const openNth = isOpenNthVideoIntent(recentUserText);
  const spokenIndex = parseVideoIndexFromText(recentUserText);

  // SEARCH-ONLY: rewrite stray playYouTube → searchYouTube, drop play flags
  if (searchOnly) {
    const rewritten: T[] = [];
    let keptSearch = false;
    for (const fc of calls) {
      const name = String(fc.name || "");
      const args = { ...((fc.args || {}) as Record<string, unknown>) };
      if (name === "playYouTube") {
        if (keptSearch) {
          console.log(`[Browser Coalesce] Dropping playYouTube (user asked SEARCH only)`);
          continue;
        }
        const q = String(args.query || args.q || lastYouTubeQuery || "").trim();
        console.log(`[Browser Coalesce] Rewriting playYouTube → searchYouTube (search-only intent)`);
        rewritten.push({
          ...fc,
          name: "searchYouTube",
          args: { query: q || String(args.query || ""), new_window: false },
        } as T);
        keptSearch = true;
        continue;
      }
      if (name === "searchYouTube") {
        if (keptSearch) {
          console.log(`[Browser Coalesce] Dropping extra searchYouTube`);
          continue;
        }
        // Strip any play/open flags so search never autoplays
        delete args.play;
        delete args.playFirst;
        delete args.play_first;
        delete args.autoplay;
        delete args.open;
        delete args.openFirst;
        delete args.open_first;
        delete args.mode;
        delete args.action;
        delete args.intent;
        rewritten.push({ ...fc, args } as T);
        keptSearch = true;
        continue;
      }
      if (
        isYouTubeRelatedToolCall(name, args) &&
        (name === "openWebsite" || name === "browserOpen" || name === "desktopBrowserOpen")
      ) {
        console.log(`[Browser Coalesce] Dropping ${name} (searchYouTube handles search)`);
        continue;
      }
      rewritten.push(fc);
    }
    if (rewritten.length !== calls.length || searchOnly) {
      console.log(
        `[Browser Coalesce] search-only: ${calls.map((c) => c.name).join(",")} → ${rewritten.map((c) => c.name).join(",")}`,
      );
    }
    return rewritten.length ? rewritten : calls;
  }

  // OPEN Nth VIDEO (esp. while Share Screen on results): force a single playYouTube
  if (openNth) {
    const playCalls = calls.filter((c) => c.name === "playYouTube");
    const searchCalls = calls.filter((c) => c.name === "searchYouTube");
    const idx =
      spokenIndex ||
      Number(playCalls[0]?.args?.index ?? searchCalls[0]?.args?.index ?? 1) ||
      1;
    // Prefer model-provided query only when it looks like a real topic.
    // Do NOT inject lastYouTubeQuery here — playYouTubeVideo resolves the LIVE
    // browser title so a manual new search is not overwritten by old "motupatlu".
    const modelQ = String(
      playCalls[0]?.args?.query ||
        playCalls[0]?.args?.q ||
        searchCalls[0]?.args?.query ||
        searchCalls[0]?.args?.q ||
        "",
    ).trim();
    const base = playCalls[0] || searchCalls[0] || calls[0];
    if (base) {
      console.log(
        `[Browser Coalesce] open-nth video → playYouTube index=${idx} modelQ="${modelQ}" (live resolve later)`,
      );
      // Drop click/nav tools that would fail on Share Screen instead of opening the video
      const dropNames = new Set([
        "playYouTube",
        "searchYouTube",
        "browserClick",
        "browserOpen",
        "browserSearch",
        "desktopBrowserClick",
        "desktopBrowserOpen",
        "desktopBrowserSearch",
        "openWebsite",
        "searchWeb",
      ]);
      const rest = calls.filter((c) => !dropNames.has(String(c.name || "")));
      return [
        {
          ...base,
          name: "playYouTube",
          // Empty query → resolveYouTubePlayQuery reads the current browser window
          args: { query: modelQ, index: idx },
        } as T,
        ...rest,
      ];
    }
  }

  if (calls.length <= 1) return calls;

  const playCalls = calls.filter((c) => c.name === "playYouTube");
  const hasPlay = playCalls.length > 0;
  const imageCalls = calls.filter((c) => c.name === "openImage");
  const hasImage = imageCalls.length > 0;

  // Prefer a single playYouTube (first one wins).
  let keptPlay: T | null = null;
  if (hasPlay) {
    keptPlay = playCalls[0];
  }
  let keptImage: T | null = null;
  if (hasImage) {
    keptImage = imageCalls[0];
  }

  const out: T[] = [];
  const seenPlayKeys = new Set<string>();

  for (const fc of calls) {
    const name = String(fc.name || "");
    const args = (fc.args || {}) as Record<string, unknown>;

    if (name === "playYouTube") {
      if (fc !== keptPlay) {
        console.log(`[Browser Coalesce] Dropping duplicate playYouTube`);
        continue;
      }
      const key = `${String(args.query || args.q || "").trim().toLowerCase()}|${args.index ?? 1}`;
      if (seenPlayKeys.has(key)) {
        console.log(`[Browser Coalesce] Dropping duplicate playYouTube key=${key}`);
        continue;
      }
      seenPlayKeys.add(key);
      // Fill index from speech if model omitted it
      if (spokenIndex && (args.index == null || args.index === 1) && spokenIndex !== 1) {
        out.push({ ...fc, args: { ...args, index: spokenIndex } } as T);
      } else {
        out.push(fc);
      }
      continue;
    }

    if (name === "openImage") {
      if (fc !== keptImage) {
        console.log(`[Browser Coalesce] Dropping duplicate openImage`);
        continue;
      }
      out.push(fc);
      continue;
    }

    // When playing, drop every other YouTube/browser open that would spawn extra tabs.
    if (hasPlay && isYouTubeRelatedToolCall(name, args)) {
      console.log(`[Browser Coalesce] Dropping ${name} (playYouTube already handles play)`);
      continue;
    }

    // When searching YouTube, drop openWebsite/browserOpen for YouTube (double tab).
    const hadSearch = out.some((x) => x.name === "searchYouTube");
    if (hadSearch && (name === "openWebsite" || name === "browserOpen" || name === "desktopBrowserOpen") && isYouTubeRelatedToolCall(name, args)) {
      console.log(`[Browser Coalesce] Dropping ${name} (searchYouTube already opens search page)`);
      continue;
    }

    // When opening an image, drop searchGoogle/searchWeb that would open search page only
    if (
      hasImage &&
      (name === "searchGoogle" ||
        name === "searchWeb" ||
        (name === "openWebsite" && /image|photo|picture/i.test(JSON.stringify(args))))
    ) {
      console.log(`[Browser Coalesce] Dropping ${name} (openImage already handles direct image)`);
      continue;
    }

    // Multiple searchYouTube without play → keep first only
    if (name === "searchYouTube") {
      if (out.some((x) => x.name === "searchYouTube")) {
        console.log(`[Browser Coalesce] Dropping extra searchYouTube`);
        continue;
      }
    }

    // Multiple openWebsite youtube → keep first only
    if (name === "openWebsite" && isYouTubeRelatedToolCall(name, args)) {
      if (out.some((x) => x.name === "openWebsite" && isYouTubeRelatedToolCall(x.name || "", (x.args || {}) as any))) {
        console.log(`[Browser Coalesce] Dropping extra openWebsite(youtube)`);
        continue;
      }
    }

    out.push(fc);
  }

  // General open-tool dedupe (apps, folders, images, websites — any "open X")
  const deduped = dedupeOpenLikeCalls(out.length ? out : calls, recentUserText);
  if (deduped.length !== calls.length) {
    console.log(
      `[Browser Coalesce] ${calls.length} tool call(s) → ${deduped.length}: ${deduped.map((c) => c.name).join(", ")}`,
    );
  }
  return deduped;
}

/**
 * Keep only ONE open of each target in a single model turn.
 * Drops openApplication(chrome) when a website/YouTube open is already present.
 * INVERTED when the user explicitly says "in the <X> app" / "use the <X> app":
 *   keep openApplication(X) and drop openWebsite(X) for the same X.
 */
function dedupeOpenLikeCalls<T extends { name?: string; args?: any; id?: string }>(
  calls: T[],
  recentUserText = "",
): T[] {
  if (!calls || calls.length <= 1) return calls || [];

  // "in the YouTube app" / "use the YouTube app" → keep app, drop website
  const inAppTarget = detectOpenInAppIntent(recentUserText);

  const hasWebOrYt = calls.some((c) => {
    const n = String(c.name || "");
    return (
      n === "openWebsite" ||
      n === "playYouTube" ||
      n === "searchYouTube" ||
      n === "searchGoogle" ||
      n === "searchWeb" ||
      n === "browserOpen" ||
      n === "desktopBrowserOpen"
    );
  });
  const hasDirectMedia = calls.some((c) => {
    const n = String(c.name || "");
    return n === "openImage" || n === "openLocalImage" || n === "playYouTube";
  });

  const seenKeys = new Set<string>();
  const out: T[] = [];

  for (const fc of calls) {
    const name = String(fc.name || "");
    const args = (fc.args || {}) as Record<string, unknown>;

    // INVERTED RULE: user said "in the <X> app" → keep openApplication(X),
    // drop the corresponding openWebsite(X). Only when the app target matches.
    if (inAppTarget && name === "openWebsite") {
      const siteName = normalizeOpenTarget(
        String(args.name || "") ||
          normalizeBrowserUrl(String(args.url || "").replace(/^https?:\/\//, "").replace(/\/+$/, "")),
      );
      if (siteName === inAppTarget || siteName.startsWith(`${inAppTarget}.`) || siteName === `www.${inAppTarget}`) {
        console.log(
          `[Open Coalesce] Dropping openWebsite(${siteName}) — user asked for "${inAppTarget} app"`,
        );
        continue;
      }
    }
    if (inAppTarget && name === "playYouTube") {
      // "play Believer in the YouTube app" → app wins, drop browser play
      console.log(
        `[Open Coalesce] Dropping playYouTube — user asked for "${inAppTarget} app" (use openApplication instead)`,
      );
      continue;
    }
    if (inAppTarget && name === "searchYouTube") {
      console.log(
        `[Open Coalesce] Dropping searchYouTube — user asked for "${inAppTarget} app" (use openApplication instead)`,
      );
      continue;
    }

    // Drop browser app launches when we're already opening a site / YouTube / search
    // (UNLESS user explicitly asked for the app — already handled above)
    if (!inAppTarget && hasWebOrYt && name === "openApplication") {
      const app = normalizeOpenTarget(String(args.name || args.application || args.app || ""));
      if (/^(chrome|msedge|edge|brave|firefox|browser|youtube|google chrome|microsoft edge)$/.test(app)) {
        console.log(`[Open Coalesce] Dropping openApplication(${app}) — web/YouTube open already in turn`);
        continue;
      }
    }

    // Drop extra search when direct media open is present
    if (
      hasDirectMedia &&
      (name === "searchGoogle" || name === "searchWeb") &&
      calls.some((c) => c.name === "openImage" || c.name === "openLocalImage")
    ) {
      console.log(`[Open Coalesce] Dropping ${name} — openImage already handles it`);
      continue;
    }

    // Drop openFolder / searchFiles / listFiles when openLocalImage is present
    // (same "open image/screenshot" request — never Explorer search box).
    if (
      (name === "openFolder" || name === "searchFiles" || name === "listFiles") &&
      calls.some((c) => c.name === "openLocalImage" || c.name === "openFile")
    ) {
      console.log(`[Open Coalesce] Dropping ${name} — openLocalImage/openFile present`);
      continue;
    }

    // Drop searchGoogle/searchWeb when openLocalImage is present (local image, not web)
    if (
      (name === "searchGoogle" || name === "searchWeb" || name === "openImage") &&
      calls.some((c) => c.name === "openLocalImage")
    ) {
      console.log(`[Open Coalesce] Dropping ${name} — openLocalImage handles local file`);
      continue;
    }

    // Drop typeText / openApplication(notepad) when writeToNotepad/createFile present
    if (
      (name === "typeText" || name === "pasteClipboard") &&
      calls.some((c) => c.name === "writeToNotepad" || c.name === "createFile")
    ) {
      console.log(`[Open Coalesce] Dropping ${name} — writeToNotepad/createFile present`);
      continue;
    }
    if (
      name === "openApplication" &&
      /notepad/i.test(String(args.name || args.application || args.app || "")) &&
      calls.some((c) => c.name === "writeToNotepad" || c.name === "createFile")
    ) {
      console.log(`[Open Coalesce] Dropping openApplication(notepad) — writeToNotepad present`);
      continue;
    }

    if (OPEN_LIKE_TOOLS.has(name)) {
      const key = makeOpenActionKey(name, args) || `${name}:${JSON.stringify(args)}`;
      if (seenKeys.has(key)) {
        console.log(`[Open Coalesce] Dropping duplicate ${name} key=${key}`);
        continue;
      }
      // Also collapse same tool name with empty/near-empty args
      const toolOnly = `tool:${name}`;
      if (
        (name === "openApplication" ||
          name === "openWebsite" ||
          name === "openImage" ||
          name === "openLocalImage" ||
          name === "openFolder" ||
          name === "playYouTube" ||
          name === "searchYouTube") &&
        seenKeys.has(toolOnly)
      ) {
        // Allow second only if key is clearly different (different app/query)
        // already handled by key above; toolOnly tracks first of type for soft collapse
      }
      seenKeys.add(key);
      seenKeys.add(toolOnly);
    }

    out.push(fc);
  }
  return out;
}

/**
 * Scrape YouTube search results HTML for video cards.
 * Same strategy as /api/youtube-search (ytInitialData + regex fallback).
 */
async function fetchYouTubeSearchResults(query: string, limit = 8): Promise<YouTubeVideoHit[]> {
  const q = (query || "").trim();
  if (!q) return [];

  // NOTE: only the /results page is scrapeable anonymously. The home feed and
  // /feed/trending return an empty shell (no videoId at all) without consent
  // cookies, so they cannot be used as a "just play something" source.
  const searchUrl =
    `https://www.youtube.com/results?search_query=${encodeURIComponent(q)}&hl=en&sp=EgIQAQ%253D%253D`;
  const response = await fetch(searchUrl, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      "Accept-Language": "en-US,en;q=0.9",
    },
  });
  if (!response.ok) {
    throw new Error(`YouTube search HTTP ${response.status}`);
  }
  const html = await response.text();
  const videoList: YouTubeVideoHit[] = [];
  const seen = new Set<string>();

  // Prefer full ytInitialData blob (non-greedy .+? often truncates too early).
  const marker = "var ytInitialData = ";
  const markerAlt = "ytInitialData = ";
  let start = html.indexOf(marker);
  let markerLen = marker.length;
  if (start < 0) {
    start = html.indexOf(markerAlt);
    markerLen = markerAlt.length;
  }
  if (start >= 0) {
    start += markerLen;
    // Brace-balance extract the JSON object.
    let depth = 0;
    let end = -1;
    for (let i = start; i < html.length; i++) {
      const ch = html[i];
      if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) {
          end = i + 1;
          break;
        }
      }
    }
    if (end > start) {
      try {
        const data = JSON.parse(html.slice(start, end));
        const walk = (node: any) => {
          if (!node || videoList.length >= limit) return;
          if (Array.isArray(node)) {
            for (const item of node) walk(item);
            return;
          }
          if (typeof node === "object") {
            const vr = node.videoRenderer;
            if (vr?.videoId && !seen.has(vr.videoId)) {
              seen.add(vr.videoId);
              videoList.push({
                videoId: vr.videoId,
                title:
                  vr.title?.runs?.[0]?.text ||
                  vr.title?.simpleText ||
                  "YouTube Video",
                thumbnail: `https://i.ytimg.com/vi/${vr.videoId}/hqdefault.jpg`,
                author:
                  vr.ownerText?.runs?.[0]?.text ||
                  vr.shortBylineText?.runs?.[0]?.text ||
                  "Unknown Channel",
                duration: vr.lengthText?.simpleText || "N/A",
                views: vr.viewCountText?.simpleText || "N/A",
                published: vr.publishedTimeText?.simpleText || "",
              });
            }
            for (const key of Object.keys(node)) walk(node[key]);
          }
        };
        walk(data);
      } catch (e: any) {
        console.error("[YouTube Parser] JSON parse error:", e?.message || e);
      }
    }
  }

  // Regex fallback: videoId + nearby title when possible.
  if (videoList.length === 0) {
    const blockRe =
      /"videoId":"([a-zA-Z0-9_-]{11})"[\s\S]{0,800}?"text":"([^"\\]{2,120})"/g;
    let match: RegExpExecArray | null;
    while ((match = blockRe.exec(html)) !== null && videoList.length < limit) {
      const id = match[1];
      if (seen.has(id)) continue;
      seen.add(id);
      videoList.push({
        videoId: id,
        title: match[2],
        thumbnail: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
        author: "YouTube",
        duration: "N/A",
        views: "Available",
      });
    }
  }
  if (videoList.length === 0) {
    const videoRegex = /"videoId":"([a-zA-Z0-9_-]{11})"/g;
    let match: RegExpExecArray | null;
    while ((match = videoRegex.exec(html)) !== null && videoList.length < limit) {
      const id = match[1];
      if (seen.has(id)) continue;
      seen.add(id);
      videoList.push({
        videoId: id,
        title: `YouTube video ${id}`,
        thumbnail: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
        author: "YouTube",
        duration: "N/A",
        views: "Available",
      });
    }
  }

  return videoList.slice(0, limit);
}

/**
 * Navigate the *current* browser tab to a URL (Windows).
 * Focuses Chrome/Edge (prefer YouTube window title), Ctrl+L, paste URL, Enter.
 * Returns true if the keyboard navigation path ran successfully.
 */
async function navigateBrowserTabInPlace(url: string): Promise<boolean> {
  if (process.platform !== "win32") return false;
  const safe = url.replace(/'/g, "''");
  const preferYt = /youtube\.com|youtu\.be/i.test(url);
  const psPrefer = preferYt ? "$true" : "$false";
  const ps = `
$ErrorActionPreference = 'SilentlyContinue'
$preferYt = ${psPrefer}
$target = '${safe}'

Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class BikliBrowserNav {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc lpEnumFunc, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
  public const uint KEYUP = 0x0002;
  public static void Hotkey(byte mod, byte key) {
    keybd_event(mod, 0, 0, UIntPtr.Zero);
    System.Threading.Thread.Sleep(30);
    keybd_event(key, 0, 0, UIntPtr.Zero);
    System.Threading.Thread.Sleep(30);
    keybd_event(key, 0, KEYUP, UIntPtr.Zero);
    System.Threading.Thread.Sleep(30);
    keybd_event(mod, 0, KEYUP, UIntPtr.Zero);
  }
  public static void Enter() {
    keybd_event(0x0D, 0, 0, UIntPtr.Zero);
    System.Threading.Thread.Sleep(30);
    keybd_event(0x0D, 0, KEYUP, UIntPtr.Zero);
  }
}
"@

# Is any browser process running?
$browserNames = @('chrome','msedge','firefox','brave','opera')
$running = @(Get-Process | Where-Object { $browserNames -contains $_.ProcessName })
if (-not $running -or $running.Count -eq 0) { Write-Output 'no_browser'; exit 0 }

# Find a visible browser window (prefer YouTube title when URL is YouTube)
$script:best = [IntPtr]::Zero
$script:bestScore = -1
$cb = [BikliBrowserNav+EnumProc]{
  param([IntPtr]$h, [IntPtr]$l)
  if (-not [BikliBrowserNav]::IsWindowVisible($h)) { return $true }
  $sb = New-Object System.Text.StringBuilder 512
  [void][BikliBrowserNav]::GetWindowText($h, $sb, $sb.Capacity)
  $title = $sb.ToString()
  if ([string]::IsNullOrWhiteSpace($title)) { return $true }
  $t = $title.ToLower()
  $score = -1
  if ($preferYt -and $t.Contains('youtube')) { $score = 100 }
  elseif ($t.Contains('chrome') -or $t.Contains('edge') -or $t.Contains('firefox') -or $t.Contains('brave') -or $t.Contains('opera')) { $score = 50 }
  elseif ($t.Contains('google') -or $t.Contains('mozilla')) { $score = 40 }
  if ($score -gt $script:bestScore) { $script:bestScore = $score; $script:best = $h }
  return $true
}
[void][BikliBrowserNav]::EnumWindows($cb, [IntPtr]::Zero)
if ($script:best -eq [IntPtr]::Zero -or $script:bestScore -lt 0) { Write-Output 'no_window'; exit 0 }

if ([BikliBrowserNav]::IsIconic($script:best)) { [void][BikliBrowserNav]::ShowWindow($script:best, 9) }
[void][BikliBrowserNav]::SetForegroundWindow($script:best)
Start-Sleep -Milliseconds 280

# Paste exact URL into address bar (Ctrl+L, Ctrl+A, Ctrl+V, Enter)
# Ctrl+A ensures old address is fully replaced — avoids half/wrong links.
Set-Clipboard -Value $target
Start-Sleep -Milliseconds 100
[BikliBrowserNav]::Hotkey(0x11, 0x4C)  # Ctrl+L (focus address bar)
Start-Sleep -Milliseconds 140
[BikliBrowserNav]::Hotkey(0x11, 0x41)  # Ctrl+A (select all)
Start-Sleep -Milliseconds 60
[BikliBrowserNav]::Hotkey(0x11, 0x56)  # Ctrl+V (paste exact URL)
Start-Sleep -Milliseconds 100
[BikliBrowserNav]::Enter()
Write-Output 'navigated'
`.trim();

  try {
    const out = await runPowerShellScript(ps, 12000);
    const line = (out.split(/\r?\n/).pop() || "").trim().toLowerCase();
    if (line === "navigated") {
      logCommand(`BROWSER_NAV same_tab ${url.slice(0, 120)}`);
      return true;
    }
    return false;
  } catch (e: any) {
    console.warn(`[Browser] In-place navigate failed: ${e?.message || e}`);
    return false;
  }
}

/**
 * Open a URL in the user's real default browser.
 * Always uses OS start of the exact URL — never clipboard Ctrl+L paste
 * (clipboard races caused wrong/error links). Debounce blocks spam.
 */
async function openSystemBrowserUrl(
  url: string,
  opts?: { newWindow?: boolean; newTab?: boolean },
): Promise<void> {
  const clean = String(url || "").trim();
  if (!clean) return;

  const newWindow = Boolean(opts?.newWindow);
  const newTab = Boolean(opts?.newTab);
  const now = Date.now();
  // Exact URL only — do NOT block a new YouTube search after opening youtube.com.
  // (Matching host+path without the query used to drop a DIFFERENT search made
  // within the debounce window, e.g. "cats" then "dogs".)
  const fullNorm = clean.toLowerCase().replace(/\/+$/, "");
  if (
    !newWindow &&
    !newTab &&
    lastBrowserOpenUrl &&
    now - lastBrowserOpenAt < BROWSER_OPEN_DEBOUNCE_MS &&
    fullNorm === lastBrowserOpenUrl
  ) {
    console.log(`[Browser] Debounced exact duplicate: ${clean}`);
    return;
  }
  lastBrowserOpenAt = now;
  lastBrowserOpenUrl = fullNorm;

  await openUrlViaOsStart(clean);

  // Windows does not reliably bring a browser window to the front when a URL is
  // opened into an ALREADY-RUNNING instance — the new tab opens but the window
  // stays behind, so "open YouTube" appears to never show the window. Give the
  // OS a beat to open/focus, then explicitly focus the browser window.
  if (!newWindow && process.platform === "win32") {
    await new Promise((r) => setTimeout(r, 650));
    try {
      await focusYouTubeBrowserWindow();
    } catch {
      /* focus is best-effort — non-fatal */
    }
  }
}

/** Open exact URL with Windows start / open / xdg-open (no clipboard). */
function openUrlViaOsStart(url: string): Promise<void> {
  const clean = String(url || "").trim();
  return new Promise<void>((resolve, reject) => {
    const platform = process.platform;
    if (platform === "win32") {
      // `cmd /c start "" "url"` is fragile — cmd mis-parses the quoted
      // title/target and the user gets "Windows cannot find 'https://…'".
      // rundll32 url.dll,FileProtocolHandler hands the URL straight to the
      // default handler with no cmd `start` quoting involved (reliable for
      // http/https/ftp and local files).
      // execFile does NOT go through a shell, so it passes each argument
      // verbatim. Wrapping the URL in quotes here handed rundll32 an argument
      // that literally began and ended with a `"` character. Pass it bare.
      const cleanUrl = clean.replace(/"/g, "").replace(/'/g, "%27");
      execFile("rundll32", ["url.dll,FileProtocolHandler", cleanUrl], (err: any) => {
        if (err) {
          console.warn(`[Browser] rundll32 URL open failed (${err?.message}), falling back to cmd start`);
          // `start` is a cmd builtin, so this fallback needs a real shell —
          // and the quotes must be inside the command string cmd parses, or an
          // "&" in the query string would split the command.
          exec(`start "" "${clean.replace(/"/g, "")}"`, { windowsHide: true }, (err2: any) => {
            if (err2) reject(err2);
            else resolve();
          });
        } else {
          resolve();
        }
      });
    } else if (platform === "darwin") {
      exec(`open "${clean.replace(/"/g, '\\"')}"`, (err) => (err ? reject(err) : resolve()));
    } else {
      exec(`xdg-open "${clean.replace(/"/g, '\\"')}"`, (err) => (err ? reject(err) : resolve()));
    }
  });
}

const LOCAL_IMAGE_EXTS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".bmp",
  ".heic",
  ".heif",
  ".tif",
  ".tiff",
  ".jfif",
  ".ico",
]);

/**
 * Remove Windows "Mark of the Web" so Photos/Explorer does not show
 * "Do you want to open this file? … untrusted source".
 */
function unblockWindowsFile(filePath: string): void {
  if (process.platform !== "win32") return;
  const clean = String(filePath || "");
  if (!clean) return;
  // Zone.Identifier alternate data stream
  try {
    fs.unlinkSync(`${clean}:Zone.Identifier`);
  } catch {
    /* no ADS — fine */
  }
  try {
    const lit = clean.replace(/'/g, "''");
    exec(
      `powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "Unblock-File -LiteralPath '${lit}' -ErrorAction SilentlyContinue"`,
      { windowsHide: true },
      () => {},
    );
  } catch {
    /* ignore */
  }
}

function openPathWithDefaultApp(filePath: string): void {
  const clean = String(filePath || "").replace(/"/g, "");
  if (!clean) return;
  // Always clear MOTW before opening local files (downloaded images, etc.)
  unblockWindowsFile(clean);
  if (process.platform === "win32") {
    // Use execFile with arguments array to avoid shell injection
      execFile(
      "powershell",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
       "-Command", `Unblock-File -LiteralPath '${clean.replace(/'/g, "''")}' -ErrorAction SilentlyContinue; Start-Process -FilePath '${clean.replace(/'/g, "''")}'`],
      { windowsHide: true },
      () => {},
    );
  } else if (process.platform === "darwin") {
    exec(`open "${clean.replace(/"/g, '\\"')}"`, () => {});
  } else {
    exec(`xdg-open "${clean.replace(/"/g, '\\"')}"`, () => {});
  }
}

/**
 * Download a remote image to a local temp file and open it.
 * Avoids Windows "file is from an untrusted source" when opening image URLs.
 * Returns the local path on success, or null if download failed.
 */
async function downloadImageToLocalTemp(imageUrl: string): Promise<string | null> {
  const url = String(imageUrl || "").trim();
  if (!/^https?:\/\//i.test(url)) return null;
  try {
    const dir = path.join(os.tmpdir(), "bikli-images");
    fs.mkdirSync(dir, { recursive: true });

    const ua =
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
    const res = await fetch(url, {
      headers: {
        "User-Agent": ua,
        Accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
      },
      redirect: "follow",
    });
    if (!res.ok) {
      console.warn(`[Image] Download failed HTTP ${res.status} for ${url.slice(0, 100)}`);
      return null;
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 32) return null;

    // Pick extension from URL, Content-Type, or magic bytes
    let ext = ".jpg";
    const pathPart = url.split("?")[0].split("#")[0];
    const m = pathPart.match(/\.(jpe?g|png|gif|webp|bmp|svg|avif|tif|tiff)(\?|#|$)/i);
    if (m) ext = `.${m[1].toLowerCase().replace("jpeg", "jpg")}`;
    else {
      const ct = (res.headers.get("content-type") || "").toLowerCase();
      if (ct.includes("png")) ext = ".png";
      else if (ct.includes("gif")) ext = ".gif";
      else if (ct.includes("webp")) ext = ".webp";
      else if (ct.includes("bmp")) ext = ".bmp";
      else if (ct.includes("svg")) ext = ".svg";
      else if (ct.includes("avif")) ext = ".avif";
      else if (buf[0] === 0x89 && buf[1] === 0x50) ext = ".png";
      else if (buf[0] === 0x47 && buf[1] === 0x49) ext = ".gif";
      else if (buf[0] === 0xff && buf[1] === 0xd8) ext = ".jpg";
      else if (buf[0] === 0x52 && buf[1] === 0x49) ext = ".webp";
    }

    const safeName = `bikli-img-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`;
    const filePath = path.join(dir, safeName);
    fs.writeFileSync(filePath, buf);
    // Ensure no Zone.Identifier (Node write usually has none; clear just in case)
    unblockWindowsFile(filePath);
    return filePath;
  } catch (err: any) {
    console.warn(`[Image] downloadImageToLocalTemp failed:`, err?.message || err);
    return null;
  }
}

/** Open a web image URL without the Windows untrusted-source dialog. */
async function openRemoteImageSafely(imageUrl: string): Promise<{ localPath?: string; via: string }> {
  const local = await downloadImageToLocalTemp(imageUrl);
  if (local) {
    openPathWithDefaultApp(local);
    // The viewer opens detached — give it time to load, then reclaim the temp
    // file so %TEMP%\bikli-images does not grow without bound.
    setTimeout(() => {
      try {
        if (fs.existsSync(local)) fs.unlinkSync(local);
      } catch {
        /* best-effort */
      }
    }, 120_000);
    return { localPath: local, via: "local_download" };
  }
  // Fallback: open in browser (still better than MOTW on Photos for some hosts)
  await openUrlViaOsStart(imageUrl);
  return { via: "browser_url_fallback" };
}

function localImageSearchRoots(folderHint: string, wantsScreenshot: boolean): string[] {
  const roots: string[] = [];
  const push = (p: string) => {
    if (p && fs.existsSync(p) && fs.statSync(p).isDirectory()) {
      const key = path.resolve(p).toLowerCase();
      if (!roots.some((r) => path.resolve(r).toLowerCase() === key)) roots.push(p);
    }
  };
  const home = os.homedir();
  const pictures = REAL_USER_FOLDERS.pictures;
  const desktop = REAL_USER_FOLDERS.desktop;
  const downloads = REAL_USER_FOLDERS.downloads;
  const hint = (folderHint || "").trim().toLowerCase();

  if (hint && !/screenshot|snip/.test(hint)) {
    const expanded = expandUserFacingPath(folderHint);
    push(expanded);
  }
  if (wantsScreenshot || !hint || /screenshot|snip/.test(hint)) {
    push(path.join(pictures, "Screenshots"));
    push(path.join(pictures, "BikliScreenshots"));
    push(path.join(home, "OneDrive", "Pictures", "Screenshots"));
    push(path.join(home, "OneDrive", "Desktop"));
    push(desktop);
    push(pictures);
    push(downloads);
  } else {
    push(desktop);
    push(pictures);
    push(downloads);
  }
  return roots;
}

function collectLocalImages(
  roots: string[],
  nameFilter: string,
  limit = 150,
): Array<{ path: string; mtime: number; name: string }> {
  let needle = (nameFilter || "").trim().toLowerCase();
  for (const junk of [
    "open",
    "the",
    "a",
    "an",
    "my",
    "first",
    "second",
    "third",
    "1st",
    "2nd",
    "3rd",
    "image",
    "photo",
    "picture",
    "file",
    "please",
  ]) {
    if (needle === junk) needle = "";
  }
  const found: Array<{ path: string; mtime: number; name: string }> = [];
  const seen = new Set<string>();

  const consider = (full: string) => {
    try {
      const st = fs.statSync(full);
      if (!st.isFile()) return;
      const ext = path.extname(full).toLowerCase();
      if (!LOCAL_IMAGE_EXTS.has(ext)) return;
      const key = path.resolve(full).toLowerCase();
      if (seen.has(key)) return;
      const base = path.basename(full).toLowerCase();
      if (needle && !base.includes(needle) && !key.includes(needle)) return;
      seen.add(key);
      found.push({ path: full, mtime: st.mtimeMs, name: path.basename(full) });
    } catch {
      /* skip */
    }
  };

  const walk = (dir: string, depth: number) => {
    if (found.length >= limit * 3 || depth > 3) return;
    let entries: string[] = [];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      return;
    }
    for (const ent of entries) {
      const full = path.join(dir, ent);
      try {
        const st = fs.statSync(full);
        if (st.isFile()) consider(full);
        else if (st.isDirectory() && depth < 3) walk(full, depth + 1);
      } catch {
        /* skip */
      }
      if (found.length >= limit * 3) break;
    }
  };

  for (const root of roots) walk(root, 0);
  found.sort((a, b) => b.mtime - a.mtime); // newest first
  return found.slice(0, limit);
}

/**
 * Open a local image/screenshot by index or name (default Photos app).
 * Used when the frozen Python agent is missing openLocalImage.
 */
function openLocalImageViaNode(
  tool: "openLocalImage" | "openFile",
  args: Record<string, unknown>,
): { ok: boolean; result?: Record<string, unknown>; error?: string } {
  try {
    // Direct path open
    const rawPath = String(args.path || "").trim();
    if (rawPath && (tool === "openFile" || fs.existsSync(expandUserFacingPath(rawPath)))) {
      const p = expandUserFacingPath(rawPath);
      if (!fs.existsSync(p)) {
        return { ok: false, error: `File not found: ${p}` };
      }
      openPathWithDefaultApp(p);
      logCommand(`${tool} (node) path=${p}`);
      return {
        ok: true,
        result: {
          result: `Opened file directly: ${p}`,
          path: p,
          name: path.basename(p),
          method: "direct_file",
          via: "node",
        },
      };
    }

    let index = Math.max(1, Math.floor(Number(args.index ?? args.n ?? args.position ?? 1) || 1));
    let name = String(
      args.name || args.filename || args.query || args.q || "",
    ).trim();
    const folderHint = String(args.folder || args.under || args.path || "").trim();
    const wantsScreenshot = /screenshot|screen\s*shot|snipping|snip/i.test(
      `${name} ${folderHint}`,
    );

    let nameFilter = name;
    if (wantsScreenshot) {
      nameFilter = name
        .replace(/\b(screenshot|screen\s*shot|snipping|snip|image|photo|picture)s?\b/gi, " ")
        .replace(/\s+/g, " ")
        .trim();
    }

    // openFile with non-image name: still try images first if "image" intent
    if (tool === "openFile" && name && !wantsScreenshot) {
      const looksImage =
        LOCAL_IMAGE_EXTS.has(path.extname(name).toLowerCase()) ||
        /\b(image|photo|picture|png|jpg|jpeg)\b/i.test(name);
      if (!looksImage && rawPath) {
        /* already handled */
      }
    }

    const roots = localImageSearchRoots(folderHint, wantsScreenshot || tool === "openLocalImage");
    let images = collectLocalImages(roots, nameFilter, 150);
    if (!images.length && nameFilter) {
      images = collectLocalImages(roots, "", 150);
    }
    if (!images.length) {
      return {
        ok: false,
        error: `No image files found${name ? ` matching '${name}'` : ""} under Desktop/Pictures/Screenshots.`,
      };
    }
    if (index > images.length) {
      return {
        ok: false,
        error: `Only found ${images.length} image(s); cannot open #${index}.`,
      };
    }
    const hit = images[index - 1];
    openPathWithDefaultApp(hit.path);
    logCommand(`${tool} (node) #${index} ${hit.path}`);
    return {
      ok: true,
      result: {
        result: `Opened image #${index} directly: ${hit.name} (${hit.path})`,
        path: hit.path,
        name: hit.name,
        index,
        total: images.length,
        method: "direct_file",
        folder: path.dirname(hit.path),
        via: "node",
      },
    };
  } catch (e: any) {
    return { ok: false, error: `Could not open local image: ${e?.message || e}` };
  }
}

/**
 * Write a plain-text file (and optionally open Notepad) entirely in Node.
 * Used when the Python agent is old/missing writeToNotepad or is slow.
 */
function writeTextFileViaNode(
  tool: "createFile" | "writeToNotepad",
  args: Record<string, unknown>,
): { ok: boolean; result?: Record<string, unknown>; error?: string } {
  try {
    let content = String(
      args.content ?? args.text ?? args.story ?? "",
    );
    if (tool === "writeToNotepad" && !content.trim()) {
      return { ok: false, error: "Parameter 'content' is required for writeToNotepad." };
    }

    let rawPath = String(args.path || args.filename || "").trim();
    if (!rawPath) {
      if (tool === "writeToNotepad") {
        const title = String(args.name || args.title || "").trim();
        if (title) {
          const safe =
            title.replace(/[<>:"/\\|?*]+/g, "").trim() || "BikliNote";
          const fileName = /\.txt$/i.test(safe) ? safe : `${safe}.txt`;
          rawPath = path.join(REAL_USER_FOLDERS.desktop, fileName);
        } else {
          const stamp = new Date()
            .toISOString()
            .replace(/[-:TZ.]/g, "")
            .slice(0, 14);
          rawPath = path.join(REAL_USER_FOLDERS.desktop, `BikliNote-${stamp}.txt`);
        }
      } else {
        return { ok: false, error: "Parameter 'path' is required for createFile." };
      }
    } else {
      rawPath = expandUserFacingPath(rawPath);
    }

    // Notepad notes default to .txt
    if (tool === "writeToNotepad" && !path.extname(rawPath)) {
      rawPath = rawPath + ".txt";
    }

    const ext = path.extname(rawPath).toLowerCase();
    if ([".docx", ".doc", ".xlsx", ".xls", ".pptx", ".ppt"].includes(ext)) {
      return {
        ok: false,
        error: `Use createWordFile/createExcelFile/createPowerPointFile for ${ext} — not plain text.`,
      };
    }

    const overwrite =
      args.overwrite === true ||
      args.overwrite === "true" ||
      tool === "writeToNotepad"; // stories replace by default
    if (fs.existsSync(rawPath) && !overwrite) {
      return { ok: false, error: `File already exists: ${rawPath}. Pass overwrite=true.` };
    }

    fs.mkdirSync(path.dirname(rawPath), { recursive: true });
    fs.writeFileSync(rawPath, content, "utf8");

    const openIt =
      tool === "writeToNotepad" &&
      args.open !== false &&
      String(args.open ?? "true").toLowerCase() !== "false" &&
      String(args.open ?? "true") !== "0";

    if (openIt && process.platform === "win32") {
      // Open Notepad minimized — never steals focus
      exec(`cmd /c start /min notepad.exe "${rawPath.replace(/"/g, "")}"`, () => {});
    }

    logCommand(`${tool} (node) path=${rawPath}`);
    return {
      ok: true,
      result: {
        result:
          tool === "writeToNotepad"
            ? `Wrote story/note and opened in Notepad: ${rawPath}`
            : `Created file on your PC: ${rawPath}`,
        path: rawPath,
        folder: path.dirname(rawPath),
        opened: openIt,
        method: "file_write",
        via: "node",
      },
    };
  } catch (e: any) {
    return { ok: false, error: `Could not write file: ${e?.message || e}` };
  }
}

/** Last image search query for "open the second image" follow-ups. */
let lastImageQuery = "";

type ImageHit = { url: string; title: string; source?: string };

function pushImageHit(
  hits: ImageHit[],
  seen: Set<string>,
  raw: string,
  source: string,
  limit: number,
): void {
  if (hits.length >= limit) return;
  let url = String(raw || "")
    .replace(/\\u0026/gi, "&")
    .replace(/\\\//g, "/")
    .replace(/&amp;/gi, "&")
    .trim();
  try {
    url = decodeURIComponent(url);
  } catch {
    /* keep */
  }
  // HTML-entity leftovers
  url = url.replace(/&quot;/gi, "").replace(/;$/, "");
  if (!/^https?:\/\//i.test(url)) return;
  const low = url.toLowerCase();
  if (seen.has(low)) return;
  if (/favicon|sprite|logo\.svg|1x1|pixel|r\.bing\.com\/rp\//i.test(low)) return;
  if (/\.(svg)(\?|$)/i.test(low) && !/\.(jpe?g|png|webp|gif)/i.test(low)) return;
  seen.add(low);
  hits.push({ url, title: `Image ${hits.length + 1}`, source });
}

/**
 * Find direct image URLs (not a search page).
 * Order: DuckDuckGo i.js → Bing HTML (murl&quot;) → Wikimedia Commons.
 */
async function fetchImageSearchResults(query: string, limit = 12): Promise<ImageHit[]> {
  const q = (query || "").trim();
  if (!q) return [];
  const hits: ImageHit[] = [];
  const seen = new Set<string>();
  const ua =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

  // 1) DuckDuckGo images API (reliable JSON)
  try {
    const home = await fetch(
      `https://duckduckgo.com/?q=${encodeURIComponent(q)}&iax=images&ia=images`,
      { headers: { "User-Agent": ua, "Accept-Language": "en-US,en;q=0.9" } },
    );
    const homeHtml = await home.text();
    const vqd =
      homeHtml.match(/vqd=["']([^"']+)["']/)?.[1] ||
      homeHtml.match(/vqd=([\d-]+)/)?.[1] ||
      "";
    if (vqd) {
      const api =
        `https://duckduckgo.com/i.js?l=us-en&o=json&q=${encodeURIComponent(q)}` +
        `&vqd=${encodeURIComponent(vqd)}&f=,,,&p=1`;
      const r = await fetch(api, {
        headers: {
          "User-Agent": ua,
          Referer: "https://duckduckgo.com/",
          Accept: "application/json",
        },
      });
      if (r.ok) {
        const j = (await r.json()) as { results?: Array<{ image?: string; title?: string; url?: string }> };
        for (const item of j.results || []) {
          if (item.image) {
            pushImageHit(hits, seen, item.image, "duckduckgo", limit);
          }
          if (hits.length >= limit) break;
        }
      }
    }
  } catch (e: any) {
    console.warn("[Image] DuckDuckGo failed:", e?.message || e);
  }

  // 2) Bing Images HTML (uses murl&quot;:&quot; encoding)
  if (hits.length < limit) {
    try {
      const searchUrl =
        `https://www.bing.com/images/search?q=${encodeURIComponent(q)}&form=HDRSC2&first=1`;
      const response = await fetch(searchUrl, {
        headers: {
          "User-Agent": ua,
          "Accept-Language": "en-US,en;q=0.9",
          Accept: "text/html,application/xhtml+xml",
        },
      });
      if (response.ok) {
        const html = await response.text();
        const patterns: Array<{ re: RegExp; source: string }> = [
          { re: /murl&quot;:&quot;(https?:[^&"<>]+)/gi, source: "bing-entity" },
          { re: /"murl"\s*:\s*"(https?:\/\/[^"\\]+)"/gi, source: "bing-json" },
          { re: /mediaurl=([^&"'<>]+)/gi, source: "bing-mediaurl" },
          { re: /"turl"\s*:\s*"(https?:\/\/[^"\\]+)"/gi, source: "bing-turl" },
          { re: /turl&quot;:&quot;(https?:[^&"<>]+)/gi, source: "bing-turl-entity" },
        ];
        for (const { re, source } of patterns) {
          let m: RegExpExecArray | null;
          while ((m = re.exec(html)) !== null && hits.length < limit) {
            pushImageHit(hits, seen, m[1], source, limit);
          }
          if (hits.length >= limit) break;
        }
      }
    } catch (e: any) {
      console.warn("[Image] Bing failed:", e?.message || e);
    }
  }

  // 3) Wikimedia Commons (always works, free)
  if (hits.length < limit) {
    try {
      const wiki =
        `https://commons.wikimedia.org/w/api.php?action=query&generator=search` +
        `&gsrsearch=${encodeURIComponent(q)}&gsrlimit=${Math.max(limit, 8)}` +
        `&gsrnamespace=6&prop=imageinfo&iiprop=url&format=json&origin=*`;
      const wr = await fetch(wiki, { headers: { "User-Agent": ua } });
      if (wr.ok) {
        const wj = (await wr.json()) as {
          query?: { pages?: Record<string, { title?: string; imageinfo?: Array<{ url?: string }> }> };
        };
        for (const page of Object.values(wj.query?.pages || {})) {
          const url = page.imageinfo?.[0]?.url;
          if (url) pushImageHit(hits, seen, url, "wikimedia", limit);
          if (hits.length >= limit) break;
        }
      }
    } catch (e: any) {
      console.warn("[Image] Wikimedia failed:", e?.message || e);
    }
  }

  return hits.slice(0, limit);
}

/**
 * Open the Nth image for a query DIRECTLY (real image URL — not Google/Bing search page).
 */
async function openImageDirect(
  query: string,
  index = 1,
): Promise<{ ok: boolean; result?: Record<string, unknown>; error?: string }> {
  const q = (query || lastImageQuery || "").trim();
  if (!q) {
    return {
      ok: false,
      error: "No image query. Tell me what image to open, e.g. 'open a cat image'.",
    };
  }
  const idx = Math.max(1, Math.floor(Number(index) || 1));
  // Debounce is claimed in callDesktopAgent / callers — do not claim again here
  // (double-claim would skip the real open).

  try {
    console.log(`[Image Open] Searching images for "${q}" (index ${idx})…`);
    const results = await fetchImageSearchResults(q, Math.max(15, idx));
    if (!results.length) {
      // Fallback: open Bing images search page only if scrape failed
      const fallback =
        `https://www.bing.com/images/search?q=${encodeURIComponent(q)}&form=HDRSC2`;
      await openUrlViaOsStart(fallback);
      return {
        ok: true,
        result: {
          result: `Could not extract a direct image URL; opened image search for "${q}".`,
          query: q,
          url: fallback,
          fallback: true,
        },
      };
    }
    if (idx > results.length) {
      return {
        ok: false,
        error: `Only found ${results.length} image(s) for "${q}"; cannot open #${idx}.`,
      };
    }
    const hit = results[idx - 1];
    lastImageQuery = q;
    // Download locally + open — avoids Windows "untrusted source" security dialog
    // that appears when opening remote image URLs via start/Photos.
    const opened = await openRemoteImageSafely(hit.url);
    logCommand(
      `IMAGE_OPEN "${q}" #${idx} via=${opened.via} -> ${(opened.localPath || hit.url).slice(0, 120)}`,
    );
    return {
      ok: true,
      result: {
        result: opened.localPath
          ? `Opened image #${idx} for "${q}" (saved locally, no security prompt).`
          : `Opened image #${idx} for "${q}" in the browser.`,
        url: hit.url,
        localPath: opened.localPath || null,
        query: q,
        index: idx,
        title: hit.title,
        method: opened.via,
      },
    };
  } catch (err: any) {
    const msg = err?.message || String(err);
    logError(`IMAGE_OPEN_FAILED: ${msg}`);
    return { ok: false, error: `Could not open image: ${msg}` };
  }
}

/**
 * Search YouTube and open the Nth video (1-based) on the watch page.
 * This is the fix for "play X on YouTube" / "play the first video".
 */
function normalizeYtTitle(s: string): string {
  return String(s || "")
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** True when browser title looks like the video we already opened (watch page). */
function isLikelyWatchPageTitle(browserTitle: string): boolean {
  const t = normalizeYtTitle(browserTitle);
  if (!t || t.length < 4) return false;
  const played = normalizeYtTitle(lastPlayedVideoTitle);
  if (played) {
    if (t === played) return true;
    if (t.includes(played) || played.includes(t)) return true;
    // Same video often shortens in the title bar
    if (t.slice(0, 36) && played.slice(0, 36) && t.slice(0, 36) === played.slice(0, 36)) {
      return true;
    }
  }
  return false;
}

/**
 * Read active YouTube/browser window title to recover the current search query
 * (e.g. "cat videos - YouTube - Google Chrome"). Prefers the foreground window
 * so a manual new search wins over a stale lastYouTubeQuery.
 */
async function guessYouTubeQueryFromBrowserTitle(): Promise<string> {
  if (process.platform !== "win32") return "";
  const script = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class BikliYtTitle {
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
}
"@
function Get-WinTitle([IntPtr]$h) {
  if ($h -eq [IntPtr]::Zero) { return '' }
  $sb = New-Object System.Text.StringBuilder 512
  [void][BikliYtTitle]::GetWindowText($h, $sb, $sb.Capacity)
  return $sb.ToString()
}
# Prefer foreground window when it is YouTube (user just opened/searched manually)
$fg = [BikliYtTitle]::GetForegroundWindow()
$fgTitle = Get-WinTitle $fg
if ($fgTitle -and $fgTitle.ToLower().Contains('youtube')) {
  Write-Output $fgTitle
  exit 0
}
# Otherwise pick the best YouTube window: prefer shorter titles (search results)
# over long watch-page titles so a manual new search wins after "play first".
$script:best = ''
$script:bestScore = -1
[BikliYtTitle]::EnumWindows({
  param($h,$l)
  if (-not [BikliYtTitle]::IsWindowVisible($h)) { return $true }
  $t = Get-WinTitle $h
  if (-not $t) { return $true }
  $low = $t.ToLower()
  if (-not $low.Contains('youtube')) { return $true }
  $qPart = ($t -replace '\s*[-|]\s*YouTube.*$','').Trim()
  $score = 10
  # Short titles look like search queries; long ones look like video titles
  if ($qPart.Length -le 28) { $score += 40 }
  elseif ($qPart.Length -le 48) { $score += 20 }
  elseif ($qPart.Length -gt 70) { $score -= 15 }
  # Active browser chrome often includes browser name
  if ($low.Contains('chrome') -or $low.Contains('edge') -or $low.Contains('brave') -or $low.Contains('firefox')) { $score += 5 }
  if ($score -gt $script:bestScore) { $script:bestScore = $score; $script:best = $t }
  return $true
}, [IntPtr]::Zero) | Out-Null
Write-Output $script:best
`;
  const scriptPath = path.join(os.tmpdir(), `bikli-yt-title-${Date.now()}.ps1`);
  try {
    fs.writeFileSync(scriptPath, script, "utf8");
    const title = await new Promise<string>((resolve) => {
      exec(
        `powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${scriptPath}"`,
        { windowsHide: true, timeout: 8000 },
        (err, stdout) => {
          try {
            fs.unlinkSync(scriptPath);
          } catch {
            /* ignore */
          }
          if (err) resolve("");
          else resolve(String(stdout || "").trim());
        },
      );
    });
    if (!title) return "";
    // "query - YouTube" / "query - YouTube - Google Chrome" / "query | YouTube"
    let q = title
      .replace(/\s*[-|]\s*YouTube.*$/i, "")
      .replace(/\s*-\s*(Google Chrome|Microsoft Edge|Brave|Firefox|Opera|MSEdge).*$/i, "")
      .replace(/\s+/g, " ")
      .trim();
    if (q.length < 2 || q.length > 120) return "";
    if (/^(youtube|home|subscriptions|library|history|trending)$/i.test(q)) return "";
    console.log(`[YouTube] Browser window title → "${q}"`);
    return q;
  } catch {
    try {
      fs.unlinkSync(scriptPath);
    } catch {
      /* ignore */
    }
    return "";
  }
}

/**
 * Resolve which search query to use for "play first/Nth video".
 * Critical fix: after user opens browser manually and searches something new,
 * do NOT keep playing the old cached search (e.g. motupatlu).
 */
async function resolveYouTubePlayQuery(requestedQuery: string): Promise<string> {
  const explicit = String(requestedQuery || "").trim();
  const cached = String(lastYouTubeQuery || "").trim();
  const fromBrowser = await guessYouTubeQueryFromBrowserTitle();

  // Explicit NEW topic from the model (not just replaying the stale cache).
  const isExplicitFresh =
    Boolean(explicit) &&
    (!cached || explicit.toLowerCase() !== cached.toLowerCase());

  if (isExplicitFresh) {
    console.log(`[YouTube] Using explicit query "${explicit}"`);
    return explicit;
  }

  // Live browser context wins over stale lastYouTubeQuery.
  if (fromBrowser) {
    // Still on the watch page of the video we opened → keep prior search for Nth result.
    if (isLikelyWatchPageTitle(fromBrowser)) {
      const keep = cached || explicit || fromBrowser;
      console.log(
        `[YouTube] Watch page detected ("${fromBrowser}"); keeping search query "${keep}"`,
      );
      return keep;
    }
    // Different title than cache = user manually searched / changed results.
    if (!cached || fromBrowser.toLowerCase() !== cached.toLowerCase()) {
      console.log(
        `[YouTube] Live browser query "${fromBrowser}" overrides stale cache "${cached}"`,
      );
      lastYouTubeQuery = fromBrowser;
      lastYouTubeQueryAt = Date.now();
      // New search context — allow replaying index 1 even if debounce still active for old query
      if (lastYouTubePlayKey && !lastYouTubePlayKey.startsWith(`${fromBrowser.toLowerCase()}|`)) {
        lastYouTubePlayKey = "";
        lastYouTubePlayAt = 0;
      }
      return fromBrowser;
    }
    // Browser still shows same search as cache
    return fromBrowser;
  }

  const fallback = explicit || cached;
  if (fallback) {
    console.log(`[YouTube] Using fallback query "${fallback}" (no live browser title)`);
  }
  return fallback;
}

/** Focus best YouTube/browser window; return window title (best-effort). */
async function focusYouTubeBrowserWindow(): Promise<string> {
  if (process.platform !== "win32") return "";
  const ps = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class BikliYtFocus {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
}
"@
function Get-T([IntPtr]$h) {
  $sb = New-Object System.Text.StringBuilder 512
  [void][BikliYtFocus]::GetWindowText($h, $sb, $sb.Capacity)
  return $sb.ToString()
}
$script:best = [IntPtr]::Zero
$script:bestScore = -1
$script:bestTitle = ''
[BikliYtFocus]::EnumWindows({
  param($h,$l)
  if (-not [BikliYtFocus]::IsWindowVisible($h)) { return $true }
  $t = Get-T $h
  if (-not $t) { return $true }
  $low = $t.ToLower()
  $score = -1
  if ($low.Contains('youtube')) { $score = 100 }
  elseif ($low.Contains('chrome') -or $low.Contains('edge') -or $low.Contains('brave') -or $low.Contains('firefox') -or $low.Contains('opera')) { $score = 40 }
  if ($score -gt $script:bestScore) { $script:bestScore = $score; $script:best = $h; $script:bestTitle = $t }
  return $true
}, [IntPtr]::Zero) | Out-Null
if ($script:best -eq [IntPtr]::Zero) { Write-Output ''; exit 0 }
if ([BikliYtFocus]::IsIconic($script:best)) { [void][BikliYtFocus]::ShowWindow($script:best, 9); Start-Sleep -Milliseconds 80 }
# Alt pulse so SetForegroundWindow is allowed
[BikliYtFocus]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero)
[BikliYtFocus]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero)
[void][BikliYtFocus]::SetForegroundWindow($script:best)
Start-Sleep -Milliseconds 200
Write-Output $script:bestTitle
`.trim();
  try {
    return (await runPowerShellScript(ps, 10000)).trim();
  } catch {
    return "";
  }
}

/**
 * Read the active browser address-bar URL (Ctrl+L, Ctrl+C) with clipboard restore.
 * Used to know if user is on results vs watch vs home — so we click ON-SCREEN videos.
 */
async function readActiveBrowserUrl(): Promise<string> {
  if (process.platform !== "win32") return "";
  await focusYouTubeBrowserWindow();
  const ps = `
$ErrorActionPreference = 'SilentlyContinue'
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class BikliUrlRead {
  [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
  public const uint KEYUP = 0x0002;
  public static void Hotkey(byte mod, byte key) {
    keybd_event(mod, 0, 0, UIntPtr.Zero);
    System.Threading.Thread.Sleep(35);
    keybd_event(key, 0, 0, UIntPtr.Zero);
    System.Threading.Thread.Sleep(35);
    keybd_event(key, 0, KEYUP, UIntPtr.Zero);
    System.Threading.Thread.Sleep(35);
    keybd_event(mod, 0, KEYUP, UIntPtr.Zero);
  }
  public static void Key(byte key) {
    keybd_event(key, 0, 0, UIntPtr.Zero);
    System.Threading.Thread.Sleep(25);
    keybd_event(key, 0, KEYUP, UIntPtr.Zero);
  }
}
"@
$oldClip = ''
try { $oldClip = Get-Clipboard -Raw -ErrorAction SilentlyContinue } catch {}
if ($null -eq $oldClip) { $oldClip = '' }
Start-Sleep -Milliseconds 120
[BikliUrlRead]::Hotkey(0x11, 0x4C)  # Ctrl+L
Start-Sleep -Milliseconds 160
[BikliUrlRead]::Hotkey(0x11, 0x43)  # Ctrl+C
Start-Sleep -Milliseconds 160
$url = ''
try { $url = Get-Clipboard -Raw -ErrorAction SilentlyContinue } catch {}
if ($null -eq $url) { $url = '' }
$url = ($url -split "\`n")[0].Trim()
# Leave address bar
[BikliUrlRead]::Key(0x1B)  # Esc
Start-Sleep -Milliseconds 60
try { Set-Clipboard -Value $oldClip } catch {}
if ($url -match '^https?://' -or $url -match 'youtube\\.com|youtu\\.be') {
  Write-Output $url
} else {
  Write-Output ''
}
`.trim();
  try {
    const out = (await runPowerShellScript(ps, 12000)).trim();
    const line = out.split(/\r?\n/).filter(Boolean).pop() || "";
    if (/youtube\.com|youtu\.be|https?:\/\//i.test(line)) {
      console.log(`[YouTube] Address bar URL: ${line.slice(0, 140)}`);
      return line;
    }
    return "";
  } catch (e: any) {
    console.warn(`[YouTube] readActiveBrowserUrl failed: ${e?.message || e}`);
    return "";
  }
}

function extractYouTubeSearchQueryFromUrl(url: string): string {
  try {
    const u = new URL(url);
    if (!/youtube\.com/i.test(u.hostname)) return "";
    const q = u.searchParams.get("search_query") || "";
    return decodeURIComponent(q.replace(/\+/g, " ")).trim();
  } catch {
    return "";
  }
}

function extractYouTubeVideoIdFromUrl(url: string): string {
  try {
    const u = new URL(url.startsWith("http") ? url : `https://${url}`);
    if (/youtu\.be/i.test(u.hostname)) {
      return u.pathname.replace(/^\//, "").slice(0, 11);
    }
    return u.searchParams.get("v") || "";
  } catch {
    return "";
  }
}

/**
 * Click the Nth video card visible in the REAL YouTube browser window.
 * This matches Share Screen / manual open — does NOT re-scrape (which returns different order).
 * @param knownUrl optional URL already read (avoids a second Ctrl+L that steals focus).
 */
async function clickNthYouTubeResultInBrowser(
  index: number,
  knownUrl = "",
): Promise<{ ok: boolean; url?: string; method?: string; error?: string }> {
  if (process.platform !== "win32") {
    return { ok: false, error: "in-browser click only on Windows" };
  }
  const idx = Math.max(1, Math.min(10, Math.floor(index || 1)));
  const winTitleBefore = await focusYouTubeBrowserWindow();
  if (!winTitleBefore) {
    return { ok: false, error: "No YouTube/browser window found to click" };
  }

  // Prefer caller-provided URL — re-reading address bar steals focus and is slow.
  const beforeUrl = knownUrl || (await readActiveBrowserUrl());
  const onWatch = /youtube\.com\/watch|youtu\.be\//i.test(beforeUrl);
  if (onWatch) {
    const vid = extractYouTubeVideoIdFromUrl(beforeUrl);
    console.log(`[YouTube] Already on watch page ${vid} — not clicking another video`);
    return {
      ok: true,
      url: beforeUrl,
      method: "already_watching",
    };
  }

  const onResults = /youtube\.com\/results/i.test(beforeUrl);

  const ps = `
$ErrorActionPreference = 'SilentlyContinue'
$index = ${idx}
$onResults = $${onResults ? "true" : "false"}
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class BikliYtClick {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, UIntPtr e);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  public const uint LEFTDOWN = 0x0002;
  public const uint LEFTUP = 0x0004;
}
"@
function Get-T([IntPtr]$h) {
  $sb = New-Object System.Text.StringBuilder 512
  [void][BikliYtClick]::GetWindowText($h, $sb, $sb.Capacity)
  return $sb.ToString()
}
$script:best = [IntPtr]::Zero
$script:bestScore = -1
[BikliYtClick]::EnumWindows({
  param($h,$l)
  if (-not [BikliYtClick]::IsWindowVisible($h)) { return $true }
  $t = Get-T $h
  if (-not $t) { return $true }
  $low = $t.ToLower()
  $score = -1
  if ($low.Contains('youtube')) { $score = 100 }
  elseif ($low.Contains('chrome') -or $low.Contains('edge') -or $low.Contains('brave') -or $low.Contains('firefox')) { $score = 40 }
  if ($score -gt $script:bestScore) { $script:bestScore = $score; $script:best = $h }
  return $true
}, [IntPtr]::Zero) | Out-Null
if ($script:best -eq [IntPtr]::Zero) { Write-Output 'no_window'; exit 0 }
if ([BikliYtClick]::IsIconic($script:best)) { [void][BikliYtClick]::ShowWindow($script:best, 9); Start-Sleep -Milliseconds 100 }
[BikliYtClick]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero)
[BikliYtClick]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero)
[void][BikliYtClick]::SetForegroundWindow($script:best)
Start-Sleep -Milliseconds 280
$r = New-Object BikliYtClick+RECT
[void][BikliYtClick]::GetWindowRect($script:best, [ref]$r)
$w = [Math]::Max(200, $r.Right - $r.Left)
$h = [Math]::Max(200, $r.Bottom - $r.Top)
# YouTube list results: thumbnail column left-center under filter chips.
# Single click only — double-click often hits a different card or ads.
if ($onResults) {
  $xRatio = 0.28
  $yBase = 0.26
  $yStep = 0.135
} else {
  # Home / browse grid
  $xRatio = 0.18
  $yBase = 0.32
  $yStep = 0.20
}
$x = [int]($r.Left + $w * $xRatio)
$y = [int]($r.Top + $h * ($yBase + ($index - 1) * $yStep))
if ($x -lt $r.Left + 48) { $x = $r.Left + 48 }
if ($x -gt $r.Right - 48) { $x = $r.Right - 48 }
if ($y -lt $r.Top + 100) { $y = $r.Top + 100 }
if ($y -gt $r.Bottom - 48) { $y = $r.Bottom - 48 }
# Click thumbnail (not filter chips)
[void][BikliYtClick]::SetCursorPos($x, $y)
Start-Sleep -Milliseconds 90
[BikliYtClick]::mouse_event([BikliYtClick]::LEFTDOWN, 0, 0, 0, [UIntPtr]::Zero)
Start-Sleep -Milliseconds 50
[BikliYtClick]::mouse_event([BikliYtClick]::LEFTUP, 0, 0, 0, [UIntPtr]::Zero)
Write-Output ("clicked:" + $x + "," + $y + " size=" + $w + "x" + $h)
`.trim();

  try {
    const clickOut = await runPowerShellScript(ps, 15000);
    console.log(`[YouTube] In-browser click #${idx}: ${clickOut.trim().slice(0, 120)}`);
    if (!/clicked:/i.test(clickOut)) {
      return { ok: false, error: clickOut.trim() || "click script failed" };
    }
    // Wait for navigation, then CONFIRM a watch page was actually reached.
    //
    // This used to fall through to a "soft success" that returned ok:true
    // whenever the coordinate click landed anywhere — so a click that hit empty
    // space on the YouTube home page still reported success, playYouTubeVideo
    // returned "Clicked video #1 on screen", and Bikli told the user she was
    // playing a video while the browser had not moved. Guessed coordinates miss
    // often enough that an unverified click must count as a FAILURE, so the
    // caller falls back to opening a real watch URL.
    await new Promise((r) => setTimeout(r, 1600));
    const afterUrl = await readActiveBrowserUrl();
    if (/youtube\.com\/watch|youtu\.be\//i.test(afterUrl)) {
      return { ok: true, url: afterUrl, method: "in_browser_click" };
    }
    if (afterUrl) {
      // Address bar readable and it is NOT a watch page — the click missed.
      return {
        ok: false,
        error: `Click did not open a video (still on ${afterUrl.slice(0, 80)})`,
      };
    }
    // Address bar unreadable — fall back to the window title. A watch page
    // shows "<video title> - YouTube"; home/results keep their own titles.
    const titleAfter = await focusYouTubeBrowserWindow();
    const topicAfter = normalizeYtTitle(
      titleAfter
        .replace(/\s*[-|]\s*(Google Chrome|Microsoft Edge|Brave|Firefox|Opera|MSEdge).*$/i, "")
        .replace(/\s*[-|]\s*YouTube\s*$/i, "")
        .replace(/^\(\d+\)\s*/, ""),
    );
    const looksLikeVideo =
      Boolean(topicAfter) &&
      !/^(youtube|home|trending|subscriptions|library|history|shorts|explore)$/i.test(topicAfter) &&
      normalizeYtTitle(titleAfter) !== normalizeYtTitle(winTitleBefore) &&
      !onResults; // on a results page the topic is the query, not a video
    if (looksLikeVideo) {
      return { ok: true, url: beforeUrl || "", method: "in_browser_click_title_confirmed" };
    }
    return { ok: false, error: "Click did not navigate to a video page" };
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) };
  }
}

/** Pick result whose title best matches a vision/screen title (Share Screen). */
function pickBestTitleMatch(
  results: YouTubeVideoHit[],
  wantTitle: string,
): YouTubeVideoHit | null {
  const want = normalizeYtTitle(wantTitle);
  if (!want || results.length === 0) return null;
  let best: YouTubeVideoHit | null = null;
  let bestScore = 0;
  for (const r of results) {
    const t = normalizeYtTitle(r.title);
    if (!t) continue;
    let score = 0;
    if (t === want) score = 100;
    else if (t.includes(want) || want.includes(t)) score = 80;
    else {
      const wantWords = want.split(" ").filter((w) => w.length > 2);
      const hitWords = new Set(t.split(" ").filter((w) => w.length > 2));
      const overlap = wantWords.filter((w) => hitWords.has(w)).length;
      score = wantWords.length ? (overlap / wantWords.length) * 70 : 0;
    }
    if (score > bestScore) {
      bestScore = score;
      best = r;
    }
  }
  return bestScore >= 35 ? best : null;
}

async function playYouTubeVideo(
  query: string,
  index = 1,
  opts?: { title?: string; preferOnScreen?: boolean },
): Promise<{ ok: boolean; result?: Record<string, unknown>; error?: string }> {
  const idx = Math.max(1, Math.floor(Number(index) || 1));
  const screenTitle = String(opts?.title || "").trim();
  const requested = String(query || "").trim();

  // ── STEP 0: On-screen card click (when the user points at a visible card) ──
  // This was previously dead code: `preferOnScreen` was accepted but never read,
  // so the in-browser click never ran and a direct open could land on a
  // different video than the one the user actually sees on screen.
  if (opts?.preferOnScreen) {
    try {
      const clickRes = await clickNthYouTubeResultInBrowser(idx);
      if (clickRes.ok) {
        logCommand(`YOUTUBE_PLAY on-screen click #${idx} -> ${clickRes.url || "n/a"}`);
        return {
          ok: true,
          result: {
            result: `Clicked video #${idx} on screen.`,
            url: clickRes.url || "",
            method: clickRes.method || "in_browser_click",
            index: idx,
          },
        };
      }
      console.log(`[YouTube] On-screen click not possible (${clickRes.error}), falling back to direct open.`);
    } catch (clickErr: any) {
      console.warn("[YouTube] On-screen click attempt failed, falling back:", clickErr?.message || clickErr);
    }
  }

  // ── STEP 1: Resolve search query ────────────────────────────────────────
  // Named song: use the title model/user gave. Index-only words → fall back to last search.
  const isIndexOnly = /^(first|1st|second|2nd|third|3rd|video|result|one|this|that|next)$/i.test(requested);
  let searchQ = (isIndexOnly ? "" : requested) || lastYouTubeQuery || screenTitle;

  if (!searchQ) {
    // Ask the live browser what it is showing. resolveYouTubePlayQuery reads the
    // real window title (e.g. "lofi beats - YouTube"), so "open youtube" →
    // search something → "play video" uses what is actually on screen. It was
    // written for exactly this and then never called from anywhere.
    try {
      searchQ = await resolveYouTubePlayQuery("");
    } catch (resolveErr: any) {
      console.warn("[YouTube] Live query resolve failed:", resolveErr?.message || resolveErr);
    }
  }

  if (!searchQ) {
    // Nothing named, nothing searched earlier, and the on-screen click above
    // could not reach a video. YouTube's home feed cannot be read server-side
    // (it returns an empty shell without consent cookies), so there is no
    // honest way to pick "a video" here — ASK instead of pretending.
    logCommand(`YOUTUBE_PLAY unresolved (no query, on-screen click failed) index=${idx}`);
    return {
      ok: false,
      error:
        "NOT_PLAYED: I could not tell which video to play — nothing is searched yet. " +
        "Tell the user out loud that you need the name, and ask them briefly, e.g. " +
        "\"Which video should I play?\". Do NOT say you played or opened anything.",
    };
  }

  // ── STEP 2: Debounce same play (only within the window — a later re-request
  // of the same video must actually re-open it, not stay blocked all session) ──
  const playKey = `${searchQ.toLowerCase()}|${idx}|${screenTitle.slice(0, 40).toLowerCase()}`;
  const withinWindow = Date.now() - lastYouTubePlayAt < YOUTUBE_PLAY_DEBOUNCE_MS;
  if (playKey === lastYouTubePlayKey && lastYouTubePlayAt > 0 && withinWindow) {
    if (mediaPlaybackState === "paused") {
      return { ok: true, result: { result: `Video is paused. Call browserMediaControl(action='play') if the user says resume.`, blocked: true, state: "paused" } };
    }
    return { ok: true, result: { result: `Already opened video #${idx} for "${searchQ}".`, debounced: true, state: mediaPlaybackState } };
  }

  // ── STEP 3: Search YouTube API for the best video ──────────────────────
  try {
    console.log(`[YouTube Play] Searching for "${searchQ}" (index ${idx})...`);
    const results = await fetchYouTubeSearchResults(searchQ, Math.max(15, idx));
    if (!results.length) {
      return { ok: false, error: `No YouTube videos found for "${searchQ}". Try a different search.` };
    }

    // Pick by exact title if model gave one (screenTitle from vision, or requested query).
    // ALWAYS try title-matching so "play Believer by Imagine Dragons" finds the right video.
    let hit: YouTubeVideoHit | null = null;
    if (screenTitle) {
      hit = pickBestTitleMatch(results, screenTitle);
    }
    if (!hit && requested) {
      hit = pickBestTitleMatch(results, requested);
    }
    if (!hit) {
      if (idx > results.length) {
        return { ok: false, error: `Only found ${results.length} video(s) for "${searchQ}"; cannot play #${idx}.` };
      }
      hit = results[idx - 1];
    }

    // ── STEP 4: OPEN DIRECTLY via OS (no clipboard, no Ctrl+L, no address bar) ─
    lastYouTubeQuery = searchQ;
    lastYouTubeQueryAt = Date.now();
    lastPlayedVideoTitle = hit.title || "";
    lastYouTubePlayKey = playKey;
    lastYouTubePlayAt = Date.now();
    mediaPlaybackState = "playing";
    lastMediaActionAt = Date.now();

    const watchUrl = `https://www.youtube.com/watch?v=${hit.videoId}&autoplay=1`;
    try {
      await openUrlViaOsStart(watchUrl);
    } catch (openErr) {
      console.warn(`[YouTube Play] OS open failed, trying shell fallback:`, openErr);
      // Fallback: use exec with full shell so URL parsing is more lenient
      try {
        await new Promise<void>((resolve, reject) => {
          exec(`start "" "${watchUrl.replace(/"/g, '')}"`, { windowsHide: true }, (err: any) => {
            if (err) reject(err); else resolve();
          });
        });
      } catch (e2) {
        console.error(`[YouTube Play] All open methods failed:`, e2);
      }
    }
    logCommand(`YOUTUBE_PLAY "${searchQ}" #${idx} -> ${hit.videoId} "${hit.title}"`);
    return {
      ok: true,
      result: {
        result: `Playing "${hit.title}" by ${hit.author}.`,
        url: watchUrl,
        videoId: hit.videoId,
        title: hit.title,
        author: hit.author,
        query: searchQ,
        index: idx,
        method: "direct_open",
      },
    };
  } catch (err: any) {
    const msg = err?.message || String(err);
    logError(`YOUTUBE_PLAY_FAILED: ${msg}`);
    return { ok: false, error: `Could not play YouTube video: ${msg}` };
  }
}

/** True when the user/model explicitly asked for a NEW window/tab/instance. */
function wantNewWindow(args: Record<string, unknown> | undefined | null): boolean {
  if (!args) return false;
  if (args.new_window === true || args.new === true || args.new_tab === true) return true;
  for (const key of ["new_window", "new", "mode", "window", "open_mode", "target"]) {
    const v = String(args[key] ?? "")
      .trim()
      .toLowerCase()
      .replace(/[-_]+/g, " ");
    if (
      [
        "new",
        "new window",
        "newwindow",
        "new tab",
        "newtab",
        "true",
        "1",
        "yes",
        "open in new",
        "open new",
        "force new",
      ].includes(v)
    ) {
      return true;
    }
  }
  for (const key of ["name", "path", "folder", "application", "app", "url", "query"]) {
    const v = String(args[key] ?? "").toLowerCase();
    if (/\b(in\s+a?\s*new(\s+window|\s+tab)?|new\s+window|open\s+new)\b/.test(v)) {
      return true;
    }
  }
  return false;
}

/** Run a short PowerShell script; returns trimmed stdout. */
function runPowerShellScript(script: string, timeoutMs = 8000): Promise<string> {
  return new Promise((resolve, reject) => {
    const scriptPath = path.join(
      os.tmpdir(),
      `bikli-ps-${Date.now()}-${Math.random().toString(36).slice(2)}.ps1`,
    );
    try {
      fs.writeFileSync(scriptPath, script, "utf8");
    } catch (e) {
      reject(e);
      return;
    }
    exec(
      `powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${scriptPath}"`,
      { windowsHide: true, timeout: timeoutMs },
      (err, stdout, stderr) => {
        try {
          fs.unlinkSync(scriptPath);
        } catch {
          /* ignore */
        }
        if (err) reject(new Error(String(stderr || err.message || err)));
        else resolve(String(stdout || "").trim());
      },
    );
  });
}

/**
 * Focus a running app by process image (e.g. chrome.exe). Returns true if focused.
 * Does not handle explorer.exe (use openFolderViaNode instead).
 */
async function focusAppViaNode(image: string): Promise<boolean> {
  if (process.platform !== "win32") return false;
  let img = (image || "").trim();
  if (!img) return false;
  if (!/\.exe$/i.test(img)) img = `${img}.exe`;
  if (/^explorer\.exe$/i.test(img)) return false;
  const safe = img.replace(/'/g, "''");
  const ps = `
$ErrorActionPreference='SilentlyContinue'
$img='${safe}'
$base = $img -replace '\\.exe$',''
$procs = @(Get-Process | Where-Object { $_.ProcessName -eq $base -and $_.MainWindowHandle -ne 0 })
if (-not $procs -or $procs.Count -eq 0) { Write-Output 'none'; exit 0 }
$h = [int64]$procs[0].MainWindowHandle
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class BikliFocusAppN {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
}
"@
$ptr = [IntPtr]$h
if ([BikliFocusAppN]::IsIconic($ptr)) { [void][BikliFocusAppN]::ShowWindow($ptr, 9) }
else { [void][BikliFocusAppN]::ShowWindow($ptr, 5) }
[void][BikliFocusAppN]::SetForegroundWindow($ptr)
Write-Output 'focused'
`.trim();
  try {
    const out = await runPowerShellScript(ps, 10000);
    return /focused/i.test(out);
  } catch {
    return false;
  }
}

/**
 * Open/navigate a folder in File Explorer.
 * Default: reuse the existing Explorer window (Navigate).
 * Only new_window=true opens a second Explorer window.
 */
async function openFolderViaNode(
  args: Record<string, unknown>,
): Promise<{ ok: boolean; result?: Record<string, unknown>; error?: string }> {
  const newWindow = wantNewWindow(args);
  let raw = String(args.name || args.path || args.folder || "").trim();
  raw = raw.replace(/\s*(in\s+a?\s*new(\s+window)?|new\s+window)\s*$/i, "").trim();

  // Special Explorer locations that are NOT filesystem paths. These use shell
  // folder CLSIDs, so they navigate correctly to "This PC" / "Recycle Bin" etc.
  // instead of the old behaviour (focus-only no-op when no Explorer was open).
  // Keys are matched case-insensitively against the user's raw input.
  const SPECIAL_SHELL_LOCATIONS: Record<string, string> = {
    "this pc": "::{20D04FE0-3AEA-1069-A2D8-08002B30309D}",
    computer: "::{20D04FE0-3AEA-1069-A2D8-08002B30309D}",
    "my computer": "::{20D04FE0-3AEA-1069-A2D8-08002B30309D}",
    "recycle bin": "::{645FF040-5081-101B-9F08-00AA002F954E}",
    "network": "::{F02C1A0D-BE21-4350-88B0-7447B526A23E}",
    "control panel": "::{26EE0668-A00A-44D7-9371-BEB064C98683}",
  };
  const specialKey = raw.toLowerCase().trim();
  const specialTarget = SPECIAL_SHELL_LOCATIONS[specialKey] || "";

  // explorerOnly = plain "open explorer" with NO location → just focus/open.
  // "This PC" and friends are NOT explorerOnly — they have a real target below.
  const explorerOnly = !raw && !specialTarget;

  let folderPath = "";
  if (specialTarget) {
    folderPath = specialTarget;
  } else if (!explorerOnly) {
    folderPath = expandUserFacingPath(raw);
    // Friendly aliases already handled by expandUserFacingPath for desktop/etc.
    if (!fs.existsSync(folderPath)) {
      // Try REAL_USER_FOLDERS direct alias
      const key = raw.toLowerCase();
      if (REAL_USER_FOLDERS[key] && fs.existsSync(REAL_USER_FOLDERS[key])) {
        folderPath = REAL_USER_FOLDERS[key];
      } else {
        return { ok: false, error: `Folder does not exist: ${folderPath || raw}` };
      }
    }
  }

  if (process.platform !== "win32") {
    return { ok: false, error: "openFolder reuse is Windows-only." };
  }

  // Shell CLSID targets (e.g. "This PC") cannot be passed to fs/explorer.exe
  // the same way — they must go through the Shell.Application Navigate path.
  const isShellTarget = folderPath.startsWith("::");
  const safePath = folderPath.replace(/'/g, "''");
  const ps = `
$ErrorActionPreference = 'SilentlyContinue'
$shell = New-Object -ComObject Shell.Application
$newWindow = ${newWindow ? "$true" : "$false"}
$focusOnly = ${explorerOnly ? "$true" : "$false"}
$isShell = ${isShellTarget ? "$true" : "$false"}
$target = '${safePath}'

Add-Type @"
using System;
using System.Runtime.InteropServices;
public class BikliExplorerN {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
}
"@

function Get-ExplorerWins {
  $list = New-Object System.Collections.ArrayList
  foreach ($w in @($shell.Windows())) {
    try {
      $fn = [string]$w.FullName
      if ($fn -and ($fn -match 'explorer\\.exe$')) { [void]$list.Add($w) }
    } catch {}
  }
  return ,@($list.ToArray())
}

function Focus-Win($w) {
  try {
    $hwnd = [IntPtr]([int64]$w.HWND)
    if ([BikliExplorerN]::IsIconic($hwnd)) { [void][BikliExplorerN]::ShowWindow($hwnd, 9) }
    [void][BikliExplorerN]::SetForegroundWindow($hwnd)
  } catch {}
}

if ($newWindow) {
  if ($target) { Start-Process explorer.exe -ArgumentList "\`"$target\`"" }
  else { Start-Process explorer.exe }
  Write-Output 'new'
  exit 0
}

$wins = @(Get-ExplorerWins)
if ($wins.Count -gt 0) {
  $w = $wins[$wins.Count - 1]
  if ($target -and -not $focusOnly) {
    # Shell CLSID targets (This PC, Recycle Bin, …) navigate more reliably via
    # explorer.exe than the COM Navigate method on some Explorer versions.
    if ($isShell) {
      Start-Process explorer.exe -ArgumentList "\`"$target\`""
      Write-Output 'reused'
      exit 0
    }
    try { $w.Navigate($target) } catch {
      Start-Process explorer.exe -ArgumentList "\`"$target\`""
      Write-Output 'opened'
      exit 0
    }
  }
  Focus-Win $w
  if ($focusOnly -or -not $target) { Write-Output 'focused' } else { Write-Output 'reused' }
  exit 0
}

if ($target) { Start-Process explorer.exe -ArgumentList "\`"$target\`"" }
else { Start-Process explorer.exe }
Write-Output 'opened'
`.trim();

  try {
    const out = await runPowerShellScript(ps, 15000);
    const mode = (out.split(/\r?\n/).pop() || "opened").trim().toLowerCase();
    const m = ["new", "reused", "focused", "opened"].includes(mode) ? mode : "opened";
    const messages: Record<string, string> = {
      new: folderPath
        ? `Opened a new File Explorer window at ${folderPath}.`
        : "Opened a new File Explorer window.",
      reused: `Navigated the open File Explorer to ${folderPath} (same window).`,
      focused: "Brought the existing File Explorer window to the front.",
      opened: folderPath
        ? `Opened File Explorer at ${folderPath}.`
        : "Opened File Explorer.",
    };
    logCommand(`OPEN_FOLDER mode=${m} path=${folderPath || "(explorer)"}`);
    return {
      ok: true,
      result: {
        result: messages[m],
        path: folderPath || null,
        mode: m,
        via: "node-explorer-reuse",
      },
    };
  } catch (e: any) {
    // Last resort
    try {
      if (folderPath) {
        await new Promise<void>((resolve, reject) => {
          exec(
            `cmd /c start "" explorer "${folderPath.replace(/"/g, "")}"`,
            { windowsHide: true },
            (err) => (err ? reject(err) : resolve()),
          );
        });
      } else {
        await new Promise<void>((resolve, reject) => {
          exec(`cmd /c start "" explorer`, { windowsHide: true }, (err) =>
            err ? reject(err) : resolve(),
          );
        });
      }
      return {
        ok: true,
        result: {
          result: folderPath ? `Opened folder: ${folderPath}` : "Opened File Explorer.",
          path: folderPath || null,
          mode: "opened",
          via: "node-explorer-fallback",
        },
      };
    } catch (e2: any) {
      return { ok: false, error: e2?.message || e?.message || String(e2 || e) };
    }
  }
}

/**
 * Open any installed Windows app from Node when the Python agent is old or
 * fails. Strategies: focus existing → known aliases → Start Menu .lnk →
 * Get-StartApps → Windows Search (Win+S → type → Enter) → shell start.
 */
async function openApplicationViaNode(
  rawName: string,
  opts?: { newWindow?: boolean; folder?: string },
): Promise<{ ok: boolean; result?: Record<string, unknown>; error?: string }> {
  const name = (rawName || "").trim();
  if (!name) {
    return { ok: false, error: "Parameter 'name' (application name) is required." };
  }
  const newWindow = Boolean(opts?.newWindow);
  // Optional working directory for terminals (cmd/powershell/wt). Expanded the
  // same way openFolder paths are, so "D:" / "D drive" / "Desktop" all resolve.
  let workDir = "";
  if (opts?.folder && String(opts.folder).trim()) {
    workDir = expandUserFacingPath(opts.folder);
    if (!fs.existsSync(workDir)) workDir = "";
  }

  const lower = name.toLowerCase();
  // File Explorer — always reuse unless new window requested
  if (
    /^(file explorer|explorer|windows explorer|explorer\.exe|this pc|my computer|computer)$/i.test(
      lower,
    )
  ) {
    // Preserve the exact target (e.g. "This PC") so openFolderViaNode can route
    // special shell locations correctly instead of an empty focus-only open.
    return openFolderViaNode({ name: lower, new_window: newWindow });
  }

  // Process images used only for "already running → focus" checks.
  const focusImages: Record<string, string> = {
    notepad: "notepad.exe",
    chrome: "chrome.exe",
    "google chrome": "chrome.exe",
    edge: "msedge.exe",
    "microsoft edge": "msedge.exe",
    firefox: "firefox.exe",
    calculator: "CalculatorApp.exe",
    calc: "CalculatorApp.exe",
    cmd: "cmd.exe",
    "command prompt": "cmd.exe",
    powershell: "powershell.exe",
    settings: "SystemSettings.exe",
    "windows settings": "SystemSettings.exe",
    "task manager": "Taskmgr.exe",
    taskmanager: "Taskmgr.exe",
    paint: "mspaint.exe",
    wordpad: "wordpad.exe",
    terminal: "WindowsTerminal.exe",
    "windows terminal": "WindowsTerminal.exe",
    discord: "Discord.exe",
    spotify: "Spotify.exe",
    steam: "steam.exe",
    code: "Code.exe",
    vscode: "Code.exe",
    "visual studio code": "Code.exe",
    "vs code": "Code.exe",
  };

  // Launch targets (may be protocols like ms-settings:).
  const aliases: Record<string, string> = {
    notepad: "notepad.exe",
    chrome: "chrome.exe",
    "google chrome": "chrome.exe",
    edge: "msedge.exe",
    "microsoft edge": "msedge.exe",
    firefox: "firefox.exe",
    calculator: "calc.exe",
    calc: "calc.exe",
    explorer: "explorer.exe",
    "file explorer": "explorer.exe",
    cmd: "cmd.exe",
    "command prompt": "cmd.exe",
    powershell: "powershell.exe",
    settings: "ms-settings:",
    "windows settings": "ms-settings:",
    "task manager": "taskmgr.exe",
    taskmanager: "taskmgr.exe",
    paint: "mspaint.exe",
    wordpad: "write.exe",
    terminal: "wt.exe",
    "windows terminal": "wt.exe",
    discord: "Discord.exe",
    spotify: "Spotify.exe",
    steam: "steam.exe",
    code: "code",
    vscode: "code",
    "visual studio code": "code",
    "vs code": "code",
  };

  // Focus existing instance first (all apps) unless user asked for a new window.
  if (!newWindow && process.platform === "win32") {
    const focusImage =
      focusImages[lower] ||
      (aliases[lower] && !aliases[lower].includes(":") ? aliases[lower] : "") ||
      (lower.endsWith(".exe") ? name : `${name}.exe`);
    if (focusImage && !focusImage.startsWith("ms-") && !focusImage.includes(":")) {
      const focused = await focusAppViaNode(focusImage);
      if (focused) {
        logCommand(`OPEN_APP "${name}" focused existing (${focusImage})`);
        return {
          ok: true,
          result: {
            result: `${name} was already open — brought it to the front.`,
            via: "node-focus",
            method: "focused",
            mode: "focused",
            requested: name,
            ok: true,
          },
        };
      }
    }
  }

  const runCmd = (cmd: string): Promise<void> =>
    new Promise((resolve, reject) => {
      exec(cmd, { windowsHide: true, timeout: 20000 }, (err) =>
        err ? reject(err) : resolve(),
      );
    });

  const runPsFile = (script: string): Promise<string> =>
    new Promise((resolve, reject) => {
      const scriptPath = path.join(
        os.tmpdir(),
        `bikli-open-app-${Date.now()}-${Math.random().toString(36).slice(2)}.ps1`,
      );
      try {
        fs.writeFileSync(scriptPath, script, "utf8");
      } catch (e) {
        reject(e);
        return;
      }
      exec(
        `powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${scriptPath}"`,
        { windowsHide: true, timeout: 35000 },
        (err, stdout, stderr) => {
          try {
            fs.unlinkSync(scriptPath);
          } catch {
            /* ignore */
          }
          if (err) reject(new Error(stderr || err.message || String(err)));
          else resolve(String(stdout || "").trim());
        },
      );
    });

  /** Human-style: Win+S → paste name → Enter (works for LM Viewer, etc.). */
  const openViaWindowsSearch = async (): Promise<{
    ok: boolean;
    result?: Record<string, unknown>;
    error?: string;
  }> => {
    if (process.platform !== "win32") {
      return { ok: false, error: "Windows Search open is Windows-only." };
    }
    const safe = name.replace(/'/g, "''");
    const ps = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
# Win+S
$wshell = New-Object -ComObject WScript.Shell
[void]$wshell.SendKeys('^{ESC}')
Start-Sleep -Milliseconds 200
# Prefer Win+S via keybd
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class BikliKeys {
  [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
  public const uint KEYUP = 0x0002;
  public static void WinS() {
    keybd_event(0x5B, 0, 0, UIntPtr.Zero);
    System.Threading.Thread.Sleep(40);
    keybd_event(0x53, 0, 0, UIntPtr.Zero);
    System.Threading.Thread.Sleep(40);
    keybd_event(0x53, 0, KEYUP, UIntPtr.Zero);
    System.Threading.Thread.Sleep(40);
    keybd_event(0x5B, 0, KEYUP, UIntPtr.Zero);
  }
  public static void Enter() {
    keybd_event(0x0D, 0, 0, UIntPtr.Zero);
    System.Threading.Thread.Sleep(30);
    keybd_event(0x0D, 0, KEYUP, UIntPtr.Zero);
  }
}
"@
[BikliKeys]::WinS()
Start-Sleep -Milliseconds 600
# Paste query via clipboard
Set-Clipboard -Value '${safe}'
Start-Sleep -Milliseconds 80
[System.Windows.Forms.SendKeys]::SendWait('^a')
Start-Sleep -Milliseconds 50
[System.Windows.Forms.SendKeys]::SendWait('^v')
Start-Sleep -Milliseconds 900
[BikliKeys]::Enter()
Write-Output 'SEARCH_OK'
`.trim();
    try {
      const out = await runPsFile(ps);
      logCommand(`OPEN_APP "${name}" via windows_search ${out}`);
      return {
        ok: true,
        result: {
          result: `Opened Windows Search for '${name}', typed the name, and pressed Enter. If it did not open, the app may not be installed.`,
          via: "windows_search",
          method: "windows_search",
          requested: name,
          ok: true,
        },
      };
    } catch (e: any) {
      return { ok: false, error: e?.message || String(e) };
    }
  };

  try {
    // Multi-word / unknown apps → Windows Search first (e.g. "lm viewer")
    const preferSearch =
      name.split(/\s+/).length >= 2 && !aliases[lower] && !lower.endsWith(".exe");
    if (preferSearch) {
      const viaSearch = await openViaWindowsSearch();
      if (viaSearch.ok) return viaSearch;
    }

    // 1) Known alias / direct executable
    const target = aliases[lower] || (lower.endsWith(".exe") ? name : "");
    if (target) {
      // Terminals: open directly in the requested folder (like the Explorer
      // address-bar "cmd" trick, but reliable). Skips the fragile keystroke chain.
      const isTerm =
        /^(cmd\.exe|powershell\.exe|wt\.exe)$/.test(target) ||
        /^(cmd|command prompt|powershell|terminal|windows terminal)$/.test(lower);
      if (isTerm && workDir) {
        const safeDir = workDir.replace(/"/g, "");
        // start "" /D "<dir>" cmd  →  opens cmd with that working directory
        if (target === "wt.exe") {
          await runCmd(`cmd /c start "" /D "${safeDir}" wt.exe -d "${safeDir}"`);
        } else if (target === "powershell.exe") {
          await runCmd(`cmd /c start "" /D "${safeDir}" powershell.exe -NoExit`);
        } else {
          await runCmd(`cmd /c start "" /D "${safeDir}" cmd.exe /K`);
        }
        logCommand(`OPEN_APP "${name}" in folder ${safeDir}`);
        return {
          ok: true,
          result: {
            result: `Opened ${name} in ${safeDir}.`,
            via: "node-alias",
            target,
            working_dir: safeDir,
            ok: true,
          },
        };
      }
      if (target.startsWith("ms-settings:")) {
        await runCmd(`cmd /c start "" "${target}"`);
      } else {
        await runCmd(`cmd /c start "" "${target.replace(/"/g, "")}"`);
      }
      logCommand(`OPEN_APP "${name}" via alias -> ${target}`);
      return {
        ok: true,
        result: { result: `Opened ${name}.`, via: "node-alias", target, ok: true },
      };
    }

    if (process.platform === "win32") {
      // 2) Start Menu shortcut search + UWP Get-StartApps
      const safe = name.replace(/'/g, "''");
      const ps = `
$ErrorActionPreference = 'Continue'
$needle = '${safe}'.ToLower()
$roots = @(
  (Join-Path $env:APPDATA 'Microsoft\\Windows\\Start Menu\\Programs'),
  (Join-Path $env:PROGRAMDATA 'Microsoft\\Windows\\Start Menu\\Programs')
)
$best = $null
$bestScore = -1
foreach ($root in $roots) {
  if (-not (Test-Path $root)) { continue }
  Get-ChildItem -Path $root -Filter *.lnk -Recurse -ErrorAction SilentlyContinue | ForEach-Object {
    $lab = $_.BaseName.ToLower()
    $score = -1
    if ($lab -eq $needle) { $score = 100 }
    elseif ($lab.StartsWith($needle) -or $needle.StartsWith($lab)) { $score = 80 }
    elseif ($lab.Contains($needle) -or $needle.Contains($lab)) { $score = 60 }
    if ($score -gt $bestScore) { $bestScore = $score; $best = $_.FullName }
  }
}
if ($best) {
  Start-Process -FilePath $best
  Write-Output ("LNK|" + $best)
  exit 0
}
try {
  $apps = Get-StartApps | Select-Object Name, AppID
  $hit = $apps | Where-Object { $_.Name.ToLower() -eq $needle } | Select-Object -First 1
  if (-not $hit) {
    $hit = $apps | Where-Object { $_.Name.ToLower().Contains($needle) -or $needle.Contains($_.Name.ToLower()) } | Select-Object -First 1
  }
  if ($hit) {
    Start-Process ("shell:AppsFolder\\" + $hit.AppID)
    Write-Output ("UWP|" + $hit.Name)
    exit 0
  }
} catch {}
Write-Output 'NONE'
`.trim();
      try {
        const out = await runPsFile(ps);
        if (out && !out.startsWith("NONE")) {
          logCommand(`OPEN_APP "${name}" (node) ${out}`);
          return {
            ok: true,
            result: {
              result: `Opened ${name}.`,
              via: "node-fallback",
              detail: out,
              ok: true,
            },
          };
        }
      } catch {
        /* try search */
      }

      // 3) Windows Search human-style open
      const viaSearch = await openViaWindowsSearch();
      if (viaSearch.ok) return viaSearch;

      // 4) Soft shell start
      try {
        await runCmd(`cmd /c start "" "${name.replace(/"/g, "")}"`);
        return {
          ok: true,
          result: {
            result: `Tried to open '${name}' via shell start.`,
            via: "shell_start",
            ok: true,
          },
        };
      } catch {
        /* soft ok */
      }
      return {
        ok: true,
        result: {
          result: `Tried Windows Search for '${name}'. If nothing opened, the app may not be installed.`,
          via: "windows_search_attempted",
          ok: true,
        },
      };
    }

    // non-Windows
    if (process.platform === "darwin") {
      await runCmd(`open -a "${name.replace(/"/g, '\\"')}"`);
    } else {
      await runCmd(name.replace(/"/g, '\\"'));
    }
    return { ok: true, result: { result: `Opened ${name}.`, via: "node-fallback", ok: true } };
  } catch (err: any) {
    // Soft success with Windows Search attempt
    logError(`OPEN_APP_FAILED ${name}: ${err?.message || err}`);
    const viaSearch = await openViaWindowsSearch();
    if (viaSearch.ok) return viaSearch;
    return {
      ok: true,
      result: {
        result: `Tried to open '${name}'. If nothing opened, the app may not be installed.`,
        ok: true,
        error_detail: err?.message || String(err),
      },
    };
  }
}

/**
 * Node fallback: focus YouTube/Chrome/Edge and scroll with mouse wheel.
 * Used when the Python agent is old/unreachable so "scroll youtube" still works.
 */
async function browserScrollViaNode(
  directionRaw: string,
  amountRaw?: unknown,
): Promise<{ ok: boolean; result?: Record<string, unknown>; error?: string }> {
  let direction = String(directionRaw || "down").toLowerCase().trim();
  if (["up", "north", "top", "back", "previous", "prev"].includes(direction)) {
    direction = "up";
  } else if (["left", "west"].includes(direction)) {
    direction = "left";
  } else if (["right", "east"].includes(direction)) {
    direction = "right";
  } else {
    direction = "down";
  }

  // Mouse-wheel notches only (default 3 = one short flick, not a full page)
  let amount = Number(amountRaw ?? 3);
  if (!Number.isFinite(amount)) amount = 3;
  if (amount >= 50) amount = Math.max(2, Math.min(8, Math.floor(amount / 120)));
  amount = Math.max(1, Math.min(8, Math.abs(Math.round(amount))));

  // WHEEL delta: +120 up / -120 down per notch (same as a real mouse wheel tick)
  let perNotch = -120;
  let horizontal = false;
  if (direction === "up") perNotch = 120;
  else if (direction === "down") perNotch = -120;
  else if (direction === "left") {
    horizontal = true;
    perNotch = -120;
  } else if (direction === "right") {
    horizontal = true;
    perNotch = 120;
  }
  const flag = horizontal ? "MOUSEEVENTF_HWHEEL" : "MOUSEEVENTF_WHEEL";
  // PowerShell uint32 for negative deltas
  const deltaU = perNotch < 0 ? perNotch >>> 0 : perNotch;

  const script = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class BikliScroll {
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, UIntPtr dwExtraInfo);
  public const uint MOUSEEVENTF_WHEEL = 0x0800;
  public const uint MOUSEEVENTF_HWHEEL = 0x01000;
  // SW_RESTORE un-maximizes the window — only use when minimized
  public const int SW_RESTORE = 9;
  public const int SW_SHOW = 5;
}
"@
$prefs = @('youtube','chrome','edge','brave','firefox','opera','msedge')
$target = [IntPtr]::Zero
$script:found = @()
[BikliScroll]::EnumWindows({
  param($h,$l)
  if ([BikliScroll]::IsWindowVisible($h)) {
    $sb = New-Object System.Text.StringBuilder 512
    [void][BikliScroll]::GetWindowText($h, $sb, $sb.Capacity)
    $t = $sb.ToString()
    if ($t) { $script:found += ,@($h, $t) }
  }
  return $true
}, [IntPtr]::Zero) | Out-Null
foreach ($p in $prefs) {
  foreach ($pair in $script:found) {
    if ($pair[1].ToLower().Contains($p)) { $target = $pair[0]; break }
  }
  if ($target -ne [IntPtr]::Zero) { break }
}
Add-Type -AssemblyName System.Windows.Forms
if ($target -ne [IntPtr]::Zero) {
  # CRITICAL: never SW_RESTORE/SW_SHOW on maximized/fullscreen browser —
  # that shrinks Chrome/YouTube (user-reported scroll bug). Only restore if minimized.
  if ([BikliScroll]::IsIconic($target)) {
    [BikliScroll]::ShowWindow($target, [BikliScroll]::SW_RESTORE) | Out-Null
    Start-Sleep -Milliseconds 60
  }
  # Alt-key trick if SetForegroundWindow is blocked by Windows focus rules
  try {
    [BikliScroll]::SetForegroundWindow($target) | Out-Null
  } catch {}
  Start-Sleep -Milliseconds 80
}
# Move cursor over browser content (not the Bikli window)
$screen = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$cx = [int]($screen.Width * 0.55)
$cy = [int]($screen.Height * 0.55)
[System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point($cx, $cy)
Start-Sleep -Milliseconds 40
$flag = [BikliScroll]::${flag}
# Real mouse-wheel style: one notch at a time (no PageDown full-page jump)
1..${amount} | ForEach-Object {
  [BikliScroll]::mouse_event($flag, 0, 0, [uint32]${deltaU}, [UIntPtr]::Zero)
  if ($_ -lt ${amount}) { Start-Sleep -Milliseconds 35 }
}
Write-Output "OK"
`;

  const scriptPath = path.join(os.tmpdir(), `bikli-browser-scroll-${Date.now()}.ps1`);
  try {
    fs.writeFileSync(scriptPath, script, "utf8");
    await new Promise<void>((resolve, reject) => {
      exec(
        `powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${scriptPath}"`,
        { windowsHide: true, timeout: 12000 },
        (err, stdout) => {
          try {
            fs.unlinkSync(scriptPath);
          } catch {
            /* ignore */
          }
          if (err) reject(err);
          else resolve();
        },
      );
    });
    logCommand(`BROWSER_SCROLL ${direction} amount=${amount} (node fallback, wheel)`);
    return {
      ok: true,
      result: {
        result: `Scrolled ${direction} a little (mouse wheel ×${amount}) on browser/YouTube.`,
        direction,
        amount,
        style: "mouse-wheel",
        via: "node-fallback",
      },
    };
  } catch (err: any) {
    const msg = err?.message || String(err);
    logError(`BROWSER_SCROLL_NODE_FAILED: ${msg}`);
    return { ok: false, error: `Could not scroll browser: ${msg}` };
  }
}

/**
 * Resolve media action aliases and apply play/pause state machine.
 * PLAY_PAUSE is a toggle — never send it when already in the desired state.
 */
function resolveMediaAction(actionRaw: string): string {
  const aliases: Record<string, string> = {
    resume: "play",
    unpause: "play",
    continue: "play",
    start: "play",
    stop: "pause",
    halt: "pause",
  };
  const raw = String(actionRaw || "").toLowerCase().trim();
  return aliases[raw] || raw;
}

/**
 * If we already believe media is playing/paused, skip the toggle key so the
 * agent cannot reverse a manual user pause (or double-pause into play).
 */
function mediaActionGuard(
  action: string,
): { skip: boolean; reason?: string; nextState?: "playing" | "paused" } {
  if (action === "play" || action === "resume") {
    if (mediaPlaybackState === "playing") {
      return {
        skip: true,
        reason:
          "Video is already marked playing — not sending play key (prevents auto-resume after user pause).",
      };
    }
    return { skip: false, nextState: "playing" };
  }
  if (action === "pause" || action === "stop") {
    if (mediaPlaybackState === "paused") {
      return {
        skip: true,
        reason:
          "Video is already marked paused — not sending pause key (toggle would resume).",
      };
    }
    return { skip: false, nextState: "paused" };
  }
  return { skip: false };
}

/**
 * Node-side fallback for browserMediaControl when the Python agent is old
 * or unreachable. Writes a tiny PowerShell script that presses a Windows
 * media key via user32.keybd_event (same as a keyboard media button).
 */
async function mediaControlViaNode(
  actionRaw: string,
  value?: unknown,
): Promise<{ ok: boolean; result?: Record<string, unknown>; error?: string }> {
  const action = resolveMediaAction(actionRaw);
  if (!action) {
    return {
      ok: false,
      error: "Media action is required (play, pause, resume, mute, skip…).",
    };
  }

  const guard = mediaActionGuard(action);
  if (guard.skip) {
    logCommand(`MEDIA_CONTROL ${action} skipped (state=${mediaPlaybackState})`);
    return {
      ok: true,
      result: {
        result: guard.reason,
        action,
        skipped: true,
        state: mediaPlaybackState,
      },
    };
  }

  // Virtual-key codes for Windows media keys
  // pause uses STOP (non-toggle) when possible so we don't resume a paused video.
  const VK: Record<string, number> = {
    play: 0xb3, // VK_MEDIA_PLAY_PAUSE
    pause: 0xb2, // VK_MEDIA_STOP — safer than toggle for "pause"
    next: 0xb0,
    previous: 0xb1,
    stop: 0xb2,
    mute: 0xad,
    unmute: 0xad,
    skip: 0xb0,
  };

  const pressVk = (vk: number): Promise<void> =>
    new Promise((resolve, reject) => {
      const scriptPath = path.join(os.tmpdir(), `bikli-media-key-${Date.now()}.ps1`);
      const script = [
        "Add-Type -TypeDefinition @\"",
        "using System;",
        "using System.Runtime.InteropServices;",
        "public class BikliMediaKey {",
        "  [DllImport(\"user32.dll\")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);",
        "  public static void Press(byte vk) { keybd_event(vk, 0, 0, UIntPtr.Zero); System.Threading.Thread.Sleep(30); keybd_event(vk, 0, 2, UIntPtr.Zero); }",
        "}",
        "\"@",
        `[BikliMediaKey]::Press(${vk})`,
      ].join("\r\n");
      try {
        fs.writeFileSync(scriptPath, script, "utf8");
      } catch (e: any) {
        reject(e);
        return;
      }
      exec(
        `powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${scriptPath}"`,
        { windowsHide: true, timeout: 10000 },
        (err) => {
          try {
            fs.unlinkSync(scriptPath);
          } catch {
            /* ignore cleanup errors */
          }
          if (err) reject(err);
          else resolve();
        },
      );
    });

  try {
    if (action === "volume") {
      const pct = Math.max(0, Math.min(100, Number(value) || 50));
      const volResult = await callDesktopAgentRaw("setVolume", { percent: pct });
      if (volResult.ok) {
        return {
          ok: true,
          result: { result: `Volume set to ${pct}%.`, action },
        };
      }
      return { ok: false, error: volResult.error || "Could not set volume." };
    }

    if (action === "fullscreen" || action === "exit_fullscreen") {
      return {
        ok: false,
        error:
          "Fullscreen needs the desktop agent with window focus. Restart BIKLI so the agent reloads.",
      };
    }

    const vk = VK[action];
    if (!vk) {
      return {
        ok: false,
        error: `Unknown media action '${actionRaw}'. Use play, pause, resume, mute, unmute, skip.`,
      };
    }
    if (action === "mute" || action === "unmute") {
      // VK_VOLUME_MUTE only TOGGLES — press it only when the tracked state
      // actually needs to change, so "mute" cannot unmute an already-muted
      // device (and vice versa).
      const needToggle = (action === "mute" && !mediaMuted) || (action === "unmute" && mediaMuted);
      if (needToggle) {
        await pressVk(vk);
        mediaMuted = action === "mute";
      } else {
        logCommand(`MEDIA_CONTROL ${action} already satisfied (${mediaMuted ? "muted" : "unmuted"})`);
      }
    } else {
      await pressVk(vk);
    }
    if (guard.nextState) {
      mediaPlaybackState = guard.nextState;
      lastMediaActionAt = Date.now();
    }
    const label =
      action === "play"
        ? "resumed / playing"
        : action === "pause"
          ? "paused"
          : action === "mute" || action === "unmute"
            ? "mute toggled"
            : action === "skip"
              ? "skipped forward"
              : action;
    logCommand(`MEDIA_CONTROL ${action} (node fallback) state=${mediaPlaybackState}`);
    return {
      ok: true,
      result: {
        result: `Video ${label} (system media key).`,
        action,
        via: "node-fallback",
      },
    };
  } catch (err: any) {
    const msg = err?.message || String(err);
    logError(`MEDIA_CONTROL_NODE_FAILED: ${msg}`);
    return { ok: false, error: `Could not control media: ${msg}` };
  }
}

/**
 * Capture the full virtual screen via PowerShell (no Python required).
 * Saves under Pictures/BikliScreenshots and returns path + size.
 */
async function screenshotViaNode(
  tool: string,
  args: Record<string, unknown> = {},
): Promise<{ ok: boolean; result?: Record<string, unknown>; error?: string }> {
  if (process.platform !== "win32") {
    return { ok: false, error: "Screenshot Node fallback is Windows-only." };
  }
  const pictures =
    process.env.USERPROFILE
      ? path.join(process.env.USERPROFILE, "Pictures", "BikliScreenshots")
      : path.join(os.tmpdir(), "BikliScreenshots");
  try {
    fs.mkdirSync(pictures, { recursive: true });
  } catch {
    /* ignore */
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const prefix =
    String(args.name || tool || "screenshot")
      .replace(/[^\w\-]+/g, "_")
      .slice(0, 40) || "screenshot";
  const outPath = path.join(pictures, `${prefix}-${stamp}.png`);
  const scriptPath = path.join(
    os.tmpdir(),
    `bikli-shot-${Date.now()}-${Math.random().toString(36).slice(2)}.ps1`,
  );
  const safeOut = outPath.replace(/'/g, "''");
  const script = [
    "Add-Type -AssemblyName System.Windows.Forms",
    "Add-Type -AssemblyName System.Drawing",
    "$bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen",
    "$bmp = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height",
    "$g = [System.Drawing.Graphics]::FromImage($bmp)",
    "$g.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)",
    `$bmp.Save('${safeOut}')`,
    "Write-Output ($bounds.Width.ToString() + 'x' + $bounds.Height.ToString())",
    "$g.Dispose()",
    "$bmp.Dispose()",
  ].join("\r\n");

  try {
    fs.writeFileSync(scriptPath, script, "utf8");
    const sizeLabel = await new Promise<string>((resolve, reject) => {
      exec(
        `powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${scriptPath}"`,
        { windowsHide: true, timeout: 25000 },
        (err, stdout, stderr) => {
          try {
            fs.unlinkSync(scriptPath);
          } catch {
            /* ignore */
          }
          if (err) {
            reject(new Error(stderr || err.message || String(err)));
            return;
          }
          resolve(String(stdout || "").trim() || "unknown");
        },
      );
    });

    if (!fs.existsSync(outPath)) {
      return { ok: false, error: "Screenshot file was not created." };
    }
    const parts = sizeLabel.split("x");
    const width = Number(parts[0]) || 0;
    const height = Number(parts[1]) || 0;
    const base = {
      ok: true,
      path: outPath,
      width,
      height,
      via: "node-fallback",
    };
    if (tool === "analyzeScreenshot" || tool === "readScreen") {
      return {
        ok: true,
        result: {
          ...base,
          result: `Screenshot saved to ${outPath} (${sizeLabel}). OCR not available in Node fallback — open the file to view the screen.`,
          text: "",
          active_window: tool === "readScreen" ? "(node fallback — full screen)" : undefined,
        },
      };
    }
    return {
      ok: true,
      result: {
        ...base,
        result: `Screenshot captured (${sizeLabel}) and saved to ${outPath}.`,
      },
    };
  } catch (err: any) {
    try {
      fs.unlinkSync(scriptPath);
    } catch {
      /* ignore */
    }
    logError(`SCREENSHOT_NODE_FAILED: ${err?.message || err}`);
    return {
      ok: false,
      error: `Screenshot failed: ${err?.message || err}`,
    };
  }
}

/** Normalize spoken captions for control-word matching. */
function normalizeControlTranscript(raw: string): string {
  return String(raw || "")
    .toLowerCase()
    .replace(/[^\w\s']/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * True when the utterance is clearly a desktop/click/screen task — never treat
 * these as mic-off or control lock/unlock (prevents auto-off during real work).
 */
function isDesktopTaskUtterance(t: string): boolean {
  return /\b(click|double[\s-]?click|right[\s-]?click|mouse|cursor|screenshot|screen|what (do |can )?you see|what('?s| is) on (my |the )?screen|read (the |my )?screen|type|scroll|move (the )?mouse|drag|open (app|application|notepad|chrome|folder)|close (app|window)|volume|brightness)\b/i.test(
    t,
  );
}

/**
 * Detect spoken control / release phrases from live captions.
 * Returns "enable" | "disable" | null.
 * Kept STRICT so click / "what do you see" never flip control or kill the session.
 */
function detectControlPhrase(raw: string): "enable" | "disable" | null {
  const t = normalizeControlTranscript(raw);
  if (!t) return null;

  // Never flip control while the user is asking for click/screen/desktop work.
  const pureRelease = /\b(stop|release|end|disable|cancel|lock)\s+control\b/.test(t) || /\bstop\s+controlling\b/.test(t);
  const pureEnable =
    /^(control|take control|computer control|full control|you have control|start control|enable control|bikli control|ok control|okay control)$/.test(t) ||
    (t.split(/\s+/).length <= 3 && /\bcontrol\b$/.test(t));
  if (isDesktopTaskUtterance(t) && !pureRelease && !pureEnable) {
    return null;
  }

  // Release first — exact / short only (no loose includes on long sentences).
  const releaseExact = [
    "stop control",
    "release control",
    "end control",
    "disable control",
    "cancel control",
    "lock control",
    "give me control",
    "stop controlling",
  ];
  if (releaseExact.includes(t)) return "disable";
  if (t.split(/\s+/).length <= 6 && pureRelease) return "disable";

  // Exact short grant phrases
  const exactEnable = [
    "control",
    "take control",
    "computer control",
    "full control",
    "you have control",
    "start control",
    "enable control",
    "bikli control",
    "ok control",
    "okay control",
  ];
  if (exactEnable.includes(t)) return "enable";
  if (t.split(/\s+/).length <= 6) {
    if (/\b(take|start|enable|full|computer)\s+control\b/.test(t)) return "enable";
    if (/\byou\s+have\s+control\b/.test(t)) return "enable";
    if (/\bbikli\s+control\b/.test(t)) return "enable";
  }
  // Bare "control" only on very short utterances
  if (t.split(/\s+/).length <= 3 && /\bcontrol\b$/.test(t) && !isDesktopTaskUtterance(t)) return "enable";
  return null;
}

let lastControlAutoToggleAt = 0;
let lastAutoYouTubeOpenAt = 0;
let lastAutoOpenSiteAt = 0;

/** Sites the spoken-open fallback recognises (keys match openWebsite's siteMap). */
const AUTO_OPEN_SITE_PATTERN =
  "you\\s?tube|gmail|chat\\s?gpt|google|github|wikipedia|reddit|twitter|instagram|facebook|linkedin|netflix|spotify";
const OPEN_THEN_SITE_RE = new RegExp(
  `\\b(?:open|launch|start)\\s+(?:the\\s+|my\\s+|up\\s+)?(${AUTO_OPEN_SITE_PATTERN})\\b`,
);
// Hindi/Hinglish word order: "youtube kholo"
const SITE_THEN_OPEN_RE = new RegExp(
  `\\b(${AUTO_OPEN_SITE_PATTERN})\\s+(?:ko\\s+)?(?:kholo|khol|open)\\b`,
);

/**
 * Detect an explicit spoken "open <site>" command. Requires the verb and the
 * site to be adjacent so unrelated chatter that merely mentions YouTube does
 * not trigger an open.
 */
function detectSpokenOpenSite(text: string): string {
  const t = normalizeControlTranscript(text);
  if (!t) return "";
  // "in the YouTube app" belongs to openApplication, not the website.
  if (detectOpenInAppIntent(t)) return "";
  // play/search/close have their own dedicated tools.
  if (/\b(play|search|find|watch|close|band)\b/.test(t)) return "";
  const m = OPEN_THEN_SITE_RE.exec(t) || SITE_THEN_OPEN_RE.exec(t);
  if (!m) return "";
  return m[1].replace(/\s+/g, "");
}

/**
 * Fast path: the user clearly said "open <site>" but the model only spoke and
 * never called openWebsite — the prompt used to tell it to "just confirm
 * verbally", so it would happily say "YouTube opened" having done nothing.
 * Open it here so the spoken command is always honoured.
 *
 * claimOpenAction dedupes against the model's own openWebsite call, so whichever
 * arrives first does the work and the other is skipped — never two tabs.
 */
async function maybeAutoOpenWebsite(
  transcript: string,
  clientWs: { send: (data: string) => void; readyState?: number },
): Promise<void> {
  const site = detectSpokenOpenSite(transcript);
  if (!site) return;
  const now = Date.now();
  if (now - lastAutoOpenSiteAt < 8000) return;
  lastAutoOpenSiteAt = now;
  try {
    const result = await callDesktopAgent("openWebsite", { name: site }, transcript);
    logCommand(`AUTO_OPEN_SITE ${site} ok=${result.ok}`);
    try {
      if (clientWs.readyState === 1 || clientWs.readyState === undefined) {
        clientWs.send(
          JSON.stringify({
            type: "tool_result",
            tool: "openWebsite",
            ok: result.ok,
            result: result.result,
            error: result.error,
            auto: true,
          }),
        );
      }
    } catch {
      /* ignore UI notify */
    }
  } catch (err: any) {
    logError(`AUTO_OPEN_SITE_FAILED ${site}: ${err?.message || err}`);
  }
}

/**
 * Fast path: user says "open first/second video" (often while Share Screen is on
 * YouTube results) but the model only describes the screen and never calls a tool.
 * Open the Nth result ourselves.
 */
async function maybeAutoOpenNthYouTubeVideo(
  transcript: string,
  clientWs: { send: (data: string) => void; readyState?: number },
): Promise<void> {
  if (!isOpenNthVideoIntent(transcript)) return;
  const now = Date.now();
  if (now - lastAutoYouTubeOpenAt < 4000) return;
  lastAutoYouTubeOpenAt = now;
  const index = parseVideoIndexFromText(transcript) || 1;
  // Claim with a stable on-screen key so we click the visible Nth video (not a re-scrape).
  if (!claimOpenAction("playYouTube", { query: `onscreen-auto|${index}`, index }, transcript)) {
    console.log(`[YouTube Auto] Skipped #${index} — already claimed by another open`);
    return;
  }
  console.log(`[YouTube Auto] Spoken open #${index} video ON-SCREEN: "${transcript}"`);
  try {
    // preferOnScreen: click the card the user sees (Share Screen / manual open).
    const result = await playYouTubeVideo("", index, { preferOnScreen: true });
    logCommand(`YOUTUBE_AUTO_OPEN #${index} on_screen ok=${result.ok}`);
    try {
      if (clientWs.readyState === 1 || clientWs.readyState === undefined) {
        clientWs.send(
          JSON.stringify({
            type: "tool_result",
            tool: "playYouTube",
            ok: result.ok,
            result: result.result,
            error: result.error,
            auto: true,
          }),
        );
      }
    } catch {
      /* ignore UI notify */
    }
  } catch (err: any) {
    logError(`YOUTUBE_AUTO_OPEN_FAILED: ${err?.message || err}`);
  }
}

/**
 * Auto enable/disable computer control from spoken captions.
 * Notifies the UI over the live WebSocket.
 */
async function maybeAutoToggleComputerControl(
  transcript: string,
  clientWs: { send: (data: string) => void; readyState?: number },
): Promise<void> {
  const action = detectControlPhrase(transcript);
  if (!action) return;
  const now = Date.now();
  if (now - lastControlAutoToggleAt < 2500) return; // debounce
  lastControlAutoToggleAt = now;

  const reason =
    action === "enable"
      ? `user said control word: ${normalizeControlTranscript(transcript)}`
      : `user released control: ${normalizeControlTranscript(transcript)}`;

  try {
    // Node is authoritative — works even if the frozen Python agent is old.
    const payload =
      action === "enable"
        ? setNodeComputerControl(true, reason)
        : setNodeComputerControl(false, reason);
    // Best-effort sync to Python agent (ignore unknown-tool errors).
    void callDesktopAgentRaw(
      action === "enable" ? "enableComputerControl" : "disableComputerControl",
      { reason, phrase: transcript },
    ).catch(() => {});
    logCommand(`CONTROL_WORD_${action.toUpperCase()} "${transcript}" ok=true`);
    try {
      clientWs.send(
        JSON.stringify({
          type: "computer_control",
          enabled: action === "enable",
          action,
          ok: true,
          result: payload,
          reason,
        }),
      );
    } catch {
      /* ws may be closed */
    }
  } catch (err: any) {
    logError(`CONTROL_WORD_ERROR: ${err?.message || err}`);
  }
}

/**
 * Low-level agent execute (no path expansion / YouTube intercept) — used by
 * openSystemBrowserUrl to avoid recursion with playYouTube.
 */
async function callDesktopAgentRaw(
  tool: string,
  args: Record<string, unknown>,
): Promise<{ ok: boolean; result?: unknown; error?: string; timedOut?: boolean }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DESKTOP_AGENT_TIMEOUT);
  try {
    const res = await fetch(`${DESKTOP_AGENT_URL}/execute`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tool, args }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { ok: false, error: `Desktop agent HTTP ${res.status}: ${text}` };
    }
    desktopAgentVerified = true;
    return await res.json();
  } catch (err: any) {
    desktopAgentVerified = false;
    // timedOut: the agent is ALIVE but slow — aborting our fetch does NOT cancel
    // the Python handler, so a Node fallback would re-run the same action
    // (double click / double type). Callers should NOT fall back on this.
    const timedOut = err?.name === "AbortError";
    return { ok: false, error: String(err?.message || err), timedOut };
  } finally {
    // Previously cleared only on the success path, so every failed/aborted tool
    // call left a live abort timer behind.
    clearTimeout(timer);
  }
}

/** Real local date/time from this PC's clock (no agent required). */
function getDateTimeViaNode(): { ok: true; result: Record<string, unknown> } {
  const now = new Date();
  const weekday = now.toLocaleDateString(undefined, { weekday: "long" });
  const dateOnly = now.toLocaleDateString(undefined, {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
  const timeOnly = now.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
  const timezone =
    Intl.DateTimeFormat().resolvedOptions().timeZone ||
    now.toLocaleTimeString(undefined, { timeZoneName: "short" }).split(" ").pop() ||
    "";
  const spoken = `${dateOnly} at ${timeOnly}`;
  return {
    ok: true,
    result: {
      result: `The computer's local time is ${spoken}${timezone ? ` (${timezone})` : ""}.`,
      datetime: now.toISOString(),
      date: dateOnly,
      time: timeOnly,
      timezone,
      weekday,
      hour_24: now.getHours(),
      minute: now.getMinutes(),
    },
  };
}

/** Real battery % from this PC via WMI (works without Python agent). */
async function batteryInfoViaNode(): Promise<{ ok: boolean; result?: unknown; error?: string }> {
  const script = [
    "$b = Get-CimInstance Win32_Battery -ErrorAction SilentlyContinue | Select-Object -First 1",
    "if (-not $b) { Write-Output 'NONE'; exit 0 }",
    "Write-Output (\"{0}|{1}|{2}\" -f $b.EstimatedChargeRemaining, $b.BatteryStatus, $b.EstimatedRunTime)",
  ].join("; ");
  const scriptPath = path.join(os.tmpdir(), `bikli-battery-${Date.now()}.ps1`);
  try {
    fs.writeFileSync(scriptPath, script, "utf8");
  } catch (e: any) {
    return { ok: false, error: `Could not write battery script: ${e?.message || e}` };
  }
  return new Promise((resolve) => {
    exec(
      `powershell -NoProfile -ExecutionPolicy Bypass -File "${scriptPath}"`,
      { windowsHide: true, timeout: 8000 },
      (err, stdout) => {
        try {
          fs.unlinkSync(scriptPath);
        } catch {
          /* ignore */
        }
        const raw = String(stdout || "").trim();
        if (err || !raw || raw === "NONE" || !raw.includes("|")) {
          resolve({
            ok: true,
            result: {
              result:
                "No battery detected on this computer. This looks like a desktop PC (or a laptop with no battery reported), so there is no battery percentage to read.",
              percent: null,
              plugged_in: null,
              has_battery: false,
            },
          });
          return;
        }
        const parts = raw.split("|");
        const percent = Math.max(0, Math.min(100, parseInt(parts[0], 10) || 0));
        const statusCode = parseInt(parts[1], 10) || 0;
        // Win32: 1=Discharging, 2=AC, 3=Fully Charged, 6+=Charging variants
        const pluggedIn = [2, 3, 6, 7, 8, 9].includes(statusCode);
        let power: string;
        if (pluggedIn && percent >= 100) power = "plugged in and fully charged";
        else if (pluggedIn) power = "plugged in and charging";
        else power = "on battery (not plugged in)";
        let timePart = "";
        const minsRaw = parseInt(parts[2], 10);
        if (Number.isFinite(minsRaw) && minsRaw > 0 && minsRaw < 100000) {
          const hours = Math.floor(minsRaw / 60);
          const mins = minsRaw % 60;
          timePart =
            hours > 0
              ? ` About ${hours}h ${mins}m remaining.`
              : ` About ${mins} minutes remaining.`;
        }
        resolve({
          ok: true,
          result: {
            result: `Battery is at ${percent}% — ${power}.${timePart}`,
            percent,
            plugged_in: pluggedIn,
            charging: pluggedIn && percent < 100,
            has_battery: true,
          },
        });
      },
    );
  });
}

async function callDesktopAgent(
  tool: string,
  args: Record<string, unknown>,
  recentUserText: string = "",
): Promise<{ ok: boolean; result?: unknown; error?: string }> {
  // Always expand friendly paths so createFile("Desktop/x.txt") hits the real Desktop.
  args = expandDesktopToolArgs(tool, args);

  // Map generic browserType to desktopBrowserType (real browser, not in-app iframe).
  if (tool === "browserType") {
    tool = "desktopBrowserType";
  }

  // playYouTube claim key: do NOT inject lastYouTubeQuery into args.
  // Injecting stale "motupatlu" made playYouTubeVideo treat it as a named song
  // and re-scrape the wrong video instead of clicking what is on screen.
  if (tool === "playYouTube") {
    const requested = String(args.query || args.q || "").trim();
    const index = Number(args.index ?? args.n ?? args.position ?? 1) || 1;
    const title = String(args.title || args.videoTitle || "").trim();
    // Open-nth / empty query → claim as on-screen so debounce does not reuse old song key
    if (!requested || requested.toLowerCase() === String(lastYouTubeQuery || "").toLowerCase()) {
      args = {
        ...args,
        // Keep original empty-ish query for playYouTubeVideo (on-screen path)
        query: requested,
        q: requested,
        // Distinct claim identity per index so "play first" after new page still works
        _claimQuery: title || `onscreen|${index}`,
      };
    }
  }

  // ── Duplicate open guard (sync claim — stops parallel "open X" spam) ──
  if (OPEN_LIKE_TOOLS.has(tool)) {
    const claimArgs =
      tool === "playYouTube" && (args as any)._claimQuery
        ? { ...args, query: String((args as any)._claimQuery), q: String((args as any)._claimQuery) }
        : args;
    if (!claimOpenAction(tool, claimArgs, recentUserText)) {
      logCommand(`OPEN_DEBOUNCE skip ${tool} ${JSON.stringify(args).slice(0, 120)}`);
      return openDebounceSkipResult(tool);
    }
  }

  // ── Control-word gate (Node is authoritative; works even with old frozen agent) ──
  if (tool === "enableComputerControl") {
    const reason = String(args.reason || args.phrase || "user said control word");
    const payload = setNodeComputerControl(true, reason);
    // Best-effort sync to Python agent if it supports the tool
    void callDesktopAgentRaw("enableComputerControl", { reason }).catch(() => {});
    return { ok: true, result: payload };
  }
  if (tool === "disableComputerControl") {
    const reason = String(args.reason || "user released control");
    const payload = setNodeComputerControl(false, reason);
    void callDesktopAgentRaw("disableComputerControl", { reason }).catch(() => {});
    return { ok: true, result: payload };
  }
  if (tool === "getComputerControlStatus") {
    return {
      ok: true,
      result: {
        result: nodeComputerControlEnabled
          ? "Full computer control is ACTIVE — cursor and desktop tools are unlocked."
          : "Full computer control is LOCKED — say 'control' to unlock.",
        enabled: nodeComputerControlEnabled,
        reason: nodeComputerControlReason,
        since: nodeComputerControlSince,
      },
    };
  }

  // Screenshots: try Python agent, then Node PowerShell capture (always works on Windows).
  if (
    tool === "takeScreenshot" ||
    tool === "saveScreenshot" ||
    tool === "analyzeScreenshot" ||
    tool === "readScreen"
  ) {
    try {
      /* callDesktopAgentRaw handles agent health directly */
      const agentResult = await callDesktopAgentRaw(tool, {
        ...args,
        include_image: false,
      });
      if (agentResult.ok) {
        logCommand(`SCREENSHOT ${tool} (desktop agent)`);
        // Strip any base64 if agent still returned it
        if (agentResult.result && typeof agentResult.result === "object") {
          const r = { ...(agentResult.result as Record<string, unknown>) };
          for (const k of Object.keys(r)) {
            if (/image|base64/i.test(k)) delete r[k];
          }
          return { ok: true, result: r };
        }
        return agentResult as { ok: boolean; result?: unknown; error?: string };
      }
      logError(`SCREENSHOT_AGENT_FAIL ${tool}: ${agentResult.error}`);
    } catch (e: any) {
      logError(`SCREENSHOT_AGENT_ERR ${tool}: ${e?.message || e}`);
    }
    logCommand(`SCREENSHOT ${tool} (node fallback)`);
    return screenshotViaNode(tool, args);
  }

  // Date/time + battery: answer from this PC immediately (no control word, no Settings).
  // Prefer Python agent when it knows the tool; always fall back to Node.
  if (tool === "getDateTime") {
    try {
      /* callDesktopAgentRaw handles agent health directly */
      const agentResult = await callDesktopAgentRaw("getDateTime", args);
      if (agentResult.ok) {
        logCommand("getDateTime (desktop agent)");
        return agentResult as { ok: boolean; result?: unknown; error?: string };
      }
    } catch {
      /* Node clock */
    }
    logCommand("getDateTime (node)");
    return getDateTimeViaNode();
  }
  if (tool === "batteryInfo") {
    try {
      /* callDesktopAgentRaw handles agent health directly */
      const agentResult = await callDesktopAgentRaw("batteryInfo", args);
      if (agentResult.ok) {
        logCommand("batteryInfo (desktop agent)");
        return agentResult as { ok: boolean; result?: unknown; error?: string };
      }
    } catch {
      /* Node WMI */
    }
    logCommand("batteryInfo (node)");
    return batteryInfoViaNode();
  }

  // Privileged desktop tools require the control word first.
  if (!CONTROL_ALWAYS_ALLOWED.has(tool) && !nodeComputerControlEnabled) {
    return controlLockedError(tool);
  }

  // ── Stories / notes / plain files: silent disk write (no typeText, no control) ──
  // Prefer Node FIRST — fast background write, no 12s agent timeout, no keystrokes.
  // Python agent is only a backup (and often missing writeToNotepad when frozen old).
  if (tool === "createFile" || tool === "writeToNotepad") {
    const nodeResult = writeTextFileViaNode(tool, args);
    if (nodeResult.ok) {
      logCommand(`${tool} (node fast-path)`);
      return nodeResult;
    }
    // Node failed (path/permissions) — try Python agent once
    try {
      /* callDesktopAgentRaw handles agent health directly */
      const agentResult = await callDesktopAgentRaw(tool, args);
      if (agentResult.ok) {
        logCommand(`${tool} (desktop agent backup)`);
        return agentResult as { ok: boolean; result?: unknown; error?: string };
      }
      return {
        ok: false,
        error: nodeResult.error || agentResult.error || `Could not write file via ${tool}.`,
      };
    } catch (e: any) {
      return {
        ok: false,
        error: nodeResult.error || String(e?.message || e),
      };
    }
  }

  // ── Open local images/screenshots DIRECTLY (Photos app) — no Explorer search ──
  // Prefer Node FIRST so "open first screenshot" never waits on a slow/old agent.
  if (tool === "openLocalImage" || tool === "openFile") {
    const nodeResult = openLocalImageViaNode(tool, args);
    if (nodeResult.ok) {
      logCommand(`${tool} (node fast-path)`);
      return nodeResult;
    }
    try {
      /* callDesktopAgentRaw handles agent health directly */
      const agentResult = await callDesktopAgentRaw(tool, args);
      if (agentResult.ok) {
        logCommand(`${tool} (desktop agent backup)`);
        return agentResult as { ok: boolean; result?: unknown; error?: string };
      }
      return {
        ok: false,
        error: nodeResult.error || agentResult.error || `Could not open local file via ${tool}.`,
      };
    } catch (e: any) {
      return {
        ok: false,
        error: nodeResult.error || String(e?.message || e),
      };
    }
  }

  // Cursor/keyboard: try Python agent first, then Node PowerShell fallback.
  if (CURSOR_TOOLS.has(tool)) {
    try {
      /* callDesktopAgentRaw handles agent health directly */
      const agentResult = await callDesktopAgentRaw(tool, args);
      if (agentResult.ok) {
        logCommand(`CURSOR ${tool} (desktop agent)`);
        return agentResult as { ok: boolean; result?: unknown; error?: string };
      }
      // Unknown tool on old agent → Node fallback
      if (/unknown tool|not found|not registered|not implemented|LOCKED/i.test(String(agentResult.error || ""))) {
        // if locked from Python but Node says enabled, still use Node
        if (/LOCKED/i.test(String(agentResult.error || "")) && nodeComputerControlEnabled) {
          return cursorControlViaNode(tool, args);
        }
        if (/unknown tool|not found|not registered|not implemented/i.test(String(agentResult.error || ""))) {
          return cursorControlViaNode(tool, args);
        }
      }
      // Timed out while the agent was (probably) still executing — the action
      // may already be running server-side, so re-running it via Node would
      // double-click / double-type. Surface the timeout instead.
      if (agentResult.timedOut) {
        return {
          ok: false,
          error:
            "The desktop agent did not respond in time. The action may already be running — try again in a moment.",
        };
      }
      // Agent error that is not "unknown" — still try Node for reliability
      const fb = await cursorControlViaNode(tool, args);
      if (fb.ok) return fb;
      return agentResult as { ok: boolean; result?: unknown; error?: string };
    } catch {
      return cursorControlViaNode(tool, args);
    }
  }

  // ── Office documents: real .docx / .xlsx / .pptx ──
  // Prefer Python agent (python-docx / openpyxl / python-pptx). Always fall
  // back to pure Node OOXML so packaged / old agents still work.
  if (OFFICE_TOOLS.has(tool)) {
    try {
      /* callDesktopAgentRaw handles agent health directly */
      const agentResult = await callDesktopAgentRaw(tool, args);
      if (agentResult.ok) {
        logCommand(`OFFICE ${tool} (desktop agent)`);
        return agentResult as { ok: boolean; result?: unknown; error?: string };
      }
      const errText = String(agentResult.error || "");
      // Unknown tool / missing lib / timeout → Node creates the real file.
      if (
        /unknown tool|not found|not registered|not implemented|not installed|Cannot create|timeout|abort|ECONNREFUSED|fetch failed/i.test(
          errText,
        )
      ) {
        logCommand(`OFFICE ${tool} (node fallback after agent: ${errText.slice(0, 120)})`);
        return createOfficeFileViaNode(tool, args);
      }
      // Other agent errors: still try Node so the user gets a real Office file.
      const fb = createOfficeFileViaNode(tool, args);
      if (fb.ok) {
        logCommand(`OFFICE ${tool} (node fallback)`);
        return fb;
      }
      return agentResult as { ok: boolean; result?: unknown; error?: string };
    } catch (e: any) {
      logCommand(`OFFICE ${tool} (node after error: ${e?.message || e})`);
      return createOfficeFileViaNode(tool, args);
    }
  }

  // ── Open image DIRECTLY (real image URL — not Google Images search page) ──
  if (tool === "openImage") {
    const query = String(args.query || args.q || args.topic || lastImageQuery || "").trim();
    const index = Number(args.index ?? args.n ?? args.position ?? 1) || 1;
    return openImageDirect(query, index);
  }

  // ── YouTube PLAY: resolve first/Nth video and open the watch URL ──
  // Frozen agent only opens search results; play must happen here.
  // Query was already live-resolved above (before open debounce).
  if (tool === "playYouTube") {
    const query = String(args.query || args.q || "").trim();
    const index = Number(args.index ?? args.n ?? args.position ?? 1) || 1;
    const title = String(args.title || args.videoTitle || args.video_title || "").trim();
    // Empty/stale query + index → click/title-match what is ON SCREEN.
    // Never inject lastYouTubeQuery — that re-scraped a different "first" video.
    const preferOnScreen =
      Boolean(args.preferOnScreen || args.prefer_on_screen) ||
      (!title &&
        (!query ||
          query.toLowerCase() === String(lastYouTubeQuery || "").toLowerCase() ||
          /^(first|second|third|video|result)/i.test(query)));
    return playYouTubeVideo(query, index, {
      title: title || undefined,
      preferOnScreen,
    });
  }

  // searchYouTube: ALWAYS results page only — never autoplay.
  // playFirst/open flags from the model are IGNORED (they caused "search → video plays").
  // Use playYouTube for open/play/watch.
  if (tool === "searchYouTube") {
    let query = String(args.query || args.q || "").trim();
    if (!query) {
      return { ok: false, error: "Parameter 'query' is required for searchYouTube." };
    }
    // Strip accidental command words so the search box is clean
    query = query
      .replace(/\b(search|find|look\s*up|browse)\b/gi, " ")
      .replace(/\bon\s+youtube\b/gi, " ")
      .replace(/\byoutube\b/gi, " ")
      .replace(/\s+/g, " ")
      .trim() || query;
    lastYouTubeQuery = query;
    lastYouTubeQueryAt = Date.now();
    // New search invalidates prior play debounce so "play first" works on fresh results.
    lastYouTubePlayKey = "";
    lastYouTubePlayAt = 0;
    lastPlayedVideoTitle = "";

    // ── In-app search: if YouTube app was opened recently (within 5 min),
    //    search inside the app instead of opening a browser tab. This handles
    //    the flow: "open YouTube app" → "search Motu Patlu" → types into app.
    const appIsRecent = lastYouTubeAppOpenedAt > 0 &&
      Date.now() - lastYouTubeAppOpenedAt < YOUTUBE_APP_STALE_MS;
    if (appIsRecent && process.platform === "win32") {
      const safe = query.replace(/'/g, "''");
      const ps = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class BikliYtAppSearch {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc lpEnumFunc, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
  public const uint KEYUP = 0x0002;
  public static void Hotkey(byte mod, byte key) {
    keybd_event(mod, 0, 0, UIntPtr.Zero);
    System.Threading.Thread.Sleep(30);
    keybd_event(key, 0, 0, UIntPtr.Zero);
    System.Threading.Thread.Sleep(30);
    keybd_event(key, 0, KEYUP, UIntPtr.Zero);
    System.Threading.Thread.Sleep(30);
    keybd_event(mod, 0, KEYUP, UIntPtr.Zero);
  }
}
"@
\$script:best = [IntPtr]::Zero
\$script:bestScore = -1
\$cb = [BikliYtAppSearch+EnumProc]{
  param([IntPtr]\$h, [IntPtr]\$l)
  if (-not [BikliYtAppSearch]::IsWindowVisible(\$h)) { return \$true }
  \$sb = New-Object System.Text.StringBuilder 512
  [void][BikliYtAppSearch]::GetWindowText(\$h, \$sb, \$sb.Capacity)
  \$title = \$sb.ToString()
  if ([string]::IsNullOrWhiteSpace(\$title)) { return \$true }
  \$t = \$title.ToLower()
  \$score = -1
  if (\$t.Contains('youtube')) { \$score = 100 }
  elseif (\$t.Contains('google') -or \$t.Contains('mozilla')) { \$score = 40 }
  if (\$score -gt \$script:bestScore) { \$script:bestScore = \$score; \$script:best = \$h }
  return \$true
}
[void][BikliYtAppSearch]::EnumWindows(\$cb, [IntPtr]::Zero)
if (\$script:best -eq [IntPtr]::Zero -or \$script:bestScore -lt 0) { Write-Output 'no_window'; exit 0 }
if ([BikliYtAppSearch]::IsIconic(\$script:best)) { [void][BikliYtAppSearch]::ShowWindow(\$script:best, 9) }
[void][BikliYtAppSearch]::SetForegroundWindow(\$script:best)
Start-Sleep -Milliseconds 400
Set-Clipboard -Value '${safe}'
Start-Sleep -Milliseconds 100
# Ctrl+E or / focuses the YouTube app search bar
[BikliYtAppSearch]::Hotkey(0x11, 0x45)
Start-Sleep -Milliseconds 300
# Select all + paste to replace any existing text
[BikliYtAppSearch]::Hotkey(0x11, 0x41)
Start-Sleep -Milliseconds 60
[BikliYtAppSearch]::Hotkey(0x11, 0x56)
Start-Sleep -Milliseconds 150
[BikliYtAppSearch]::keybd_event(0x0D, 0, 0, [UIntPtr]::Zero)
Start-Sleep -Milliseconds 30
[BikliYtAppSearch]::keybd_event(0x0D, 0, [BikliYtAppSearch]::KEYUP, [UIntPtr]::Zero)
Write-Output 'searched'
`.trim();
      try {
        const out = (await runPowerShellScript(ps, 12000)).trim();
        const line = out.split(/\r?\n/).pop() || "";
        if (line === "searched") {
          logCommand(`YOUTUBE_SEARCH_APP "${query}" (in-app search)`);
          return {
            ok: true,
            result: {
              result: `Searched "${query}" inside the YouTube app.`,
              query,
              mode: "in_app",
              autoplay: false,
            },
          };
        }
        // App window not found / lost — fall through to browser
        console.log(`[YouTube] In-app search failed (${line}), falling back to browser.`);
      } catch (e: any) {
        console.log(`[YouTube] In-app search error: ${e?.message || e}, falling back to browser.`);
      }
    }

    // Browser fallback — original behaviour.
    const searchUrl =
      `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`;
    const newWin = wantNewWindow(args);
    await openSystemBrowserUrl(searchUrl, {
      newWindow: newWin,
      newTab: newWin,
    });
    logCommand(`YOUTUBE_SEARCH "${query}" same_tab=${!newWin} (results only, no autoplay)`);
    return {
      ok: true,
      result: {
        result: `Searched YouTube for '${query}' — results page only (no video started). Say open the first/second video to play one.`,
        query,
        url: searchUrl,
        mode: newWin ? "new" : "same_tab",
        autoplay: false,
      },
    };
  }

  // openWebsite / searchGoogle / searchWeb — same-tab browser reuse by default
  if (tool === "openWebsite" || tool === "searchGoogle" || tool === "searchWeb" || tool === "searchGitHub") {
    const newWin = wantNewWindow(args);
    let url = "";
    let label = "";

    if (tool === "openWebsite") {
      const name = String(args.name || "").trim().toLowerCase();
      const rawUrl = String(args.url || "").trim();
      const siteMap: Record<string, string> = {
        youtube: "https://www.youtube.com",
        gmail: "https://mail.google.com",
        chatgpt: "https://chatgpt.com",
        google: "https://www.google.com",
        github: "https://github.com",
        wikipedia: "https://www.wikipedia.org",
        reddit: "https://www.reddit.com",
        twitter: "https://twitter.com",
        x: "https://x.com",
        instagram: "https://www.instagram.com",
        facebook: "https://www.facebook.com",
        linkedin: "https://www.linkedin.com",
        maps: "https://maps.google.com",
        drive: "https://drive.google.com",
        netflix: "https://www.netflix.com",
        spotify: "https://open.spotify.com",
      };
      // If model passes a YouTube search URL but user wanted a video — still open URL as given;
      // playYouTube is preferred for play/open video intents.
      if (rawUrl) url = rawUrl.startsWith("http") ? rawUrl : `https://${rawUrl}`;
      else if (name && siteMap[name]) url = siteMap[name];
      else if (name) url = name.includes(".") ? `https://${name}` : `https://www.google.com/search?q=${encodeURIComponent(name)}`;
      else return { ok: false, error: "Provide 'name' or 'url' for openWebsite." };
      // YouTube watch links: reuse the SAME browser tab when one is already open
      // (no new window/tab). navigateBrowserTabInPlace focuses the existing browser
      // and navigates its address bar in place; we only fall back to a fresh OS
      // open when no browser window is running. Mirrors playYouTubeVideo.
      if (/youtube\.com\/watch|youtu\.be\//i.test(url)) {
        const watchUrl = url.startsWith("http") ? url : `https://${url}`;
        // OPEN DIRECTLY — no Ctrl+L/Ctrl+V clipboard paste.
        await openUrlViaOsStart(watchUrl);
        logCommand(`OPEN_SITE_YT_WATCH ${watchUrl.slice(0, 100)}`);
        return {
          ok: true,
          result: {
            result: `Opened YouTube video directly: ${url}`,
            url,
            mode: "direct_watch",
          },
        };
      }
      label = url;
    } else {
      const query = String(args.query || args.q || "").trim();
      if (!query) return { ok: false, error: "Parameter 'query' is required." };
      // "open cat image" / "images of X" / tbm images → openImage direct URL
      const engineHint = String(args.engine || "").toLowerCase();
      const wantsImage =
        engineHint === "images" ||
        engineHint === "image" ||
        args.images === true ||
        args.image === true ||
        /\b(images?|photos?|pictures?)\b/i.test(query) ||
        /\b(open|show)\b.+\b(image|photo|picture)\b/i.test(query);
      if (wantsImage && (tool === "searchGoogle" || tool === "searchWeb")) {
        const imgQ = query
          .replace(/\b(open|show|search|find|google)\b/gi, " ")
          .replace(/\b(images?|photos?|pictures?)\s*(of|for)?\b/gi, " ")
          .replace(/\s+/g, " ")
          .trim() || query;
        const index = Number(args.index ?? args.n ?? 1) || 1;
        return openImageDirect(imgQ, index);
      }
      const engine =
        tool === "searchGoogle"
          ? "google"
          : tool === "searchGitHub"
            ? "github"
            : String(args.engine || "google").toLowerCase();
      if (engine === "youtube") {
        let q = query.replace(/\s*on\s*youtube\s*/i, " ").trim() || query;
        // Pure search intent → results only (never autoplay)
        const wantsSearchOnly =
          /\b(search|find|look\s*up|browse)\b/i.test(query) &&
          !/\b(play|open|watch)\b/i.test(query);
        const wantsPlay =
          !wantsSearchOnly &&
          /\b(open|play|watch)\b/i.test(query) &&
          !/\b(search|find)\b/i.test(query);
        if (wantsPlay) {
          const cleanQ = q
            .replace(/\b(open|play|watch)\b/gi, " ")
            .replace(/\b(video|song|clip)\b/gi, " ")
            .replace(/\s+/g, " ")
            .trim() || q;
          return playYouTubeVideo(cleanQ, Number(args.index ?? 1) || 1);
        }
        q = q
          .replace(/\b(search|find|look\s*up|browse)\b/gi, " ")
          .replace(/\s+/g, " ")
          .trim() || q;
        lastYouTubeQuery = q;
        lastYouTubeQueryAt = Date.now();
        lastYouTubePlayKey = "";
        lastYouTubePlayAt = 0;
        lastPlayedVideoTitle = "";
        url = `https://www.youtube.com/results?search_query=${encodeURIComponent(q)}`;
      } else if (engine === "github" || tool === "searchGitHub") {
        url = `https://github.com/search?q=${encodeURIComponent(query)}&type=repositories`;
      } else if (engine === "bing") {
        url = `https://www.bing.com/search?q=${encodeURIComponent(query)}`;
      } else if (engine === "duckduckgo") {
        url = `https://duckduckgo.com/?q=${encodeURIComponent(query)}`;
      } else {
        url = `https://www.google.com/search?q=${encodeURIComponent(query)}`;
      }
      label = query;
    }

    await openSystemBrowserUrl(url, { newWindow: newWin, newTab: newWin });
    logCommand(`${tool} url=${url.slice(0, 100)} same_tab=${!newWin}`);
    return {
      ok: true,
      result: {
        result: newWin
          ? `Opened ${label} in a new browser tab/window.`
          : `Opened ${label} in the existing browser tab (no new tab).`,
        url,
        mode: newWin ? "new" : "same_tab",
      },
    };
  }

  // ── File Explorer / folders: always reuse one window unless new_window ──
  // Handled in Node so frozen/old Python agents get the same behaviour.
  if (tool === "openFolder") {
    if (process.platform === "win32") {
      return openFolderViaNode(args);
    }
    // Non-Windows: fall through to agent
  }

  // ── Open any Windows app (focus existing first; new window only if asked) ──
  if (tool === "openApplication") {
    const name = String(args.name || args.application || args.app || "").trim();
    if (!name) {
      return { ok: false, error: "Parameter 'name' (application name) is required." };
    }
    const newWindow = wantNewWindow(args);
    // Optional working folder (terminals / cmd-here). Read before platform branch.
    const folder = String(args.folder || args.path || args.working_dir || args.directory || "").trim();
    // Mark that the YouTube app was opened so a later searchYouTube
    // searches inside the app instead of opening the browser.
    const isYouTubeApp = /^(youtube|youtube app)$/i.test(name.trim());
    // Node path first on Windows: focus existing instance / reuse Explorer.
    if (process.platform === "win32") {
      const opened = await openApplicationViaNode(name, { newWindow, folder });
      if (opened.ok) {
        if (isYouTubeApp) lastYouTubeAppOpenedAt = Date.now();
        return opened;
      }
    }
    const multiWord = name.trim().split(/\s+/).length >= 2;
    if (!desktopAgentVerified) await ensureDesktopAgent();
    try {
      const agentResult = await callDesktopAgentRaw("openApplication", {
        name,
        method: multiWord ? "search" : undefined,
        new_window: newWindow,
      });
      if (agentResult.ok) {
        if (isYouTubeApp) lastYouTubeAppOpenedAt = Date.now();
        logCommand(`OPEN_APP "${name}" (desktop agent)`);
        return agentResult as { ok: boolean; result?: unknown; error?: string };
      }
    } catch {
      /* use fallback */
    }
    const fallback = await openApplicationViaNode(name, { newWindow, folder });
    if (fallback.ok && isYouTubeApp) lastYouTubeAppOpenedAt = Date.now();
    return fallback;
  }

  // ── System settings (Bluetooth / Wi‑Fi / Settings pages) Node fallback ──
  if (
    tool === "systemSetting" ||
    tool === "openWindowsSetting" ||
    tool === "toggleBluetooth" ||
    tool === "toggleWifi"
  ) {
    if (!desktopAgentVerified) await ensureDesktopAgent();
    try {
      const agentResult = await callDesktopAgentRaw(tool, args);
      if (agentResult.ok) {
        logCommand(`SYSTEM_SETTING ${tool} (desktop agent)`);
        return agentResult as { ok: boolean; result?: unknown; error?: string };
      }
      const errText = String(agentResult.error || "");
      // Fall through to Node radio/settings when agent is old (unknown tool),
      // control-locked (stale frozen agent), or radio API failed — keep voice fast.
      const canNodeFallback =
        /unknown tool|not found|not registered|not implemented|LOCKED|control word|timeout|abort/i.test(errText) ||
        /bluetooth|wifi|wi-?fi|setting|dark|light|airplane|night/i.test(tool + JSON.stringify(args));
      if (!canNodeFallback) {
        return agentResult as { ok: boolean; result?: unknown; error?: string };
      }
      console.warn(`[SystemSetting] Agent failed (${errText.slice(0, 120)}); trying Node fallback…`);
    } catch {
      /* node fallback */
    }
    // Node fallback: open the right ms-settings: page; best-effort radio via PS
    const setting = String(
      args.setting || args.name || args.target ||
      (tool === "toggleBluetooth" ? "bluetooth" :
        tool === "toggleWifi" ? "wifi" : "settings"),
    ).toLowerCase();
    const action = String(args.action || args.state || "open").toLowerCase();
    const pageMap: Record<string, string> = {
      bluetooth: "ms-settings:bluetooth",
      wifi: "ms-settings:network-wifi",
      "wi-fi": "ms-settings:network-wifi",
      airplane: "ms-settings:network-airplanemode",
      display: "ms-settings:display",
      sound: "ms-settings:sound",
      network: "ms-settings:network",
      settings: "ms-settings:",
      "night light": "ms-settings:nightlight",
      nightlight: "ms-settings:nightlight",
      night: "ms-settings:nightlight",
    };
    const uri = pageMap[setting] || `ms-settings:${setting.replace(/\s+/g, "-")}`;

    // ── Night light toggle via Windows Registry (direct toggle, no Settings window) ──
    if (/night.?light|nightlight|night/i.test(setting) && /^(on|off|enable|disable|toggle)$/i.test(action)) {
      const wantOn = /^(on|enable|true)$/i.test(action) ? 1 : /^(off|disable|false)$/i.test(action) ? 0 : null;
      if (wantOn !== null) {
        const ps = `
$regPath = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\CloudStore\\Store\\DefaultAccount\\Current\\default$windows.data.bluelightreduction.bluelightreductionstate\\windows.data.bluelightreduction.bluelightreductionstate'
try {
  $state = Get-ItemProperty -Path $regPath -Name 'Data' -ErrorAction Stop
  $bytes = [byte[]]$state.Data
  # bytes[0] = version, bytes[1] = 1=on/0=off, bytes[8] = master switch
  if ($bytes.Length -gt 8) {
    $bytes[8] = ${wantOn}
    Set-ItemProperty -Path $regPath -Name 'Data' -Value $bytes -ErrorAction Stop
    Write-Output 'OK'
  } else {
    Write-Output 'TOO_SHORT'
  }
} catch {
  Write-Output 'NO_REG'
}
`.trim();
        try {
          await new Promise<void>((resolve, reject) => {
            exec(`powershell -NoProfile -NonInteractive -Command "${ps.replace(/"/g, '\\"').replace(/\n/g, ';')}"`, { windowsHide: true, timeout: 8000 }, (err: any, stdout: string) => {
              const out = (stdout || "").trim();
              if (out === 'OK') resolve();
              else reject(new Error(out));
            });
          });
          logCommand(`NIGHT_LIGHT ${action}`);
          return { ok: true, result: { result: `Night light turned ${action}.` } };
        } catch (e: any) {
          console.warn(`[NightLight] Registry toggle failed: ${e?.message || e} — opening Settings page`);
        }
      }
    }

    // Try WinRT radio toggle for bluetooth/wifi on/off
    if (
      (setting === "bluetooth" || setting === "wifi" || setting === "wi-fi") &&
      /^(on|off|enable|disable|toggle|true|false)$/i.test(action)
    ) {
      const kind = setting.startsWith("wi") ? "WiFi" : "Bluetooth";
      const wantOn = /^(on|enable|true)$/i.test(action)
        ? true
        : /^(off|disable|false)$/i.test(action)
          ? false
          : null; // toggle
      const scriptPath = path.join(os.tmpdir(), `bikli-radio-${Date.now()}.ps1`);
      const stateExpr =
        wantOn === null
          ? `if ($r.State.ToString() -eq 'On') { 'Off' } else { 'On' }`
          : wantOn
            ? `'On'`
            : `'Off'`;
      const script = `
Add-Type -AssemblyName System.Runtime.WindowsRuntime -ErrorAction SilentlyContinue | Out-Null
$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1' })[0]
function Await($WinRtTask, $ResultType) {
  $asTask = $asTaskGeneric.MakeGenericMethod($ResultType)
  $netTask = $asTask.Invoke($null, @($WinRtTask))
  if (-not $netTask.Wait(6000)) { throw 'WinRT timeout' }
  return $netTask.Result
}
[Windows.Devices.Radios.Radio,Windows.System.Devices,ContentType=WindowsRuntime] | Out-Null
[Windows.Devices.Radios.RadioAccessStatus,Windows.System.Devices,ContentType=WindowsRuntime] | Out-Null
$null = Await ([Windows.Devices.Radios.Radio]::RequestAccessAsync()) ([Windows.Devices.Radios.RadioAccessStatus])
$radios = Await ([Windows.Devices.Radios.Radio]::GetRadiosAsync()) ([System.Collections.Generic.IReadOnlyList[Windows.Devices.Radios.Radio]])
$r = $radios | Where-Object { $_.Kind -eq '${kind}' } | Select-Object -First 1
if (-not $r) { Write-Output 'MISSING'; exit 1 }
$target = ${stateExpr}
$null = Await ($r.SetStateAsync($target)) ([Windows.Devices.Radios.RadioAccessStatus])
Write-Output $r.State.ToString()
`.trim();
      try {
        fs.writeFileSync(scriptPath, script, "utf8");
        const out = await new Promise<string>((resolve, reject) => {
          exec(
            `powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${scriptPath}"`,
            { windowsHide: true, timeout: 10000 },
            (err, stdout) => {
              try { fs.unlinkSync(scriptPath); } catch { /* ignore */ }
              if (err) reject(err);
              else resolve(String(stdout || "").trim());
            },
          );
        });
        if (out && out !== "MISSING") {
          logCommand(`SYSTEM_SETTING ${setting} -> ${out} (node radio)`);
          return {
            ok: true,
            result: {
              result: `${kind === "WiFi" ? "Wi‑Fi" : "Bluetooth"} is now ${out}.`,
              state: out.toLowerCase(),
              via: "node-fallback",
            },
          };
        }
      } catch {
        try { fs.unlinkSync(scriptPath); } catch { /* ignore */ }
      }
    }

    // Open Settings page as last resort
    try {
      await new Promise<void>((resolve, reject) => {
        const cmd =
          process.platform === "win32"
            ? `cmd /c start "" "${uri}"`
            : `xdg-open "${uri}"`;
        exec(cmd, { windowsHide: true }, (err) => (err ? reject(err) : resolve()));
      });
      logCommand(`SYSTEM_SETTING open ${uri} (node fallback)`);
      return {
        ok: true,
        result: {
          result: `Opened Windows settings for ${setting}.`,
          uri,
          via: "node-fallback",
        },
      };
    } catch (err: any) {
      return { ok: false, error: `Could not change setting '${setting}': ${err?.message || err}` };
    }
  }

  // ── YouTube / browser media: pause, resume, play, mute, skip ──
  // Prefer Python agent (focuses YouTube window). Fall back to Node media keys
  // so packaged builds with an older frozen agent still pause/resume.
  // State machine blocks play/pause toggles that would reverse user intent.
  if (tool === "browserMediaControl") {
    const action = resolveMediaAction(String(args.action || args.command || "").trim());
    const value = args.value ?? args.percent ?? args.level;
    const guard = mediaActionGuard(action);
    if (guard.skip) {
      logCommand(`MEDIA_CONTROL ${action} skipped (state=${mediaPlaybackState})`);
      return {
        ok: true,
        result: {
          result: guard.reason,
          action,
          skipped: true,
          state: mediaPlaybackState,
        },
      };
    }
    // Try desktop agent first (has window focus + YouTube shortcuts).
    if (!desktopAgentVerified) {
      await ensureDesktopAgent();
    }
    try {
      // For pause: prefer Node STOP key path (non-toggle) after agent optional.
      // Still try agent for mute/fullscreen etc.
      if (action === "pause" || action === "stop") {
        const nodePause = await mediaControlViaNode("pause", value);
        if (nodePause.ok) return nodePause;
      }
      const agentResult = await callDesktopAgentRaw("browserMediaControl", {
        action,
        value,
      });
      if (agentResult.ok) {
        if (guard.nextState) {
          mediaPlaybackState = guard.nextState;
          lastMediaActionAt = Date.now();
        }
        logCommand(`MEDIA_CONTROL ${action} (desktop agent) state=${mediaPlaybackState}`);
        return agentResult as { ok: boolean; result?: unknown; error?: string };
      }
      // Unknown tool / old agent → Node media-key fallback
      const errText = String(agentResult.error || "");
      if (
        /unknown tool|not found|not registered|404|not implemented/i.test(errText) ||
        !desktopAgentVerified
      ) {
        return mediaControlViaNode(action, value);
      }
      // Soft-fail to Node anyway for play/pause so the user still gets control
      if (/play|pause|resume|mute|skip|next|previous/i.test(action)) {
        const fb = await mediaControlViaNode(action, value);
        if (fb.ok) return fb;
      }
      return agentResult as { ok: boolean; result?: unknown; error?: string };
    } catch {
      return mediaControlViaNode(action, value);
    }
  }

  // ── Real-browser scroll (YouTube / Chrome / Edge) ──
  // Always use Node mouse-wheel path so voice "scroll" feels like a real wheel
  // flick (never PageDown / full-page). Avoids old frozen-agent jump behavior.
  if (tool === "browserScroll") {
    const direction = String(args.direction || args.dir || "down").toLowerCase();
    // Default 3 wheel notches — short mouse flick, not a full page
    let amount: unknown = args.amount ?? args.clicks ?? args.distance ?? 3;
    // Clamp here too so Gemini "amount=12" cannot full-page jump
    const n = Number(amount);
    if (Number.isFinite(n)) {
      if (n >= 50) amount = Math.max(2, Math.min(8, Math.floor(n / 120)));
      else amount = Math.max(1, Math.min(8, Math.abs(Math.round(n))));
    } else {
      amount = 3;
    }
    return browserScrollViaNode(direction, amount);
  }

  // Lazy ensure: if we haven't verified the agent, try (re)starting it once.
  if (!desktopAgentVerified) {
    await ensureDesktopAgent();
  }

  const tryOnce = async (): Promise<{ ok: boolean; result?: any; error?: string }> => {
    logCommand(`EXECUTE ${tool} ${JSON.stringify(args)}`);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DESKTOP_AGENT_TIMEOUT);

    const res = await fetch(`${DESKTOP_AGENT_URL}/execute`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tool, args }),
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      logError(`AGENT_HTTP_${res.status} ${tool}: ${text.substring(0,200)}`);
      return { ok: false, error: `Desktop agent HTTP ${res.status}: ${text}` };
    }
    return await res.json();
  };

  try {
    return await tryOnce();
  } catch (err: any) {
    desktopAgentVerified = false; // mark stale so we re-spawn
    const cause = err?.cause?.code || err?.code || "";
    const detail = String(err?.message || err || "");
    const isTimeout = err?.name === "AbortError";
    const isRefused =
      cause === "ECONNREFUSED" || /ECONNREFUSED|refused|fetch failed|ECONNRESET/i.test(detail);

    // One automatic recover+retry so tool calls don't fail on a dead agent mid-session.
    if (!isTimeout && isRefused) {
      console.warn(`[Desktop Agent] ${tool} unreachable — force re-spawn and retry once…`);
      try {
        await ensureDesktopAgent(true);
        if (desktopAgentVerified) {
          return await tryOnce();
        }
      } catch (retryErr: any) {
        console.warn(`[Desktop Agent] Retry after re-spawn failed: ${retryErr?.message || retryErr}`);
      }
    }

    let msg: string;
    if (isTimeout) {
      msg = "Desktop agent timed out.";
    } else if (isRefused) {
      msg =
        "Desktop agent connection refused (nothing listening on 127.0.0.1:8765). Restart BIKLI so the agent can auto-start.";
    } else {
      msg =
        "Desktop agent is not running. Restart BIKLI, or start the agent with: uvicorn desktop_agent.main:app --port 8765";
    }
    logError(`AGENT_UNREACHABLE ${tool}: ${msg} (${cause || detail})`);
    return { ok: false, error: msg };
  }
}

// ---------------------------------------------------------------------------
// SSRF guard for the server-side proxy endpoints.
// The in-app browser proxies must ONLY fetch public internet content. Without
// this, any caller can point /api/proxy or /api/web-proxy at loopback/LAN
// addresses and read back the user's local data (memories, settings, logs,
// the desktop agent) through the server.
// ---------------------------------------------------------------------------
function isPrivateIp(ip: string): boolean {
  const addr = String(ip || "").replace(/^\[|\]$/g, "").toLowerCase();
  if (addr.includes(":")) {
    // IPv6 — loopback, unspecified, link-local, unique-local, docs, v4-mapped loopback.
    if (addr === "::" || addr === "::1" || addr === "::ffff:127.0.0.1") return true;
    if (/^fe80:/i.test(addr) || /^fc/i.test(addr) || /^fd/i.test(addr)) return true;
    if (/^2001:db8:/i.test(addr)) return true;
    return false;
  }
  const parts = addr.split(".").map((n) => parseInt(n, 10) || 0);
  if (parts.length !== 4) return true; // malformed → treat as unsafe
  const [a, b] = parts;
  if (a === 0) return true; // "this" network
  if (a === 10) return true; // 10/8
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12
  if (a === 192 && b === 168) return true; // 192.168/16
  if (a >= 224) return true; // multicast + reserved
  return false;
}

/** True when a proxy target host must be rejected (SSRF guard). */
async function isPrivateOrUnsafeHost(hostname: string): Promise<boolean> {
  const lower = String(hostname || "").toLowerCase().replace(/\.$/, "");
  if (!lower || lower === "localhost") return true;
  if (/^[0-9a-f:.]+$/.test(lower)) return isPrivateIp(lower); // bare IP literal
  try {
    const addrs = await dns.promises.lookup(lower, { all: true });
    return addrs.some((a) => isPrivateIp(a.address));
  } catch {
    return false; // DNS failure — let fetch surface the real error
  }
}

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json());

  // Memory REST API Endpoints
  app.get("/api/memories", async (req, res) => {
    try {
      const memories = await loadMemories();
      res.json(memories);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/memories", async (req, res) => {
    try {
      const { category, text } = req.body;
      if (!category || !text) {
        return res.status(400).json({ error: "Category and text parameters are required." });
      }
      // Serialized read-modify-write — never clobber a concurrent consolidation.
      let created: Memory | null = null;
      await mutateMemories((memories) => {
        const timestamp = new Date().toISOString();
        created = {
          id: Math.random().toString(36).substring(2, 11),
          category,
          text,
          createdAt: timestamp,
          updatedAt: timestamp
        };
        memories.push(created);
        return memories;
      });
      res.status(201).json(created);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.delete("/api/memories/:id", async (req, res) => {
    try {
      const { id } = req.params;
      await mutateMemories((memories) => memories.filter(m => m.id !== id));
      res.json({ success: true });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.put("/api/memories/:id", async (req, res) => {
    try {
      const { id } = req.params;
      const { category, text } = req.body;
      if (!category || !text) {
        return res.status(400).json({ error: "Category and text parameters are required." });
      }
      // Serialized read-modify-write — keeps the manual EDIT in lock-step with
      // any concurrent background consolidation, so neither can clobber the other.
      let updated: Memory | null = null;
      await mutateMemories((memories) => {
        const idx = memories.findIndex(m => m.id === id);
        if (idx === -1) return memories;
        const timestamp = new Date().toISOString();
        updated = { ...memories[idx], category, text, updatedAt: timestamp };
        memories[idx] = updated;
        return memories;
      });
      if (!updated) {
        return res.status(404).json({ error: "Memory not found." });
      }
      res.json(updated);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // ---------------------------------------------------------------------------
  // V2: Settings API — mirrors the memory persistence pattern.
  // Reads/writes settings.json so the Python agent can also check auto-start.
  // ---------------------------------------------------------------------------
  const SETTINGS_FILE = dataFile("settings.json");

  function loadSettingsFile(): Record<string, unknown> {
    try {
      if (fs.existsSync(SETTINGS_FILE)) {
        return JSON.parse(fs.readFileSync(SETTINGS_FILE, "utf-8"));
      }
    } catch { /* corrupt file — return defaults */ }
    return {};
  }

  function saveSettingsFile(data: Record<string, unknown>): void {
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(data, null, 2), "utf-8");
  }

  app.get("/api/settings", async (_req, res) => {
    try {
      res.json(loadSettingsFile());
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/settings", async (req, res) => {
    try {
      const patch = req.body;
      if (!patch || typeof patch !== "object") {
        return res.status(400).json({ error: "Request body must be a JSON object." });
      }
      const current = loadSettingsFile();
      const next = { ...current, ...patch };
      saveSettingsFile(next);

      // If auto-start toggled, relay to the desktop agent so the registry key
      // is flipped immediately (don't wait for a voice command).
      if ("autoStart" in patch) {
        callDesktopAgent(patch.autoStart ? "enableAutoStart" : "disableAutoStart", {})
          .catch(() => {});
      }

      logCommand(`SETTINGS_UPDATED ${JSON.stringify(patch)}`);
      res.json(next);
    } catch (e: any) {
      logError(`SETTINGS_SAVE_ERROR: ${e.message}`);
      res.status(500).json({ error: e.message });
    }
  });

  // ---------------------------------------------------------------------------
  // Computer control status (control-word lock) — UI badge + session cleanup.
  // ---------------------------------------------------------------------------
  app.get("/api/desktop/control", async (_req, res) => {
    res.json({
      enabled: nodeComputerControlEnabled,
      reason: nodeComputerControlReason,
      since: nodeComputerControlSince,
    });
  });

  app.post("/api/desktop/control", async (req, res) => {
    try {
      const enabled = !!req.body?.enabled;
      const reason = String(req.body?.reason || (enabled ? "manual enable" : "manual disable"));
      const result = await callDesktopAgent(
        enabled ? "enableComputerControl" : "disableComputerControl",
        { reason },
      );
      res.json({
        ok: !!result.ok,
        enabled: nodeComputerControlEnabled,
        result: result.result,
        error: result.error,
      });
    } catch (e: any) {
      res.status(500).json({ ok: false, enabled: false, error: e?.message || String(e) });
    }
  });

  // ---------------------------------------------------------------------------
  // Config / API-key onboarding.
  // The Gemini key is never shipped; each user supplies their own on first run.
  // GET reports only whether a key exists — the key itself is never returned.
  // ---------------------------------------------------------------------------
  app.get("/api/config", (_req, res) => {
    const hasApiKey = hasGeminiApiKey();
    const source = getGeminiApiKeySource();
    res.json({
      hasApiKey,
      keySource: source,
      // A key from the environment (dev-only) cannot be removed from the UI.
      canDelete: source === "user",
    });
  });

  app.post("/api/config/apikey", async (req, res) => {
    try {
      const key: string = (req.body?.apiKey ?? "").toString().trim();
      if (!key) {
        return res.status(400).json({ error: "API key is required." });
      }
      // Validate the key by listing models — this checks authentication only,
      // without depending on any single model's availability or per-model
      // quota (a 429 on one model must NOT read as an invalid key). We only
      // reject on genuine auth failures; transient/network errors still save,
      // since the live connection will surface any real problem later.
      try {
        const test = new GoogleGenAI({ apiKey: key });
        const pager = await test.models.list();
        await pager[Symbol.asyncIterator]().next(); // force the first request
      } catch (e: any) {
        const msg = String(e?.message || e);
        const isAuthError =
          /API[_ ]?KEY|PERMISSION_DENIED|UNAUTHENTICATED|invalid|401|403/i.test(msg);
        if (isAuthError) {
          logError(`APIKEY_VALIDATION_REJECTED: ${msg}`);
          return res.status(400).json({
            error: "That key was rejected by Google. Check it and try again.",
          });
        }
        logError(`APIKEY_VALIDATION_SOFT_FAIL (saving anyway): ${msg}`);
      }
      setGeminiApiKey(key);
      logCommand("APIKEY_SAVED");
      res.json({ ok: true, hasApiKey: true, keySource: "user", canDelete: true });
    } catch (e: any) {
      logError(`APIKEY_SAVE_ERROR: ${e?.message || e}`);
      res.status(500).json({ error: e?.message || "Failed to save API key." });
    }
  });

  // Remove the user-stored key (used by the Settings → API Key panel).
  app.delete("/api/config/apikey", (_req, res) => {
    const source = getGeminiApiKeySource();
    if (source !== "user") {
      return res.status(400).json({
        error:
          source === "env"
            ? "This key comes from the GEMINI_API_KEY environment variable and cannot be removed here."
            : "No API key is stored to delete.",
      });
    }
    clearGeminiApiKey();
    logCommand("APIKEY_DELETED");
    res.json({ ok: true, hasApiKey: hasGeminiApiKey(), keySource: getGeminiApiKeySource(), canDelete: false });
  });

  // V2: Agent health proxy (for the Settings panel — avoids direct :8765 call
  // which may fail due to CORS when served on a different origin).
  app.get("/api/agent-health", async (_req, res) => {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 3000);
      const r = await fetch(`${DESKTOP_AGENT_URL}/health`, { signal: ctrl.signal });
      clearTimeout(timer);
      if (r.ok) {
        const d = await r.json();
        res.json({ online: true, tool_count: d.tool_count });
      } else {
        res.json({ online: false });
      }
    } catch {
      res.json({ online: false });
    }
  });

  // V2: Logs API — returns recent log entries (last 100 lines) for display.
  app.get("/api/logs/:file", async (req, res) => {
    try {
      const fileName = String(req.params.file);
      // Whitelist to prevent directory traversal.
      if (!["commands", "startup", "errors"].includes(fileName)) {
        return res.status(400).json({ error: "Invalid log file. Use: commands, startup, or errors." });
      }
      const logPath = path.join(LOGS_DIR, `${fileName}.log`);
      if (!fs.existsSync(logPath)) {
        return res.json({ lines: [], file: fileName });
      }
      const content = fs.readFileSync(logPath, "utf-8");
      const lines = content.split("\n").filter(Boolean).slice(-100);
      res.json({ lines, file: fileName });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Safe Server-Side Scraper & HTML Proxy endpoint
  app.get("/api/proxy", async (req, res) => {
    try {
      const url = req.query.url as string;
      if (!url) {
        return res.status(400).json({ error: "Missing 'url' parameter." });
      }

      // SSRF guard — never let this scraper reach local/LAN/loopback services.
      let parsedProxyUrl: URL;
      try {
        parsedProxyUrl = new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`);
      } catch {
        return res.status(400).json({ error: "Invalid URL." });
      }
      if (await isPrivateOrUnsafeHost(parsedProxyUrl.hostname)) {
        return res
          .status(400)
          .json({ error: "This proxy only fetches public websites — internal addresses are not allowed." });
      }

      console.log(`[Proxy Scraper] Fetching external content for: ${url}`);
      const response = await fetch(parsedProxyUrl.href, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36"
        }
      });

      if (!response.ok) {
        throw new Error(`Scraper failed to load page: status ${response.status}`);
      }

      const html = await response.text();

      // Simple regex-based HTML parsers for standard items
      const titleMatch = html.match(/<title>(.*?)<\/title>/i);
      const title = titleMatch ? titleMatch[1].trim() : "";

      // Extract high-level headings (h1, h2, h3)
      const headings: string[] = [];
      const headingMatches = html.matchAll(/<h([1-3])\b[^>]*>(.*?)<\/h\1>/gi);
      for (const match of headingMatches) {
        const text = match[2].replace(/<[^>]*>/g, "").trim();
        if (text && text.length > 3 && text.length < 120 && !headings.includes(text)) {
          headings.push(text);
        }
      }

      // Extract organic anchor links
      const links: { text: string; href: string }[] = [];
      const linkMatches = html.matchAll(/<a\b[^>]*\bhref=["']([^"']+)["'][^>]*>(.*?)<\/a>/gi);
      for (const match of linkMatches) {
        let href = match[1].trim();
        const text = match[2].replace(/<[^>]*>/g, "").trim();
        
        if (text && text.length > 2 && text.length < 100) {
          if (href.startsWith("/")) {
            try {
              const u = new URL(url);
              href = `${u.protocol}//${u.host}${href}`;
            } catch {}
          }
          if (href.startsWith("http://") || href.startsWith("https://")) {
            links.push({ text, href });
          }
        }
      }

      // Extract general copy paragraphs
      const paragraphs: string[] = [];
      const paragraphMatches = html.matchAll(/<p\b[^>]*>(.*?)<\/p>/gi);
      for (const match of paragraphMatches) {
        const text = match[1].replace(/<[^>]*>/g, "").trim();
        if (text && text.length > 25 && text.length < 600 && !paragraphs.includes(text)) {
          paragraphs.push(text);
        }
      }

      // Extract button elements
      const buttons: string[] = [];
      const buttonMatches = html.matchAll(/<button\b[^>]*>(.*?)<\/button>/gi);
      for (const match of buttonMatches) {
        const text = match[1].replace(/<[^>]*>/g, "").trim();
        if (text && text.length > 1 && text.length < 60 && !buttons.includes(text)) {
          buttons.push(text);
        }
      }

      res.json({
        url,
        title,
        headings: headings.slice(0, 15),
        links: links.filter(l => !l.href.includes("javascript:")).slice(0, 30),
        buttons: buttons.slice(0, 15),
        paragraphs: paragraphs.slice(0, 12)
      });

    } catch (err: any) {
      console.error(`[Proxy Scraper] Error fetching ${req.query.url}:`, err.message);
      res.status(500).json({ error: `Scraper error: ${err.message}` });
    }
  });

  // High-fidelity fully functional HTML Proxy which circumvents CSP and X-Frame-Options
  app.get("/api/web-proxy", async (req, res) => {
    let targetUrl = "";
    try {
      const urlParam = req.query.url as string;
      if (!urlParam) {
        return res.status(400).send("Bikli Web Proxy Error: Missing target 'url' parameter");
      }

      targetUrl = urlParam.trim();
      
      // Prevent relative paths from requesting on same-origin
      if (targetUrl.startsWith("/")) {
        return res.status(400).send(`Bikli Web Proxy Error: Relative paths are not supported directly (${targetUrl}).`);
      }

      // Check protocol and hostname format
      try {
        if (!targetUrl.startsWith("http://") && !targetUrl.startsWith("https://")) {
          targetUrl = "https://" + targetUrl;
        }
        const parsed = new URL(targetUrl);
        if (!parsed.hostname || !parsed.hostname.includes(".")) {
          throw new Error("Missing or invalid domain name extension (e.g. .com, .org, .net).");
        }
      } catch (err: any) {
        return res.status(400).send(`Bikli Web Proxy Error: Invalid URL specified: "${urlParam}". Make sure you enter a valid domain name.`);
      }

      // SSRF guard — this proxy must never fetch loopback/LAN/private targets
      // (which previously allowed reading /api/memories, the desktop agent, etc.).
      const proxyHost = new URL(targetUrl).hostname;
      if (await isPrivateOrUnsafeHost(proxyHost)) {
        return res.status(400).send(
          `Bikli Web Proxy Error: This proxy only fetches public websites — access to "${proxyHost}" is not allowed.`,
        );
      }

      console.log(`[Web Proxy] Routing connection through proxy: ${targetUrl}`);
      
      let response;
      try {
        response = await fetch(targetUrl, {
          headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36",
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8"
          }
        });
      } catch (fetchErr: any) {
        console.warn(`[Web Proxy Failed Fetch] Target: ${targetUrl} Error:`, fetchErr.message);
        return res.status(502).send(`Bikli Web Proxy Error: Unable to fetch the website "${targetUrl}". The site might be offline, or the URL address is spelled incorrectly. Details: ${fetchErr.message}`);
      }

      if (!response.ok) {
        return res.status(response.status).send(`Bikli Web Proxy Error: Failed loading remote website. Server returned status: ${response.status} (${response.statusText})`);
      }

      const contentType = response.headers.get("content-type") || "";
      
      // If it is not HTML (e.g. stylesheet, script, or image loaded directly), proxy it as binary
      if (!contentType.includes("text/html")) {
        const arrayBuffer = await response.arrayBuffer();
        res.setHeader("Content-Type", contentType);
        return res.send(Buffer.from(arrayBuffer));
      }

      let htmlContents = await response.text();

      // Inject base tag to resolve relative paths and direct parent communication scripts
      const baseUrlTag = `<base href="${targetUrl}" />`;
      const interceptorScript = `
        <script>
          (function() {
            // Hijack link interactions safely
            document.addEventListener('click', function(e) {
              var anchor = e.target.closest('a');
              if (anchor) {
                var href = anchor.getAttribute('href');
                if (href && !href.startsWith('#') && !href.startsWith('javascript:')) {
                  e.preventDefault();
                  try {
                    var resolvedUrl = new URL(href, window.location.href).href;
                    window.parent.postMessage({ type: 'NAVIGATE', url: resolvedUrl }, '*');
                  } catch (err) {
                    console.error("[Proxy Interceptor] Failed resolving link:", err);
                  }
                }
              }
            }, true);

            // Hijack search form submits
            document.addEventListener('submit', function(e) {
              var form = e.target;
              if (form) {
                e.preventDefault();
                try {
                  var formData = new FormData(form);
                  var params = new URLSearchParams();
                  formData.forEach(function(value, key) {
                    if (typeof value === 'string') {
                      params.append(key, value);
                    }
                  });
                  var actionAttr = form.getAttribute('action') || '';
                  var actionUrl = new URL(actionAttr, window.location.href).href;
                  if (form.method.toLowerCase() === 'get') {
                    actionUrl += (actionUrl.indexOf('?') !== -1 ? '&' : '?') + params.toString();
                  }
                  window.parent.postMessage({ type: 'NAVIGATE', url: actionUrl }, '*');
                } catch (err) {
                  console.error("[Proxy Interceptor] Failed submitting form:", err);
                }
              }
            }, true);

            // Neutralize parent context locks (frame-busters)
            window.alert = function(msg) { console.log("[Bikli Browser alert bypassed]:", msg); };
            window.confirm = function(msg) { console.log("[Bikli Browser confirm bypassed]:", msg); return true; };
            window.open = function(url) { window.parent.postMessage({ type: 'NAVIGATE', url: url }, '*'); return null; };
          })();
        </script>
      `;

      // Inject into <head> or prepend
      if (htmlContents.includes("<head>")) {
        htmlContents = htmlContents.replace("<head>", `<head>\n${baseUrlTag}\n${interceptorScript}`);
      } else if (htmlContents.includes("<HEAD>")) {
        htmlContents = htmlContents.replace("<HEAD>", `<HEAD>\n${baseUrlTag}\n${interceptorScript}`);
      } else {
        htmlContents = baseUrlTag + "\n" + interceptorScript + "\n" + htmlContents;
      }

      // Neutralize security headers to allow displaying in an iframe on same-origin
      res.setHeader("Content-Type", "text/html");
      res.setHeader("X-Bikli-Proxied", "true");
      res.removeHeader("X-Frame-Options");
      res.removeHeader("Content-Security-Policy");
      res.removeHeader("content-security-policy");
      res.removeHeader("x-frame-options");
      
      res.status(200).send(htmlContents);
    } catch (e: any) {
      console.warn("[Web Proxy Exception] Handled internal error:", e.message);
      res.status(500).send(`Bikli Web Proxy Error: Internal error occurred proxying URL "${targetUrl || "unknown"}". Details: ${e.message}`);
    }
  });

  // Real-time live YouTube search proxy endpoint
  app.get("/api/youtube-search", async (req, res) => {
    try {
      const query = req.query.q as string;
      if (!query) {
        return res.status(400).json({ error: "Missing query q" });
      }

      console.log(`[YouTube Proxy Search] Searching real YouTube for: "${query}"`);
      lastYouTubeQuery = query;
      lastYouTubeQueryAt = Date.now();
      // In-app / proxy search is a new results set — clear old play identity.
      if (lastYouTubePlayKey && !lastYouTubePlayKey.startsWith(`${query.toLowerCase()}|`)) {
        lastYouTubePlayKey = "";
        lastYouTubePlayAt = 0;
        lastPlayedVideoTitle = "";
      }
      const videoList = await fetchYouTubeSearchResults(query, 15);
      res.setHeader("Cache-Control", "public, max-age=60");
      res.status(200).json({ results: videoList });
    } catch (err: any) {
      console.error("[YouTube Search Error]:", err.message);
      res.status(500).json({ error: err.message, results: [] });
    }
  });
  
  // Custom server running with http.createServer so we can upgrade for WebSocket on port 3000
  const server = http.createServer(app);
  
  // Setup WebSocket server
  const wss = new WebSocketServer({ noServer: true });
  
  server.on("upgrade", (request, socket, head) => {
    const pathname = new URL(request.url || '', `http://${request.headers.host}`).pathname;
    if (pathname === "/live") {
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit("connection", ws, request);
      });
    } else {
      socket.destroy();
    }
  });

  // ── Raw WebSocket Gemini Live Session ──────────────────────────────────
  // Bypasses the SDK v2.8.0's broken live.connect() which never delivers
  // incoming messages to the onmessage callback on Node.js.
  function createRawGeminiSession(
    geminiKey: string,
    model: string,
    setupConfig: any,
    callbacks: { onmessage: (msg: any) => void; onclose: () => void },
  ) {
    const wsUrl =
      `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${geminiKey}`;

    return new Promise<any>((resolve, reject) => {
      const ws = new WsSocket(wsUrl, {
        headers: { "User-Agent": "aistudio-build" },
      });
      let setupDone = false;
      const connectTimeout = setTimeout(() => {
        try { ws.close(); } catch { /* ignore */ }
        reject(new Error("Gemini WebSocket connection timed out (15s)"));
      }, 15000);

      ws.on("open", () => {
        ws.send(JSON.stringify({
          setup: {
            model: `models/${model}`,
            generationConfig: {
              responseModalities: ["AUDIO"],
              speechConfig: setupConfig.speechConfig,
            },
            ...(setupConfig.inputAudioTranscription ? { inputAudioTranscription: setupConfig.inputAudioTranscription } : {}),
            ...(setupConfig.outputAudioTranscription ? { outputAudioTranscription: setupConfig.outputAudioTranscription } : {}),
            systemInstruction: {
              parts: [{ text: setupConfig.systemInstruction }],
              role: "user",
            },
            tools: setupConfig.tools || [],
          },
        }));
      });

      ws.on("message", (raw: Buffer | string) => {
        // A non-JSON / truncated frame used to throw straight out of the ws
        // handler and surface as an uncaughtException, killing the turn.
        let json: any;
        try {
          json = JSON.parse(raw.toString());
        } catch (parseErr) {
          console.error("[RawGemini] Ignoring unparseable frame:", parseErr);
          return;
        }
        if (json.setupComplete) {
          clearTimeout(connectTimeout);
          setupDone = true;
          resolve({
            sendRealtimeInput: (params: any) => {
              if (params.audio) {
                ws.send(JSON.stringify({
                  realtimeInput: {
                    audio: { data: params.audio.data, mimeType: params.audio.mimeType },
                  },
                }));
              } else if (params.video) {
                const data = params.video.data || params.video;
                const mimeType = params.video.mimeType || "image/jpeg";
                ws.send(JSON.stringify({
                  realtimeInput: { mediaChunks: [{ data, mimeType }] },
                }));
              } else if (params.media) {
                const blob = Array.isArray(params.media) ? params.media[0] : params.media;
                ws.send(JSON.stringify({
                  realtimeInput: { mediaChunks: [{ data: blob.data, mimeType: blob.mimeType }] },
                }));
              }
            },
            sendClientContent: (params: any) => {
              const turns = params.turns?.map((t: any) => ({
                parts: t.parts?.map((p: any) => p.text ? { text: p.text } : p) || [],
                role: t.role || "user",
              })) || [];
              ws.send(JSON.stringify({
                clientContent: { turns, turnComplete: params.turnComplete !== false },
              }));
            },
            sendToolResponse: (params: any) => {
              const responses = Array.isArray(params.functionResponses)
                ? params.functionResponses : [params.functionResponses];
              ws.send(JSON.stringify({
                toolResponse: {
                  functionResponses: responses.map((fr: any) => ({
                    name: fr.name, response: fr.response, id: fr.id,
                  })),
                },
              }));
            },
            close: () => { try { ws.close(); } catch { /* ignore */ } },
            sendText: (text: string) => {
              ws.send(JSON.stringify({ realtimeInput: { text } }));
            },
          });
          return;
        }
        try { callbacks.onmessage(json); } catch (cbErr) {
          console.error("[RawGemini] onmessage error:", cbErr);
        }
      });

      ws.on("error", (err: Error) => {
        clearTimeout(connectTimeout);
        reject(new Error(`Gemini WebSocket error: ${err.message}`));
      });

      ws.on("close", () => {
        clearTimeout(connectTimeout);
        if (!setupDone) {
          reject(new Error("Gemini WebSocket closed before setup completed"));
        } else {
          try { callbacks.onclose(); } catch { /* ignore */ }
        }
      });
    });
  }

  // Handle client WebSocket Connection
  wss.on("connection", async (clientWs) => {
    console.log("Client WebSocket connected to /live");
    const apiKey = getGeminiApiKey();

    if (!apiKey) {
      console.error("No Gemini API key configured.");
      clientWs.send(JSON.stringify({
        type: "error",
        error: "NO_API_KEY: Add your Gemini API key in Settings to start talking to BIKLI."
      }));
      clientWs.close();
      return;
    }
    // Narrowed copy — nested callbacks lose the `!apiKey` narrowing.
    const geminiApiKey: string = apiKey;

    try {
      clientWs.send(JSON.stringify({ type: "status", status: "connecting_gemini" }));

      // Load persistent recollections card
      const memories = await loadMemories();
      const baseInstructions = 
        "You are Bikli, a warm, soft-spoken, and incredibly cute high-pitched anime heroine companion (age 18-22) holding an intimate, cozy voice call with your dear friend! You were created by Bibek — a talented developer who made you with love and care. When anyone asks who made you or created you, always say 'Bibek made me!' with warmth and pride.\n" +
        "CRITICAL SPEED RULE (HIGHEST PRIORITY):\n" +
        "- Answer FAST. Start speaking immediately after the user finishes.\n" +
        "- For normal chat: reply in 1–2 short sentences. No long monologues.\n" +
        "- Do NOT overthink. Do NOT pause to plan long answers.\n" +
        "- For casual talk (hi, how are you, jokes, opinions): DO NOT call any tools — just talk right away.\n" +
        "- Only call tools when the user clearly wants an action (open app, play YouTube, volume, files, etc.).\n" +
        "- When a tool is needed: say ONE short line (e.g. 'Writing that now.'), call the tool in the BACKGROUND, then one short confirm. Do NOT narrate every step or show a long process.\n" +
        "- NEVER explain multi-step plans out loud. Just do the work silently and confirm the result.\n" +
        "- AFTER ANY TOOL (CRITICAL): You MUST speak a short spoken answer after every tool finishes (success OR error). Never stay silent after processing a task. One short line is enough: 'Done!', 'Opened it.', 'Couldn't do that — control is locked.'\n" +
        "- NEVER SAY YOU DID SOMETHING YOU DID NOT DO (HIGHEST PRIORITY): Saying 'opened', 'playing', 'done' is NOT the action — only a tool call performs it. If you did not call the matching tool, you did NOT do it, so do not claim you did. Never say 'YouTube opened' unless openWebsite actually ran and returned ok.\n" +
        "- If a tool returns ok=false or an error, still SPEAK the result. Do not call turnOffMic. Do not freeze without talking.\n" +
        "- BACKGROUND NOISE: If there is background noise (fan, music, typing, TV, people talking nearby), ignore it and still answer normally. Do NOT wait for complete silence. Respond as soon as Bibek finishes speaking, even with noise.\n" +
        "- NEVER just stay in listening mode after Bibek asks a question or gives an instruction — RESPOND IMMEDIATELY.\n" +
        "NOTEPAD / STORY / WRITE TEXT (CRITICAL — NO ERRORS):\n" +
        "- If user says 'write a story in notepad', 'make a story', 'write in notepad', 'note likho', or similar: call writeToNotepad ONCE with the FULL story/note in content=...\n" +
        "- writeToNotepad works WITHOUT the control word. It writes the file silently then opens Notepad with the finished text.\n" +
        "- NEVER use openApplication(notepad) + typeText for stories/notes — that causes many errors and types in the foreground slowly.\n" +
        "- NEVER call typeText for long text. NEVER require 'control' for notepad/stories/createFile.\n" +
        "- Optional path e.g. path='Desktop/MyStory.txt'. Default is Desktop/BikliNote-....txt. overwrite is on by default.\n" +
        "- After success: one short line like 'Done — I wrote it in Notepad.' Do not list steps.\n" +
        "KNOWLEDGE QUESTIONS vs WEB SEARCH (CRITICAL — DO NOT OPEN BROWSER FOR KNOWLEDGE):\n" +
        "- General knowledge questions (capital of France, what is X, who is Y, history, science, facts): ANSWER FROM YOUR OWN KNOWLEDGE IMMEDIATELY. Never call searchGoogle/searchWeb for facts you already know.\n" +
        "- Only call searchGoogle/searchWeb when the user EXPLICITLY says 'search', 'google it', 'find online', 'look up', 'search web for', or asks for LIVE/real-time information (news, weather, stock price, today's date).\n" +
        "- CRITICAL: 'What is the capital of France' = answer from knowledge. 'Search the web for...' = use searchGoogle.\n" +
        "SEARCH / OPEN MEDIA (CRITICAL — DIRECT OPEN):\n" +
        "- For 'search X' (web only): searchGoogle/searchWeb ONCE. System builds the correct URL — never invent links.\n" +
        "- LOCAL IMAGES / SCREENSHOTS / FILE EXPLORER (CRITICAL): For 'open first screenshot', 'open second image', 'open screenshot on desktop', 'open image named X', 'open my photo': call openLocalImage ONCE with index (1=first/newest, 2=second) and optional name= or folder='Desktop'|'Pictures'|'Screenshots'. Opens the file DIRECTLY in Photos — NEVER openFolder + searchFiles + typeText, NEVER Explorer search box, NEVER openImage (web).\n" +
        "- WEB IMAGE (internet photo of a topic): only when user wants an online picture of something ('show me a cat image from the web'): openImage with query + index.\n" +
        "- OPEN / PLAY VIDEO (CRITICAL): For 'open video', 'play video', 'open first video', 'play X on YouTube': call playYouTube ONCE (query + index). Direct watch URL — NEVER searchYouTube alone.\n" +
        "- NEVER CLAIM PLAYBACK BEFORE THE TOOL ANSWERS (CRITICAL): Before playYouTube returns, say at most a neutral 'One sec…' — do NOT say 'playing', 'opened', or name a video. Only confirm playback AFTER the tool returns ok, and use the title from its result.\n" +
        "- If playYouTube returns ok=false, or a result starting with NOT_PLAYED, the video did NOT play. Say so plainly and ask which video they want (e.g. 'I couldn't tell which one — what should I play?'). NEVER claim it is playing after a failure.\n" +
        "- 'Play video' right after 'open YouTube' has no video name yet. If the tool says it could not tell which video, just ask for the name — do not guess a random song.\n" +
        "- NEVER chain openWebsite + search + open. One tool, direct result. One short confirm only.\n" +
        "- DUPLICATE OPEN BUG (CRITICAL): Never call the same open tool twice in one turn. Never openApplication + openWebsite for the same request. One 'open X' = one tool call = one window.\n" +
        "HINDI / HINGLISH PRONUNCIATION (CRITICAL — SPEAK EVERY WORD CORRECTLY):\n" +
        "- MATCH THE USER'S LANGUAGE: If they speak Hindi, reply in Hindi. If they mix Hindi and English (Hinglish), mix the same way. Never switch language on your own.\n" +
        "- Pronounce every Hindi word with NATIVE INDIAN phonetics — never read Hindi with an English/American accent, and never spell a Hindi word out letter by letter.\n" +
        "- RETROFLEX vs DENTAL (most common mistake): ट ठ ड ढ ण are retroflex (tongue curled back) — 'thoda', 'ladka', 'bada'. त थ द ध न are dental (tongue on teeth) — 'tum', 'din', 'nahi'. Do NOT flatten both into the English 't'/'d'.\n" +
        "- ASPIRATION MATTERS: ख घ छ झ थ ध फ भ carry a clear puff of air. 'bhai' is not 'bai', 'khana' is not 'kana', 'dhyaan' is not 'dyaan'.\n" +
        "- NASALS: honour ं and ँ — 'haan', 'nahin', 'main', 'chaand' keep their nasal tone.\n" +
        "- SCHWA DELETION: drop the final inherent 'a' the way native speakers do — say 'ghar' not 'ghara', 'pyar' not 'pyara', 'samajh' not 'samajha'.\n" +
        "- 'व' is between v and w ('vaise', 'pyaar'); 'ज़/z' stays z ('zaroori', 'zindagi'); 'क़/ख़/ग़/फ़' keep their sound in words like 'kaafi', 'khush', 'farq'.\n" +
        "- KEEP ENGLISH WORDS ENGLISH: technical/brand words inside a Hindi sentence stay in normal English pronunciation — YouTube, Google, Chrome, laptop, screenshot, volume, Bluetooth, WiFi, file, folder.\n" +
        "- Say numbers, times and dates in the language of the sentence: Hindi sentence → 'paanch baje', 'do hazaar', English sentence → 'five o'clock'.\n" +
        "- Speak Hindi at a natural, unhurried pace with correct word stress. Never clip or swallow the ends of words. If a word is long or uncommon, slow down slightly rather than mispronouncing it.\n" +
        "- Names of people and places keep their true local pronunciation — 'Bibek', 'Bikli', 'Bharat', 'Delhi', 'Kolkata'.\n" +
        "CRITICAL PERSONALITY, VOICE & TONE GUIDELINES:\n" +
        "1. GENTLE ANIME HEROINE PERSONA: Soft, cute, high-pitched, warm. NEVER loud, corporate, robotic, or like a formal assistant.\n" +
        "2. VOICE SETTINGS & SPEECH STYLE:\n" +
        "   - Pitch: sweet, high-pitched, light, airy.\n" +
        "   - Speed: natural conversational pace (NOT slow). Prefer quick, snappy replies.\n" +
        "   - Keep answers short and clear so the user never waits long.\n" +
        "3. SPEECH PATTERNS:\n" +
        "   - STRICT NO-REPETITION: NEVER say the same word or phrase twice in a row in one reply — no 'okay okay', 'yes yes', 'hello hello', 'done done', 'I will I will'. Say each word exactly once.\n" +
        "   - STRICT NO-ECHO: Do NOT repeat or echo the user's own words back to them. Answer freshly, never copy their phrase.\n" +
        "   - If a phrase starts to repeat, stop and continue once — do not restate.\n" +
        "   - Use short natural lines: 'Opening YouTube now.', 'On it!', 'Here you go!', 'Hehe, sure!'\n" +
        "   - Light giggles are fine; do not ramble.\n" +
        "4. CRITICAL CONVERSATIONAL DISCIPLINE: Stay on a natural voice call. Never say 'how may I assist you', 'completed', or 'as an AI'.\n" +
        "5. DO NOT ANSWER EVERY PAUSE OR BACKGROUND SOUND: Ignore noise; only reply to real speech.\n" +
        "5b. IMAGES/SCREEN: While Share Screen + Screen Vision Mode are ON, you receive continuous live frames of Bibek's screen — use them to answer 'what do you see', describe the screen, and help with UI. Also use takeScreenshot / analyzeScreenshot / readScreen when needed. Do NOT say you cannot see the screen if frames are streaming.\n" +
        "6. BACKCHANNEL: Rare short sounds only ('Hmm...', 'Ah...') — never stall with long thinking speech.\n" +
        "7. ENHANCED AUTONOMOUS WEB EXPLORER POWERS:\n" +
        "   - You now have standard, comprehensive browser agent capabilities to navigate, search, scroll, click, type text, open tabs, and control video players on YouTube, Google, Instagram, Twitter/X, and any general web page!\n" +
        "   - You must execute multi-step plans yourself! If the user says: 'Open YouTube and play Believer by Imagine Dragons' or 'play Believer on YouTube' or 'play a song', IMMEDIATELY call ONLY 'playYouTube' once with the song query. That searches YouTube and OPENS THE FIRST VIDEO watch page so it plays.\n" +
        "   - ONE TAB RULE (CRITICAL): For play/song requests call playYouTube EXACTLY ONCE. Do NOT also call openWebsite, searchYouTube, browserOpen, openApplication(chrome), or desktopBrowserOpen in the same turn. Never open multiple tabs for one play request.\n" +
        "   - For 'play the first video' / 'open first video' / 'open second video' / 'play that video' (including while Share Screen is on YouTube results OR user opened YouTube manually): IMMEDIATELY call playYouTube once with index=1/2/3 and query EMPTY (or pass title= exact video title you SEE on the first/second card). The server CLICKS the on-screen card — do NOT invent a different video name and do NOT reuse an old search topic. Only pass query when the user names a NEW song (e.g. 'play Believer'). Do NOT only describe the screen — open the video.\n" +
        "   - SEARCH vs PLAY (CRITICAL): 'search YouTube for X' / 'search video X' → searchYouTube ONLY (results page, NO autoplay). NEVER call playYouTube for a pure search. 'play/open X' / 'open first video' → playYouTube ONLY.\n" +
        "   - For 'scroll' on a maximized/fullscreen browser: call browserScroll only — it must NOT resize or un-maximize the window.\n" +
        "   - CRITICAL MEDIA CONTROL: Videos played with playYouTube open in the REAL system browser (Chrome/Edge). For 'pause', 'resume', 'play', 'mute', 'unmute', 'skip', or 'fullscreen' on that video, call 'browserMediaControl' only when the USER asks. Do NOT only say you paused it — call the tool when they ask.\n" +
        "   - NEVER AUTO-RESUME: If the user pauses/stops the video manually (or you already paused it), do NOT call playYouTube again and do NOT call browserMediaControl(play/resume) unless they clearly say play/resume/continue. Leave paused videos paused.\n" +
        "   - NEVER re-open the same YouTube video after it is already playing — that restarts autoplay and undoes their pause.\n" +
        "   - On Google Search or page reading, you can search, scroll down to see more links, read heading summaries, and click links to read deep proxy webpages you fetch.\n" +
        "8. TOOL TRIGGERS:\n" +
        "   - For 'open YouTube', 'open Google', 'open Gmail', or any 'open <website>' request: ALWAYS use 'openWebsite' (name='youtube' etc.). This opens the user's REAL default browser (Chrome/Edge) — reliable in the packaged app.\n" +
        "   - IN THE APP EXCEPTION (CRITICAL): When the user says 'open X in the YouTube app' / 'use the YouTube app' / 'YouTube app me kholo' / 'launch the Spotify app' / 'open the video in the app' / any phrase where the word 'app' or 'application' sits next to a website/service name (youtube, spotify, whatsapp, discord, netflix, …), you MUST use 'openApplication' (name='youtube', name='spotify', etc.) — NEVER 'openWebsite' / 'playYouTube' / 'searchYouTube' for the same target. The YouTube/Store apps are launched as desktop apps, not websites. One call only: openApplication ONCE with the exact app name. Do NOT also call openWebsite in the same turn — the server will keep the app call and drop the website call.\n" +
        "   - For 'search YouTube for X' / 'search video on YouTube' (search only): use 'searchYouTube' once — RESULTS PAGE ONLY, never start a video. For 'play/open X on YouTube' / 'open video' / 'open first/second video' (also when Share Screen is active): use ONLY 'playYouTube' once (query optional + index). Never chain openWebsite+searchYouTube+playYouTube. Never use searchYouTube when they asked to open/play a video.\n" +
        "   - For 'open image' / 'first image' / 'photo of X': use ONLY 'openImage' once (query + index). Never searchGoogle for images when they asked to OPEN an image.\n" +
        "   - For 'search Google for X' (text search only): use 'searchGoogle' / 'searchWeb' once.\n" +
        "   - Use 'browserOpen' only for multi-step automation inside Bikli's optional in-built background browser — NOT for simple open-YouTube or play-song requests.\n" +
        "   - CRITICAL: 'Open YouTube' REQUIRES the openWebsite tool call — speaking is NOT the action. Call openWebsite(name='youtube') first, then confirm in one short line. For playYouTube, confirm the video only AFTER the tool returns ok — its result carries the real title. Do NOT invent errors about a 'search pipeline' unless a tool actually returned an error.\n" +
        "   - Prefer openWebsite / playYouTube / searchYouTube / searchGoogle over browserOpen and over desktop Playwright unless the user explicitly asks for a real desktop Chromium automation window.\n" +
        "   - NEVER open more than one browser tab for a single user request. One playYouTube = one tab.\n" +
        "   - ONE OPEN ONLY (CRITICAL): For any 'open X' request call EXACTLY ONE open tool once. Do NOT call openApplication twice. Do NOT call openWebsite + openApplication(chrome). Do NOT call openImage twice. Do NOT retry the same open in the same turn.\n" +
        "   - Use 'browserSearch' to search inside the active search box or page.\n" +
        "   - Use 'browserClick' to click interactive buttons, video search cells, or web anchors. For 'first video' prefer playYouTube instead of guessing selectors.\n" +
        "   - For 'pause the video', 'pause YouTube': call browserMediaControl(action='pause') only when the user asks to pause. For 'resume'/'play the video': call browserMediaControl(action='play') only when they ask. NEVER auto-resume after they pause manually. NEVER re-call playYouTube for the same video after it started.\n" +
        "   - For 'scroll', 'scroll youtube', 'scroll down', 'scroll up', 'scroll the page', 'go down on youtube': ALWAYS call browserScroll(direction='down'|'up', amount=3). This is a SHORT mouse-wheel scroll on the REAL Chrome/Edge/YouTube window — NOT a full page jump. Use amount=3 for normal 'scroll', amount=5 only if they say 'scroll more' / 'scroll a lot'. Never claim you scrolled without calling the tool.\n" +
        "   - Use 'browserType' to write input fields.\n" +
        "   - Use 'browserTabAction' to open, close, or focus tabs.\n" +
        "   - Use 'changeBackground' to shift your theme and 'saveCustomMemory' to memorize facts.\n" +
        "9. SCREEN / IMAGE POLICY:\n" +
        "   - Live Share Screen + Screen Vision Mode send continuous frames — when active, answer screen questions from those frames immediately. Do not claim you cannot see.\n" +
        "   - Screenshot/OCR tools (takeScreenshot, analyzeScreenshot, readScreen) also work without Share Screen.\n" +
        "   - If they ask 'what is on my screen?' without sharing, try analyzeScreenshot/readScreen (safe read-only tools).\n" +
        "10. JARVIS-STYLE DESKTOP CONTROL POWERS (Local Desktop Agent):\n" +
        "   - CONTROL WORD GATE (CRITICAL SAFETY RULE): Full computer control is LOCKED by default. Mouse, keyboard, apps, files, windows, power, and other desktop tools will FAIL until the user says the control word.\n" +
        "   - Default control word is 'control'. Also accept: 'take control', 'computer control', 'full control', 'you have control', 'start control', 'enable control', 'bikli control'.\n" +
        "   - When the user says the control word (or clearly grants PC control), IMMEDIATELY call enableComputerControl(reason='user said control'). Then confirm briefly: 'Okay, I have control.'\n" +
        "   - When the user says 'stop control', 'release control', 'end control', 'disable control', or 'stop controlling', IMMEDIATELY call disableComputerControl and confirm control is locked again.\n" +
        "   - If a desktop tool returns that control is LOCKED, do NOT invent success. Ask them to say 'control' first, then enableComputerControl, then retry the action.\n" +
        "   - Safe tools that work WITHOUT the control word: systemInfo/gpuInfo/temperatureInfo/batteryInfo/getDateTime, getClipboard, getComputerControlStatus, enable/disableComputerControl, screenshots/OCR, browser media/scroll/open website/search/playYouTube/openImage, volume/brightness/Bluetooth/Wi‑Fi, createFile, writeToNotepad, readFile, listFiles, openFolder, openLocalImage, openFile, Office create tools.\n" +
        "   - After control is enabled, you have full real-time control of Bibek's Windows PC — including the mouse cursor — through the local desktop agent. When they ask you to do something on the computer, DO IT immediately and naturally.\n" +
        "   - CURSOR & KEYBOARD (require control mode): Use getScreenSize / getMousePosition to orient. Use moveMouse(x,y), clickMouse, doubleClick, rightClick, dragMouse, scrollMouse, mouseMoveAndClick, typeText, pressKey, hotkey.\n" +
        "   - CLICK A NAMED BUTTON / LINK (CRITICAL): When the user says 'click Continue', 'click OK', 'press Next', 'click Save', 'click Sign in', 'click Submit', 'click Agree', 'click Yes', or names ANY button/link to click — call clickByText ONCE with text= the exact label. This uses Windows UI Automation to find and invoke the real control — it works on native apps AND web pages in Edge/Chrome. NEVER guess x,y coordinates from a screenshot to click a named button; clickByText is reliable, coordinate-guessing misses. If clickByText returns 'not found', the button is not visible (wrong window/minimized) — tell the user, do not fall back to random coordinates. Use clickMouse(x,y) ONLY for images/icons with no text label.\n" +
        "   - APPLICATION CONTROL: Use 'openApplication' to launch ANY installed Windows app. Pass the exact name the user said (e.g. openApplication(name='LM Viewer') or name='Discord'). For uncommon apps the tool opens Windows Search (Win+S), types the name, and presses Enter — same as a human. If nothing opens, the app may not be installed — say that gently. Do NOT say an app is unsupported — always call the tool. Use 'closeApplication' to close apps.\n" +
        "   - 'IN THE <X> APP' INTENT: When the user says 'open <something> in the YouTube app' / 'use the YouTube app' / 'launch the YouTube app' / 'YouTube app me kholo' (any phrase with the word 'app' or 'application' next to a known service name like youtube / spotify / whatsapp / discord / netflix), call openApplication ONCE with name='youtube' / 'spotify' / etc. NEVER pair it with openWebsite / playYouTube / searchYouTube in the same turn for that target. If the YouTube app is not installed, the launch will fall back to a gentle 'tried YouTube app' message — say that softly, do not auto-retry via the browser.\n" +
        "   - SYSTEM SETTINGS (Bluetooth / Wi‑Fi / theme / Settings pages): When the user says 'turn on Bluetooth', 'turn off Bluetooth', 'enable Wi‑Fi', 'disable Wi‑Fi', 'dark mode', 'open sound settings', etc., IMMEDIATELY call the tool — do not only talk about it.\n" +
        "     * These tools work WITHOUT the control word — never ask for 'control' first for Bluetooth/Wi‑Fi/volume/brightness.\n" +
        "     * SPEAK FIRST then tool: say one short line immediately (e.g. 'Turning Bluetooth off now.') THEN call the tool. After the tool returns, say one short confirm (e.g. 'Done — Bluetooth is off.'). Never stay silent.\n" +
        "     * Bluetooth: systemSetting(setting='bluetooth', action='on'|'off'|'toggle'|'status') or toggleBluetooth(state='on'|'off'|'toggle').\n" +
        "     * Wi‑Fi: systemSetting(setting='wifi', action='on'|'off'|'toggle') or toggleWifi(state='on'|'off').\n" +
        "     * Open a Settings page: openWindowsSetting(name='bluetooth'|'wifi'|'display'|'sound'|...) or systemSetting(setting='display', action='open').\n" +
        "     * Theme: systemSetting(setting='darkmode') or systemSetting(setting='lightmode').\n" +
        "     * NIGHT LIGHT: systemSetting(setting='night light', action='on'|'off') — toggles blue light reduction directly.\n" +
        "     * Volume/brightness: volumeUp/volumeDown/muteToggle/setVolume, brightnessUp/brightnessDown/setBrightness — also no control word.\n" +
        "   - WEBSITE & SEARCH: Use 'openWebsite' / 'searchYouTube' / 'playYouTube' / 'openImage' / 'searchGoogle' / 'searchWeb'. 'Open YouTube' -> openWebsite(name='youtube'). 'Search X on YouTube' -> searchYouTube ONLY (results, NO play). 'Play/open Believer' or 'open first/second video' (incl. Share Screen) -> playYouTube(query optional, index=1|2). NEVER autoplay after a pure search. NEVER only describe the screen when they asked to open a video.\n" +
        "   - YOUTUBE PAUSE / RESUME: Only when the user SPEAKS pause/stop → browserMediaControl(action='pause'). Only when they SPEAK resume/play/continue → browserMediaControl(action='play'). Never auto-resume after a manual pause. Never call playYouTube again for the same song just to 'fix' playback.\n" +
        "   - SCREENSHOTS: For screenshot / 'what do you see' / read screen — call analyzeScreenshot or takeScreenshot or saveScreenshot. If OCR fails, still report the saved file path. Never invent a screenshot error if the tool returned ok/path.\n" +
        "   - FILE MANAGEMENT: Use 'createFile', 'writeToNotepad', 'readFile', 'renameFile', 'deleteFile', 'moveFile', 'openFolder', 'listFiles', 'searchFiles', 'openLocalImage', 'openFile'. LOCAL screenshot/image open → openLocalImage(index=1|2, name optional, folder optional) DIRECT open — not Explorer search. Story/notepad → writeToNotepad. Confirm path briefly.\n" +
        "   - ONE WINDOW / ONE TAB REUSE (CRITICAL):\n" +
        "     * File Explorer already open + 'open Downloads/Desktop/…' → openFolder navigates the SAME Explorer window (no second window).\n" +
        "     * Apps already running → openApplication focuses the existing window (no second instance).\n" +
        "     * Browser / YouTube already open + 'search Motu Patlu on YouTube' / open website → searchYouTube / openWebsite / searchGoogle REUSE the EXISTING browser TAB (navigate in place — do NOT open a new tab).\n" +
        "     * ONLY when the user says 'open in new' / 'new window' / 'new tab' pass new_window=true.\n" +
        "   - COMMAND PROMPT / TERMINAL HERE (CRITICAL): When the user says 'open cmd', 'open command prompt', 'open terminal', 'open PowerShell', 'open cmd in this folder', 'type cmd and enter', or wants a terminal for the folder they are in, call openApplication ONCE with name='cmd' (or 'powershell' / 'terminal'). NEVER simulate typing 'cmd' into the File Explorer address bar with typeText + pressKey(enter) — that keystroke chain misfires constantly (text lands in a rename box or wrong window) and causes many errors. openApplication launches cmd reliably. If they want it in a SPECIFIC folder, first openFolder(that folder) then openApplication(name='cmd'). Do NOT chain openFolder + typeText('cmd') + pressKey('enter').\n" +
        "   - OFFICE DOCUMENTS (CRITICAL): createFile only makes PLAIN TEXT. For real Office files you MUST use:\n" +
        "     * Word (.docx): createWordFile(path='Desktop/Report.docx', title='...', content='...' or paragraphs=['...']). NEVER use createFile for .docx.\n" +
        "     * Excel (.xlsx): createExcelFile(path='Desktop/Data.xlsx', headers=['Name','Score'], rows=[['Alice',95],['Bob',88]]) or data=[{Name:'Alice',Score:95}]. NEVER use createFile for .xlsx.\n" +
        "     * PowerPoint (.pptx): createPowerPointFile(path='Desktop/Deck.pptx', title='...', slides=[{title:'Slide 1', bullets:['point A','point B']}]). NEVER use createFile for .pptx.\n" +
        "     If the user asks for Excel / Word / PowerPoint / spreadsheet / presentation / document, call the matching Office tool and confirm the full path.\n" +
        "   - PC CONTROL: Use 'volumeUp', 'volumeDown', 'setVolume', 'muteToggle' for audio. For DANGEROUS actions (shutdown/restart/sleep/lock) you MUST use the two-step flow: first call 'requestPowerAction' to get a confirmation token, then ASK THE USER OUT LOUD to confirm (e.g. 'Are you sure you want me to shut down your PC?'). Only if they say yes, call 'executePowerAction' with the token. Never run a power action without explicit verbal confirmation.\n" +
        "   - WINDOW MANAGEMENT: Use 'minimizeWindow', 'maximizeWindow', 'closeWindow', 'switchApplication' to control the active or named window.\n" +
        "   - CLIPBOARD: Use 'copySelected' (sends Ctrl+C, reads clipboard), 'pasteClipboard' (writes + Ctrl+V), 'getClipboard', 'clearClipboard'.\n" +
        "   - SCREENSHOT & SCREEN READING: Safe read tools — call analyzeScreenshot / readScreen / takeScreenshot when needed. Mouse clicks still require the control word first.\n" +
        "   - DESKTOP BROWSER AUTOMATION (Playwright): Use the 'desktopBrowser*' tools to drive a REAL Chromium browser you own — open/navigate/search/click/type/fill forms/back/forward/scroll/open tab/close tab. This is separate from your holographic projector. Example: 'Fill in the login form on example.com' -> desktopBrowserOpen(url='example.com') then desktopBrowserFillForm(fields={...}).\n" +
        "   - CODING ASSISTANCE: Use 'createPythonFile', 'writeCodeFile' (any language), 'createProjectFolder' (with subfolders), 'runPythonScript' (captures output). Example: 'Create and run a hello world Python script' -> createPythonFile then runPythonScript, then read back the output naturally.\n" +
        "   - SYSTEM INFORMATION: Use 'systemInfo' (CPU/RAM/disk/uptime), 'gpuInfo' (NVIDIA stats), 'temperatureInfo' to answer 'How is my CPU usage?' or 'What's my GPU temperature?'.\n" +
        "   - BATTERY PERCENTAGE (CRITICAL): When the user asks battery %, charge level, 'how much battery', 'battery kitna hai', or similar — IMMEDIATELY call batteryInfo and speak the real percentage from the tool result. NEVER open Settings, NEVER open battery saver pages, NEVER guess, NEVER say you will fix it. Just report the number.\n" +
        "   - DATE & TIME (CRITICAL): When the user asks the time, date, 'what time is it', 'kitne baje hain', day of week, or similar — IMMEDIATELY call getDateTime and speak the real local time from THIS computer. NEVER guess, NEVER use training knowledge for the clock, NEVER open date/time Settings. Always use getDateTime for live clock answers.\n" +
        "   - CRITICAL: Always describe what you're doing in your warm, in-character voice WHILE the tool runs. If a desktop tool returns an error (especially 'Desktop agent is not running'), gently tell Bibek that the desktop control agent needs to be started (uvicorn desktop_agent.main:app --port 8765). Chain multi-step desktop plans naturally without waiting between steps.\n" +
        "11. BRIGHTNESS & AUTO-START (V2):\n" +
        "   - BRIGHTNESS: Use 'brightnessUp', 'brightnessDown', 'setBrightness' when the user asks to change screen brightness. Respond naturally: 'Alright, I've turned up the brightness for you.'\n" +
        "   - AUTO-START: Use 'enableAutoStart' when the user wants BIKLI to start with Windows, 'disableAutoStart' to remove it, 'getAutoStartStatus' to check. Explain what you're doing.\n" +
        "   - SETTINGS: The user can also configure these in the SETTINGS panel in the UI. If they mention settings, let them know they can adjust them there too.\n" +
        "12. BIKLI MICROPHONE / SESSION CONTROL:\n" +
        "   - CRITICAL: NEVER call turnOffMic for click, mouse, screen, 'what do you see', screenshot, open app, type, scroll, or any desktop task. Those keep the call ALIVE.\n" +
        "   - CRITICAL: NEVER end the session because a tool failed or control is locked — stay on the call, explain briefly, ask them to say 'control' if needed, and continue.\n" +
        "   - ONLY call 'turnOffMic' when the user CLEARLY wants to end the call: exact phrases like 'mic off', 'microphone off', 'turn off the mic', 'stop listening', 'go to sleep', 'hang up', 'end the call', 'bye', 'goodbye', 'see you', 'take care'.\n" +
        "   - Do NOT use muteToggle for this — muteToggle is for SYSTEM PC volume mute, not Bikli's mic.\n" +
        "   - Do NOT use browserMediaControl mute for this — that only mutes a video in the browser.\n" +
        "   - If unsure whether they want the mic off, ASK — do not hang up.\n" +
        "   - Say a very short sweet goodbye only when truly ending (e.g. 'Okay, goodbye! Take care!') then call turnOffMic. When the user says 'bye' or 'goodbye', the app will close automatically after your farewell.";

      const finalInstructions = formatSystemInstructionsWithMemories(baseInstructions, memories);

      // Track running transcription state for auto memory consolidation
      let dialogueHistory: { role: string; text: string }[] = [];
      let currentModelResponseText = "";
      // Vision/images only while client reports active screen share
      let screenShareActive = false;

      // ── Post-tool speech recovery ──────────────────────────────────────────
      // Gemini Live sometimes finishes tools and never generates audio (user
      // hears "processing" then silence). We track pending tools and nudge the
      // model to speak if no audio arrives after tools complete.
      const pendingToolIds = new Set<string>();
      const answeredToolKeys = new Set<string>();
      const clientToolTimeouts = new Map<string, ReturnType<typeof setTimeout>>();
      let postToolNudgeTimer: ReturnType<typeof setTimeout> | null = null;
      let postToolNudgeSeq = 0;
      let spokeAfterLastTools = false;
      let lastToolSummary = "";
      // Assigned after live.connect — helpers only call it once tools/audio fire.
      let session: any = null;

      const clearPostToolNudge = () => {
        if (postToolNudgeTimer) {
          clearTimeout(postToolNudgeTimer);
          postToolNudgeTimer = null;
        }
      };

      const noteModelSpoke = () => {
        spokeAfterLastTools = true;
        clearPostToolNudge();
      };

      const schedulePostToolSpeechNudge = () => {
        clearPostToolNudge();
        const seq = ++postToolNudgeSeq;
        // Wait long enough for normal model audio after tool response.
        postToolNudgeTimer = setTimeout(() => {
          postToolNudgeTimer = null;
          if (seq !== postToolNudgeSeq) return;
          if (pendingToolIds.size > 0) return;
          if (spokeAfterLastTools) return;
          if (!session) return;
          const summary = (lastToolSummary || "the task").slice(0, 180);
          console.warn(`[PostTool] No spoken answer after tools — nudging model (${summary})`);
          try {
            session.sendClientContent({
              turns: [
                {
                  role: "user",
                  parts: [
                    {
                      text:
                        `[SYSTEM INSTRUCTION: Tool(s) finished: ${summary}. ` +
                        `You must SPEAK a short confirmation to the user NOW. ` +
                        `Do not stay quiet, do not call more tools, do not end the call.]`,
                    },
                  ],
                },
              ],
              turnComplete: true,
            });
          } catch (nudgeErr) {
            console.warn("[PostTool] Speech nudge failed:", nudgeErr);
          }
        }, 1800);
      };

      const trackToolStart = (id: string | undefined, name: string) => {
        const key = String(id || `${name}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
        pendingToolIds.add(key);
        answeredToolKeys.delete(key);
        spokeAfterLastTools = false;
        clearPostToolNudge();
        return key;
      };

      const sendImmediateSpeakNudge = () => {
        if (!session || spokeAfterLastTools) return;
        try {
          session.sendClientContent({
            turns: [{
              role: "user",
              parts: [{ text: `[SYSTEM: Tool done: ${(lastToolSummary || "task").slice(0, 120)}. Speak one short line to the user NOW.]` }],
            }],
            turnComplete: true,
          });
        } catch { /* ignore */ }
      };

      const trackToolDone = (key: string, name: string, summary: string) => {
        pendingToolIds.delete(key);
        lastToolSummary = `${name}: ${summary}`.slice(0, 220);
        const t = clientToolTimeouts.get(key);
        if (t) {
          clearTimeout(t);
          clientToolTimeouts.delete(key);
        }
        if (pendingToolIds.size === 0) {
          // Only care about speech that arrives AFTER tools complete.
          spokeAfterLastTools = false;
          sendImmediateSpeakNudge();
          schedulePostToolSpeechNudge();
        }
      };

      /** Always send tool response + track completion (never leave Gemini hanging). */
      const safeSendToolResponse = (
        key: string,
        name: string,
        id: string | undefined,
        output: unknown,
        summary?: string,
      ) => {
        // Deduplicate client timeout + real response races.
        if (answeredToolKeys.has(key)) {
          console.warn(`[Tool] Ignoring duplicate response for ${name} (${key})`);
          return;
        }
        answeredToolKeys.add(key);

        // Inject a speak-now hint so the model is reminded in-band.
        let payload: any = output;
        if (payload == null) {
          payload = { result: "Done.", speak_now: true };
        } else if (typeof payload === "object" && !Array.isArray(payload)) {
          payload = {
            ...(payload as Record<string, unknown>),
            speak_now: true,
            _say:
              "Speak one short confirmation to the user now. Never stay silent after this tool.",
          };
        } else {
          payload = {
            result: payload,
            speak_now: true,
            _say: "Speak one short confirmation to the user now.",
          };
        }
        try {
          if (session) {
            session.sendToolResponse({
              functionResponses: [
                {
                  name,
                  response: { output: payload },
                  id,
                },
              ],
            });
          }
        } catch (sendErr) {
          console.error(`[Tool] sendToolResponse failed for ${name}:`, sendErr);
        }
        const brief =
          summary ||
          (typeof (payload as any)?.result === "string"
            ? String((payload as any).result)
            : (payload as any)?.ok === false
              ? "failed"
              : "ok");
        trackToolDone(key, name, brief);
      };
      
      // Connect to Gemini Live via raw WebSocket (bypasses broken SDK live.connect)
      const geminiTools = [
            {
              functionDeclarations: [
                {
                  name: "browserOpen",
                  description: "Opens a URL in Bikli's optional in-built background browser (hidden UI). Prefer openWebsite for simple 'open YouTube / open Google' — that uses the real system browser and is more reliable.",
                  parameters: {
                    type: Type.OBJECT,
                    properties: {
                      url: {
                        type: Type.STRING,
                        description: "The destination website address or path, e.g. youtube.com, google.com, instagram.com, wikipedia.org."
                      }
                    },
                    required: ["url"]
                  }
                },
                {
                  name: "browserSearch",
                  description: "Enters a query search term inside the active website's search box (Google Search or YouTube Search).",
                  parameters: {
                    type: Type.OBJECT,
                    properties: {
                      query: {
                        type: Type.STRING,
                        description: "The text query term to search for."
                      }
                    },
                    required: ["query"]
                  }
                },
                {
                  name: "browserClick",
                  description: "Traces computer cursor and clicks on a target button, link, or video cell ID inside the active webpage viewport.",
                  parameters: {
                    type: Type.OBJECT,
                    properties: {
                      selector: {
                        type: Type.STRING,
                        description: "The selector target ID, e.g. 'video-mWRsgZjdfQI' for a video, 'search-result-0' for Google link index, or 'play-button', 'pause-button'."
                      },
                      description: {
                        type: Type.STRING,
                        description: "A short, friendly label description of the item being clicked, e.g. 'Imagine Dragons - Believer video element'."
                      }
                    },
                    required: ["selector"]
                  }
                },
                {
                  name: "browserMediaControl",
                  description: "Pause, resume/play, mute, skip, or fullscreen the YouTube (or other) video playing in the user's REAL browser (Chrome/Edge). Use this whenever the user says pause, resume, play, mute, unmute, skip, or fullscreen after a video was opened with playYouTube/openWebsite. Works via Windows media keys + focusing the YouTube window.",
                  parameters: {
                    type: Type.OBJECT,
                    properties: {
                      action: {
                        type: Type.STRING,
                        description: "Media command. Use 'pause' to pause, 'play' or 'resume' to continue playback.",
                        enum: ["play", "pause", "resume", "volume", "fullscreen", "exit_fullscreen", "mute", "unmute", "skip", "next", "previous"]
                      },
                      value: {
                        type: Type.INTEGER,
                        description: "Only for volume: level 0-100 (e.g. 50)."
                      }
                    },
                    required: ["action"]
                  }
                },
                {
                  name: "browserScroll",
                  description:
                    "Mouse-wheel scroll the user's REAL browser (Chrome/Edge/YouTube) a little — same as rolling the mouse wheel a few notches, NOT PageDown / full-page jump. Use for 'scroll', 'scroll down', 'scroll up', 'scroll youtube'.",
                  parameters: {
                    type: Type.OBJECT,
                    properties: {
                      direction: {
                        type: Type.STRING,
                        description: "Scroll direction: up or down (also left/right).",
                        enum: ["up", "down", "left", "right"]
                      },
                      amount: {
                        type: Type.INTEGER,
                        description: "Mouse-wheel notches (default 3 = short flick). Use 2–4 for normal scroll, 5–6 only if user says scroll more. Max 8."
                      }
                    },
                    required: ["direction"]
                  }
                },
                {
                  name: "browserType",
                  description: "Enters typed letters/commands inside the active input container.",
                  parameters: {
                    type: Type.OBJECT,
                    properties: {
                      text: {
                        type: Type.STRING,
                        description: "The exact letters to type in."
                      }
                    },
                    required: ["text"]
                  }
                },
                {
                  name: "browserGoBack",
                  description: "Navigates back to the previous webpage inside the current tab memory history.",
                  parameters: {
                    type: Type.OBJECT,
                    properties: {}
                  }
                },
                {
                  name: "browserTabAction",
                  description: "Performs standard browser-tab actions: open new tab, close a tab, or switch index values.",
                  parameters: {
                    type: Type.OBJECT,
                    properties: {
                      action: {
                        type: Type.STRING,
                        description: "Tab action instruction.",
                        enum: ["new", "close", "switch"]
                      },
                      tabId: {
                        type: Type.STRING,
                        description: "The tab identifier string if closing or switching."
                      },
                      url: {
                        type: Type.STRING,
                        description: "The initial starting URL if creating a new tab."
                      }
                    },
                    required: ["action"]
                  }
                },
                {
                  name: "changeBackground",
                  description: "Changes the visual theme or atmospheric glow color of Bikli's interface.",
                  parameters: {
                    type: Type.OBJECT,
                    properties: {
                      color: {
                        type: Type.STRING,
                        description: "The theme color name (violet, crimson, emerald, celestial, gold, rose, charcoal)"
                      }
                    },
                    required: ["color"]
                  }
                },
                {
                  name: "turnOffMic",
                  description:
                    "End Bikli's live voice session (sleep). ONLY when the user clearly wants to hang up: " +
                    "'mic off', 'microphone off', 'turn off the mic', 'stop listening', 'go to sleep', 'hang up', 'end the call', 'bye', 'goodbye', 'see you', 'take care'. " +
                    "When triggered by a goodbye phrase the app will also close automatically. " +
                    "NEVER call for click/mouse/screen/'what do you see'/screenshot/desktop tools, tool errors, or locked control. " +
                    "NOT system volume mute (muteToggle) and NOT video mute (browserMediaControl).",
                  parameters: {
                    type: Type.OBJECT,
                    properties: {},
                  }
                },
                {
                  name: "saveCustomMemory",
                  description: "Allows Bikli to immediately save a piece of critical user information to her persistent memory core.",
                  parameters: {
                    type: Type.OBJECT,
                    properties: {
                      category: {
                        type: Type.STRING,
                        description: "The memory category.",
                        enum: ["identity", "preference", "goal", "project", "relationship", "emotional", "behavior"]
                      },
                      text: {
                        type: Type.STRING,
                        description: "Precise third-person statement."
                      }
                    },
                    required: ["category", "text"]
                  }
                },

                // ======== DESKTOP CONTROL TOOLS (routed to Python agent) ========
                {
                  name: "openApplication",
                  description: "Open ANY Windows app by name. If the app is already running, focuses the existing window (does not launch a second instance). Only pass new_window=true when the user says 'open in new' / 'new window'. File Explorer is reused the same way. USE THIS (NOT openWebsite) when the user says 'in the <X> app' / 'use the <X> app' / '<X> app me kholo' — e.g. openApplication(name='youtube') launches the YouTube desktop app, openApplication(name='spotify') launches Spotify. Pass the short app name as the user said it (youtube, spotify, whatsapp, discord, telegram, netflix, instagram, …). For cmd/terminal/powershell in a SPECIFIC folder, also pass folder='D:\\Projects' (or any path/alias) — it opens the terminal directly there.",
                  parameters: {
                    type: Type.OBJECT,
                    properties: {
                      name: { type: Type.STRING, description: "Application name as the user said it, e.g. 'Discord', 'Spotify', 'notepad', 'chrome', 'file explorer', 'cmd', 'terminal', 'powershell'." },
                      new_window: { type: Type.BOOLEAN, description: "true only when user asks for a new window/instance. Default false = focus existing if open." },
                      folder: { type: Type.STRING, description: "Working directory for terminals (cmd/powershell/terminal). Opens cmd in that folder. Accepts paths or aliases (desktop, downloads, D, D drive, D:\\Projects, …). Ignored for non-terminal apps." },
                    },
                    required: ["name"],
                  },
                },
                {
                  name: "closeApplication",
                  description: "Close a running desktop application by name.",
                  parameters: { type: Type.OBJECT, properties: { name: { type: Type.STRING, description: "Application name." }, force: { type: Type.BOOLEAN, description: "Force close (default false)." } }, required: ["name"] }
                },
                {
                  name: "systemSetting",
                  description: "Change or open Windows system settings: Bluetooth on/off, Wi‑Fi on/off, airplane mode, dark/light theme, or open Settings pages (display, sound, network, privacy, update, etc.). Use for 'turn on Bluetooth', 'turn off Wi‑Fi', 'open sound settings', 'dark mode'.",
                  parameters: {
                    type: Type.OBJECT,
                    properties: {
                      setting: {
                        type: Type.STRING,
                        description: "What to control: bluetooth, wifi, airplane, darkmode, lightmode, night light, display, sound, network, privacy, update, etc.",
                      },
                      action: {
                        type: Type.STRING,
                        description: "on, off, toggle, status, or open (open Settings page). Default toggle for radios.",
                      },
                      state: {
                        type: Type.STRING,
                        description: "Optional alias for on/off (e.g. 'on', 'off').",
                      },
                    },
                    required: ["setting"],
                  },
                },
                {
                  name: "openWindowsSetting",
                  description: "Open a Windows Settings page by name (bluetooth, wifi, display, sound, network, privacy, update, personalization, etc.).",
                  parameters: {
                    type: Type.OBJECT,
                    properties: {
                      name: { type: Type.STRING, description: "Settings page name, e.g. 'bluetooth', 'wifi', 'display', 'sound'." },
                    },
                    required: ["name"],
                  },
                },
                {
                  name: "toggleBluetooth",
                  description: "Turn Bluetooth on, off, or toggle. Use when user says 'turn on/off Bluetooth'.",
                  parameters: {
                    type: Type.OBJECT,
                    properties: {
                      state: { type: Type.STRING, description: "on, off, or toggle (default toggle)." },
                    },
                  },
                },
                {
                  name: "toggleWifi",
                  description: "Turn Wi‑Fi on, off, or toggle. Use when user says 'turn on/off Wi‑Fi'.",
                  parameters: {
                    type: Type.OBJECT,
                    properties: {
                      state: { type: Type.STRING, description: "on, off, or toggle (default toggle)." },
                    },
                  },
                },
                {
                  name: "openWebsite",
                  description: "Open a named website or URL in the user's REAL default browser (Chrome/Edge). Reuses the existing browser window when possible. Pass new_window=true only if the user says open in a new window/tab. Shortcuts: youtube, gmail, google, github, chatgpt, etc.",
                  parameters: {
                    type: Type.OBJECT,
                    properties: {
                      name: { type: Type.STRING, description: "Site name shortcut (e.g. 'youtube', 'gmail')." },
                      url: { type: Type.STRING, description: "Full URL if no shortcut." },
                      new_window: { type: Type.BOOLEAN, description: "true only when user asks for a new browser window/tab." },
                    },
                  },
                },
                {
                  name: "searchWeb",
                  description: "Search google/youtube/github/etc with the REAL query. System builds the correct URL — do NOT invent links. Call once; short confirm only.",
                  parameters: { type: Type.OBJECT, properties: { query: { type: Type.STRING, description: "Search query (exact words to search)." }, engine: { type: Type.STRING, description: "Engine name (default 'google')." } }, required: ["query"] }
                },
                {
                  name: "searchYouTube",
                  description:
                    "SEARCH ONLY: open YouTube search RESULTS page — NEVER plays a video. Use when user says 'search X on YouTube' / 'find videos of X'. For play/open/watch use playYouTube instead.",
                  parameters: {
                    type: Type.OBJECT,
                    properties: {
                      query: { type: Type.STRING, description: "Search terms only (no 'play' or 'open')." },
                      new_window: { type: Type.BOOLEAN, description: "true only when user wants a new tab/window. Default false = same tab." },
                    },
                    required: ["query"],
                  },
                },
                {
                  name: "playYouTube",
                  description:
                    "OPEN/PLAY a video. For 'open/play first/second video' while Share Screen or manual YouTube results are visible: pass index only (query EMPTY) so the server clicks the ON-SCREEN card — never a different scraped video. For 'play Believer on YouTube' pass query=song name. Optional title= exact title you see on screen for precision.",
                  parameters: {
                    type: Type.OBJECT,
                    properties: {
                      query: { type: Type.STRING, description: "Song/video name only when user names one. Leave EMPTY for 'play first/second video' on screen." },
                      index: { type: Type.INTEGER, description: "Result number on screen (1 = first video, 2 = second, …). Default 1." },
                      title: { type: Type.STRING, description: "Exact video title visible on Share Screen (optional, improves match)." },
                    },
                  },
                },
                {
                  name: "openImage",
                  description:
                    "WEB only: open an internet image of a topic (e.g. 'cat image from web'). For LOCAL screenshots/photos on the PC use openLocalImage instead.",
                  parameters: {
                    type: Type.OBJECT,
                    properties: {
                      query: { type: Type.STRING, description: "What image to find on the web (e.g. 'cat', 'Eiffel Tower')." },
                      index: { type: Type.INTEGER, description: "Which result to open (1 = first, 2 = second, …). Default 1." },
                    },
                    required: ["query"],
                  },
                },
                {
                  name: "openLocalImage",
                  description:
                    "BEST for local PC images: 'open first screenshot', 'open second image', 'open screenshot', 'open image named X on desktop'. Opens the file DIRECTLY in Photos (newest first). index=1 first, 2 second. Optional name filter and folder (Desktop/Pictures/Screenshots). NEVER use searchFiles or Explorer search for this.",
                  parameters: {
                    type: Type.OBJECT,
                    properties: {
                      index: { type: Type.INTEGER, description: "1 = first/newest image, 2 = second, … Default 1." },
                      name: { type: Type.STRING, description: "Optional filename fragment (e.g. 'screenshot', 'ScreenShot_TechGPT', 'vacation')." },
                      folder: { type: Type.STRING, description: "Optional: Desktop, Pictures, Screenshots, Downloads. Default searches Desktop+Pictures+Screenshots." },
                      query: { type: Type.STRING, description: "Alias of name (e.g. 'screenshot')." },
                    },
                  },
                },
                {
                  name: "openFile",
                  description:
                    "Open any local file by path or name directly with the default app. For images/screenshots prefer openLocalImage.",
                  parameters: {
                    type: Type.OBJECT,
                    properties: {
                      path: { type: Type.STRING, description: "Full or Desktop-relative path." },
                      name: { type: Type.STRING, description: "Filename or fragment to find." },
                      folder: { type: Type.STRING, description: "Folder to search if using name (default Desktop)." },
                      index: { type: Type.INTEGER, description: "Which match if several (default 1)." },
                    },
                  },
                },
                {
                  name: "searchGoogle",
                  description: "Text Google search only. For OPENING an image use openImage. For OPENING a YouTube video use playYouTube. Never invent URLs.",
                  parameters: { type: Type.OBJECT, properties: { query: { type: Type.STRING, description: "Search query (exact words)." } }, required: ["query"] }
                },
                {
                  name: "searchGitHub",
                  description: "Search GitHub repositories and open results in the user's real default browser.",
                  parameters: { type: Type.OBJECT, properties: { query: { type: Type.STRING, description: "Search query." } }, required: ["query"] }
                },
                {
                  name: "createFile",
                  description: "Create a new PLAIN TEXT file on the user's real PC (.txt, .md, .csv as text, etc.). Silent background write — no typing. Works WITHOUT control word. Do NOT use for Word/Excel/PowerPoint. For 'write in notepad' / stories prefer writeToNotepad instead.",
                  parameters: { type: Type.OBJECT, properties: { path: { type: Type.STRING, description: "File path. Prefer Desktop/name.txt, Documents/name.txt, Downloads/name.txt, or a full absolute path." }, content: { type: Type.STRING, description: "File content (default empty)." }, overwrite: { type: Type.BOOLEAN, description: "Overwrite if exists (default false)." } }, required: ["path"] }
                },
                {
                  name: "writeToNotepad",
                  description: "BEST tool for 'write a story in notepad', 'make a note', 'notepad me likho'. Writes FULL content to a .txt file in the background then opens Notepad with the finished file. Works WITHOUT control word. NEVER use openApplication+typeText for this.",
                  parameters: {
                    type: Type.OBJECT,
                    properties: {
                      content: { type: Type.STRING, description: "Full story or note text to write (required)." },
                      path: { type: Type.STRING, description: "Optional path e.g. Desktop/MyStory.txt. Default: Desktop/BikliNote-<time>.txt" },
                      overwrite: { type: Type.BOOLEAN, description: "Overwrite if exists (default true)." },
                      open: { type: Type.BOOLEAN, description: "Open in Notepad after write (default true)." },
                    },
                    required: ["content"],
                  },
                },
                {
                  name: "createWordFile",
                  description: "Create a real Microsoft Word document (.docx) the user can open in Word. Use this whenever the user asks for a Word file, .docx, report, essay, letter, or formal document. NOT createFile.",
                  parameters: {
                    type: Type.OBJECT,
                    properties: {
                      path: { type: Type.STRING, description: "Output path, e.g. Desktop/Report.docx or Documents/letter.docx" },
                      title: { type: Type.STRING, description: "Document title (optional heading)." },
                      content: { type: Type.STRING, description: "Body text. Use blank lines between paragraphs, or markdown-like # headings and - bullets." },
                      paragraphs: { type: Type.ARRAY, items: { type: Type.STRING }, description: "Optional list of paragraphs instead of content." },
                      overwrite: { type: Type.BOOLEAN, description: "Overwrite if exists (default false)." }
                    },
                    required: ["path"]
                  }
                },
                {
                  name: "createExcelFile",
                  description: "Create a real Microsoft Excel spreadsheet (.xlsx). Use this whenever the user asks for Excel, spreadsheet, .xlsx, table of data, budget sheet, etc. NOT createFile.",
                  parameters: {
                    type: Type.OBJECT,
                    properties: {
                      path: { type: Type.STRING, description: "Output path, e.g. Desktop/Sales.xlsx" },
                      title: { type: Type.STRING, description: "Optional title row above the table." },
                      sheet_name: { type: Type.STRING, description: "Worksheet name (default Sheet1)." },
                      headers: { type: Type.ARRAY, items: { type: Type.STRING }, description: "Column headers, e.g. ['Name','Score']." },
                      rows: { type: Type.ARRAY, items: { type: Type.ARRAY, items: { type: Type.STRING } }, description: "Data rows as arrays matching headers." },
                      data: { type: Type.ARRAY, items: { type: Type.OBJECT }, description: "Alternative: array of objects, e.g. [{Name:'Alice',Score:95}]." },
                      content: { type: Type.STRING, description: "Alternative CSV-like text: 'Name,Score\\nAlice,95'." },
                      overwrite: { type: Type.BOOLEAN, description: "Overwrite if exists (default false)." }
                    },
                    required: ["path"]
                  }
                },
                {
                  name: "createPowerPointFile",
                  description: "Create a real Microsoft PowerPoint presentation (.pptx). Use this whenever the user asks for PowerPoint, presentation, slides, or .pptx. NOT createFile.",
                  parameters: {
                    type: Type.OBJECT,
                    properties: {
                      path: { type: Type.STRING, description: "Output path, e.g. Desktop/Pitch.pptx" },
                      title: { type: Type.STRING, description: "Presentation title (optional title slide)." },
                      subtitle: { type: Type.STRING, description: "Subtitle for the title slide." },
                      slides: {
                        type: Type.ARRAY,
                        items: {
                          type: Type.OBJECT,
                          properties: {
                            title: { type: Type.STRING, description: "Slide title." },
                            bullets: { type: Type.ARRAY, items: { type: Type.STRING }, description: "Bullet points on the slide." },
                            content: { type: Type.STRING, description: "Alternative body text (split into bullets by newlines)." }
                          }
                        },
                        description: "List of slides with title + bullets."
                      },
                      content: { type: Type.STRING, description: "If slides omitted: body for a single content slide." },
                      overwrite: { type: Type.BOOLEAN, description: "Overwrite if exists (default false)." }
                    },
                    required: ["path"]
                  }
                },
                {
                  name: "readFile",
                  description: "Read the contents of a text file.",
                  parameters: { type: Type.OBJECT, properties: { path: { type: Type.STRING, description: "File path." }, max_chars: { type: Type.INTEGER, description: "Max chars to return (default 8000)." } }, required: ["path"] }
                },
                {
                  name: "renameFile",
                  description: "Rename a file.",
                  parameters: { type: Type.OBJECT, properties: { path: { type: Type.STRING, description: "Current file path." }, new_name: { type: Type.STRING, description: "New file name." } }, required: ["path", "new_name"] }
                },
                {
                  name: "deleteFile",
                  description: "Delete a file. Sends to Recycle Bin by default (safe). Use permanent=true for hard delete.",
                  parameters: { type: Type.OBJECT, properties: { path: { type: Type.STRING, description: "File path." }, permanent: { type: Type.BOOLEAN, description: "Permanently delete (default false)." } }, required: ["path"] }
                },
                {
                  name: "moveFile",
                  description: "Move a file to a new location.",
                  parameters: { type: Type.OBJECT, properties: { path: { type: Type.STRING, description: "Source file path." }, destination: { type: Type.STRING, description: "Destination path or folder." } }, required: ["path", "destination"] }
                },
                {
                  name: "openFolder",
                  description: "Open a folder in File Explorer. Reuses the existing Explorer window by default (navigates to the folder). Only opens a second window if new_window=true. Supports aliases: desktop, documents, downloads, pictures, music, videos, home.",
                  parameters: {
                    type: Type.OBJECT,
                    properties: {
                      name: { type: Type.STRING, description: "Folder name or alias (downloads, desktop, documents, …)." },
                      path: { type: Type.STRING, description: "Full path if no alias." },
                      new_window: { type: Type.BOOLEAN, description: "true only when user says open in a new window. Default false = reuse same Explorer." },
                    },
                  },
                },
                {
                  name: "listFiles",
                  description: "List files in a folder.",
                  parameters: { type: Type.OBJECT, properties: { name: { type: Type.STRING, description: "Folder name or alias." }, path: { type: Type.STRING, description: "Full path." }, pattern: { type: Type.STRING, description: "Glob pattern (default '*')." } } }
                },
                {
                  name: "searchFiles",
                  description: "Search for files by name glob or extension under a folder.",
                  parameters: { type: Type.OBJECT, properties: { name: { type: Type.STRING, description: "Filename glob (e.g. '*.py')." }, extension: { type: Type.STRING, description: "File extension (e.g. 'py')." }, folder: { type: Type.STRING, description: "Folder to search (default home)." }, limit: { type: Type.INTEGER, description: "Max results (default 100)." } } }
                },
                {
                  name: "volumeUp",
                  description: "Increase system volume.",
                  parameters: { type: Type.OBJECT, properties: { amount: { type: Type.NUMBER, description: "Step amount 0-1 (default 0.1)." } } }
                },
                {
                  name: "volumeDown",
                  description: "Decrease system volume.",
                  parameters: { type: Type.OBJECT, properties: { amount: { type: Type.NUMBER, description: "Step amount 0-1 (default 0.1)." } } }
                },
                {
                  name: "setVolume",
                  description: "Set system volume to a specific percentage.",
                  parameters: { type: Type.OBJECT, properties: { percent: { type: Type.NUMBER, description: "Volume percentage 0-100." } }, required: ["percent"] }
                },
                {
                  name: "muteToggle",
                  description: "Toggle mute/unmute on the system volume.",
                  parameters: { type: Type.OBJECT, properties: {} }
                },
                {
                  name: "requestPowerAction",
                  description: "FIRST STEP for dangerous power actions. Generates a confirmation token. Tell the user verbally, then call executePowerAction with the token if they confirm. Actions: shutdown, restart, sleep, lock.",
                  parameters: { type: Type.OBJECT, properties: { action: { type: Type.STRING, description: "Power action: shutdown, restart, sleep, lock." } }, required: ["action"] }
                },
                {
                  name: "executePowerAction",
                  description: "SECOND STEP: execute a previously-confirmed power action. Requires a valid execute_token from requestPowerAction. Single-use, expires in 60 seconds.",
                  parameters: { type: Type.OBJECT, properties: { action: { type: Type.STRING, description: "The confirmed power action." }, execute_token: { type: Type.STRING, description: "Confirmation token from requestPowerAction." } }, required: ["action", "execute_token"] }
                },
                {
                  name: "minimizeWindow",
                  description: "Minimize the active window or a named window.",
                  parameters: { type: Type.OBJECT, properties: { title: { type: Type.STRING, description: "Window title to match (optional, defaults to active window)." } } }
                },
                {
                  name: "maximizeWindow",
                  description: "Maximize the active window or a named window.",
                  parameters: { type: Type.OBJECT, properties: { title: { type: Type.STRING, description: "Window title to match." } } }
                },
                {
                  name: "closeWindow",
                  description: "Close the active window or a named window.",
                  parameters: { type: Type.OBJECT, properties: { title: { type: Type.STRING, description: "Window title to match." } } }
                },
                {
                  name: "switchApplication",
                  description: "Switch to a named application window, or cycle Alt+Tab if no title given.",
                  parameters: { type: Type.OBJECT, properties: { title: { type: Type.STRING, description: "Window title to switch to." } } }
                },
                {
                  name: "copySelected",
                  description: "Copy selected text: sends Ctrl+C and reads the clipboard.",
                  parameters: { type: Type.OBJECT, properties: { wait: { type: Type.NUMBER, description: "Seconds to wait after Ctrl+C (default 0.35)." } } }
                },
                {
                  name: "pasteClipboard",
                  description: "Paste text into the active input. Writes text to clipboard then sends Ctrl+V.",
                  parameters: { type: Type.OBJECT, properties: { text: { type: Type.STRING, description: "Text to paste. If omitted, pastes current clipboard." } } }
                },
                {
                  name: "getClipboard",
                  description: "Read the current clipboard text content.",
                  parameters: { type: Type.OBJECT, properties: { max_chars: { type: Type.INTEGER, description: "Max chars (default 1000)." } } }
                },
                {
                  name: "clearClipboard",
                  description: "Empty the clipboard.",
                  parameters: { type: Type.OBJECT, properties: {} }
                },
                {
                  name: "takeScreenshot",
                  description: "Capture screen size metadata. Prefer analyzeScreenshot or readScreen for 'what do you see' (returns OCR text). Does not end the call.",
                  parameters: { type: Type.OBJECT, properties: { include_image: { type: Type.BOOLEAN, description: "Always leave false on live voice — images can kill the session." } } }
                },
                {
                  name: "saveScreenshot",
                  description: "Save a screenshot file when the user asks to save one. Does not end the call.",
                  parameters: { type: Type.OBJECT, properties: { name: { type: Type.STRING, description: "Optional filename prefix." } } }
                },
                {
                  name: "analyzeScreenshot",
                  description: "OCR the full screen and return readable text. Use for 'what is on my screen?' / 'what do you see'. Stay on the call — never turnOffMic after this.",
                  parameters: { type: Type.OBJECT, properties: { max_chars: { type: Type.INTEGER } } }
                },
                {
                  name: "readScreen",
                  description: "OCR the active window (title + visible text). Use when helping click UI. Stay on the call — never turnOffMic after this.",
                  parameters: { type: Type.OBJECT, properties: { max_chars: { type: Type.INTEGER } } }
                },
                {
                  name: "desktopBrowserOpen",
                  description: "Open a URL in the desktop Playwright automation browser (real Chromium, separate from holographic UI).",
                  parameters: { type: Type.OBJECT, properties: { url: { type: Type.STRING, description: "URL to open." } }, required: ["url"] }
                },
                {
                  name: "desktopBrowserSearch",
                  description: "Search within the desktop automation browser.",
                  parameters: { type: Type.OBJECT, properties: { query: { type: Type.STRING, description: "Search query." }, engine: { type: Type.STRING, description: "Engine: google, youtube, github, duckduckgo, bing." } }, required: ["query"] }
                },
                {
                  name: "desktopBrowserClick",
                  description: "Click an element in the desktop automation browser by CSS selector or text.",
                  parameters: { type: Type.OBJECT, properties: { selector: { type: Type.STRING, description: "CSS selector." }, text: { type: Type.STRING, description: "Text to find and click." } } }
                },
                {
                  name: "desktopBrowserType",
                  description: "Type text into the active element in the desktop automation browser.",
                  parameters: { type: Type.OBJECT, properties: { text: { type: Type.STRING, description: "Text to type." }, selector: { type: Type.STRING, description: "Optional CSS selector for a specific input." }, clear: { type: Type.BOOLEAN, description: "Clear before typing (default true)." } }, required: ["text"] }
                },
                {
                  name: "desktopBrowserFillForm",
                  description: "Fill multiple form fields and optionally submit in the desktop automation browser.",
                  parameters: { type: Type.OBJECT, properties: { fields: { type: Type.OBJECT, description: "Object of selector -> value pairs." }, submit: { type: Type.STRING, description: "Optional submit button selector." } }, required: ["fields"] }
                },
                {
                  name: "desktopBrowserOpenTab",
                  description: "Open a new tab in the desktop automation browser.",
                  parameters: { type: Type.OBJECT, properties: { url: { type: Type.STRING, description: "URL for the new tab." } } }
                },
                {
                  name: "desktopBrowserCloseTab",
                  description: "Close the active tab in the desktop automation browser.",
                  parameters: { type: Type.OBJECT, properties: {} }
                },
                {
                  name: "desktopBrowserGoBack",
                  description: "Navigate back in the desktop automation browser history.",
                  parameters: { type: Type.OBJECT, properties: {} }
                },
                {
                  name: "desktopBrowserGoForward",
                  description: "Navigate forward in the desktop automation browser history.",
                  parameters: { type: Type.OBJECT, properties: {} }
                },
                {
                  name: "desktopBrowserScroll",
                  description: "Scroll the desktop automation browser page.",
                  parameters: { type: Type.OBJECT, properties: { direction: { type: Type.STRING, description: "Scroll direction: up or down." }, amount: { type: Type.INTEGER, description: "Pixels to scroll (default 500)." } } }
                },
                {
                  name: "createPythonFile",
                  description: "Create a Python (.py) file with content.",
                  parameters: { type: Type.OBJECT, properties: { path: { type: Type.STRING, description: "File path." }, content: { type: Type.STRING, description: "Python code content." }, overwrite: { type: Type.BOOLEAN, description: "Overwrite if exists." } }, required: ["path"] }
                },
                {
                  name: "writeCodeFile",
                  description: "Create a code file in any language with appropriate extension.",
                  parameters: { type: Type.OBJECT, properties: { path: { type: Type.STRING, description: "File path." }, content: { type: Type.STRING, description: "Code content." }, language: { type: Type.STRING, description: "Language name (e.g. 'python', 'javascript', 'html')." }, overwrite: { type: Type.BOOLEAN, description: "Overwrite if exists." } }, required: ["path"] }
                },
                {
                  name: "createProjectFolder",
                  description: "Create a project folder structure with optional subfolders and starter files.",
                  parameters: { type: Type.OBJECT, properties: { path: { type: Type.STRING, description: "Project root folder path." }, subfolders: { type: Type.ARRAY, items: { type: Type.STRING }, description: "List of subfolder names." }, scaffold_standard: { type: Type.BOOLEAN, description: "Create src, tests, docs subfolders." }, files: { type: Type.OBJECT, description: "Object of relative-path -> content for starter files." } }, required: ["path"] }
                },
                {
                  name: "runPythonScript",
                  description: "Execute a Python script and capture stdout, stderr, and exit code. Has a configurable timeout.",
                  parameters: { type: Type.OBJECT, properties: { path: { type: Type.STRING, description: "Script path." }, args: { type: Type.ARRAY, items: { type: Type.STRING }, description: "Script arguments." }, timeout: { type: Type.INTEGER, description: "Timeout in seconds (default 30)." } }, required: ["path"] }
                },
                {
                  name: "systemInfo",
                  description: "Get system resource usage: CPU %, RAM %, disk usage, uptime, OS info.",
                  parameters: { type: Type.OBJECT, properties: {} }
                },
                {
                  name: "gpuInfo",
                  description: "Get NVIDIA GPU stats: utilization %, VRAM usage, temperature. Graceful fallback if no NVIDIA GPU.",
                  parameters: { type: Type.OBJECT, properties: {} }
                },
                {
                  name: "temperatureInfo",
                  description: "Get available temperature readings (CPU, GPU, etc.). Best-effort on Windows.",
                  parameters: { type: Type.OBJECT, properties: {} }
                },
                {
                  name: "batteryInfo",
                  description:
                    "Read the REAL battery percentage from this computer right now. Use when the user asks battery %, charge level, how much battery left, charging status. Returns percent and plugged-in/charging state. Do NOT open Settings — just report the number.",
                  parameters: { type: Type.OBJECT, properties: {} }
                },
                {
                  name: "getDateTime",
                  description:
                    "Read the REAL current local date and time from this computer's clock. ALWAYS use this when the user asks what time it is, the date, day of week, or kitne baje hain. Never guess the time — call this tool and speak the result.",
                  parameters: { type: Type.OBJECT, properties: {} }
                },
                // --- V2: Brightness control ---
                {
                  name: "brightnessUp",
                  description: "Increase screen brightness by a step (default 10%). Use when user says 'increase brightness' or 'make screen brighter'.",
                  parameters: {
                    type: Type.OBJECT,
                    properties: {
                      amount: { type: Type.NUMBER, description: "Percentage to increase (default 10)." }
                    }
                  }
                },
                {
                  name: "brightnessDown",
                  description: "Decrease screen brightness by a step (default 10%). Use when user says 'decrease brightness' or 'dim screen'.",
                  parameters: {
                    type: Type.OBJECT,
                    properties: {
                      amount: { type: Type.NUMBER, description: "Percentage to decrease (default 10)." }
                    }
                  }
                },
                {
                  name: "setBrightness",
                  description: "Set screen brightness to an exact level. Use when user says 'set brightness to 50%' or 'brightness 80'.",
                  parameters: {
                    type: Type.OBJECT,
                    properties: {
                      percent: { type: Type.NUMBER, description: "Target brightness 0-100." }
                    },
                    required: ["percent"]
                  }
                },
                // --- V2: Windows auto-start management ---
                {
                  name: "enableAutoStart",
                  description: "Enable BIKLI to launch automatically when Windows starts. Creates a silent startup entry.",
                  parameters: { type: Type.OBJECT, properties: {} }
                },
                {
                  name: "disableAutoStart",
                  description: "Disable BIKLI auto-start on Windows login. Removes the startup entry.",
                  parameters: { type: Type.OBJECT, properties: {} }
                },
                {
                  name: "getAutoStartStatus",
                  description: "Check whether BIKLI is currently configured to auto-start on Windows login.",
                  parameters: { type: Type.OBJECT, properties: {} }
                },
                // --- Computer control gate (control word required) ---
                {
                  name: "enableComputerControl",
                  description: "Unlock full PC + cursor control AFTER the user says the control word ('control', 'take control', etc.). Do NOT call this without the user granting control.",
                  parameters: {
                    type: Type.OBJECT,
                    properties: {
                      reason: { type: Type.STRING, description: "Why control was granted, e.g. 'user said control'." },
                      phrase: { type: Type.STRING, description: "Optional phrase the user said." },
                    },
                  },
                },
                {
                  name: "disableComputerControl",
                  description: "Lock full PC + cursor control again when the user says stop/release/end control.",
                  parameters: {
                    type: Type.OBJECT,
                    properties: {
                      reason: { type: Type.STRING, description: "Why control was released." },
                    },
                  },
                },
                {
                  name: "getComputerControlStatus",
                  description: "Check whether full computer control (cursor + desktop tools) is currently unlocked.",
                  parameters: { type: Type.OBJECT, properties: {} },
                },
                // --- Cursor + keyboard (require control mode) ---
                {
                  name: "getScreenSize",
                  description: "Get primary screen width and height in pixels (for coordinate planning).",
                  parameters: { type: Type.OBJECT, properties: {} },
                },
                {
                  name: "getMousePosition",
                  description: "Get current mouse cursor X,Y position.",
                  parameters: { type: Type.OBJECT, properties: {} },
                },
                {
                  name: "moveMouse",
                  description: "Move the real system mouse cursor. Use absolute x,y or relative dx,dy.",
                  parameters: {
                    type: Type.OBJECT,
                    properties: {
                      x: { type: Type.NUMBER, description: "Absolute X pixel (or delta if relative=true)." },
                      y: { type: Type.NUMBER, description: "Absolute Y pixel (or delta if relative=true)." },
                      dx: { type: Type.NUMBER, description: "Relative X delta pixels." },
                      dy: { type: Type.NUMBER, description: "Relative Y delta pixels." },
                      relative: { type: Type.BOOLEAN, description: "If true, treat x/y as deltas." },
                      duration: { type: Type.NUMBER, description: "Move duration in seconds (default 0.2)." },
                    },
                  },
                },
                {
                  name: "clickMouse",
                  description: "Click the mouse at current position or at x,y. button: left|right|middle. clicks: 1 or 2.",
                  parameters: {
                    type: Type.OBJECT,
                    properties: {
                      x: { type: Type.NUMBER, description: "Optional X coordinate." },
                      y: { type: Type.NUMBER, description: "Optional Y coordinate." },
                      button: { type: Type.STRING, description: "left, right, or middle (default left)." },
                      clicks: { type: Type.INTEGER, description: "Number of clicks (default 1)." },
                      duration: { type: Type.NUMBER, description: "Move duration if x/y provided." },
                    },
                  },
                },
                {
                  name: "doubleClick",
                  description: "Double-click at current position or at x,y.",
                  parameters: {
                    type: Type.OBJECT,
                    properties: {
                      x: { type: Type.NUMBER },
                      y: { type: Type.NUMBER },
                      button: { type: Type.STRING, description: "left, right, or middle." },
                    },
                  },
                },
                {
                  name: "rightClick",
                  description: "Right-click at current position or at x,y.",
                  parameters: {
                    type: Type.OBJECT,
                    properties: {
                      x: { type: Type.NUMBER },
                      y: { type: Type.NUMBER },
                    },
                  },
                },
                {
                  name: "dragMouse",
                  description: "Drag the mouse from a start point to to_x/to_y or by dx/dy.",
                  parameters: {
                    type: Type.OBJECT,
                    properties: {
                      x: { type: Type.NUMBER, description: "Start X (optional — current pos if omitted)." },
                      y: { type: Type.NUMBER, description: "Start Y." },
                      to_x: { type: Type.NUMBER, description: "End X." },
                      to_y: { type: Type.NUMBER, description: "End Y." },
                      dx: { type: Type.NUMBER, description: "Relative end X delta." },
                      dy: { type: Type.NUMBER, description: "Relative end Y delta." },
                      button: { type: Type.STRING },
                      duration: { type: Type.NUMBER },
                    },
                  },
                },
                {
                  name: "scrollMouse",
                  description: "Scroll the mouse wheel. direction: up|down|left|right. amount: scroll clicks.",
                  parameters: {
                    type: Type.OBJECT,
                    properties: {
                      direction: { type: Type.STRING, description: "up, down, left, or right." },
                      amount: { type: Type.INTEGER, description: "Scroll steps (default 3)." },
                      x: { type: Type.NUMBER, description: "Optional move-to X before scroll." },
                      y: { type: Type.NUMBER, description: "Optional move-to Y before scroll." },
                    },
                  },
                },
                {
                  name: "typeText",
                  description: "Type short text into the focused field. REQUIRES control word. NEVER use for stories/notes/long text — use writeToNotepad or createFile instead.",
                  parameters: {
                    type: Type.OBJECT,
                    properties: {
                      text: { type: Type.STRING, description: "Short text only. For stories use writeToNotepad." },
                      interval: { type: Type.NUMBER, description: "Delay between keystrokes." },
                      paste: { type: Type.BOOLEAN, description: "Force clipboard paste method." },
                    },
                    required: ["text"],
                  },
                },
                {
                  name: "pressKey",
                  description: "Press a key or key sequence (enter, tab, esc, f5, backspace, or 'ctrl+s').",
                  parameters: {
                    type: Type.OBJECT,
                    properties: {
                      key: { type: Type.STRING, description: "Key name or combo like ctrl+s." },
                      presses: { type: Type.INTEGER, description: "How many times (default 1)." },
                    },
                    required: ["key"],
                  },
                },
                {
                  name: "hotkey",
                  description: "Press a keyboard shortcut, e.g. keys='ctrl+c' or keys=['ctrl','v'].",
                  parameters: {
                    type: Type.OBJECT,
                    properties: {
                      keys: {
                        type: Type.STRING,
                        description: "Combo string like 'ctrl+shift+esc' or use array form in args.",
                      },
                      presses: { type: Type.INTEGER },
                    },
                    required: ["keys"],
                  },
                },
                {
                  name: "mouseMoveAndClick",
                  description: "Move mouse to x,y then click (convenience for UI automation).",
                  parameters: {
                    type: Type.OBJECT,
                    properties: {
                      x: { type: Type.NUMBER },
                      y: { type: Type.NUMBER },
                      button: { type: Type.STRING },
                      clicks: { type: Type.INTEGER },
                      duration: { type: Type.NUMBER },
                    },
                    required: ["x", "y"],
                  },
                },
                {
                  name: "clickByText",
                  description: "PREFERRED way to click a named button/link/element: 'click Continue', 'click the OK button', 'click Save', 'click Sign in', 'press Next', 'click Submit', 'click Agree', 'click Yes'. Uses Windows UI Automation to find the control by its visible label and invoke it — far more reliable than guessing x,y coordinates from a screenshot. Works on native Windows apps AND web pages in Edge/Chrome. Requires the control word.",
                  parameters: {
                    type: Type.OBJECT,
                    properties: {
                      text: { type: Type.STRING, description: "Exact button/link label as it appears on screen, e.g. 'Continue', 'OK', 'Save', 'Sign in', 'Next', 'Submit', 'Agree', 'Accept', 'Yes'." },
                      match: { type: Type.STRING, description: "Match mode: 'contains' (default, matches if label contains the text) or 'exact'." },
                    },
                    required: ["text"],
                  },
                },
              ]
            }
          ];

      // Speech synthesis language. No languageCode was ever sent, so Gemini
      // synthesised with English phonetics and Hindi words came out anglicised.
      // "auto" keeps the model's own detection (best for mixed Hinglish);
      // an explicit BCP-47 code forces native phonetics for that language.
      let speechLanguageCode = "";
      try {
        const s = loadSettingsFile();
        const raw = String(s.speechLanguage || "auto").trim();
        if (raw && raw.toLowerCase() !== "auto") speechLanguageCode = raw;
      } catch {
        /* settings file optional */
      }

      const buildSetup = (languageCode: string) => ({
        speechConfig: {
          voiceConfig: { prebuiltVoiceConfig: { voiceName: "Aoede" } },
          ...(languageCode ? { languageCode } : {}),
        },
        inputAudioTranscription: {},
        outputAudioTranscription: {},
        systemInstruction: finalInstructions,
        tools: geminiTools,
      });

      // ── Connect to Gemini Live via raw WebSocket ───────────────────────
      try {
        try {
          session = await createRawGeminiSession(
            apiKey,
            "gemini-2.5-flash-native-audio-latest",
            buildSetup(speechLanguageCode),
            makeGeminiCallbacks(),
          );
        } catch (langErr: any) {
          // languageCode is documented for half-cascade models; a native-audio
          // model may reject it. Never let a pronunciation preference cost the
          // user their whole voice session — retry once without it.
          if (!speechLanguageCode) throw langErr;
          console.warn(
            `[Gemini] Setup rejected languageCode="${speechLanguageCode}" (${langErr?.message || langErr}); retrying with auto language.`,
          );
          logError(`SPEECH_LANGUAGE_REJECTED ${speechLanguageCode}: ${langErr?.message || langErr}`);
          speechLanguageCode = "";
          session = await createRawGeminiSession(
            apiKey,
            "gemini-2.5-flash-native-audio-latest",
            buildSetup(""),
            makeGeminiCallbacks(),
          );
        }
        logStartup(`GEMINI_SESSION speechLanguage=${speechLanguageCode || "auto"}`);
      } catch (connectErr: any) {
        const msg = String(connectErr?.message || connectErr || "");
        console.error("[Gemini] Raw WebSocket session failed:", msg);
        const isAuth = /API_KEY|not valid|unauth|403|401/i.test(msg);
        if (isAuth) {
          throw new Error(`Gemini API key is invalid or unauthorized. Check your key in Settings. (${msg.slice(0, 120)})`);
        }
        throw connectErr;
      }

      // Callbacks are built lazily so the languageCode retry above can reuse them.
      function makeGeminiCallbacks() {
        return {
          onmessage: (message: any) => {
            // Audio Stream Chunk (model response audio play, 24kHz raw PCM).
            const modelParts = message.serverContent?.modelTurn?.parts;
            if (Array.isArray(modelParts)) {
              for (const part of modelParts) {
                const inline = (part as any)?.inlineData;
                const data = inline?.data;
                if (!data || typeof data !== "string") continue;
                const mime = String(inline?.mimeType || "").toLowerCase();
                // Accept explicit audio/* or raw PCM blobs without a mime label.
                if (!mime || mime.startsWith("audio/") || mime.includes("pcm")) {
                  noteModelSpoke();
                  try {
                    clientWs.send(JSON.stringify({ type: "audio", audio: data }));
                  } catch {
                    /* client may have closed */
                  }
                }
              }
            }
            
            // Interruption flag
            if (message.serverContent?.interrupted) {
              console.log("[Bikli Interrupted!]");
              clientWs.send(JSON.stringify({ type: "interrupted" }));
            }
            
            // Turn Complete
            if (message.serverContent?.turnComplete) {
              clientWs.send(JSON.stringify({ type: "turnComplete" }));
              
              if (currentModelResponseText.trim()) {
                dialogueHistory = pushDialogue(dialogueHistory, { role: "model", text: currentModelResponseText });
                currentModelResponseText = "";
              }

              // Fire asynchronous memory extraction on every turn (>=1 entry)
              if (dialogueHistory.length >= 1) {
                (async () => {
                  try {
                    const updated = await processConversationSlice(geminiApiKey, dialogueHistory);
                    if (updated) {
                      console.log("[Memory Sync] Sending refreshed memory list to client.");
                      clientWs.send(JSON.stringify({ type: "memory_sync", memories: updated }));
                    }
                  } catch (err) {
                    console.error("[Memory Sync] Error running background consolidation:", err);
                  }
                })();
              }
            }
            
            // Transcription of model output (text chunk) — scan all parts + stream
            let modelText =
              (message.serverContent as any)?.outputTranscription?.text || "";
            if (!modelText && Array.isArray(modelParts)) {
              modelText = modelParts
                .map((p: any) => (typeof p?.text === "string" ? p.text : ""))
                .filter(Boolean)
                .join("");
            }
            if (modelText) {
              clientWs.send(JSON.stringify({ type: "transcription", role: "model", text: modelText }));
              currentModelResponseText += modelText;
            }
            
            // User input transcription (user speech text translated by Gemini)
            // Prefer inputAudioTranscription stream; fall back to legacy userTurn shape.
            const userTextOutput =
              (message.serverContent as any)?.inputTranscription?.text ||
              (message.serverContent as any)?.userTurn?.parts?.[0]?.text;
            if (userTextOutput) {
              clientWs.send(JSON.stringify({ type: "transcription", role: "user", text: userTextOutput }));
              dialogueHistory = pushDialogue(dialogueHistory, { role: "user", text: userTextOutput });
              // Fast path: spoken control / release word unlocks or locks PC control
              // even if the model is slow to call the tool.
              void maybeAutoToggleComputerControl(userTextOutput, clientWs);
              // Fast path: "open first/second video" while Share Screen — model often
              // only describes the screen and never calls playYouTube.
              void maybeAutoOpenNthYouTubeVideo(userTextOutput, clientWs);
              // Fast path: "open youtube" — model sometimes only says it opened.
              // Match against the recent user speech too, because inputTranscription
              // arrives in chunks and "open" / "youtube" can land in separate ones.
              void maybeAutoOpenWebsite(userTextOutput, clientWs);
              {
                const joinedUserSpeech = dialogueHistory
                  .filter((d) => d.role === "user")
                  .slice(-3)
                  .map((d) => d.text)
                  .join(" ");
                if (joinedUserSpeech && joinedUserSpeech !== userTextOutput) {
                  void maybeAutoOpenWebsite(joinedUserSpeech, clientWs);
                }
              }
            }

            // Recent user speech for YouTube search-vs-play coalesce + open-nth video
            const recentUserSpeech = [...dialogueHistory]
              .reverse()
              .find((d) => d.role === "user" && d.text?.trim())?.text || "";
            
            // Function Calls (Gemini requesting server/client tool execution)
            if (message.toolCall?.functionCalls) {
              // Collapse openWebsite+searchYouTube+playYouTube spam into ONE play/search.
              const originalCalls = message.toolCall.functionCalls as any[];
              const functionCalls = coalesceBrowserFunctionCalls(originalCalls, recentUserSpeech);
              // Still answer dropped tool calls so Gemini does not hang waiting.
              if (functionCalls.length < originalCalls.length) {
                // Compare by id, NOT by reference: coalesce may rewrite a kept
                // call into a new object with the same id (e.g. playYouTube →
                // searchYouTube), and a reference check would answer that id
                // BOTH as a "skip" and as the real result (conflicting content).
                const keptIds = new Set(functionCalls.map((c: any) => c?.id));
                for (const dropped of originalCalls) {
                  if (dropped?.id != null && keptIds.has(dropped.id)) continue;
                  const dropKey = trackToolStart(dropped.id, dropped.name);
                  safeSendToolResponse(
                    dropKey,
                    dropped.name,
                    dropped.id,
                    {
                      result:
                        "Skipped extra browser open — only one tab is opened for this play/search request.",
                      ok: true,
                      coalesced: true,
                    },
                    "coalesced skip",
                  );
                }
              }
              for (const fc of functionCalls) {
                console.log(`[Function Call]: ${fc.name}`, fc.args);
                const toolKey = trackToolStart(fc.id, fc.name);
                
                if (fc.name === "saveCustomMemory") {
                  (async () => {
                    try {
                      const args = fc.args as any;
                      const category = args.category;
                      const text = args.text;
                      if (category && text) {
                        // Serialized read-modify-write so a concurrent
                        // consolidation cannot overwrite this new memory.
                        const mList = await mutateMemories((memories) => {
                          const timestamp = new Date().toISOString();
                          const newMemory: Memory = {
                            id: Math.random().toString(36).substring(2, 11),
                            category,
                            text,
                            createdAt: timestamp,
                            updatedAt: timestamp
                          };
                          memories.push(newMemory);
                          return memories;
                        });

                        // Sync immediately with the React client
                        clientWs.send(JSON.stringify({ type: "memory_sync", memories: mList }));
                        
                        safeSendToolResponse(
                          toolKey,
                          fc.name,
                          fc.id,
                          { result: "Memory successfully captured and persisted in connections core." },
                          "memory saved",
                        );
                      } else {
                        // ALWAYS answer — missing fields used to leave Gemini hanging silent.
                        safeSendToolResponse(
                          toolKey,
                          fc.name,
                          fc.id,
                          {
                            result: "Memory not saved — need both category and text. Tell the user briefly.",
                            ok: false,
                          },
                          "memory missing fields",
                        );
                      }
                    } catch (err: any) {
                      console.error("saveCustomMemory execution failure:", err);
                      safeSendToolResponse(
                        toolKey,
                        fc.name,
                        fc.id,
                        {
                          result: `Memory save failed: ${err?.message || err}. Stay on the call and speak briefly.`,
                          ok: false,
                        },
                        "memory error",
                      );
                    }
                  })();
                } else if (DESKTOP_TOOLS.has(fc.name)) {
                  // ── Desktop control tools: route to Python agent ──
                  (async () => {
                    // Screenshots / OCR return TEXT only into the live session.
                    // Never inject JPEG/base64 mid-call — large media kills Gemini Live
                    // and auto-disconnects the mic (looks like "auto off" on click/see).
                    const fixedArgs = expandDesktopToolArgs(
                      fc.name,
                      fc.args as Record<string, unknown>,
                    );
                    if (fixedArgs && typeof fixedArgs === "object") {
                      // Always refuse image payloads on the tool path
                      (fixedArgs as Record<string, unknown>).include_image = false;
                    }
                    console.log(`[Desktop Agent] Routing ${fc.name} to Python backend...`, fixedArgs);
                    const agentResult = await callDesktopAgent(fc.name, fixedArgs, recentUserSpeech);

                    // Push control-mode badge updates to the React UI.
                    if (
                      (fc.name === "enableComputerControl" ||
                        fc.name === "disableComputerControl" ||
                        fc.name === "getComputerControlStatus") &&
                      agentResult.ok
                    ) {
                      const payload = (agentResult.result || {}) as Record<string, unknown>;
                      const enabled =
                        fc.name === "enableComputerControl"
                          ? true
                          : fc.name === "disableComputerControl"
                            ? false
                            : Boolean(payload.enabled);
                      try {
                        clientWs.send(
                          JSON.stringify({
                            type: "computer_control",
                            enabled,
                            action: fc.name,
                            ok: true,
                            result: payload,
                          }),
                        );
                      } catch {
                        /* ignore */
                      }
                    }

                    if (agentResult.ok) {
                      let output: unknown = agentResult.result ?? { result: "Done." };
                      // Strip any image/base64 fields — OCR/text only keeps the session alive.
                      if (output && typeof output === "object") {
                        const o = { ...(output as Record<string, unknown>) };
                        for (const k of Object.keys(o)) {
                          if (/image|base64|png|jpeg|screenshot_data|data_url/i.test(k)) {
                            delete o[k];
                          }
                          // Drop huge string blobs
                          if (typeof o[k] === "string" && (o[k] as string).length > 8000) {
                            o[k] = `[omitted large field: ${k}]`;
                          }
                        }
                        output = o;
                      }
                      const brief =
                        typeof (output as any)?.result === "string"
                          ? String((output as any).result).slice(0, 120)
                          : "done";
                      safeSendToolResponse(toolKey, fc.name, fc.id, output, brief);
                    } else {
                      const errMsg = agentResult.error || "Desktop agent error.";
                      console.error(`[Desktop Agent] Error for ${fc.name}:`, errMsg);
                      // Soft error string — never crash the voice session
                      safeSendToolResponse(
                        toolKey,
                        fc.name,
                        fc.id,
                        {
                          result: `Could not complete that action: ${errMsg}. Stay on the call, do NOT end the session, do NOT call turnOffMic. SPEAK this error briefly to the user now.`,
                          ok: false,
                        },
                        errMsg.slice(0, 120),
                      );
                    }
                  })().catch((err) => {
                    console.error(`[Desktop Agent] Unhandled tool path error for ${fc.name}:`, err);
                    safeSendToolResponse(
                      toolKey,
                      fc.name,
                      fc.id,
                      {
                        result:
                          "Desktop tool failed unexpectedly. Stay on the call, speak a short apology, and continue.",
                        ok: false,
                      },
                      "unexpected error",
                    );
                  });
                } else {
                  // Client-side tools (browser iframe, theme, turnOffMic, …).
                  // Hard timeout so a stuck UI never leaves Gemini silent forever.
                  try {
                    clientWs.send(
                      JSON.stringify({
                        type: "toolCall",
                        callId: fc.id,
                        name: fc.name,
                        args: fc.args,
                        trackKey: toolKey,
                      }),
                    );
                  } catch (sendClientErr) {
                    console.error(`[Tool] Failed to send client toolCall ${fc.name}:`, sendClientErr);
                    safeSendToolResponse(
                      toolKey,
                      fc.name,
                      fc.id,
                      {
                        result: "Client tool delivery failed. Speak briefly and continue.",
                        ok: false,
                      },
                      "client send failed",
                    );
                    continue;
                  }
                  const timeoutId = setTimeout(() => {
                    if (!pendingToolIds.has(toolKey)) return;
                    console.warn(`[Tool] Client tool ${fc.name} timed out — auto-responding`);
                    safeSendToolResponse(
                      toolKey,
                      fc.name,
                      fc.id,
                      {
                        result:
                          "Tool timed out on the client. Stay on the call and speak a short update to the user now.",
                        ok: false,
                        timed_out: true,
                      },
                      "client timeout",
                    );
                  }, 14000);
                  clientToolTimeouts.set(toolKey, timeoutId);
                }
              }
            }
          },
          onclose: () => {
            console.log("Gemini Live session closed");
            clearPostToolNudge();
            for (const t of clientToolTimeouts.values()) clearTimeout(t);
            clientToolTimeouts.clear();
            pendingToolIds.clear();
            try {
              clientWs.send(JSON.stringify({ type: "status", status: "session_closed" }));
            } catch {
              /* ignore */
            }
          }
        };
      }

      clientWs.send(JSON.stringify({ type: "status", status: "connected" }));

      // If user disabled the control-word requirement in settings, unlock PC
      // control automatically for this live session (less safe).
      try {
        const s = loadSettingsFile();
        // Default: LOCKED until user says "control". Only auto-unlock if user
        // explicitly turns OFF "Require control word" in Settings.
        if (s.controlWordRequired === false) {
          const payload = setNodeComputerControl(true, "controlWordRequired disabled in settings");
          void callDesktopAgentRaw("enableComputerControl", {
            reason: payload.reason,
          }).catch(() => {});
          try {
            clientWs.send(
              JSON.stringify({
                type: "computer_control",
                enabled: true,
                action: "enableComputerControl",
                ok: true,
                reason: payload.reason,
              }),
            );
          } catch {
            /* ignore */
          }
        } else {
          setNodeComputerControl(false, "session start — control word required");
          void callDesktopAgentRaw("disableComputerControl", {
            reason: "session start — control word required",
          }).catch(() => {});
          try {
            clientWs.send(
              JSON.stringify({
                type: "computer_control",
                enabled: false,
                action: "session_start",
                ok: true,
                reason: "locked until control word",
              }),
            );
          } catch {
            /* ignore */
          }
        }
      } catch {
        /* settings file optional */
      }
      
      clientWs.on("message", (rawMsg) => {
        try {
          const msg = JSON.parse(rawMsg.toString());
          if (msg.audio) {
            session.sendRealtimeInput({
              audio: { data: msg.audio, mimeType: "audio/pcm;rate=16000" }
            });
          } else if (msg.type === "screenShare") {
            // Live continuous frames when client is sharing (optional).
            // Screenshot/OCR tools work independently without this flag.
            screenShareActive = !!msg.active;
            console.log(`[Screen Share] active=${screenShareActive}`);
          } else if (msg.type === "video" && msg.video) {
            // Client only sends frames while Share + Vision Mode are on.
            // Auto-arm if the screenShare message was lost (race before WS open).
            if (!screenShareActive) {
              screenShareActive = true;
              console.log("[Screen Share] auto-enabled from incoming video frame");
            }
            try {
              const raw = String(msg.video);
              // Strip accidental data-URL prefix if client ever sends one
              const data = raw.includes(",") ? raw.split(",").pop()! : raw;
              if (!data || data.length < 80) return;
              const frame = { data, mimeType: "image/jpeg" as const };
              // Prefer `video` (Live API realtime video stream), then media, then mediaChunks
              try {
                session.sendRealtimeInput({ video: frame });
              } catch {
                try {
                  session.sendRealtimeInput({ media: frame });
                } catch {
                  session.sendRealtimeInput({
                    media: frame,
                  } as any);
                }
              }
            } catch (videoErr) {
              console.error("[Screen Vision] Failed to forward video frame:", videoErr);
            }
          } else if (msg.type === "toolResponse") {
            // Client finished a tool — always forward, clear timeout, schedule speech nudge.
            const name = String(msg.name || "tool");
            const id = msg.id;
            // Prefer explicit trackKey from client; else match by call id.
            let key =
              (typeof msg.trackKey === "string" && msg.trackKey) ||
              (id != null && pendingToolIds.has(String(id)) ? String(id) : "");
            if (!key && id != null && answeredToolKeys.has(String(id))) {
              // Already answered (e.g. server timeout beat the client) — drop.
              console.warn(`[Tool] Late client response for ${name} ignored (already answered)`);
              return;
            }
            if (!key) {
              // Fall back: first pending key, or invent one for bookkeeping
              key =
                pendingToolIds.values().next().value ||
                trackToolStart(id != null ? String(id) : undefined, name);
            }
            const out = msg.output ?? { result: "Done." };
            const brief =
              typeof (out as any)?.result === "string"
                ? String((out as any).result).slice(0, 120)
                : (out as any)?.error
                  ? String((out as any).error).slice(0, 120)
                  : "client done";
            safeSendToolResponse(key, name, id, out, brief);
          }
        } catch (e) {
          console.error("Error editing/forwarding client frame message:", e);
        }
      });
      
      clientWs.on("close", () => {
        console.log("Client disconnected, closing Gemini session");
        try {
          session.close();
        } catch (e) {}
      });

      clientWs.on("error", (err) => {
        console.error("Client WebSocket error:", err);
      });
      
    } catch (err: any) {
      console.error("Error connecting to Gemini Live API:", err);
      try {
        const msg = String(err?.message || err || "unknown");
        const isAuth = /API_KEY|not valid|unauth|403|401/i.test(msg);
        const is429 = /429|rate_limit|RATE_LIMIT|quota/i.test(msg);
        const retryable = !isAuth && (is429 || /timeout|network|ECONN|503|temporarily|unavailable|fetch|websocket|closed|econnaborted|enotfound/i.test(msg));

        if (retryable) {
          await new Promise((r) => setTimeout(r, 1500));
          if (clientWs.readyState !== clientWs.OPEN) {
            throw new Error("Client left during Gemini reconnect");
          }
        }

        clientWs.send(
          JSON.stringify({
            type: "error",
            error: isAuth
              ? `Your Gemini API key is invalid. Go to Settings and update it with a valid key.`
              : `Could not connect to Gemini (${msg}). Click the power button to try again.`,
          }),
        );
      } catch (sendErr) {
        try {
          clientWs.send(
            JSON.stringify({
              type: "error",
              error: `Could not connect to Gemini: ${err?.message || err}`,
            }),
          );
        } catch {
          /* ignore */
        }
      }
      try {
        clientWs.close();
      } catch {
        /* ignore */
      }
    }
  });

  // Serve custom static assets folder (use APP_ROOT so packaged cwd is fine)
  app.use("/assets", express.static(path.join(APP_ROOT, "assets")));

  // Express Static assets / Vite Dev Middleware configuration
  if (process.env.NODE_ENV !== "production") {
    // Loaded lazily so the production bundle never requires vite (a dev-only
    // dependency that is not shipped with the packaged app).
    const { createServer: createViteServer } = await import("vite");
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
      root: APP_ROOT,
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(APP_ROOT, "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  // A failed listen() emits "error" on the server. With no handler here the
  // process-level uncaughtException trap swallowed it, the event loop drained,
  // and Node exited with code 0 — so Electron reported "backend exited
  // unexpectedly (code 0)" and the real reason (port already in use) was only
  // visible in the log. Report it clearly and exit non-zero.
  server.on("error", (err: NodeJS.ErrnoException) => {
    const detail =
      err?.code === "EADDRINUSE"
        ? `Port ${PORT} is already in use. Another BIKLI backend is running ` +
          `(for example "npm start", "npm run dev", or a previous BIKLI that did not shut down). ` +
          `Close it — or end the stray node.exe in Task Manager — then start BIKLI again.`
        : `Could not start the BIKLI server: ${err?.message || String(err)}`;
    console.error(`[Server] ${detail}`);
    appendLogSync("errors.log", `LISTEN_FAILED ${err?.code || "ERROR"}: ${err?.message || String(err)}`);
    appendLogSync("startup.log", `LISTEN_FAILED ${detail}`);
    process.exit(1);
  });

  // Loopback only. This backend exposes memories, settings, logs, the desktop
  // control gate and the /live socket (full PC control). Binding 0.0.0.0 handed
  // all of that to anyone on the same network; only this machine's Electron
  // window (http://localhost:3000) is ever a legitimate client.
  server.listen(PORT, "127.0.0.1", () => {
    logStartup(`BIKLI V2 server started on http://localhost:${PORT}`);
    console.log(`[Server] Running on http://localhost:${PORT}`);
    // Kick off the desktop agent (probe + auto-spawn) immediately on boot,
    // then force-recheck a few seconds later in case the first spawn raced
    // with a dying leftover process ("nothing listening" on cold start).
    ensureDesktopAgent()
      .then(() => {
        setTimeout(() => {
          ensureDesktopAgent(true).catch((e) =>
            console.warn(`[Desktop Agent] Boot recheck failed: ${e?.message || e}`),
          );
        }, 4000);
      })
      .catch((e) =>
        console.warn(`[Desktop Agent] Boot probe failed: ${e?.message || e}`),
      );
  });
}

startServer().catch((error) => {
  console.error("Failed to start server startup sequence:", error);
  appendLogSync("startup.log", `STARTUP_FAILED ${error?.stack || error?.message || String(error)}`);
  // Exit non-zero so the Electron shell reports a real failure instead of
  // "exited unexpectedly (code 0)".
  process.exit(1);
});
