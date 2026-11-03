/**
 * 3D/2D scene model for the live agent network.
 *
 * Pure functions only: every position, curve and colour derives from the real
 * graph (`networkGraph.buildGraph`) which in turn derives from bridge state.
 * The renderers (R3F universe, React Flow map, Canvas fallback) share these
 * helpers so all three modes agree on what exists and where it sits.
 */
import type { Graph, GraphEdge, GraphNode, NodeStatus } from "./networkGraph";
import { CORE_ID, hash01 } from "./networkGraph";

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export const UNIVERSE = {
  deptRadius: 6.4,
  agentRadius: 3.5,
  deptY: 0.2,
  agentY: 1.45,
  coreY: 0.9,
  segments: 44,
} as const;

/* ── palette ──────────────────────────────────────────────────────────── */

export const UNIVERSE_COLORS = {
  accent: "#f97316",
  cyan: "#22d3ee",
  violet: "#a78bfa",
  ok: "#22c55e",
  warn: "#eab308",
  danger: "#ef4444",
  idle: "#64748b",
  off: "#52525b",
  line: "#3f3f46",
} as const;

export function statusColor(status: NodeStatus): string {
  switch (status) {
    case "live":
      return UNIVERSE_COLORS.ok;
    case "busy":
      return UNIVERSE_COLORS.accent;
    case "completed":
      return UNIVERSE_COLORS.cyan;
    case "failed":
      return UNIVERSE_COLORS.danger;
    case "offline":
    case "disabled":
      return UNIVERSE_COLORS.off;
    case "idle":
      return UNIVERSE_COLORS.idle;
    default:
      return UNIVERSE_COLORS.cyan;
  }
}

export function edgeColor(kind: GraphEdge["kind"], active: boolean): string {
  if (kind === "conflict") return UNIVERSE_COLORS.danger;
  if (kind === "task") return active ? UNIVERSE_COLORS.ok : UNIVERSE_COLORS.accent;
  if (kind === "seat") return active ? UNIVERSE_COLORS.cyan : UNIVERSE_COLORS.idle;
  return active ? UNIVERSE_COLORS.accent : UNIVERSE_COLORS.line;
}

/* ── scene model ──────────────────────────────────────────────────────── */

export interface UniverseNode {
  id: string;
  kind: GraphNode["kind"];
  label: string;
  sub: string;
  status: NodeStatus;
  selected: boolean;
  color: string;
  radius: number;
  position: Vec3;
}

export interface UniverseEdge {
  id: string;
  kind: GraphEdge["kind"];
  from: string;
  to: string;
  active: boolean;
  color: string;
  a: Vec3;
  c: Vec3;
  b: Vec3;
}

export interface UniverseModel {
  nodes: UniverseNode[];
  edges: UniverseEdge[];
  byId: Map<string, UniverseNode>;
}

function ringPosition(node: GraphNode): Vec3 {
  if (node.kind === "core") return { x: 0, y: UNIVERSE.coreY, z: 0 };
  const angle = Math.atan2(node.ty, node.tx);
  if (node.kind === "department") {
    return {
      x: Math.cos(angle) * UNIVERSE.deptRadius,
      y: UNIVERSE.deptY + (hash01(node.id) - 0.5) * 0.24,
      z: Math.sin(angle) * UNIVERSE.deptRadius,
    };
  }
  return {
    x: Math.cos(angle) * UNIVERSE.agentRadius,
    y: UNIVERSE.agentY + (hash01(node.id) - 0.5) * 0.18,
    z: Math.sin(angle) * UNIVERSE.agentRadius,
  };
}

export function curveControl(a: Vec3, b: Vec3, seed: string): Vec3 {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const len = Math.hypot(dx, dz) || 1;
  const bend = (hash01(seed) - 0.5) * 0.8;
  const lift = 0.55 + hash01(`${seed}:lift`) * 1.5;
  return {
    x: (a.x + b.x) / 2 - (dz / len) * bend * len * 0.24,
    y: Math.max(a.y, b.y) + lift,
    z: (a.z + b.z) / 2 + (dx / len) * bend * len * 0.24,
  };
}

export function universeFromGraph(graph: Graph): UniverseModel {
  const nodes: UniverseNode[] = graph.nodes.map((node) => {
    const position = ringPosition(node);
    return {
      id: node.id,
      kind: node.kind,
      label: node.label,
      sub: node.sub,
      status: node.status,
      selected: node.selected,
      color: statusColor(node.status),
      radius: node.kind === "department" ? 0.42 : node.kind === "agent" ? 0.3 : 0.62,
      position,
    };
  });
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const edges: UniverseEdge[] = [];
  for (const edge of graph.edges) {
    const from = byId.get(edge.from);
    const to = byId.get(edge.to);
    if (!from || !to) continue;
    edges.push({
      id: edge.id,
      kind: edge.kind,
      from: edge.from,
      to: edge.to,
      active: edge.active,
      color: edgeColor(edge.kind, edge.active),
      a: from.position,
      b: to.position,
      c: curveControl(from.position, to.position, edge.id),
    });
  }
  return { nodes, edges, byId };
}

