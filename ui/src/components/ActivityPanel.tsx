"use client";

import { useEffect, useRef } from "react";
import { useHudStore } from "@/lib/store";
import PixelAvatar from "./pixel/PixelAvatar";
import Linkified from "./Linkified";
import DeckPanel, { DeckStat } from "./fancy/Panel";

const STATE_STYLES: Record<string, { dot: string; text: string }> = {
  queued: { dot: "bg-[var(--text-lo)]", text: "text-[var(--text-mid)]" },
  running: { dot: "bg-[var(--accent)] animate-pulse", text: "text-[var(--accent)]" },
  awaiting_approval: { dot: "bg-[var(--warn)] animate-pulse", text: "text-[var(--warn)]" },
  completed: { dot: "bg-[var(--ok)]", text: "text-[var(--ok)]" },
  failed: { dot: "bg-[var(--danger)]", text: "text-[var(--danger)]" },
  cancelled: { dot: "bg-[var(--text-lo)]", text: "text-[var(--text-lo)]" },
};

const LEVEL_STYLES: Record<string, { dot: string; text: string }> = {
  info: { dot: "bg-[var(--accent)]/70", text: "text-[var(--text-mid)]" },
  warn: { dot: "bg-[var(--warn)]", text: "text-[var(--warn)]" },
  error: { dot: "bg-[var(--danger)]", text: "text-[var(--danger)]" },
};

const LIVE_STATES = new Set(["queued", "running", "awaiting_approval"]);

/** Seed entries have ts=0 so server and client render the same label. */
function logTime(ts: number): string {
  return ts > 0 ? new Date(ts).toLocaleTimeString([], { hour12: false }) : "boot";
}

const SCROLLBAR_CLASSES =
  "[scrollbar-color:rgba(148,163,184,0.25)_transparent] [scrollbar-width:thin] " +
  "[&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar-track]:bg-transparent " +
  "[&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-[rgba(148,163,184,0.22)] " +
  "[&::-webkit-scrollbar-thumb:hover]:bg-[rgba(148,163,184,0.4)]";

/** Task states and bridge log stream — the mission's live heartbeat. */
export default function ActivityPanel() {
  const tasks = useHudStore((s) => s.tasks);
  const logs = useHudStore((s) => s.logs);
  const clearLogs = useHudStore((s) => s.clearLogs);
  const send = useHudStore((s) => s.send);
  const listRef = useRef<HTMLUListElement>(null);
  // Auto-scroll only while pinned to the bottom, so scrolling back through
  // history is not yanked away by new events.
  const stickToBottomRef = useRef(true);

  const taskList = Object.values(tasks)
    .slice(-12)
    .reverse();
  const liveTasks = Object.values(tasks).filter((t) => LIVE_STATES.has(t.state)).length;

  useEffect(() => {
    const el = listRef.current;
    if (el && stickToBottomRef.current) el.scrollTop = el.scrollHeight;
  }, [logs]);

  const onLogsScroll = () => {
    const el = listRef.current;
    if (!el) return;
    stickToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 32;
  };

  return (
    <DeckPanel
      label="Etkinlik"
      icon={
        <span
          className={`size-1.5 rounded-full ${liveTasks > 0 ? "bg-ok deck-live" : "bg-text-lo/50"}`}
          aria-hidden
        />
      }
      meta={
        <span className="flex items-center gap-2">
          <DeckStat label="görev" value={Object.keys(tasks).length} />
          <DeckStat label="canlı" value={liveTasks} tone={liveTasks > 0 ? "accent" : "neutral"} />
        </span>
      }
      tone={liveTasks > 0 ? "accent" : "neutral"}
      live={liveTasks > 0}
      flush
      className="min-h-0 flex-1"
      bodyClassName="min-h-0"
      actions={
        <button
          type="button"
          onClick={clearLogs}
          className="rounded-[4px] border border-line px-1 py-px font-mono text-[8px] uppercase tracking-wider text-text-lo transition-colors hover:border-line-strong hover:text-text-mid focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/50"
        >
          temizle
        </button>
      }
    >

      {taskList.length > 0 && (
        <ul className="border-b border-[var(--line)] bg-[var(--bg-0)]/30">
          {taskList.map((t) => {
            const style = STATE_STYLES[t.state] ?? {
              dot: "bg-[var(--text-lo)]",
              text: "text-[var(--text-mid)]",
            };
            return (
              <li
                key={t.id}
                className="flex items-center gap-2 border-b border-[var(--line)]/50 px-3 py-1 font-mono text-xs last:border-b-0"
              >
                <span className={`size-1.5 shrink-0 rounded-full ${style.dot}`} aria-hidden />
                <span className={`w-32 shrink-0 truncate uppercase tracking-wider ${style.text}`}>
                  {t.state}
                </span>
                <span className="truncate text-[var(--text-mid)]" title={t.detail ?? t.id}>
                  {t.title ?? t.id}
                </span>
                <span className="ml-auto shrink-0 truncate pl-2 text-[10px] text-[var(--text-lo)]/70">
                  {t.id}
                </span>
                {LIVE_STATES.has(t.state) && (
                  <button
                    type="button"
                    onClick={() => send({ type: "task_cancel", task_id: t.id })}
                    className="shrink-0 rounded border border-[var(--danger)]/40 px-1.5 py-px text-[10px] text-[var(--danger)] transition-colors hover:bg-[var(--danger)]/10 focus-visible:outline-1 focus-visible:outline-[var(--danger)]"
                  >
                    cancel
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <ul
        ref={listRef}
        onScroll={onLogsScroll}
        className={`max-h-56 min-h-24 flex-1 overflow-y-auto px-3 py-1.5 font-mono ${SCROLLBAR_CLASSES}`}
        aria-live="polite"
      >
        {logs.map((l) => {
          const style = LEVEL_STYLES[l.level] ?? LEVEL_STYLES.info;
          return (
            <li key={l.id} className="flex items-start gap-2 py-0.5 text-xs leading-relaxed">
              <span className="shrink-0 pt-px text-[10px] tabular-nums text-[var(--text-lo)]">
                {logTime(l.ts)}
              </span>
              <PixelAvatar seed={l.message.slice(0, 24)} size={18} className="mt-0.5" />
              <span className={`min-w-0 break-words whitespace-pre-wrap ${style.text}`}>
                <Linkified>{l.message}</Linkified>
              </span>
            </li>
          );
        })}
      </ul>
    </DeckPanel>
  );
}
