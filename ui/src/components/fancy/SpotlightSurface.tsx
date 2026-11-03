"use client";

import { useRef, type CSSProperties, type ReactNode } from "react";

/**
 * FancyUI-style pointer-reactive surface (CardSpotlight + GlowingEffect).
 *
 * The spotlight follows the pointer inside the panel and the border lights up
 * as the pointer approaches an edge. Both are painted from CSS custom
 * properties written straight to the node, so moving the mouse never
 * re-renders React — important on a board that can hold a dozen terminals.
 *
 * `as` renders the child first, so a card keeps its own semantics.
 */
export default function SpotlightSurface({
  children,
  className = "",
  accent = "94 234 212",
  size = 280,
  alpha = 0.1,
  border = false,
  as = "div",
  style,
}: {
  children?: ReactNode;
  className?: string;
  /** `"R G B"` — the surface glow colour. */
  accent?: string;
  /** Spot radius, in CSS pixels. */
  size?: number;
  /** Peak opacity of the spot. */
  alpha?: number;
  /** Light the border where the pointer gets close to it. */
  border?: boolean;
  as?: "div" | "section" | "article" | "li";
  style?: CSSProperties;
}) {
  const ref = useRef<HTMLElement | null>(null);

  const track = (e: React.PointerEvent<HTMLElement>) => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    el.style.setProperty("--fx-mx", `${x}px`);
    el.style.setProperty("--fx-my", `${y}px`);
    if (border) {
      // Distance to the nearest edge, normalised over a 90px approach band.
      const near = Math.min(x, rect.width - x, y, rect.height - y);
      const prox = Math.max(0, 1 - Math.max(0, near) / 90);
      el.style.setProperty("--fx-prox", prox.toFixed(3));
      el.style.setProperty("--fx-angle", `${(x / Math.max(1, rect.width)) * 360}deg`);
    }
  };

  const leave = () => {
    const el = ref.current;
    if (!el) return;
    el.style.setProperty("--fx-prox", "0");
    el.style.setProperty("--fx-mx", "50%");
    el.style.setProperty("--fx-my", "0%");
  };

  const Tag = as as "div";

  return (
    <Tag
      ref={ref as React.Ref<HTMLDivElement>}
      onPointerMove={track}
      onPointerLeave={leave}
      className={`fx-spot ${border ? "fx-spot--border" : ""} ${className}`}
      style={
        {
          "--fx-accent": accent,
          "--fx-size": `${size}px`,
          "--fx-alpha": String(alpha),
          ...style,
        } as CSSProperties
      }
    >
      <span className="fx-spot-layer" aria-hidden />
      {border && <span className="fx-glow-layer" aria-hidden />}
      {children}
    </Tag>
  );
}
