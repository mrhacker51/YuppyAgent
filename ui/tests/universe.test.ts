/**
 * 3D universe model contract.
 *
 * These tests pin down the pure geometry behind the R3F scene: node/edge
 * derivation from the real graph, quadratic curves, force settling, honest
 * stats and the task-state -> effect mapping the brief asked for. Nothing
 * here renders WebGL, so it runs under plain `node --test`.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  UNIVERSE,
  UNIVERSE_COLORS,
  createBodies,
  curveControl,
  edgeColor,
  flowDirection,
  forceStep,
  graphStats,
  hexToRgb,
  project2D,
  quadratic3,
  sampleCurve,
  statusColor,
  syncBodies,
  taskEdgeId,
  taskStateFx,
  toneColor,
  universeFromGraph,
  type UniverseModel,
} from "@/lib/universe";
import { CORE_ID, type Graph, type GraphNode } from "@/lib/networkGraph";

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

function graph(over: Partial<Graph> = {}): Graph {
  return {
    nodes: [
      node({ id: CORE_ID, kind: "core", status: "live" }),
      node({ id: "dept:dev", kind: "department", tx: 6, ty: 0 }),
      node({ id: "agent:claude-code", kind: "agent", tx: 3, ty: 2, status: "busy" }),
    ],
    edges: [
      {
        id: `${CORE_ID}->dept:dev:orchestration`,
        from: CORE_ID,
        to: "dept:dev",
        kind: "orchestration",
        active: true,
      },
      {
        id: "dept:dev->agent:claude-code:seat",
        from: "dept:dev",
        to: "agent:claude-code",
        kind: "seat",
        active: true,
      },
    ],
    ...over,
  };
}

test("core sits at the origin plan, departments on the outer ring, agents inside", () => {
  const model = universeFromGraph(graph());
  const core = model.byId.get(CORE_ID);
  assert.ok(core);
  assert.deepEqual(core.position, { x: 0, y: UNIVERSE.coreY, z: 0 });

  const dept = model.byId.get("dept:dev");
  assert.ok(dept);
  const deptRadius = Math.hypot(dept.position.x, dept.position.z);
  assert.ok(Math.abs(deptRadius - UNIVERSE.deptRadius) < 0.001);

  const agent = model.byId.get("agent:claude-code");
  assert.ok(agent);
  const agentRadius = Math.hypot(agent.position.x, agent.position.z);
  assert.ok(Math.abs(agentRadius - UNIVERSE.agentRadius) < 0.001);
  assert.ok(agentRadius < deptRadius, "agents orbit inside the department ring");
});

test("edges keep only real endpoints and carry a curve that lifts between nodes", () => {
  const g = graph({
    edges: [
      {
        id: "core->dept:dev:orchestration",
        from: CORE_ID,
        to: "dept:dev",
        kind: "orchestration",
        active: true,
      },
      {
        id: "dangling",
        from: CORE_ID,
        to: "dept:missing",
        kind: "seat",
        active: false,
      },
    ],
  });
  const model = universeFromGraph(g);
  assert.equal(model.edges.length, 1, "edge with a missing endpoint is dropped");
  const edge = model.edges[0];
  const points = sampleCurve(edge, 8);
  assert.equal(points.length, 9);
  assert.deepEqual(points[0], edge.a);
  assert.deepEqual(points[8], edge.b);
  const apex = Math.max(...points.map((p) => p.y));
  assert.ok(apex > Math.max(edge.a.y, edge.b.y), "curve arcs above both endpoints");
});

test("quadratic helpers clamp t and project deterministically to 2D", () => {
  const a = { x: 0, y: 0, z: 0 };
  const c = { x: 1, y: 2, z: 0 };
  const b = { x: 2, y: 0, z: 0 };
  assert.deepEqual(quadratic3(a, c, b, 0), a);
  assert.deepEqual(quadratic3(a, c, b, 1), b);
  assert.deepEqual(quadratic3(a, c, b, 2), b, "t above 1 clamps to the end");
  assert.deepEqual(quadratic3(a, c, b, -1), a, "t below 0 clamps to the start");
  assert.deepEqual(project2D({ x: 1, y: 0, z: 2 }, 10), { x: 10, y: 20 });
  const control = curveControl(a, b, "seed");
  assert.equal(Number.isFinite(control.x + control.y + control.z), true);
  assert.ok(control.y > 0);
});

test("status and edge colours follow the requested semantics", () => {
  assert.equal(statusColor("live"), UNIVERSE_COLORS.ok);
  assert.equal(statusColor("busy"), UNIVERSE_COLORS.accent);
  assert.equal(statusColor("failed"), UNIVERSE_COLORS.danger);
  assert.equal(edgeColor("conflict", false), UNIVERSE_COLORS.danger);
  assert.equal(edgeColor("task", true), UNIVERSE_COLORS.ok);
  assert.equal(edgeColor("seat", false), UNIVERSE_COLORS.idle);
});

test("active agent-to-agent edges flow in both directions", () => {
  const forward: Array<1 | -1> = [];
  for (let i = 0; i < 6; i++) {
    forward.push(flowDirection({ kind: "seat", active: true }, i));
  }
  assert.ok(forward.includes(1));
  assert.ok(forward.includes(-1));
  assert.equal(flowDirection({ kind: "seat", active: false }, 1), 1);

  const task: Array<1 | -1> = [];
  for (let i = 0; i < 8; i++) task.push(flowDirection({ kind: "task", active: true }, i));
  assert.ok(task.includes(-1), "task edges also report back");
});

test("force simulation converges on targets and keeps momentum across topology changes", () => {
  const model = universeFromGraph(graph());
  const bodies = createBodies(model, "core");
  const agentBody = bodies.find((b) => b.id === "agent:claude-code");
  assert.ok(agentBody);
  const start = Math.hypot(agentBody.x - agentBody.tx, agentBody.z - agentBody.tz);
  for (let i = 0; i < 900; i++) forceStep(bodies, 0.016);
  const end = Math.hypot(agentBody.x - agentBody.tx, agentBody.z - agentBody.tz);
  assert.ok(end < start * 0.1, `body should settle (${start} -> ${end})`);
  assert.ok(Number.isFinite(agentBody.x + agentBody.y + agentBody.z));
});

test("syncBodies spawns new nodes at the core and drops removed ones", () => {
  const first = universeFromGraph(graph());
  const bodies = createBodies(first, "target");
  bodies[0].pinned = { x: 1, y: 2, z: 3 };

  const grown = universeFromGraph(
    graph({
      nodes: [
        ...graph().nodes,
        node({ id: "agent:codex", kind: "agent", tx: -3, ty: 2 }),
      ],
    }),
  );
  const result = syncBodies(bodies, grown);
  assert.deepEqual(result.spawned, ["agent:codex"]);
  assert.deepEqual(result.removed, []);
  const spawned = result.bodies.find((b) => b.id === "agent:codex");
  assert.ok(spawned);
  assert.equal(spawned.x, 0);
  assert.equal(spawned.y, UNIVERSE.coreY);
  assert.deepEqual(result.bodies[0].pinned, { x: 1, y: 2, z: 3 }, "pin survives sync");

  const shrunk = syncBodies(result.bodies, first);
  assert.deepEqual(shrunk.removed, ["agent:codex"]);
  assert.equal(shrunk.bodies.length, first.nodes.length);
});

test("graph stats and task effects report only what happened", () => {
  const stats = graphStats(graph());
  assert.equal(stats.departments, 1);
  assert.equal(stats.agents, 1);
  assert.equal(stats.live, 1);
  assert.equal(stats.busy, 1);
  assert.equal(stats.completed, 0);
  assert.equal(stats.failed, 0);

  const idle = taskStateFx("queued");
  assert.equal(idle.flash, false);
  assert.equal(idle.glitch, false);
  assert.ok(idle.nodePulse > 0);

  const running = taskStateFx("running");
  assert.equal(running.bidirectional, true);
  assert.ok(running.edgePulse > 0);

  const completed = taskStateFx("completed");
  assert.equal(completed.tone, "ok");
  assert.equal(completed.flash, true);
  assert.ok(completed.burst > 0);

  const failed = taskStateFx("failed");
  assert.equal(failed.tone, "danger");
  assert.equal(failed.glitch, true);

  const unknown = taskStateFx("cancelled");
  assert.equal(unknown.flash, false);
  assert.equal(unknown.corePulse, 0);
});

test("tone helpers and hex parsing stay within the palette", () => {
  assert.equal(toneColor("ok"), UNIVERSE_COLORS.ok);
  assert.equal(toneColor("danger"), UNIVERSE_COLORS.danger);
  assert.equal(taskEdgeId("claude-code"), `${CORE_ID}->agent:claude-code:task`);
  assert.deepEqual(hexToRgb("#22c55e"), [0x22 / 255, 0xc5 / 255, 0x5e / 255]);
  assert.deepEqual(hexToRgb("#fff"), [1, 1, 1]);
  const model: UniverseModel = universeFromGraph(graph());
  assert.equal(model.byId.size, model.nodes.length);
});
