import React from "react";
import { Camera, X, Eye, EyeOff, RefreshCw } from "lucide-react";
import { motion, AnimatePresence } from "motion/react";

interface CameraModalProps {
  isOpen: boolean;
  onClose: () => void;
  videoRef: React.RefObject<HTMLVideoElement | null>;
  isVisionActive: boolean;
  onToggleVision?: () => void;
}

export const CameraModal: React.FC<CameraModalProps> = ({
  isOpen,
  onClose,
  videoRef,
  isVisionActive,
  onToggleVision,
}) => {
  if (!isOpen) return null;

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0, scale: 0.92, y: 20 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.92, y: 20 }}
        transition={{ duration: 0.22, ease: "easeOut" }}
        className="fixed bottom-6 right-6 z-50 w-96 overflow-hidden rounded-2xl border border-cyan-500/30 bg-slate-950/90 shadow-2xl shadow-cyan-950/50 backdrop-blur-xl"
      >
        {/* Header bar */}
        <div className="flex items-center justify-between border-b border-cyan-500/20 bg-slate-900/60 px-4 py-3">
          <div className="flex items-center gap-2.5">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-cyan-500/10 text-cyan-400 border border-cyan-500/20">
              <Camera className="h-4 w-4" />
            </div>
            <div>
              <h3 className="text-sm font-semibold text-slate-100">Camera App</h3>
              <div className="flex items-center gap-1.5">
                <span
                  className={`h-2 w-2 rounded-full ${
                    isVisionActive ? "bg-emerald-400 animate-pulse" : "bg-slate-500"
                  }`}
                />
                <span className="text-xs text-slate-400">
                  {isVisionActive ? "AI Vision Active (Camera)" : "Camera Preview"}
                </span>
              </div>
            </div>
          </div>

          <div className="flex items-center gap-1">
            {onToggleVision && (
              <button
                onClick={onToggleVision}
                title={isVisionActive ? "Pause AI Vision" : "Enable AI Vision"}
                className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-800 hover:text-slate-200 transition-colors"
              >
                {isVisionActive ? (
                  <Eye className="h-4 w-4 text-emerald-400" />
                ) : (
                  <EyeOff className="h-4 w-4 text-slate-500" />
                )}
              </button>
            )}
            <button
              onClick={onClose}
              title="Close Camera"
              className="rounded-lg p-1.5 text-slate-400 hover:bg-red-500/20 hover:text-red-300 transition-colors"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* Video feed container */}
        <div className="relative aspect-video w-full bg-black">
          <video
            ref={videoRef}
            autoPlay
            playsInline
            muted
            className="h-full w-full object-cover"
          />

          {/* Vision indicator pill overlay */}
          {isVisionActive && (
            <div className="absolute top-3 left-3 flex items-center gap-1.5 rounded-full border border-emerald-500/30 bg-slate-950/80 px-2.5 py-1 text-xs font-medium text-emerald-300 shadow-md backdrop-blur-md">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-ping" />
              Bikli is seeing this camera view
            </div>
          )}
        </div>

        {/* Footer controls */}
        <div className="flex items-center justify-between border-t border-cyan-500/10 bg-slate-900/40 px-4 py-2.5 text-xs text-slate-400">
          <span>Camera hardware active</span>
          <button
            onClick={onClose}
            className="rounded-lg bg-red-500/20 px-3 py-1 text-xs font-medium text-red-300 hover:bg-red-500/30 transition-colors border border-red-500/30"
          >
            Turn Off Camera
          </button>
        </div>
      </motion.div>
    </AnimatePresence>
  );
};
