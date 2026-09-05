import React, { useEffect, useRef, useState, useCallback } from "react";
import { createPortal } from "react-dom";
import { BikliAudioSession, LiveState } from "../lib/audio";
import {
  BikliCharacterEngine,
  bikliConfig,
  BIKLI_BEHAVIOURS,
  BIKLI_EMOTIONS,
  CharacterActivity,
  CharacterEmotion,
} from "../lib/character/characterEngine";
import {
  Sparkles,
  RotateCcw,
  Eye,
  Lock,
  Unlock,
  AlertTriangle,
  ChevronUp,
  ChevronDown,
  MessageCircle,
} from "lucide-react";

export type BikliEmotion =
  | "idle"
  | "happy"
  | "excited"
  | "curious"
  | "thinking"
  | "proud"
  | "sad"
  | "confused"
  | "surprised"
  | "embarrassed"
  | "playful";

interface BikliCoreVisualizerProps {
  session: BikliAudioSession | null;
  state: LiveState;
  themeColor: string;
  activeEmotion?: BikliEmotion;
  characterState: "idle" | "thinking" | "talking";
  /** Whether the typing box is currently showing. */
  isChatOpen?: boolean;
  /** Show/hide the typing box. Omit to leave the Chat button out entirely. */
  onToggleChat?: () => void;
}

