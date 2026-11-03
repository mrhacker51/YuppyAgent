/**
 * Lead terminal contract: the main command window is the team lead's real
 * interactive Claude Code PTY, asked for with `open_terminal { lead: true }`
 * and recognised by `terminal_opened { lead: true }`. The lead dispatches its
 * own work over MCP (`yuppy_dispatch`), so its tasks first reach the HUD as
 * bare `task_state` frames for ids this window never submitted — they must
 * still become visible task rows.
 *
 * Literals mirror `crates/yuppycode-protocol` (`ClientRequest::OpenTerminal`
 * / `ServerPayload::TerminalOpened` gain `lead: bool`, serde default false).
 */
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { connectBridge, hud, logsMatching, newestSocket, resetHud, useHudStore } from "./helpers/dom-env";
import type { AgentStatusDto } from "@/lib/protocol";

beforeEach(() => {
  resetHud();
  // The default startup policy auto-opens worker seats; these tests are
  // about the lead only.
  useHudStore.setState({ seatStartup: "off" });
});

const CLAUDE: AgentStatusDto = { id: "claude-code", display_name: "Claude Code", available: true };
const CODEX: AgentStatusDto = { id: "codex", display_name: "Codex", available: true };

const leadOpens = () =>
  newestSocket()
    .requests()
    .filter((f) => f.type === "open_terminal" && f.lead === true);

test("the lead PTY opens itself once Claude Code is in the inventory", () => {
  const socket = connectBridge();
  assert.equal(leadOpens().length, 0, "nothing opens before the inventory says Claude exists");
  socket.deliver({ type: "agent_inventory", agents: [CLAUDE, CODEX] });
  assert.deepEqual(leadOpens(), [
    { type: "open_terminal", agent: "claude-code", label: "Lead · Claude Code", lead: true },
  ]);
  assert.equal(hud().leadPending, true);
});

test("repeated inventory frames and manual calls never spawn a second lead", () => {
  const socket = connectBridge();
  socket.deliver({ type: "agent_inventory", agents: [CLAUDE] });
  socket.deliver({ type: "agent_inventory", agents: [CLAUDE] });
  assert.equal(useHudStore.getState().openLeadTerminal(), false, "in flight: refused");
  socket.deliver({
    type: "terminal_opened",
    session_id: "lead-1",
    agent: "claude-code",
    label: "Lead · Claude Code",
    lead: true,
  });
  assert.equal(useHudStore.getState().openLeadTerminal(), false, "live: refused");
  assert.equal(leadOpens().length, 1);
});

test("terminal_opened with lead:true sets the lead session and focus", () => {
  const socket = connectBridge();
  socket.deliver({ type: "agent_inventory", agents: [CLAUDE] });
  socket.deliver({ type: "terminal_opened", session_id: "w-1", agent: "codex", label: "Codex" });
  socket.deliver({
    type: "terminal_opened",
    session_id: "lead-1",
    agent: "claude-code",
    label: "Lead · Claude Code",
    lead: true,
  });
  assert.equal(hud().leadSessionId, "lead-1");
  assert.equal(hud().leadPending, false);
  assert.equal(hud().activeSessionId, "lead-1");
  assert.equal(hud().sessions.find((s) => s.id === "lead-1")?.lead, true);
  assert.equal(hud().sessions.find((s) => s.id === "w-1")?.lead, undefined, "workers stay workers");

  // A worker opening after the lead does not steal the command window's focus.
  socket.deliver({ type: "terminal_opened", session_id: "w-2", agent: "claude-code", label: "Claude Code" });
  assert.equal(hud().activeSessionId, "lead-1");
  assert.equal(hud().leadSessionId, "lead-1", "a plain claude seat is not the lead");
});

test("a terminal_opened without the lead flag is never taken for the lead", () => {
  const socket = connectBridge();
  socket.deliver({ type: "terminal_opened", session_id: "s-1", agent: "claude-code", label: "Claude Code" });
  assert.equal(hud().leadSessionId, undefined);
});

test("when the lead exits the HUD keeps the exit and offers a real restart", () => {
  const socket = connectBridge();
  socket.deliver({ type: "agent_inventory", agents: [CLAUDE] });
  socket.deliver({
    type: "terminal_opened",
    session_id: "lead-1",
    agent: "claude-code",
    label: "Lead · Claude Code",
    lead: true,
  });
  socket.deliver({ type: "terminal_closed", session_id: "lead-1", exit_code: 1 });
  assert.equal(hud().leadSessionId, undefined);
  assert.equal(hud().leadExit?.exitCode, 1);
  assert.equal(logsMatching("Lead Claude kapandı").length, 1);

  // Not re-spawned on its own: another inventory frame changes nothing.
  socket.deliver({ type: "agent_inventory", agents: [CLAUDE] });
  assert.equal(leadOpens().length, 1);

  // The restart action is an explicit, real open_terminal{lead}.
  assert.equal(useHudStore.getState().openLeadTerminal(), true);
  assert.equal(leadOpens().length, 2);
});

