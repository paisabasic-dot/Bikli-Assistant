/**
 * Audio handling utility for Bikli Live API Voice stream.
 * Handles:
 * - 16kHz layout sampling for microphone stream.
 * - Raw Little Endian Int16 PCM translation.
 * - 24kHz layout output sampling for model voice playback.
 * - Gapless double-buffer queue scheduler.
 * - Interrupt signal immediate stop.
 * - Input & Output AnalyserNodes for real-time waveform visuals.
 */

export type LiveState = "disconnected" | "connecting" | "listening" | "speaking";

// PCM Conversion Helper: converts Float32Array [-1.0, 1.0] to signed Int16 Raw PCM Little Endian
function floatTo16BitPCM(input: Float32Array): ArrayBuffer {
  const buffer = new ArrayBuffer(input.length * 2);
  const view = new DataView(buffer);
  let offset = 0;
  for (let i = 0; i < input.length; i++, offset += 2) {
    let s = Math.max(-1, Math.min(1, input[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
  }
  return buffer;
}

// Float conversion helper: converts signed Int16 array buffer to Float32Array [-1.0, 1.0]
function pcm16ToFloats(uint8Array: Uint8Array): Float32Array {
  // A truncated frame with an odd byte count would make the Int16Array
  // constructor throw RangeError and kill the whole playback chunk.
  const int16 = new Int16Array(
    uint8Array.buffer,
    uint8Array.byteOffset,
    Math.floor(uint8Array.byteLength / 2)
  );
  const floats = new Float32Array(int16.length);
  for (let i = 0; i < int16.length; i++) {
    floats[i] = int16[i] / 32768.0;
  }
  return floats;
}

// Convert ArrayBuffer to Base64 String
function base64ArrayBuffer(arrayBuffer: ArrayBuffer): string {
  const bytes = new Uint8Array(arrayBuffer);
  const len = bytes.byteLength;
  const parts = new Array<string>(len);
  for (let i = 0; i < len; i++) {
    parts[i] = String.fromCharCode(bytes[i]);
  }
  return window.btoa(parts.join(''));
}

// Convert Base64 string to Uint8Array
function base64ToUint8Array(base64: string): Uint8Array {
  const binaryString = window.atob(base64);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}

export class BikliAudioSession {
  private ws: WebSocket | null = null;
  
  // Audios contexts (separate to match exact required sample rates)
  private inputAudioCtx: AudioContext | null = null;
  private outputAudioCtx: AudioContext | null = null;
  
  // Audio sources & processors
  private micStream: MediaStream | null = null;
  private micSourceNode: MediaStreamAudioSourceNode | null = null;
  private micProcessorNode: ScriptProcessorNode | null = null;
  
  // Visualisers
  public inputAnalyser: AnalyserNode | null = null;
  public outputAnalyser: AnalyserNode | null = null;
  private outputGainNode: GainNode | null = null;
  
  // Buffering / Playback details
  private nextStartTime = 0;
  private activeSources: AudioBufferSourceNode[] = [];
  /** Last audio chunk (base64). A byte-identical consecutive chunk is a
   *  transport re-send — replaying it would make Bikli "repeat the same words". */
  private lastAudioChunk = "";
  /** Timestamp when Bikli started speaking her latest turn. */
  private lastSpeakingStartTime = 0;
  /** Timestamp of last genuine user mic energy spike above speech threshold. */
  private lastUserSpeechTime = 0;
  
  // State Callbacks
  private onStateChange: (state: LiveState) => void;
  private onTranscription: (role: "user" | "model", text: string) => void;
  private onToolCall: (name: string, args: any, callback: (result: any) => void) => void;
  private onError: (error: string) => void;
  private onMemorySync?: (memories: any[]) => void;
  private onComputerControl?: (enabled: boolean, meta?: { action?: string; reason?: string }) => void;
  
  private currentState: LiveState = "disconnected";
  private isActivated = false;
  private openTimeoutId: ReturnType<typeof setTimeout> | null = null;
  /** Gemini Live ready — only then mark listening and forward mic audio. */
  private geminiReady = false;
  private geminiReadyTimeoutId: ReturnType<typeof setTimeout> | null = null;
  /** Keep AudioContexts running (Windows/Electron often suspend them → silent "thinking"). */
  private audioKeepAliveId: ReturnType<typeof setInterval> | null = null;
  private micEndedHandler: (() => void) | null = null;
  /** Bumps on every connect/disconnect so stale async work cannot finish late. */
  private connectGen = 0;
  /** Prevent stacking concurrent connect() calls. */
  private connectInFlight: Promise<void> | null = null;
  /** Preferred mic for mid-session recoveries. */
  private lastMicDeviceId = "";
  /** Avoid infinite mic-recover loops. */
  private micRecoverAttempts = 0;
  /** One-shot auto-reconnect after unexpected Gemini session_closed. */
  private autoReconnectArmed = false;
  private static MAX_RECONNECTS = 1;
  private reconnectCount = 0;
  private userWantsLive = false;
  /** Prevent session_closed + ws_close double recovery. */
  private dropHandling = false;
  /** Desired screen-vision gate — re-sent when WebSocket opens (was lost before). */
  private screenShareDesired = false;
  private screenShareFlushTimer: ReturnType<typeof setTimeout> | null = null;

  /** Map getUserMedia / DOMException names to clear user-facing text. */
  private static friendlyMicError(err: unknown): string {
    const name = String((err as any)?.name || "");
    const msg = String((err as any)?.message || err || "");
    if (name === "NotAllowedError" || /permission|not allowed|denied/i.test(msg)) {
      return "Microphone permission denied. Allow mic access for BIKLI, then try the power button again.";
    }
    if (name === "NotFoundError" || /not found|no device/i.test(msg)) {
      return "No microphone found. Plug in a mic or pick one in Settings.";
    }
    if (name === "NotReadableError" || name === "AbortError" || /busy|in use|could not start/i.test(msg)) {
      return "Microphone is busy (another app or wake-word still holding it). Close other apps using the mic, wait a second, then try again.";
    }
    if (name === "OverconstrainedError" || /overconstrained|constraint/i.test(msg)) {
      return "Selected microphone is unavailable. Switch to Default mic in Settings, then try again.";
    }
    if (name === "SecurityError") {
      return "Browser blocked the microphone (secure context required). Restart BIKLI.";
    }
    if (msg && msg.length < 180) return msg;
    return "Microphone could not be opened. Allow mic access, close other apps using the mic, then try again.";
  }

  /** Soft tool/desktop noise must not kill the call or spam the red banner. */
  private static isSoftError(text: string): boolean {
    return /desktop|tool|control is locked|screenshot|agent|timeout|could not complete|speak_now|timed out|nothing listening|ECONNREFUSED|not running|LOCKED|busy/i.test(
      text,
    );
  }

  constructor(handlers: {
    onStateChange: (state: LiveState) => void;
    onTranscription: (role: "user" | "model", text: string) => void;
    onToolCall: (name: string, args: any, callback: (result: any) => void) => void;
    onError: (error: string) => void;
    onMemorySync?: (memories: any[]) => void;
    onComputerControl?: (enabled: boolean, meta?: { action?: string; reason?: string }) => void;
  }) {
    this.onStateChange = handlers.onStateChange;
    this.onTranscription = handlers.onTranscription;
    this.onToolCall = handlers.onToolCall;
    this.onError = handlers.onError;
    this.onMemorySync = handlers.onMemorySync;
    this.onComputerControl = handlers.onComputerControl;
  }

  private setState(state: LiveState) {
    if (state === "speaking" && this.currentState !== "speaking") {
      this.lastSpeakingStartTime = Date.now();
    } else if (state !== "speaking") {
      this.lastSpeakingStartTime = 0;
    }
    this.currentState = state;
    this.onStateChange(state);
  }

  public getState(): LiveState {
    return this.currentState;
  }

  /**
   * Tell the server whether screen vision frames should be accepted.
   * Always stores the desired flag and re-sends when the WebSocket is ready
   * (fixes vision never turning on after Share Screen before live connect).
   */
  public setScreenShareActive(active: boolean) {
    this.screenShareDesired = !!active;
    this.flushScreenShareState();
  }

  /** Re-send the stored screenShare gate (call after connect / vision toggle). */
  public flushScreenShareState() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      // Retry shortly — connect may still be finishing
      if (this.screenShareDesired) {
        if (this.screenShareFlushTimer) clearTimeout(this.screenShareFlushTimer);
        this.screenShareFlushTimer = setTimeout(() => {
          this.screenShareFlushTimer = null;
          this.flushScreenShareState();
        }, 400);
      }
      return;
    }
    try {
      this.ws.send(
        JSON.stringify({ type: "screenShare", active: this.screenShareDesired }),
      );
      console.log(`[Bikli] screenShare active=${this.screenShareDesired}`);
    } catch (err) {
      console.error("[Bikli] Failed to send screenShare state:", err);
    }
  }

  public isScreenShareDesired(): boolean {
    return this.screenShareDesired;
  }

  /**
   * Push a JPEG screen frame to Gemini — only while screen vision is desired
   * and the live WebSocket is open.
   */
  public sendVideoFrame(base64Data: string) {
    if (!base64Data) return;
    if (!this.screenShareDesired) return;
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    if (this.currentState === "disconnected" || this.currentState === "connecting") return;
    try {
      this.ws.send(JSON.stringify({ type: "video", video: base64Data }));
    } catch (err) {
      console.error("[Bikli] Failed to send screen frame:", err);
    }
  }

  /**
   * Open the microphone with a multi-strategy retry ladder.
   * Wake-word / screen-share often leave the device busy for 1–3s on Windows.
   */
  private async openMicrophone(deviceId?: string, attempts = 20): Promise<MediaStream> {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error("Microphone API is not available in this environment.");
    }

    // Best-effort: refresh device list (can unlock labels + help after unplug/replug).
    try {
      await navigator.mediaDevices.enumerateDevices();
    } catch {
      /* ignore */
    }

    let lastError: unknown = null;
    let usePreferred = !!deviceId;

    const constraintLadder = (prefer: boolean, step: number): MediaStreamConstraints[] => {
      const list: MediaStreamConstraints[] = [];
      // 1) Bare boolean FIRST — most reliable across Windows drivers.
      //    On many systems exact constraints cause immediate NotReadableError.
      list.push({ audio: true });
      // 2) Optional echo cancellation + noise suppression (non-exact).
      //    Using ideal instead of exact avoids device rejection.
      list.push({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      // 3) Exact echo cancellation + noise suppression (some drivers like this).
      list.push({
        audio: {
          echoCancellation: { exact: true },
          noiseSuppression: { exact: true },
          autoGainControl: true,
        },
      });
      if (prefer && deviceId) {
        // 4) Device with ideal constraint (non-exact, tolerant of stale IDs).
        list.push({
          audio: {
            deviceId: { ideal: deviceId },
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
        });
        // 5) Device with exact constraint (only after earlier steps failed).
        if (step >= 5) {
          list.push({
            audio: {
              deviceId: { exact: deviceId },
              echoCancellation: true,
              noiseSuppression: true,
              autoGainControl: true,
            },
          });
        }
      }
      // 6) Worst-case: bare minimum with preferred device (some broken drivers
      //    only accept a single property).
      if (prefer && deviceId && step >= 7) {
        list.push({
          audio: { deviceId: { exact: deviceId } },
        });
      }
      return list;
    };

    for (let i = 0; i < attempts; i++) {
      // After a few preferred-device failures, drop to system default.
      if (usePreferred && i >= 4) {
        usePreferred = false;
        console.warn("[Bikli] Falling back to default microphone…");
      }
      const variants = constraintLadder(usePreferred, i);
      // Cycle through the ladder rather than clamping to the last entry.
      // Clamping meant attempts 3..19 all reused the *exact* echo/noise
      // constraints — the variant most likely to be rejected outright — so a
      // mic that was merely busy never got retried with `{ audio: true }`.
      const constraints = variants[i % variants.length];

      try {
        const stream = await navigator.mediaDevices.getUserMedia(constraints);
        const track = stream.getAudioTracks()[0];
        if (!track || track.readyState === "ended") {
          stream.getTracks().forEach((t) => {
            try {
              t.stop();
            } catch {
              /* ignore */
            }
          });
          throw new Error("Microphone track ended immediately after open.");
        }
        try {
          track.enabled = true;
        } catch {
          /* ignore */
        }
        // Some devices open muted; force unmute if possible.
        try {
          const settings = track.getSettings?.() || {};
          if ((settings as any).deviceId) {
            console.log("[Bikli] Mic opened:", (settings as any).deviceId, track.label || "");
          }
        } catch {
          /* ignore */
        }
        return stream;
      } catch (err) {
        lastError = err;
        const name = String((err as any)?.name || "");
        console.warn(
          `[Bikli] getUserMedia attempt ${i + 1}/${attempts} failed (${name}):`,
          err,
        );
        // Permission permanently denied — no point hammering.
        if (name === "NotAllowedError" || name === "SecurityError") {
          break;
        }
        // Wait longer each try so the OS can free the capture device.
        // Initial windows settle 300ms, ramping to ~1200ms — many Windows
        // audio drivers need 500-800ms after SpeechRecognition release.
        await new Promise((r) => setTimeout(r, 300 + Math.min(i * 160, 1000)));
      }
    }

    throw new Error(BikliAudioSession.friendlyMicError(lastError));
  }

  /** Resume input/output AudioContexts if the OS/browser suspended them. */
  private async resumeAudioContexts(retries = 3): Promise<void> {
    const tryResume = async (ctx: AudioContext | null): Promise<boolean> => {
      if (!ctx) return false;
      for (let i = 0; i < retries; i++) {
        const s = ctx.state as string;
        if (s !== "suspended") return true;
        try {
          await ctx.resume();
        } catch {
          /* ignore */
        }
        if ((ctx.state as string) === "running") return true;
        if (i < retries - 1) {
          await new Promise((r) => setTimeout(r, 100));
        }
      }
      return (ctx.state as string) === "running";
    };
    await Promise.all([tryResume(this.inputAudioCtx), tryResume(this.outputAudioCtx)]);
  }

  /** Create a silent oscillator to keep the AudioContext alive.
   *  Chromium aggressively suspends AudioContexts after a few seconds of
   *  silence — a silent oscillator prevents this without using a tight timer.
   */
  private createKeepAliveOscillator(): { start: () => void; stop: () => void } | null {
    const ctx = this.outputAudioCtx;
    if (!ctx) return null;
    try {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = 18; // subsonic, inaudible
      gain.gain.value = 0.0001; // near-silent
      osc.connect(gain);
      gain.connect(ctx.destination);
      const start = () => {
        try {
          osc.start();
        } catch {
          /* already started */
        }
      };
      const stop = () => {
        try {
          osc.stop();
          osc.disconnect();
          gain.disconnect();
        } catch {
          /* ignore */
        }
      };
      return { start, stop };
    } catch {
      return null;
    }
  }

  private keepAliveOsc: { start: () => void; stop: () => void } | null = null;

  private startAudioKeepAlive(): void {
    if (this.audioKeepAliveId) {
      clearInterval(this.audioKeepAliveId);
      this.audioKeepAliveId = null;
    }
    // Use both a silent oscillator (keeps context alive without CPU polling)
    // and a fallback timer for extra reliability.
    this.keepAliveOsc = this.createKeepAliveOscillator();
    this.keepAliveOsc?.start();
    // Fallback timer — catches cases where oscillator alone wasn't enough.
    this.audioKeepAliveId = setInterval(() => {
      if (!this.isActivated) return;
      void this.resumeAudioContexts();
    }, 3000);
  }

  private stopAudioKeepAlive(): void {
    if (this.audioKeepAliveId) {
      clearInterval(this.audioKeepAliveId);
      this.audioKeepAliveId = null;
    }
    if (this.keepAliveOsc) {
      this.keepAliveOsc.stop();
      this.keepAliveOsc = null;
    }
  }

  private clearGeminiReadyTimeout(): void {
    if (this.geminiReadyTimeoutId) {
      clearTimeout(this.geminiReadyTimeoutId);
      this.geminiReadyTimeoutId = null;
    }
  }

  /** Mark live only after Gemini is connected (not merely local WS open). */
  private markGeminiReady(): void {
    if (!this.isActivated) return;
    this.clearGeminiReadyTimeout();
    this.geminiReady = true;
    void this.resumeAudioContexts();
    if (this.currentState !== "speaking") {
      this.setState("listening");
    }
    console.log("[Bikli] Live mic session active (listening — Gemini ready)");
    // status=connected can arrive more than once; drop the previous pair so
    // repeated calls do not orphan timers that teardown will never clear.
    for (const t of this.geminiReadyFlushTimers) clearTimeout(t);
    const t1 = setTimeout(() => this.flushScreenShareState(), 250);
    const t2 = setTimeout(() => this.flushScreenShareState(), 1200);
    this.geminiReadyFlushTimers = [t1, t2];
  }

  /** Wire mic stream into Web Audio graph (PCM → WebSocket). */
  private setupMicGraph(stream: MediaStream) {
    if (!this.inputAudioCtx) {
      throw new Error("Input AudioContext missing.");
    }
    this.micStream = stream;
    this.inputAnalyser = this.inputAudioCtx.createAnalyser();
    this.inputAnalyser.fftSize = 256;

    this.micSourceNode = this.inputAudioCtx.createMediaStreamSource(this.micStream);
    this.micSourceNode.connect(this.inputAnalyser);

    // Silent gain sink so ScriptProcessor keeps running without speaker feedback.
    this.micProcessorNode = this.inputAudioCtx.createScriptProcessor(2048, 1, 1);
    this.micSourceNode.connect(this.micProcessorNode);
    const silentGain = this.inputAudioCtx.createGain();
    silentGain.gain.value = 0;
    this.micProcessorNode.connect(silentGain);
    silentGain.connect(this.inputAudioCtx.destination);

    // Detect mic track death mid-session (device unplugged / OS reclaim).
    const track = stream.getAudioTracks()[0];
    if (track) {
      this.micEndedHandler = () => {
        if (!this.isActivated) return;
        console.error("[Bikli] Microphone track ended while live — attempting recover…");
        void this.recoverMicrophone();
      };
      track.addEventListener("ended", this.micEndedHandler);
    }

    this.micProcessorNode.onaudioprocess = (e) => {
      // Only forward mic once Gemini is ready — early frames were dropped silently
      // and looked like "listening but not answering".
      if (!this.geminiReady) return;
      if (this.currentState === "disconnected" || this.currentState === "connecting") return;
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      if (this.inputAudioCtx?.state === "suspended") {
        void this.resumeAudioContexts();
        return;
      }

      const channelData = e.inputBuffer.getChannelData(0);

      // RMS Energy calculation to filter out background noise & speaker bleed
      let sum = 0;
      for (let i = 0; i < channelData.length; i++) {
        sum += channelData[i] * channelData[i];
      }
      const rms = Math.sqrt(sum / channelData.length);

      // When Bikli is speaking, speaker output feeds back into the microphone.
      // If we send speaker bleed / ambient noise to Gemini during speaking state,
      // Gemini's server-side VAD detects incoming audio and emits "interrupted",
      // cutting Bikli's speech off in the middle of her response.
      //
      // Therefore, while Bikli is speaking:
      // 1) Suppress mic audio for the first 600ms of her turn (startup transients).
      // 2) Require a higher RMS threshold (> 0.048) so only intentional loud user
      //    barge-in speech is forwarded to trigger a real interruption.
      if (this.currentState === "speaking") {
        const timeSinceSpeechStart = Date.now() - this.lastSpeakingStartTime;
        if (timeSinceSpeechStart < 600) {
          return; // Ignore mic during initial speech startup
        }
        if (rms < 0.048) {
          return; // Suppress speaker bleed and normal room noise while speaking
        }
        // User genuinely spoke loudly over Bikli to interrupt her
        this.lastUserSpeechTime = Date.now();
      } else {
        // While listening: suppress pure room silence (< 0.002) to save bandwidth
        if (rms < 0.002) {
          return;
        }
        if (rms > 0.015) {
          this.lastUserSpeechTime = Date.now();
        }
      }

      const pcmBuffer = floatTo16BitPCM(channelData);
      const base64 = base64ArrayBuffer(pcmBuffer);
      try {
        this.ws.send(JSON.stringify({ audio: base64 }));
      } catch {
        /* ignore transient send errors */
      }
    };
  }

  /**
   * Re-open the mic mid-call without killing the Gemini WebSocket.
   * Common on Windows when another app steals the capture device briefly.
   */
  private micRecoverResetTimer: ReturnType<typeof setTimeout> | null = null;
  private turnCompleteTimer: ReturnType<typeof setTimeout> | null = null;
  private geminiReadyFlushTimers: ReturnType<typeof setTimeout>[] = [];

  private async recoverMicrophone(): Promise<void> {
    if (!this.isActivated || !this.userWantsLive) return;
    if (this.micRecoverAttempts >= 2) {
      this.onError(
        "Microphone stopped mid-call. Click the power button to reconnect, or check mic permissions.",
      );
      this.disconnect();
      return;
    }
    this.micRecoverAttempts++;
    const gen = this.connectGen;
    try {
      // Tear down only the mic graph, keep WS + output context.
      if (this.micProcessorNode) {
        try {
          this.micProcessorNode.disconnect();
        } catch {
          /* ignore */
        }
        this.micProcessorNode.onaudioprocess = null as any;
        this.micProcessorNode = null;
      }
      if (this.micSourceNode) {
        try {
          this.micSourceNode.disconnect();
        } catch {
          /* ignore */
        }
        this.micSourceNode = null;
      }
      if (this.micStream) {
        this.micStream.getTracks().forEach((t) => {
          try {
            if (this.micEndedHandler) t.removeEventListener("ended", this.micEndedHandler);
            t.stop();
          } catch {
            /* ignore */
          }
        });
        this.micStream = null;
      }
      this.micEndedHandler = null;

      await new Promise((r) => setTimeout(r, 400));
      if (!this.isActivated || gen !== this.connectGen) return;

      const stream = await this.openMicrophone(this.lastMicDeviceId || undefined);
      if (!this.isActivated || gen !== this.connectGen) {
        stream.getTracks().forEach((t) => {
          try {
            t.stop();
          } catch {
            /* ignore */
          }
        });
        return;
      }
      if (!this.inputAudioCtx) {
        throw new Error("Input AudioContext missing during mic recover.");
      }
      await this.resumeAudioContexts();
      this.setupMicGraph(stream);
      console.log("[Bikli] Microphone recovered mid-call");
      // Success — allow future recoveries again after a quiet period.
      if (this.micRecoverResetTimer) clearTimeout(this.micRecoverResetTimer);
      this.micRecoverResetTimer = setTimeout(() => {
        if (this.isActivated) this.micRecoverAttempts = 0;
      }, 15000);
    } catch (err) {
      console.error("[Bikli] Mic recover failed:", err);
      this.onError(BikliAudioSession.friendlyMicError(err));
      this.disconnect();
    }
  }

  // Requests microphone and creates connections
  public async connect(options?: { micDeviceId?: string }) {
    this.userWantsLive = true;
    // Coalesce concurrent callers (wake + button) onto one attempt.
    if (this.connectInFlight) {
      // Already live — nothing to do
      if (this.getState() === "listening" || this.getState() === "speaking") {
        return;
      }
      // Mid-connect: wait for that attempt (do NOT silently no-op forever).
      try {
        await this.connectInFlight;
      } catch {
        /* prior attempt failed — fall through to a fresh one */
      }
      const after = this.getState();
      if (after === "listening" || after === "speaking") {
        return;
      }
      // Prior attempt failed and we're not live — continue to a fresh attempt.
      // Reset so we don't infinitely chain stale failed attempts.
      this.connectInFlight = null;
    }

    // Already live — do nothing
    {
      const s = this.getState();
      if (s === "listening" || s === "speaking") {
        return;
      }
    }

    // NB: the guard must compare against the promise actually stored in
    // connectInFlight. Storing `run.finally(...)` while comparing to `run`
    // never matched, so connectInFlight stayed set for the life of the
    // session and every later connect() paid an extra await on a dead promise.
    const run: Promise<void> = this.connectInternal(options).finally(() => {
      if (this.connectInFlight === run) this.connectInFlight = null;
    });
    this.connectInFlight = run;
    return run;
  }

  private async connectInternal(options?: { micDeviceId?: string }) {
    // Force-clean any half-open / stuck session (common after failed wake handoff).
    // Never silent-return while "connecting" — that left the mic dead forever.
    // Use quiet teardown so userWantsLive stays true for this intentional connect.
    if (this.isActivated || this.ws || this.micStream || this.currentState !== "disconnected") {
      console.warn("[Bikli] Cleaning leftover session before connect…");
      this.teardownResources({ keepUserIntent: true });
      // Windows needs a real pause after track.stop() / SpeechRecognition.abort().
      await new Promise((r) => setTimeout(r, 500));
    }

    const gen = ++this.connectGen;
    this.reconnectCount = 0;
    this.isActivated = true;
    this.geminiReady = false;
    this.micRecoverAttempts = 0;
    this.autoReconnectArmed = true;
    this.dropHandling = false;
    this.setState("connecting");
    const preferredMic = options?.micDeviceId || "";
    this.lastMicDeviceId = preferredMic;

    try {
      // 1) Open microphone FIRST while still close to the user click / wake handoff.
      //    Doing this after async WebSocket open often fails after screen share.
      console.log("[Bikli] Opening microphone…");
      const stream = await this.openMicrophone(preferredMic || undefined);
      if (!this.isActivated || gen !== this.connectGen) {
        stream.getTracks().forEach((t) => {
          try {
            t.stop();
          } catch {
            /* ignore */
          }
        });
        return;
      }

      // 2) Audio contexts (must be after a user gesture when possible)
      const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
      if (!AudioContextClass) {
        stream.getTracks().forEach((t) => {
          try {
            t.stop();
          } catch {
            /* ignore */
          }
        });
        throw new Error("Holographic audio link unsupported: Web Audio API missing in browser.");
      }

      // Prefer exact rates; fall back if the device rejects the sampleRate option.
      try {
        this.inputAudioCtx = new AudioContextClass({ sampleRate: 16000 });
      } catch {
        this.inputAudioCtx = new AudioContextClass();
      }
      try {
        this.outputAudioCtx = new AudioContextClass({ sampleRate: 24000 });
      } catch {
        this.outputAudioCtx = new AudioContextClass();
      }
      await this.resumeAudioContexts();

      this.outputGainNode = this.outputAudioCtx.createGain();
      this.outputAnalyser = this.outputAudioCtx.createAnalyser();
      this.outputAnalyser.fftSize = 256;
      this.outputAnalyser.smoothingTimeConstant = 0.8;
      this.outputGainNode.connect(this.outputAnalyser);
      this.outputAnalyser.connect(this.outputAudioCtx.destination);

      this.setupMicGraph(stream);
      this.startAudioKeepAlive();

      // A newer connect() already owns `this.*` — tearing down here would kill
      // the live session instead of this stale attempt.
      if (gen !== this.connectGen) return;
      if (!this.isActivated) {
        this.disconnect();
        return;
      }

      // 3) WebSocket bridge to the live backend
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const host = window.location.host || "localhost:3000";
      this.ws = new WebSocket(`${protocol}//${host}/live`);
      this.ws.binaryType = "blob";

      if (this.openTimeoutId) {
        clearTimeout(this.openTimeoutId);
        this.openTimeoutId = null;
      }
      // WS must open within 12s
      this.openTimeoutId = setTimeout(() => {
        this.openTimeoutId = null;
        if (
          gen === this.connectGen &&
          this.currentState === "connecting" &&
          this.ws &&
          this.ws.readyState !== WebSocket.OPEN
        ) {
          console.error("[Bikli] WebSocket open timed out");
          this.onError("Could not reach Bikli server. Is the app backend running?");
          this.disconnect();
        }
      }, 12000);

      this.ws.onopen = () => {
        if (gen !== this.connectGen || !this.isActivated) return;
        if (this.openTimeoutId) {
          clearTimeout(this.openTimeoutId);
          this.openTimeoutId = null;
        }
        console.log("[Bikli] Connected to server side WS bridge — waiting for Gemini…");
        // Stay in "connecting" until status=connected. Early "listening" made the UI
        // look live while mic audio was ignored / Gemini not ready (no answers).
        this.clearGeminiReadyTimeout();
        this.geminiReadyTimeoutId = setTimeout(() => {
          this.geminiReadyTimeoutId = null;
          if (gen === this.connectGen && !this.geminiReady && this.isActivated) {
            console.error("[Bikli] Gemini ready timed out");
            this.onError(
              "Voice link timed out. Check that your Gemini API key is valid and you have internet access, then tap the power button.",
            );
            this.disconnect();
          }
        }, 12000);
        // Best-effort screen share gate while waiting
        this.flushScreenShareState();
      };

      this.ws.onmessage = async (event) => {
        if (gen !== this.connectGen || !this.isActivated) return;
        try {
          const data = JSON.parse(event.data);
          
          // Root Error Handler — soft tool/desktop errors must NOT kill the call
          // or spam the red banner (looked like "many errors").
          // HOWEVER: during the connecting phase, ALL errors are fatal — the soft
          // suppression is only for mid-call tool/desktop noise (timeout, busy, etc.).
          if (data.type === "error") {
            const errText = String(data.error || "");
            const isConnecting = this.currentState === "connecting";
            if (!isConnecting && BikliAudioSession.isSoftError(errText)) {
              console.warn("[Bikli] Soft error (session kept):", errText);
            } else {
              this.onError(errText);
              this.disconnect();
            }
            return;
          }

          // Handle server-side states
          if (data.type === "status") {
            console.log("[Bikli WS Status]:", data.status);
            if (data.status === "connecting_gemini") {
              // Wait for Gemini Live connection — keep UI on connecting spinner
            } else if (data.status === "connected") {
              this.markGeminiReady();
            } else if (data.status === "session_closed") {
              // Gemini closed the live link. If user still wants live, try once
              // automatically (idle drops / brief API blips look like "mic off").
              console.warn("[Bikli] Gemini session_closed");
              this.handleUnexpectedSessionDrop("session_closed");
            }
            return;
          }

          // Handle audio payload (24kHzPCM model response)
          if (data.type === "audio" && data.audio) {
            // First audio can arrive slightly before status=connected on some paths
            if (!this.geminiReady) this.markGeminiReady();
            this.playAudioPCMChunk(data.audio);
          }

          // Handle interruption signal (e.g. user talked over Bikli)
          if (data.type === "interrupted") {
            this.handleInterruption();
          }

          // Turn complete
          if (data.type === "turnComplete") {
            // Once Bikli completes speaking, change visual state back to listening
            if (this.turnCompleteTimer) clearTimeout(this.turnCompleteTimer);
            this.turnCompleteTimer = setTimeout(() => {
              this.turnCompleteTimer = null;
              if (
                gen === this.connectGen &&
                this.activeSources.length === 0 &&
                this.currentState === "speaking"
              ) {
                this.setState("listening");
              }
            }, 100);
          }

          // Handle live captions transcription
          if (data.type === "transcription") {
            if (!this.geminiReady && data.role === "model") this.markGeminiReady();
            this.onTranscription(data.role, data.text);
          }

          // Handle memory synchronization
          if (data.type === "memory_sync" && data.memories) {
            if (this.onMemorySync) {
              this.onMemorySync(data.memories);
            }
          }

          // Full PC control lock/unlock (control word)
          if (data.type === "computer_control") {
            if (this.onComputerControl) {
              this.onComputerControl(!!data.enabled, {
                action: data.action,
                reason: data.reason,
              });
            }
          }

          // Handle Tool Calling — always answer (timeout) so Gemini never
          // hangs mid-task without a spoken follow-up.
          if (data.type === "toolCall") {
            if (!this.geminiReady) this.markGeminiReady();
            const { callId, name, args, trackKey } = data;
            let answered = false;
            let timeoutId: ReturnType<typeof setTimeout> | null = null;
            const reply = (result: any) => {
              if (answered) return;
              answered = true;
              if (timeoutId) {
                clearTimeout(timeoutId);
                timeoutId = null;
              }
              if (this.ws && this.ws.readyState === WebSocket.OPEN) {
                try {
                  this.ws.send(
                    JSON.stringify({
                      type: "toolResponse",
                      id: callId,
                      name,
                      trackKey,
                      output: result,
                    }),
                  );
                } catch {
                  /* ignore */
                }
              }
            };
            timeoutId = setTimeout(() => {
              console.warn(`[Bikli] Client tool ${name} timed out — auto-reply`);
              reply({
                result:
                  "Tool timed out. Stay on the call and speak a short update to the user now.",
                ok: false,
                timed_out: true,
              });
            }, 12000);
            try {
              this.onToolCall(name, args, reply);
            } catch (toolErr) {
              console.error(`[Bikli] Client tool ${name} threw:`, toolErr);
              reply({
                result: "Tool failed on client. Speak briefly and continue.",
                ok: false,
              });
            }
          }

        } catch (parseError) {
          console.error("Error reading server packet:", parseError);
        }
      };

      this.ws.onerror = (wsError) => {
        if (gen !== this.connectGen) return;
        console.error("WebSocket transport error:", wsError);
        // onclose will also fire — avoid double hard error banners when possible
      };

      this.ws.onclose = () => {
        if (gen !== this.connectGen) return;
        console.log("WebSocket connection closed");
        // Failed before going live — hard fail with a clear message.
        if (this.currentState === "connecting" && !this.geminiReady) {
          this.onError("Voice link closed before it was ready. Click the power button to try again.");
          this.disconnect();
          return;
        }
        // Unexpected drop while live — one auto-reconnect attempt.
        this.handleUnexpectedSessionDrop("ws_close");
      };

    } catch (e: any) {
      if (gen !== this.connectGen) return;
      console.error("Connection establish sequence failed:", e);
      this.onError(
        BikliAudioSession.friendlyMicError(e) ||
          e?.message ||
          "Failed to initialize active channel.",
      );
      this.disconnect();
    }
  }

  // Interruption triggers: stops all active audio players immediately
  private handleInterruption() {
    // Only accept interruption if Bikli has been speaking for > 500ms
    // AND either the user recently spoke loudly (RMS threshold met) or speech started > 1s ago.
    // This prevents Gemini's false-positive server interruptions from cutting off Bikli's voice.
    const timeSpeaking = Date.now() - this.lastSpeakingStartTime;
    const timeSinceUserSpeech = Date.now() - this.lastUserSpeechTime;

    if (timeSpeaking < 500 && timeSinceUserSpeech > 1200) {
      console.warn("[Audio] Suppressed false server interruption (Bikli just started speaking).");
      return;
    }

    console.log("[Audio] Interruption signal received; flushing play logs.");
    
    // Stop all playing nodes
    this.activeSources.forEach((source) => {
      try {
        source.stop();
      } catch (err) {
        // Already finished or stopped
      }
    });
    this.activeSources = [];
    this.nextStartTime = 0;
    
    // Set state back to user listening
    this.setState("listening");
  }

  // Direct raw PCM chunk scheduled playback at 24kHz
  private playAudioPCMChunk(base64Audio: string) {
    if (!this.outputAudioCtx || !this.outputGainNode) return;

    // Transport-duplicate guard: if the exact same chunk comes twice in a row,
    // play it once. (Real audio frames are never byte-identical back-to-back, so
    // this only ever drops genuine re-sends, not legitimately repeated speech.)
    if (base64Audio === this.lastAudioChunk) return;
    this.lastAudioChunk = base64Audio;

    const schedule = () => {
      if (!this.outputAudioCtx || !this.outputGainNode || !this.isActivated) return;
      let success = false;
      try {
        const uint8Array = base64ToUint8Array(base64Audio);
        const floats = pcm16ToFloats(uint8Array);

        // Create AudioBuffer of 24000Hz (the exact playback sample rate of Gemini outputs)
        const buffer = this.outputAudioCtx.createBuffer(1, floats.length, 24000);
        buffer.getChannelData(0).set(floats);

        // Create Buffer source
        const source = this.outputAudioCtx.createBufferSource();
        source.buffer = buffer;

        // Connect source to gain which is routed to analyser & speakers
        source.connect(this.outputGainNode);

        const currentTime = this.outputAudioCtx.currentTime;

        // Gapless scheduler sync
        if (this.nextStartTime < currentTime) {
          // Start fresh: 30ms ahead to bridge schedule timing
          this.nextStartTime = currentTime + 0.03;
        }

        source.start(this.nextStartTime);
        this.setState("speaking");
        this.nextStartTime += buffer.duration;
        success = true;

        // Keep reference to handle real-time interruptions
        source.onended = () => {
          const index = this.activeSources.indexOf(source);
          if (index > -1) {
            this.activeSources.splice(index, 1);
          }

          // If there are no more active play nodes, revert state back to listening
          if (this.activeSources.length === 0 && this.currentState === "speaking") {
            this.setState("listening");
          }
        };

        this.activeSources.push(source);
      } catch (playbackError) {
        console.error("PCM Chunk buffering/playback failed:", playbackError);
        if (!success && this.currentState === "speaking") {
          this.setState("listening");
        }
      }
    };

    // Suspended output context = model "answers" with no sound (looks like thinking-only).
    if (this.outputAudioCtx.state === "suspended") {
      void this.resumeAudioContexts(5).then(() => {
        // Check again — resume may have been blocked by policy
        if (this.outputAudioCtx?.state === "suspended") {
          // Last resort: create a fresh context
          try {
            const Ctx = window.AudioContext || (window as any).webkitAudioContext;
            if (Ctx) {
              const oldCtx = this.outputAudioCtx;
              // nextStartTime still holds the OLD context's clock (it accumulates
              // buffer.duration each chunk, so after ~20s of speech it is ~20s).
              // A fresh context starts at currentTime≈0, so reusing that value
              // schedules the whole reply tens of seconds in the future = silent.
              // Stop old sources, reset the timeline, then swap contexts.
              this.activeSources.forEach((s) => {
                try { s.stop(); s.disconnect(); } catch { /* ignore */ }
              });
              this.activeSources = [];
              this.nextStartTime = 0;

              const fresh = new Ctx({ sampleRate: 24000 });
              this.outputAudioCtx = fresh;
              this.outputGainNode = fresh.createGain();
              this.outputAnalyser = fresh.createAnalyser();
              this.outputAnalyser.fftSize = 256;
              this.outputAnalyser.smoothingTimeConstant = 0.8;
              this.outputGainNode.connect(this.outputAnalyser);
              this.outputAnalyser.connect(fresh.destination);
              // Restart keep-alive for the new context
              this.stopAudioKeepAlive();
              this.startAudioKeepAlive();
              // Release the suspended old context (avoid a leak per incident)
              try {
                if (oldCtx && oldCtx.state !== "closed") void oldCtx.close();
              } catch {
                /* ignore */
              }
            }
          } catch {
            /* best-effort */
          }
        }
        schedule();
      });
      return;
    }
    schedule();
  }

  /**
   * Gemini/WS dropped while the user still wants a live call.
   * Attempts one silent reconnect; otherwise full disconnect.
   */
  private handleUnexpectedSessionDrop(reason: string) {
    if (this.dropHandling) return;
    this.dropHandling = true;
    // Skip reconnect if user intentionally ended the session (turnOffMic / disconnect).
    if (!this.userWantsLive) {
      console.warn(`[Bikli] Session drop (${reason}) — no reconnect (user ended session)`);
      this.dropHandling = false;
      return;
    }
    const shouldRetry =
      this.autoReconnectArmed && this.geminiReady &&
      this.reconnectCount < BikliAudioSession.MAX_RECONNECTS;
    this.autoReconnectArmed = false;
    this.reconnectCount++;
    console.warn(`[Bikli] Unexpected session drop (${reason}), retry=${shouldRetry} (reconnect #${this.reconnectCount})`);

    this.teardownResources({ keepUserIntent: shouldRetry });
    if (shouldRetry) {
      this.setState("connecting");
      setTimeout(() => {
        this.dropHandling = false;
        if (!this.userWantsLive) return;
        const s = this.getState();
        if (s === "listening" || s === "speaking") return;
        void this.connect({ micDeviceId: this.lastMicDeviceId || undefined }).catch((err) => {
          console.error("[Bikli] Auto-reconnect failed:", err);
          this.onError("Voice session dropped. Click the power button to reconnect.");
          this.disconnect();
        });
      }, 700);
    } else {
      this.userWantsLive = false;
      this.reconnectCount = 0;
      this.dropHandling = false;
      this.setState("disconnected");
    }
  }

  /**
   * Low-level resource teardown. keepUserIntent=true is used for internal
   * reconnect paths so we do not clear userWantsLive.
   */
  private teardownResources(opts?: { keepUserIntent?: boolean }) {
    // Invalidate any in-flight connect so late mic/WS work cannot revive state.
    this.connectGen++;
    this.isActivated = false;
    this.geminiReady = false;

    if (!opts?.keepUserIntent) {
      this.userWantsLive = false;
      this.autoReconnectArmed = false;
    }

    if (this.openTimeoutId) {
      clearTimeout(this.openTimeoutId);
      this.openTimeoutId = null;
    }
    this.clearGeminiReadyTimeout();
    this.stopAudioKeepAlive();
    if (this.screenShareFlushTimer) {
      clearTimeout(this.screenShareFlushTimer);
      this.screenShareFlushTimer = null;
    }
    if (this.micRecoverResetTimer) {
      clearTimeout(this.micRecoverResetTimer);
      this.micRecoverResetTimer = null;
    }
    if (this.turnCompleteTimer) {
      clearTimeout(this.turnCompleteTimer);
      this.turnCompleteTimer = null;
    }
    if (this.keepAliveOsc) {
      this.keepAliveOsc.stop();
      this.keepAliveOsc = null;
    }
    for (const t of this.geminiReadyFlushTimers) {
      clearTimeout(t);
    }
    this.geminiReadyFlushTimers = [];
    // Keep screenShareDesired so re-connect after share still enables vision

    // Close WS socket (clear handlers first so onclose does not re-enter)
    if (this.ws) {
      const socket = this.ws;
      this.ws = null;
      try {
        socket.onopen = null;
        socket.onmessage = null;
        socket.onerror = null;
        socket.onclose = null;
        socket.close();
      } catch (e) {}
    }

    // Stop and release user microphone streams
    if (this.micStream) {
      this.micStream.getTracks().forEach((track) => {
        try {
          if (this.micEndedHandler) {
            track.removeEventListener("ended", this.micEndedHandler);
          }
          track.stop();
        } catch (e) {}
      });
      this.micStream = null;
    }
    this.micEndedHandler = null;

    // Disconnect routing nodes
    if (this.micProcessorNode) {
      try {
        this.micProcessorNode.disconnect();
      } catch (e) {}
      this.micProcessorNode = null;
    }

    if (this.micSourceNode) {
      try {
        this.micSourceNode.disconnect();
      } catch (e) {}
      this.micSourceNode = null;
    }

    // Close Audio contexts
    if (this.inputAudioCtx) {
      try {
        this.inputAudioCtx.close();
      } catch (e) {}
      this.inputAudioCtx = null;
    }

    if (this.outputAudioCtx) {
      try {
        this.outputAudioCtx.close();
      } catch (e) {}
      this.outputAudioCtx = null;
    }

    this.activeSources.forEach((source) => {
      try {
        source.stop();
      } catch {
        /* already stopped */
      }
    });
    this.activeSources = [];
    this.nextStartTime = 0;
    this.inputAnalyser = null;
    this.outputAnalyser = null;
    this.outputGainNode = null;
  }

  // Fully cleanup and release microphones & connection sockets
  public disconnect() {
    // Idempotent: onclose also calls disconnect — avoid double teardown work
    if (
      this.currentState === "disconnected" &&
      !this.isActivated &&
      !this.ws &&
      !this.micStream &&
      !this.userWantsLive
    ) {
      return;
    }
    this.teardownResources({ keepUserIntent: false });
    this.setState("disconnected");
  }
}
