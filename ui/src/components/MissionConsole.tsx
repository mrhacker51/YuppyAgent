"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { GitBranch, ListChecks, MessagesSquare, TriangleAlert, Users } from "lucide-react";
import { Badge, ChatMessage, Tabs, TabsList, TabsTrigger, TypingIndicator } from "fancy-ui-react";
import { useHudStore } from "@/lib/store";
import { agentShortName } from "@/lib/agents";
import { DeckPanel } from "./fancy/Panel";
import AgentActivity, { type FeedItem } from "./fancy/AgentActivity";
import LiveTaskBoard from "./fancy/LiveTaskBoard";

const LIVE_STATES = new Set(["queued", "running", "awaiting_approval"]);

const STATE_STYLES: Record<string, { dot: string; text: string }> = {
  queued: { dot: "bg-text-lo", text: "text-text-mid" },
  running: { dot: "bg-ok", text: "text-ok" },
  awaiting_approval: { dot: "bg-warn", text: "text-warn" },
  completed: { dot: "bg-accent", text: "text-accent" },
  failed: { dot: "bg-danger", text: "text-danger" },
  cancelled: { dot: "bg-text-lo/60", text: "text-text-lo" },
};

const STATE_LABEL: Record<string, string> = {
  queued: "sırada",
  running: "çalışıyor",
  awaiting_approval: "onay bekliyor",
  completed: "bitti",
  failed: "hata",
  cancelled: "iptal",
};

type ConsoleTab = "feed" | "tasks" | "team";

/**
 * Ana komut konsolu — the information panel. Commanding happens in the lead
 * Claude terminal (the main command window); this panel only reports what
 * really happened: bridge log lines, every task transition per agent (Claude
 * and Codex side by side when the lead fans out), the team-bus transcript,
 * worktree integrations and conflicts. It has no prompt input on purpose.
 */