test("a fresh connection resets the lead and opens it again", () => {
  let socket = connectBridge();
  socket.deliver({ type: "agent_inventory", agents: [CLAUDE] });
  socket.deliver({
    type: "terminal_opened",
    session_id: "lead-1",
    agent: "claude-code",
    label: "Lead · Claude Code",
    lead: true,
  });
  socket = connectBridge();
  assert.equal(hud().leadSessionId, undefined, "a restarted bridge has no lead PTY");
  socket.deliver({ type: "agent_inventory", agents: [CLAUDE] });
  assert.equal(leadOpens().length, 1, "one lead per connection");
});

test("no Claude Code, no lead: nothing is spawned", () => {
  const socket = connectBridge();
  socket.deliver({ type: "agent_inventory", agents: [{ ...CLAUDE, available: false }, CODEX] });
  assert.equal(leadOpens().length, 0);
  assert.equal(useHudStore.getState().openLeadTerminal(), false);
});

test("task_state for an id this window never submitted becomes a lead task row", () => {
  const socket = connectBridge();
  socket.deliver({ type: "task_state", task_id: "lead-7f3a-1", state: "queued" });
  socket.deliver({ type: "task_state", task_id: "lead-7f3a-2", state: "running", cli: "codex", title: "testleri koş" });
  // No rAF in this environment: coalesced updates flush synchronously.
  assert.deepEqual(hud().tasks["lead-7f3a-1"], {
    id: "lead-7f3a-1",
    title: undefined,
    state: "queued",
    detail: null,
    cli: undefined,
    department: undefined,
    origin: "lead",
  });
  assert.equal(hud().tasks["lead-7f3a-2"].cli, "codex");
  assert.equal(hud().tasks["lead-7f3a-2"].title, "testleri koş");
  assert.equal(hud().tasks["lead-7f3a-2"].origin, "lead");
  assert.deepEqual(logsMatching("lead-7f3a-1"), ["görev lead · ajan ? · lead-7f3a-1 → sırada"]);
  assert.deepEqual(logsMatching("testleri koş"), ["görev lead · Codex · testleri koş → çalışıyor"]);

  // A repeated state is not news; a real transition is.
  socket.deliver({ type: "task_state", task_id: "lead-7f3a-1", state: "queued" });
  socket.deliver({ type: "task_state", task_id: "lead-7f3a-1", state: "completed" });
  assert.equal(hud().tasks["lead-7f3a-1"].state, "completed");
  assert.equal(logsMatching("lead-7f3a-1").length, 2);
});

test("the lead PTY does not absorb Claude's worker seat in auto-deploy", () => {
  const socket = connectBridge();
  socket.deliver({
    type: "terminal_opened",
    session_id: "lead-1",
    agent: "claude-code",
    label: "Lead · Claude Code",
    lead: true,
  });
  socket.deliver({
    type: "departments_loaded",
    departments: [
      {
        id: "dev",
        name: "Ar-Ge",
        max_concurrency: 2,
        enabled: true,
        roles: [{ id: "dev", name: "Geliştirici", cli: "claude-code" }],
      },
    ],
  });
  socket.deliver({ type: "agent_inventory", agents: [CLAUDE] });
  useHudStore.getState().setSeatStartup("primary");
  const workerOpens = newestSocket()
    .requests()
    .filter((f) => f.type === "open_terminal" && f.agent === "claude-code" && !f.lead);
  assert.equal(workerOpens.length, 1, "the worker Claude seat still opens");
});

test("tasks_dispatched from the lead names its tasks and task_report records the result", () => {
  const socket = connectBridge();
  socket.deliver({
    type: "tasks_dispatched",
    lead: true,
    tasks: [
      { id: "lead-k1-1", title: "API uçlarını yaz", prompt: "p1", cli: "claude-code", isolation: "shared" },
      { id: "lead-k1-2", title: "testleri koş", prompt: "p2", cli: "codex", isolation: "shared" },
    ],
  });
  socket.deliver({ type: "task_state", task_id: "lead-k1-1", state: "running" });
  socket.deliver({ type: "task_state", task_id: "lead-k1-2", state: "running" });
  const tasks = hud().tasks;
  assert.equal(tasks["lead-k1-1"].title, "API uçlarını yaz");
  assert.equal(tasks["lead-k1-1"].cli, "claude-code");
  assert.equal(tasks["lead-k1-2"].cli, "codex");
  assert.equal(tasks["lead-k1-2"].origin, "lead");
  assert.equal(Object.values(tasks).filter((t) => t.state === "running").length, 2);
  assert.deepEqual(logsMatching("Lead dağıttı"), ["Lead dağıttı ×2 paralel → Claude Code + Codex"]);

  socket.deliver({
    type: "task_report",
    task_id: "lead-k1-2",
    success: false,
    exit_code: 1,
    duration_ms: 1500,
    output_tail: "boom",
  });
  assert.deepEqual(hud().tasks["lead-k1-2"].report, {
    success: false,
    exitCode: 1,
    durationMs: 1500,
    outputTail: "boom",
  });
  assert.deepEqual(logsMatching("rapor testleri koş"), ["rapor testleri koş · başarısız (çıkış 1) · 1.5 sn"]);
});
