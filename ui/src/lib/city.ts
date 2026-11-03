/**
 * Office-city layout for the AgentSpace map.
 *
 * The dashboard is a top-down/scaled 3D office district: the Jarvis core sits
 * in the central plaza, every real department becomes a tower on the grid,
 * every detected agent gets a pod at its department tower (or in the open
 * floor if the bridge does not tie it to a department), and the roads between
 * them exist only when the real graph contains that relationship.
 *
 * Pure and deterministic: the same bridge state always produces the same
 * city, so positions can be tested without WebGL.
 */
import type { Graph, GraphEdge, GraphNode } from "./networkGraph";
import { CORE_ID } from "./networkGraph";
import { edgeColor, statusColor, type UniverseEdge, type UniverseModel, type UniverseNode, type Vec3 } from "./universe";

export const CITY = {
  /** Distance between avenue centre lines. */
  block: 9.5,
  /** Plaza radius kept clear around the core. */
  plaza: 3.4,
  /** Ground plane height for roads and floors. */
  ground: 0.04,
  /** Tower footprint. */
  towerWidth: 3.1,
  towerDepth: 2.4,
  /** Agent pod ring around a tower. */
  podRadius: 2.6,
  /** Hard ceiling so a huge roster never towers over the camera. */
  maxTowerHeight: 8.5,
  minTowerHeight: 2.2,
} as const;

export interface TowerMeta {
  height: number;
  floors: number;
  roles: number;
  agents: number;
  liveAgents: number;
}

function hashUnit(seed: string): number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 10000) / 10000;
}

/**
 * Department plots: alternating avenues east/west of the plaza, three plots
 * deep per avenue band, expanding outwards. The centre stays free for the
 * core, so no building can ever sit on the plaza.
 */
export function towerPlots(count: number): Array<{ x: number; z: number }> {
  const plots: Array<{ x: number; z: number }> = [];
  for (let i = 0; i < count; i++) {
    const side = i % 2 === 0 ? -1 : 1;
    const row = Math.floor(i / 2);
    const band = Math.floor(row / 3);
    const depth = row % 3;
    const x = side * CITY.block * (1 + band);
    const z = (depth - 1) * CITY.block;
    plots.push({ x, z });
  }
  return plots;
}

/** Agent pods around a tower, starting from the plaza-facing corner. */
export function podSlots(tower: Vec3, count: number, seed: string): Vec3[] {
  const slots: Vec3[] = [];
  const facing = Math.atan2(-tower.z, -tower.x);
  for (let i = 0; i < count; i++) {
    const angle = facing + (i - (count - 1) / 2) * 0.55 + (hashUnit(`${seed}:${i}`) - 0.5) * 0.12;
    slots.push({
      x: tower.x + Math.cos(angle) * CITY.podRadius,
      y: CITY.ground,
      z: tower.z + Math.sin(angle) * CITY.podRadius,
    });
  }
  return slots;
}

/** Open-floor parking strip for agents the graph does not attach to a tower. */
export function openFloorSlots(count: number): Vec3[] {
  const slots: Vec3[] = [];
  for (let i = 0; i < count; i++) {
    const col = i % 6;
    const row = Math.floor(i / 6);
    slots.push({
      x: (col - 2.5) * (CITY.block / 2.2),
      y: CITY.ground,
      z: CITY.block * 1.85 + row * 3.2,
    });
  }
  return slots;
}

/**
 * Tower massing reads the real department: one floor per seat edge, taller
 * with more floors, and a taller spire while a PTY is live on it.
 */
export function towerMeta(roles: number, live: boolean): TowerMeta {
  const floors = Math.max(1, roles);
  const height = Math.min(
    CITY.maxTowerHeight,
    CITY.minTowerHeight + floors * 0.62 + (live ? 1.1 : 0),
  );
  return {
    height,
    floors,
    roles,
    agents: 0,
    liveAgents: live ? 1 : 0,
  };
}

/** A road is flat: the bezier control point sits on the ground between both ends. */
function roadCurve(a: Vec3, b: Vec3): Vec3 {
  return { x: (a.x + b.x) / 2, y: CITY.ground, z: (a.z + b.z) / 2 };
}

/**
 * Build the city model from the real graph. Departments come from
 * `departments_loaded`, agents from `agent_inventory`, roads from the same
 * seat/orchestration/conflict edges the 2D graph uses — nothing is invented.
 */
