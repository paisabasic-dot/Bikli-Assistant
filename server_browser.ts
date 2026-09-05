/**
 * Agent-Browser Automation for BIKLI Node Server.
 *
 * Uses vercel-labs/agent-browser CLI to automate Chromium/Edge:
 * - Enforces same-tab navigation by default for all site visits and searches.
 * - Extracts live accessibility elements (snapshot -i) to click the EXACT
 *   on-screen video cards on YouTube when the user asks to "play 1st / first video"
 *   or "play another one".
 */

import { spawn, spawnSync } from "child_process";
import path from "path";
import fs from "fs";
import { resolveAgentBrowserExe } from "./server_paths";

export const AGENT_BROWSER_SESSION = "bikli_main";

function getAgentBrowserEnv(): Record<string, string> {
  const env: Record<string, string> = {
    ...process.env as Record<string, string>,
    AGENT_BROWSER_SESSION,
    AGENT_BROWSER_HEADED: "1",
    AGENT_BROWSER_PIN_TAB: "1",
  };

  const edgePaths = [
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    path.join(process.env.LOCALAPPDATA || "", "Microsoft", "Edge", "Application", "msedge.exe"),
  ];

  const chromePaths = [
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  ];

  const foundEdge = edgePaths.find((p) => p && fs.existsSync(p));
  if (foundEdge) {
    env.AGENT_BROWSER_EXECUTABLE_PATH = foundEdge;
  } else {
    const foundChrome = chromePaths.find((p) => p && fs.existsSync(p));
    if (foundChrome) {
      env.AGENT_BROWSER_EXECUTABLE_PATH = foundChrome;
    }
  }

  return env;
}

export function runAgentBrowserCmd(
  args: string[],
  timeoutMs = 25000,
): Promise<{ ok: boolean; stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve) => {
    const exe = resolveAgentBrowserExe();
    if (!exe || !fs.existsSync(exe)) {
      resolve({
        ok: false,
        stdout: "",
        stderr: `agent-browser binary not found at '${exe || "undefined"}'`,
        code: 1,
      });
      return;
    }

    const fullArgs = ["--session", AGENT_BROWSER_SESSION, ...args];
    const env = getAgentBrowserEnv();

    const child = spawn(exe, fullArgs, {
      env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";

    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {}
      resolve({
        ok: false,
        stdout,
        stderr: `${stderr}\nTimed out after ${timeoutMs}ms`,
        code: -1,
      });
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      // Ignore internal Chromium network data pipe upload stream diagnostics and missing MF on Windows N
      if (text.includes("chunked_data_pipe_upload_data_stream.cc") || text.includes("mf_initializer.cc")) return;
      stderr += text;
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        ok: code === 0,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        code,
      });
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({
        ok: false,
        stdout,
        stderr: String(err?.message || err),
        code: 1,
      });
    });
  });
}

/**
 * Open a URL in the browser, strictly reusing the existing active tab unless
 * newTab or newWindow is explicitly true.
 */
export async function agentBrowserOpenUrl(
  url: string,
  opts?: { newWindow?: boolean; newTab?: boolean },
): Promise<{ ok: boolean; url: string; mode: string; error?: string }> {
  const clean = String(url || "").trim();
  if (!clean) {
    return { ok: false, url: "", mode: "none", error: "Empty URL." };
  }
  const targetUrl = clean.includes("://") ? clean : `https://${clean}`;

  const wantNew = Boolean(opts?.newWindow || opts?.newTab);
  const args = wantNew ? ["tab", "new", targetUrl] : ["open", targetUrl];

  console.log(`[Agent-Browser] Navigating (${wantNew ? "new_tab" : "same_tab"}): ${targetUrl}`);
  const res = await runAgentBrowserCmd(args, 30000);

  if (!res.ok && res.stderr.includes("Navigation failed")) {
    console.warn(`[Agent-Browser] Open failed: ${res.stderr}`);
    return { ok: false, url: targetUrl, mode: wantNew ? "new_tab" : "same_tab", error: res.stderr };
  }

  return {
    ok: true,
    url: targetUrl,
    mode: wantNew ? "new_tab" : "same_tab",
  };
}

export interface VideoCard {
  title: string;
  ref: string;
  h_ref: string;
}

/**
 * Parse visible video cards from an interactive accessibility tree snapshot.
 */
