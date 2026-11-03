"use client";

import type { ReactNode } from "react";
import { cn } from "fancy-ui-react";

/**
 * DeckPanel — the one surface language every module panel uses.
 *
 * Three layers, never more: a hairline frame, a glass body, and one optional
 * accent. `live` is the only state that gets a beam, so a screen full of idle
 * panels stays quiet and the operator's eye goes to work that is actually
 * running. No state is implied by colour alone: `label` and `meta` are text.
 */
export type PanelTone = "neutral" | "accent" | "struct" | "warn" | "danger";

const TONE_RING: Record<PanelTone, string> = {
  neutral: "border-line",
  accent: "border-accent/25",
  struct: "border-struct/25",
  warn: "border-warn/30",
  danger: "border-danger/30",
};

const TONE_TEXT: Record<PanelTone, string> = {
  neutral: "text-text-mid",
  accent: "text-accent",
  struct: "text-struct",
  warn: "text-warn",
  danger: "text-danger",
};

export function DeckPanel({
  label,
  icon,
  meta,
  actions,
  tone = "neutral",
  live = false,
  flush = false,
  className,
  bodyClassName,
  children,
}: {
  /** Panel title. Mono, uppercase, always visible. */
  label: string;
  icon?: ReactNode;
  /** Right-aligned factual meta (counts, ids) — plain text only. */
  meta?: ReactNode;
  actions?: ReactNode;
  tone?: PanelTone;
  /** True only while real work is running in this panel. */
  live?: boolean;
  /** Drop the body padding (terminals, feeds that own their scroll box). */
  flush?: boolean;
  className?: string;
  bodyClassName?: string;
  children: ReactNode;
}) {
  return (
    <section
      className={cn(
        "deck-surface group/panel relative flex min-h-0 min-w-0 flex-col overflow-hidden rounded-[10px] border backdrop-blur-[2px]",
        TONE_RING[tone],
        live && "deck-surface-live",
        className,
      )}
      data-live={live || undefined}
    >
      {/* Top-lit glass edge: one hairline of light, no glow soup. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/12 to-transparent"
      />
      {live && (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-6 top-0 h-px deck-live-beam"
        />
      )}
      <header className="deck-rail relative z-10 flex h-8 shrink-0 items-center gap-2 border-b border-line/70 px-2.5">
        {icon && <span className={cn("shrink-0", TONE_TEXT[tone])}>{icon}</span>}
        <h2 className="truncate font-mono text-[9px] font-semibold uppercase tracking-[0.18em] text-text-mid">
          {label}
        </h2>
        {live && (
          <span className="flex shrink-0 items-center gap-1 font-mono text-[8px] uppercase tracking-[0.14em] text-ok">
            <span className="size-1 animate-pulse rounded-full bg-ok" aria-hidden />
            canlı
          </span>
        )}
        <div className="ml-auto flex min-w-0 shrink-0 items-center gap-2">
          {meta && (
            <span className="truncate font-mono text-[8px] uppercase tracking-[0.12em] text-text-lo">
              {meta}
            </span>
          )}
          {actions}
        </div>
      </header>
      <div
        className={cn(
          "relative z-0 flex min-h-0 flex-1 flex-col",
          flush ? "" : "p-2.5",
          bodyClassName,
        )}
      >
        {children}
      </div>
    </section>
  );
}

/** A quiet inline chip for panel headers: label + value, no colour semantics. */
export function DeckStat({
  label,
  value,
  tone = "neutral",
}: {
  label: string;
  value: ReactNode;
  tone?: PanelTone;
}) {
  return (
    <span className="flex items-baseline gap-1 whitespace-nowrap font-mono text-[8px] uppercase tracking-[0.12em]">
      <span className="text-text-lo">{label}</span>
      <span className={cn("tabular-nums", TONE_TEXT[tone])}>{value}</span>
    </span>
  );
}

export default DeckPanel;
