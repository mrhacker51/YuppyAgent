/**
 * `submitTasks` contract. The HUD no longer has a prompt composer (commands
 * go to the lead Claude terminal, which dispatches over MCP), but the store
 * keeps its operator-side `task_submit` path: one batch becomes one task per
 * CLI, Claude Code first as the primary executor.
 *
 * These tests pin the frame that leaves the browser for that flow — the
 * ordering and role fields the bridge's task runner reads — plus the two
 * refusal paths that must never put a half-built batch on the wire.
 *
 * The literals mirror `crates/yuppycode-protocol` (`TaskSpecDto`) and the
 * shared fan-out composer in `src/lib/composer.ts`.
 */
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { connectBridge, hud, resetHud, useHudStore } from "./helpers/dom-env";
import type { TaskSpecDto } from "@/lib/protocol";

beforeEach(() => {
  resetHud();
});

/** Exactly what composer.ts builds for a two-CLI mission: Claude first. */
function mission(prompt: string): TaskSpecDto[] {
  return [
    {
      id: "main-1-claude-code",
      title: prompt,
      prompt,
      cli: "claude-code",
      department: "software-development",
      role: "primary",
      isolation: "worktree",
    },
    {
      id: "aux-1-codex",
      title: prompt,
      prompt,
      cli: "codex",
      department: "software-development",
      role: "parallel",
      isolation: "worktree",
    },
  ];
}

test("one mission prompt puts Claude Code first as the primary executor", () => {
  const socket = connectBridge();
  assert.equal(
    useHudStore.getState().submitTasks(mission("görev: README düzelt")),
    true,
  );

  const frame = socket.lastRequest();
  assert.ok(frame, "task_submit frame captured");
  assert.equal(frame.type, "task_submit");
  const tasks = frame.tasks as TaskSpecDto[];
  assert.deepEqual(
    tasks.map((t) => [t.cli, t.role]),
    [
      ["claude-code", "primary"],
      ["codex", "parallel"],
    ],
    "the Claude task must lead the batch and own the primary role",
  );
  assert.equal(
    new Set(tasks.map((t) => t.prompt)).size,
    1,
    "one prompt, fanned out",
  );
  assert.equal(
    tasks[0].prompt,
    "görev: README düzelt",
    "the text is sent untouched",
  );
});

test("a mission keeps its title and per-task role visible in the task rows", () => {
  connectBridge();
  useHudStore.getState().submitTasks(mission("görev: README düzelt"));
  assert.deepEqual(hud().tasks["main-1-claude-code"], {
    id: "main-1-claude-code",
    title: "görev: README düzelt",
    state: "queued",
    detail: "primary",
    cli: "claude-code",
    department: "software-development",
    origin: "operator",
  });
  assert.equal(hud().tasks["aux-1-codex"].detail, "parallel");
});

test("worktree isolation is the default and survives the frame", () => {
  const socket = connectBridge();
  useHudStore.getState().submitTasks(mission("ship it"));
  const frame = socket.lastRequest();
  assert.ok(frame, "task_submit frame captured");
  const tasks = frame.tasks as TaskSpecDto[];
  assert.deepEqual(
    tasks.map((t) => t.isolation),
    ["worktree", "worktree"],
    "parallel CLIs must not share one checkout unless the operator opts out",
  );
});

test("a mission is never queued while the bridge is down", () => {
  useHudStore.getState().disconnect();
  assert.equal(useHudStore.getState().submitTasks(mission("ship it")), false);
  assert.deepEqual(hud().tasks, {}, "no ghost rows may appear");
  assert.match(
    hud().logs.at(-1)!.message,
    /Bridge offline/,
    "the operator is told why nothing ran",
  );
});

test("an empty batch is refused instead of an empty frame", () => {
  const socket = connectBridge();
  const before = socket.frames.length;
  assert.equal(useHudStore.getState().submitTasks([]), false);
  assert.equal(socket.frames.length, before, "nothing may reach the wire");
});
