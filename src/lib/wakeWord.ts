/**
 * BIKLI Wake Word Detector (V2).
 *
 * Uses the browser-native Web Speech API (webkitSpeechRecognition) for
 * continuous, always-listening keyword detection. Zero dependencies, runs
 * entirely in the BIKLI window (Electron / Chromium).
 *
 * Design goals:
 *   - Flexible greetings: "bikli", "hey", "hi", "hello", "hey bikli", "hey hi"
 *   - Survives SpeechRecognition auto-stop / network blips
 *   - Releases the microphone cleanly before handing off to the live session
 *     (the old bug: wake fired, chime played, but getUserMedia failed because
 *     SpeechRecognition still held the mic)
 *   - Always re-arms if the live session fails to start
 *   - Activation sound + state callback on detection
 */

// --- Minimal typed shim for the unprefixed SpeechRecognition API -------------
interface SpeechRecognitionLike {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  maxAlternatives: number;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((e: any) => void) | null;
  onerror: ((e: any) => void) | null;
  onend: (() => void) | null;
  onstart: (() => void) | null;
}

type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

function getSpeechRecognitionCtor(): SpeechRecognitionCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as any;
  return (w.SpeechRecognition || w.webkitSpeechRecognition || null) as
    | SpeechRecognitionCtor
    | null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Built-in phrases that always wake Bikli, even if settings only list one.
 * Primary triggers: "hey" and "hi" (alone or with extra words).
 */
export const DEFAULT_WAKE_PHRASES: readonly string[] = [
  "hey",
  "hi",
  "hello",
  "bikli",
  "hey bikli",
  "hi bikli",
  "hello bikli",
  "hey hi",
  "hi hey",
  "ok bikli",
  "okay bikli",
  "yo bikli",
  "wake up",
  "wakeup",
  "wake up bikli",
  "wakeup bikli",
];

/**
 * Primary short greets that turn Bikli ON.
 * Matched as whole words so "history" ≠ "hi".
 */
const PRIMARY_GREETS: readonly string[] = [
  "hey",
  "hi",
  "hello",
  "yo",
];

/**
 * Common SpeechRecognition mis-hearings of "hey" / "hi".
 * STT often mangles short greets (user said "hi" → "hhi", "hay", etc.).
 */
const GREET_ALIASES: readonly string[] = [
  "hey",
  "hi",
  "hello",
  "hhi",
  "hii",
  "hiii",
  "hay",
  "hei",
  "heyy",
  "heyyy",
  // NOTE: "he" was removed — it is a top English word ("he said that") and
  // matched as a whole word, causing frequent false wakes from ordinary speech.
  "aye",
  "ey",
  "hola",
  "hallo",
  "howdy",
];

/**
 * Common SpeechRecognition mis-hearings of "bikli".
 * Google STT often turns the name into these.
 */
const BIKLI_ALIASES: readonly string[] = [
  "bikli",
  "bickly",
  "bickley",
  "beakly",
  "beakley",
  "bigly",
  "bigley",
  "weekly",
  "weakly",
  "brickly",
  "bricly",
  "piccoli",
  "piccolo",
  "beekly",
  "bikely",
  "bikley",
  "bik li",
  "big lee",
  "beak lee",
  "beek lee",
  "pikli",
  "pickly",
  "pickle",
  "pickley",
];

/** Split a settings string into individual phrases (comma / | / ; / newline). */
export function parseWakePhrases(input: string | undefined | null): string[] {
  if (!input) return [];
  return input
    .split(/[,|;/\n]+/)
    .map((p) => p.toLowerCase().trim())
    .filter((p) => p.length > 0);
}

/**
 * Merge user phrases with built-ins (deduped, lowercase).
 * Always ensures hey/hi are present so voice-on never depends on settings alone.
 */
export function resolveWakePhrases(userPhrase: string | undefined | null): string[] {
  const custom = parseWakePhrases(userPhrase);
  const merged = new Set<string>([
    ...DEFAULT_WAKE_PHRASES,
    ...PRIMARY_GREETS,
    ...custom,
  ]);
  return Array.from(merged);
}

