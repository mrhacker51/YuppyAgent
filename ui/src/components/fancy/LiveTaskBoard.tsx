"use client";

import { useMemo } from "react";
import {
  Badge,
  SubagentList,
  ThinkingIndicator,
  type RunStatus,
  type SubagentData,
} from "fancy-ui-react";
import { useHudStore } from "@/lib/store";
import type { TaskStateDto } from "@/lib/protocol";
import { agentShortName } from "@/lib/agents";

const LIVE_STATES = new Set<TaskStateDto>(["queued", "running", "awaiting_approval"]);

/** Real bridge task state → FancyUI's run lifecycle. No state is inferred. */
const RUN_STATUS: Record<TaskStateDto, RunStatus> = {
  queued: "pending",
  running: "running",
  awaiting_approval: "running",
  completed: "done",
  failed: "error",
  cancelled: "cancelled",
};

/**
 * "Ekip" board: the real task queue as delegated workers — what the lead
 * Claude dispatched over `yuppy_dispatch` and anything the operator filed.
 * FancyUI's SubagentList provides the row structure and status dots; the data
 * is only ever what the bridge reported. Per-task progress is deliberately
 * omitted — the store has no start/completion counters for a single task, so
 * a progress bar would be invented.
 */
export default function LiveTaskBoard() {
  const tasks = useHudStore((s) => s.tasks);

  const taskList = useMemo(() => {
    const all = Object.values(tasks);
    // Newest insertions first, then live rows before finished ones. Array.sort
    // is stable, so equal ranks keep the store's real insertion order.
    return [...all].reverse().sort((a, b) => {
      const aLive = LIVE_STATES.has(a.state) ? 0 : 1;
      const bLive = LIVE_STATES.has(b.state) ? 0 : 1;
      return aLive - bLive;
    }).slice(0, 48);
  }, [tasks]);

  const liveCount = useMemo(
    () => Object.values(tasks).filter((t) => LIVE_STATES.has(t.state)).length,
    [tasks],
  );

  const agents = useMemo<SubagentData[]>(
    () =>
      taskList.map((t) => ({
        id: t.id,
        name: t.title ?? (t.cli ? agentShortName(t.cli) : t.id),
        task: [t.origin === "operator" ? "operatör" : "lead", t.detail ?? t.department ?? t.id].join(" · "),
        status: RUN_STATUS[t.state],
        // No per-task completion count exists in the store, so no progress.
        model: t.cli ? agentShortName(t.cli) : undefined,
      })),
    [taskList],
  );

  const byCli = useMemo(() => {
    const out = new Map<string, number>();
    for (const t of Object.values(tasks)) {
      if (t.state !== "running") continue;
      const key = t.cli ? agentShortName(t.cli) : "ajan ?";
      out.set(key, (out.get(key) ?? 0) + 1);
    }
    return [...out.entries()];
  }, [tasks]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-wrap items-center gap-1.5 px-1 pb-1">
        <Badge variant={liveCount > 0 ? "success" : "outline"}>
          {liveCount > 0 ? `${liveCount} canlı` : "canlı yok"}
        </Badge>
        <Badge variant="secondary">{Object.keys(tasks).length} görev</Badge>
        <span className="ml-auto font-mono text-[7px] uppercase tracking-[0.12em] text-text-lo">
          gerçek köprü durumu
        </span>
      </div>

      {byCli.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 px-1 pb-1.5">
          {/* Parallelism, per executor: only tasks the bridge reports running. */}
          {byCli.map(([cli, count]) => (
            <ThinkingIndicator
              key={cli}
              status={`${cli} ×${count} çalışıyor`}
              running
              showElapsed={false}
              variant="pill"
              className="!gap-1 !border-line !bg-bg-1 !px-1.5 !py-0.5 !text-[8px]"
            />
          ))}
        </div>
      )}

      <div className="thin-scroll min-h-0 flex-1 overflow-y-auto px-1">
        <div className="mb-0.5 flex items-center gap-1 border-b border-line/60 pb-0.5 font-mono text-[7.5px] uppercase tracking-[0.14em] text-text-lo">
          paralel işçiler
          <span className="text-line">/</span>
          <span className="normal-case tracking-normal text-text-lo/80">
            aynı anda koşan köprü görevleri
          </span>
        </div>
        {agents.length === 0 ? (
          <p className="px-1 py-2 font-mono text-[9px] text-text-lo">
            Henüz işçi yok — lead Claude&apos;a bir iş ver; dağıttığı görevler burada belirir.
          </p>
        ) : (
          <SubagentList
            agents={agents}
            compact
            label={`${liveCount} canlı · ${agents.length} görev`}
            className="font-mono text-[9px] [&_.ft-subagents-name]:!text-[9px] [&_.ft-subagents-model]:!text-[7.5px] [&_.ft-subagents-task]:!text-[8px] [&_.ft-subagents-state]:!text-[7.5px] [&_.ft-subagents-progress]:!h-1"
          />
        )}
      </div>
    </div>
  );
}
