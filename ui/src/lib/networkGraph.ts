/**
 * Pure graph model + geometry for the AgentSpace network map.
 *
 * Everything here is deterministic and side-effect free so it can run under
 * `node --test`. The only data source is the real bridge state passed in by
 * the caller: departments/roles are configuration, sessions are real PTYs,
 * tasks are real scheduler states. No relationship is invented — an edge
 * exists only when the input data actually contains it.
 */
import type { AgentStatusDto, DepartmentDto, TaskStateDto } from "./protocol";

export type NodeKind = "core" | "department" | "agent";

export type NodeStatus =
  | "idle"
  | "ready"
  | "live"
  | "busy"
  | "completed"
  | "failed"
  | "offline"
  | "disabled";

export interface GraphNode {
  id: string;
  kind: NodeKind;
  label: string;
  sub: string;
  status: NodeStatus;
  selected: boolean;
  /** World-space target position (assigned by layoutNodes). */
  tx: number;
  ty: number;
}

export type EdgeKind = "orchestration" | "seat" | "task" | "conflict";

export interface GraphEdge {
  id: string;
  from: string;
  to: string;
  kind: EdgeKind;
  /** Task edges are active while the task runs. */
  active: boolean;
}

export interface Graph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

/** Structural subset of the HUD store slices the graph needs. */
export interface GraphInput {
  departments: DepartmentDto[];
  agents: AgentStatusDto[];
  sessions: Array<{ id: string; agent: string; department?: string }>;
  tasks: Record<string, { id: string; state: TaskStateDto; cli?: string; department?: string | null }>;
  conflicts: Array<{ taskA: string; taskB: string }>;
  selectedDept: string;
  selectedAgent: string;
}

export const CORE_ID = "core";

export function deptNodeId(departmentId: string): string {
  return `dept:${departmentId}`;
}

export function agentNodeId(agentId: string): string {
  return `agent:${agentId}`;
}

function latestTaskByCli(
  tasks: GraphInput["tasks"],
): Record<string, { id: string; state: TaskStateDto }> {
  const out: Record<string, { id: string; state: TaskStateDto }> = {};
  for (const task of Object.values(tasks)) {
    if (task.cli) out[task.cli] = { id: task.id, state: task.state };
  }
  return out;
}

export function agentStatusFor(
  agent: AgentStatusDto,
  liveAgents: Set<string>,
  latestTask: { id: string; state: TaskStateDto } | undefined,
): NodeStatus {
  if (!agent.available) return "offline";
  if (latestTask?.state === "failed") return "failed";
  if (liveAgents.has(agent.id)) {
    return latestTask?.state === "running" || latestTask?.state === "awaiting_approval"
      ? "busy"
      : "live";
  }
  if (latestTask?.state === "running" || latestTask?.state === "awaiting_approval") return "busy";
  if (latestTask?.state === "completed") return "completed";
  return "ready";
}

export function buildGraph(input: GraphInput): Graph {
  const { departments, agents, sessions, tasks, conflicts, selectedDept, selectedAgent } = input;
  const liveAgents = new Set(sessions.map((s) => s.agent));
  const latestByCli = latestTaskByCli(tasks);

  const nodes: GraphNode[] = [
    {
      id: CORE_ID,
      kind: "core",
      label: "YUPPY",
      sub: "core",
      status: "live",
      selected: false,
      tx: 0,
      ty: 0,
    },
  ];

  for (const d of departments) {
    const roles = d.roles ?? [];
    const live = sessions.filter((s) => s.department === d.id).length;
    const status: NodeStatus = !d.enabled ? "disabled" : live > 0 ? "live" : "idle";
    nodes.push({
      id: deptNodeId(d.id),
      kind: "department",
      label: d.name,
      sub: `${live} canlı · ${roles.length} rol · max ${d.max_concurrency}${d.enabled ? "" : " · kapalı"}`,
      status,
      selected: selectedDept === d.id,
      tx: 0,
      ty: 0,
    });
  }

  for (const a of agents) {
    nodes.push({
      id: agentNodeId(a.id),
      kind: "agent",
      label: a.display_name || a.id,
      sub: latestByCli[a.id]?.state ?? (a.available ? "hazır" : "yok"),
      status: agentStatusFor(a, liveAgents, latestByCli[a.id]),
      selected: selectedAgent === a.id,
      tx: 0,
      ty: 0,
    });
  }

  const edges: GraphEdge[] = [];
  const edgeIds = new Set<string>();
  const push = (from: string, to: string, kind: EdgeKind, active = false) => {
    const id = `${from}->${to}:${kind}`;
    if (edgeIds.has(id)) return;
    edgeIds.add(id);
    edges.push({ id, from, to, kind, active });
  };

  // Core orchestrates every real department.
  for (const d of departments) push(CORE_ID, deptNodeId(d.id), "orchestration", d.enabled);

  // Department seats: a role edge exists only when the configured CLI matches
  // a detected agent id exactly.
  for (const d of departments) {
    for (const role of d.roles ?? []) {
      if (agents.some((a) => a.id === role.cli)) {
        push(deptNodeId(d.id), agentNodeId(role.cli), "seat", d.enabled);
      }
    }
  }

  // Live sessions also anchor their agent under the department they were
  // opened for (the bridge reports the department only via our request).
  for (const s of sessions) {
    if (s.department && departments.some((d) => d.id === s.department)) {
      push(deptNodeId(s.department), agentNodeId(s.agent), "seat", true);
    }
  }

  // Task flow: core -> executor while a task is queued/running on it.
  for (const task of Object.values(tasks)) {
    if (!task.cli) continue;
    if (!agents.some((a) => a.id === task.cli)) continue;
    const active =
      task.state === "running" || task.state === "awaiting_approval" || task.state === "queued";
    push(CORE_ID, agentNodeId(task.cli), "task", active);
  }

  // Conflicts: a real red edge between the two executors that touched the
  // same path, only when both task ids are still known.
  for (const c of conflicts) {
    const a = tasks[c.taskA]?.cli;
    const b = tasks[c.taskB]?.cli;
    if (a && b && a !== b && agents.some((x) => x.id === a) && agents.some((x) => x.id === b)) {
      push(agentNodeId(a), agentNodeId(b), "conflict");
    }
  }

  layoutNodes(nodes);
  return { nodes, edges };
}