function normalizeTranscript(transcript: string): string {
  return transcript
    .toLowerCase()
    // collapse repeated letters often produced by STT ("hhi" / "heyy")
    .replace(/[^\w\s']/g, " ")
    .replace(/\bwakeup\b/g, "wake up")
    .replace(/\s+/g, " ")
    .trim();
}

/** Soft-normalize STT glitches: "hhi"→"hi", "heyy"→"hey" for matching only. */
function softNormalizeGreetGlitches(text: string): string {
  return text
    .replace(/\bh{2,}i+\b/g, "hi") // hhi, hhii, hiii → hi
    .replace(/\bhe+y+\b/g, "hey") // heey, heyy → hey
    .replace(/\bhay\b/g, "hey")
    .replace(/\bhei\b/g, "hey")
    .replace(/\bheyhi\b/g, "hey hi") // heyhi → hey hi
    .replace(/\bhihi\b/g, "hi hi") // hihi → hi hi
    .replace(/\bheyhey\b/g, "hey hey"); // heyhey → hey hey
}

/**
 * True if transcript matches any wake phrase.
 * - Saying "hey" or "hi" alone ALWAYS turns Bikli on
 * - Multi-word / longer phrases: case-insensitive substring
 * - Short greets: whole-word match so "high" ≠ "hi"
 * - Name aliases and STT mis-hearings also wake
 */
export function transcriptMatchesWake(transcript: string, phrases: string[]): boolean {
  const raw = normalizeTranscript(transcript);
  if (!raw) return false;
  const text = softNormalizeGreetGlitches(raw);

  // 1) PRIMARY: "hey" / "hi" / "hello" / "yo" as whole words — always wake
  for (const g of PRIMARY_GREETS) {
    if (new RegExp(`\\b${g}\\b`).test(text)) return true;
  }

  // 2) Greet aliases / STT glitches as whole words
  for (const alias of GREET_ALIASES) {
    const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`\\b${escaped}\\b`).test(raw) || new RegExp(`\\b${escaped}\\b`).test(text)) {
      return true;
    }
  }

  // 3) Exact short utterance is just a greet alias (entire phrase)
  if (GREET_ALIASES.includes(raw) || GREET_ALIASES.includes(text)) return true;
  if (raw.length <= 6 && /^(h+i+|he+y+|hello|yo)$/.test(raw)) return true;

  // 4) Name (and common mis-hearings) as whole words
  for (const alias of BIKLI_ALIASES) {
    const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
    if (new RegExp(`\\b${escaped}\\b`).test(text)) return true;
  }

  // 5) Explicit wake-up phrasing
  if (/\b(wake\s+up|wakeup)\b/.test(text)) return true;

  // 5b) Common greet pairs: "hey hi", "hi hey" — treat as single trigger
  if (/\b(hey\s+hi|hi\s+hey)\b/.test(text) || /\b(hey\s+hi|hi\s+hey)\b/.test(raw)) {
    return true;
  }

  // 6) User-configured phrases
  for (const phrase of phrases) {
    if (!phrase) continue;
    const p = normalizeTranscript(phrase);
    if (!p) continue;

    if (p.includes(" ") || p.length > 5) {
      if (text.includes(p) || raw.includes(p)) return true;
      continue;
    }
    // Short single tokens: whole-word match.
    const escaped = p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`\\b${escaped}\\b`);
    if (re.test(text) || re.test(raw)) return true;
  }
  return false;
}

export type WakeWordState = "stopped" | "listening" | "triggered" | "error" | "starting";

export interface WakeWordOptions {
  /**
   * Phrase(s) to match. Comma-separated list is supported, e.g.
   * "bikli, hey, hi". Built-in greets are always included as well.
   */
  phrase: string;
  /** 0 (strict) .. 100 (loose). Higher = shorter debounce, more matches. */
  sensitivity?: number;
  /**
   * Fired once when the phrase is detected.
   * The detector has already stopped SpeechRecognition and waited for the
   * mic to be released, so it is safe to call getUserMedia immediately.
   * Return true/void if the live session started, false if it failed
   * (detector will re-arm automatically).
   */
  onTriggered?: () => void | boolean | Promise<void | boolean>;
  /** Fired whenever the detector state changes. */
  onState?: (state: WakeWordState) => void;
  /** Optional preferred microphone deviceId ("" = system default). */
  micDeviceId?: string;
}

