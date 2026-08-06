import React, { useState } from "react";
import { Memory, MemoryCategory } from "../lib/memoryTypes";
import {
  Brain,
  X,
  Trash2,
  Plus,
  Pencil,
  User,
  Heart,
  Target,
  Briefcase,
  Users,
  Flame,
  Sparkles,
  Check
} from "lucide-react";
import { motion, AnimatePresence } from "motion/react";

interface MemoryDashboardProps {
  isOpen: boolean;
  onClose: () => void;
  memories: Memory[];
  onAddMemory: (category: MemoryCategory, text: string) => Promise<void>;
  onDeleteMemory: (id: string) => Promise<void>;
  onUpdateMemory: (id: string, category: MemoryCategory, text: string) => Promise<void>;
  themeColor: string;
}

export function MemoryDashboard({
  isOpen,
  onClose,
  memories,
  onAddMemory,
  onDeleteMemory,
  onUpdateMemory,
  themeColor
}: MemoryDashboardProps) {
  const [activeTab, setActiveTab] = useState<MemoryCategory | "all">("all");
  const [newText, setNewText] = useState("");
  const [newCategory, setNewCategory] = useState<MemoryCategory>("identity");
  const [isAdding, setIsAdding] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);

  // Inline EDIT state — one memory at a time, replacing its card content.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState("");
  const [editCategory, setEditCategory] = useState<MemoryCategory>("identity");
  const [editSubmitting, setEditSubmitting] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);

  // Category Configuration
  const categoryConfig: Record<MemoryCategory, { label: string; icon: any; color: string; bg: string }> = {
    identity: { 
      label: "Identity Core", 
      icon: User, 
      color: "text-amber-400 border-amber-500/25", 
      bg: "bg-amber-500/5 hover:bg-amber-500/10" 
    },
    preference: { 
      label: "Preferences", 
      icon: Heart, 
      color: "text-pink-400 border-pink-500/25", 
      bg: "bg-pink-500/5 hover:bg-pink-500/10" 
    },
    goal: { 
      label: "Life Goals", 
      icon: Target, 
      color: "text-emerald-400 border-emerald-500/25", 
      bg: "bg-emerald-500/5 hover:bg-emerald-500/10" 
    },
    project: { 
      label: "Active Projects", 
      icon: Briefcase, 
      color: "text-cyan-400 border-cyan-500/25", 
      bg: "bg-cyan-500/5 hover:bg-cyan-500/10" 
    },
    relationship: { 
      label: "Relationships", 
      icon: Users, 
      color: "text-purple-400 border-purple-500/25", 
      bg: "bg-purple-500/5 hover:bg-purple-500/10" 
    },
    emotional: { 
      label: "Milestones", 
      icon: Flame, 
      color: "text-red-400 border-red-500/25", 
      bg: "bg-red-500/5 hover:bg-red-500/10" 
    },
    behavior: { 
      label: "Behaviors & Habits", 
      icon: Brain, 
      color: "text-indigo-400 border-indigo-500/25", 
      bg: "bg-indigo-500/5 hover:bg-indigo-500/10" 
    },
  };

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

  const filteredMemories = activeTab === "all" 
    ? memories 
    : memories.filter(m => m.category === activeTab);

  const handleManualAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newText.trim()) return;

    setSubmitting(true);
    setAddError(null);
    try {
      await onAddMemory(newCategory, newText.trim());
      setNewText("");
      setIsAdding(false);
    } catch (e) {
      console.error(e);
      setAddError(e instanceof Error ? e.message : "Could not save memory. Try again.");
    } finally {
      setSubmitting(false);
    }
  };

  // Populate the inline editor with the memory being edited.
  const startEdit = (m: Memory) => {
    setEditingId(m.id);
    setEditText(m.text);
    setEditCategory((m.category as MemoryCategory) ?? "identity");
    setEditError(null);
  };

  const cancelEdit = () => {
    setEditingId(null);
    setEditText("");
    setEditError(null);
  };

  const handleEditSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingId || !editText.trim()) return;
    setEditSubmitting(true);
    setEditError(null);
    try {
      await onUpdateMemory(editingId, editCategory, editText.trim());
      cancelEdit();
    } catch (err) {
      console.error(err);
      setEditError(err instanceof Error ? err.message : "Could not update memory. Try again.");
    } finally {
      setEditSubmitting(false);
    }
  };

  // Compact reusable category chip row (used by both ADD and EDIT forms).
  const renderCategoryPicker = (
    activeCat: MemoryCategory,
    onSelect: (c: MemoryCategory) => void
  ) => (
    <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
      {(Object.keys(categoryConfig) as MemoryCategory[]).map((cat) => {
        const Icon = categoryConfig[cat].icon;
        const active = activeCat === cat;
        return (
          <button
            key={cat}
            type="button"
            onClick={() => onSelect(cat)}
            className={`flex items-center gap-2 p-1.5 rounded-lg border text-xs tracking-wide transition cursor-pointer ${
              active
                ? "border-cyan-400 bg-cyan-400/10 text-cyan-300"
                : "border-white/5 bg-white/5 text-slate-400 hover:bg-white/10"
            }`}
          >
            <Icon size={12} />
            <span className="truncate">{categoryConfig[cat].label.split(" ")[0]}</span>
          </button>
        );
      })}
    </div>
  );

  const formatDate = (isoStr: string) => {
    try {
      const d = new Date(isoStr);
      return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
    } catch (e) {
      return "Durable Record";
    }
  };

  return (
    <AnimatePresence>
      {isOpen && (
        <>
          {/* Backdrop Overlay */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
            className="absolute inset-0 bg-black/60 z-40 backdrop-blur-sm"
          />

          {/* Slide-over Container */}
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
                  <Brain size={22} className="animate-pulse" />
                </div>
                <div>
                  <h3 className="font-display font-medium text-lg tracking-tight text-white flex items-center gap-2">
                    Bikli Memory Core
                    <Sparkles size={14} className="text-cyan-400" />
                  </h3>
                  <p className="text-[10px] font-mono uppercase tracking-widest text-slate-400 mt-0.5">
                    Persistent recollect files ({memories.length})
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

            {/* Quick stats & action row */}
            <div className="px-6 py-4 bg-white/5 border-b border-white/5 flex items-center justify-between gap-2.5">
              <span className="text-[10px] text-slate-400 font-mono">
                💡 Bikli remembers these details naturally as you chat.
              </span>
              {!isAdding && (
                <button
                  onClick={() => setIsAdding(true)}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl border border-cyan-500/30 bg-cyan-500/10 hover:bg-cyan-500/20 text-xs font-mono tracking-wider text-cyan-300 transition shrink-0 cursor-pointer"
                >
                  <Plus size={12} />
                  <span>MANUAL SEED</span>
                </button>
              )}
            </div>

            {/* Manual entry card drawer inside dashboard */}
            <AnimatePresence>
              {isAdding && (
                // NOTE: no height animation here — animating height on a parent
                // with an inner scrollable (max-height) child made the drawer
                // sometimes open to a sliver / clip ("only a part shows").
                // Render at natural height instead; the form body scrolls itself.
                <motion.div
                  initial={{ opacity: 0, y: -10 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.18 }}
                  className="border-b border-white/15 bg-[#080812]"
                >
                  <form onSubmit={handleManualAdd} className="flex flex-col">
                    {/* Scrollable body — capped height so it never overruns the panel */}
                    <div className="px-5 pt-5 space-y-3.5 overflow-y-auto" style={{ maxHeight: "42vh" }}>
                      <div>
                        <label className="block text-[11px] font-mono tracking-wider text-slate-300 uppercase mb-2">
                          Memory Archetype Category
                        </label>
                        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                          {(Object.keys(categoryConfig) as MemoryCategory[]).map((cat) => {
                            const Icon = categoryConfig[cat].icon;
                            const active = newCategory === cat;
                            return (
                              <button
                                key={cat}
                                type="button"
                                onClick={() => setNewCategory(cat)}
                                className={`flex items-center gap-1.5 min-w-0 p-2 rounded-lg border text-xs tracking-wide transition cursor-pointer ${
                                  active
                                    ? "border-cyan-400 bg-cyan-400/10 text-cyan-300"
                                    : "border-white/5 bg-white/5 text-slate-400 hover:bg-white/10"
                                }`}
                              >
                                <Icon size={12} className="shrink-0" />
                                <span className="truncate">{categoryConfig[cat].label.split(" ")[0]}</span>
                              </button>
                            );
                          })}
                        </div>
                      </div>

                      <div>
                        <label className="block text-[11px] font-mono tracking-wider text-slate-300 uppercase mb-2">
                          Recollection Statement (3rd Person declarative)
                        </label>
                        <textarea
                          value={newText}
                          onChange={(e) => {
                            setNewText(e.target.value);
                            if (addError) setAddError(null);
                          }}
                          placeholder="e.g. The user's startup is called Bikli, a voice AI platform."
                          required
                          className="w-full h-24 text-xs p-3 rounded-lg border border-white/10 bg-black/40 text-white placeholder-slate-500 focus:outline-none focus:border-cyan-500/60 resize-none font-sans"
                        />
                      </div>

                      {addError && (
                        <p className="text-xs text-red-300 bg-red-500/10 border border-red-500/25 rounded-lg px-3 py-2">
                          {addError}
                        </p>
                      )}
                    </div>

                    {/* Pinned action bar — always visible, never scrolled out of reach */}
                    <div className="px-5 py-3.5 mt-3 flex gap-2.5 justify-end border-t border-white/10 bg-[#0a0a14] shrink-0">
                      <button
                        type="button"
                        onClick={() => setIsAdding(false)}
                        className="px-3.5 py-2 rounded-lg border border-white/5 text-xs font-mono tracking-wide text-slate-400 hover:text-white transition cursor-pointer"
                      >
                        Cancel
                      </button>
                      <button
                        type="submit"
                        disabled={submitting}
                        className="px-4 py-2 rounded-lg bg-cyan-500 hover:bg-cyan-400 text-slate-950 font-bold text-xs uppercase font-mono tracking-widest transition disabled:opacity-50 cursor-pointer"
                      >
                        {submitting ? "Saving..." : "Commit Memory"}
                      </button>
                    </div>
                  </form>
                </motion.div>
              )}
            </AnimatePresence>

            {/* TAB SELECTOR SCROLLER */}
            <div className="px-6 py-4 flex gap-1.5 overflow-x-auto recalls-tabs-scroll border-b border-white/10 shrink-0 pb-3">
              <button
                onClick={() => setActiveTab("all")}
                className={`px-3 py-1.5 rounded-full border text-[11px] tracking-wider uppercase transition cursor-pointer shrink-0 ${
                  activeTab === "all"
                    ? "border-white bg-white text-slate-950 font-bold"
                    : "border-white/5 bg-white/5 text-slate-400 hover:border-white/15"
                }`}
              >
                All Memories
              </button>
              {(Object.keys(categoryConfig) as MemoryCategory[]).map((cat) => {
                const config = categoryConfig[cat];
                const active = activeTab === cat;
                return (
                  <button
                    key={cat}
                    onClick={() => setActiveTab(cat)}
                    className={`px-3 py-1.5 rounded-full border text-[11px] tracking-wider uppercase transition shrink-0 cursor-pointer ${
                      active
                        ? "border-white bg-white text-slate-950 font-bold"
                        : "border-white/5 bg-white/5 text-slate-400 hover:border-white/15"
                    }`}
                  >
                    {config.label.split(" ")[0]}
                  </button>
                );
              })}
            </div>

            {/* RECOLLECTION ITEMS CARDS CONTAINER */}
            <div className="flex-1 overflow-y-auto recalls-scroll p-6 pr-4 space-y-3.5">
              <AnimatePresence initial={false}>
                {filteredMemories.length === 0 ? (
                  <motion.div
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    className="h-full flex flex-col items-center justify-center p-8 text-center text-slate-500"
                  >
                    <div className="p-4 rounded-full border border-dashed border-white/10 bg-white/[0.02] mb-4">
                      <Brain size={32} className="opacity-40" />
                    </div>
                    <h4 className="text-sm font-semibold tracking-wide text-slate-300">No memories recorded yet</h4>
                    <p className="text-xs max-w-xs mt-1.5 leading-relaxed font-mono">
                      {activeTab === "all" 
                        ? "Start talking aloud with Bikli! Her background consolidator analyzes transcript slices and builds a life context naturally."
                        : `No persistent recollections saved in Category "${categoryConfig[activeTab as MemoryCategory]?.label}". Add one or speak with Bikli.`}
                    </p>
                  </motion.div>
                ) : (
                  filteredMemories.map((m) => {
                    // Guard against legacy/unknown categories — a memory with an
                    // unexpected category used to crash the whole dashboard (cfg
                    // was undefined and cfg.icon threw).
                    const cfg = categoryConfig[m.category as MemoryCategory] ?? {
                      label: "Note",
                      icon: Sparkles,
                      color: "text-slate-400 border-white/15",
                      bg: "bg-white/5 hover:bg-white/10",
                    };
                    const Icon = cfg.icon;

                    return (
                      <motion.div
                        key={m.id}
                        initial={{ opacity: 0, y: 10 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, scale: 0.95 }}
                        className={`p-4 rounded-xl border border-white/5 backdrop-blur-md bg-white/[0.02] ${cfg.bg} transition-colors group relative`}
                      >
                        {editingId === m.id ? (
                          /* ---- Inline EDIT form replaces the card while editing ---- */
                          <form onSubmit={handleEditSubmit} className="space-y-4">
                            <div>
                              <label className="block text-[11px] font-mono tracking-wider text-slate-300 uppercase mb-2">
                                Memory Archetype Category
                              </label>
                              {renderCategoryPicker(editCategory, setEditCategory)}
                            </div>
                            <div>
                              <label className="block text-[11px] font-mono tracking-wider text-slate-300 uppercase mb-2">
                                Recollection Statement (3rd Person declarative)
                              </label>
                              <textarea
                                value={editText}
                                onChange={(e) => {
                                  setEditText(e.target.value);
                                  if (editError) setEditError(null);
                                }}
                                required
                                className="w-full h-20 text-xs p-3 rounded-lg border border-white/10 bg-black/40 text-white placeholder-slate-500 focus:outline-none focus:border-cyan-500/60 resize-none font-sans"
                              />
                            </div>
                            {editError && (
                              <p className="text-xs text-red-300 bg-red-500/10 border border-red-500/25 rounded-lg px-3 py-2">
                                {editError}
                              </p>
                            )}
                            <div className="flex gap-2.5 justify-end">
                              <button
                                type="button"
                                onClick={cancelEdit}
                                className="px-3.5 py-1.5 rounded-lg border border-white/5 text-xs font-mono tracking-wide text-slate-400 hover:text-white transition cursor-pointer"
                              >
                                Cancel
                              </button>
                              <button
                                type="submit"
                                disabled={editSubmitting}
                                className="flex items-center gap-1.5 px-4 py-1.5 rounded-lg bg-cyan-500 hover:bg-cyan-400 text-slate-950 font-bold text-xs uppercase font-mono tracking-widest transition disabled:opacity-50 cursor-pointer"
                              >
                                <Check size={12} />
                                {editSubmitting ? "Saving..." : "Commit Edit"}
                              </button>
                            </div>
                          </form>
                        ) : (
                          /* ---- Normal (read) card content ---- */
                          <div className="flex items-start justify-between gap-4">
                            <div className="flex gap-3.5 overflow-hidden">
                              <div className={`p-2 rounded-lg border mt-0.5 shrink-0 bg-black/40 ${cfg.color}`}>
                                <Icon size={14} />
                              </div>
                              <div className="overflow-hidden">
                                <span className={`text-[9px] font-mono uppercase tracking-wider block ${cfg.color}`}>
                                  {cfg.label}
                                </span>
                                <p className="text-xs text-slate-200 mt-1 font-sans leading-relaxed break-words font-medium">
                                  {m.text}
                                </p>
                                <span className="text-[9px] font-mono text-slate-500 mt-2 block">
                                  Recalled: {formatDate(m.createdAt)}
                                </span>
                              </div>
                            </div>

                            {/* Edit + Forget action buttons */}
                            <div className="absolute top-4 right-4 sm:relative sm:top-0 sm:right-0 flex items-center gap-1.5 shrink-0">
                              <button
                                onClick={() => startEdit(m)}
                                className="opacity-0 group-hover:opacity-100 p-2 rounded-lg border border-cyan-500/25 bg-cyan-950/15 text-cyan-400 hover:bg-cyan-500 hover:text-white transition-all duration-150 cursor-pointer"
                                title="Edit this memory"
                              >
                                <Pencil size={13} />
                              </button>
                              <button
                                onClick={() => onDeleteMemory(m.id)}
                                className="opacity-0 group-hover:opacity-100 p-2 rounded-lg border border-red-500/25 bg-red-950/15 text-red-400 hover:bg-red-500 hover:text-white transition-all duration-150 cursor-pointer"
                                title="Forget this memory"
                              >
                                <Trash2 size={13} />
                              </button>
                            </div>
                          </div>
                        )}
                      </motion.div>
                    );
                  })
                )}
              </AnimatePresence>
            </div>

            {/* Technical visual core footprint footer */}
            <div className="p-5 border-t border-white/10 bg-black/40 flex items-center justify-between text-[9px] font-mono text-slate-600 tracking-wider">
              <span className="flex items-center gap-1">
                <span className="w-1.5 h-1.5 rounded-full bg-cyan-400 shadow-[0_0_5px_rgba(34,211,238,0.7)] animate-pulse" />
                <span>MEM-SYNC STREAM ACTIVE</span>
              </span>
              <span>DURABLE LOCAL JSON DB SEED</span>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
