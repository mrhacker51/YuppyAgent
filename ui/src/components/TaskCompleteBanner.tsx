"use client";

import { useEffect, useRef, useState } from "react";
import { useHudStore, type Task } from "@/lib/store";
import { newlyCompleted, type CompletedTask } from "@/lib/taskCompletion";
import { FxPlayer, type FxModule } from "@/lib/pixelfx/player";
import * as questFx from "@/lib/pixelfx/fx/ui/quest-complete.js";

const SCALE = 3;
const NATIVE_W = 204;
const NATIVE_H = 92;

/**
 * A pixelfx banner when a task really finishes. Each queued completion plays
 * once, three at most, and only for transitions witnessed during this session
 * (see `newlyCompleted`). The label is the task's own title, not a placeholder.
 */
export function TaskCompleteBanner() {
  const tasks = useHudStore((s) => s.tasks);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [queue, setQueue] = useState<CompletedTask[]>([]);
  const seenRef = useRef<Record<string, Task>>({});

  useEffect(() => {
    const prev = seenRef.current;
    const fresh = newlyCompleted(prev, tasks);
    seenRef.current = tasks;
    if (fresh.length === 0) return;
    setQueue((q) => [...q, ...fresh].slice(-3));
  }, [tasks]);

  const current = queue[0];

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !current) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    canvas.width = NATIVE_W * SCALE;
    canvas.height = NATIVE_H * SCALE;

    const player = new FxPlayer(
      questFx as unknown as FxModule,
      {
        // The effect ships English micro-copy; the deck speaks Turkish. The
        // font is a 7px ASCII bitmap, so no diacritics.
        text: "GOREV TAMAM",
        seed: current.id.length + current.id.charCodeAt(current.id.length - 1),
      },
      NATIVE_W,
      NATIVE_H,
    );
    let last = performance.now();
    let raf = 0;
    const frame = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      player.update(dt);
      if (player.done()) {
        setQueue((q) => q.slice(1));
        return;
      }
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      player.paint(
        ctx,
        0,
        0,
        NATIVE_W,
        NATIVE_H,
        0,
        0,
        canvas.width,
        canvas.height,
        null,
      );
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [current]);

  return (
    <div
      aria-live="polite"
      className="pointer-events-none fixed bottom-16 right-4 z-[55] flex flex-col items-end gap-1"
    >
      {current && (
        <div className="deck-panel overflow-hidden border-accent/30 bg-bg-0/85">
          <canvas
            ref={canvasRef}
            width={NATIVE_W * SCALE}
            height={NATIVE_H * SCALE}
            className="block h-[69px] w-[153px] [image-rendering:pixelated]"
            role="img"
            aria-label={`Görev tamamlandı: ${current.title}`}
          />
          <p className="max-w-[153px] truncate border-t border-line px-1.5 py-0.5 font-mono text-[8px] text-text-mid">
            {current.title}
          </p>
        </div>
      )}
      {queue.length > 1 && (
        <span className="font-mono text-[8px] text-text-lo">+{queue.length - 1} tamamlanan</span>
      )}
    </div>
  );
}