export class BikliWakeWordDetector {
  private recognition: SpeechRecognitionLike | null = null;
  private ctor: SpeechRecognitionCtor | null;
  private phrases: string[] = resolveWakePhrases("bikli, hey, hi");
  private sensitivity = 60;
  private onTriggered: (() => void | boolean | Promise<void | boolean>) | null = null;
  private onState: ((s: WakeWordState) => void) | null = null;
  private micDeviceId = "";

  /** True when the user intends the detector to be running. */
  private intended = false;
  /** True while the underlying recognition is actively listening. */
  private active = false;
  /** True while we are in the middle of a trigger handoff. */
  private firing = false;
  /** Guards against rapid double-fires of the same utterance. */
  private lastTrigger = 0;
  /** True when stop() was called during a firing handoff — prevents auto re-arm. */
  private stopRequestedDuringFire = false;
  /** Debounce window (ms) — derived from sensitivity. */
  private debounceMs = 1800;
  /** Backoff for restart after repeated errors. */
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private consecutiveErrors = 0;
  private currentState: WakeWordState = "stopped";
  /** Last options so we can re-arm after a failed handoff without App help. */
  private lastOpts: WakeWordOptions | null = null;
  /** Prevents onend double-scheduling a restart after onerror already did. */
  private _hasPendingErrorRestart = false;

  constructor() {
    this.ctor = getSpeechRecognitionCtor();
  }

  /** Whether this browser supports wake-word detection at all. */
  static isSupported(): boolean {
    return getSpeechRecognitionCtor() !== null;
  }

  get state(): WakeWordState {
    return this.currentState;
  }

  /** Begin continuously listening. Safe to call repeatedly. */
  start(opts: WakeWordOptions): boolean {
    if (!this.ctor) {
      this.setState("error");
      console.error("[WakeWord] SpeechRecognition API not available in this environment.");
      return false;
    }
    // Mid-handoff: only refresh callbacks/options — do NOT tear down.
    if (this.firing) {
      this.lastOpts = opts;
      this.phrases = resolveWakePhrases(opts.phrase || "bikli, hey, hi");
      this.sensitivity = opts.sensitivity ?? this.sensitivity;
      this.onTriggered = opts.onTriggered ?? this.onTriggered;
      this.onState = opts.onState ?? this.onState;
      this.micDeviceId = opts.micDeviceId ?? this.micDeviceId;
      return true;
    }

    this.lastOpts = opts;
    this.phrases = resolveWakePhrases(opts.phrase || "bikli, hey, hi");
    this.sensitivity = opts.sensitivity ?? this.sensitivity;
    this.onTriggered = opts.onTriggered ?? null;
    this.onState = opts.onState ?? null;
    this.micDeviceId = opts.micDeviceId || "";
    // sensitivity 0..100 -> debounce 1800ms..400ms (higher sens = faster re-arm)
    this.debounceMs = Math.round(1800 - (this.sensitivity / 100) * 1400);
    this.intended = true;
    this.consecutiveErrors = 0;
    this.setState("starting");
    // Already listening with same intent — soft relaunch only if inactive.
    if (this.active && this.recognition) {
      this.setState("listening");
      return true;
    }
    // Pre-warm mic permission so SpeechRecognition can open the device.
    void this.prewarmMic().finally(() => {
      if (this.intended && !this.firing) this.launch();
    });
    return true;
  }

  /**
   * Soft re-arm after window focus / network blip without resetting phrase config.
   * Safe to call frequently.
   */
  ensureListening(): void {
    if (!this.ctor || !this.intended || this.firing) return;
    if (this.active && this.recognition) return;
    if (this.lastOpts) {
      void this.prewarmMic().finally(() => {
        if (this.intended && !this.firing) this.launch();
      });
    } else {
      this.launch();
    }
  }

  /** Fully stop listening and clear timers. */
  stop(): void {
    // Do not abort mid-handoff — fire() owns mic release + connect.
    if (this.firing) {
      if (this.restartTimer) {
        clearTimeout(this.restartTimer);
        this.restartTimer = null;
      }
      // Mark that we should NOT re-arm after handoff if App asked to stop
      this.stopRequestedDuringFire = true;
      this.intended = false;
      return;
    }
    this.intended = false;
    this.firing = false;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    this.teardown();
    this.setState("stopped");
  }