export function parseYouTubeSnapshot(snapshotText: string): VideoCard[] {
  const items: VideoCard[] = [];
  const lines = snapshotText.split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const mHeading = /-\s+heading\s+"([^"]+)"\s+\[level=3,\s*ref=(e\d+)\]/.exec(line);
    if (mHeading) {
      const title = mHeading[1].trim();
      const h_ref = mHeading[2];
      let link_ref = "";

      // Look ahead up to 4 lines for child link ref
      for (let j = i + 1; j < Math.min(lines.length, i + 5); j++) {
        const mLink = /-\s+link\s+.*\[ref=(e\d+)\]/.exec(lines[j]);
        if (mLink) {
          link_ref = mLink[1];
          break;
        }
      }

      items.push({
        title,
        ref: link_ref || h_ref,
        h_ref,
      });
    }
  }

  return items;
}

/**
 * Normalizes text for robust title matching:
 * lowercases, removes emojis/brackets/clickbait punctuation, normalizes spaces.
 */
export function normalizeTitleText(text: string): string {
  return String(text || "")
    .toLowerCase()
    .replace(/[\[\(\{\]\)\}]/g, " ")
    .replace(/official\s+(music\s+)?(video|audio|trailer|lyric\s+video|hd|4k)/gi, " ")
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Computes match score (0 to 1) between spoken query and video card title.
 * Combines exact substring match + word token overlap.
 */
export function scoreTitleMatch(query: string, cardTitle: string): number {
  const normQ = normalizeTitleText(query);
  const normT = normalizeTitleText(cardTitle);

  if (!normQ || !normT) return 0;

  // 1. Direct exact substring match -> highest confidence
  if (normT.includes(normQ)) return 1.0;
  if (normQ.includes(normT)) return 0.95;

  // 2. Token overlap (Jaccard / intersection)
  const qTokens = normQ.split(" ").filter((w) => w.length > 1);
  const tTokens = new Set(normT.split(" ").filter((w) => w.length > 1));

  if (qTokens.length === 0 || tTokens.size === 0) return 0;

  let matched = 0;
  for (const q of qTokens) {
    if (tTokens.has(q)) {
      matched += 1.0;
      continue;
    }
    for (const t of tTokens) {
      if ((q.length >= 4 && t.includes(q)) || (t.length >= 4 && q.includes(t))) {
        matched += 0.8;
        break;
      }
    }
  }

  return matched / qTokens.length;
}

/**
 * Finds the best matching video card on screen given a spoken query.
 * Returns null if no card scores >= threshold (default 0.35).
 */
export function findBestMatchingCard(
  query: string,
  cards: VideoCard[],
  threshold = 0.35,
): { card: VideoCard; index: number; score: number } | null {
  if (!query || !cards.length) return null;

  let bestCard: VideoCard | null = null;
  let bestIndex = -1;
  let bestScore = 0;

  for (let i = 0; i < cards.length; i++) {
    const score = scoreTitleMatch(query, cards[i].title);
    if (score > bestScore) {
      bestScore = score;
      bestCard = cards[i];
      bestIndex = i + 1;
    }
  }

  if (bestCard && bestScore >= threshold) {
    return { card: bestCard, index: bestIndex, score: bestScore };
  }

  return null;
}

/**
 * Play the exact video on screen matching title, or N-th video in YouTube via agent-browser.
 */
export async function agentBrowserPlayYouTube(
  query = "",
  index = 1,
  opts?: { preferOnScreen?: boolean },
): Promise<{ ok: boolean; result?: Record<string, unknown>; error?: string }> {
  const idx = Math.max(1, Math.floor(Number(index) || 1));
  let cleanQ = String(query || "").trim();

  // Strip ordinal phrases from search query
  const isOrdinalOnly =
    /^(the\s+)?(first|1st|second|2nd|third|3rd|fourth|4th|fifth|5th|next|another|different|other)(\s+(video|one|result|clip|song))?$/i.test(
      cleanQ,
    ) ||
    /^(first|1st|second|2nd|third|3rd|fourth|4th|fifth|5th|video|result|one|this|that|next|another|different|other)$/i.test(
      cleanQ,
    );
  if (isOrdinalOnly) {
    cleanQ = "";
  }

  // Check current URL in agent-browser
  const urlRes = await runAgentBrowserCmd(["get", "url"], 8000);
  const currentUrl = urlRes.stdout.trim();
  const isOnYouTube = currentUrl.includes("youtube.com");

  // PRIORITY 1: ON-SCREEN TITLE MATCHING
  // If user specified a title and YouTube is already open, inspect the screen FIRST!
  // If that video is already on screen, click it directly without re-searching!
  if (cleanQ && isOnYouTube) {
    console.log(`[Agent-Browser Play] Checking active YouTube screen for title: "${cleanQ}"`);
    const snapRes = await runAgentBrowserCmd(["snapshot", "-i"], 10000);
    const visibleCards = parseYouTubeSnapshot(snapRes.stdout);
    const match = findBestMatchingCard(cleanQ, visibleCards, 0.35);

    if (match) {
      console.log(
        `[Agent-Browser Play] Found on-screen match #${match.index}: "${match.card.title}" (score ${match.score.toFixed(2)})`,
      );
      let clickRes = await runAgentBrowserCmd(["click", `@${match.card.ref}`], 10000);
      if (!clickRes.ok && match.card.h_ref && match.card.h_ref !== match.card.ref) {
        clickRes = await runAgentBrowserCmd(["click", `@${match.card.h_ref}`], 10000);
      }
      await new Promise((r) => setTimeout(r, 1000));
      const finalUrlRes = await runAgentBrowserCmd(["get", "url"], 6000);
      return {
        ok: true,
        result: {
          result: `Playing "${match.card.title}" on YouTube.`,
          title: match.card.title,
          index: match.index,
          ref: `@${match.card.ref}`,
          url: finalUrlRes.stdout.trim(),
          query: cleanQ,
          matchedOnScreen: true,
        },
      };
    }
    console.log(`[Agent-Browser Play] "${cleanQ}" not visible on current screen. Navigating to YouTube search...`);
  }

  // PRIORITY 2: SEARCH & AUTO-PLAY
  let needSearchNavigation = Boolean(cleanQ);
  if (cleanQ && currentUrl.includes("youtube.com/results")) {
    const enc = encodeURIComponent(cleanQ.toLowerCase());
    if (currentUrl.toLowerCase().includes(enc)) {
      needSearchNavigation = false;
    }
  }

  if (needSearchNavigation) {
    const searchUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(cleanQ)}`;
    await agentBrowserOpenUrl(searchUrl, { newWindow: false, newTab: false });
    await new Promise((r) => setTimeout(r, 2000));
  } else if (!isOnYouTube) {
    const searchUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(cleanQ || "trending")}`;
    await agentBrowserOpenUrl(searchUrl, { newWindow: false, newTab: false });
    await new Promise((r) => setTimeout(r, 2000));
  }

  // Snapshot active view
  let snapRes = await runAgentBrowserCmd(["snapshot", "-i"], 12000);
  let cards = parseYouTubeSnapshot(snapRes.stdout);

  if (!cards.length) {
    await new Promise((r) => setTimeout(r, 1500));
    snapRes = await runAgentBrowserCmd(["snapshot", "-i"], 12000);
    cards = parseYouTubeSnapshot(snapRes.stdout);
  }

  if (!cards.length) {
    if (cleanQ) {
      const fallbackUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(cleanQ)}`;
      return {
        ok: true,
        result: {
          result: `Opened YouTube search for "${cleanQ}" in the current tab. Say "play first video" to start playing.`,
          url: fallbackUrl,
          query: cleanQ,
        },
      };
    }
    return {
      ok: false,
      error: "Could not find any video cards on the current YouTube screen.",
    };
  }

  // If query was specified, pick best matching card from search results; otherwise use index
  let target: VideoCard;
  let targetIdx: number;
  if (cleanQ) {
    const match = findBestMatchingCard(cleanQ, cards, 0.25);
    if (match) {
      target = match.card;
      targetIdx = match.index;
    } else {
      targetIdx = Math.min(idx, cards.length);
      target = cards[targetIdx - 1];
    }
  } else {
    targetIdx = Math.min(idx, cards.length);
    target = cards[targetIdx - 1];
  }

  console.log(`[Agent-Browser Play] Clicking video #${targetIdx}: "${target.title}" (@${target.ref})`);

  let clickRes = await runAgentBrowserCmd(["click", `@${target.ref}`], 10000);
  if (!clickRes.ok && target.h_ref && target.h_ref !== target.ref) {
    console.log(`[Agent-Browser Play] Retrying click with heading ref @${target.h_ref}`);
    clickRes = await runAgentBrowserCmd(["click", `@${target.h_ref}`], 10000);
  }

  await new Promise((r) => setTimeout(r, 1000));
  const finalUrlRes = await runAgentBrowserCmd(["get", "url"], 6000);
  const finalUrl = finalUrlRes.stdout.trim();

  return {
    ok: true,
    result: {
      result: `Playing "${target.title}" on YouTube.`,
      title: target.title,
      index: targetIdx,
      ref: `@${target.ref}`,
      url: finalUrl,
      query: cleanQ,
    },
  };
}
