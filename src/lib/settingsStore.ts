/**
 * BIKLI Settings Store — persistent user preferences (V2).
 *
 * Establishes the persistence pattern for BIKLI: settings are mirrored to
 * localStorage (instant local read) AND synced to the backend (settings.json)
 * so auto-start / wake-word preferences survive across browsers and the
 * Python desktop agent can read them too.
 *
 * Pattern follows the existing codebase conventions: plain state + ref mirrors.
 * No Context/Zustand — this is deliberately lightweight to match audio.ts/memoryTypes.ts.
 */

export interface BikliSettings {
  /** Launch BIKLI (backends + browser tab) silently on Windows login. */
  autoStart: boolean;
  /** Enable the always-listening wake-word detector. */
  wakeWordEnabled: boolean;
  /** Phrase(s) that activate BIKLI (comma-separated; built-ins always included). */
  wakePhrase: string;
  /** Preferred microphone device id ("" = system default). */
  micDeviceId: string;
  /** Wake-word sensitivity: 0 (strict) .. 100 (loose). Affects debounce window. */
  sensitivity: number;
  /** Master toggle for UI animations. */
  animations: boolean;
  /**
   * Require the spoken control word before full PC + cursor control.
   * Default true: locked until the user says "control" (or configured phrase).
   */
  controlWordRequired: boolean;
  /** Phrase(s) that unlock full computer control (comma-separated). */
  controlPhrase: string;
  /**
   * Speech synthesis language for Bikli's voice.
   * "auto" lets Gemini detect it (best for mixed Hinglish); a BCP-47 code such
   * as "hi-IN" forces native phonetics for that language.
   */
  speechLanguage: string;
}

export const DEFAULT_SETTINGS: BikliSettings = {
  autoStart: false,
  wakeWordEnabled: true,
  // Comma-separated; built-ins always include hey / hi so they always turn Bikli on.
  wakePhrase: "hey, hi, hello, bikli, hey bikli, hi bikli",
  micDeviceId: "",
  // Higher default = shorter debounce so "hey"/"hi" feel instant
  sensitivity: 75,
  animations: true,
  // Mouse/PC control only after the user says the control word
  controlWordRequired: true,
  controlPhrase: "control, take control, computer control, full control",
  // Auto = Gemini picks per utterance, which handles Hinglish best.
  speechLanguage: "auto",
};

// v5: control word required again (mouse/PC only after "control")
const STORAGE_KEY = "bikli.settings.v5";

/** Settings keys that the browser should never persist (security). */
const NEVER_PERSIST: ReadonlySet<keyof BikliSettings> = new Set([]);

/**
 * Load settings from localStorage, merged over defaults so new keys always
 * have a sane value even when an older payload is present.
 */
export function loadSettings(): BikliSettings {
  if (typeof window === "undefined") return { ...DEFAULT_SETTINGS };
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(raw) as Partial<BikliSettings>;
    return { ...DEFAULT_SETTINGS, ...parsed };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

/**
 * Persist a full or partial settings update to localStorage.
 * Returns the fully merged settings object.
 */
export function saveSettings(patch: Partial<BikliSettings>): BikliSettings {
  const current = loadSettings();
  const next: BikliSettings = { ...current, ...patch };
  if (typeof window !== "undefined") {
    try {
      // Strip any sensitive keys before writing to localStorage.
      const safe: Record<string, unknown> = {};
      (Object.keys(next) as (keyof BikliSettings)[]).forEach((k) => {
        if (!NEVER_PERSIST.has(k)) safe[k] = next[k];
      });
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(safe));
    } catch {
      /* localStorage may be unavailable (private mode) — fail silently. */
    }
  }
  // Best-effort sync to backend so the Python agent can read auto-start state.
  void syncSettingsToBackend(next).catch(() => {});
  return next;
}

// Latest snapshot waiting to be pushed to the backend, plus an in-flight guard.
// Two rapid saves each fire a full-snapshot POST; without serialization the
// OLDER snapshot could arrive last and persist stale settings (e.g. an earlier
// autoStart value overriding the newer one the user just set).
let latestSyncSettings: BikliSettings | null = null;
let backendSyncRunning = false;

/** Push settings to the backend (server.ts persists to settings.json), coalesced. */
function syncSettingsToBackend(settings: BikliSettings): Promise<void> {
  latestSyncSettings = settings;
  if (backendSyncRunning) return Promise.resolve(); // the running loop will pick it up
  backendSyncRunning = true;
  const loop = (async () => {
    while (latestSyncSettings) {
      const toSend = latestSyncSettings;
      latestSyncSettings = null;
      try {
        await fetch("/api/settings", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(toSend),
        });
      } catch {
        /* Backend may be briefly unavailable during boot — non-fatal. */
      }
    }
  })().finally(() => {
    backendSyncRunning = false;
  });
  return loop;
}