  /** Change the wake phrase live without a full restart. */
  setPhrase(phrase: string): void {
    this.phrases = resolveWakePhrases(phrase || "bikli, hey, hi");
  }

  /** Change sensitivity live. */
  setSensitivity(value: number): void {
    this.sensitivity = Math.max(0, Math.min(100, value));
    // Must match the formula in start() — sensitivity 0..100 -> debounce 1800ms..400ms
    this.debounceMs = Math.round(1800 - (this.sensitivity / 100) * 1400);
  }

  // --- internals --------------------------------------------------------

  /**
   * Briefly open then close the mic so Chromium/Electron has an active
   * media permission grant. SpeechRecognition often fails with "not-allowed"
   * until getUserMedia has succeeded at least once.
   * Tries simplest constraints first — { audio: true } is most reliable
   * across different Windows audio drivers.
   */
  private async prewarmMic(): Promise<void> {
    try {
      if (!navigator.mediaDevices?.getUserMedia) return;
      let stream: MediaStream | null = null;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch {
        try {
          stream = await navigator.mediaDevices.getUserMedia({
            audio: {
              echoCancellation: true,
              noiseSuppression: true,
              autoGainControl: true,
            },
          });
        } catch {
          if (this.micDeviceId) {
            stream = await navigator.mediaDevices.getUserMedia({
              audio: { deviceId: { ideal: this.micDeviceId } },
            });
          }
        }
      }
      if (stream) {
        stream.getTracks().forEach((t) => {
          try {
            t.stop();
          } catch {
            /* ignore */
          }
        });
      }
      // Give the OS a beat to fully release the capture device.
      await sleep(200);
    } catch (err) {
      console.warn("[WakeWord] Mic prewarm failed (will still try SpeechRecognition):", err);
    }
  }

