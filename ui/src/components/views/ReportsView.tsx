"use client";

import { useEffect, useMemo, useState } from "react";
import { Activity, FileBarChart, GitBranch, TriangleAlert } from "lucide-react";
import {
  NumberTicker,
  ToolTimeline,
  type ToolTimelineItemData,
} from "fancy-ui-react";
import { useHudStore } from "@/lib/store";
import { Card, EmptyState, Stat, ViewShell, formatDuration } from "./shared";

function agentShortName(agent: string): string {
  if (agent.includes("claude")) return "Claude Code";
  if (agent.includes("codex")) return "Codex";
  return agent;
}

function time(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour12: false });
}

/** Session age without reading the clock during render. */
function SessionAge({ startedAt }: { startedAt?: number }) {
  const [elapsed, setElapsed] = useState<number | null>(null);
  useEffect(() => {
    if (!startedAt) return;
    const tick = () => setElapsed((Date.now() - startedAt) / 1000);
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [startedAt]);
  return (
    <span className="shrink-0 tabular-nums text-text-lo">
      {elapsed === null ? "—" : formatDuration(elapsed)}
    </span>
  );
}

/**
 * Reports module: derived from the same bridge events as the rest of the
 * console. No analytics pipeline is implied — every number is countable from
 * the live store and labeled with its source.
 */
export default function ReportsView() {
  const tasks = useHudStore((s) => s.tasks);
  const sessions = useHudStore((s) => s.sessions);
  const integrations = useHudStore((s) => s.integrations);
  const conflicts = useHudStore((s) => s.conflicts);
  const logs = useHudStore((s) => s.logs);
  const departments = useHudStore((s) => s.departments);
  const engine = useHudStore((s) => s.engineInfo);

  const taskList = Object.values(tasks);
  const running = taskList.filter((t) => t.state === "running").length;
  const queued = taskList.filter(
    (t) => t.state === "queued" || t.state === "awaiting_approval",
  ).length;
  const completed = taskList.filter((t) => t.state === "completed").length;
  const failed = taskList.filter((t) => t.state === "failed").length;
  const cancelled = taskList.filter((t) => t.state === "cancelled").length;

  const deptNames = Object.fromEntries(departments.map((d) => [d.id, d.name]));
  const sessionRows = sessions.map((s) => ({ ...s }));
  const integrationItems = useMemo<ToolTimelineItemData[]>(
    () =>
      integrations
        .slice()
        .reverse()
        .map((entry, i) => ({
          id: `${entry.taskId}-${entry.ts}-${i}`,
          verb: entry.committed ? "commit" : "commit yok",
          target: entry.branch,
          detail:
            entry.changedFiles.length === 0
              ? `task ${entry.taskId.slice(-8)} · değişen dosya bildirilmedi`
              : `task ${entry.taskId.slice(-8)} · ${entry.changedFiles.slice(0, 5).join(" · ")}${
                  entry.changedFiles.length > 5
                    ? ` · +${entry.changedFiles.length - 5}`
                    : ""
                }`,
          timestamp: entry.ts,
        })),
    [integrations],
  );
  const conflictItems = useMemo<ToolTimelineItemData[]>(
    () =>
      conflicts
        .slice()
        .reverse()
        .map((entry, i) => ({
          id: `${entry.path}-${entry.ts}-${i}`,
          verb: "çakışma",
          target: entry.path,
          detail: `${entry.taskA.slice(-8)} × ${entry.taskB.slice(-8)} · manuel merge`,
          timestamp: entry.ts,
        })),
    [conflicts],
  );

  return (
    <ViewShell
      title="Raporlar"
      kicker="canlı veriden türetilmiş operasyon özeti"
      right={
        <span className="flex items-center gap-1.5 font-mono text-[8px] uppercase tracking-wider text-text-lo">
          <Activity size={9} className="text-accent" aria-hidden />
          {engine?.git_branch ? `branch ${engine.git_branch}` : "git branch yok"}
        </span>
      }
      footer={
        <>
          <FileBarChart size={9} aria-hidden />
          <span>kaynak: görev durumları · PTY oturumları · worktree olayları · bridge logları</span>
          <span className="ml-auto hidden normal-case tracking-normal text-text-lo/70 md:inline">
            {engine?.workspace ?? "çalışma alanı bilinmiyor"}
          </span>
        </>
      }
    >
      <div className="space-y-1 p-1">
        <div className="grid grid-cols-2 gap-1 sm:grid-cols-4 xl:grid-cols-8">
          <Stat label="toplam görev" value={<NumberTicker value={taskList.length} />} />
          <Stat
            label="çalışan"
            value={<NumberTicker value={running} />}
            tone={running > 0 ? "ok" : "default"}
          />
          <Stat
            label="kuyruk"
            value={<NumberTicker value={queued} />}
            tone={queued > 0 ? "warn" : "default"}
          />
          <Stat
            label="tamamlanan"
            value={<NumberTicker value={completed} />}
            tone={completed > 0 ? "accent" : "default"}
          />
          <Stat
            label="başarısız"
            value={<NumberTicker value={failed} />}
            tone={failed > 0 ? "danger" : "default"}
          />
          <Stat label="iptal" value={<NumberTicker value={cancelled} />} />
          <Stat
            label="canlı PTY"
            value={<NumberTicker value={sessions.length} />}
            tone={sessions.length > 0 ? "ok" : "default"}
          />
          <Stat
            label="çakışma"
            value={<NumberTicker value={conflicts.length} />}
            tone={conflicts.length > 0 ? "danger" : "default"}
          />
        </div>

        <div className="grid gap-1 xl:grid-cols-2">
          <Card
            title="Worktree entegrasyonları"
            sub={`${integrations.length} olay`}
            right={<GitBranch size={9} className="text-accent" aria-hidden />}
          >
            {integrations.length === 0 ? (
              <div className="p-2">
                <EmptyState>worktree entegrasyon olayı yok</EmptyState>
              </div>
            ) : (
              <ToolTimeline
                items={integrationItems}
                label="Worktree entegrasyonları"
                className="px-2 py-1"
              />
            )}
          </Card>

          <Card
            title="Çakışmalar"
            sub={`${conflicts.length} manuel merge`}
            right={<TriangleAlert size={9} className="text-danger" aria-hidden />}
          >
            {conflicts.length === 0 ? (
              <div className="p-2">
                <EmptyState>çakışma bildirilmedi</EmptyState>
              </div>
            ) : (
              <ToolTimeline
                items={conflictItems}
                label="Çakışmalar"
                className="px-2 py-1"
              />
            )}
          </Card>
        </div>

        <div className="grid gap-1 xl:grid-cols-2">
          <Card title="PTY oturumları" sub={`${sessionRows.length} canlı`}>
            {sessionRows.length === 0 ? (
              <div className="p-2">
                <EmptyState>canlı terminal oturumu yok</EmptyState>
              </div>
            ) : (
              <div className="divide-y divide-line/50">
                {sessionRows.map((s) => (
                  <div key={s.id} className="flex items-center gap-1.5 px-2 py-1.5 font-mono text-[9px]">
                    <span className="size-1.5 rounded-full bg-ok" aria-hidden />
                    <span className="min-w-0 flex-1 truncate text-text-mid">{s.label}</span>
                    <span className="hidden shrink-0 text-[8px] text-text-lo sm:inline">
                      {agentShortName(s.agent)}
                    </span>
                    <span className="hidden shrink-0 text-[8px] text-text-lo md:inline">
                      {s.department ? deptNames[s.department] ?? s.department : "takımsız"}
                    </span>
                    <SessionAge startedAt={s.openedAt} />
                  </div>
                ))}
              </div>
            )}
          </Card>

          <Card title="Son olaylar" sub="en yeni 20">
            {logs.length === 0 ? (
              <div className="p-2">
                <EmptyState>bridge olayı yok</EmptyState>
              </div>
            ) : (
              <div className="divide-y divide-line/40">
                {logs
                  .slice(-20)
                  .reverse()
                  .map((log) => (
                    <div key={log.id} className="flex items-start gap-1.5 px-2 py-1">
                      <span
                        className={`mt-[4px] size-1 shrink-0 rounded-full ${
                          log.level === "error"
                            ? "bg-danger"
                            : log.level === "warn"
                              ? "bg-warn"
                              : "bg-accent/60"
                        }`}
                        aria-hidden
                      />
                      <span className="shrink-0 font-mono text-[8px] tabular-nums text-text-lo/70">
                        {time(log.ts)}
                      </span>
                      <span
                        className={`min-w-0 flex-1 break-words font-mono text-[8px] leading-[1.5] ${
                          log.level === "error"
                            ? "text-danger"
                            : log.level === "warn"
                              ? "text-warn"
                              : "text-text-mid"
                        }`}
                      >
                        {log.message}
                      </span>
                    </div>
                  ))}
              </div>
            )}
          </Card>
        </div>
      </div>
    </ViewShell>
  );
}
