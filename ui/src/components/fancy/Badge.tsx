"use client";

import type { HTMLAttributes, ReactNode } from "react";

export type BadgeTone =
  | "outline"
  | "muted"
  | "accent"
  | "struct"
  | "ok"
  | "warn"
  | "danger";

const TONE: Record<BadgeTone, string> = {
  outline: "border-line text-text-mid",
  muted: "border-transparent bg-bg-2 text-text-lo",
  accent: "border-accent/35 bg-accent/10 text-accent",
  struct: "border-struct/35 bg-struct/10 text-struct",
  ok: "border-ok/30 bg-ok/10 text-ok",
  warn: "border-warn/30 bg-warn/10 text-warn",
  danger: "border-danger/30 bg-danger/10 text-danger",
};

/**
 * FancyUI's Badge: one pill, one token pair. Colour never carries the message
 * alone — every badge in the deck also renders a word.
 */
export default function Badge({
  tone = "outline",
  size = "md",
  icon,
  children,
  className = "",
  ...rest
}: HTMLAttributes<HTMLSpanElement> & {
  tone?: BadgeTone;
  size?: "sm" | "md";
  icon?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <span
      {...rest}
      data-tone={tone}
      className={`inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-[3px] border font-mono uppercase tracking-[0.1em] ${TONE[tone]} ${
        size === "sm" ? "px-1 py-px text-[7px]" : "px-1.5 py-0.5 text-[8px]"
      } ${className}`}
    >
      {icon}
      {children}
    </span>
  );
}
