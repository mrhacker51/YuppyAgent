"use client";

import { useEffect, useRef, useState } from "react";
import { Activity, ListChecks, MessagesSquare } from "lucide-react";
import { Tabs, TabsList, TabsTrigger } from "fancy-ui-react";
import { useHudStore } from "@/lib/store";
import PixelAvatar from "./pixel/PixelAvatar";
import Linkified from "./Linkified";
import DeckPanel, { DeckStat } from "./fancy/Panel";

const LIVE_STATES = new Set(["queued", "running", "awaiting_approval"]);

const STATE_STYLES: Record<string, { dot: string; text: string }> = {
  queued: { dot: "bg-text-lo", text: "text-text-mid" },
  running: { dot: "bg-ok", text: "text-ok" },
  awaiting_approval: { dot: "bg-warn", text: "text-warn" },
  completed: { dot: "bg-accent", text: "text-accent" },
  failed: { dot: "bg-danger", text: "text-danger" },
  cancelled: { dot: "bg-text-lo/60", text: "text-text-lo" },
};

const LEVEL_STYLES: Record<string, { dot: string; text: string }> = {
  info: { dot: "bg-accent/60", text: "text-text-mid" },
  warn: { dot: "bg-warn", text: "text-warn" },
  error: { dot: "bg-danger", text: "text-danger" },
};

/** Seed entries have ts=0 so the SSR HTML and hydration agree. */
function logTime(ts: number): string {
  return ts > 0 ? new Date(ts).toLocaleTimeString([], { hour12: false }) : "boot";
}

type FeedTab = "team" | "activity" | "tasks";

/**
 * The team feed under the map. "Ekip" is the real team bus: every
 * `yuppy_send` the bridge streams, sender → recipient, verbatim. "Akış" is
 * bridge events; "Görevler" is the real task queue. There is no chat endpoint
 * beyond the bus, so nothing here is invented.
 */
