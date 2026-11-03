"use client";

import { useRef } from "react";

/**
 * The deck's resize grip. One component serves every splitter so pointer,
 * touch and keyboard behaviour are identical everywhere:
 *
 *   • drag with mouse / pen / touch (pointer capture, so the drag survives the
 *     pointer leaving the 9px grip),
 *   • arrow keys nudge it, Home or double-click resets it,
 *   • `role="separator"` with live `aria-valuenow` for assistive tech.
 *
 * It is deliberately dumb: it reports *incremental pixel deltas* and lets the
 * owner turn those into a ratio, a height or a set of grid weights.
 */
export interface SplitSashProps {
  /** `vertical` = a vertical bar you drag left/right (col-resize). */
  orientation: "vertical" | "horizontal";
  label: string;
  /** Reported to assistive tech; the owner owns the units. */
  valueNow: number;
  valueMin: number;
  valueMax: number;
  /** Incremental delta (px) since the previous event. */
  onDelta: (deltaPx: number) => void;
  /** Fired when the drag ends or a key nudge is applied. */
  onCommit?: () => void;
  onReset?: () => void;
  keyboardStepPx?: number;
  className?: string;
}

export default function SplitSash({
  orientation,
  label,
  valueNow,
  valueMin,
  valueMax,
  onDelta,
  onCommit,
  onReset,
  keyboardStepPx = 24,
  className = "",
}: SplitSashProps) {
  const last = useRef<number | null>(null);
  const axis = (e: { clientX: number; clientY: number }) =>
    orientation === "vertical" ? e.clientX : e.clientY;

  return (
    <div
      role="separator"
      aria-orientation={orientation}
      aria-label={label}
      aria-valuenow={Math.round(valueNow)}
      aria-valuemin={Math.round(valueMin)}
      aria-valuemax={Math.round(valueMax)}
      tabIndex={0}
      title={`${label} — sürükle, ok tuşları ile ince ayar, çift tıkla sıfırla`}
      onPointerDown={(e) => {
        if (e.pointerType === "mouse" && e.button !== 0) return;
        last.current = axis(e);
        e.currentTarget.setPointerCapture?.(e.pointerId);
        e.stopPropagation();
      }}
      onPointerMove={(e) => {
        if (last.current === null) return;
        const value = axis(e);
        const delta = value - last.current;
        if (delta === 0) return;
        last.current = value;
        onDelta(delta);
      }}
      onPointerUp={(e) => {
        if (last.current === null) return;
        last.current = null;
        try {
          e.currentTarget.releasePointerCapture(e.pointerId);
        } catch {
          // capture is already gone; the drag is over either way
        }
        onCommit?.();
      }}
      onPointerCancel={() => {
        last.current = null;
        onCommit?.();
      }}
      onDoubleClick={() => onReset?.()}
      onKeyDown={(e) => {
        const back = orientation === "vertical" ? "ArrowLeft" : "ArrowUp";
        const forth = orientation === "vertical" ? "ArrowRight" : "ArrowDown";
        const dir = e.key === forth ? 1 : e.key === back ? -1 : 0;
        if (dir !== 0) {
          e.preventDefault();
          onDelta(dir * keyboardStepPx);
          onCommit?.();
          return;
        }
        if (e.key === "Home") {
          e.preventDefault();
          onReset?.();
        }
      }}
      className={`group z-20 shrink-0 touch-none select-none focus-visible:outline-none ${
        className.includes("absolute") ? "" : "relative"
      } ${
        orientation === "vertical" ? "cursor-col-resize" : "cursor-row-resize"
      } ${className}`}
    >
      <span
        aria-hidden
        className={`pointer-events-none absolute bg-line transition-colors group-hover:bg-accent/70 group-focus-visible:bg-accent ${
          orientation === "vertical"
            ? "inset-y-0 left-1/2 w-px -translate-x-1/2"
            : "inset-x-0 top-1/2 h-px -translate-y-1/2"
        }`}
      />
      <span
        aria-hidden
        className={`pointer-events-none absolute grid place-items-center text-[7px] leading-none text-text-lo opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100 ${
          orientation === "vertical" ? "inset-y-0 left-1/2 -translate-x-1/2" : "inset-x-0 top-1/2 -translate-y-1/2"
        }`}
      >
        {orientation === "vertical" ? "↔" : "↕"}
      </span>
    </div>
  );
}
