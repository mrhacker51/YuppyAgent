/**
 * Bridge snapshot diff -> visual events.
 *
 * The renderer must react only to transitions the backend actually reported.
 * These tests cover the first-frame seeding (no replay on reload), PTY open/
 * close/activity, scheduler transitions, conflicts, new errors and bridge
 * status changes — and that unchanged snapshots emit nothing.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  createDiffState,
  diffNetwork,
  type DiffInput,
  type DiffState,
  type NetworkEvent,
} from "@/lib/networkEvents";
import type { TaskStateDto } from "@/lib/protocol";

function input(over: Partial<DiffInput> = {}): DiffInput {
  return {
    sessions: [],
    tasks: {},
    conflicts: [],
    logs: [],
    status: "connected",
    ...over,
  };
}

function seed(over: Partial<DiffInput> = {}): DiffState {
  return diffNetwork(createDiffState(), input(over)).next;
}

function task(id: string, state: TaskStateDto, cli = "claude-code") {
  return { id, state, cli };
}

function types(events: NetworkEvent[]): string[] {
  return events.map((e) => e.type);
}

test("the first snapshot only seeds state and replays no history", () => {
  const { events, next } = diffNetwork(
    createDiffState(),
    input({
      sessions: [{ id: "s1", agent: "claude-code" }],
      tasks: { t1: task("t1", "completed") },
      conflicts: [{ taskA: "a", taskB: "b" }],
      logs: [{ level: "error", ts: 10 }],
    }),
  );
  assert.deepEqual(events, []);
  assert.equal(next.booted, true);
  assert.equal(next.sessionIds.has("s1"), true);
  assert.equal(next.taskStates.get("t1"), "completed");
});

test("identical consecutive snapshots emit nothing", () => {
  const first = seed({
    sessions: [{ id: "s1", agent: "claude-code", generation: 1 }],
    tasks: { t1: task("t1", "running") },
  });
  const { events } = diffNetwork(
    first,
    input({
      sessions: [{ id: "s1", agent: "claude-code", generation: 1 }],
      tasks: { t1: task("t1", "running") },
    }),
  );
  assert.deepEqual(events, []);
});

test("session open/close and PTY generation bumps become events", () => {
  const first = seed({ sessions: [{ id: "s1", agent: "claude-code", generation: 1 }] });
  const opened = diffNetwork(
    first,
    input({
      sessions: [
        { id: "s1", agent: "claude-code", generation: 1 },
        { id: "s2", agent: "codex", generation: 0 },
      ],
    }),
  );
  assert.deepEqual(opened.events, [
    { type: "session_open", sessionId: "s2", agent: "codex" },
  ]);

  const activity = diffNetwork(
    opened.next,
    input({
      sessions: [
        { id: "s1", agent: "claude-code", generation: 2 },
        { id: "s2", agent: "codex", generation: 0 },
      ],
    }),
  );
  assert.deepEqual(activity.events, [
    { type: "activity", sessionId: "s1", agent: "claude-code" },
  ]);

  const closed = diffNetwork(activity.next, input({ sessions: [] }));
  assert.deepEqual(
    closed.events
      .filter((e) => e.type === "session_close")
      .map((e) => e.type),
    ["session_close", "session_close"],
  );
  const agents = closed.events
    .filter((e): e is Extract<NetworkEvent, { type: "session_close" }> => e.type === "session_close")
    .map((e) => e.agent)
    .sort();
  assert.deepEqual(agents, ["claude-code", "codex"]);
});

test("only task state transitions emit, including failures", () => {
  const first = seed({ tasks: { t1: task("t1", "running") } });
  const changed = diffNetwork(
    first,
    input({ tasks: { t1: task("t1", "completed") } }),
  );
  assert.deepEqual(changed.events, [
    { type: "task", taskId: "t1", cli: "claude-code", state: "completed" },
  ]);

  const failed = diffNetwork(
    changed.next,
    input({ tasks: { t1: task("t1", "failed") } }),
  );
  assert.deepEqual(types(failed.events), ["task"]);
  const event = failed.events[0];
  assert.equal(event.type, "task");
  if (event.type === "task") assert.equal(event.state, "failed");

  const noCli = diffNetwork(seed(), input({ tasks: { t2: { id: "t2", state: "running" } } }));
  assert.deepEqual(noCli.events, [], "tasks without an executor cannot be mapped to a node");
});

test("growing conflict list emits one event per new conflict", () => {
  const first = seed({ conflicts: [{ taskA: "a", taskB: "b" }] });
  const grown = diffNetwork(
    first,
    input({
      conflicts: [
        { taskA: "a", taskB: "b" },
        { taskA: "c", taskB: "d" },
        { taskA: "e", taskB: "f" },
      ],
    }),
  );
  assert.deepEqual(grown.events, [
    { type: "conflict", taskA: "c", taskB: "d" },
    { type: "conflict", taskA: "e", taskB: "f" },
  ]);
});

test("a newer error log and a status change are reported once", () => {
  const first = seed({ logs: [{ level: "error", ts: 10 }], status: "connected" });
  const errored = diffNetwork(
    first,
    input({ logs: [{ level: "error", ts: 12 }], status: "connected" }),
  );
  assert.deepEqual(errored.events, [{ type: "error" }]);

  const stable = diffNetwork(
    errored.next,
    input({ logs: [{ level: "error", ts: 12 }], status: "connected" }),
  );
  assert.deepEqual(stable.events, []);

  const offline = diffNetwork(
    stable.next,
    input({ logs: [{ level: "error", ts: 12 }], status: "disconnected" }),
  );
  assert.deepEqual(offline.events, [
    { type: "status", status: "disconnected" },
  ]);

  const older = diffNetwork(
    seed({ logs: [{ level: "error", ts: 10 }] }),
    input({ logs: [{ level: "info", ts: 99 }] }),
  );
  assert.deepEqual(older.events, [], "info logs are not errors");
});
