/**
 * Office-city model contract.
 *
 * The city is a presentation of real bridge state only: towers are the
 * departments the backend reported, pods are the detected agents, roads come
 * from real seat/orchestration edges. These tests pin the honest derivation,
 * deterministic placement and the plaza clearance so no renderer can invent
 * buildings or fabricate streets.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  CITY,
  cityFromGraph,
  openFloorSlots,
  podSlots,
  towerMeta,
  towerMetas,
  towerPlots,
} from "@/lib/city";
import { CORE_ID, type Graph, type GraphEdge, type GraphNode } from "@/lib/networkGraph";

function node(over: Partial<GraphNode> & Pick<GraphNode, "id" | "kind">): GraphNode {
  return {
    label: over.id,
    sub: "",
    status: "idle",
    selected: false,
    tx: 0,
    ty: 0,
    ...over,
  };
}

function edge(id: string, from: string, to: string, kind: GraphEdge["kind"], active = true): GraphEdge {
  return { id, from, to, kind, active };
}

function cityGraph(over: Partial<Graph> = {}): Graph {
  return {
    nodes: [
      node({ id: CORE_ID, kind: "core", status: "live" }),
      node({ id: "dept:dev", kind: "department", status: "live" }),
      node({ id: "dept:qa", kind: "department" }),
      node({ id: "agent:claude-code", kind: "agent", status: "busy" }),
      node({ id: "agent:codex", kind: "agent", status: "ready" }),
    ],
    edges: [
      edge(`${CORE_ID}->dept:dev:orchestration`, CORE_ID, "dept:dev", "orchestration"),
      edge(`${CORE_ID}->dept:qa:orchestration`, CORE_ID, "dept:qa", "orchestration", false),
      edge("dept:dev->agent:claude-code:seat", "dept:dev", "agent:claude-code", "seat"),
    ],
    ...over,
  };
}

test("towers are placed on distinct avenue plots outside the plaza", () => {
  const plots = towerPlots(7);
  assert.equal(plots.length, 7);
  const seen = new Set(plots.map((p) => `${p.x}:${p.z}`));
  assert.equal(seen.size, 7, "no two towers share a plot");
  for (const plot of plots) {
    assert.ok(Math.abs(plot.x) >= CITY.block, "plots line the avenues, never the plaza");
  }
});

test("the city only contains what the bridge reported", () => {
  const model = cityFromGraph(cityGraph());
  assert.deepEqual(
    model.nodes.map((n) => n.id).sort(),
    [
      CORE_ID,
      "agent:claude-code",
      "agent:codex",
      "dept:dev",
      "dept:qa",
    ].sort(),
  );
  const core = model.byId.get(CORE_ID);
  assert.ok(core);
  assert.deepEqual(core.position, { x: 0, y: CITY.ground, z: 0 }, "core sits on the plaza");
});

test("roads derive from real edges; every tower is connected to the plaza", () => {
  // QA reported without any core edge: only a non-active driveway may appear.
  const orphan = cityGraph({
    edges: [
      edge(`${CORE_ID}->dept:dev:orchestration`, CORE_ID, "dept:dev", "orchestration"),
      edge("dept:dev->agent:claude-code:seat", "dept:dev", "agent:claude-code", "seat"),
    ],
  });
  const model = cityFromGraph(orphan);
  const roadIds = new Set(model.edges.map((e) => e.id));
  assert.ok(roadIds.has(`${CORE_ID}->dept:dev:orchestration`));
  assert.ok(roadIds.has("dept:dev->agent:claude-code:seat"));
  // The orphan QA department still gets exactly one non-active driveway.
  const driveway = model.edges.find((e) => e.id.endsWith(":drive"));
  assert.ok(driveway);
  assert.equal(driveway.to, "dept:qa");
  assert.equal(driveway.active, false, "a driveway is never drawn as live traffic");
  assert.equal(model.edges.filter((e) => e.id.endsWith(":drive")).length, 1);
  // Departments already reported with a real core edge get no invented extra road.
  const full = cityFromGraph(cityGraph());
  assert.equal(full.edges.filter((e) => e.id.endsWith(":drive")).length, 0);
  // All road endpoints exist.
  for (const road of full.edges) {
    assert.ok(model.byId.has(road.from) && full.byId.has(road.to));
  }
});

test("roads are flat: every curve point stays at street level", () => {
  const model = cityFromGraph(cityGraph());
  for (const road of model.edges) {
    assert.equal(road.a.y, CITY.ground);
    assert.equal(road.b.y, CITY.ground);
    assert.equal(road.c.y, CITY.ground, "control point on the ground keeps the road flat");
  }
});

test("agents park at their department tower, unattached ones on the open floor", () => {
  const model = cityFromGraph(cityGraph());
  const attached = model.byId.get("agent:claude-code");
  const tower = model.byId.get("dept:dev");
  assert.ok(attached && tower);
  const dist = Math.hypot(attached.position.x - tower.position.x, attached.position.z - tower.position.z);
  assert.ok(dist <= CITY.block / 2, "seat edge pulls the pod next to its tower");
  assert.ok(dist >= 1, "pods never spawn inside the building");

  const homeless = model.byId.get("agent:codex");
  assert.ok(homeless);
  for (const dept of model.nodes.filter((n) => n.kind === "department")) {
    const d = Math.hypot(homeless.position.x - dept.position.x, homeless.position.z - dept.position.z);
    assert.ok(d > CITY.block / 2, "an agent without a seat edge is not parked at a tower");
  }
});

test("placement is deterministic: the same state yields the same city", () => {
  const first = cityFromGraph(cityGraph());
  const second = cityFromGraph(cityGraph());
  assert.deepEqual(
    first.nodes.map((n) => [n.id, n.position]),
    second.nodes.map((n) => [n.id, n.position]),
  );
  const slots = podSlots({ x: 9.5, y: 0, z: 0 }, 3, "dept:dev");
  assert.deepEqual(slots, podSlots({ x: 9.5, y: 0, z: 0 }, 3, "dept:dev"));
});

test("open floor slots never overlap", () => {
  const slots = openFloorSlots(8);
  assert.equal(slots.length, 8);
  const seen = new Set(slots.map((s) => `${s.x}:${s.z}`));
  assert.equal(seen.size, 8);
});

test("tower massing follows real seats and live PTYs only", () => {
  const idle = towerMeta(3, false);
  const live = towerMeta(3, true);
  assert.ok(live.height > idle.height, "a live tower grows a taller spire");
  assert.equal(towerMeta(0, false).floors, 1, "a reported department is at least one floor");
  assert.ok(towerMeta(99, true).height <= CITY.maxTowerHeight);

  const model = cityFromGraph(cityGraph());
  const metas = towerMetas(cityGraph(), model);
  const dev = metas.get("dept:dev");
  assert.ok(dev);
  assert.equal(dev.roles, 1, "one real seat edge -> one floor");
  assert.equal(dev.liveAgents, 1, "dept:dev is live in the fixture");
  assert.equal(metas.get("dept:qa")?.roles, 0, "QA has no seats: massing stays flat");
});