export const BikliCoreVisualizer: React.FC<BikliCoreVisualizerProps> = ({
  session,
  state,
  themeColor,
  activeEmotion = "idle",
  characterState,
  isChatOpen = false,
  onToggleChat,
}) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const engineRef = useRef<BikliCharacterEngine | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  // Loading & diagnostic state
  const [loadState, setLoadState] = useState<{
    phase: string;
    ratio: number;
    error: string | null;
  }>({ phase: "Initializing BIKLI 3D", ratio: 0, error: null });
  const [isLoaded, setIsLoaded] = useState(false);

  const [isViewLocked, setIsViewLocked] = useState(false);
  const [isEyeTracking, setIsEyeTracking] = useState(true);
  const [activePoseName, setActivePoseName] = useState<string | null>(null);
  const [showControlsDrawer, setShowControlsDrawer] = useState(false);

  // Derive high-level character activity
  const resolvedActivity: CharacterActivity =
    state === "listening"
      ? "listening"
      : characterState === "talking" || state === "speaking"
      ? "talking"
      : characterState === "thinking" || state === "connecting"
      ? "thinking"
      : "idle";

  // Derive emotion
  const resolvedEmotion: CharacterEmotion = activeEmotion || "idle";

  // Initialize Character Engine
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let disposed = false;
    const canvas = document.createElement("canvas");
    canvas.className =
      "absolute inset-0 w-full h-full cursor-grab active:cursor-grabbing select-none";
    canvas.style.opacity = "0";
    canvas.style.transition = "opacity 0.8s ease-in-out";
    container.appendChild(canvas);
    canvasRef.current = canvas;

    const engine = new BikliCharacterEngine({
      canvas,
      config: bikliConfig,
      onProgress: (phase: string, ratio: number) => {
        if (!disposed) {
          setLoadState({ phase, ratio, error: null });
        }
      },
      onError: (err: Error) => {
        console.error("[BIKLI 3D Engine Error]", err);
        if (!disposed) {
          setLoadState((prev) => ({ ...prev, error: err.message }));
        }
      },
    });

    engineRef.current = engine;
    engine.resize(container.clientWidth, container.clientHeight);

    engine
      .load()
      .then(() => {
        if (!disposed) {
          setIsLoaded(true);
          setLoadState({ phase: "Ready", ratio: 1, error: null });
          engine.start();
          engine.setEyeTracking(true);
          canvas.style.opacity = "1";
        }
      })
      .catch((err) => {
        console.error("[BIKLI 3D Load Error]", err);
      });

    return () => {
      disposed = true;
      engineRef.current = null;
      engine.dispose();
      canvas.remove();
      if (canvasRef.current === canvas) {
        canvasRef.current = null;
      }
    };
  }, []);

  // Resize observer
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const { width, height } = entry.contentRect;
      engineRef.current?.resize(width, height);
    });

    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  // Window cursor tracking (head and eye gaze follow cursor)
  const handlePointerMove = useCallback((e: MouseEvent | PointerEvent) => {
    const ndcX = (e.clientX / window.innerWidth) * 2 - 1;
    const ndcY = -((e.clientY / window.innerHeight) * 2 - 1);
    engineRef.current?.setPointer(ndcX, ndcY);
  }, []);

  useEffect(() => {
    window.addEventListener("pointermove", handlePointerMove, { passive: true });
    window.addEventListener("mousemove", handlePointerMove, { passive: true });
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("mousemove", handlePointerMove);
    };
  }, [handlePointerMove]);

  // Window drag to orbit & scroll to zoom
  useEffect(() => {
    let isDragging = false;
    let prevX = 0;
    let prevY = 0;

    const isInteractive = (target: EventTarget | null) => {
      const el = target as HTMLElement | null;
      if (!el) return false;
      return !!el.closest("button, a, input, textarea, select, [role='button'], .bikli-interactive, #bikli-3d-portal");
    };

    const onMouseDown = (e: MouseEvent) => {
      if (e.button !== 0) return; // left click only
      if (isInteractive(e.target)) return;

      isDragging = true;
      prevX = e.clientX;
      prevY = e.clientY;
    };

    const onMouseMove = (e: MouseEvent) => {
      if (!isDragging) return;
      const dx = e.clientX - prevX;
      const dy = e.clientY - prevY;
      prevX = e.clientX;
      prevY = e.clientY;

      const speed = 0.005;
      engineRef.current?.orbitBy(dx * speed, -dy * speed);
    };

    const onMouseUp = () => {
      isDragging = false;
    };

    const onWheel = (e: WheelEvent) => {
      if (isInteractive(e.target)) return;
      const delta = e.deltaY * 0.02;
      engineRef.current?.zoomBy(delta);
    };

    window.addEventListener("mousedown", onMouseDown);
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    window.addEventListener("wheel", onWheel, { passive: true });

    return () => {
      window.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
      window.removeEventListener("wheel", onWheel);
    };
  }, []);

  // Keyboard navigation (WASD, QE, L, F, R, 1-4)
  useEffect(() => {
    const keysDown = new Set<string>();
    let animId = 0;
    let lastTime = performance.now();
    const orbitSpeed = 1.9;
    const zoomSpeed = 14;

    const loop = () => {
      animId = requestAnimationFrame(loop);
      const now = performance.now();
      const dt = Math.min((now - lastTime) / 1000, 0.1);
      lastTime = now;

      const engine = engineRef.current;
      if (!engine) return;

      let yaw = 0;
      let pitch = 0;
      if (keysDown.has("a")) yaw -= orbitSpeed * dt;
      if (keysDown.has("d")) yaw += orbitSpeed * dt;
      if (keysDown.has("w")) pitch += orbitSpeed * 0.6 * dt;
      if (keysDown.has("s")) pitch -= orbitSpeed * 0.6 * dt;
      if (yaw || pitch) engine.orbitBy(yaw, pitch);

      let zoom = 0;
      if (keysDown.has("q")) zoom += zoomSpeed * dt;
      if (keysDown.has("e")) zoom -= zoomSpeed * dt;
      if (zoom) engine.zoomBy(zoom);
    };

    animId = requestAnimationFrame(loop);

    const isInputActive = (target: EventTarget | null) => {
      const el = target as HTMLElement | null;
      if (!el) return false;
      const tag = el.tagName;
      return (
        tag === "INPUT" ||
        tag === "TEXTAREA" ||
        tag === "SELECT" ||
        el.isContentEditable
      );
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (isInputActive(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
      const key = e.key.toLowerCase();
      const engine = engineRef.current;
      if (!engine) return;

      if ("wasdqe".includes(key)) {
        keysDown.add(key);
        return;
      }

      switch (key) {
        case "l": {
          const next = !engine.isViewLocked;
          engine.setViewLocked(next);
          setIsViewLocked(next);
          break;
        }
        case "f": {
          const next = !engine.isEyeTracking;
          engine.setEyeTracking(next);
          setIsEyeTracking(next);
          break;
        }
        case "r":
          engine.resetView();
          break;
        case "1":
          engine.setView("front");
          break;
        case "2":
          engine.setView("threeQuarter");
          break;
        case "3":
          engine.setView("right");
          break;
        case "4":
          engine.setView("back");
          break;
        default:
          return;
      }
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      keysDown.delete(e.key.toLowerCase());
    };

    const handleBlur = () => {
      keysDown.clear();
    };

    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);
    window.addEventListener("blur", handleBlur);

    return () => {
      cancelAnimationFrame(animId);
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
      window.removeEventListener("blur", handleBlur);
    };
  }, []);

  // Update AI speech & activity animation loop (lip-sync with outputAnalyser)
  useEffect(() => {
    engineRef.current?.setFrameInput({
      activity: resolvedActivity,
      emotion: resolvedEmotion,
      outputAnalyser: session?.outputAnalyser ?? null,
      inputAnalyser: session?.inputAnalyser ?? null,
    });
  }, [resolvedActivity, resolvedEmotion, session?.outputAnalyser, session?.inputAnalyser]);

  // Pause rendering when window is minimized/hidden
  useEffect(() => {
    const handleVisibility = () => {
      const engine = engineRef.current;
      if (!engine?.isLoaded) return;
      if (document.hidden) {
        engine.stop();
      } else {
        engine.start();
      }
    };

    document.addEventListener("visibilitychange", handleVisibility);
    return () => document.removeEventListener("visibilitychange", handleVisibility);
  }, []);

  // Action handlers
  const handleTriggerBehaviour = (name: string) => {
    if (!engineRef.current) return;
    engineRef.current.triggerBehaviour(name);
    setActivePoseName(name);
    setTimeout(() => setActivePoseName(null), 3000);
  };

  const handleSetEmotion = (emo: string) => {
    engineRef.current?.setExpression(emo);
  };

  const handleSetView = (preset: "front" | "threeQuarter" | "right" | "back") => {
    engineRef.current?.setView(preset);
  };

  const handleResetView = () => {
    engineRef.current?.resetView();
  };

  const isReady = (isLoaded || loadState.ratio >= 1) && !loadState.error;

  // Render Portal Controls directly to document.body so no parent stacking context can ever block them
  const portalContent = typeof document !== "undefined" ? (
    <div
      id="bikli-3d-portal"
      className="fixed bottom-6 right-6 z-[9999] pointer-events-auto select-none flex flex-col items-end gap-2 font-sans"
    >
      {/* Active Pose Indicator Pill */}
      {activePoseName && (
        <div className="px-3.5 py-1.5 rounded-full bg-cyan-500/25 border border-cyan-400/60 text-cyan-200 text-xs font-mono tracking-widest uppercase shadow-xl animate-pulse backdrop-blur-md">
          Pose: {activePoseName}
        </div>
      )}

      {/* Expanded Poses Drawer */}
      {showControlsDrawer && (
        <div className="w-80 p-4 rounded-2xl border border-white/15 bg-slate-950/95 backdrop-blur-2xl shadow-2xl flex flex-col gap-3 transition-all text-white">
          <div className="flex items-center justify-between border-b border-white/10 pb-2">
            <span className="text-xs font-mono font-bold uppercase tracking-wider text-cyan-300 flex items-center gap-1.5">
              <Sparkles size={14} className="text-cyan-400" /> BIKLI 3D Controls
            </span>
            <button
              type="button"
              onClick={handleResetView}
              title="Reset Camera (R)"
              className="px-2 py-1 rounded-lg border border-white/10 bg-white/5 text-[10px] font-mono text-slate-300 hover:text-white hover:bg-white/10 transition cursor-pointer"
            >
              <RotateCcw size={11} className="inline mr-1" /> Reset View
            </button>
          </div>

          {/* Procedural Gestures */}
          <div>
            <div className="text-[10px] font-mono uppercase tracking-widest text-slate-400 mb-1.5 font-semibold">
              Procedural Gestures
            </div>
            <div className="grid grid-cols-3 gap-1.5">
              {[
                { id: "wave", label: "Wave 👋" },
                { id: "nod", label: "Nod 🙇" },
                { id: "smile", label: "Smile 😊" },
                { id: "happy", label: "Happy ✨" },
                { id: "think", label: "Think 🤔" },
                { id: "headTilt", label: "Curious 🧐" },
                { id: "stretch", label: "Stretch 🙆" },
                { id: "shiftWeight", label: "Shift ⚖️" },
                { id: "relaxedPose", label: "Relax 😌" },
              ].map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => handleTriggerBehaviour(item.id)}
                  className="px-2 py-1.5 rounded-lg border border-white/10 bg-white/5 hover:border-cyan-400/60 hover:bg-cyan-500/20 active:scale-95 text-[10px] font-mono text-slate-200 transition text-center truncate cursor-pointer"
                >
                  {item.label}
                </button>
              ))}
            </div>
          </div>

          {/* Facial Expressions */}
          <div>
            <div className="text-[10px] font-mono uppercase tracking-widest text-slate-400 mb-1.5 font-semibold">
              Facial Expressions
            </div>
            <div className="grid grid-cols-4 gap-1">
              {BIKLI_EMOTIONS.slice(0, 8).map((emo) => (
                <button
                  key={emo}
                  type="button"
                  onClick={() => handleSetEmotion(emo)}
                  className="px-1.5 py-1 rounded-md border border-white/5 bg-white/5 hover:border-fuchsia-400/50 hover:bg-fuchsia-500/15 active:scale-95 text-[9px] font-mono text-slate-300 capitalize truncate cursor-pointer"
                >
                  {emo}
                </button>
              ))}
            </div>
          </div>

          {/* Camera Angles */}
          <div>
            <div className="text-[10px] font-mono uppercase tracking-widest text-slate-400 mb-1.5 font-semibold">
              Camera Presets
            </div>
            <div className="flex gap-1.5">
              {[
                ["Front (1)", "front"],
                ["3/4 (2)", "threeQuarter"],
                ["Side (3)", "right"],
                ["Back (4)", "back"],
              ].map(([label, preset]) => (
                <button
                  key={preset}
                  type="button"
                  onClick={() => handleSetView(preset as any)}
                  className="flex-1 py-1 rounded-lg border border-white/10 bg-slate-900 text-[9px] font-mono uppercase text-slate-300 hover:text-cyan-200 hover:border-cyan-400/40 transition cursor-pointer"
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          {/* Tips footer */}
          <div className="flex items-center justify-between pt-2 border-t border-white/10 text-[9px] font-mono text-slate-400">
            <span>Drag background to Orbit</span>
            <span>•</span>
            <span>Scroll to Zoom</span>
          </div>
        </div>
      )}

      {/* Main Floating Trigger Pill */}
      <div className="flex items-center gap-1.5 bg-slate-950/90 backdrop-blur-xl p-1.5 rounded-xl border border-white/15 shadow-2xl">
        {onToggleChat && (
          <button
            type="button"
            onClick={onToggleChat}
            title={isChatOpen ? "Hide typing box" : "Type to Bikli"}
            className={`px-2.5 py-1.5 rounded-lg border text-[10px] font-mono tracking-wider uppercase transition flex items-center gap-1.5 cursor-pointer ${
              isChatOpen
                ? "border-cyan-400/80 bg-cyan-500/20 text-cyan-200 shadow-md shadow-cyan-950/40"
                : "border-white/10 bg-white/5 text-slate-300 hover:text-white hover:bg-white/10"
            }`}
          >
            <MessageCircle size={12} />
            Chat
          </button>
        )}

        <button
          type="button"
          onClick={() => {
            const eng = engineRef.current;
            if (!eng) return;
            const next = !eng.isViewLocked;
            eng.setViewLocked(next);
            setIsViewLocked(next);
          }}
          title={isViewLocked ? "Unlock camera (L)" : "Lock camera (L)"}
          className={`px-2.5 py-1.5 rounded-lg border text-[10px] font-mono tracking-wider uppercase transition flex items-center gap-1.5 cursor-pointer ${
            isViewLocked
              ? "border-amber-400/80 bg-amber-500/20 text-amber-200 shadow-md shadow-amber-950/40"
              : "border-white/10 bg-white/5 text-slate-300 hover:text-white hover:bg-white/10"
          }`}
        >
          {isViewLocked ? <Lock size={12} /> : <Unlock size={12} />}
          {isViewLocked ? "Locked" : "Free"}
        </button>

        <button
          type="button"
          onClick={() => {
            const eng = engineRef.current;
            if (!eng) return;
            const next = !eng.isEyeTracking;
            eng.setEyeTracking(next);
            setIsEyeTracking(next);
          }}
          title={isEyeTracking ? "Gaze tracking cursor (F)" : "Gaze wandering randomly (F)"}
          className={`px-2.5 py-1.5 rounded-lg border text-[10px] font-mono tracking-wider uppercase transition flex items-center gap-1.5 cursor-pointer ${
            isEyeTracking
              ? "border-cyan-400/80 bg-cyan-500/20 text-cyan-200 shadow-md shadow-cyan-950/40"
              : "border-white/10 bg-white/5 text-slate-300 hover:text-white hover:bg-white/10"
          }`}
        >
          <Eye size={12} />
          {isEyeTracking ? "Gaze: On" : "Gaze: Auto"}
        </button>

        <button
          type="button"
          onClick={() => setShowControlsDrawer((prev) => !prev)}
          className="px-3 py-1.5 rounded-lg border border-cyan-400/50 bg-cyan-500/20 text-cyan-200 text-[10px] font-mono tracking-widest uppercase hover:bg-cyan-500/30 active:scale-95 transition flex items-center gap-1.5 cursor-pointer shadow-lg shadow-cyan-950/50 font-semibold"
        >
          <Sparkles size={12} />
          Poses
          {showControlsDrawer ? <ChevronDown size={12} /> : <ChevronUp size={12} />}
        </button>
      </div>
    </div>
  ) : null;

  return (
    <div
      ref={containerRef}
      className="relative w-full h-full overflow-hidden select-none pointer-events-auto"
    >
      {/* Loading HUD */}
      {!isReady && !loadState.error && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 pointer-events-none z-30">
          <Sparkles className="text-cyan-400 animate-spin" size={32} />
          <div className="font-mono text-[11px] uppercase tracking-[0.3em] text-cyan-200/80">
            {loadState.phase}
          </div>
          <div className="h-1 w-48 bg-white/10 overflow-hidden rounded-full border border-white/5">
            <div
              className="h-full bg-gradient-to-r from-cyan-400 to-fuchsia-400 transition-[width] duration-300"
              style={{ width: `${Math.round(loadState.ratio * 100)}%` }}
            />
          </div>
        </div>
      )}

      {/* Error HUD */}
      {loadState.error && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 p-6 text-center z-30 pointer-events-auto">
          <AlertTriangle className="text-amber-400" size={32} />
          <div className="font-mono text-xs uppercase tracking-widest text-amber-200">
            Failed to load BIKLI 3D avatar
          </div>
          <p className="max-w-md text-xs text-slate-400 leading-relaxed">
            {loadState.error}
          </p>
        </div>
      )}

      {/* Mount Portal Controls to document.body once ready */}
      {isReady && typeof document !== "undefined" && createPortal(portalContent, document.body)}
    </div>
  );
};
