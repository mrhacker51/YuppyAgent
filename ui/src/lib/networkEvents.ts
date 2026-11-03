/**
 * Real bridge state -> visual events.
 *
 * The HUD stores normalized snapshots of what the backend reported. This
 * module diffs two snapshots and emits *only* transitions that really
 * happened: a PTY opening, a scheduler state change, a reported conflict, a
 * new error log, the bridge disconnecting. Renderers turn these into
 * pulses/flashes; they never invent events or metrics.
 */
import type { TaskStateDto } from "./protocol";

export interface DiffSession {
  id: string;
  agent: string;
  generation?: number;
}

export interface DiffTask {
  id: string;
  state: TaskStateDto;
  cli?: string;
}

export interface DiffInput {
  sessions: readonly DiffSession[];
  tasks: Record<string, DiffTask>;
  conflicts: readonly { taskA: string; taskB: string }[];
  logs: readonly { level: string; ts: number }[];
  status: string;
}

export interface DiffState {
  booted: boolean;
  sessionIds: Set<string>;
  /** session id -> agent id, kept for closed sessions too. */
  agents: Map<string, string>;
  generations: Map<string, number | undefined>;
  taskStates: Map<string, TaskStateDto>;
  conflictCount: number;
  errorTs: number;
  status: string;
}

export type NetworkEvent =
  | { type: "session_open"; sessionId: string; agent: string }
  | { type: "session_close"; sessionId: string; agent: string }
  | { type: "activity"; sessionId: string; agent: string }
  | { type: "task"; taskId: string; cli: string; state: TaskStateDto }
  | { type: "conflict"; taskA: string; taskB: string }
  | { type: "error" }
  | { type: "status"; status: string };

export function createDiffState(): DiffState {
  return {
    booted: false,
    sessionIds: new Set(),
    agents: new Map(),
    generations: new Map(),
    taskStates: new Map(),
    conflictCount: 0,
    errorTs: 0,
    status: "",
  };
}

function latestErrorTs(logs: DiffInput["logs"]): number {
  let ts = 0;
  for (const log of logs) {
    if (log.level === "error" && log.ts > ts) ts = log.ts;
  }
  return ts;
}

/**
 * Diff one snapshot against the previous one. The returned state is a fresh
 * copy; callers store it for the next frame. The first call only seeds the
 * state (`booted: false`) so a page reload does not replay old history.
 */
export function diffNetwork(
  previous: DiffState,
  input: DiffInput,
): { events: NetworkEvent[]; next: DiffState } {
  const events: NetworkEvent[] = [];
  const agents = new Map(previous.agents);
  for (const session of input.sessions) agents.set(session.id, session.agent);

  const next: DiffState = {
    booted: true,
    sessionIds: new Set(input.sessions.map((s) => s.id)),
    agents,
    generations: new Map(input.sessions.map((s) => [s.id, s.generation])),
    taskStates: new Map(Object.values(input.tasks).map((t) => [t.id, t.state])),
    conflictCount: input.conflicts.length,
    errorTs: latestErrorTs(input.logs),
    status: input.status,
  };

  if (!previous.booted) return { events, next };

  for (const session of input.sessions) {
    if (!previous.sessionIds.has(session.id)) {
      events.push({ type: "session_open", sessionId: session.id, agent: session.agent });
      continue;
    }
    const before = previous.generations.get(session.id);
    if (before != null && session.generation != null && before !== session.generation) {
      events.push({ type: "activity", sessionId: session.id, agent: session.agent });
    }
  }
  for (const id of previous.sessionIds) {
    if (next.sessionIds.has(id)) continue;
    const agent = previous.agents.get(id);
    if (agent) events.push({ type: "session_close", sessionId: id, agent });
  }

  for (const task of Object.values(input.tasks)) {
    if (!task.cli) continue;
    if (previous.taskStates.get(task.id) === task.state) continue;
    events.push({ type: "task", taskId: task.id, cli: task.cli, state: task.state });
  }

  if (input.conflicts.length > previous.conflictCount) {
    for (const conflict of input.conflicts.slice(previous.conflictCount)) {
      events.push({ type: "conflict", taskA: conflict.taskA, taskB: conflict.taskB });
    }
  }

  if (next.errorTs > previous.errorTs) events.push({ type: "error" });

  if (previous.status && previous.status !== input.status) {
    events.push({ type: "status", status: input.status });
  }

  return { events, next };
}
