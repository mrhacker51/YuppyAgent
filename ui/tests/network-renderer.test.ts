/**
 * Renderer smoke test: run the real `renderFrame` against a recording canvas
 * double. This proves the whole paint path (grid, edges, flows, core, labels,
 * pulses) executes, that particles advance along the connection geometry, and
 * that static/reduced-motion mode stops the animation clock.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { buildGraph, agentNodeId, CORE_ID } from "@/lib/networkGraph";
import { resolveEffects, DEFAULT_SETTINGS } from "@/lib/effects";
import {
  COLORS,
  createFx,
  emphasizeEdge,
  hitTest,
  renderFrame,
  resetCamera,
  type Viewport,
} from "@/lib/networkRenderer";

const VIEW: Viewport = { w: 800, h: 600, dpr: 1 };

type Call = { name: string; args: unknown[] };

function fakeContext(): { ctx: CanvasRenderingContext2D; calls: Call[] } {
  const calls: Call[] = [];
  const gradient = { addColorStop: () => undefined };
  const target: Record<string, unknown> = {};
  const ctx = new Proxy(target, {
    get(t, prop: string) {
      if (prop === "createRadialGradient" || prop === "createConicGradient") {
        return () => gradient;
      }
      if (prop in t) return t[prop];
      return (...args: unknown[]) => {
        calls.push({ name: prop, args });
        return undefined;
      };
    },
    set(t, prop: string, value) {
      t[prop] = value;
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;
  return { ctx, calls };
}

function graphFixture() {
  return buildGraph({
    departments: [
      {
        id: "software-development",
        name: "Software Development",
        max_concurrency: 3,
        enabled: true,
        roles: [
          { id: "backend", name: "Backend", cli: "claude-code" },
          { id: "qa", name: "QA", cli: "codex" },
        ],
      },
    ],
    agents: [
      { id: "claude-code", display_name: "Claude Code", available: true },
      { id: "codex", display_name: "Codex", available: true },
    ],
    sessions: [{ id: "s1", agent: "claude-code", department: "software-development" }],
    tasks: { t1: { id: "t1", state: "running", cli: "claude-code" } },
    conflicts: [],
    selectedDept: "software-development",
    selectedAgent: "claude-code",
  });
}

test("renderFrame paints a full frame without throwing", () => {
  const graph = graphFixture();
  const fx = createFx();
  const camera = resetCamera(VIEW);
  const resolved = resolveEffects(DEFAULT_SETTINGS, false);
  const { ctx, calls } = fakeContext();
  renderFrame(ctx, VIEW, camera, graph, fx, resolved, "connected", 1000, 0.016, null);
  assert.ok(calls.some((c) => c.name === "fillText"), "labels/readouts are drawn");
  assert.ok(calls.some((c) => c.name === "arc"), "nodes/core arcs are drawn");
  assert.equal(fx.nodes.size, graph.nodes.length);
  assert.ok(fx.edgeBorn.size > 0, "edges get a reveal timestamp");
});

test("flows advance along the curve and stay in [0,1]", () => {
  const graph = graphFixture();
  const fx = createFx();
  const camera = resetCamera(VIEW);
  const resolved = resolveEffects(DEFAULT_SETTINGS, false);
  const { ctx } = fakeContext();
  const taskEdge = graph.edges.find(
    (e) => e.kind === "task" && e.to === agentNodeId("claude-code"),
  );
  assert.ok(taskEdge, "fixture has an active task edge");

  emphasizeEdge(fx, taskEdge.id, COLORS.ok, 6);
  const before = fx.flows.map((f) => f.t);
  renderFrame(ctx, VIEW, camera, graph, fx, resolved, "connected", 2000, 0.5, null);
  const after = fx.flows.map((f) => f.t);
  assert.ok(after.length > 0);
  assert.ok(after.some((t, i) => t !== before[i]), "particles move along the path");
  for (const t of after) assert.ok(t >= 0 && t <= 1);
});

test("reduced motion freezes the animation clock but still paints", () => {
  const graph = graphFixture();
  const fx = createFx();
  const camera = resetCamera(VIEW);
  const resolved = resolveEffects({ ...DEFAULT_SETTINGS, reducedMotion: "on" }, false);
  const { ctx, calls } = fakeContext();
  renderFrame(ctx, VIEW, camera, graph, fx, resolved, "connected", 3000, 0.5, null);
  assert.equal(fx.spin, 0);
  assert.equal(fx.flows.length, 0);
  assert.ok(calls.length > 0, "the static graph is still painted");
});

test("hit testing resolves the core at the viewport centre", () => {
  const graph = graphFixture();
  const fx = createFx();
  const camera = resetCamera(VIEW);
  const resolved = resolveEffects(DEFAULT_SETTINGS, false);
  const { ctx } = fakeContext();
  renderFrame(ctx, VIEW, camera, graph, fx, resolved, "connected", 1000, 0.016, null);
  const node = hitTest(camera, VIEW, fx, graph, VIEW.w / 2, VIEW.h / 2);
  assert.equal(node?.id, CORE_ID);
});
