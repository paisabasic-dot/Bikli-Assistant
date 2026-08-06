import React, { useEffect, useRef } from "react";
import { LiveState } from "../lib/audio";

/**
 * Self-contained animated voice waveform.
 * Animates with its own requestAnimationFrame and writes bar heights
 * straight to the DOM refs — it never calls setState, so the surrounding
 * App does NOT re-render 20x/sec while live. That removes the biggest
 * source of main-thread jank during long / detailed conversations.
 */
const BASE_HEIGHTS = [12, 28, 16, 32, 20, 8];

export const LiveWaveform: React.FC<{ state: LiveState }> = ({ state }) => {
  const barRefs = useRef<(HTMLDivElement | null)[]>([]);

  useEffect(() => {
    let raf = 0;
    const started = performance.now();

    const step = (now: number) => {
      const tick = (now - started) / 1000; // seconds — cleaner than an unbounded counter

      barRefs.current.forEach((el, idx) => {
        if (!el) return;
        let heightFactor = 0.35;
        if (state === "speaking") {
          heightFactor = 0.35 + Math.sin(tick * 3.5 + idx * 0.9) * 0.65;
        } else if (state === "listening") {
          heightFactor = 0.2 + Math.sin(tick * 1.8 + idx * 0.5) * 0.4;
        } else {
          heightFactor = idx % 2 === 0 ? 0.25 : 0.12;
        }
        el.style.height = `${Math.max(3, BASE_HEIGHTS[idx] * Math.abs(heightFactor))}px`;
      });

      raf = requestAnimationFrame(step);
    };

    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [state]);

  const color =
    state === "speaking"
      ? "#c084fc"
      : state === "listening"
        ? "#22d3ee"
        : "rgba(255,255,255,0.10)";

  return (
    <div className="flex items-center justify-center gap-1 h-8 w-44">
      {BASE_HEIGHTS.map((bh, idx) => (
        <div
          key={idx}
          ref={(el) => {
            barRefs.current[idx] = el;
          }}
          className="w-0.5 rounded-full"
          style={{ backgroundColor: color, height: Math.min(bh, 8) }}
        />
      ))}
    </div>
  );
};