/**
 * AI image generation from Node.
 *
 * Mirrors desktop_agent/tools_image.py so BIKLI can still create pictures when
 * the Python agent is old (a frozen bikli-agent.exe built before tools_image.py
 * existed reports "Unknown tool 'generateImage'"), missing, or too slow.
 *
 * Every call produces a BRAND NEW image: a fresh random seed is sent to the
 * provider and the filename is uniquified, so "generate another one" never
 * returns the previous picture.
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { spawn } from "child_process";

export const IMAGE_TOOLS = new Set(["generateImage"]);

/** Image generation talks to a remote provider — far slower than a click. */
export const IMAGE_GEN_TIMEOUT_MS = 90_000;

const HOME = os.homedir();

/** Resolve the real user Pictures / Desktop / Downloads / Documents folder. */
function resolveOutputDir(folderName: string): string {
  const fn = (folderName || "Pictures").trim().toLowerCase();
  const oneDrive = process.env.OneDrive || process.env.OneDriveConsumer || "";

  let candidates: string[];
  let useSubfolder = true;

  if (fn.includes("desktop")) {
    candidates = [path.join(HOME, "Desktop"), oneDrive ? path.join(oneDrive, "Desktop") : ""];
  } else if (fn.includes("download")) {
    candidates = [path.join(HOME, "Downloads")];
    useSubfolder = false;
  } else if (fn.includes("document")) {
    candidates = [path.join(HOME, "Documents"), oneDrive ? path.join(oneDrive, "Documents") : ""];
    useSubfolder = false;
  } else {
    candidates = [path.join(HOME, "Pictures"), oneDrive ? path.join(oneDrive, "Pictures") : ""];
  }

  for (const base of candidates) {
    if (!base) continue;
    try {
      if (!fs.statSync(base).isDirectory()) continue;
    } catch {
      continue;
    }
    const outDir = useSubfolder ? path.join(base, "Bikli_Images") : base;
    try {
      fs.mkdirSync(outDir, { recursive: true });
      return outDir;
    } catch {
      /* try the next candidate */
    }
  }

  const fallback = path.join(HOME, "Pictures", "Bikli_Images");
  fs.mkdirSync(fallback, { recursive: true });
  return fallback;
}

/** First few prompt words as a safe filename stem. */
function slugify(text: string): string {
  const cleaned = text
    .toLowerCase()
    .replace(/[^\w\s-]/g, "")
    .trim();
  const slug = cleaned.split(/\s+/).filter(Boolean).slice(0, 5).join("_");
  return slug || "generated_image";
}

/** Never overwrite an existing picture — the user asked for a NEW one. */
function uniquePath(dir: string, fileName: string): string {
  const ext = path.extname(fileName) || ".jpg";
  const stem = path.basename(fileName, ext);
  let candidate = path.join(dir, `${stem}${ext}`);
  let n = 2;
  while (fs.existsSync(candidate)) {
    candidate = path.join(dir, `${stem}_${n}${ext}`);
    n++;
  }
  return candidate;
}

/** Open the saved picture in the default photo viewer (best effort). */
function openInViewer(filePath: string): boolean {
  try {
    if (process.platform === "win32") {
      // `start` is a cmd builtin; the empty "" is the window title argument.
      spawn("cmd", ["/c", "start", "", filePath], {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      }).unref();
    } else {
      spawn("xdg-open", [filePath], { detached: true, stdio: "ignore" }).unref();
    }
    return true;
  } catch {
    try {
      spawn("explorer", [filePath], { detached: true, stdio: "ignore" }).unref();
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * Generate an AI image, save it into the user's picture folder and open it.
 * Same result shape as the Python tool so the caller can't tell them apart.
 */
export async function generateImageViaNode(
  args: Record<string, unknown>,
): Promise<{ ok: boolean; result?: Record<string, unknown>; error?: string }> {
  const prompt = String(args?.prompt ?? args?.description ?? args?.text ?? "").trim();
  if (!prompt) {
    return { ok: false, error: "Parameter 'prompt' is required for generateImage." };
  }

  const outDir = resolveOutputDir(String(args?.folder ?? "Pictures"));

  let fileName = String(args?.filename ?? "").trim();
  if (fileName) {
    if (!/\.(jpe?g|png|webp)$/i.test(fileName)) fileName += ".jpg";
    fileName = fileName.replace(/[\\/:*?"<>|]/g, "_");
  } else {
    fileName = `${slugify(prompt)}_${Math.floor(Math.random() * 9000) + 1000}.jpg`;
  }
  const filePath = uniquePath(outDir, fileName);

  // Fresh seed on every call — same prompt still yields a different picture.
  const seed = Math.floor(Math.random() * 999_999) + 1;
  const url =
    `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}` +
    `?width=1024&height=1024&seed=${seed}&nologo=true`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), IMAGE_GEN_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Bikli/1.0",
        Accept: "image/jpeg,image/png,image/*",
      },
    });
    if (!res.ok) {
      return { ok: false, error: `Image provider returned HTTP ${res.status}.` };
    }
    const data = Buffer.from(await res.arrayBuffer());
    if (data.length < 1000) {
      return { ok: false, error: "Image provider returned empty or corrupt data." };
    }
    fs.writeFileSync(filePath, data);
  } catch (err: any) {
    const timedOut = err?.name === "AbortError";
    return {
      ok: false,
      error: timedOut
        ? "Image generation timed out — the provider took too long."
        : `Failed to generate image: ${err?.message || err}`,
    };
  } finally {
    clearTimeout(timer);
  }

  const absPath = path.resolve(filePath);
  const opened = openInViewer(absPath);

  return {
    ok: true,
    result: {
      result:
        `Image successfully generated for '${prompt}' and saved to '${absPath}'.` +
        (opened ? " Opened image in Photo Viewer." : ""),
      path: absPath,
      filename: path.basename(absPath),
      prompt,
      opened,
      ok: true,
    },
  };
}
