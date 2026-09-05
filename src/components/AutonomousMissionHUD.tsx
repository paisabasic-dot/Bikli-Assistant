import React, { useState, useEffect } from "react";
import {
  X,
  Play,
  Pause,
  Square,
  AlertTriangle,
  CheckCircle2,
  Maximize2,
  Minimize2,
  Copy,
  Check,
  Eye,
  Bot,
  Activity,
  Layers,
  Clock,
  Sparkles,
  ArrowRight,
  ShieldAlert,
} from "lucide-react";
import { motion, AnimatePresence } from "motion/react";

export interface MissionEvent {
  type: string;
  mission_id?: string;
  status?: string;
  step?: number;
  max_steps?: number;
  goal?: string;
  mode?: string;
  thought?: string;
  action?: string;
  plan?: any;
  screenshot?: string;
  page_url?: string;
  element_count?: number;
  reason?: string;
  result?: string;
  error?: string;
  timestamp?: number;
}

interface AutonomousMissionHUDProps {
  isOpen: boolean;
  onClose: () => void;
  latestEvent: MissionEvent | null;
}

export const AutonomousMissionHUD: React.FC<AutonomousMissionHUDProps> = ({
  isOpen,
  onClose,
  latestEvent,
}) => {
  const [missionId, setMissionId] = useState<string>("");
  const [status, setStatus] = useState<string>("IDLE");
  const [goal, setGoal] = useState<string>("");
  const [step, setStep] = useState<number>(0);
  const [maxSteps, setMaxSteps] = useState<number>(20);
  const [thought, setThought] = useState<string>("Standing by for mission...");
  const [action, setAction] = useState<string>("");
  const [screenshot, setScreenshot] = useState<string>("");
  const [pageUrl, setPageUrl] = useState<string>("");
  const [elementCount, setElementCount] = useState<number>(0);
  const [history, setHistory] = useState<any[]>([]);
  const [finalResult, setFinalResult] = useState<string>("");
  const [confirmationData, setConfirmationData] = useState<any | null>(null);
  const [latestPlan, setLatestPlan] = useState<any | null>(null);

  const [isMaximized, setIsMaximized] = useState<boolean>(false);
  const [copied, setCopied] = useState<boolean>(false);
  const [isProcessingAction, setIsProcessingAction] = useState<boolean>(false);

  // Poll status on initial open
  useEffect(() => {
    if (isOpen) {
      fetch("/api/mission/status")
        .then((r) => r.json())
        .then((data) => {
          if (data?.mission) {
            const m = data.mission;
            if (m.mission_id) setMissionId(m.mission_id);
            if (m.status) setStatus(m.status);
            if (m.goal) setGoal(m.goal);
            if (m.step !== undefined) setStep(m.step);
            if (m.max_steps) setMaxSteps(m.max_steps);
            if (m.latest_thought) setThought(m.latest_thought);
            if (m.latest_action) setAction(m.latest_action);
            if (m.latest_plan) setLatestPlan(m.latest_plan);
            if (m.final_result) setFinalResult(m.final_result);
            if (m.pending_confirmation) setConfirmationData(m.pending_confirmation);
          }
        })
        .catch(() => {});
    }
  }, [isOpen]);

  // Update on live WebSocket stream events
  useEffect(() => {
    if (!latestEvent) return;

    if (latestEvent.mission_id) setMissionId(latestEvent.mission_id);
    if (latestEvent.status) setStatus(latestEvent.status);

    if (latestEvent.type === "mission_started") {
      setStatus("RUNNING");
      if (latestEvent.goal) setGoal(latestEvent.goal);
      if (latestEvent.max_steps) setMaxSteps(latestEvent.max_steps);
      setStep(1);
      setThought("Initializing PC-Agent-E environment...");
      setAction("start");
      setLatestPlan(null);
      setHistory([]);
      setFinalResult("");
      setConfirmationData(null);
    } else if (latestEvent.type === "screen_update") {
      if (latestEvent.screenshot) setScreenshot(latestEvent.screenshot);
      if (latestEvent.page_url) setPageUrl(latestEvent.page_url);
      if (latestEvent.element_count !== undefined) setElementCount(latestEvent.element_count);
      if (latestEvent.step) setStep(latestEvent.step);
    } else if (latestEvent.type === "step_update") {
      if (latestEvent.step) setStep(latestEvent.step);
      if (latestEvent.thought) setThought(latestEvent.thought);
      if (latestEvent.action) setAction(latestEvent.action);
      if (latestEvent.plan) setLatestPlan(latestEvent.plan);
      setHistory((prev) => [
        ...prev,
        {
          step: latestEvent.step,
          thought: latestEvent.thought,
          action: latestEvent.action,
          plan: latestEvent.plan,
        },
      ]);
    } else if (latestEvent.type === "confirmation_needed") {
      setStatus("WAITING_CONFIRMATION");
      setConfirmationData(latestEvent);
    } else if (latestEvent.type === "mission_completed") {
      setStatus("COMPLETED");
      setFinalResult(latestEvent.result || "Mission successfully completed.");
      setConfirmationData(null);
    } else if (latestEvent.type === "mission_stopped") {
      setStatus("STOPPED");
      setThought(latestEvent.reason || "Mission halted by user.");
    } else if (latestEvent.type === "mission_failed") {
      setStatus("FAILED");
      setThought(latestEvent.error || "Mission encountered an unexpected error.");
    } else if (latestEvent.type === "mission_paused") {
      setStatus("PAUSED");
    } else if (latestEvent.type === "mission_resumed") {
      setStatus("RUNNING");
      setConfirmationData(null);
    }
  }, [latestEvent]);

  // Controls
  const handleStop = async () => {
    setIsProcessingAction(true);
    try {
      await fetch("/api/mission/stop", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: "Emergency stop triggered from HUD" }),
      });
      setStatus("STOPPED");
    } finally {
      setIsProcessingAction(false);
    }
  };

  const handleTogglePause = async () => {
    setIsProcessingAction(true);
    try {
      if (status === "PAUSED") {
        await fetch("/api/mission/resume", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ approved: true }),
        });
        setStatus("RUNNING");
      } else {
        await fetch("/api/mission/pause", { method: "POST" });
        setStatus("PAUSED");
      }
    } finally {
      setIsProcessingAction(false);
    }
  };

  const handleConfirmAction = async (approved: boolean) => {
    setIsProcessingAction(true);
    try {
      await fetch("/api/mission/resume", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ approved }),
      });
      setConfirmationData(null);
      setStatus("RUNNING");
    } finally {
      setIsProcessingAction(false);
    }
  };

  const handleCopyResult = () => {
    if (!finalResult) return;
    navigator.clipboard.writeText(finalResult);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  if (!isOpen) return null;

  return (
    <AnimatePresence>
      <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-6 bg-black/75 backdrop-blur-md">
        <motion.div
          initial={{ opacity: 0, scale: 0.95, y: 15 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.95, y: 15 }}
          transition={{ duration: 0.25 }}
          className={`flex flex-col bg-zinc-950/95 border border-cyan-500/30 rounded-2xl shadow-2xl shadow-cyan-950/40 overflow-hidden transition-all duration-300 ${
            isMaximized
              ? "w-full h-full"
              : "w-full max-w-5xl h-[88vh] max-h-[820px]"
          }`}
        >
          {/* Top Bar / HUD Header */}
          <div className="flex items-center justify-between px-5 py-3.5 border-b border-zinc-800 bg-zinc-900/60">
            <div className="flex items-center gap-3">
              <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-cyan-500/20 text-cyan-400 border border-cyan-500/30">
                <Bot className="w-5 h-5" />
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <span className="text-xs font-mono tracking-widest text-cyan-400 uppercase font-semibold">
                    BIKLI AUTONOMOUS AGENT
                  </span>
                  {/* Status Badge */}
                  {status === "RUNNING" && (
                    <span className="flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[10px] font-semibold tracking-wide uppercase bg-emerald-500/20 text-emerald-300 border border-emerald-500/30">
                      <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-ping" />
                      ACTIVE
                    </span>
                  )}
                  {status === "WAITING_CONFIRMATION" && (
                    <span className="flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[10px] font-semibold tracking-wide uppercase bg-amber-500/20 text-amber-300 border border-amber-500/40 animate-pulse">
                      <ShieldAlert className="w-3 h-3" />
                      APPROVAL REQUIRED
                    </span>
                  )}
                  {status === "PAUSED" && (
                    <span className="px-2.5 py-0.5 rounded-full text-[10px] font-semibold tracking-wide uppercase bg-yellow-500/20 text-yellow-300 border border-yellow-500/30">
                      PAUSED
                    </span>
                  )}
                  {status === "COMPLETED" && (
                    <span className="px-2.5 py-0.5 rounded-full text-[10px] font-semibold tracking-wide uppercase bg-cyan-500/20 text-cyan-300 border border-cyan-500/30">
                      COMPLETED
                    </span>
                  )}
                  {status === "STOPPED" && (
                    <span className="px-2.5 py-0.5 rounded-full text-[10px] font-semibold tracking-wide uppercase bg-rose-500/20 text-rose-300 border border-rose-500/30">
                      STOPPED
                    </span>
                  )}
                  {status === "FAILED" && (
                    <span className="px-2.5 py-0.5 rounded-full text-[10px] font-semibold tracking-wide uppercase bg-red-500/20 text-red-300 border border-red-500/30">
                      FAILED
                    </span>
                  )}
                </div>
                <div className="text-[11px] text-zinc-400 truncate max-w-sm">
                  {missionId || "No active mission ID"}
                </div>
              </div>
            </div>

            {/* Quick Actions & Window Controls */}
            <div className="flex items-center gap-2">
              {status === "RUNNING" && (
                <button
                  onClick={handleTogglePause}
                  disabled={isProcessingAction}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg bg-yellow-500/10 text-yellow-300 hover:bg-yellow-500/20 border border-yellow-500/30 transition-colors"
                  title="Pause mission"
                >
                  <Pause className="w-3.5 h-3.5" />
                  <span>Pause</span>
                </button>
              )}

              {status === "PAUSED" && (
                <button
                  onClick={handleTogglePause}
                  disabled={isProcessingAction}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg bg-emerald-500/10 text-emerald-300 hover:bg-emerald-500/20 border border-emerald-500/30 transition-colors"
                  title="Resume mission"
                >
                  <Play className="w-3.5 h-3.5" />
                  <span>Resume</span>
                </button>
              )}

              {(status === "RUNNING" || status === "PAUSED" || status === "WAITING_CONFIRMATION") && (
                <div className="flex items-center gap-2">
                  <span className="hidden sm:inline-flex text-[10px] font-mono text-zinc-400 bg-zinc-800/80 px-2 py-1 rounded border border-zinc-700/60">
                    ESC to abort
                  </span>
                  <button
                    onClick={handleStop}
                    disabled={isProcessingAction}
                    className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg bg-rose-500/20 text-rose-300 hover:bg-rose-500/30 border border-rose-500/40 transition-colors"
                    title="Emergency Stop"
                  >
                    <Square className="w-3.5 h-3.5 fill-rose-400" />
                    <span>Stop</span>
                  </button>
                </div>
              )}

              <button
                onClick={() => setIsMaximized(!isMaximized)}
                className="p-1.5 text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800 rounded-lg transition-colors"
                title={isMaximized ? "Restore window" : "Maximize"}
              >
                {isMaximized ? <Minimize2 className="w-4 h-4" /> : <Maximize2 className="w-4 h-4" />}
              </button>

              <button
                onClick={onClose}
                className="p-1.5 text-zinc-400 hover:text-rose-300 hover:bg-rose-500/10 rounded-lg transition-colors"
                title="Close window"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          </div>

          {/* Goal & Progress Indicator Bar */}
          <div className="px-5 py-2.5 bg-zinc-900/40 border-b border-zinc-800/80 flex items-center justify-between gap-4">
            <div className="flex items-center gap-2 text-sm text-zinc-200 truncate flex-1">
              <Sparkles className="w-4 h-4 text-cyan-400 shrink-0" />
              <span className="font-medium text-zinc-300">Goal:</span>
              <span className="truncate text-zinc-100">{goal || "No goal specified."}</span>
            </div>

            <div className="flex items-center gap-3 shrink-0">
              <span className="text-xs font-mono text-cyan-400">
                Step {step} / {maxSteps}
              </span>
              <div className="w-28 h-2 rounded-full bg-zinc-800 overflow-hidden">
                <div
                  className="h-full bg-gradient-to-r from-cyan-500 to-emerald-400 transition-all duration-300"
                  style={{
                    width: `${Math.min(100, Math.max(5, (step / maxSteps) * 100))}%`,
                  }}
                />
              </div>
            </div>
          </div>

          {/* Confirmation Alert Banner (if waiting) */}
          {status === "WAITING_CONFIRMATION" && confirmationData && (
            <div className="p-4 bg-amber-500/15 border-b border-amber-500/40 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 animate-pulse">
              <div className="flex items-start gap-3">
                <ShieldAlert className="w-5 h-5 text-amber-400 shrink-0 mt-0.5" />
                <div>
                  <div className="text-sm font-semibold text-amber-200">
                    Sensitive Action Safeguard Triggered
                  </div>
                  <div className="text-xs text-amber-300/90">
                    {confirmationData.reason || "Action requires user verification before proceeding."}
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <button
                  onClick={() => handleConfirmAction(false)}
                  className="px-3 py-1 text-xs font-semibold rounded-lg bg-zinc-800 text-zinc-300 hover:bg-zinc-700 border border-zinc-700"
                >
                  Deny Action
                </button>
                <button
                  onClick={() => handleConfirmAction(true)}
                  className="px-4 py-1 text-xs font-semibold rounded-lg bg-amber-500 hover:bg-amber-400 text-black shadow-md font-bold"
                >
                  Approve & Continue
                </button>
              </div>
            </div>
          )}

          {/* Main Grid: Left Screen View + Right Cognition Stream */}
          <div className="grid grid-cols-1 lg:grid-cols-12 flex-1 min-h-0 overflow-hidden divide-y lg:divide-y-0 lg:divide-x divide-zinc-800">
            {/* Left Screen Preview (5 or 6 cols) */}
            <div className="lg:col-span-6 xl:col-span-7 flex flex-col h-full bg-zinc-950/60 p-4 overflow-hidden">
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2 text-xs font-mono text-zinc-400">
                  <Eye className="w-3.5 h-3.5 text-cyan-400" />
                  <span>SET-OF-MARKS VISUAL GROUNDING</span>
                </div>
                {elementCount > 0 && (
                  <span className="text-[11px] px-2 py-0.5 rounded bg-zinc-800 text-zinc-300 border border-zinc-700 font-mono">
                    {elementCount} interactive marks
                  </span>
                )}
              </div>

              {/* Viewport Card */}
              <div className="relative flex-1 min-h-0 rounded-xl overflow-hidden border border-zinc-800 bg-zinc-900/50 flex items-center justify-center group">
                {screenshot ? (
                  <div className="relative w-full h-full flex items-center justify-center overflow-hidden">
                    <img
                      src={screenshot}
                      alt="Agent View"
                      className="w-full h-full object-contain"
                    />

                    {/* PC-Agent-E Target Click Reticle Overlay */}
                    {latestPlan && latestPlan.x !== undefined && latestPlan.y !== undefined && (
                      <div
                        className="absolute pointer-events-none -translate-x-1/2 -translate-y-1/2 flex items-center justify-center z-20 transition-all duration-300"
                        style={{
                          left: `${Math.max(3, Math.min(97, Number(latestPlan.x) / 10))}%`,
                          top: `${Math.max(3, Math.min(97, Number(latestPlan.y) / 10))}%`,
                        }}
                      >
                        <div className="relative flex items-center justify-center">
                          <span className="absolute w-8 h-8 rounded-full border-2 border-cyan-400 animate-ping opacity-80" />
                          <span className="w-6 h-6 rounded-full border-2 border-cyan-300 bg-cyan-500/30 backdrop-blur-sm flex items-center justify-center shadow-lg shadow-cyan-500/50">
                            <span className="w-1.5 h-1.5 rounded-full bg-cyan-200" />
                          </span>
                          <span className="absolute -bottom-5 px-1.5 py-0.5 rounded bg-black/90 border border-cyan-500/60 text-[9px] font-mono text-cyan-300 whitespace-nowrap shadow-md">
                            {action || "click"} ({latestPlan.x}, {latestPlan.y})
                          </span>
                        </div>
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="flex flex-col items-center gap-2 text-zinc-500 text-xs">
                    <Activity className="w-8 h-8 animate-pulse text-cyan-500/50" />
                    <span>Awaiting visual feed...</span>
                  </div>
                )}

                {/* Sub-bar showing active page or screen URL */}
                {pageUrl && (
                  <div className="absolute bottom-2 left-2 right-2 px-3 py-1 rounded-lg bg-black/80 backdrop-blur border border-zinc-700/60 text-[11px] font-mono text-zinc-300 truncate z-10">
                    {pageUrl}
                  </div>
                )}
              </div>
            </div>

            {/* Right Cognition & History Stream (6 or 5 cols) */}
            <div className="lg:col-span-6 xl:col-span-5 flex flex-col h-full bg-zinc-900/20 overflow-hidden">
              {/* Active Thought / Reasoning Box */}
              <div className="p-4 border-b border-zinc-800 bg-zinc-900/40">
                <div className="flex items-center justify-between mb-1.5">
                  <span className="text-xs font-mono text-cyan-400 font-semibold uppercase tracking-wider flex items-center gap-1.5">
                    <Bot className="w-3.5 h-3.5" />
                    Inner Monologue / Reasoning
                  </span>
                  {action && (
                    <span className="text-[11px] font-mono px-2 py-0.5 rounded bg-cyan-500/10 text-cyan-300 border border-cyan-500/30">
                      action: {action}
                    </span>
                  )}
                </div>
                <div className="text-sm text-zinc-200 bg-zinc-950/70 p-3 rounded-xl border border-zinc-800 max-h-32 overflow-y-auto leading-relaxed font-sans">
                  {thought}
                </div>
              </div>

              {/* Final Result / Synthesis Report (if completed) */}
              {finalResult ? (
                <div className="flex-1 min-h-0 flex flex-col p-4 bg-zinc-950/90 overflow-hidden">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-xs font-semibold text-emerald-400 uppercase tracking-wider flex items-center gap-1.5">
                      <CheckCircle2 className="w-4 h-4" />
                      MISSION SYNTHESIS REPORT
                    </span>
                    <button
                      onClick={handleCopyResult}
                      className="flex items-center gap-1 px-2.5 py-1 text-xs rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-300 border border-zinc-700 transition-colors"
                    >
                      {copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                      <span>{copied ? "Copied" : "Copy"}</span>
                    </button>
                  </div>
                  <div className="flex-1 overflow-y-auto p-3.5 rounded-xl bg-zinc-900/60 border border-zinc-800 text-xs text-zinc-200 whitespace-pre-wrap leading-relaxed">
                    {finalResult}
                  </div>
                </div>
              ) : (
                /* Step History Timeline */
                <div className="flex-1 min-h-0 flex flex-col p-4 overflow-hidden">
                  <span className="text-xs font-mono text-zinc-400 font-semibold uppercase tracking-wider mb-2 flex items-center gap-1.5">
                    <Clock className="w-3.5 h-3.5" />
                    EXECUTION TIMELINE
                  </span>
                  <div className="flex-1 overflow-y-auto space-y-2 pr-1">
                    {history.length === 0 ? (
                      <div className="text-xs text-zinc-500 text-center py-8">
                        No steps recorded yet. Agent is preparing plan.
                      </div>
                    ) : (
                      history.map((h, i) => (
                        <div
                          key={i}
                          className="p-2.5 rounded-lg bg-zinc-900/60 border border-zinc-800/80 text-xs text-zinc-300 flex flex-col gap-1"
                        >
                          <div className="flex items-center justify-between">
                            <span className="font-mono text-[10px] text-cyan-400 font-bold">
                              STEP #{h.step}
                            </span>
                            <span className="font-mono text-[10px] px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-400">
                              {h.action}
                            </span>
                          </div>
                          <div className="text-zinc-300 text-[11px] line-clamp-2">
                            {h.thought}
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>
        </motion.div>
      </div>
    </AnimatePresence>
  );
};
