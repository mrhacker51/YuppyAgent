import type { ReactNode } from "react";
import { DeckPanel } from "../fancy/Panel";

/** Shared chrome and primitives for the full-page module views. */

/**
 * The module frame. Every full-page view sits in one DeckPanel: a single
 * hairline frame, a mono label, a one-line factual meta and an actions rail.
 * Nothing here implies state; panels only light up when they carry real work.
 */
export function ViewShell({
  title,
  kicker,
  right,
  children,
  footer,
}: {
  title: string;
  kicker?: string;
  right?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <DeckPanel
      label={title}
      meta={kicker}
      actions={right}
      flush
      className="h-full min-h-0"
      bodyClassName="min-h-0"
    >
      <div className="thin-scroll min-h-0 flex-1 overflow-y-auto">{children}</div>
      {footer && (
        <footer className="flex h-6 shrink-0 items-center gap-2 border-t border-line bg-bg-1/85 px-2.5 font-mono text-[8px] uppercase tracking-wider text-text-lo">
          {footer}
        </footer>
      )}
    </DeckPanel>
  );
}

/**
 * A module card built on the same DeckPanel surface, so dense views share one
 * frame language. `spotlight`/`accent` stay in the signature for console
 * callers that still pass them; the deck does not paint extra rings.
 */
export function Card({
  title,
  sub,
  right,
  children,
  className = "",
}: {
  title: string;
  sub?: string;
  right?: ReactNode;
  children: ReactNode;
  className?: string;
  accent?: string;
  spotlight?: boolean;
}) {
  return (
    <DeckPanel
      label={title}
      meta={sub}
      actions={right}
      flush
      className={`min-h-0 ${className}`}
      bodyClassName="min-h-0"
    >
      {children}
    </DeckPanel>
  );
}

export function Stat({
  label,
  value,
  tone = "default",
  hint,
}: {
  label: string;
  value: ReactNode;
  tone?: "default" | "ok" | "warn" | "danger" | "accent";
  hint?: string;
}) {
  const toneClass =
    tone === "ok"
      ? "text-ok"
      : tone === "warn"
        ? "text-warn"
        : tone === "danger"
          ? "text-danger"
          : tone === "accent"
            ? "text-accent"
            : "text-text-hi";
  return (
    <div className="deck-surface flex min-w-0 flex-col rounded-[10px] border border-line bg-bg-1/45 px-2.5 py-2">
      <div className="truncate font-mono text-[8px] uppercase tracking-[0.14em] text-text-lo">
        {label}
      </div>
      <div className={`mt-1 font-mono text-[19px] leading-none tabular-nums ${toneClass}`}>
        {value}
      </div>
      {hint && <div className="mt-1 truncate font-mono text-[8px] text-text-lo/70">{hint}</div>}
    </div>
  );
}

export function EmptyState({
  children,
  action,
}: {
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex min-h-[120px] flex-col items-center justify-center gap-2 rounded-[4px] border border-dashed border-line px-4 py-6 text-center">
      <p className="max-w-md font-mono text-[9px] uppercase leading-relaxed tracking-[0.16em] text-text-lo">
        {children}
      </p>
      {action}
    </div>
  );
}

export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`
    : `${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
}

export const TASK_TONE: Record<string, "ok" | "warn" | "danger" | "accent" | "default"> = {
  queued: "default",
  running: "ok",
  awaiting_approval: "warn",
  completed: "accent",
  failed: "danger",
  cancelled: "default",
};

export function TaskBadge({ state }: { state: string }) {
  const tone = TASK_TONE[state] ?? "default";
  const cls =
    tone === "ok"
      ? "border-ok/30 bg-ok/[0.06] text-ok"
      : tone === "warn"
        ? "border-warn/30 bg-warn/[0.06] text-warn"
        : tone === "danger"
          ? "border-danger/30 bg-danger/[0.06] text-danger"
          : tone === "accent"
            ? "border-accent/30 bg-accent/[0.06] text-accent"
            : "border-line bg-bg-2 text-text-mid";
  return (
    <span
      className={`inline-flex items-center gap-1 border px-1 py-px font-mono text-[8px] uppercase tracking-wider ${cls}`}
    >
      <span
        className={`size-1 rounded-full ${
          tone === "ok"
            ? "bg-ok"
            : tone === "warn"
              ? "bg-warn"
              : tone === "danger"
                ? "bg-danger"
                : tone === "accent"
                  ? "bg-accent"
                  : "bg-text-lo"
        }`}
        aria-hidden
      />
      {state}
    </span>
  );
}

/**
 * Aim the main command window (the lead Claude terminal) from anywhere.
 *
 * The lead terminal lives in AgentSpace, which may not be mounted when a
 * launcher is pressed (Team view, Skills, Tasks, ⌘K). So the target is parked
 * here and the event still fires, letting an already-mounted terminal react
 * immediately while a fresh one drains the pending value on mount.
 */
let pendingCommandTarget: { cli?: string; department?: string } | null = null;

export function takePendingCommandTarget(): { cli?: string; department?: string } | null {
  const detail = pendingCommandTarget;
  pendingCommandTarget = null;
  return detail;
}

export function dispatchCommandTarget(cli: string | undefined, department: string | undefined) {
  pendingCommandTarget = { cli, department };
  window.dispatchEvent(
    new CustomEvent("yuppy:command-target", { detail: { cli, department } }),
  );
}