/* ── curve geometry ───────────────────────────────────────────────────── */

export function quadratic3(a: Vec3, c: Vec3, b: Vec3, t: number): Vec3 {
  const clamped = Math.min(1, Math.max(0, t));
  const u = 1 - clamped;
  return {
    x: u * u * a.x + 2 * u * clamped * c.x + clamped * clamped * b.x,
    y: u * u * a.y + 2 * u * clamped * c.y + clamped * clamped * b.y,
    z: u * u * a.z + 2 * u * clamped * c.z + clamped * clamped * b.z,
  };
}

export function sampleCurve(edge: Pick<UniverseEdge, "a" | "c" | "b">, segments: number = UNIVERSE.segments): Vec3[] {
  const out: Vec3[] = [];
  for (let i = 0; i <= segments; i++) out.push(quadratic3(edge.a, edge.c, edge.b, i / segments));
  return out;
}

/** Direction of travel for a flow particle: dispatch forward, report back. */
export function flowDirection(edge: Pick<UniverseEdge, "kind" | "active">, index: number): 1 | -1 {
  if (!edge.active) return 1;
  if (edge.kind === "task") return index % 4 === 3 ? -1 : 1;
  return index % 2 === 0 ? 1 : -1;
}

/* ── force-directed settling ──────────────────────────────────────────── */

export interface ForceBody {
  id: string;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  tx: number;
  ty: number;
  tz: number;
  /** User-pinned position from dragging; null lets the body spring back. */
  pinned: Vec3 | null;
}

export interface ForceOptions {
  spring?: number;
  damping?: number;
  repulsion?: number;
  minDistance?: number;
  maxSpeed?: number;
}

export function createBodies(
  model: UniverseModel,
  startAt: "target" | "core" = "target",
): ForceBody[] {
  return model.nodes.map((node) => {
    const start =
      startAt === "core"
        ? { x: 0, y: UNIVERSE.coreY, z: 0 }
        : { x: node.position.x, y: node.position.y, z: node.position.z };
    return {
      id: node.id,
      ...start,
      vx: 0,
      vy: 0,
      vz: 0,
      tx: node.position.x,
      ty: node.position.y,
      tz: node.position.z,
      pinned: null,
    };
  });
}

export function forceStep(bodies: ForceBody[], dt: number, options: ForceOptions = {}): void {
  const step = Math.min(0.05, Math.max(0, dt));
  if (step === 0) return;
  const spring = options.spring ?? 9;
  const damping = options.damping ?? 4.2;
  const repulsion = options.repulsion ?? 1.6;
  const minDistance = options.minDistance ?? 1.5;
  const maxSpeed = options.maxSpeed ?? 6;

  for (let i = 0; i < bodies.length; i++) {
    const a = bodies[i];
    const target = a.pinned ?? { x: a.tx, y: a.ty, z: a.tz };
    const k = a.pinned ? spring * 2.4 : spring;
    a.vx += (target.x - a.x) * k * step;
    a.vy += (target.y - a.y) * k * step;
    a.vz += (target.z - a.z) * k * step;

    // Repulsion only between nodes that occupy the same neighbourhood.
    for (let j = i + 1; j < bodies.length; j++) {
      const b = bodies[j];
      const dx = a.x - b.x;
      const dy = a.y - b.y;
      const dz = a.z - b.z;
      const dist = Math.hypot(dx, dy, dz);
      if (dist <= 0.0001 || dist >= minDistance) continue;
      const push = (repulsion * (minDistance - dist)) / minDistance;
      const nx = dx / dist;
      const ny = dy / dist;
      const nz = dz / dist;
      a.vx += nx * push * step;
      a.vy += ny * push * step;
      a.vz += nz * push * step;
      b.vx -= nx * push * step;
      b.vy -= ny * push * step;
      b.vz -= nz * push * step;
    }
  }

  for (const body of bodies) {
    const damp = Math.max(0, 1 - damping * step);
    body.vx *= damp;
    body.vy *= damp;
    body.vz *= damp;
    const speed = Math.hypot(body.vx, body.vy, body.vz);
    if (speed > maxSpeed) {
      const scale = maxSpeed / speed;
      body.vx *= scale;
      body.vy *= scale;
      body.vz *= scale;
    }
    body.x += body.vx * step;
    body.y += body.vy * step;
    body.z += body.vz * step;
  }
}

