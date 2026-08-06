import React, { useEffect, useRef, useState } from "react";
import {
  Settings,
  X,
  Power,
  Mic,
  Cpu,
  Info,
  Check,
  AlertTriangle,
  Volume2,
  Sparkles,
  KeyRound,
  ShieldCheck,
  Loader2,
  Trash2,
  Eye,
  EyeOff,
} from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import {
  BikliSettings,
  DEFAULT_SETTINGS,
  loadSettings,
  saveSettings,
} from "../lib/settingsStore";

interface SettingsPanelProps {
  isOpen: boolean;
  onClose: () => void;
  /** Current settings (owned by App so wake-word state stays in sync). */
  settings: BikliSettings;
  /** Persist a settings patch (also notifies App of changes). */
  onChange: (patch: Partial<BikliSettings>) => void;
  themeColor: string;
}

type SettingsTab = "general" | "voice" | "system" | "about";

/** A single toggle row matching the existing "Screen Vision Mode" switch style. */
function ToggleRow({
  label,
  description,
  checked,
  onChange,
}: {
  label: string;
  description: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="pt-2 border-t border-white/5 flex items-center justify-between text-left">
      <div className="flex flex-col">
        <span className="text-[10px] font-bold font-mono text-slate-200">{label}</span>
        <span className="text-[8px] text-slate-400 uppercase font-mono max-w-[200px]">
          {description}
        </span>
      </div>
      <button
        onClick={() => onChange(!checked)}
        className={`w-10 h-5 rounded-full p-0.5 transition-colors duration-200 focus:outline-none cursor-pointer ${
          checked ? "bg-cyan-500" : "bg-white/10"
        }`}
      >
        <div
          className={`bg-white w-4 h-4 rounded-full shadow-md transform duration-200 ease-in-out ${
            checked ? "translate-x-5" : "translate-x-0"
          }`}
        />
      </button>
    </div>
  );
}

/**
 * Branded voice-sensitivity slider (Settings → Voice).
 * Uses the .bikli-range track/thumb style from index.css and keeps its own
 * draft value while dragging, committing to the app only on RELEASE. That
 * avoids restarting the wake detector / persisting to disk on every pixel of
 * the drag — smooth AND light.
 */
