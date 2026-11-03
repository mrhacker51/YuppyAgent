"use client";

import { useId, useRef } from "react";
import { motion } from "framer-motion";
import type { LucideIcon } from "lucide-react";

export interface SegmentedTabItem {
  id: string;
  label: string;
  icon?: LucideIcon;
  /** Small trailing hint — a count, a state word, a shortcut. */
  hint?: string;
  hintTone?: "lo" | "ok" | "warn" | "danger" | "accent";
  title?: string;
  disabled?: boolean;
}

const HINT_TONE: Record<NonNullable<SegmentedTabItem["hintTone"]>, string> = {
  lo: "text-text-lo",
  ok: "text-ok",
  warn: "text-warn",
  danger: "text-danger",
  accent: "text-accent",
};

/**
 * FancyUI's Tabs compound, distilled for the deck: one roving tabindex,
 * arrows / Home / End move focus, and a single shared `layoutId` makes the
 * indicator glide between triggers instead of snapping.
 *
 * `segmented` paints a raised pill behind the active trigger (used by the
 * module bar); the default underline variant sits on the rail's bottom edge
 * like a physical deck switch.
 */
export default function SegmentedTabs({
  items,
  value,
  onChange,
  ariaLabel,
  variant = "underline",
  className = "",
  itemClassName = "",
  grow = false,
}: {
  items: readonly SegmentedTabItem[];
  value: string;
  onChange: (id: string) => void;
  ariaLabel: string;
  variant?: "underline" | "segmented";
  className?: string;
  itemClassName?: string;
  /** Stretch triggers to share the rail width (module bar) instead of hugging. */
  grow?: boolean;
}) {
  const groupId = useId();
  const listRef = useRef<HTMLDivElement>(null);

  const move = (dir: 1 | -1 | "home" | "end") => {
    const enabled = items.filter((i) => !i.disabled);
    if (enabled.length === 0) return;
    const currentIndex = Math.max(
      0,
      enabled.findIndex((i) => i.id === value),
    );
    const nextIndex =
      dir === "home"
        ? 0
        : dir === "end"
          ? enabled.length - 1
          : (currentIndex + dir + enabled.length) % enabled.length;
    const next = enabled[nextIndex];
    onChange(next.id);
    const node = listRef.current?.querySelector<HTMLElement>(`[data-tab="${CSS.escape(next.id)}"]`);
    node?.focus();
  };

  return (
    <div
      ref={listRef}
      role="tablist"
      aria-label={ariaLabel}
      aria-orientation="horizontal"
      className={`flex min-w-0 items-stretch ${className}`}
      onKeyDown={(e) => {
        if (e.key === "ArrowRight" || e.key === "ArrowDown") {
          e.preventDefault();
          move(1);
        } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
          e.preventDefault();
          move(-1);
        } else if (e.key === "Home") {
          e.preventDefault();
          move("home");
        } else if (e.key === "End") {
          e.preventDefault();
          move("end");
        }
      }}
    >
      {items.map((item) => {
        const active = item.id === value;
        const Icon = item.icon;
        return (
          <button
            key={item.id}
            type="button"
            role="tab"
            data-tab={item.id}
            aria-selected={active}
            aria-label={item.title ?? item.label}
            title={item.title ?? item.label}
            disabled={item.disabled}
            tabIndex={active ? 0 : -1}
            onClick={() => onChange(item.id)}
            className={`relative flex shrink-0 items-center justify-center gap-1.5 px-2.5 text-[10.5px] tracking-[0.02em] transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent/60 disabled:cursor-not-allowed disabled:opacity-40 ${
              grow ? "flex-1" : ""
            } ${active ? "text-text-hi" : "text-text-mid hover:bg-bg-2/70 hover:text-text-hi"} ${itemClassName}`}
          >
            {variant === "segmented" && active && (
              <motion.span
                layoutId={`${groupId}-pill`}
                transition={{ type: "spring", stiffness: 480, damping: 38 }}
                className="absolute inset-[3px] rounded-[4px] border border-accent/35 bg-accent/[0.10]"
                aria-hidden
              />
            )}
            {Icon && (
              <Icon
                size={11}
                className={`relative shrink-0 ${active ? "text-accent" : "text-text-lo"}`}
                aria-hidden
              />
            )}
            <span className="relative whitespace-nowrap">{item.label}</span>
            {item.hint && (
              <span
                className={`relative shrink-0 font-mono text-[8px] tabular-nums ${
                  active ? "text-accent/90" : HINT_TONE[item.hintTone ?? "lo"]
                }`}
              >
                {item.hint}
              </span>
            )}
            {variant === "underline" && active && (
              <motion.span
                layoutId={`${groupId}-rail`}
                transition={{ type: "spring", stiffness: 460, damping: 36 }}
                className="absolute inset-x-0 bottom-0 h-[2px] bg-accent"
                aria-hidden
              />
            )}
          </button>
        );
      })}
    </div>
  );
}
