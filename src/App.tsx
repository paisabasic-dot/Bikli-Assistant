import { useState, useEffect, useRef } from "react";
import { BikliAudioSession, LiveState } from "./lib/audio";
import { BikliCoreVisualizer, BikliEmotion } from "./components/BikliCoreVisualizer";
import { LiveWaveform } from "./components/LiveWaveform";
import { BrowserAgent } from "./components/BrowserAgent";
import {
  Power,
  Volume2,
  Globe,
  Compass,
  CircleAlert,
  Mic,
  X,
  Brain,
  Monitor,
  Play,
  Pause,
  Square,
  RefreshCw,
  Settings as SettingsIcon
} from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import { Memory, MemoryCategory } from "./lib/memoryTypes";
import { MemoryDashboard } from "./components/MemoryDashboard";
import { SettingsPanel } from "./components/SettingsPanel";
import { BikliSettings, loadSettings, saveSettings } from "./lib/settingsStore";
import { BikliWakeWordDetector, WakeWordState } from "./lib/wakeWord";

// Very dim ambient floating particles — deterministic so the layer is stable.
const AMBIENT_PARTICLES = Array.from({ length: 9 }, (_, i) => ({
  left: `${(i * 37 + 9) % 100}%`,
  top: `${(i * 23 + 6) % 90}%`,
  size: 2 + (i % 3) * 2,
  delay: (i * 1.7) % 15,
  dur: 13 + (i % 4) * 3,
}));

