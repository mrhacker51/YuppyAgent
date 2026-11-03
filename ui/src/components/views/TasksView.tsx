"use client";

import { useMemo, useState } from "react";
import { ListChecks, X } from "lucide-react";
import {
  AgentPlan,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  type PlanStepData,
  type RunStatus,
} from "fancy-ui-react";
import { useHudStore, type Task } from "@/lib/store";
import type { TaskStateDto } from "@/lib/protocol";
import Badge from "../fancy/Badge";
import { EmptyState, TaskBadge, ViewShell, dispatchCommandTarget } from "./shared";

const FILTERS = [
  { id: "all", label: "tümü" },
  { id: "live", label: "canlı" },
  { id: "done", label: "bitti" },
  { id: "error", label: "hata" },
] as const;

type FilterId = (typeof FILTERS)[number]["id"];

const LIVE = new Set(["queued", "running", "awaiting_approval"]);

function matches(task: Task, filter: FilterId): boolean {
  if (filter === "all") return true;
  if (filter === "live") return LIVE.has(task.state);
  if (filter === "done") return task.state === "completed";
  return task.state === "failed" || task.state === "cancelled";
}

function shortCli(cli: string | undefined): string {
  if (!cli) return "—";
  if (cli.includes("claude")) return "Claude";
  if (cli.includes("codex")) return "Codex";
  return cli;
}

const STATE_LABEL: Record<TaskStateDto, string> = {
  queued: "kuyrukta",
  running: "çalışıyor",
  awaiting_approval: "onay bekliyor",
  completed: "tamamlandı",
  failed: "başarısız",
  cancelled: "iptal",
};

/** Bridge task state → FancyUI run status. Only real states are mapped. */
function runStatus(state: TaskStateDto): RunStatus {
  switch (state) {
    case "running":
      return "running";
    case "completed":
      return "done";
    case "failed":
      return "error";
    case "cancelled":
      return "cancelled";
    case "queued":
    case "awaiting_approval":
      return "pending";
  }
}

/** Aggregate a department's real task states into one plan step status. */
function groupStatus(tasks: Task[]): RunStatus {
  if (tasks.length === 0) return "pending";
  if (tasks.some((t) => t.state === "running")) return "running";
  if (tasks.some((t) => LIVE.has(t.state))) return "pending";
  if (tasks.every((t) => t.state === "completed")) return "done";
  if (tasks.some((t) => t.state === "failed")) return "error";
  if (tasks.every((t) => t.state === "cancelled")) return "cancelled";
  return "done";
}

const ALL_DEPTS = "__all";

/**
 * Tasks module: the bridge's live queue, not a local todo list. Task specs
 * are created in the command centre; this view mirrors their state as a real
 * plan grouped by the department that owns each task.
 */
