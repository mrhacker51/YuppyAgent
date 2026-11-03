"use client";

import { useEffect, useRef, useState } from "react";

/**
 * FancyUI's NumberTicker: counts to a new value on the frame clock instead of
 * swapping digits. Only the number animates — the surrounding label stays
 * selectable, and a value that never changes still renders immediately.
 */
export default function NumberTicker({
  value,
  duration = 620,
  className = "",
}: {
  value: number;
  duration?: number;
  className?: string;
}) {
  const [shown, setShown] = useState(value);
  const fromRef = useRef(value);
  const rafRef = useRef(0);

  useEffect(() => {
    const from = fromRef.current;
    if (from === value) return;
    const start = performance.now();
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / duration);
      // easeOutCubic — fast first frame, settled landing
      const eased = 1 - Math.pow(1 - t, 3);
      const next = Math.round(from + (value - from) * eased);
      setShown(next);
      if (t < 1) rafRef.current = requestAnimationFrame(tick);
      else fromRef.current = value;
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [value, duration]);

  useEffect(() => {
    fromRef.current = value;
  }, [value]);

  return (
    <span className={`tabular-nums ${className}`} aria-label={String(value)}>
      {shown}
    </span>
  );
}