export interface Vec {
  x: number;
  y: number;
}

/** Deterministic pseudo-random from a string (stable edge curvature). */
export function hash01(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 1000) / 1000;
}

export const DEPT_RING_R = 200;
export const AGENT_RING_R = 112;

/**
 * Assign ring positions: departments on the outer ring, agents on an inner
 * ring, core at the origin. Positions are targets; the renderer eases toward
 * them so topology changes animate smoothly.
 */
export function layoutNodes(nodes: GraphNode[]): void {
  const depts = nodes.filter((n) => n.kind === "department");
  const agents = nodes.filter((n) => n.kind === "agent");
  depts.forEach((n, i) => {
    const angle = -Math.PI / 2 + (i / Math.max(1, depts.length)) * Math.PI * 2;
    n.tx = Math.cos(angle) * DEPT_RING_R;
    n.ty = Math.sin(angle) * DEPT_RING_R;
  });
  agents.forEach((n, i) => {
    const angle =
      -Math.PI / 2 + ((i + 0.5) / Math.max(1, agents.length)) * Math.PI * 2 + Math.PI / 7;
    n.tx = Math.cos(angle) * AGENT_RING_R;
    n.ty = Math.sin(angle) * AGENT_RING_R;
  });
  const core = nodes.find((n) => n.kind === "core");
  if (core) {
    core.tx = 0;
    core.ty = 0;
  }
}

/** Quadratic bezier control point: midpoint pushed perpendicular. */
export function bezierControl(a: Vec, b: Vec, curvature: number): Vec {
  const mx = (a.x + b.x) / 2;
  const my = (a.y + b.y) / 2;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  const off = curvature * len;
  return { x: mx - (dy / len) * off, y: my + (dx / len) * off };
}

export function bezierPoint(a: Vec, c: Vec, b: Vec, t: number): Vec {
  const u = 1 - t;
  return {
    x: u * u * a.x + 2 * u * t * c.x + t * t * b.x,
    y: u * u * a.y + 2 * u * t * c.y + t * t * b.y,
  };
}

/** Sample a bezier into `segments` polyline points (for drawing + particles). */
export function sampleBezier(a: Vec, c: Vec, b: Vec, segments: number): Vec[] {
  const pts: Vec[] = [];
  for (let i = 0; i <= segments; i++) pts.push(bezierPoint(a, c, b, i / segments));
  return pts;
}

/** Draw only the first `progress` (0..1) fraction of a sampled path. */
export function partialPath(points: Vec[], progress: number): Vec[] {
  const n = points.length;
  if (n < 2 || progress <= 0) return [];
  const upto = Math.min(n - 1, Math.floor(progress * (n - 1)));
  const frac = progress * (n - 1) - upto;
  const out = points.slice(0, upto + 1);
  if (frac > 0 && upto + 1 < n) {
    const p0 = points[upto];
    const p1 = points[upto + 1];
    out.push({ x: p0.x + (p1.x - p0.x) * frac, y: p0.y + (p1.y - p0.y) * frac });
  }
  return out;
}

/** Point at exact t along the curve (particle position). */
export function pointAt(a: Vec, c: Vec, b: Vec, t: number): Vec {
  return bezierPoint(a, c, b, Math.min(1, Math.max(0, t)));
}