/** Bring the existing force simulation in line with a new graph revision. */
export function syncBodies(
  bodies: ForceBody[],
  model: UniverseModel,
): { bodies: ForceBody[]; spawned: string[]; removed: string[] } {
  const existing = new Map(bodies.map((b) => [b.id, b]));
  const next: ForceBody[] = [];
  const spawned: string[] = [];
  for (const node of model.nodes) {
    const body = existing.get(node.id);
    if (body) {
      body.tx = node.position.x;
      body.ty = node.position.y;
      body.tz = node.position.z;
      next.push(body);
    } else {
      spawned.push(node.id);
      next.push({
        id: node.id,
        x: 0,
        y: UNIVERSE.coreY,
        z: 0,
        vx: 0,
        vy: 0,
        vz: 0,
        tx: node.position.x,
        ty: node.position.y,
        tz: node.position.z,
        pinned: null,
      });
    }
  }
  const alive = new Set(next.map((b) => b.id));
  const removed = bodies.filter((b) => !alive.has(b.id)).map((b) => b.id);
  return { bodies: next, spawned, removed };
}

/* ── honest readouts ──────────────────────────────────────────────────── */

export interface GraphStats {
  departments: number;
  agents: number;
  live: number;
  busy: number;
  completed: number;
  failed: number;
  offline: number;
}

export function graphStats(graph: Graph): GraphStats {
  const stats: GraphStats = {
    departments: 0,
    agents: 0,
    live: 0,
    busy: 0,
    completed: 0,
    failed: 0,
    offline: 0,
  };
  for (const node of graph.nodes) {
    if (node.kind === "department") stats.departments += 1;
    if (node.kind === "agent") stats.agents += 1;
    if (node.status === "live") stats.live += 1;
    if (node.status === "busy") stats.busy += 1;
    if (node.status === "completed") stats.completed += 1;
    if (node.status === "failed") stats.failed += 1;
    if (node.status === "offline") stats.offline += 1;
  }
  return stats;
}

/* ── task state -> effect plan (the UI contract from the brief) ───────── */

export type EffectTone = "accent" | "ok" | "danger" | "cyan";

export interface EventFxPlan {
  tone: EffectTone;
  corePulse: number;
  nodePulse: number;
  burst: number;
  ring: number;
  edgePulse: number;
  flash: boolean;
  glitch: boolean;
  /** Bidirectional particle flow while the job is active. */
  bidirectional: boolean;
}

const NO_FX: EventFxPlan = {
  tone: "accent",
  corePulse: 0,
  nodePulse: 0,
  burst: 0,
  ring: 0,
  edgePulse: 0,
  flash: false,
  glitch: false,
  bidirectional: false,
};

export function taskStateFx(state: string): EventFxPlan {
  switch (state) {
    case "queued":
      return { ...NO_FX, tone: "accent", nodePulse: 0.5, ring: 0.6 };
    case "running":
    case "awaiting_approval":
      return {
        ...NO_FX,
        tone: "accent",
        corePulse: 0.8,
        nodePulse: 1,
        ring: 0.9,
        edgePulse: 1,
        bidirectional: true,
      };
    case "completed":
      return {
        ...NO_FX,
        tone: "ok",
        corePulse: 0.5,
        nodePulse: 1,
        burst: 1,
        edgePulse: 0.7,
        flash: true,
      };
    case "failed":
      return {
        ...NO_FX,
        tone: "danger",
        corePulse: 0.2,
        nodePulse: 1.2,
        burst: 0.8,
        glitch: true,
      };
    default:
      return NO_FX;
  }
}

export function toneColor(tone: EffectTone): string {
  switch (tone) {
    case "ok":
      return UNIVERSE_COLORS.ok;
    case "danger":
      return UNIVERSE_COLORS.danger;
    case "cyan":
      return UNIVERSE_COLORS.cyan;
    default:
      return UNIVERSE_COLORS.accent;
  }
}

/** Task edges are the ones the scheduler actually owns. */
export function taskEdgeId(cli: string): string {
  return `${CORE_ID}->agent:${cli}:task`;
}

export function isCoreId(id: string): boolean {
  return id === CORE_ID;
}

/** Convert a 3D position to a stable orthographic-ish 2D map position. */
export function project2D(position: Vec3, scale = 44): { x: number; y: number } {
  return { x: position.x * scale, y: position.z * scale - position.y * scale * 0.35 };
}

/** Small helper used by labels/tests: hex -> rgb tuple in 0..1. */
export function hexToRgb(hex: string): [number, number, number] {
  const clean = hex.replace("#", "");
  const value = Number.parseInt(clean.length === 3 ? clean.replace(/(.)/g, "$1$1") : clean, 16);
  return [((value >> 16) & 255) / 255, ((value >> 8) & 255) / 255, (value & 255) / 255];
}
