/**
 * BIKLI — path & secret resolution.
 *
 * Separates read-only *code/asset* locations (shipped with the app) from the
 * writable *data* location (per-user, survives reinstalls). In development both
 * collapse to the project root, so existing behaviour is unchanged. When the
 * packaged Electron app launches the backend it sets BIKLI_DATA_DIR to a
 * writable folder under %APPDATA%\BIKLI, because the install directory
 * (Program Files) is read-only.
 *
 * The Gemini API key is NOT shipped with the app. Each user supplies their own
 * on first run; it is stored here in the per-user data dir (never returned to
 * the frontend).
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const _currentDir =
  typeof __dirname !== "undefined"
    ? __dirname
    : typeof process !== "undefined"
      ? process.cwd()
      : ".";

/**
 * Read-only app root (code + bundled assets). Prefer BIKLI_APP_ROOT from
 * Electron; otherwise fall back to the process working directory.
 */
export const APP_ROOT: string = process.env.BIKLI_APP_ROOT || process.cwd();

/** Writable per-user data directory. Falls back to cwd in development. */
export const DATA_DIR: string = process.env.BIKLI_DATA_DIR || process.cwd();

try {
  fs.mkdirSync(DATA_DIR, { recursive: true });
} catch {
  /* already exists / best-effort */
}

/** Absolute path to a file inside the writable data directory. */
export function dataFile(name: string): string {
  return path.join(DATA_DIR, name);
}

/**
 * Locate the frozen desktop agent executable (PyInstaller build).
 * Order: explicit env → packaged Electron resource → local agent_dist build.
 */
export function resolveFrozenAgentExe(): string | undefined {
  const candidates = [
    process.env.BIKLI_AGENT_EXE,
    // Packaged Electron: resources/agent/bikli-agent.exe
    process.env.BIKLI_APP_ROOT
      ? path.join(path.dirname(process.env.BIKLI_APP_ROOT), "agent", "bikli-agent.exe")
      : "",
    path.join(APP_ROOT, "agent_dist", "bikli-agent", "bikli-agent.exe"),
    path.join(APP_ROOT, "agent_dist", "bikli-agent.exe"),
    path.join(_currentDir, "agent_dist", "bikli-agent", "bikli-agent.exe"),
    path.join(_currentDir, "agent_dist", "bikli-agent.exe"),
    path.join(_currentDir, "..", "agent_dist", "bikli-agent", "bikli-agent.exe"),
    path.join(_currentDir, "..", "agent_dist", "bikli-agent.exe"),
    path.join(process.cwd(), "agent_dist", "bikli-agent", "bikli-agent.exe"),
    path.join(process.cwd(), "agent_dist", "bikli-agent.exe"),
  ].filter(Boolean) as string[];

  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return c;
    } catch {
      /* ignore */
    }
  }
  return undefined;
}

/**
 * Locate the bundled agent-browser CLI executable.
 */
export function resolveAgentBrowserExe(): string | undefined {
  const exeName = process.platform === "win32" ? "agent-browser.exe" : "agent-browser";
  const candidates = [
    process.env.AGENT_BROWSER_PATH,
    process.env.BIKLI_APP_ROOT ? path.join(path.dirname(process.env.BIKLI_APP_ROOT), "bin", exeName) : "",
    path.join(APP_ROOT, "bin", exeName),
    path.join(_currentDir, "bin", exeName),
    path.join(process.cwd(), "bin", exeName),
    path.join(path.dirname(process.execPath), "bin", exeName),
    path.join(path.dirname(APP_ROOT), "bin", exeName),
  ].filter(Boolean) as string[];

  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return c;
    } catch {
      /* ignore */
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Gemini API key store (secrets.json in the data dir).
// ---------------------------------------------------------------------------
const SECRETS_FILE = dataFile("secrets.json");

interface Secrets {
  geminiApiKey?: string;
}

function readSecrets(): Secrets {
  try {
    if (fs.existsSync(SECRETS_FILE)) {
      return JSON.parse(fs.readFileSync(SECRETS_FILE, "utf-8")) as Secrets;
    }
  } catch {
    /* corrupt — treat as empty */
  }
  return {};
}

/**
 * Resolve the active Gemini API key.
 * Priority: user-entered key (secrets.json) → environment (.env, dev only).
 */
export function getGeminiApiKey(): string | undefined {
  const stored = readSecrets().geminiApiKey?.trim();
  if (stored) return stored;
  const env = process.env.GEMINI_API_KEY?.trim();
  return env || undefined;
}

/** Whether any usable key is configured (without revealing it). */
export function hasGeminiApiKey(): boolean {
  return Boolean(getGeminiApiKey());
}

/**
 * Where the active key comes from:
 * - "user": stored in the per-user secrets file (editable / deletable from UI)
 * - "env":  from GEMINI_API_KEY (dev-only) — cannot be removed from the UI
 * - "none": no key configured
 */
export function getGeminiApiKeySource(): "user" | "env" | "none" {
  const stored = readSecrets().geminiApiKey?.trim();
  if (stored) return "user";
  return process.env.GEMINI_API_KEY?.trim() ? "env" : "none";
}

/** Persist a user-supplied key to the per-user secrets file. */
export function setGeminiApiKey(key: string): void {
  const trimmed = (key || "").trim();
  if (!trimmed) throw new Error("API key must not be empty.");
  const current = readSecrets();
  current.geminiApiKey = trimmed;
  fs.writeFileSync(SECRETS_FILE, JSON.stringify(current, null, 2), "utf-8");
  try {
    fs.chmodSync(SECRETS_FILE, 0o600); // owner-only where supported
  } catch {
    /* Windows ACLs differ; best-effort */
  }
}

/** Remove the stored key (used by "reset"/sign-out flows). */
export function clearGeminiApiKey(): void {
  const current = readSecrets();
  delete current.geminiApiKey;
  try {
    fs.writeFileSync(SECRETS_FILE, JSON.stringify(current, null, 2), "utf-8");
  } catch {
    /* best-effort */
  }
}
