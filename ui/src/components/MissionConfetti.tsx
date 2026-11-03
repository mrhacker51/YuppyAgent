"use client";

import { useEffect, useRef } from "react";
import { useHudStore } from "@/lib/store";
import { FxPlayer, type FxModule } from "@/lib/pixelfx/player";
import * as confettiFx from "@/lib/pixelfx/fx/ui/confetti.js";

/**
 * Real pixelfx confetti when the lead's dispatch genuinely fans out: the
 * bridge reports two or more of the lead's tasks running at once. One-shot,
 * transparent overlay, pointer-events none — the effect mirrors a state
 * transition that really happened, it never fires on a timer.
 */
export const CONFETTI_SCALE = 3;

export function MissionConfetti() {
  const fanout = useHudStore((s) => {
    let running = 0;
    for (const t of Object.values(s.tasks)) {
      if (t.origin === "lead" && t.state === "running") running += 1;
    }
    return running >= 2;
  });
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rafRef = useRef(0);
  const prevFanout = useRef(false);

  useEffect(() => {
    const previous = prevFanout.current;
    prevFanout.current = fanout;
    if (!fanout || previous) return;

    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    cancelAnimationFrame(rafRef.current);
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    const player = new FxPlayer(
      confettiFx as unknown as FxModule,
      { seed: Math.floor(Date.now() / 1000) },
      200,
      140,
    );
    let last = performance.now();

    const frame = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      player.update(dt);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      if (!player.done()) {
        const w = 200 * CONFETTI_SCALE;
        const h = 140 * CONFETTI_SCALE;
        player.paint(
          ctx,
          0,
          0,
          200,
          140,
          Math.round((canvas.width - w) / 2),
          canvas.height - h,
          w,
          h,
          null,
        );
        rafRef.current = requestAnimationFrame(frame);
      } else {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
      }
    };
    rafRef.current = requestAnimationFrame(frame);

    return () => cancelAnimationFrame(rafRef.current);
  }, [fanout]);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden
      className="pointer-events-none fixed inset-0 z-[60]"
    />
  );
}