  private launch(): void {
    if (!this.ctor || !this.intended || this.firing) return;
    this.teardown();
    // A previous cycle may have left this set (e.g. onerror fired while the
    // detector was stopped, so onend never consumed it). A stale true here
    // makes the NEXT natural onend skip its restart and the detector dies.
    this._hasPendingErrorRestart = false;
    try {
      const rec = new this.ctor();
      rec.continuous = true;
      rec.interimResults = true;
      // Prefer user language; en-US is the most reliable for "hey/hi/bikli".
      try {
        const navLang = (typeof navigator !== "undefined" && navigator.language) || "en-US";
        rec.lang = navLang.toLowerCase().startsWith("en") ? navLang : "en-US";
      } catch {
        rec.lang = "en-US";
      }
      // Keep alternatives low — some Electron builds break with high values.
      rec.maxAlternatives = 3;

      rec.onstart = () => {
        this.consecutiveErrors = 0;
        this.active = true;
        if (this.intended && !this.firing) {
          this.setState("listening");
        }
        console.log("[WakeWord] Listening for:", this.phrases.join(", "));
      };

      rec.onresult = (e: any) => {
        if (!this.intended || this.firing) return;
        // Inspect every alternative of every result since last index.
        for (let i = e.resultIndex; i < e.results.length; i++) {
          const res = e.results[i];
          if (!res) continue;
          // Prefer final results but also accept strong interim matches
          // so wake feels instant.
          for (let j = 0; j < res.length; j++) {
            const transcript = (res[j]?.transcript || "").toString();
            if (!transcript) continue;
            if (transcriptMatchesWake(transcript, this.phrases)) {
              console.log("[WakeWord] MATCH:", transcript, res.isFinal ? "(final)" : "(interim)");
              void this.fire(transcript);
              return;
            }
          }
        }
      };

      rec.onerror = (e: any) => {
        const err = e?.error || "unknown";
        // Benign — browser pauses after silence; onend will restart.
        if (err === "no-speech" || err === "aborted") {
          return;
        }
        this.consecutiveErrors++;
        console.warn("[WakeWord] error:", err, `(#${this.consecutiveErrors})`);

        if (err === "audio-capture") {
          // Mic busy — relaunch after a beat.
          if (this.intended && !this.firing) {
            // Claim the restart so onend (which fires right after onerror)
            // does not clear this timer and relaunch immediately instead.
            this._hasPendingErrorRestart = true;
            if (this.restartTimer) clearTimeout(this.restartTimer);
            this.restartTimer = setTimeout(() => {
              this._hasPendingErrorRestart = false;
              if (this.intended && !this.firing) this.launch();
            }, 900);
          }
          return;
        }

        if (err === "not-allowed" || err === "service-not-allowed") {
          this.setState("error");
          // Prewarm mic again then retry — common after install / first run.
          if (this.intended && !this.firing) {
            // Without claiming the restart, onend cancels this timer and
            // relaunches without the prewarm, so the permission never recovers.
            this._hasPendingErrorRestart = true;
            if (this.restartTimer) clearTimeout(this.restartTimer);
            this.restartTimer = setTimeout(() => {
              this._hasPendingErrorRestart = false;
              if (!this.intended || this.firing) return;
              void this.prewarmMic().finally(() => {
                if (this.intended && !this.firing) this.launch();
              });
            }, 2500);
          }
          return;
        }

        // "network" is very common in Electron (Google STT blip) — never give up.
        // Mark a flag so onend doesn't also schedule a restart.
        this._hasPendingErrorRestart = true;
        if (this.intended && !this.firing) {
          const delay =
            err === "network"
              ? Math.min(400 + this.consecutiveErrors * 200, 4000)
              : Math.min(500 + this.consecutiveErrors * 300, 5000);
          if (this.restartTimer) clearTimeout(this.restartTimer);
          this.restartTimer = setTimeout(() => {
            this._hasPendingErrorRestart = false;
            this.consecutiveErrors = Math.min(this.consecutiveErrors, 3);
            if (this.intended && !this.firing) this.launch();
          }, delay);
        }
      };

      rec.onend = () => {
        this.active = false;
        if (!this.intended || this.firing) return;
        // If onerror already scheduled a restart, don't schedule another.
        if (this._hasPendingErrorRestart) {
          this._hasPendingErrorRestart = false;
          return;
        }
        // Always auto-recover — SpeechRecognition ends often (silence / network).
        const delay = Math.min(120 + this.consecutiveErrors * 80, 2000);
        if (this.restartTimer) clearTimeout(this.restartTimer);
        this.restartTimer = setTimeout(() => {
          if (this.intended && !this.firing) this.launch();
        }, delay);
      };

      this.recognition = rec;
      rec.start();
    } catch (err) {
      console.error("[WakeWord] launch failed:", err);
      // InvalidStateError often means already started — teardown and retry.
      if (this.restartTimer) clearTimeout(this.restartTimer);
      this.restartTimer = setTimeout(() => {
        if (this.intended && !this.firing) this.launch();
      }, 600);
    }
  }

  private teardown(): void {
    if (this.recognition) {
      try {
        this.recognition.onresult = null;
        this.recognition.onerror = null;
        this.recognition.onend = null;
        this.recognition.onstart = null;
        // Prefer stop() then abort() so the OS releases the capture device.
        try {
          this.recognition.stop();
        } catch {
          /* ignore */
        }
        try {
          this.recognition.abort();
        } catch {
          /* ignore */
        }
      } catch {
        /* ignore */
      }
      this.recognition = null;
    }
    this.active = false;
  }

  /**
   * Critical path: release SpeechRecognition's mic hold BEFORE calling the
   * connect handler, otherwise getUserMedia fails and the mic never turns on.
   */
  private async fire(_transcript: string): Promise<void> {
    const now = Date.now();
    if (this.firing) return;
    if (now - this.lastTrigger < this.debounceMs) return;
    // Record this trigger so the debounce guard above actually debounces —
    // lastTrigger was never assigned, so rapid re-fires (e.g. the user is still
    // talking after a failed connect re-arms the detector) were never blocked.
    this.lastTrigger = now;
    this.stopRequestedDuringFire = false;
    this.firing = true;
    // Pause auto-restart during handoff (but keep lastOpts for re-arm).
    this.intended = false;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }

    await this.playActivationSound();
    this.setState("triggered");

    // Kill SpeechRecognition so it releases the microphone.
    this.teardown();
    // Windows / Chromium needs a real pause after abort before getUserMedia.
    // Probe the mic until it opens, so live connect does not race the OS.
    await sleep(400);
    await this.waitForMicFree(6000);
    // Extra settle after probe closed the track (live connect opens next).
    await sleep(200);