export default function TasksView() {
  const tasks = useHudStore((s) => s.tasks);
  const departments = useHudStore((s) => s.departments);
  const send = useHudStore((s) => s.send);
  const [filter, setFilter] = useState<FilterId>("all");

  const deptNames = useMemo(
    () => Object.fromEntries(departments.map((d) => [d.id, d.name])),
    [departments],
  );
  const all = useMemo(() => Object.values(tasks).reverse(), [tasks]);
  const visible = all.filter((t) => matches(t, filter));
  const live = all.filter((t) => LIVE.has(t.state)).length;
  const completed = all.filter((t) => t.state === "completed").length;
  const failed = all.filter((t) => t.state === "failed" || t.state === "cancelled").length;

  const counts = {
    all: all.length,
    live,
    done: completed,
    error: failed,
  } satisfies Record<FilterId, number>;

  const plan = useMemo(() => {
    const groups = new Map<string, Task[]>();
    for (const task of visible) {
      const key = task.department || ALL_DEPTS;
      const list = groups.get(key);
      if (list) list.push(task);
      else groups.set(key, [task]);
    }
    // Keep the configured department order, then any unconfigured departments,
    // then the tasks that belong to no department.
    const orderedKeys = [
      ...departments.map((d) => d.id).filter((id) => groups.has(id)),
      ...[...groups.keys()].filter(
        (id) => id !== ALL_DEPTS && !departments.some((d) => d.id === id),
      ),
      ...(groups.has(ALL_DEPTS) ? [ALL_DEPTS] : []),
    ];
    return orderedKeys.map<PlanStepData>((key) => {
      const groupTasks = groups.get(key) ?? [];
      const name =
        key === ALL_DEPTS ? "tüm takımlar" : deptNames[key] ?? key;
      return {
        id: `dept:${key}`,
        label: name,
        status: groupStatus(groupTasks),
        detail: `${groupTasks.length} görev · ${groupTasks.filter((t) => LIVE.has(t.state)).length} canlı`,
        substeps: groupTasks.map((task) => ({
          id: `task:${task.id}`,
          label: task.title ?? task.id,
          status: runStatus(task.state),
          detail: `${shortCli(task.cli)} · ${STATE_LABEL[task.state]}${
            task.detail ? ` · ${task.detail}` : ""
          }`,
        })),
      };
    });
  }, [visible, departments, deptNames]);

  const taskById = useMemo(
    () => new Map(visible.map((task) => [`task:${task.id}`, task])),
    [visible],
  );

  const renderPlan = () => {
    if (plan.length === 0) {
      return (
        <div className="p-2">
          <EmptyState
            action={
              all.length === 0 ? (
                <button
                  type="button"
                  onClick={() => dispatchCommandTarget(undefined, undefined)}
                  className="border border-accent/40 bg-accent-dim px-2 py-1 font-mono text-[9px] uppercase tracking-wider text-accent transition-colors hover:border-accent/70 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/50"
                >
                  lead&apos;e git
                </button>
              ) : undefined
            }
          >
            {all.length === 0
              ? "henüz görev yok — lead Claude'a bir iş ver; dağıttığı görevler burada belirir"
              : "bu filtrede görev yok"}
          </EmptyState>
        </div>
      );
    }

    return (
      <AgentPlan
        steps={plan}
        label="görev kuyruğu"
        showProgress
        className="px-0.5 py-1"
        item={(step) => {
          const task = taskById.get(step.id);
          if (!task) {
            return (
              <span className="flex min-w-0 flex-1 items-center gap-2">
                <span className="min-w-0 flex-1 truncate text-[10.5px] font-medium text-text-hi">
                  {step.label}
                </span>
                {step.detail && (
                  <span className="shrink-0 font-mono text-[8px] text-text-lo">
                    {step.detail}
                  </span>
                )}
              </span>
            );
          }
          return (
            <span className="flex min-w-0 flex-1 items-center gap-2">
              <span className="min-w-0 flex-1">
                <span
                  className="block truncate text-[10px] text-text-hi"
                  title={task.title ?? task.id}
                >
                  {task.title ?? task.id}
                </span>
                <span className="block truncate font-mono text-[8px] text-text-lo">
                  {shortCli(task.cli)} · {task.id}
                  {task.detail ? ` · ${task.detail}` : ""}
                </span>
              </span>
              <TaskBadge state={task.state} />
              {LIVE.has(task.state) ? (
                <button
                  type="button"
                  onClick={() => send({ type: "task_cancel", task_id: task.id })}
                  className="flex shrink-0 items-center gap-1 border border-danger/30 px-1.5 py-0.5 font-mono text-[8px] uppercase tracking-wider text-danger transition-colors hover:border-danger/60 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-danger/50"
                  title="Görevi iptal et"
                >
                  <X size={8} aria-hidden /> iptal
                </button>
              ) : (
                <span className="shrink-0 font-mono text-[8px] text-text-lo/40">—</span>
              )}
            </span>
          );
        }}
      />
    );
  };

  return (
    <ViewShell
      title="Görevler"
      kicker="bridge görev kuyruğu"
      right={
        <span className="flex items-center gap-2 font-mono text-[8px] uppercase tracking-wider text-text-lo">
          <span className="text-ok">{live} canlı</span>
          <span className="text-line">/</span>
          <span className="text-accent">{completed} tamam</span>
          <span className="text-line">/</span>
          <span className="text-danger">{failed} hata</span>
        </span>
      }
      footer={
        <>
          <ListChecks size={9} aria-hidden />
          <span>{all.length} görev · durumlar backend&apos;den gelir</span>
          <span className="ml-auto">
            <Badge tone={filter === "error" ? "danger" : filter === "live" ? "ok" : "outline"}>
              {filter === "all" ? "tümü" : filter}
            </Badge>
          </span>
        </>
      }
    >
      <Tabs
        value={filter}
        onValueChange={(value) => setFilter(value as FilterId)}
        variant="segmented"
        className="flex min-h-0 flex-col"
      >
        <div className="flex items-center gap-2 border-b border-line bg-bg-1/50 px-2 py-1">
          <TabsList className="border-line bg-bg-0/40">
            {FILTERS.map((f) => (
              <TabsTrigger key={f.id} value={f.id} className="gap-1 px-2 py-[3px] text-[9px]">
                {f.label}
                <span className="font-mono text-[8px] tabular-nums opacity-70">
                  {counts[f.id]}
                </span>
              </TabsTrigger>
            ))}
          </TabsList>
          <span className="ml-auto hidden font-mono text-[8px] uppercase tracking-wider text-text-lo sm:inline">
            görev merkezden gönderilir
          </span>
        </div>

        {FILTERS.map((f) => (
          <TabsContent key={f.id} value={f.id} className="min-h-0">
            {renderPlan()}
          </TabsContent>
        ))}
      </Tabs>
    </ViewShell>
  );
}