function SensitivitySlider({
  value,
  onChange,
  resetTo,
}: {
  value: number;
  onChange: (v: number) => void;
  resetTo: number;
}) {
  const clamp = (n: number) => Math.max(0, Math.min(100, Math.round(n)));
  const [draft, setDraft] = useState(clamp(value));
  const draggingRef = useRef(false);

  // Re-sync from the persisted value only when not actively dragging, so an
  // external change (factory reset / restart) still shows up.
  useEffect(() => {
    if (!draggingRef.current && draft !== clamp(value)) setDraft(clamp(value));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  const update = (raw: number) => {
    const v = clamp(raw);
    setDraft(v);
    draggingRef.current = true;
  };
  const commit = () => {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    if (draft !== clamp(value)) onChange(draft);
  };
  const reset = () => {
    draggingRef.current = false;
    const v = clamp(resetTo);
    setDraft(v);
    if (v !== clamp(value)) onChange(v);
  };

  const tier =
    draft >= 85
      ? "Very Loose — triggers easily, good in noisy rooms"
      : draft >= 70
        ? "Balanced — fast, reliable wake"
        : draft >= 40
          ? "Balanced"
          : "Strict — avoids false triggers";

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <span className="text-[10px] font-mono text-cyan-300 uppercase">{draft}%</span>
        <button
          type="button"
          onClick={reset}
          className="text-[8px] font-mono uppercase text-slate-400 hover:text-cyan-300 transition cursor-pointer"
        >
          Reset
        </button>
      </div>
      <input
        type="range"
        min={0}
        max={100}
        aria-label="Voice sensitivity"
        className="bikli-range"
        style={{ "--fill": `${draft}%` } as React.CSSProperties}
        value={draft}
        onChange={(e) => update(Number(e.target.value))}
        onPointerUp={commit}
        onMouseUp={commit}
        onTouchEnd={commit}
        onBlur={commit}
        onKeyUp={commit}
      />
      <div className="flex justify-between text-[8px] font-mono uppercase text-slate-600 -mt-0.5">
        <span>Strict</span>
        <span>Loose</span>
      </div>
      <span className="block text-[8px] text-slate-500 uppercase font-mono leading-relaxed">
        {tier} · Higher = faster re-arm &amp; friendlier matching · Lower = fewer false wake-ups.
      </span>
    </div>
  );
}

export function SettingsPanel({ isOpen, onClose, settings, onChange, themeColor }: SettingsPanelProps) {
  const [activeTab, setActiveTab] = useState<SettingsTab>("general");
  const [mics, setMics] = useState<MediaDeviceInfo[]>([]);
  const [agentHealth, setAgentHealth] = useState<{
    online: boolean;
    toolCount?: number;
    cpu?: string;
    ram?: string;
  }>({ online: false });

  // API key status (never contains the key itself — just whether one exists
  // and where it comes from, so the UI can show accurate status + actions).
  const [apiKeyInfo, setApiKeyInfo] = useState<{
    hasApiKey: boolean;
    keySource: "user" | "env" | "none";
    canDelete: boolean;
  }>({ hasApiKey: false, keySource: "none", canDelete: false });
  const [newApiKey, setNewApiKey] = useState("");
  const [keySaving, setKeySaving] = useState(false);
  const [keyDeleting, setKeyDeleting] = useState(false);
  const [keyError, setKeyError] = useState<string | null>(null);
  const [keyNotice, setKeyNotice] = useState<string | null>(null);
  const [editingKey, setEditingKey] = useState(false);
  const [showKey, setShowKey] = useState(false);

  async function refreshKeyStatus() {
    try {
      const res = await fetch("/api/config", { cache: "no-store" });
      if (!res.ok) return;
      const data = await res.json();
      setApiKeyInfo({
        hasApiKey: !!data.hasApiKey,
        keySource: data.keySource ?? (data.hasApiKey ? "user" : "none"),
        canDelete: data.canDelete ?? data.keySource === "user",
      });
    } catch {
      /* backend unreachable — keep last known status */
    }
  }

  async function handleSaveApiKey() {
    const key = newApiKey.trim();
    if (!key || keySaving) return;
    setKeySaving(true);
    setKeyError(null);
    setKeyNotice(null);
    try {
      const res = await fetch("/api/config/apikey", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey: key }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not save the key.");
      setNewApiKey("");
      setEditingKey(false);
      setApiKeyInfo({ hasApiKey: true, keySource: "user", canDelete: true });
      setKeyNotice("API key verified and saved.");
    } catch (err) {
      setKeyError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setKeySaving(false);
    }
  }

  async function handleDeleteApiKey() {
    if (keyDeleting) return;
    setKeyDeleting(true);
    setKeyError(null);
    setKeyNotice(null);
    try {
      const res = await fetch("/api/config/apikey", { method: "DELETE" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not delete the key.");
      setApiKeyInfo({ hasApiKey: false, keySource: "none", canDelete: false });
      setEditingKey(false);
      setNewApiKey("");
      setKeyNotice("API key removed.");
    } catch (err) {
      setKeyError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setKeyDeleting(false);
    }
  }

  // Enumerate microphones (mirrors how audio.ts grabs getUserMedia).
  useEffect(() => {
    if (!isOpen) return;
    refreshKeyStatus();
    const enumerate = async () => {
      try {
        if (!navigator.mediaDevices?.enumerateDevices) return;
        const devices = await navigator.mediaDevices.enumerateDevices();
        setMics(devices.filter((d) => d.kind === "audioinput"));
      } catch {
        /* permission may be needed first */
      }
    };
    enumerate();
  }, [isOpen]);

  // Probe desktop agent health (port 8765) via the server-side logs/health proxy.
  useEffect(() => {
    if (!isOpen) return;
    const probe = async () => {
      try {
        // Re-use the local agent directly (same machine, same browser).
        const res = await fetch("http://127.0.0.1:8765/health", { cache: "no-store" });
        if (!res.ok) {
          setAgentHealth({ online: false });
          return;
        }
        const data = await res.json();
        setAgentHealth({ online: true, toolCount: data.tool_count });
      } catch {
        // Cross-origin may fail; try the server proxy as a fallback.
        try {
          const res2 = await fetch("/api/agent-health", { cache: "no-store" });
          if (res2.ok) {
            const d = await res2.json();
            setAgentHealth({ online: !!d.online, toolCount: d.tool_count });
            return;
          }
        } catch {
          /* ignore */
        }
        setAgentHealth({ online: false });
      }
    };
    probe();
    const id = setInterval(probe, 5000);
    return () => clearInterval(id);
  }, [isOpen]);

  const getThemeBadgeGlow = () => {
    switch (themeColor) {
      case "violet": return "border-purple-500/30 text-purple-400 bg-purple-500/10";
      case "crimson": return "border-rose-500/30 text-rose-400 bg-rose-500/10";
      case "emerald": return "border-emerald-500/30 text-emerald-400 bg-emerald-500/10";
      case "celestial": return "border-sky-500/30 text-sky-400 bg-sky-500/10";
      case "gold": return "border-amber-500/30 text-amber-400 bg-amber-500/10";
      case "rose": return "border-pink-500/30 text-pink-400 bg-pink-500/10";
      case "charcoal":
      default:
        return "border-indigo-500/30 text-indigo-400 bg-indigo-500/10";
    }
  };

  const tabs: { id: SettingsTab; label: string; icon: any }[] = [
    { id: "general", label: "GENERAL", icon: Power },
    { id: "voice", label: "VOICE", icon: Mic },
    { id: "system", label: "SYSTEM", icon: Cpu },
    { id: "about", label: "ABOUT", icon: Info },
  ];

  return (
    <AnimatePresence>
      {isOpen && (
        <>
          {/* Backdrop Overlay — identical to MemoryDashboard */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
            className="absolute inset-0 bg-black/60 z-40 backdrop-blur-sm"
          />

          {/* Slide-over Container — identical shell to MemoryDashboard */}
          <motion.div
            initial={{ x: "100%" }}
            animate={{ x: 0 }}
            exit={{ x: "100%" }}
            transition={{ type: "spring", damping: 25, stiffness: 200 }}
            className="absolute inset-y-0 right-0 w-full max-w-lg bg-[#020206]/95 border-l border-white/15 backdrop-blur-2xl z-50 flex flex-col shadow-[0_0_50px_rgba(0,0,0,0.8)]"
          >
            {/* Header */}
            <div className="p-6 border-b border-white/10 flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className={`p-2.5 rounded-xl border ${getThemeBadgeGlow()}`}>
                  <Settings size={22} className="animate-spin [animation-duration:6s]" />
                </div>
                <div>
                  <h3 className="font-display font-medium text-lg tracking-tight text-white flex items-center gap-2">
                    Bikli Configuration
                    <Sparkles size={14} className="text-cyan-400" />
                  </h3>
                  <p className="text-[10px] font-mono uppercase tracking-widest text-slate-400 mt-0.5">
                    System settings &amp; preferences
                  </p>
                </div>
              </div>
              <button
                onClick={onClose}
                className="p-2 rounded-xl border border-white/5 bg-white/5 hover:bg-white/10 text-slate-400 hover:text-white transition cursor-pointer"
              >
                <X size={18} />
              </button>
            </div>

            {/* Tab selector row — mirrors MemoryDashboard / Recalls pill scroller */}
            <div className="px-6 py-4 border-b border-white/5 flex items-center gap-2 overflow-x-auto recalls-tabs-scroll pb-3">
              {tabs.map((t) => {
                const Icon = t.icon;
                const active = activeTab === t.id;
                return (
                  <button
                    key={t.id}
                    onClick={() => setActiveTab(t.id)}
                    className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl border text-xs font-mono tracking-wider transition shrink-0 cursor-pointer ${
                      active
                        ? "border-cyan-400 bg-cyan-400/10 text-cyan-300"
                        : "border-white/5 bg-white/5 text-slate-400 hover:bg-white/10"
                    }`}
                  >
                    <Icon size={12} />
                    <span>{t.label}</span>
                  </button>
                );
              })}
            </div>

            {/* Scrollable content — Recalls-style glow rail (Voice & all tabs) */}
            <div className="flex-1 overflow-y-auto bikli-scroll p-6 pr-4 space-y-5">
              {/* ---------------- GENERAL ---------------- */}
              {activeTab === "general" && (
                <div className="space-y-4">
                  <div className="text-[10px] font-mono uppercase tracking-widest text-slate-500">
                    Startup &amp; Appearance
                  </div>

                  <ToggleRow
                    label="LAUNCH AT STARTUP"
                    description="Start Bikli silently when Windows logs in"
                    checked={settings.autoStart}
                    onChange={(v) => {
                      onChange({ autoStart: v });
                      // Persist + push to backend; the desktop agent flips the
                      // HKCU Run registry key. We just record intent here.
                      void fetch("/api/settings", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ autoStart: v }),
                      }).catch(() => {});
                    }}
                  />

                  <ToggleRow
                    label="UI ANIMATIONS"
                    description="Enable motion and orb transitions"
                    checked={settings.animations}
                    onChange={(v) => onChange({ animations: v })}
                  />

                  {settings.autoStart && (
                    <div className="mt-2 p-3 rounded-xl border border-emerald-500/20 bg-emerald-500/5 flex items-center gap-2">
                      <Check size={14} className="text-emerald-400 shrink-0" />
                      <span className="text-[10px] font-mono text-emerald-300/80">
                        Bikli will auto-launch on next Windows login.
                      </span>
                    </div>
                  )}

                  {/* Gemini API Key */}
                  <div className="pt-4 border-t border-white/10 space-y-3">
                    <div className="flex items-center gap-2">
                      <KeyRound size={14} className="text-cyan-400" />
                      <span className="text-[10px] font-mono uppercase tracking-wider text-slate-300">
                        Gemini API Key
                      </span>
                    </div>

                    {apiKeyInfo.hasApiKey && !editingKey ? (
                      /* Key is configured — show status + Change / Remove */
                      <div className="flex items-center justify-between p-3 rounded-xl border border-emerald-500/20 bg-emerald-500/5">
                        <div className="flex items-center gap-2">
                          <ShieldCheck size={12} className="text-emerald-400" />
                          <span className="text-[9px] font-mono text-emerald-300/80">
                            Key configured
                            {apiKeyInfo.keySource === "env" ? " (env)" : ""}
                          </span>
                        </div>
                        {apiKeyInfo.canDelete && (
                          <div className="flex items-center gap-1">
                            <button
                              onClick={() => {
                                setEditingKey(true);
                                setNewApiKey("");
                                setKeyError(null);
                                setKeyNotice(null);
                              }}
                              className="text-[9px] font-mono text-slate-300 hover:text-white transition"
                            >
                              Change
                            </button>
                            <span className="text-slate-600">|</span>
                            <button
                              onClick={handleDeleteApiKey}
                              disabled={keyDeleting}
                              className="text-[9px] font-mono text-rose-400 hover:text-rose-300 transition disabled:opacity-50"
                            >
                              {keyDeleting ? "Removing…" : "Remove"}
                            </button>
                          </div>
                        )}
                      </div>
                    ) : (
                      /* No key or editing — show input form */
                      <div className="space-y-2">
                        <div className="relative">
                          <input
                            type={showKey ? "text" : "password"}
                            value={newApiKey}
                            onChange={(e) => setNewApiKey(e.target.value)}
                            placeholder="AIza…"
                            spellCheck={false}
                            className="w-full px-3 py-2 rounded-xl border border-white/10 bg-black/40 text-xs text-white font-mono focus:outline-none focus:border-cyan-400/50 transition pr-8"
                          />
                          <button
                            type="button"
                            onClick={() => setShowKey(!showKey)}
                            className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-200 transition"
                          >
                            {showKey ? (
                              <EyeOff size={12} />
                            ) : (
                              <Eye size={12} />
                            )}
                          </button>
                        </div>
                        <div className="flex gap-2">
                          <button
                            onClick={handleSaveApiKey}
                            disabled={!newApiKey.trim() || keySaving}
                            className="flex-1 flex items-center justify-center gap-1.5 rounded-xl bg-gradient-to-r from-indigo-500 to-cyan-500 px-3 py-1.5 text-[9px] font-mono font-semibold text-white transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
                          >
                            {keySaving && <Loader2 size={10} className="animate-spin" />}
                            {keySaving ? "Verifying…" : "Save Key"}
                          </button>
                          {editingKey && (
                            <button
                              onClick={() => {
                                setEditingKey(false);
                                setNewApiKey("");
                                setKeyError(null);
                                setKeyNotice(null);
                              }}
                              className="flex-1 rounded-xl border border-white/10 bg-white/5 text-[9px] font-mono text-slate-300 hover:text-white transition"
                            >
                              Cancel
                            </button>
                          )}
                        </div>
                        <span className="text-[8px] text-slate-500 uppercase font-mono">
                          Your key stays local. Never shared or stored in settings.json.
                        </span>
                      </div>
                    )}

                    {keyError && (
                      <p className="rounded-lg bg-red-500/10 px-3 py-2 text-[8px] text-red-300 ring-1 ring-red-500/20">
                        {keyError}
                      </p>
                    )}
                    {keyNotice && (
                      <p className="rounded-lg bg-emerald-500/10 px-3 py-2 text-[8px] text-emerald-300/80">
                        {keyNotice}
                      </p>
                    )}
                  </div>
                </div>
              )}

              {/* ---------------- VOICE ---------------- */}
              {activeTab === "voice" && (
                <div className="space-y-4">
                  <div className="text-[10px] font-mono uppercase tracking-widest text-slate-500">
                    Wake Word &amp; Microphone
                  </div>

                  <ToggleRow
                    label="WAKE WORD"
                    description="Always-listen for the activation phrase"
                    checked={settings.wakeWordEnabled}
                    onChange={(v) => onChange({ wakeWordEnabled: v })}
                  />

                  <div className="space-y-1.5">
                    <label className="block text-[10px] font-mono tracking-wider text-slate-300 uppercase">
                      Wake Phrase
                    </label>
                    <input
                      type="text"
                      value={settings.wakePhrase}
                      onChange={(e) => onChange({ wakePhrase: e.target.value })}
                      placeholder="hey, hi, hello, bikli"
                      className="w-full px-3 py-2 rounded-xl border border-white/10 bg-white/5 text-sm text-white font-mono focus:outline-none focus:border-cyan-400/50 transition"
                    />
                    <span className="text-[8px] text-slate-500 uppercase font-mono">
                      Say hey or hi to turn Bikli on (also hello / bikli). Built-in greets always work.
                    </span>
                  </div>

                  <div className="pt-3 border-t border-white/5 space-y-3">
                    <div className="text-[10px] font-mono uppercase tracking-widest text-slate-500">
                      Full PC Control Gate
                    </div>
                    <ToggleRow
                      label="REQUIRE CONTROL WORD"
                      description="Cursor + full desktop control only after you say the control word"
                      checked={settings.controlWordRequired !== false}
                      onChange={(v) => onChange({ controlWordRequired: v })}
                    />
                    <div className="space-y-1.5">
                      <label className="block text-[10px] font-mono tracking-wider text-slate-300 uppercase">
                        Control Phrase
                      </label>
                      <input
                        type="text"
                        value={settings.controlPhrase || "control, take control"}
                        onChange={(e) => onChange({ controlPhrase: e.target.value })}
                        placeholder="control, take control, computer control"
                        className="w-full px-3 py-2 rounded-xl border border-white/10 bg-white/5 text-sm text-white font-mono focus:outline-none focus:border-amber-400/50 transition"
                      />
                      <span className="text-[8px] text-slate-500 uppercase font-mono">
                        Say &quot;control&quot; to unlock mouse/PC. Say &quot;stop control&quot; to lock again.
                      </span>
                    </div>
                  </div>

                  <div className="space-y-1.5">
                    <label className="block text-[10px] font-mono tracking-wider text-slate-300 uppercase">
                      Microphone
                    </label>
                    <select
                      value={settings.micDeviceId}
                      onChange={(e) => onChange({ micDeviceId: e.target.value })}
                      className="w-full px-3 py-2 rounded-xl border border-white/10 bg-white/5 text-sm text-white font-mono focus:outline-none focus:border-cyan-400/50 transition cursor-pointer"
                    >
                      <option value="">System Default</option>
                      {mics.map((m, i) => (
                        <option key={m.deviceId || i} value={m.deviceId}>
                          {m.label || `Microphone ${i + 1}`}
                        </option>
                      ))}
                    </select>
                    <span className="text-[8px] text-slate-500 uppercase font-mono">
                      {mics.length === 0
                        ? "Grant mic permission to list devices"
                        : `${mics.length} device(s) detected`}
                    </span>
                  </div>

                  <div className="space-y-1.5">
                    <label className="block text-[10px] font-mono tracking-wider text-slate-300 uppercase">
                      Voice Language
                    </label>
                    <select
                      value={settings.speechLanguage || "auto"}
                      onChange={(e) => onChange({ speechLanguage: e.target.value })}
                      className="w-full px-3 py-2 rounded-xl border border-white/10 bg-white/5 text-sm text-white font-mono focus:outline-none focus:border-cyan-400/50 transition cursor-pointer"
                    >
                      <option value="auto">Auto (best for Hinglish)</option>
                      <option value="hi-IN">हिन्दी — Hindi (hi-IN)</option>
                      <option value="en-IN">English — India (en-IN)</option>
                      <option value="en-US">English — US (en-US)</option>
                      <option value="bn-IN">বাংলা — Bengali (bn-IN)</option>
                      <option value="mr-IN">मराठी — Marathi (mr-IN)</option>
                      <option value="ta-IN">தமிழ் — Tamil (ta-IN)</option>
                      <option value="te-IN">తెలుగు — Telugu (te-IN)</option>
                      <option value="gu-IN">ગુજરાતી — Gujarati (gu-IN)</option>
                    </select>
                    <span className="text-[8px] text-slate-500 uppercase font-mono">
                      Forces native pronunciation. Pick Hindi if Hindi words sound anglicised. Reconnect to apply.
                    </span>
                  </div>

                  <div className="space-y-1.5">
                    <label className="block text-[10px] font-mono tracking-wider text-slate-300 uppercase">
                      Sensitivity
                    </label>
                    <SensitivitySlider
                      value={settings.sensitivity}
                      onChange={(v) => onChange({ sensitivity: v })}
                      resetTo={DEFAULT_SETTINGS.sensitivity}
                    />
                  </div>
                </div>
              )}

              {/* ---------------- SYSTEM ---------------- */}
              {activeTab === "system" && (
                <div className="space-y-4">
                  <div className="text-[10px] font-mono uppercase tracking-widest text-slate-500">
                    Desktop Control Agent
                  </div>

                  <div
                    className={`p-4 rounded-xl border flex items-center gap-3 ${
                      agentHealth.online
                        ? "border-emerald-500/20 bg-emerald-500/5"
                        : "border-rose-500/20 bg-rose-500/5"
                    }`}
                  >
                    <div
                      className={`w-2.5 h-2.5 rounded-full shrink-0 ${
                        agentHealth.online ? "bg-emerald-400 animate-pulse" : "bg-rose-400"
                      }`}
                    />
                    <div className="flex-1">
                      <div className="text-xs font-mono text-white">
                        {agentHealth.online ? "Agent Online" : "Agent Offline"}
                      </div>
                      <div className="text-[10px] font-mono text-slate-400">
                        {agentHealth.online
                          ? `${agentHealth.toolCount ?? 0} tools registered`
                          : "Start the Python agent on port 8765"}
                      </div>
                    </div>
                    <Cpu size={16} className="text-slate-500" />
                  </div>

                  <div className="p-3 rounded-xl border border-white/5 bg-white/5 space-y-2">
                    <div className="flex items-center gap-2 text-[10px] font-mono text-slate-400 uppercase tracking-wider">
                      <Volume2 size={12} /> Capabilities
                    </div>
                    <div className="grid grid-cols-2 gap-1.5 text-[10px] font-mono text-slate-300">
                      <span>✓ App control</span>
                      <span>✓ Browser</span>
                      <span>✓ Volume</span>
                      <span>✓ Brightness</span>
                      <span>✓ Power</span>
                      <span>✓ Files</span>
                      <span>✓ Screenshot</span>
                      <span>✓ Clipboard</span>
                    </div>
                  </div>
                </div>
              )}

              {/* ---------------- ABOUT ---------------- */}
              {activeTab === "about" && (
                <div className="space-y-4">
                  <div className="text-[10px] font-mono uppercase tracking-widest text-slate-500">
                    About Bikli
                  </div>

                  <div className="p-4 rounded-xl border border-white/5 bg-white/5 space-y-3">
                    <div className="flex items-center gap-2">
                      <Info size={14} className="text-cyan-400" />
                      <span className="text-sm font-display text-white">BIKLI AI Assistant</span>
                    </div>
                    <div className="space-y-1.5 text-[10px] font-mono text-slate-400">
                      <div className="flex justify-between">
                        <span>VERSION</span>
                        <span className="text-slate-300">V2.0.0</span>
                      </div>
                      <div className="flex justify-between">
                        <span>ENGINE</span>
                        <span className="text-slate-300">Gemini Live</span>
                      </div>
                      <div className="flex justify-between">
                        <span>DESKTOP</span>
                        <span className="text-slate-300">FastAPI Agent</span>
                      </div>
                      <div className="flex justify-between">
                        <span>WAKE WORD</span>
                        <span className="text-slate-300">Web Speech API</span>
                      </div>
                    </div>
                  </div>

                  <div className="p-3 rounded-xl border border-amber-500/15 bg-amber-500/5 flex items-start gap-2">
                    <AlertTriangle size={12} className="text-amber-400 shrink-0 mt-0.5" />
                    <span className="text-[10px] font-mono text-amber-300/70 leading-relaxed">
                      Keep this tab active for wake-word detection. Microphone access
                      is required for voice activation.
                    </span>
                  </div>
                </div>
              )}

            </div>{/* /scrollable content */}

            {/* Footer status bar — mirrors MemoryDashboard */}
            <div className="px-6 py-3 border-t border-white/5 bg-white/5 flex items-center justify-between">
              <span className="text-[9px] font-mono uppercase tracking-widest text-slate-500">
                Preferences auto-save
              </span>
              <span className="text-[9px] font-mono uppercase tracking-widest text-slate-500">
                Bikli V2
              </span>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