export default function TeamFeed() {
  const logs = useHudStore((s) => s.logs);
  const tasks = useHudStore((s) => s.tasks);
  const teamMessages = useHudStore((s) => s.teamMessages);
  const clearLogs = useHudStore((s) => s.clearLogs);
  const send = useHudStore((s) => s.send);

  const [tab, setTab] = useState<FeedTab>("team");
  const listRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);

  const taskList = Object.values(tasks).reverse().slice(0, 60);
  let liveTasks = 0;
  for (const t of Object.values(tasks)) if (LIVE_STATES.has(t.state)) liveTasks += 1;
  const messages = [...teamMessages].reverse();

  useEffect(() => {
    const el = listRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [logs, teamMessages, tab]);

  const onScroll = () => {
    const el = listRef.current;
    if (!el) return;
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
  };

  return (
    <DeckPanel
      label="Takım akışı"
      icon={<MessagesSquare size={10} className="text-accent" aria-hidden />}
      meta={
        <span className="flex items-center gap-2">
          <DeckStat label="mesaj" value={teamMessages.length} tone={teamMessages.length > 0 ? "accent" : "neutral"} />
          <DeckStat label="canlı" value={liveTasks} tone={liveTasks > 0 ? "accent" : "neutral"} />
        </span>
      }
      tone={teamMessages.length > 0 ? "accent" : "neutral"}
      flush
      className="h-[232px] shrink-0"
      bodyClassName="min-h-0"
      actions={
        tab === "activity" ? (
          <button
            type="button"
            onClick={clearLogs}
            className="rounded-[4px] border border-line px-1 py-px font-mono text-[8px] uppercase tracking-wider text-text-lo transition-colors hover:border-line-strong hover:text-text-mid focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/50"
          >
            temizle
          </button>
        ) : undefined
      }
    >
      <Tabs
        value={tab}
        onValueChange={(value) => setTab(value as FeedTab)}
        variant="underline"
        activation="automatic"
        className="shrink-0 border-b border-line/70 bg-bg-1/30"
      >
        <TabsList className="!h-6 !gap-0 !border-0 !bg-transparent !p-0">
          <TabsTrigger
            value="team"
            className="!h-6 !rounded-none !px-2 font-mono !text-[8.5px] uppercase tracking-[0.14em]"
          >
            <MessagesSquare size={9} aria-hidden /> ekip
            <span className="ml-1 border border-line px-1 text-[8px] tabular-nums text-text-lo">
              {teamMessages.length}
            </span>
          </TabsTrigger>
          <TabsTrigger
            value="activity"
            className="!h-6 !rounded-none !px-2 font-mono !text-[8.5px] uppercase tracking-[0.14em]"
          >
            <Activity size={9} aria-hidden /> akış
          </TabsTrigger>
          <TabsTrigger
            value="tasks"
            className="!h-6 !rounded-none !px-2 font-mono !text-[8.5px] uppercase tracking-[0.14em]"
          >
            <ListChecks size={9} aria-hidden /> görevler
            <span className="ml-1 border border-line px-1 text-[8px] tabular-nums text-text-lo">
              {Object.keys(tasks).length}
            </span>
            {liveTasks > 0 && (
              <span className="ml-1 border border-ok/30 bg-ok/[0.06] px-1 text-[8px] tabular-nums text-ok">
                {liveTasks}
              </span>
            )}
          </TabsTrigger>
        </TabsList>
      </Tabs>

      <div
        ref={listRef}
        onScroll={onScroll}
        className="thin-scroll min-h-0 flex-1 overflow-y-auto px-2 py-1 font-mono"
        aria-live="polite"
      >
        {tab === "team" ? (
          messages.length === 0 ? (
            <p className="px-1 py-3 text-[9px] text-text-lo">henüz takım mesajı yok.</p>
          ) : (
            messages.map((m) => (
              <div
                key={m.id}
                className="deck-row flex items-start gap-1.5 border-b border-line/40 px-1 py-1 text-[9px] leading-[1.45] last:border-b-0"
              >
                <span className="shrink-0 tabular-nums text-[8px] text-text-lo/70">
                  {logTime(m.ts)}
                </span>
                <PixelAvatar seed={m.sender} size={18} className="mt-[1px]" />
                <span className="min-w-0 flex-1">
                  <span className="flex items-baseline gap-1">
                    <span className="truncate text-text-hi">{m.sender}</span>
                    <span className="shrink-0 text-text-lo" aria-label="şu kişiye">
                      →
                    </span>
                    <span className="shrink-0 text-accent">
                      {m.recipient === "*" ? "herkes" : m.recipient}
                    </span>
                  </span>
                  <span className="mt-0.5 block whitespace-pre-wrap break-words text-text-mid">
                    {m.body}
                  </span>
                </span>
              </div>
            ))
          )
        ) : tab === "activity" ? (
          logs.length === 0 ? (
            <p className="px-1 py-3 text-[9px] text-text-lo">Henüz bridge olayı yok.</p>
          ) : (
            logs.map((l, index) => {
              const style = LEVEL_STYLES[l.level] ?? LEVEL_STYLES.info;
              return (
                <div
                  key={l.id}
                  className="deck-enter deck-row flex items-start gap-1.5 px-1 py-0.5 text-[9px] leading-[1.5]"
                  style={{ animationDelay: `${Math.min(index, 10) * 30}ms` }}
                >
                  <span className="shrink-0 tabular-nums text-[8px] text-text-lo/70">
                    {logTime(l.ts)}
                  </span>
                  <PixelAvatar seed={l.message.slice(0, 24)} size={20} className="mt-[1px]" />
                  <span className={`min-w-0 whitespace-pre-wrap break-words ${style.text}`}>
                    <Linkified>{l.message}</Linkified>
                  </span>
                </div>
              );
            })
          )
        ) : taskList.length === 0 ? (
          <p className="px-1 py-3 text-[9px] text-text-lo">
            Henüz görev yok — lead Claude&apos;a bir iş ver.
          </p>
        ) : (
          taskList.map((t, index) => {
            const style = STATE_STYLES[t.state] ?? STATE_STYLES.queued;
            return (
              <div
                key={t.id}
                className="deck-enter deck-row flex items-center gap-1.5 border-b border-line/40 px-1 py-1 text-[9px] last:border-b-0"
                data-active={LIVE_STATES.has(t.state)}
                style={{ animationDelay: `${Math.min(index, 10) * 30}ms` }}
              >
                <span
                  className={`size-1.5 shrink-0 rounded-full ${style.dot} ${
                    LIVE_STATES.has(t.state) ? "deck-live" : ""
                  }`}
                  aria-hidden
                />
                <span className={`w-[72px] shrink-0 uppercase tracking-wider ${style.text}`}>
                  {t.state}
                </span>
                <span className="min-w-0 flex-1 truncate text-text-mid" title={t.detail ?? t.id}>
                  {t.title ?? t.id}
                </span>
                {t.cli && (
                  <span className="hidden shrink-0 font-mono text-[8px] text-text-lo sm:inline">
                    {t.cli}
                  </span>
                )}
                <span className="shrink-0 font-mono text-[8px] text-text-lo/60">
                  {t.id.slice(-8)}
                </span>
                {LIVE_STATES.has(t.state) && (
                  <button
                    type="button"
                    onClick={() => send({ type: "task_cancel", task_id: t.id })}
                    className="shrink-0 border border-danger/30 px-1 py-px text-[8px] text-danger transition-colors hover:border-danger/60 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-danger/50"
                  >
                    iptal
                  </button>
                )}
              </div>
            );
          })
        )}
      </div>
    </DeckPanel>
  );
}