export function cityFromGraph(graph: Graph): UniverseModel {
  const departments = graph.nodes.filter((n) => n.kind === "department");
  const agents = graph.nodes.filter((n) => n.kind === "agent");
  const plots = towerPlots(departments.length);

  const nodes: UniverseNode[] = [];
  const towerByDept = new Map<string, Vec3>();

  const coreNode = graph.nodes.find((n) => n.kind === "core");
  if (coreNode) {
    nodes.push({
      id: coreNode.id,
      kind: "core",
      label: coreNode.label,
      sub: "merkez plaza",
      status: coreNode.status,
      selected: false,
      color: statusColor(coreNode.status),
      radius: 1.15,
      position: { x: 0, y: CITY.ground, z: 0 },
    });
  }

  departments.forEach((dept, index) => {
    const plot = plots[index];
    const position = { x: plot.x, y: CITY.ground, z: plot.z };
    towerByDept.set(dept.id, position);
    nodes.push({
      id: dept.id,
      kind: "department",
      label: dept.label,
      sub: dept.sub,
      status: dept.status,
      selected: dept.selected,
      color: statusColor(dept.status),
      radius: CITY.towerWidth / 2,
      position,
    });
  });

  // Agents park at their department tower; unattached ones use the open floor.
  const towerOf = new Map<string, string>();
  for (const edge of graph.edges) {
    if (edge.kind !== "seat") continue;
    const deptEnd = edge.from.startsWith("dept:") ? edge.from : edge.to.startsWith("dept:") ? edge.to : null;
    const agentEnd = edge.from.startsWith("agent:") ? edge.from : edge.to.startsWith("agent:") ? edge.to : null;
    if (deptEnd && agentEnd && !towerOf.has(agentEnd)) towerOf.set(agentEnd, deptEnd);
  }

  const grouped = new Map<string, GraphNode[]>();
  const homeless: GraphNode[] = [];
  for (const agent of agents) {
    const tower = towerOf.get(agent.id);
    if (tower && towerByDept.has(tower)) {
      const list = grouped.get(tower) ?? [];
      list.push(agent);
      grouped.set(tower, list);
    } else {
      homeless.push(agent);
    }
  }

  for (const [deptId, list] of grouped) {
    const tower = towerByDept.get(deptId) as Vec3;
    const slots = podSlots(tower, list.length, deptId);
    list.forEach((agent, i) => {
      nodes.push({
        id: agent.id,
        kind: "agent",
        label: agent.label,
        sub: agent.sub,
        status: agent.status,
        selected: agent.selected,
        color: statusColor(agent.status),
        radius: 0.55,
        position: slots[i],
      });
    });
  }

  const freeSlots = openFloorSlots(homeless.length);
  homeless.forEach((agent, i) => {
    nodes.push({
      id: agent.id,
      kind: "agent",
      label: agent.label,
      sub: agent.sub,
      status: agent.status,
      selected: agent.selected,
      color: statusColor(agent.status),
      radius: 0.55,
      position: freeSlots[i],
    });
  });

  const byId = new Map(nodes.map((n) => [n.id, n]));
  const edges: UniverseEdge[] = [];
  const seen = new Set<string>();
  const pushRoad = (edge: GraphEdge, from: UniverseNode, to: UniverseNode) => {
    if (seen.has(edge.id)) return;
    seen.add(edge.id);
    edges.push({
      id: edge.id,
      kind: edge.kind,
      from: from.id,
      to: to.id,
      active: edge.active,
      color: edgeColor(edge.kind, edge.active),
      a: from.position,
      b: to.position,
      c: roadCurve(from.position, to.position),
    });
  };

  for (const edge of graph.edges) {
    const from = byId.get(edge.from);
    const to = byId.get(edge.to);
    if (!from || !to) continue;
    // Agent-to-tower spurs stay local to the plot; the plaza avenue is drawn
    // once per department so the skyline is readable from the core outward.
    pushRoad(edge, from, to);
  }

  // Every tower needs a physical link to the plaza even when the bridge only
  // reported the department (no seat edges yet): that is a real driveway, not
  // a fabricated relationship, and it is drawn as an inactive road.
  for (const dept of departments) {
    const tower = byId.get(dept.id);
    const core = byId.get(CORE_ID);
    if (!tower || !core) continue;
    if (edges.some((e) => (e.from === dept.id || e.to === dept.id) && (e.from === CORE_ID || e.to === CORE_ID)))
      continue;
    edges.push({
      id: `${CORE_ID}->${dept.id}:drive`,
      kind: "orchestration",
      from: CORE_ID,
      to: dept.id,
      active: false,
      color: edgeColor("orchestration", false),
      a: core.position,
      b: tower.position,
      c: roadCurve(core.position, tower.position),
    });
  }

  return { nodes, edges, byId };
}

/** Tower massing per department, keyed by node id. */
export function towerMetas(graph: Graph, model: UniverseModel): Map<string, TowerMeta> {
  const metas = new Map<string, TowerMeta>();
  for (const node of model.nodes) {
    if (node.kind !== "department") continue;
    const seats = graph.edges.filter(
      (e) => e.kind === "seat" && (e.from === node.id || e.to === node.id),
    ).length;
    const agents = model.nodes.filter((n) => n.kind === "agent" && n.position && near(node.position, n.position, CITY.block)).length;
    const live = node.status === "live" || node.status === "busy";
    const meta = towerMeta(seats || agents, live);
    metas.set(node.id, { ...meta, agents, liveAgents: live ? 1 : 0 });
  }
  return metas;
}

function near(a: Vec3, b: Vec3, radius: number): boolean {
  return Math.hypot(a.x - b.x, a.z - b.z) <= radius;
}