export default function App() {
  const [state, setState] = useState<LiveState>("disconnected");

  // Full PC control is LOCKED until user says the control word ("control")
  const [computerControlEnabled, setComputerControlEnabled] = useState(false);

  // Real-time Screen Sharing states
  const [isScreenSharing, setIsScreenSharing] = useState<boolean>(false);
  const [isScreenSharingPaused, setIsScreenSharingPaused] = useState<boolean>(false);
  // Vision frames only while Share Screen is active (auto-on when sharing starts)
  const [screenVisionMode, setScreenVisionMode] = useState<boolean>(true);
  // Live PIP preview stream (React state so the <video> re-binds reliably)
  const [screenPreviewStream, setScreenPreviewStream] = useState<MediaStream | null>(null);

  // References to preserve state across intervals
  const screenStreamRef = useRef<MediaStream | null>(null);
  const screenVideoRef = useRef<HTMLVideoElement | null>(null);
  const screenPreviewVideoRef = useRef<HTMLVideoElement | null>(null);
  const screenCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const screenIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Re-entrancy guard for startScreenSharing: two concurrent invocations would
  // both tear down, then each acquire a display stream, and the later one would
  // overwrite screenStreamRef, leaking the earlier stream (never stopped).
  const screenShareStartingRef = useRef<boolean>(false);
  // Declared early so captureFrameAndSend can close over a stable ref.
  const sessionRef = useRef<BikliAudioSession | null>(null);

  const isPausedRef = useRef<boolean>(false);
  const screenVisionRef = useRef<boolean>(true);
  const isScreenSharingRef = useRef<boolean>(false);
  const stateRef = useRef<LiveState>("disconnected");
  /** Captures the last onError text during "connecting" phase so the retry
   *  fallback can show a specific error (API key / auth) instead of the
   *  generic "did not start" message. */
  const connectErrorRef = useRef<string | null>(null);
  /** Timestamp of the last manual disconnect (power button). Wake word
   *  re-arm is delayed by 2s after this to prevent mic contention when
   *  the user toggles OFF then quickly ON again. */
  const lastManualDisconnectRef = useRef<number>(0);
  /** True when the user said "bye" and we're waiting for Bikli to speak her
   *  farewell before closing. Prevents auto-close from racing the audio. */
  const goodbyePendingRef = useRef<boolean>(false);
  /** Safety-net timer: closes the app if Gemini never calls turnOffMic after bye. */
  const goodbyeSafetyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Sync state changes with refs to totally prevent stale closures in callbacks
  useEffect(() => {
    isPausedRef.current = isScreenSharingPaused;
  }, [isScreenSharingPaused]);

  useEffect(() => {
    screenVisionRef.current = screenVisionMode;
  }, [screenVisionMode]);

  /** True when frames should flow to Gemini (share on + not paused + vision mode on). */
  const syncScreenVisionGate = (opts?: {
    sharing?: boolean;
    paused?: boolean;
    vision?: boolean;
  }) => {
    const sharing = opts?.sharing ?? isScreenSharingRef.current;
    const paused = opts?.paused ?? isPausedRef.current;
    const vision = opts?.vision ?? screenVisionRef.current;
    const live = !!(sharing && !paused && vision);
    sessionRef.current?.setScreenShareActive(live);
    return live;
  };

  useEffect(() => {
    isScreenSharingRef.current = isScreenSharing;
    // Vision frames only when sharing + not paused + SCREEN VISION MODE on
    syncScreenVisionGate({
      sharing: isScreenSharing,
      paused: isScreenSharingPaused,
      vision: screenVisionMode,
    });
  }, [isScreenSharing, isScreenSharingPaused, screenVisionMode]);

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  // Keep the floating live preview video attached to the active screen stream
  useEffect(() => {
    const el = screenPreviewVideoRef.current;
    if (!el) return;
    if (screenPreviewStream) {
      if (el.srcObject !== screenPreviewStream) {
        el.srcObject = screenPreviewStream;
      }
      el.muted = true;
      el.playsInline = true;
      void el.play().catch((err) => {
        console.warn("[Screen Preview] play failed:", err);
      });
    } else {
      try {
        el.srcObject = null;
      } catch {
        /* ignore */
      }
    }
  }, [screenPreviewStream, isScreenSharing, isScreenSharingPaused]);

  // Clean up streaming on unmount
  useEffect(() => {
    return () => {
      if (screenIntervalRef.current) {
        clearInterval(screenIntervalRef.current);
        screenIntervalRef.current = null;
      }
      if (screenStreamRef.current) {
        screenStreamRef.current.getTracks().forEach((t) => {
          try { t.stop(); } catch { /* ignore */ }
        });
        screenStreamRef.current = null;
      }
      if (screenVideoRef.current) {
        try {
          screenVideoRef.current.pause();
          screenVideoRef.current.srcObject = null;
        } catch { /* ignore */ }
        screenVideoRef.current = null;
      }
    };
  }, []);

  const captureFrameAndSend = () => {
    const video = screenVideoRef.current;
    // ONLY send frames while sharing + vision mode on + not paused
    if (!isScreenSharingRef.current || !video || isPausedRef.current || !screenVisionRef.current) {
      return;
    }

    if (stateRef.current === "disconnected" || stateRef.current === "connecting") {
      return;
    }

    try {
      // readyState >= 1 (HAVE_METADATA) is enough once we have dimensions
      if (video.videoWidth === 0 || video.videoHeight === 0) return;
      if (video.readyState < 1) return;

      // Keep video playing (Electron can pause hidden videos)
      if (video.paused) {
        void video.play().catch(() => {});
      }

      if (!screenCanvasRef.current) {
        screenCanvasRef.current = document.createElement("canvas");
      }
      const canvas = screenCanvasRef.current;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (!ctx) return;

      // Keep payload light for Gemini Live but sharp enough to read UI text
      const maxDim = 1024;
      let width = video.videoWidth;
      let height = video.videoHeight;

      if (width > maxDim || height > maxDim) {
        if (width > height) {
          height = Math.round((height * maxDim) / width);
          width = maxDim;
        } else {
          width = Math.round((width * maxDim) / height);
          height = maxDim;
        }
      }

      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }

      ctx.drawImage(video, 0, 0, width, height);

      const dataUrl = canvas.toDataURL("image/jpeg", 0.62);
      const base64 = dataUrl.split(",")[1];
      if (!base64 || base64.length < 100) return;

      sessionRef.current?.sendVideoFrame(base64);
    } catch (err) {
      console.error("[Screen Capture] Failed drawing frame to canvas:", err);
    }
  };

  /** Toggle SCREEN VISION MODE — must re-arm server gate + frames (was UI-only before). */
  const setScreenVisionModeLive = (on: boolean) => {
    setScreenVisionMode(on);
    screenVisionRef.current = on;
    const live = syncScreenVisionGate({ vision: on });
    if (on && isScreenSharingRef.current && !isPausedRef.current) {
      // Ensure Bikli is live so frames reach Gemini
      void ensureBikliLiveAfterShare();
      if (live || sessionRef.current) {
        sessionRef.current?.flushScreenShareState?.();
        sessionRef.current?.setScreenShareActive(true);
        setTimeout(() => captureFrameAndSend(), 150);
        setTimeout(() => captureFrameAndSend(), 500);
        setTimeout(() => captureFrameAndSend(), 1200);
      }
    }
  };

  /** Wait until the hidden capture <video> has real dimensions. */
  const waitForVideoReady = (video: HTMLVideoElement, timeoutMs = 8000): Promise<void> => {
    if (video.videoWidth > 0 && video.videoHeight > 0 && video.readyState >= 2) {
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error("Screen stream timed out before producing frames."));
      }, timeoutMs);

      const onReady = () => {
        if (video.videoWidth > 0 && video.videoHeight > 0) {
          cleanup();
          resolve();
        }
      };

      const cleanup = () => {
        clearTimeout(timer);
        video.removeEventListener("loadedmetadata", onReady);
        video.removeEventListener("loadeddata", onReady);
        video.removeEventListener("resize", onReady);
      };

      video.addEventListener("loadedmetadata", onReady);
      video.addEventListener("loadeddata", onReady);
      video.addEventListener("resize", onReady);
      // In case metadata already fired before listeners attached
      onReady();
    });
  };

  /** True when running inside the Bikli Electron desktop shell. */
  const isElectronDesktop = (): boolean => {
    try {
      return Boolean((window as any).bikli?.isDesktop);
    } catch {
      return false;
    }
  };

  /**
   * Packaged Electron path: desktopCapturer source id + chromeMediaSource.
   * More reliable than getDisplayMedia alone in the built EXE.
   */
  const getElectronDesktopStream = async (): Promise<MediaStream | null> => {
    const api = (window as any).bikli;
    if (!api?.isDesktop || typeof api.getScreenSources !== "function") {
      return null;
    }
    if (!navigator.mediaDevices?.getUserMedia) return null;

    let sources: Array<{ id: string; name: string; isScreen?: boolean }> = [];
    try {
      sources = (await api.getScreenSources()) || [];
    } catch (err) {
      console.warn("[Screen Share] getScreenSources failed:", err);
      return null;
    }
    if (!sources.length) {
      console.warn("[Screen Share] No desktop sources from Electron");
      return null;
    }

    const preferred =
      sources.find((s) => s.isScreen || String(s.id).startsWith("screen:")) || sources[0];
    console.log("[Screen Share] Electron source:", preferred.name, preferred.id);

    // Electron / Chromium desktop capture constraints (not in standard DOM types).
    const tryConstraints = async (constraints: unknown) => {
      return navigator.mediaDevices.getUserMedia(constraints as MediaStreamConstraints);
    };

    try {
      return await tryConstraints({
        audio: false,
        video: {
          mandatory: {
            chromeMediaSource: "desktop",
            chromeMediaSourceId: preferred.id,
            maxWidth: 1920,
            maxHeight: 1080,
            maxFrameRate: 10,
          },
        },
      });
    } catch (err1) {
      console.warn("[Screen Share] chromeMediaSource mandatory failed, retry:", err1);
      try {
        // Alternate constraint shape used by some Electron versions
        return await tryConstraints({
          audio: false,
          video: {
            chromeMediaSource: "desktop",
            chromeMediaSourceId: preferred.id,
          },
        });
      } catch (err2) {
        console.warn("[Screen Share] Electron desktop stream failed:", err2);
        return null;
      }
    }
  };

  /** Browser / getDisplayMedia path (also used as Electron fallback). */
  const getDisplayMediaStream = async (): Promise<MediaStream> => {
    if (!navigator.mediaDevices?.getDisplayMedia) {
      throw new Error(
        "Screen share is not supported in this environment. Use the Bikli desktop app.",
      );
    }
    try {
      return await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: false,
      });
    } catch (firstErr: any) {
      if (firstErr?.name === "OverconstrainedError" || firstErr?.name === "TypeError") {
        return await navigator.mediaDevices.getDisplayMedia({
          video: {
            width: { ideal: 1280 },
            height: { ideal: 720 },
            frameRate: { ideal: 5, max: 10 },
          } as MediaTrackConstraints,
          audio: false,
        });
      }
      throw firstErr;
    }
  };

  /**
   * After screen share starts: turn Bikli live ON so vision frames actually reach
   * Gemini (frames are ignored while disconnected).
   */
  const ensureBikliLiveAfterShare = async () => {
    const session = sessionRef.current;
    if (!session) return;
    // Always re-arm desired vision flag (even if already listening)
    if (isScreenSharingRef.current && !isPausedRef.current && screenVisionRef.current) {
      session.setScreenShareActive(true);
    }
    const current = session.getState();
    if (current === "listening" || current === "speaking") {
      session.flushScreenShareState();
      setTimeout(() => captureFrameAndSend(), 150);
      setTimeout(() => captureFrameAndSend(), 600);
      return;
    }

    // Free wake-word mic before live getUserMedia (critical after share on Windows)
    const det = wakeDetectorRef.current;
    if (det) {
      try {
        det.stop();
      } catch {
        /* ignore */
      }
      setWakeState("stopped");
      await new Promise((r) => setTimeout(r, 450));
    }

    if (current === "connecting") {
      session.disconnect();
      await new Promise((r) => setTimeout(r, 350));
    }

    try {
      console.log("[Screen Share] Turning Bikli live so screen vision works…");
      // Flag before connect — flushed on WS open
      session.setScreenShareActive(true);
      await session.connect({
        micDeviceId: settingsRef.current.micDeviceId || undefined,
      });
      for (let i = 0; i < 60; i++) {
        await new Promise((r) => setTimeout(r, 150));
        const s = sessionRef.current?.getState();
        if (s === "listening" || s === "speaking") {
          sessionRef.current?.setScreenShareActive(true);
          sessionRef.current?.flushScreenShareState();
          setTimeout(() => captureFrameAndSend(), 150);
          setTimeout(() => captureFrameAndSend(), 500);
          setTimeout(() => captureFrameAndSend(), 1200);
          console.log("[Screen Share] Bikli is live with screen vision");
          return;
        }
        if (s === "disconnected" && i > 6) break;
      }
      console.warn("[Screen Share] Bikli did not reach listening after share");
      setErrorText(
        "Screen is shared, but live voice did not start. Press the Power button once so Bikli can see your screen.",
      );
    } catch (err) {
      console.error("[Screen Share] Auto-connect after share failed:", err);
      setErrorText(
        "Screen preview is on, but live connect failed. Press Power to wake Bikli, then try Share Screen again.",
      );
    }
  };

  const startScreenSharing = async () => {
    if (screenShareStartingRef.current) return; // already starting — avoid double capture
    screenShareStartingRef.current = true;
    try {
    setErrorText(null);

    // Tear down any previous capture cleanly before starting a new one
    if (screenIntervalRef.current) {
      clearInterval(screenIntervalRef.current);
      screenIntervalRef.current = null;
    }
    if (screenStreamRef.current) {
      screenStreamRef.current.getTracks().forEach((t) => {
        try { t.stop(); } catch { /* ignore */ }
      });
      screenStreamRef.current = null;
    }
    setScreenPreviewStream(null);
    if (screenVideoRef.current) {
      try {
        screenVideoRef.current.pause();
        screenVideoRef.current.srcObject = null;
        if (screenVideoRef.current.parentNode) {
          screenVideoRef.current.parentNode.removeChild(screenVideoRef.current);
        }
      } catch { /* ignore */ }
      screenVideoRef.current = null;
    }

    try {
      let stream: MediaStream | null = null;
      let usedElectron = false;

      // 1) Packaged EXE: preferred path via desktopCapturer + chromeMediaSource
      if (isElectronDesktop()) {
        stream = await getElectronDesktopStream();
        usedElectron = !!stream;
        if (stream) {
          console.log("[Screen Share] Using Electron desktopCapturer stream");
        }
      }

      // 2) Fallback: getDisplayMedia (browser + Electron handler bridge)
      if (!stream) {
        stream = await getDisplayMediaStream();
        console.log("[Screen Share] Using getDisplayMedia stream");
      }

      const track = stream.getVideoTracks()[0];
      if (!track) {
        stream.getTracks().forEach((t) => t.stop());
        setErrorText("Screen share failed: no video track was returned.");
        return;
      }

      // Keep track alive; some Electron builds end tracks if not enabled
      try {
        track.enabled = true;
      } catch {
        /* ignore */
      }

      screenStreamRef.current = stream;

      const video = document.createElement("video");
      video.srcObject = stream;
      video.muted = true;
      video.playsInline = true;
      video.setAttribute("playsinline", "true");
      video.setAttribute("muted", "true");
      video.setAttribute("autoplay", "true");
      // Keep off-DOM but force layout decoding in some Chromium builds
      video.style.position = "fixed";
      video.style.width = "2px";
      video.style.height = "2px";
      video.style.opacity = "0.01";
      video.style.pointerEvents = "none";
      video.style.left = "0";
      video.style.top = "0";
      video.style.zIndex = "-1";
      document.body.appendChild(video);

      try {
        await video.play();
      } catch (playErr) {
        console.warn("[Screen Share] video.play() warning:", playErr);
      }

      try {
        await waitForVideoReady(video, usedElectron ? 10000 : 8000);
      } catch (readyErr: any) {
        console.error("[Screen Share] stream not ready:", readyErr);
        // One more play + wait attempt (Electron sometimes needs it)
        try {
          await video.play();
          await waitForVideoReady(video, 5000);
        } catch {
          stream.getTracks().forEach((t) => {
            try { t.stop(); } catch { /* ignore */ }
          });
          try { document.body.removeChild(video); } catch { /* ignore */ }
          screenStreamRef.current = null;
          setErrorText(
            readyErr?.message ||
              "Screen stream failed to start. Try again, or rebuild/reinstall Bikli desktop app.",
          );
          return;
        }
      }

      screenVideoRef.current = video;
      setScreenPreviewStream(stream);
      setIsScreenSharing(true);
      setIsScreenSharingPaused(false);
      setScreenVisionMode(true); // auto-enable vision when user shares
      isScreenSharingRef.current = true;
      isPausedRef.current = false;
      screenVisionRef.current = true;
      // Arm vision gate BEFORE connect so reconnect flushes it
      sessionRef.current?.setScreenShareActive(true);

      // Stop handling when native "Stop sharing" chrome bar ends the track
      track.onended = () => {
        stopScreenSharing();
      };

      // ~1.5s frames while vision is on (gated in captureFrameAndSend)
      screenIntervalRef.current = setInterval(() => {
        captureFrameAndSend();
      }, 1500);

      // First frames ASAP once dimensions are known
      captureFrameAndSend();
      setTimeout(() => captureFrameAndSend(), 300);
      setTimeout(() => captureFrameAndSend(), 800);
      setTimeout(() => captureFrameAndSend(), 1600);

      // Turn Bikli ON so screen frames are actually sent to Gemini
      void ensureBikliLiveAfterShare();

    } catch (e: any) {
      console.error("Screen sharing failed:", e);
      const name = e?.name || "";
      const msg = String(e?.message || e || "");

      if (name === "NotAllowedError" || name === "PermissionDeniedError") {
        // User cancelled the picker — stay quiet unless this is a hard block
        if (/permission|denied|not allowed|secure/i.test(msg) || isElectronDesktop()) {
          setErrorText(
            "Screen share was blocked. In the Bikli desktop app this should work automatically — try again. If it keeps failing, restart Bikli as Administrator once, or check Windows Privacy → Screen recording.",
          );
        }
        return;
      }
      if (name === "NotFoundError") {
        setErrorText("No screen or window is available to share.");
        return;
      }
      if (name === "NotReadableError" || name === "TrackStartError") {
        setErrorText(
          "Could not read the screen (another app may be capturing it). Close other capture tools and retry.",
        );
        return;
      }
      if (name === "AbortError") {
        return; // user dismissed picker
      }
      setErrorText(`Could not capture screen: ${msg || name || "unknown error"}`);
    }
    } finally {
      screenShareStartingRef.current = false;
    }
  };

  const stopScreenSharing = () => {
    if (screenIntervalRef.current) {
      clearInterval(screenIntervalRef.current);
      screenIntervalRef.current = null;
    }

    if (screenStreamRef.current) {
      screenStreamRef.current.getTracks().forEach((track) => {
        try {
          track.stop();
        } catch (e) {}
      });
      screenStreamRef.current = null;
    }

    if (screenVideoRef.current) {
      try {
        screenVideoRef.current.pause();
        screenVideoRef.current.srcObject = null;
        if (screenVideoRef.current.parentNode) {
          screenVideoRef.current.parentNode.removeChild(screenVideoRef.current);
        }
      } catch { /* ignore */ }
      screenVideoRef.current = null;
    }

    setScreenPreviewStream(null);
    setIsScreenSharing(false);
    setIsScreenSharingPaused(false);
    isScreenSharingRef.current = false;
    isPausedRef.current = false;
    sessionRef.current?.setScreenShareActive(false);
  };

  const pauseScreenSharing = () => {
    setIsScreenSharingPaused(true);
    isPausedRef.current = true;
    sessionRef.current?.setScreenShareActive(false);
  };

  const resumeScreenSharing = () => {
    setIsScreenSharingPaused(false);
    isPausedRef.current = false;
    // Resume vision stream if mode is on
    const live =
      isScreenSharingRef.current && screenVisionRef.current;
    sessionRef.current?.setScreenShareActive(live);
    if (live) {
      void ensureBikliLiveAfterShare();
      setTimeout(() => captureFrameAndSend(), 100);
      setTimeout(() => captureFrameAndSend(), 500);
    }
  };

  const switchScreenShare = async () => {
    // startScreenSharing already tears down the previous stream
    await startScreenSharing();
  };

  const [activeEmotion, setActiveEmotion] = useState<BikliEmotion>("idle");
  const [themeColor, setThemeColor] = useState<string>("charcoal");
  // Transcript buffers are INTERNAL only (control words / mic-off / emotion).
  // Nothing is painted on screen — fully caption-free UI.
  const userTranscriptRef = useRef<string>("");
  const modelTranscriptRef = useRef<string>("");
  const [characterState, setCharacterState] = useState<"idle" | "thinking" | "talking">("idle");

  const detectEmotionFromText = (text: string): BikliEmotion => {
    const lower = text.toLowerCase();
    if (lower.includes("haha") || lower.includes("lol") || lower.includes("funny") || lower.includes("joke") || lower.includes("hehe") || lower.includes("wink")) return "playful";
    if (lower.includes("happy") || lower.includes("harmony") || lower.includes("glad") || lower.includes("joy") || lower.includes("wonderful") || lower.includes("love") || lower.includes("smile")) return "happy";
    if (lower.includes("wow") || lower.includes("awesome") || lower.includes("excited") || lower.includes("amazing") || lower.includes("yay") || lower.includes("incredible") || lower.includes("hype")) return "excited";
    if (lower.includes("really?") || lower.includes("curious") || lower.includes("interest") || lower.includes("tell me more") || lower.includes("why") || lower.includes("how") || lower.includes("wonder")) return "curious";
    if (lower.includes("think") || lower.includes("calculat") || lower.includes("analyz") || lower.includes("hmmm") || lower.includes("process") || lower.includes("let me see") || lower.includes("conclude")) return "thinking";
    if (lower.includes("proud") || lower.includes("achieved") || lower.includes("expert") || lower.includes("skill") || lower.includes("confidence") || lower.includes("succeed")) return "proud";
    if (lower.includes("sad") || lower.includes("sorry") || lower.includes("unfortunate") || lower.includes("grief") || lower.includes("bad") || lower.includes("regret") || lower.includes("alas") || lower.includes("cry")) return "sad";
    if (lower.includes("shock") || lower.includes("surprise") || lower.includes("gasp") || lower.includes("unexpected") || lower.includes("seriously") || lower.includes("oh my")) return "surprised";
    if (lower.includes("blush") || lower.includes("shy") || lower.includes("embarrass") || lower.includes("nervous") || lower.includes("oops") || lower.includes("sorry about")) return "embarrassed";
    if (lower.includes("what?") || lower.includes("confus") || lower.includes("puzzled") || lower.includes("dont know") || lower.includes("not sure") || lower.includes("wait")) return "confused";
    return "idle";
  };
  // In-built browser engine: runs in background by default (no full-screen UI).
  const [browserEngineOn, setBrowserEngineOn] = useState<boolean>(false);
  const [browserUiVisible, setBrowserUiVisible] = useState<boolean>(false);
  const [browserSeedUrl, setBrowserSeedUrl] = useState<string>("about:blank");
  const [showGuide, setShowGuide] = useState<boolean>(false);
  const [errorText, setErrorText] = useState<string | null>(null);

  // Bikli Autopilot system controller state
  const [browserTrigger, setBrowserTrigger] = useState<{
    type: string;
    args: any;
    id: string;
    callback: (res: any) => void;
  } | null>(null);

  /** Resolve website shortcuts / free text into a URL for the in-built browser. */
  const resolveInbuiltUrl = (raw: string | undefined | null): string => {
    const s = (raw || "").trim();
    if (!s) return "https://html.duckduckgo.com/html/";
    const key = s.toLowerCase().replace(/^https?:\/\//, "").replace(/\/$/, "");
    const shortcuts: Record<string, string> = {
      youtube: "https://www.youtube.com",
      yt: "https://www.youtube.com",
      google: "https://html.duckduckgo.com/html/",
      github: "https://github.com",
      gmail: "https://mail.google.com",
      chatgpt: "https://chatgpt.com",
      duckduckgo: "https://html.duckduckgo.com/html/",
      ddg: "https://html.duckduckgo.com/html/",
    };
    if (shortcuts[key] || shortcuts[s.toLowerCase()]) {
      return shortcuts[key] || shortcuts[s.toLowerCase()];
    }
    if (/^https?:\/\//i.test(s)) return s;
    if (/^[\w.-]+\.[a-z]{2,}/i.test(s)) return `https://${s}`;
    return `https://html.duckduckgo.com/html/?q=${encodeURIComponent(s)}`;
  };

  /** Start / keep the hidden in-built browser engine (never pops the full UI). */
  const ensureBackgroundBrowser = (seedUrl?: string) => {
    if (seedUrl) setBrowserSeedUrl(resolveInbuiltUrl(seedUrl));
    setBrowserEngineOn(true);
    // Intentionally do NOT set browserUiVisible — stay in background
  };

  // Bikli recollections database core state
  const [memories, setMemories] = useState<Memory[]>([]);
  const [showMemoryDashboard, setShowMemoryDashboard] = useState<boolean>(false);

  // V2: Settings + wake word state
  const [settings, setSettings] = useState<BikliSettings>(() => loadSettings());
  const [showSettings, setShowSettings] = useState<boolean>(false);
  const [wakeState, setWakeState] = useState<WakeWordState>("stopped");
  const showSettingsRef = useRef<boolean>(false);
  useEffect(() => { showSettingsRef.current = showSettings; }, [showSettings]);

  // V2: Wake word detector instance (Web Speech API, lives for the app lifetime)
  const wakeDetectorRef = useRef<BikliWakeWordDetector | null>(null);
  // Ref indirection so the wake-word callback always calls the latest connect
  // handler, regardless of where it's declared in the component body.
  // Must FORCE connect (never toggle) — returns true only when live session is up.
  const connectHandlerRef = useRef<() => Promise<boolean>>(async () => false);
  const settingsRef = useRef(settings);
  useEffect(() => { settingsRef.current = settings; }, [settings]);

  // Initialize wake detector once on mount.
  useEffect(() => {
    const det = new BikliWakeWordDetector();
    wakeDetectorRef.current = det;
    return () => {
      det.stop();
    };
  }, []);

  // Start / stop wake word detection when the setting or live state changes.
  useEffect(() => {
    const det = wakeDetectorRef.current;
    if (!det) return;

    // Only fully stop wake when Bikli is LIVE. While connecting, leave handoff alone.
    if (!settings.wakeWordEnabled) {
      det.stop();
      setWakeState("stopped");
      return;
    }
    if (state === "listening" || state === "speaking") {
      det.stop();
      setWakeState("stopped");
      return;
    }
    // state === disconnected | connecting — keep / start wake (connecting: soft update only)
    if (state === "connecting") {
      return;
    }

    const startDetector = () => {
      if (!BikliWakeWordDetector.isSupported()) {
        setWakeState("error");
        console.error("[WakeWord] SpeechRecognition not supported in this environment.");
        setErrorText(
          "Wake word needs speech recognition (online). Use the power button, or check mic permission + internet.",
        );
        return;
      }
      det.start({
        phrase: settings.wakePhrase,
        sensitivity: settings.sensitivity,
        micDeviceId: settings.micDeviceId,
        onState: (s) => setWakeState(s),
        onTriggered: async () => {
          // Detector already stopped SpeechRecognition and freed the mic.
          // Return true ONLY when live session is up — false re-arms wake word.
          console.log("[WakeWord] Triggered — connecting live mic session…");
          try {
            const ok = await connectHandlerRef.current();
            console.log("[WakeWord] Connect result:", ok);
            return ok === true;
          } catch (err) {
            console.error("[WakeWord] Connect threw:", err);
            return false;
          }
        },
      });
    };

    // Delay wake re-arm after a manual disconnect so the user can toggle
    // back ON without the wake word racing for the mic. Without this
    // cooldown, disconnecting re-triggers det.start() which grabs the mic,
    // and the next click's getUserMedia fails → button spins forever.
    if (state === "disconnected" && lastManualDisconnectRef.current) {
      const elapsed = Date.now() - lastManualDisconnectRef.current;
      if (elapsed < 2000) {
        const waitMs = 2000 - elapsed;
        console.log(`[WakeWord] Manual disconnect cooldown — waiting ${waitMs}ms before re-arm`);
        const cooldownTimer = setTimeout(() => {
          if (stateRef.current === "disconnected" && settingsRef.current.wakeWordEnabled) {
            // Full start(), NOT ensureListening(): the detector was stopped when
            // the session went live (intended=false), and ensureListening() is a
            // no-op in that state — so wake word never re-armed after the power
            // button. start() re-arms it properly.
            startDetector();
          }
        }, waitMs);
        // Cancel on unmount / re-run so a stale cooldown cannot re-arm the
        // detector after the effect that scheduled it is gone.
        return () => clearTimeout(cooldownTimer);
      }
    }

    startDetector();
  }, [settings.wakeWordEnabled, settings.wakePhrase, settings.sensitivity, settings.micDeviceId, state]);

  // Re-arm wake word when Electron window gains focus (SpeechRecognition dies unfocused).
  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState !== "visible") return;
      if (!settingsRef.current.wakeWordEnabled) return;
      if (stateRef.current !== "disconnected") return;
      wakeDetectorRef.current?.ensureListening();
    };
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("focus", onVis);

    let unsub: (() => void) | undefined;
    try {
      const api = (window as any).bikli;
      if (typeof api?.onWindowFocus === "function") {
        unsub = api.onWindowFocus(() => {
          if (!settingsRef.current.wakeWordEnabled) return;
          if (stateRef.current !== "disconnected") return;
          console.log("[WakeWord] Window focused — ensuring wake listener");
          wakeDetectorRef.current?.ensureListening();
        });
      }
    } catch {
      /* ignore */
    }

    return () => {
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("focus", onVis);
      try {
        unsub?.();
      } catch {
        /* ignore */
      }
    };
  }, []);

  // Track how long we've been in "connecting" so we can hard-reset if stuck.
  const connectingSinceRef = useRef<number | null>(null);
  useEffect(() => {
    if (state === "connecting") {
      if (connectingSinceRef.current == null) {
        connectingSinceRef.current = Date.now();
      }
    } else {
      connectingSinceRef.current = null;
    }
  }, [state]);

  // Startup + stuck-connecting recovery:
  // 1) After boot, re-arm wake listening a few times (SpeechRecognition often
  //    fails the first launch attempt until the window is fully ready).
  // 2) If live session stays "connecting" too long, hard-reset so UI is not
  //    stuck spinning / thinking with no answers.
  useEffect(() => {
    const bootTimers: ReturnType<typeof setTimeout>[] = [];
    for (const ms of [800, 2500, 6000]) {
      bootTimers.push(
        setTimeout(() => {
          if (!settingsRef.current.wakeWordEnabled) return;
          if (stateRef.current !== "disconnected") return;
          console.log(`[WakeWord] Startup ensureListening @ ${ms}ms`);
          wakeDetectorRef.current?.ensureListening();
        }, ms),
      );
    }

    const stuckWatch = setInterval(() => {
      if (stateRef.current !== "connecting") return;
      const since = connectingSinceRef.current;
      if (since == null) return;
      const stuckFor = Date.now() - since;
      // Show a warning while stuck but before the full timeout
      if (stuckFor > 12000 && stuckFor < 14000) {
        setErrorText(
          "Still starting the voice link — this usually takes a few seconds. If it takes much longer, click the power button to retry.",
        );
      }
      // Must exceed Gemini ready timeout (~20s) + a little slack
      if (stuckFor < 30000) return;
      const session = sessionRef.current;
      if (!session || session.getState() !== "connecting") return;
      console.warn("[Mic] Stuck connecting watchdog — forcing disconnect");
      connectingSinceRef.current = null;
      try {
        session.disconnect();
      } catch {
        /* ignore */
      }
      setCharacterState("idle");
      setActiveEmotion("idle");
      setErrorText(
        "Voice link timed out. Check that: 1) Your Gemini API key is valid in Settings, 2) You have internet access, 3) No other app is using the microphone. Then click the power button to try again.",
      );
    }, 3000);

    return () => {
      bootTimers.forEach(clearTimeout);
      clearInterval(stuckWatch);
    };
  }, []);

  // Handle settings changes: persist to localStorage + update state.
  const handleSettingsChange = (patch: Partial<BikliSettings>) => {
    const next = saveSettings(patch);
    setSettings(next);
  };

  // Fetch initial recollections from backend database
  useEffect(() => {
    fetch("/api/memories")
      .then(res => res.json())
      .then(data => {
        if (Array.isArray(data)) {
          setMemories(data);
        }
      })
      .catch(err => console.error("Initial persistent recollections load failure:", err));
  }, []);

  const handleAddManualMemory = async (category: MemoryCategory, text: string) => {
    // Do NOT swallow failures — the dashboard shows them to the user. Before,
    // a failed save silently left the form thinking it succeeded.
    const resp = await fetch("/api/memories", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ category, text })
    });
    if (!resp.ok) {
      throw new Error(`Memory not saved (server returned ${resp.status}).`);
    }
    const saved = await resp.json();
    if (saved && saved.id) {
      setMemories((prev) => [...prev, saved]);
    } else {
      throw new Error("Memory not saved — unexpected server response.");
    }
  };

  const handleDeleteMemory = async (id: string) => {
    try {
      const resp = await fetch(`/api/memories/${id}`, {
        method: "DELETE"
      });
      if (!resp.ok) throw new Error(`DELETE returned ${resp.status}`);
      // Handle both 204 No Content and JSON response bodies
      const resObj = resp.status === 204 ? { success: true } : await resp.json();
      if (resObj && (resObj.success || resObj.ok)) {
        setMemories((prev) => prev.filter(m => m.id !== id));
      }
    } catch (err) {
      console.error("Manual memory delete execution failed:", err);
    }
  };

  const handleUpdateMemory = async (id: string, category: MemoryCategory, text: string) => {
    const resp = await fetch(`/api/memories/${id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ category, text })
    });
    if (!resp.ok) {
      throw new Error(`Memory not updated (server returned ${resp.status}).`);
    }
    const updated = await resp.json();
    if (updated && updated.id) {
      setMemories((prev) => prev.map(m => (m.id === updated.id ? updated : m)));
    } else {
      throw new Error("Memory not updated — unexpected server response.");
    }
  };

  /**
   * Desktop/click/screen tasks must NEVER end the mic session.
   */
  const isDesktopTaskPhrase = (raw: string): boolean => {
    const t = raw.toLowerCase().replace(/[^\w\s']/g, " ").replace(/\s+/g, " ").trim();
    if (!t) return false;
    return /\b(click|double[\s-]?click|right[\s-]?click|mouse|cursor|screenshot|screen|what (do |can )?you see|what('?s| is) on (my |the )?screen|read (the |my )?screen|type|scroll|move (the )?mouse|drag|open (app|application|notepad|chrome|folder)|close (app|window)|volume|brightness)\b/.test(
      t,
    );
  };

  /**
   * Detect spoken "mic off" style commands from user captions.
   * STRICT — only clear hang-up phrases. Never match click / see / screen tasks.
   */
  const isMicOffPhrase = (raw: string): boolean => {
    const t = raw.toLowerCase().replace(/[^\w\s']/g, " ").replace(/\s+/g, " ").trim();
    if (!t) return false;
    // Never hang up while user is asking for desktop/click/screen work
    if (isDesktopTaskPhrase(t)) return false;
    // Exact short hang-up commands only
    const exact = [
      "mic off",
      "mike off",
      "microphone off",
      "turn off mic",
      "turn off the mic",
      "turn off microphone",
      "turn off the microphone",
      "turn the mic off",
      "turn the microphone off",
      "stop listening",
      "go to sleep",
      "hang up",
      "end the call",
      "end call",
    ];
    if (exact.includes(t)) return true;
    // Allow short wrappers only ("please mic off", "bikli mic off") — max 5 words
    const words = t.split(/\s+/);
    if (words.length <= 5) {
      if (/\b(mic|mike|microphone)\s+off\b/.test(t)) return true;
      if (/\bturn\s+off\s+(the\s+)?(mic|mike|microphone)\b/.test(t)) return true;
      if (/\b(stop listening|go to sleep|hang up|end (the )?call)\b/.test(t)) return true;

      // Anchored farewell regexes — only match pure goodbye phrases, never substrings
      const farewellRegex = /^(ok\s+)?(bye\s+bye|bye|goodbye|good\s+bye)(\s+now|\s+then|\s+for\s+now)?(\s+bikli)?$/;
      const seeYouRegex = /^(ok\s+)?see\s+(you|ya)(\s+later|\s+tomorrow|\s+then|\s+soon)?(\s+bikli)?$/;
      const takeCareRegex = /^(please\s+|ok\s+)?take\s+care(\s+now)?(\s+bikli)?$/;
      const talkLaterRegex = /^(talk|catch\s+up)(\s+to\s+you)?\s+later(\s+bikli)?$/;
      const cyaRegex = /^(cya|ttyl)(\s+later)?(\s+bikli)?$/;

      if (
        farewellRegex.test(t) ||
        seeYouRegex.test(t) ||
        takeCareRegex.test(t) ||
        talkLaterRegex.test(t) ||
        cyaRegex.test(t)
      ) {
        return true;
      }
    }
    return false;
  };

  /**
   * Returns true when the user's phrase is a farewell that should also
   * close the entire app (not just turn the mic off).
   */
  const isGoodbyeAndClosePhrase = (raw: string): boolean => {
    const t = raw.toLowerCase().replace(/[^\w\s']/g, " ").replace(/\s+/g, " ").trim();
    if (!t) return false;
    if (isDesktopTaskPhrase(t)) return false;
    const exact = ["bye", "bye bye", "goodbye", "good bye", "see you", "see ya",
                   "take care", "talk later", "talk to you later", "ttyl", "cya"];
    if (exact.includes(t)) return true;
    const words = t.split(/\s+/);
    if (words.length <= 5) {
      const farewellRegex = /^(ok\s+)?(bye\s+bye|bye|goodbye|good\s+bye)(\s+now|\s+then|\s+for\s+now)?(\s+bikli)?$/;
      const seeYouRegex = /^(ok\s+)?see\s+(you|ya)(\s+later|\s+tomorrow|\s+then|\s+soon)?(\s+bikli)?$/;
      const takeCareRegex = /^(please\s+|ok\s+)?take\s+care(\s+now)?(\s+bikli)?$/;
      const talkLaterRegex = /^(talk|catch\s+up)(\s+to\s+you)?\s+later(\s+bikli)?$/;
      const cyaRegex = /^(cya|ttyl)(\s+later)?(\s+bikli)?$/;

      if (
        farewellRegex.test(t) ||
        seeYouRegex.test(t) ||
        takeCareRegex.test(t) ||
        talkLaterRegex.test(t) ||
        cyaRegex.test(t)
      ) {
        return true;
      }
    }
    return false;
  };

  /**
   * Detect spoken control / release word from live captions (client backup).
   * Server also unlocks; this keeps the UI badge snappy. STRICT matching.
   */
  const detectControlPhraseLocal = (raw: string): "enable" | "disable" | null => {
    const t = raw.toLowerCase().replace(/[^\w\s']/g, " ").replace(/\s+/g, " ").trim();
    if (!t) return null;
    // Don't flip control during click/screen requests
    if (isDesktopTaskPhrase(t) && !/\b(stop|release|end|disable|cancel|lock)\s+control\b/.test(t)) {
      return null;
    }
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
    if (t.split(/\s+/).length <= 6 && /\b(stop|release|end|disable|cancel|lock)\s+control\b/.test(t)) {
      return "disable";
    }
    if (t.split(/\s+/).length <= 6 && /\bstop\s+controlling\b/.test(t)) return "disable";

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
    if (t.split(/\s+/).length <= 3 && /\bcontrol\b$/.test(t) && !isDesktopTaskPhrase(t)) return "enable";
    return null;
  };

  /** End live session and release the microphone (same as sleep button). */
  const turnOffMicNow = (reason = "voice command") => {
    console.log(`[Mic] Turning off microphone (${reason})…`);
    if (sessionRef.current && sessionRef.current.getState() !== "disconnected") {
      sessionRef.current.disconnect();
    }
  };

  /** Close the whole app after an optional delay (ms). Works in Electron; falls back to window.close(). */
  const closeApp = (delayMs = 1200) => {
    setTimeout(() => {
      try {
        const w = window as any;
        if (w.bikli?.quit) {
          w.bikli.quit();
        } else {
          window.close();
        }
      } catch {
        window.close();
      }
    }, delayMs);
  };

  // Initialize the audio session handlers once on mount
  useEffect(() => {
    sessionRef.current = new BikliAudioSession({
      onStateChange: (newState) => {
        setState(newState);
        if (newState === "disconnected") {
          userTranscriptRef.current = "";
          modelTranscriptRef.current = "";
          setActiveEmotion("idle");
          setCharacterState("idle");
          // Cancel any pending goodbye close timer (user may have manually disconnected)
          if (goodbyeSafetyTimer.current) {
            clearTimeout(goodbyeSafetyTimer.current);
            goodbyeSafetyTimer.current = null;
          }
          goodbyePendingRef.current = false;
          // Re-lock PC control when the live session ends (safety)
          setComputerControlEnabled(false);
          void fetch("/api/desktop/control", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ enabled: false, reason: "session ended" }),
          }).catch(() => {});
        } else if (newState === "listening") {
          setActiveEmotion("idle");
          // Stay idle while listening — no thinking zoom pop between turns
          setCharacterState("idle");
          modelTranscriptRef.current = "";
          setErrorText(null);
          // Re-sync screen-vision gate after live session is up
          if (
            isScreenSharingRef.current &&
            !isPausedRef.current &&
            screenVisionRef.current
          ) {
            sessionRef.current?.setScreenShareActive(true);
            sessionRef.current?.flushScreenShareState();
            setTimeout(() => captureFrameAndSend(), 200);
            setTimeout(() => captureFrameAndSend(), 700);
          }
        } else if (newState === "speaking") {
          userTranscriptRef.current = "";
          setCharacterState("talking");
          setErrorText(null);
        } else if (newState === "connecting") {
          // Connecting spinner only — never leave face stuck on "thinking"
          setCharacterState("idle");
        }
      },
      onTranscription: (role, text) => {
        if (role === "user") {
          const prev = userTranscriptRef.current;
          const combined = !prev
            ? text
            : text.startsWith(prev)
              ? text
              : prev.endsWith(text)
                ? prev
                : `${prev}${text}`;
          const clipped = combined.length > 400 ? combined.slice(-400) : combined;
          userTranscriptRef.current = clipped;
          modelTranscriptRef.current = "";
          // Do NOT flip to "thinking" on every user phrase — that caused a face
          // zoom/pop while Bluetooth / settings tools ran. Stay idle until she speaks.

          // Fast path: user said "mic off" (or similar) — end live mic session.
          // IMPORTANT: a GOODBYE must NOT hang up instantly. Doing that killed
          // the session the moment Gemini transcribed "bye", so Bikli never got
          // to speak her farewell — the app just closed silently. For goodbye we
          // leave the session live so she can say it and call turnOffMic (which
          // closes below), with a safety-net close in case she never responds.
          const isBye =
            isGoodbyeAndClosePhrase(text) || isGoodbyeAndClosePhrase(clipped);
          if (isBye) {
            // Mark that this is a goodbye so turnOffMic tool closes the app
            // instead of just disconnecting the mic. Do NOT close instantly here —
            // let Bikli speak her farewell first, then close.
            goodbyePendingRef.current = true;
            // Safety-net: if Gemini never calls turnOffMic within 8s, close anyway.
            if (goodbyeSafetyTimer.current) clearTimeout(goodbyeSafetyTimer.current);
            goodbyeSafetyTimer.current = setTimeout(() => {
              if (goodbyePendingRef.current) {
                goodbyePendingRef.current = false;
                closeApp(0);
              }
            }, 8000);
          } else if (isMicOffPhrase(text) || isMicOffPhrase(clipped)) {
            turnOffMicNow("user transcript: " + clipped);
          }
          // Control word → unlock/lock full PC + cursor (server also does this)
          const ctrl = detectControlPhraseLocal(text) || detectControlPhraseLocal(clipped);
          if (ctrl === "enable") {
            setComputerControlEnabled(true);
            void fetch("/api/desktop/control", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ enabled: true, reason: "client transcript: " + clipped }),
            }).catch(() => {});
          } else if (ctrl === "disable") {
            setComputerControlEnabled(false);
            void fetch("/api/desktop/control", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ enabled: false, reason: "client transcript: " + clipped }),
            }).catch(() => {});
          }
        } else if (role === "model") {
          // Emotion only — never show model text on screen
          modelTranscriptRef.current = (modelTranscriptRef.current + text).slice(-600);
          setActiveEmotion(detectEmotionFromText(modelTranscriptRef.current));
          userTranscriptRef.current = "";
        }
      },
      onToolCall: (name, args, callback) => {
        console.log(`[App] Tool call triggered: ${name}`, args);
        
        // openWebsite / search* / browserMediaControl / browserScroll / browserType
        // are handled by the server/desktop agent (real Chrome/Edge).
        // Only pure in-app browser automation stays on the client iframe.
        const clientBrowserTools = [
          "browserOpen",
          "browserSearch",
          "browserClick",
          "browserGoBack",
          "browserTabAction",
        ];

        if (clientBrowserTools.includes(name)) {
          let triggerType = name;
          let triggerArgs: any = args || {};

          if (name === "browserOpen") {
            const url = resolveInbuiltUrl(args?.url || "youtube.com");
            triggerArgs = { ...args, url };
            ensureBackgroundBrowser(url);
          } else {
            // Other browser actions still need the engine alive
            ensureBackgroundBrowser();
          }

          setBrowserTrigger({
            type: triggerType,
            args: triggerArgs,
            id: Math.random().toString(),
            callback: (res) => {
              callback(res);
              setBrowserTrigger(null);
            },
          });
        } else if (name === "changeBackground") {
          const colorName = args.color?.toLowerCase();
          const validColors = ["violet", "crimson", "emerald", "celestial", "gold", "rose", "charcoal"];
          
          if (colorName && validColors.includes(colorName)) {
            setThemeColor(colorName);
            callback({ result: `Successfully shifted aesthetic atmosphere to ${colorName}.` });
          } else {
            callback({ error: `Unsupported color '${colorName}'. Supported themes are: ${validColors.join(", ")}` });
          }
        } else if (name === "turnOffMic") {
          // Guard: never hang up if the latest user speech was a desktop/click/see task
          // (model sometimes wrongly calls turnOffMic after tool work).
          const recent = (userTranscriptRef.current || "").toLowerCase();
          if (isDesktopTaskPhrase(recent)) {
            console.warn("[Mic] Ignoring turnOffMic — last user speech was a desktop/click/see task:", recent);
            callback({
              result:
                "Not ending the session — user asked for a desktop/click/screen action. Stay on the call.",
            });
          } else {
            // Gemini heard a clear "mic off" / "bye" and requested session end.
            // Check both the tool-call context and the pending-goodbye flag.
            const recentUserSpeech = userTranscriptRef.current || "";
            const isGoodbye =
              goodbyePendingRef.current ||
              isGoodbyeAndClosePhrase(recentUserSpeech);
            if (isGoodbye) {
              // Cancel the safety-net timer — we got the proper tool call.
              if (goodbyeSafetyTimer.current) {
                clearTimeout(goodbyeSafetyTimer.current);
                goodbyeSafetyTimer.current = null;
              }
              goodbyePendingRef.current = false;
              // Acknowledge first so Gemini can speak the farewell audio,
              // then close after enough time for the audio to finish playing.
              callback({ result: "Goodbye! Closing Bikli now." });
              // 3 seconds — enough for a short farewell to finish playing.
              closeApp(3000);
            } else {
              // Plain "mic off" — just end the session, don't close the app.
              turnOffMicNow("turnOffMic tool");
              callback({ result: "Microphone turned off. Live session ended." });
            }
          }
        } else {
          callback({ error: `Tool ${name} is not implemented.` });
        }
      },
      onError: (err) => {
        const text = String(err || "");
        // During connecting phase, ALL errors are shown — never suppress them
        // (the "only rotates" bug was caused by mid-call soft suppression
        // swallowing connection failures).
        // Also save to connectErrorRef so the retry fallback can avoid
        // overwriting a specific server error with a generic message.
        if (stateRef.current === "connecting") {
          setErrorText(text);
          connectErrorRef.current = text;
          return;
        }
        // Soft tool/desktop noise must not flood the red "Core Error Protocol" banner.
        if (
          /desktop|tool|control is locked|screenshot|agent|timeout|could not complete|speak_now|timed out|nothing listening|ECONNREFUSED|not running|LOCKED|busy|coalesced/i.test(
            text,
          )
        ) {
          console.warn("[App] Soft error (banner suppressed):", text);
          return;
        }
        setErrorText(text);
      },
      onMemorySync: (updatedMemories) => {
        console.log("[App] WebSocket memories sync triggered:", updatedMemories);
        if (Array.isArray(updatedMemories)) {
          setMemories(updatedMemories);
        }
      },
      onComputerControl: (enabled, meta) => {
        console.log("[App] Computer control:", enabled, meta);
        setComputerControlEnabled(enabled);
      },
    });

    return () => {
      if (sessionRef.current) {
        sessionRef.current.disconnect();
      }
    };
  }, []);

  /**
   * Always start the live mic session (used by wake word — never toggles off).
   * Returns true only when the session reaches listening/speaking.
   * connect() returns early when the socket is opened; mic setup is async,
   * so we poll until live or failed.
   */
  const handleForceConnect = async (): Promise<boolean> => {
    setErrorText(null);
    connectErrorRef.current = null;
    if (!sessionRef.current) {
      console.error("[WakeWord/Connect] No audio session instance");
      return false;
    }

    // Up to 3 full connect attempts after wake (mic often still busy once or twice).
    for (let attempt = 1; attempt <= 3; attempt++) {
      const current = sessionRef.current.getState();
      if (current === "listening" || current === "speaking") {
        return true;
      }

      // If stuck mid-connect, reset first
      if (current === "connecting" || current !== "disconnected") {
        sessionRef.current.disconnect();
        await new Promise((r) => setTimeout(r, 550));
      }

      // Extra settle after SpeechRecognition released the device (Windows).
      if (attempt === 1) {
        await new Promise((r) => setTimeout(r, 350));
      } else {
        console.warn(`[WakeWord/Connect] Retry connect attempt ${attempt}…`);
        await new Promise((r) => setTimeout(r, 800 + attempt * 200));
      }

      try {
        await sessionRef.current.connect({
          micDeviceId: settingsRef.current.micDeviceId || undefined,
        });

        // Wait up to ~22s for mic + WS + Gemini to become fully live
        // (must wait for status=connected, not just local WS open)
        for (let i = 0; i < 150; i++) {
          await new Promise((r) => setTimeout(r, 150));
          const s = sessionRef.current?.getState();
          if (s === "listening" || s === "speaking") {
            console.log("[WakeWord/Connect] Live session ready:", s);
            setErrorText(null);
            setActiveEmotion("idle");
            setCharacterState("idle");
            if (
              isScreenSharingRef.current &&
              !isPausedRef.current &&
              screenVisionRef.current
            ) {
              sessionRef.current?.setScreenShareActive(true);
              sessionRef.current?.flushScreenShareState();
              setTimeout(() => captureFrameAndSend(), 200);
              setTimeout(() => captureFrameAndSend(), 700);
            }
            return true;
          }
          // Failed hard back to disconnected — try again if attempts remain
          if (s === "disconnected" && i > 4) {
            console.warn("[WakeWord/Connect] Session dropped during handoff");
            // Don't retry auth errors (invalid API key, quota) — Gemini
            // will keep refusing. Surface the specific error and stop.
            if (connectErrorRef.current && /API_KEY|invalid|unauthorized|key/i.test(connectErrorRef.current)) {
              return false;
            }
            break;
          }
        }
      } catch (err: any) {
        console.error(`[WakeWord/Connect] Attempt ${attempt} failed:`, err);
        if (attempt === 3) {
          setErrorText(err?.message || "Could not turn on the microphone.");
          return false;
        }
      }
    }

    console.warn("[WakeWord/Connect] Timed out waiting for live session");
    setErrorText(
      connectErrorRef.current ||
        "I heard you, but the microphone didn't turn on. Check mic permission and that no other app is using the mic, then try saying hey/hi again.",
    );
    return false;
  };

  /**
   * Power / mic button. Must release wake-word mic BEFORE live getUserMedia,
   * especially after Share Screen (media stack is often busy).
   */
  const handleToggleConnection = async () => {
    setErrorText(null);
    connectErrorRef.current = null;
    const session = sessionRef.current;
    if (!session) return;

    const current = session.getState();

    // Already live → sleep / turn mic off
    if (current === "listening" || current === "speaking") {
      session.disconnect();
      lastManualDisconnectRef.current = Date.now();
      return;
    }

    // Stuck connecting / half-open → hard reset then retry
    if (current === "connecting" || current !== "disconnected") {
      console.warn("[Mic] Resetting session before button connect…");
      session.disconnect();
      await new Promise((r) => setTimeout(r, 300));
    }

    // CRITICAL: stop wake-word SpeechRecognition so it frees the microphone.
    // Without this, getUserMedia fails after share-screen / wake listening.
    const det = wakeDetectorRef.current;
    const wasWaking =
      !!det &&
      (wakeState === "listening" || wakeState === "starting" || wakeState === "triggered");
    if (det) {
      try {
        det.stop();
      } catch {
        /* ignore */
      }
      setWakeState("stopped");
    }
    // Windows keeps the capture device locked ~300-700ms after a
    // SpeechRecognition.abort(). If the wake detector was actually holding the
    // mic, give the OS a short beat BEFORE connect() opens it — otherwise the
    // mic retry ladder spins for many seconds and the button looks like a
    // spinner that "never opens the mic". When wake was already idle, wait 0ms.
    if (wasWaking) {
      await new Promise((r) => setTimeout(r, 400));
    }

    // Two full attempts — first often fails while OS still holds the mic.
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        if (attempt > 1) {
          console.warn(`[Mic] Button connect retry #${attempt}…`);
          const s = sessionRef.current;
          if (s) {
            try { s.disconnect(); } catch { /* ignore */ }
          }
          await new Promise((r) => setTimeout(r, 400));
        }

        const activeSession = sessionRef.current;
        if (!activeSession) break;
        await activeSession.connect({
          micDeviceId: settingsRef.current.micDeviceId || undefined,
        });

        // Wait until mic + WS + Gemini are fully live (status=connected)
        // Fine-grained (100ms) so the button flips to "on" the moment it's ready.
        let ok = false;
        for (let i = 0; i < 100; i++) {
          await new Promise((r) => setTimeout(r, 100));
          const s = sessionRef.current?.getState();
          if (s === "listening" || s === "speaking") {
            ok = true;
            break;
          }
          if (s === "disconnected" && i > 3) break;
        }

        if (ok) {
          setErrorText(null);
          setActiveEmotion("idle");
          setCharacterState("idle");
          // Re-sync screen-vision gate so vision works with the new live session
          if (
            isScreenSharingRef.current &&
            !isPausedRef.current &&
            screenVisionRef.current
          ) {
            sessionRef.current?.setScreenShareActive(true);
            sessionRef.current?.flushScreenShareState();
            setTimeout(() => captureFrameAndSend(), 200);
            setTimeout(() => captureFrameAndSend(), 800);
          }
          console.log("[Mic] Live session on after button press");
          return;
        }

        console.warn(`[Mic] Button connect attempt ${attempt} did not reach listening`);
        // Don't retry if the specific error is an auth/key issue — Gemini
        // will keep refusing. Show the specific error and stop immediately
        // so the user isn't stuck watching the button spin on a bad API key.
        if (connectErrorRef.current && /API_KEY|invalid|unauthorized|key/i.test(connectErrorRef.current)) {
          setCharacterState("idle");
          setActiveEmotion("idle");
          return;
        }
      } catch (err: any) {
        console.error(`[Mic] Toggle connect attempt ${attempt} failed:`, err);
        if (attempt === 2) {
          setCharacterState("idle");
          setActiveEmotion("idle");
          setErrorText(err?.message || "Could not turn on the microphone.");
          return;
        }
      }
    }

    // Hard-reset so next press is clean
    try {
      sessionRef.current?.disconnect();
    } catch {
      /* ignore */
    }
    setCharacterState("idle");
    setActiveEmotion("idle");
    // Use the captured server error if available (e.g. "invalid API key")
    // instead of the generic fallback — the generic "did not start" message
    // was overwriting specific auth / rate-limit errors as the retry loop
    // exhausted both attempts.
    setErrorText(
      connectErrorRef.current ||
        "Microphone / voice link did not start. Allow mic access, check internet + API key, close other apps using the mic, then try again.",
    );
  };
  // V2: wake-word callback always force-connects (never disconnects).
  connectHandlerRef.current = handleForceConnect;

  // NOTE: the animated voice waveform now lives in its own <LiveWaveform>
  // component (self-contained rAF, no setState) so it no longer re-renders
  // the entire App at 20Hz during a live conversation. See components/LiveWaveform.tsx.

  // Maps theme colors to CSS ambient light spots
  const getAmbientStyles = () => {
    switch (themeColor) {
      case "violet":
        return "from-purple-950/40 via-violet-950/20 to-slate-950";
      case "crimson":
        return "from-red-950/40 via-orange-950/20 to-slate-950";
      case "emerald":
        return "from-emerald-950/40 via-teal-950/20 to-slate-950";
      case "celestial":
        return "from-sky-950/45 via-indigo-950/25 to-slate-950";
      case "gold":
        return "from-amber-950/30 via-yellow-950/15 to-slate-950";
      case "rose":
        return "from-rose-950/40 via-pink-950/20 to-slate-950";
      case "charcoal":
      default:
        return "from-slate-900/50 via-slate-950/30 to-slate-950";
    }
  };

  const getThemeTextGlow = () => {
    switch (themeColor) {
      case "violet": return "text-purple-400 drop-shadow-[0_0_12px_rgba(168,85,247,0.5)]";
      case "crimson": return "text-rose-400 drop-shadow-[0_0_12px_rgba(244,63,94,0.5)]";
      case "emerald": return "text-emerald-400 drop-shadow-[0_0_12px_rgba(16,185,129,0.5)]";
      case "celestial": return "text-sky-400 drop-shadow-[0_0_12px_rgba(14,165,233,0.5)]";
      case "gold": return "text-amber-400 drop-shadow-[0_0_12px_rgba(245,158,11,0.5)]";
      case "rose": return "text-pink-400 drop-shadow-[0_0_12px_rgba(244,63,94,0.5)]";
      case "charcoal":
      default:
        return "text-indigo-400 drop-shadow-[0_0_12px_rgba(99,102,241,0.5)]";
    }
  };

  const getOrbRingColor = () => {
    switch (state) {
      case "listening": return "border-indigo-500/50 shadow-[0_0_30px_rgba(99,102,241,0.3)] bg-indigo-500/10";
      case "speaking": return "border-purple-500/70 shadow-[0_0_40px_rgba(168,85,247,0.4)] bg-purple-500/10";
      case "connecting": return "border-amber-500/50 animate-pulse bg-amber-500/10";
      case "disconnected":
      default:
        return "border-white/10 hover:border-indigo-500/30 bg-white/5";
    }
  };

  // Colors for the animated lighting border sweep (per theme).
  const getBorderLight = () => {
    switch (themeColor) {
      case "violet": return { faint: "rgba(147,51,234,0.20)", bright: "rgba(168,85,247,0.9)", accent: "rgba(236,72,153,0.95)" };
      case "crimson": return { faint: "rgba(225,29,72,0.20)", bright: "rgba(244,63,94,0.9)", accent: "rgba(234,88,12,0.95)" };
      case "emerald": return { faint: "rgba(5,150,105,0.20)", bright: "rgba(16,185,129,0.9)", accent: "rgba(52,211,153,0.95)" };
      case "celestial": return { faint: "rgba(2,132,199,0.20)", bright: "rgba(14,165,233,0.9)", accent: "rgba(56,189,248,0.95)" };
      case "gold": return { faint: "rgba(202,138,4,0.20)", bright: "rgba(234,179,8,0.9)", accent: "rgba(250,204,21,0.95)" };
      case "rose": return { faint: "rgba(219,39,119,0.20)", bright: "rgba(236,72,153,0.9)", accent: "rgba(251,113,133,0.95)" };
      case "charcoal":
      default:
        return { faint: "rgba(99,102,241,0.20)", bright: "rgba(34,211,238,0.9)", accent: "rgba(129,140,248,0.95)" };
    }
  };

  const borderLight = getBorderLight();

  // Warm gold glow for the small suggestion cards (distinct "new color" vs the
  // theme-colored home border sweep).
  const cardGlow = {
    faint: "rgba(251,191,36,0.22)",
    bright: "rgba(251,191,36,0.95)",
    accent: "rgba(245,158,11,0.95)",
  };
  const suggestionCards = [
    { text: "Bikli, change atmosphere of your core to crimson", desc: "Shifts theme color background" },
    { text: "Open youtube.com", desc: "Opens in-built browser in background (hidden)" },
    { text: "Tell me a witty joke and change background to gold", desc: "Combines tools & voice" },
    { text: "Mic off", desc: "Turns off Bikli's mic and ends the live session" },
  ];

  return (
    <div
      id="bikli-holographic-desktop"
      className={`relative w-full h-screen overflow-hidden bg-[#020205] text-white ${getAmbientStyles()} theme-transition flex flex-col justify-between p-6 sm:p-10 select-none`}
    >
      {/* Ambient Background Gradients matching Frosted Glass theme */}
      <div className="absolute top-[-10%] left-[-10%] w-[500px] h-[500px] bg-purple-900/15 rounded-full blur-[120px] pointer-events-none" />
      <div className="absolute bottom-[-10%] right-[-10%] w-[600px] h-[600px] bg-cyan-900/15 rounded-full blur-[150px] pointer-events-none" />
      <div className="absolute top-[20%] right-[10%] w-[300px] h-[300px] bg-indigo-800/10 rounded-full blur-[100px] pointer-events-none" />

      {/* Decorative grid pattern background */}
      <div className="absolute inset-0 bg-[linear-gradient(rgba(255,255,255,0.012)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.012)_1px,transparent_1px)] bg-[size:32px_32px] pointer-events-none opacity-40" />

      {/* Very dim ambient floating particles (background loop) */}
      <div className="absolute inset-0 pointer-events-none overflow-hidden">
        {AMBIENT_PARTICLES.map((p, i) => (
          <span
            key={i}
            className="bikli-ambient-particle"
            style={{
              left: p.left,
              top: p.top,
              width: p.size,
              height: p.size,
              animationDelay: `${p.delay}s`,
              animationDuration: `${p.dur}s`,
            }}
          />
        ))}
      </div>

      {/* Animated lighting sweep around the home-screen border (theme-colored) */}
      <div
        className="border-light-sweep z-[45]"
        style={{
          "--glow-faint": borderLight.faint,
          "--glow-bright": borderLight.bright,
          "--glow-accent": borderLight.accent,
        } as any}
      />

      {/* FULL VIEWPORT HOLOGRAPHIC STAGE: Bikli materializes across the entire screen */}
      <div className="absolute inset-0 z-0 pointer-events-none select-none">
        <BikliCoreVisualizer
          session={sessionRef.current}
          state={state}
          themeColor={themeColor}
          activeEmotion={activeEmotion}
          characterState={characterState}
        />
      </div>

      {/* HEADER SECTION - Minimalist typography */}
      <header className="relative z-30 flex items-center justify-between w-full max-w-5xl mx-auto select-none">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold tracking-[0.4em] text-white/50 uppercase font-sans">
            Bikli
          </span>
          <div className={`w-1.5 h-1.5 rounded-full ${
            state === "listening" || state === "speaking" 
              ? "bg-cyan-400" 
              : wakeState === "listening"
              ? "bg-emerald-400 animate-pulse"
              : wakeState === "error"
              ? "bg-rose-400"
              : "bg-white/10"
          }`} />
          {state === "disconnected" && settings.wakeWordEnabled && (
            wakeState === "error" ? (
              /* Pill-shaped error badge: red dot pulses + text shakes subtly */
              <span className="bikli-err-badge">
                <span className="bikli-err-dot" />
                <span className="bikli-err-text">Wake Mic Error</span>
              </span>
            ) : (
              <span className={`text-[9px] font-mono tracking-wider uppercase ml-1 ${
                wakeState === "listening"
                  ? "text-emerald-400/80"
                  : wakeState === "starting" || wakeState === "triggered"
                  ? "text-amber-300/80"
                  : "text-white/30"
              }`}>
                {wakeState === "listening"
                  ? "Say hey or hi"
                  : wakeState === "starting"
                  ? "Arming wake mic…"
                  : wakeState === "triggered"
                  ? "Waking…"
                  : "Wake off"}
              </span>
            )
          )}
          {state !== "disconnected" && (
            <span
              className={`text-[9px] font-mono tracking-wider uppercase ml-1 px-1.5 py-0.5 rounded border ${
                computerControlEnabled
                  ? "text-amber-300 border-amber-400/40 bg-amber-500/10 animate-pulse"
                  : "text-white/35 border-white/10 bg-white/5"
              }`}
              title={
                computerControlEnabled
                  ? "Full PC + cursor control ACTIVE. Say 'stop control' to lock."
                  : "PC control locked. Say 'control' to unlock mouse & desktop tools."
              }
            >
              {computerControlEnabled ? "CONTROL ON" : "Say CONTROL"}
            </span>
          )}
        </div>

        <div className="flex items-center gap-5">
          <button
            onClick={() => setShowMemoryDashboard(!showMemoryDashboard)}
            className="flex items-center gap-1 opacity-25 hover:opacity-100 text-white transition text-xs font-mono tracking-widest cursor-pointer"
            title="Recollections Database"
          >
            <Brain size={14} />
            <span className="hidden sm:inline">RECALLS</span>
          </button>

          {/* Real-time screen sharing toggler button inside Bikli glass style header */}
          <button
            onClick={isScreenSharing ? stopScreenSharing : startScreenSharing}
            className={`flex items-center gap-1.5 transition text-xs font-mono tracking-widest cursor-pointer ${
              isScreenSharing
                ? "text-cyan-400 opacity-100 font-semibold"
                : "opacity-25 hover:opacity-100 text-white"
            }`}
            title="Share Screen with Bikli"
          >
            <Monitor size={14} className={isScreenSharing && !isScreenSharingPaused ? "animate-pulse text-cyan-400" : ""} />
            <span>{isScreenSharing ? "SHARING" : "SHARE SCREEN"}</span>
          </button>

          {/* V2: Settings toggler button — matches existing faint-to-hover header style */}
          <button
            onClick={() => setShowSettings(!showSettings)}
            className={`flex items-center gap-1.5 transition text-xs font-mono tracking-widest cursor-pointer ${
              showSettings
                ? "text-cyan-400 opacity-100 font-semibold"
                : "opacity-25 hover:opacity-100 text-white"
            }`}
            title="Bikli Configuration"
          >
            <SettingsIcon size={14} className={showSettings ? "animate-spin [animation-duration:6s]" : ""} />
            <span>SETTINGS</span>
          </button>
        </div>
      </header>

      {/* CORE AVATAR AND VISUALS */}
      <main className="relative z-10 flex-1 w-full max-w-4xl mx-auto flex flex-col items-center justify-between py-6">

        {/* Tiny background-browser indicator (no full panel — engine stays hidden) */}
        <AnimatePresence>
          {browserEngineOn && !browserUiVisible && (
            <div className="absolute inset-x-0 top-0 z-30 flex justify-center p-2 pointer-events-none">
              <motion.div
                initial={{ opacity: 0, y: -12 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -12 }}
                className="pointer-events-auto flex items-center gap-2 px-3 py-1.5 rounded-full border border-white/10 bg-slate-950/50 backdrop-blur-md text-[10px] font-mono text-slate-400"
              >
                <Globe size={12} className="text-indigo-400" />
                <span className="tracking-widest uppercase">Browser running in background</span>
                <button
                  onClick={() => setBrowserUiVisible(true)}
                  className="ml-1 px-2 py-0.5 rounded-full bg-white/5 hover:bg-white/10 text-slate-300 cursor-pointer"
                  title="Show in-built browser"
                >
                  Show
                </button>
                <button
                  onClick={() => {
                    setBrowserEngineOn(false);
                    setBrowserUiVisible(false);
                    setBrowserTrigger(null);
                  }}
                  className="p-0.5 rounded hover:bg-white/10 text-slate-500 hover:text-white cursor-pointer"
                  title="Stop background browser"
                >
                  <X size={11} />
                </button>
              </motion.div>
            </div>
          )}
        </AnimatePresence>

        {/* Space Spacer to avoid head area — fully caption-free stage */}
        <div className="h-10 sm:h-20" />

        {/* Interactive suggestions prompt guide */}
        <AnimatePresence>
          {showGuide && (
            <motion.div
              initial={{ opacity: 0, x: -24, y: 0 }}
              animate={{ opacity: 1, x: 0, y: 0 }}
              exit={{ opacity: 0, x: -24, y: 0 }}
              className="absolute left-6 top-24 z-40 p-5 rounded-2xl border border-white/10 bg-slate-900/85 backdrop-blur-2xl max-w-md text-left shadow-2xl"
            >
              <div className="flex items-center justify-between mb-3 text-white">
                <div className="flex items-center gap-1.5 font-display text-sm font-bold tracking-wide">
                  <Compass size={16} className="text-indigo-400" />
                  <span>PLAYFUL CORE SUGGESTIONS</span>
                </div>
                <button 
                  onClick={() => setShowGuide(false)}
                  className="text-slate-400 hover:text-white transition"
                >
                  <X size={14} />
                </button>
              </div>
              <p className="text-xs text-slate-400 mb-4 font-mono leading-relaxed">
                Bikli is equipped with dynamic visual modules and standard text browser projectors. Here are clever triggers to try speaking aloud:
              </p>
              <div className="space-y-2 text-xs font-serif italic text-indigo-300">
                {suggestionCards.map((c) => (
                  <div
                    key={c.text}
                    className="relative overflow-hidden p-2.5 rounded-xl bg-white/5 border border-white/5 hover:bg-white/10 transition cursor-pointer font-sans normal-case text-slate-200"
                  >
                    {/* Small-card animated lighting border (warm gold) */}
                    <div
                      className="card-light-sweep"
                      style={{
                        "--glow-faint": cardGlow.faint,
                        "--glow-bright": cardGlow.bright,
                        "--glow-accent": cardGlow.accent,
                      } as any}
                    />
                    <span>⚡ &quot;{c.text}&quot;</span>
                    <span className="text-[10px] font-mono text-amber-400/80 block mt-0.5 font-medium">{c.desc}</span>
                  </div>
                ))}
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Global Error Banner */}
        <AnimatePresence>
          {errorText && (
            <motion.div
              initial={{ opacity: 0, x: 30, y: 0 }}
              animate={{ opacity: 1, x: 0, y: 0 }}
              exit={{ opacity: 0, x: 30, y: 0 }}
              className="absolute right-6 top-24 z-40 flex items-start gap-3 p-4 rounded-2xl border border-rose-500/20 bg-slate-950/80 backdrop-blur-xl shadow-2xl max-w-[420px] w-auto text-left"
            >
              <CircleAlert className="text-rose-400 shrink-0 mt-0.5" size={18} />
              <div>
                <h4 className="text-xs font-bold uppercase tracking-widest text-rose-300 font-mono">Core Error Protocol</h4>
                <p className="text-xs text-rose-200 mt-1 leading-relaxed break-words">{errorText}</p>
                <button
                  onClick={() => setErrorText(null)}
                  className="mt-2 text-[10px] font-bold text-rose-400 underline font-mono uppercase"
                >
                  Dismiss Code
                </button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

      </main>

      {/* FOOTER INTERFACE WITH WAVEFORM AND CONTROLS */}
      <footer className="relative z-10 w-full max-w-2xl mx-auto flex flex-col items-center gap-5 mt-auto">

        {/* Dynamic Minimalist Waveform Visualizer (self-contained, no App re-render) */}
        <LiveWaveform state={state} />

        {/* Glossy Beautiful Primary Connector Core Node */}
        <div className="flex items-center justify-center relative mb-4">
          {/* Animated status ring around the power button (blue neon pulse) */}
          {(state === "listening" || state === "speaking") && (
            <>
              <div className="bikli-status-wave w1" />
              <div className="bikli-status-wave w2" />
            </>
          )}
          <div className="bikli-status-ring" />
          <button
            onClick={handleToggleConnection}
            className={`relative w-20 h-20 rounded-full flex items-center justify-center transition-all duration-500 cursor-pointer ${
              state === "disconnected"
                ? "bg-white/10 hover:bg-white/15 border border-white/15 text-white shadow-[0_0_20px_rgba(255,255,255,0.02)] hover:scale-105 active:scale-95"
                : state === "listening"
                ? "bg-cyan-500/15 hover:bg-cyan-500/25 border border-cyan-400/80 text-cyan-200 shadow-[0_0_35px_rgba(34,211,238,0.3)] animate-pulse scale-105"
                : state === "speaking"
                ? "bg-purple-500/90 hover:bg-purple-600 border border-purple-400/95 text-white shadow-[0_0_35px_rgba(168,85,247,0.4)] scale-105"
                : "bg-amber-600 border border-amber-300 text-white animate-spin"
            }`}
            title={state === "disconnected" ? "Awake Bikli" : "Sleep core"}
          >
            {/* inner glowing ripple */}
            <span className="bikli-power-pulse" />
            {state === "disconnected" ? (
              <Power className="opacity-80" size={24} />
            ) : state === "connecting" ? (
              <div className="w-6 h-6 border-2 border-white border-t-transparent rounded-full animate-spin" />
            ) : state === "listening" ? (
              <Mic size={24} className="text-cyan-200" />
            ) : (
              <Volume2 size={24} className="text-white" />
            )}
          </button>

          {/* Quiet Reset Projection Anchor */}
          {(browserEngineOn || errorText) && (
            <button 
              onClick={() => {
                setBrowserEngineOn(false);
                setBrowserUiVisible(false);
                setBrowserTrigger(null);
                setErrorText(null);
              }}
              className="absolute right-[-60px] p-2 rounded-full hover:bg-white/5 text-slate-400 hover:text-white transition duration-150 cursor-pointer"
              title="Stop browser / clear errors"
            >
              <X size={16} />
            </button>
          )}
        </div>

      </footer>

      {/* In-built browser engine — always background unless user clicks Show */}
      {browserEngineOn && (
        <BrowserAgent
          url={browserSeedUrl}
          visible={browserUiVisible}
          onClose={() => {
            // Hide UI only — keep engine running for continued voice automation
            setBrowserUiVisible(false);
          }}
          actionTrigger={browserTrigger}
        />
      )}

      {/* Dynamic Floating Glassmorphic Screen Sharing Control Hub */}
      <AnimatePresence>
        {isScreenSharing && (
          <motion.div
            initial={{ opacity: 0, scale: 0.85, x: 50 }}
            animate={{ opacity: 1, scale: 1, x: 0 }}
            exit={{ opacity: 0, scale: 0.85, x: 50 }}
            className={`absolute bottom-6 md:bottom-10 right-6 md:right-10 z-50 w-72 p-4 rounded-2xl border ${
              isScreenSharingPaused 
                ? "border-amber-500/20 bg-slate-950/70" 
                : "border-cyan-500/20 bg-slate-950/70"
            } backdrop-blur-2xl shadow-2xl overflow-hidden`}
          >
            {/* Header / Indicator */}
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <div
                  className={`w-2 h-2 rounded-full ${
                    isScreenSharingPaused
                      ? "bg-amber-400"
                      : screenVisionMode
                        ? "bg-cyan-400 animate-pulse"
                        : "bg-slate-500"
                  }`}
                />
                <span className="text-[10px] font-bold font-mono tracking-widest text-slate-200">
                  {isScreenSharingPaused
                    ? "SCREEN VISION PAUSED"
                    : screenVisionMode
                      ? "SCREEN VISION ACTIVE"
                      : "PREVIEW ONLY (VISION OFF)"}
                </span>
              </div>
              <button 
                onClick={stopScreenSharing}
                className="text-slate-400 hover:text-white transition-colors duration-150 p-1 rounded-lg hover:bg-white/5 cursor-pointer"
                title="Stop Sharing"
              >
                <X size={14} />
              </button>
            </div>

            {/* Live screen PIP preview — always shows what is being shared */}
            <div className="relative aspect-video w-full rounded-xl overflow-hidden bg-slate-900 border border-white/5 mb-3 flex items-center justify-center group select-none">
              <video
                ref={(el) => {
                  screenPreviewVideoRef.current = el;
                  if (el && screenPreviewStream && el.srcObject !== screenPreviewStream) {
                    el.srcObject = screenPreviewStream;
                    el.muted = true;
                    el.playsInline = true;
                    void el.play().catch((err) =>
                      console.warn("[Screen Preview] attach play issue:", err),
                    );
                  }
                }}
                className={`w-full h-full object-contain bg-black transition-opacity duration-300 ${
                  isScreenSharingPaused ? "opacity-30 blur-sm" : "opacity-100"
                }`}
                autoPlay
                playsInline
                muted
              />

              {!screenPreviewStream && (
                <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                  <span className="text-[10px] uppercase tracking-widest font-mono text-slate-500">
                    Starting preview…
                  </span>
                </div>
              )}

              {isScreenSharingPaused && (
                <div className="absolute inset-0 flex items-center justify-center">
                  <span className="text-[10px] uppercase tracking-widest font-mono text-amber-400 font-bold px-2 py-1 bg-amber-950/40 border border-amber-500/20 rounded-md">
                    Transmission Paused
                  </span>
                </div>
              )}
              
              {!isScreenSharingPaused && screenVisionMode && (
                <div className="absolute top-2 left-2 flex items-center gap-1.5 px-2 py-0.5 rounded bg-cyan-950/50 border border-cyan-400/20 text-[9px] font-mono text-cyan-300">
                  <span className="w-1.5 h-1.5 bg-cyan-400 rounded-full animate-ping" />
                  <span>LIVE PREVIEW</span>
                </div>
              )}
            </div>

            {/* Quick Action Control Strip */}
            <div className="flex items-center justify-between gap-1.5 mb-2.5">
              {isScreenSharingPaused ? (
                <button
                  onClick={resumeScreenSharing}
                  className="flex-1 py-1.5 px-2 bg-cyan-500/10 hover:bg-cyan-500/20 border border-cyan-500/20 rounded-lg text-xs font-mono font-medium text-cyan-300 flex items-center justify-center gap-1.5 transition-all cursor-pointer"
                  title="Resume Streaming Feed"
                >
                  <Play size={10} />
                  <span>Resume</span>
                </button>
              ) : (
                <button
                  onClick={pauseScreenSharing}
                  className="flex-1 py-1.5 px-2 bg-amber-500/10 hover:bg-amber-500/20 border border-amber-500/20 rounded-lg text-xs font-mono font-medium text-amber-300 flex items-center justify-center gap-1.5 transition-all cursor-pointer"
                  title="Pause Streaming Feed"
                >
                  <Pause size={10} />
                  <span>Pause</span>
                </button>
              )}

              <button
                onClick={switchScreenShare}
                className="py-1.5 px-2 bg-white/5 hover:bg-white/10 border border-white/10 rounded-lg text-xs font-mono text-slate-300 hover:text-white flex items-center justify-center gap-1 transition-all cursor-pointer"
                title="Choose Another Screen or Window"
              >
                <RefreshCw size={11} />
                <span>Switch</span>
              </button>

              <button
                onClick={stopScreenSharing}
                className="py-1.5 px-2 bg-rose-500/10 hover:bg-rose-500/20 border border-rose-500/20 rounded-lg text-xs font-mono text-rose-400 flex items-center justify-center gap-1 transition-all cursor-pointer hover:scale-[1.02] active:scale-[0.98]"
                title="Terminate Stream"
              >
                <Square size={9} />
                <span>Stop</span>
              </button>
            </div>

            {/* Core Mode Configuration Toggle */}
            <div className="pt-2 border-t border-white/5 flex items-center justify-between text-left">
              <div className="flex flex-col">
                <span className="text-[10px] font-bold font-mono text-slate-200">SCREEN VISION MODE</span>
                <span className="text-[8px] text-slate-400 uppercase font-mono max-w-[160px]">
                  {screenVisionMode
                    ? "Sending frames to Bikli"
                    : "Off — preview only, turn ON to analyze"}
                </span>
              </div>
              <button
                onClick={() => setScreenVisionModeLive(!screenVisionMode)}
                className={`w-10 h-5 rounded-full p-0.5 transition-colors duration-200 focus:outline-none cursor-pointer ${
                  screenVisionMode ? "bg-cyan-500" : "bg-white/10"
                }`}
                title={
                  screenVisionMode
                    ? "Screen vision ON — Bikli receives live frames"
                    : "Screen vision OFF — preview only, no analysis"
                }
              >
                <div
                  className={`bg-white w-4 h-4 rounded-full shadow-md transform duration-200 ease-in-out ${
                    screenVisionMode ? "translate-x-5" : "translate-x-0"
                  }`}
                />
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Recollections sliding core panel */}
      <MemoryDashboard
        isOpen={showMemoryDashboard}
        onClose={() => setShowMemoryDashboard(false)}
        memories={memories}
        onAddMemory={handleAddManualMemory}
        onDeleteMemory={handleDeleteMemory}
        onUpdateMemory={handleUpdateMemory}
        themeColor={themeColor}
      />

      {/* V2: Settings sliding core panel */}
      <SettingsPanel
        isOpen={showSettings}
        onClose={() => setShowSettings(false)}
        settings={settings}
        onChange={handleSettingsChange}
        themeColor={themeColor}
      />
    </div>
  );
}