    let success = false;
    try {
      if (!this.onTriggered) {
        console.error("[WakeWord] No onTriggered handler — cannot turn Bikli on");
        success = false;
      } else {
        const result = await this.onTriggered();
        // Only true counts as success — false/undefined means not live yet.
        success = result === true;
      }
    } catch (err) {
      console.error("[WakeWord] onTriggered handler failed:", err);
      success = false;
    } finally {
      this.firing = false;
    }

    // If stop() was called during firing, respect it and do NOT re-arm.
    if (this.stopRequestedDuringFire) {
      console.log("[WakeWord] stop() was requested during fire — skipping re-arm");
      this.stopRequestedDuringFire = false;
      this.setState("stopped");
      return;
    }

    // If the live session did not take over, re-arm wake listening automatically.
    if (!success) {
      console.warn("[WakeWord] Live session did not start — re-arming wake word…");
      await sleep(900);
      if (this.lastOpts) {
        this.start(this.lastOpts);
      }
    }
  }

  /** Open+close mic until it works, proving the device is free for live session. */
  private async waitForMicFree(budgetMs: number): Promise<void> {
    if (!navigator.mediaDevices?.getUserMedia) {
      await sleep(800);
      return;
    }
    const deadline = Date.now() + budgetMs;
    let attempt = 0;
    const preferredId = this.micDeviceId;
    while (Date.now() < deadline) {
      attempt++;
      try {
        let stream: MediaStream;
        // Try the simplest constraint first — bare boolean often works best
        // on Windows after SpeechRecognition releases the device.
        if (attempt <= 2) {
          stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        } else if (preferredId && attempt <= 4) {
          stream = await navigator.mediaDevices.getUserMedia({
            audio: {
              deviceId: { ideal: preferredId },
              echoCancellation: true,
              noiseSuppression: true,
            },
          });
        } else {
          // Full constraints after basic stuff worked.
          try {
            stream = await navigator.mediaDevices.getUserMedia({
              audio: {
                echoCancellation: { exact: true },
                noiseSuppression: { exact: true },
              },
            });
          } catch {
            stream = await navigator.mediaDevices.getUserMedia({
              audio: { echoCancellation: true, noiseSuppression: true },
            });
          }
        }
        stream.getTracks().forEach((t) => {
          try {
            t.stop();
          } catch {
            /* ignore */
          }
        });
        // Device opened successfully — brief settle, then hand off to live connect.
        await sleep(200);
        return;
      } catch (err) {
        const name = String((err as any)?.name || "");
        // NotAllowedError / SecurityError is permanent — stop waiting.
        if (name === "NotAllowedError" || name === "SecurityError") {
          await sleep(300);
          return;
        }
        console.warn(`[WakeWord] mic free probe #${attempt} failed (${name}):`, err);
        await sleep(300 + attempt * 100);
      }
    }
    // Last resort delay even if probe never succeeded.
    await sleep(400);
  }

  /** Soft two-tone chime synthesized via Web Audio (no asset needed). */
  private async playActivationSound(): Promise<void> {
    try {
      const Ctx =
        (window as any).AudioContext || (window as any).webkitAudioContext;
      if (!Ctx) return;
      const ctx: AudioContext = new Ctx();
      // Resume in case the context starts suspended (autoplay policy).
      try {
        if (ctx.state === "suspended") {
          await ctx.resume();
        }
      } catch {
        /* best-effort */
      }
      const now = ctx.currentTime;
      const notes = [
        { f: 660, t: 0 },
        { f: 880, t: 0.12 },
      ];
      notes.forEach(({ f, t }) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = "sine";
        osc.frequency.value = f;
        gain.gain.setValueAtTime(0.0001, now + t);
        gain.gain.exponentialRampToValueAtTime(0.18, now + t + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, now + t + 0.18);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(now + t);
        osc.stop(now + t + 0.2);
      });
      setTimeout(() => ctx.close().catch(() => {}), 600);
    } catch {
      /* audio is best-effort */
    }
  }

  private setState(s: WakeWordState): void {
    this.currentState = s;
    try {
      this.onState?.(s);
    } catch {
      /* ignore */
    }
  }

  /** Whether the underlying recognition is currently active. */
  get isActive(): boolean {
    return this.active;
  }
}

