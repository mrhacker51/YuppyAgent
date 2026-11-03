/**
 * Network graph contract: which nodes/edges the map may draw. The hard rule
 * is honesty — an edge exists only when the bridge data actually contains
 * the relationship (role seat, live session department, task executor,
 * reported conflict). Nothing here fabricates agents or connections.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  AGENT_RING_R,
  CORE_ID,
  DEPT_RING_R,
  agentNodeId,
  bezierControl,
  bezierPoint,
  buildGraph,
  deptNodeId,
  layoutNodes,
  partialPath,
  sampleBezier,
  type GraphInput,
} from "@/lib/networkGraph";
import type { AgentStatusDto, DepartmentDto } from "@/lib/protocol";

function dept(id: string, over: Partial<DepartmentDto> = {}): DepartmentDto {
  return { id, name: id, max_concurrency: 1, enabled: true, ...over };
}

function agent(id: string, over: Partial<AgentStatusDto> = {}): AgentStatusDto {
  return { id, display_name: id, available: true, ...over };
}

function input(over: Partial<GraphInput> = {}): GraphInput {
  return {
    departments: [],
    agents: [],
    sessions: [],
    tasks: {},
    conflicts: [],
    selectedDept: "",
    selectedAgent: "",
    ...over,
  };
}

test("core is always present and departments get real orchestration edges", () => {
  const graph = buildGraph(
    input({
      departments: [dept("software-development"), dept("research", { enabled: false })],
    }),
  );
  assert.equal(graph.nodes.filter((n) => n.kind === "core").length, 1);
  assert.ok(graph.nodes.some((n) => n.id === CORE_ID));
  const orchestration = graph.edges.filter((e) => e.kind === "orchestration");
  assert.equal(orchestration.length, 2);
  const researchEdge = orchestration.find((e) => e.to === deptNodeId("research"));
  assert.equal(researchEdge?.active, false, "disabled department edge is not active");
});

test("seat edges appear only for roles whose cli matches a detected agent", () => {
  const graph = buildGraph(
    input({
      departments: [
        dept("software-development", {
          roles: [
            { id: "backend", name: "Backend", cli: "claude-code" },
            { id: "qa", name: "QA", cli: "codex" },
            { id: "ghost", name: "Ghost", cli: "unknown-cli" },
          ],
        }),
      ],
      agents: [agent("claude-code"), agent("codex")],
    }),
  );
  const seats = graph.edges.filter((e) => e.kind === "seat");
  assert.deepEqual(
    seats.map((e) => e.to).sort(),
    [agentNodeId("claude-code"), agentNodeId("codex")].sort(),
  );
  assert.ok(!seats.some((e) => e.to === agentNodeId("unknown-cli")));
});

test("live sessions anchor their agent under the requested department", () => {
  const graph = buildGraph(
    input({
      departments: [dept("research")],
      agents: [agent("claude-code")],
      sessions: [{ id: "s1", agent: "claude-code", department: "research" }],
    }),
  );
  const seat = graph.edges.find(
    (e) => e.kind === "seat" && e.to === agentNodeId("claude-code"),
  );
  assert.ok(seat, "session department produces a seat edge");
  assert.equal(seat?.active, true);
  const node = graph.nodes.find((n) => n.id === agentNodeId("claude-code"));
  assert.equal(node?.status, "live");
});

test("task edges exist only for known executors, active while queued/running", () => {
  const graph = buildGraph(
    input({
      agents: [agent("claude-code"), agent("codex")],
      tasks: {
        t1: { id: "t1", state: "running", cli: "claude-code" },
        t2: { id: "t2", state: "completed", cli: "codex" },
        t3: { id: "t3", state: "queued", cli: "gone" },
      },
    }),
  );
  const taskEdges = graph.edges.filter((e) => e.kind === "task");
  assert.equal(taskEdges.length, 2);
  assert.equal(taskEdges.find((e) => e.to === agentNodeId("claude-code"))?.active, true);
  assert.equal(taskEdges.find((e) => e.to === agentNodeId("codex"))?.active, false);
});

test("a reported conflict connects the two real executors", () => {
  const graph = buildGraph(
    input({
      agents: [agent("claude-code"), agent("codex")],
      tasks: {
        a: { id: "a", state: "completed", cli: "claude-code" },
        b: { id: "b", state: "completed", cli: "codex" },
      },
      conflicts: [{ taskA: "a", taskB: "b" }],
    }),
  );
  const conflict = graph.edges.find((e) => e.kind === "conflict");
  assert.ok(conflict);
  assert.deepEqual(
    [conflict?.from, conflict?.to].sort(),
    [agentNodeId("claude-code"), agentNodeId("codex")].sort(),
  );
});

test("node status reflects real availability and scheduler state", () => {
  const graph = buildGraph(
    input({
      agents: [agent("claude-code"), agent("codex", { available: false })],
      tasks: {
        t1: { id: "t1", state: "failed", cli: "claude-code" },
      },
    }),
  );
  const claude = graph.nodes.find((n) => n.id === agentNodeId("claude-code"));
  const codex = graph.nodes.find((n) => n.id === agentNodeId("codex"));
  assert.equal(claude?.status, "failed");
  assert.equal(codex?.status, "offline");
});

test("layout puts the core at the origin and rings at their radii", () => {
  const graph = buildGraph(
    input({
      departments: [dept("a"), dept("b"), dept("c")],
      agents: [agent("claude-code"), agent("codex")],
    }),
  );
  const core = graph.nodes.find((n) => n.kind === "core");
  assert.equal(core?.tx, 0);
  assert.equal(core?.ty, 0);
  for (const node of graph.nodes.filter((n) => n.kind === "department")) {
    assert.ok(Math.abs(Math.hypot(node.tx, node.ty) - DEPT_RING_R) < 1e-6);
  }
  for (const node of graph.nodes.filter((n) => n.kind === "agent")) {
    assert.ok(Math.abs(Math.hypot(node.tx, node.ty) - AGENT_RING_R) < 1e-6);
  }
});

test("bezier helpers stay on the sampled curve (particles follow the path)", () => {
  const a = { x: -100, y: 0 };
  const b = { x: 100, y: 0 };
  const c = bezierControl(a, b, 0.3);
  assert.ok(c.y > 0, "positive curvature bends the control point");
  assert.deepEqual(bezierPoint(a, c, b, 0), a);
  assert.deepEqual(bezierPoint(a, c, b, 1), b);
  const samples = sampleBezier(a, c, b, 12);
  assert.equal(samples.length, 13);
  assert.deepEqual(samples[0], a);
  assert.deepEqual(samples[12], b);
  const half = partialPath(samples, 0.5);
  assert.ok(half.length >= 6);
  assert.deepEqual(partialPath(samples, 0), []);
});

test("layoutNodes is deterministic and stable for the same input", () => {
  const one = buildGraph(input({ departments: [dept("a"), dept("b")] }));
  const two = buildGraph(input({ departments: [dept("a"), dept("b")] }));
  assert.deepEqual(
    one.nodes.map((n) => [n.id, n.tx, n.ty]),
    two.nodes.map((n) => [n.id, n.tx, n.ty]),
  );
  layoutNodes(one.nodes);
  assert.ok(Number.isFinite(one.nodes[0].tx));
});
