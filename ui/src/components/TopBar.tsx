"use client";

import { useHudStore } from "@/lib/store";

/**
 * Global top bar telemetry — every chip renders **real bridge state only**:
 * workspace path, git branch, live CLI inventory, session count and task
 * counters. A chip that has no backing data is simply not rendered; nothing
 * here is simulated or guessed.
 */

const chip =
  "flex items-center gap-1.5 rounded-md border border-line bg-bg-2/80 px-2.5 py-1 font-mono text-[11px] text-text-mid";

function TaskCounts() {
  const tasks = useHudStore((s) => s.tasks);
  const counts = { running: 0, queued: 0, completed: 0, failed: 0 };
  for (const t of Object.values(tasks)) {
    if (t.state === "running") counts.running += 1;
    else if (t.state === "queued" || t.state === "awaiting_approval") counts.queued += 1;
    else if (t.state === "completed") counts.completed += 1;
    else if (t.state === "failed" || t.state === "cancelled") counts.failed += 1;
  }
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  if (total === 0) return null;
  const cell = (n: number, label: string, cls: string) => (
    <span className={n > 0 ? cls : "text-text-lo"} aria-label={`${label} tasks: ${n}`}>
      {n}
      <span className="ml-0.5 text-text-lo">{label[0]}</span>
    </span>
  );
  return (
    <span className={chip} aria-label="Task counts">
      {cell(counts.running, "running", "text-ok")}
      {cell(counts.queued, "queued", "text-warn")}
      {cell(counts.completed, "done", "text-accent")}
      {cell(counts.failed, "failed", "text-danger")}
    </span>
  );
}

function SessionsChip() {
  const sessions = useHudStore((s) => s.sessions);
  if (sessions.length === 0) return null;
  return (
    <span className={chip} aria-label="Live CLI sessions">
      <span className="h-1.5 w-1.5 rounded-full bg-ok" aria-hidden="true" />
      {sessions.length} live
    </span>
  );
}

function WorkspaceChip() {
  const info = useHudStore((s) => s.engineInfo);
  if (!info) return null;
  const dir = info.workspace.split("/").filter(Boolean).pop() ?? info.workspace;
  return (
    <span className={chip} title={info.workspace} aria-label={`Workspace ${info.workspace}`}>
      <span className="text-text-lo">▸</span>
      <span className="max-w-40 truncate text-text-hi/90">{dir}</span>
    </span>
  );
}

function GitChip() {
  const branch = useHudStore((s) => s.engineInfo?.git_branch);
  if (!branch) return null; // not a checkout — absence is honest
  return (
    <span className={chip} aria-label={`Git branch ${branch}`}>
      <span className="text-accent/80">◈</span>
      <span className="max-w-32 truncate text-text-hi/90">{branch}</span>
    </span>
  );
}

function CliInventoryChip() {
  const agents = useHudStore((s) => s.agents);
  const live = agents.filter((a) => a.available);
  if (live.length === 0) return null;
  const text = live
    .map((a) => a.version ? `${a.id} ${a.version}` : a.id)
    .join(" · ");
  return (
    <span className={chip} aria-label="Detected CLIs">
      <span className="max-w-64 truncate">{text}</span>
    </span>
  );
}

export default function StatusChips() {
  return (
    <div className="hidden items-center gap-2 lg:flex" role="status" aria-label="Orchestration telemetry">
      <WorkspaceChip />
      <GitChip />
      <CliInventoryChip />
      <SessionsChip />
      <TaskCounts />
    </div>
  );
}
