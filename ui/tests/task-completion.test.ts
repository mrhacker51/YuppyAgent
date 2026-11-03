/**
 * The completion banner may only fire on a transition we actually witnessed.
 * Reloading a finished board, reconnecting, or receiving a snapshot that is
 * already complete must stay silent — otherwise the UI invents history.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { newlyCompleted } from "@/lib/taskCompletion";
import type { Task } from "@/lib/store";

const task = (id: string, state: Task["state"], title?: string): Task => ({ id, state, title });

test("a running task that completes is reported once", () => {
  const out = newlyCompleted({ a: task("a", "running", "ui: pano") }, { a: task("a", "completed", "ui: pano") });
  assert.deepEqual(out, [{ id: "a", title: "ui: pano" }]);
});

test("a task already complete on first sight is not reported", () => {
  assert.deepEqual(newlyCompleted(undefined, { a: task("a", "completed") }), []);
  assert.deepEqual(newlyCompleted({}, { a: task("a", "completed") }), []);
});

test("staying complete never re-fires", () => {
  const done = { a: task("a", "completed", "x") };
  assert.deepEqual(newlyCompleted(done, { ...done }), []);
});

test("failed and cancelled are not completions", () => {
  assert.deepEqual(newlyCompleted({ a: task("a", "running") }, { a: task("a", "failed") }), []);
  assert.deepEqual(newlyCompleted({ a: task("a", "running") }, { a: task("a", "cancelled") }), []);
});

test("an untitled task falls back to its id, never an empty banner", () => {
  const out = newlyCompleted({ a: task("a", "queued") }, { a: task("a", "completed", "   ") });
  assert.equal(out[0].title, "a");
});

test("several completions in one update are all reported in order", () => {
  const prev = { a: task("a", "running"), b: task("b", "queued"), c: task("c", "completed") };
  const out = newlyCompleted(prev, {
    a: task("a", "completed", "one"),
    b: task("b", "completed", "two"),
    c: task("c", "completed", "three"),
  });
  assert.deepEqual(
    out.map((t) => t.id),
    ["a", "b"],
  );
});