export default function MissionConsole() {
  const logs = useHudStore((s) => s.logs);
  const tasks = useHudStore((s) => s.tasks);
  const speech = useHudStore((s) => s.speech);
  const teamMessages = useHudStore((s) => s.teamMessages);
  const integrations = useHudStore((s) => s.integrations);
  const conflicts = useHudStore((s) => s.conflicts);
  const leadSessionId = useHudStore((s) => s.leadSessionId);
  const send = useHudStore((s) => s.send);
  const clearLogs = useHudStore((s) => s.clearLogs);

  const [tab, setTab] = useState<ConsoleTab>("feed");
  const listRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);

  const taskList = useMemo(() => Object.values(tasks).reverse().slice(0, 80), [tasks]);
  const liveTasks = useMemo(
    () => Object.values(tasks).filter((t) => LIVE_STATES.has(t.state)).length,
    [tasks],
  );
  /** Running tasks per executor — the parallelism the lead actually got. */
  const runningByCli = useMemo(() => {
    const out = new Map<string, number>();
    for (const t of Object.values(tasks)) {
      if (t.state !== "running") continue;
      const key = t.cli ? agentShortName(t.cli) : "ajan ?";
      out.set(key, (out.get(key) ?? 0) + 1);
    }
    return [...out.entries()];
  }, [tasks]);
  const runningTotal = runningByCli.reduce((sum, [, n]) => sum + n, 0);

  /** Feed: bridge events (incl. task transitions), team bus, worker seat
   * lines. The lead's own screen is already the main window, so its PTY
   * lines are not echoed here. */
  const feed = useMemo<FeedItem[]>(() => {
    const items: FeedItem[] = [
      ...logs.map((l, i) => ({ kind: "log" as const, key: l.id, ts: l.ts || i, entry: l })),
      ...teamMessages.map((m) => ({ kind: "bus" as const, key: `bus-${m.id}`, ts: m.ts, message: m })),
      ...speech
        .filter((sp) => !leadSessionId || !sp.id.startsWith(`${leadSessionId}.`))
        .map((sp) => ({ kind: "speech" as const, key: sp.id, ts: sp.ts, speech: sp })),
    ];
    return items.sort((a, b) => a.ts - b.ts).slice(-200);
  }, [logs, speech, teamMessages, leadSessionId]);

  useEffect(() => {
    const el = listRef.current;
    if (el && stickRef.current) el.scrollTop = el.scrollHeight;
  }, [feed, tab]);

  const onScroll = () => {
    const el = listRef.current;
    if (!el) return;
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
  };

  // A beam only where work is genuinely running.
  const live = runningTotal > 0;

  return (
    <DeckPanel
      label="ana konsol · bilgi"
      icon={<MessagesSquare size={10} aria-hidden />}
      live={live}
      tone={conflicts.length > 0 ? "warn" : "neutral"}
      flush
      className="h-full min-h-0"
      bodyClassName="min-h-0"
      meta={
        runningByCli.length > 0
          ? runningByCli.map(([cli, n]) => `${cli} ×${n}`).join(" · ")
          : "salt okunur · komut lead terminalinde"
      }
      actions={
        <span className="flex items-center gap-1">
          {liveTasks > 0 && (
            <Badge variant="success" size="sm">
              {liveTasks} canlı
            </Badge>
          )}
          <button
            type="button"
            onClick={() => {
              useHudStore.setState({ speech: [] });
              clearLogs();
            }}
            className="rounded-[6px] border border-line px-1.5 py-0.5 font-mono text-[8px] uppercase tracking-wider text-text-lo transition-colors hover:border-line-strong hover:text-text-mid focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/50"
          >
            temizle
          </button>
        </span>
      }
    >
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex shrink-0 items-center gap-2 border-b border-line/70 px-2 py-1">
          <Tabs value={tab} onValueChange={(value) => setTab(value as ConsoleTab)} variant="segmented">
            <TabsList className="border-line bg-bg-0/40">
              <TabsTrigger value="feed" className="gap-1 px-2 py-[3px] text-[9px]">
                <MessagesSquare size={8} aria-hidden />
                akış
              </TabsTrigger>
              <TabsTrigger value="tasks" className="gap-1 px-2 py-[3px] text-[9px]">
                <ListChecks size={8} aria-hidden />
                görevler
                <span className="font-mono text-[8px] tabular-nums opacity-70">
                  {Object.keys(tasks).length}
                </span>
              </TabsTrigger>
              <TabsTrigger value="team" className="gap-1 px-2 py-[3px] text-[9px]">
                <Users size={8} aria-hidden />
                ekip
              </TabsTrigger>
            </TabsList>
          </Tabs>
          <span className="ml-auto hidden truncate font-mono text-[8px] uppercase tracking-[0.12em] text-text-lo sm:inline">
            {tab === "feed"
              ? "köprü · görev durumları · veriyolu"
              : tab === "tasks"
                ? "gerçek görev kuyruğu · entegrasyon"
                : "ekip · canlı durum"}
          </span>
        </div>

        {/* `@container`: whether the Ekip rail fits depends on the console's
            own width, not the viewport — the deck split can squeeze it. */}
        <div className="@container flex min-h-0 flex-1">
          <div
            ref={listRef}
            onScroll={onScroll}
            className="thin-scroll min-h-0 min-w-0 flex-1 overflow-y-auto px-2 py-1 font-mono"
            aria-live="polite"
          >
            {tab === "feed" ? (
              feed.length === 0 ? (
                <p className="px-1 py-3 text-[9px] text-text-lo">
                  Akış boş — lead Claude&apos;a bir iş verince görev durumları ve köprü olayları burada.
                </p>
              ) : (
                <>
                  {feed.map((item, index) => (
                    <AgentActivity key={item.key} item={item} index={index} />
                  ))}
                  {runningTotal > 0 && (
                    <ChatMessage
                      role="system"
                      sound={false}
                      className="mb-1 !gap-1.5"
                      footer={
                        <span className="font-mono text-[7px] uppercase tracking-[0.12em] text-text-lo/80">
                          {runningByCli.map(([cli, n]) => `${cli} ×${n}`).join(" · ")}
                        </span>
                      }
                    >
                      <span className="flex items-center gap-1.5 text-[9px] text-text-mid">
                        <TypingIndicator size={3} label="Görevler yürüyor" />
                        {runningTotal} görev paralel yürüyor — yeni durumlar geldikçe burada
                      </span>
                    </ChatMessage>
                  )}
                </>
              )
            ) : tab === "team" ? (
              <LiveTaskBoard />
            ) : (
              <>
                {taskList.length === 0 ? (
                  <p className="px-1 py-3 text-[9px] text-text-lo">
                    Henüz görev yok — lead Claude <span className="text-text-mid">yuppy_dispatch</span>{" "}
                    ile görev dağıttığında burada belirir.
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
                        <span className={`w-[78px] shrink-0 uppercase tracking-wider ${style.text}`}>
                          {STATE_LABEL[t.state] ?? t.state}
                        </span>
                        <span
                          className={`shrink-0 rounded-[4px] border px-1 text-[7.5px] uppercase tracking-wider ${
                            t.origin === "operator"
                              ? "border-line text-text-lo"
                              : "border-accent/30 text-accent"
                          }`}
                          title={t.origin === "operator" ? "bu pencereden gönderildi" : "lead Claude dağıttı"}
                        >
                          {t.origin === "operator" ? "operatör" : "lead"}
                        </span>
                        <span className="min-w-0 flex-1 truncate text-text-mid" title={t.detail ?? t.id}>
                          {t.title ?? t.id}
                        </span>
                        <span className="shrink-0 font-mono text-[8px] text-text-lo">
                          {t.cli ? agentShortName(t.cli) : "ajan ?"}
                        </span>
                        <span className="hidden shrink-0 font-mono text-[8px] text-text-lo/60 sm:inline">
                          {t.id.slice(-8)}
                        </span>
                        {LIVE_STATES.has(t.state) && (
                          <button
                            type="button"
                            onClick={() => send({ type: "task_cancel", task_id: t.id })}
                            className="shrink-0 rounded-[4px] border border-danger/30 px-1 py-px text-[8px] text-danger transition-colors hover:border-danger/60 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-danger/50"
                          >
                            iptal
                          </button>
                        )}
                      </div>
                    );
                  })
                )}

                {(integrations.length > 0 || conflicts.length > 0) && (
                  <div className="mt-2 border-t border-line/60 pt-1">
                    <div className="mb-0.5 font-mono text-[7.5px] uppercase tracking-[0.14em] text-text-lo">
                      entegrasyon
                    </div>
                    {[...conflicts].reverse().map((c) => (
                      <p
                        key={`c-${c.taskA}-${c.taskB}-${c.path}-${c.ts}`}
                        className="flex items-center gap-1 py-0.5 text-[8.5px] text-warn"
                      >
                        <TriangleAlert size={8} className="shrink-0" aria-hidden />
                        <span className="min-w-0 truncate" title={c.path}>
                          çakışma {c.path}
                        </span>
                        <span className="ml-auto shrink-0 text-text-lo">
                          {c.taskA.slice(-6)} · {c.taskB.slice(-6)} · elle birleştir
                        </span>
                      </p>
                    ))}
                    {[...integrations].reverse().map((i) => (
                      <p
                        key={`i-${i.taskId}-${i.ts}`}
                        className="flex items-center gap-1 py-0.5 text-[8.5px] text-text-mid"
                      >
                        <GitBranch size={8} className="shrink-0 text-accent" aria-hidden />
                        <span className="min-w-0 truncate" title={i.branch}>
                          {i.branch}
                        </span>
                        <span className="ml-auto shrink-0 text-text-lo">
                          {i.changedFiles.length} dosya · {i.committed ? "commit" : "commit yok"}
                        </span>
                      </p>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>

          {/* Right rail: the real Ekip board, only when the console is wide. */}
          <aside className="hidden w-[212px] shrink-0 flex-col border-l border-line/70 bg-bg-1/30 @[560px]:flex">
            <div className="flex h-6 shrink-0 items-center gap-1.5 border-b border-line/60 px-2 font-mono text-[8px] uppercase tracking-[0.14em] text-text-lo">
              <Users size={8} aria-hidden />
              ekip
              <span className="ml-auto normal-case tracking-normal text-text-lo/80">gerçek durum</span>
            </div>
            <div className="min-h-0 flex-1">
              <LiveTaskBoard />
            </div>
          </aside>
        </div>
      </div>
    </DeckPanel>
  );
}
