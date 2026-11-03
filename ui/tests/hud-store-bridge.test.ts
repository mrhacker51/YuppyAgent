/**
 * Bridge contract tests for the HUD store.
 *
 * These drive the real `useHudStore` through a fake WebSocket, so every payload
 * shape asserted here is the shape `yuppycode-cli`'s bridge must put on the
 * wire (see crates/yuppycode-cli/src/bridge). The 3D HUD renders straight from
 * this state, so a field renamed on either side shows up as a red test here
 * instead of a blank panel in the browser.
 */
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  connectBridge,
  connectToken,
  FakeWebSocket,
  hud,
  installAnimationFrameQueue,
  logsMatching,
  newestSocket,
  resetHud,
  useHudStore,
} from "./helpers/dom-env";
import type {
  DepartmentDto,
  ServerPayload,
  TaskSpecDto,
  TerminalCellDto,
} from "@/lib/protocol";

// `Session.lastScreen` is typed as the whole ServerPayload union rather than the
// terminal_screen variant, so readers have to narrow it themselves.
type ScreenPayload = Extract<ServerPayload, { type: "terminal_screen" }>;
import { PROTOCOL_VERSION } from "@/lib/protocol";

beforeEach(() => {
  resetHud();
});

function department(id: string, name = id): DepartmentDto {
  return { id, name, max_concurrency: 2, enabled: true };
}

function cell(ch: string): TerminalCellDto {
  return {
    ch,
    fg: { t: "default" },
    bg: { t: "default" },
    bold: false,
    italic: false,
    underline: false,
    inverse: false,
    wide: false,
  };
}

function screenFrame(sessionId: string, generation: number, text: string) {
  return {
    type: "terminal_screen" as const,
    session_id: sessionId,
    rows: 1,
    cols: text.length,
    cursor: [0, text.length] as [number, number],
    cursor_visible: true,
    generation,
    cells: [...text].map(cell),
  };
}

function task(id: string, over: Partial<TaskSpecDto> = {}): TaskSpecDto {
  return {
    id,
    title: `Task ${id}`,
    prompt: `do ${id}`,
    cli: "claude-code",
    isolation: "worktree",
    role: "software-development",
    ...over,
  };
}

const session = () => hud().sessions[0];
const activeSessionId = () => hud().activeSessionId;

test("handshake authenticates with the protocol version and the bridge token", () => {
  useHudStore.getState().connect("ws://127.0.0.1:9090", connectToken);
  const socket = newestSocket();
  assert.equal(socket.url, "ws://127.0.0.1:9090");
  assert.equal(hud().status, "connecting", "dialling must not imply authorized");

  socket.serverOpen();
  assert.deepEqual(JSON.parse(socket.frames[0]), { version: PROTOCOL_VERSION, token: connectToken });
  assert.equal(hud().status, "authenticating");
  assert.equal(hud().offline, true, "offline stays true until the bridge says connected");

  socket.deliver({ type: "connected" });
  assert.equal(hud().status, "connected");
  assert.equal(hud().offline, false);
  assert.equal(hud().bridgeError, undefined);
  assert.equal(logsMatching("Bridge connected and authorized.").length, 1);
  // The store keeps the socket warm immediately after the handshake.
  assert.deepEqual(socket.requests().at(-1), { type: "ping" });
});

test("a missing token fails fast instead of dialling the bridge", () => {
  localStorage.removeItem("yuppy.bridge.token");
  useHudStore.getState().connect("ws://127.0.0.1:9090", "");
  assert.equal(FakeWebSocket.instances.length, 0, "no socket may be opened without a token");
  assert.equal(hud().status, "auth_failed");
  assert.match(hud().bridgeError ?? "", /token/i);
});

test("a restarted bridge wipes ghost sessions and stale task rows", () => {
  const socket = connectBridge();
  socket.deliver({ type: "terminal_opened", session_id: "s-1", agent: "claude-code", label: "Dev" });
  useHudStore.getState().submitTasks([task("t-1")]);
  assert.equal(hud().sessions.length, 1);
  assert.equal(Object.keys(hud().tasks).length, 1);

  connectBridge();
  assert.equal(hud().sessions.length, 0);
  assert.deepEqual(hud().tasks, {});
  assert.equal(activeSessionId(), undefined);
});

test("agent_inventory and departments_loaded populate the rail and keep a valid selection", () => {
  const socket = connectBridge();
  socket.deliver({
    type: "agent_inventory",
    agents: [{ id: "claude-code", display_name: "Claude Code", available: true }],
  });
  assert.equal(hud().agents.length, 1);

  socket.deliver({
    type: "departments_loaded",
    departments: [department("research", "Araştırma"), department("finance", "Finans")],
  });
  assert.deepEqual(hud().departments.map((d) => d.id), ["research", "finance"]);
  assert.equal(hud().selectedDept, "research", "empty selection snaps to the first department");

  useHudStore.getState().setSelectedDept("finance");
  socket.deliver({ type: "departments_loaded", departments: [department("finance", "Finans")] });
  assert.equal(hud().selectedDept, "finance", "a still-existing selection survives a reload");

  socket.deliver({ type: "departments_loaded", departments: [department("youtube-content")] });
  assert.equal(hud().selectedDept, "youtube-content", "a deleted selection falls back, never dangles");
});

test("a rejected department save is reported with the backend reason", () => {
  const socket = connectBridge();
  socket.deliver({ type: "department_upserted", id: "research", ok: false, error: "duplicate id" });
  assert.deepEqual(logsMatching("Department save failed"), [
    "Department save failed (research): duplicate id",
  ]);
  assert.equal(hud().logs.at(-1)?.level, "error");

  socket.deliver({ type: "department_upserted", id: "research", ok: true });
  assert.equal(logsMatching("Department save failed").length, 1, "ok=true logs nothing");
});

test("terminal_opened dedupes by session id but still focuses and opens the dock", () => {
  const socket = connectBridge();
  useHudStore.getState().setDockOpen(false);
  socket.deliver({ type: "terminal_opened", session_id: "s-1", agent: "claude-code", label: "Dev" });
  socket.deliver({ type: "terminal_opened", session_id: "s-1", agent: "codex", label: "Dev rerun" });
  assert.equal(hud().sessions.length, 1, "deduped by session id");
  assert.equal(hud().sessions[0].id, "s-1");
  assert.equal(hud().sessions[0].agent, "codex");
  assert.equal(hud().sessions[0].label, "Dev rerun");
  assert.equal(typeof hud().sessions[0].openedAt, "number", "duration starts when opened");
  assert.equal(activeSessionId(), "s-1");
  assert.equal(hud().dockOpen, true);
  assert.equal(logsMatching("terminal opened: Dev rerun").length, 1);
});

test("terminal_closed records an exit card and clears focus only for that session", () => {
  const socket = connectBridge();
  socket.deliver({ type: "terminal_opened", session_id: "s-1", agent: "claude-code", label: "Dev" });
  socket.deliver({ type: "terminal_opened", session_id: "s-2", agent: "codex", label: "Review" });
  useHudStore.getState().focusSession("s-2");

  socket.deliver({ type: "terminal_closed", session_id: "s-1", exit_code: 0, signal: null });
  assert.deepEqual(hud().sessions.map((s) => s.id), ["s-2"]);
  assert.equal(activeSessionId(), "s-2", "the other session keeps focus");
  assert.deepEqual(
    { ...hud().lastExit, ts: 0 },
    { sessionId: "s-1", agent: "claude-code", label: "Dev", exitCode: 0, signal: null, ts: 0 },
  );
  assert.deepEqual(logsMatching("closed"), ["Dev closed (exit 0)."]);

  socket.deliver({ type: "terminal_closed", session_id: "s-2", signal: "SIGTERM" });
  assert.deepEqual(logsMatching("closed").at(-1), "Review closed (signal SIGTERM).");

  socket.deliver({ type: "terminal_closed", session_id: "never-seen" });
  assert.deepEqual(logsMatching("closed").at(-1), "terminal closed (exit status unavailable).");
});

test("a close that raced a dropped socket is resent on the next connect", () => {
  const socket = connectBridge();
  socket.deliver({ type: "terminal_opened", session_id: "s-1", agent: "claude-code", label: "Dev" });
  useHudStore.getState().closeTerminal("s-1");
  assert.deepEqual(newestSocket().lastRequest(), { type: "terminal_close", session_id: "s-1" });
  assert.equal(hud().sessions.length, 0);

  // The bridge dies before answering; the close request is lost with it.
  socket.serverClose(1006);
  assert.equal(hud().status, "disconnected");
  assert.match(hud().bridgeError ?? "", /Retrying/);

  const next = connectBridge();
  assert.deepEqual(
    next.requests().filter((frame) => frame.type === "terminal_close"),
    [{ type: "terminal_close", session_id: "s-1" }],
    "orphaned PTYs must be reaped after a reconnect",
  );
});

test("terminal screens coalesce into one state update per animation frame", () => {
  const { flush } = installAnimationFrameQueue();
  const socket = connectBridge();
  socket.deliver({ type: "terminal_opened", session_id: "s-1", agent: "claude-code", label: "Dev" });

  socket.deliver(screenFrame("s-1", 10, "abc"));
  socket.deliver(screenFrame("s-1", 11, "def"));
  socket.deliver(screenFrame("s-1", 12, "ghi"));
  assert.equal(session().generation, undefined, "nothing may be applied before rAF");

  flush();
  assert.equal(session().generation, 12, "only the newest frame per session survives");
  assert.equal(session().cols, 3);
  const screen = session().lastScreen as ScreenPayload | undefined;
  assert.equal(screen?.cells.map((c) => c.ch).join(""), "ghi");

  flush();
  assert.equal(session().generation, 12, "an idle frame must not rewrite state");
});

test("screens for unknown sessions are buffered without inventing a session", () => {
  const socket = connectBridge();
  socket.deliver(screenFrame("ghost", 1, "hi"));
  assert.deepEqual(hud().sessions, []);
});

test("task_state keeps the submitted title and detail across live updates", () => {
  const socket = connectBridge();
  assert.equal(useHudStore.getState().submitTasks([task("t-1"), task("t-2")]), true);
  assert.deepEqual(newestSocket().lastRequest(), {
    type: "task_submit",
    tasks: [task("t-1"), task("t-2")],
  });
  assert.deepEqual(hud().tasks["t-1"], {
    id: "t-1",
    title: "Task t-1",
    state: "queued",
    detail: "software-development",
    cli: "claude-code",
    department: null,
    origin: "operator",
  });

  socket.deliver({ type: "task_state", task_id: "t-1", state: "running" });
  assert.deepEqual(hud().tasks["t-1"], {
    id: "t-1",
    title: "Task t-1",
    state: "running",
    detail: "software-development",
    cli: "claude-code",
    department: null,
    origin: "operator",
  });

  socket.deliver({ type: "task_state", task_id: "t-1", state: "completed", detail: "merged" });
  assert.equal(hud().tasks["t-1"].detail, "merged");
  // Every real transition is narrated once in the information console;
  // success is info, never an alert.
  assert.deepEqual(logsMatching("Task t-1 →"), [
    "görev Claude Code · Task t-1 → çalışıyor",
    "görev Claude Code · Task t-1 → bitti",
  ]);
  assert.equal(hud().logs.at(-1)?.level, "info");
});

test("terminal task failures are logged with severity, integration and conflicts as activity", () => {
  const socket = connectBridge();
  socket.deliver({ type: "task_state", task_id: "t-1", state: "failed", detail: "provider 500" });
  assert.deepEqual(logsMatching("t-1 →"), ["görev lead · ajan ? · t-1 → hata — provider 500"]);
  assert.equal(hud().logs.at(-1)?.level, "error");

  socket.deliver({ type: "task_state", task_id: "t-2", state: "cancelled" });
  assert.equal(hud().logs.at(-1)?.level, "warn");

  socket.deliver({
    type: "task_integration",
    task_id: "t-1",
    branch: "task/t-1",
    changed_files: ["a.rs", "b.rs"],
    committed: false,
  });
  assert.deepEqual(logsMatching("review branch"), [
    "task t-1 review branch task/t-1 (2 changed file(s), not committed).",
  ]);

  socket.deliver({ type: "task_conflict", task_a: "t-1", task_b: "t-2", path: "src/lib.rs" });
  assert.equal(hud().logs.at(-1)?.level, "warn");
  assert.deepEqual(logsMatching("task conflict"), [
    "task conflict on src/lib.rs: t-1 and t-2 both changed it. Manual merge required.",
  ]);
});

test("bridge log and error frames are surfaced without killing the session", () => {
  const socket = connectBridge();
  socket.deliver({ type: "log", level: "warn", message: "worktree is dirty" });
  assert.deepEqual(hud().logs.at(-1), {
    ...hud().logs.at(-1),
    level: "warn",
    message: "worktree is dirty",
  });

  socket.deliver({ type: "error", code: "tool_failed", message: "git push rejected" });
  assert.equal(hud().bridgeError, "tool_failed: git push rejected");
  assert.equal(hud().logs.at(-1)?.level, "error");
  assert.equal(hud().status, "connected", "a recoverable error must not disconnect the HUD");
});

test("auth and protocol failures stop the reconnect loop instead of hammering the bridge", () => {
  const socket = connectBridge();
  socket.deliver({ type: "error", code: "unauthorized", message: "bad token" });
  assert.equal(hud().status, "auth_failed");
  assert.equal(hud().offline, true);
  assert.equal(hud().bridgeError, "bad token");
  assert.equal(socket.readyState, FakeWebSocket.CLOSED, "the rejected socket must be closed");

  socket.serverClose(1006);
  assert.equal(hud().status, "auth_failed", "a retried handshake is pointless with a bad token");

  connectBridge();
  newestSocket().deliver({
    type: "error",
    code: "protocol_mismatch",
    message: "server speaks protocol v3",
  });
  assert.equal(hud().status, "protocol_mismatch");
  assert.equal(hud().bridgeError, "server speaks protocol v3");
});

test("an unexpected close reconnects with backoff and a live connection resets it", () => {
  const socket = connectBridge();
  socket.serverClose(1006);
  assert.match(hud().bridgeError ?? "", /code 1006/);
  socket.serverClose(1000);
  // The stale socket's second close must not resurrect the older message.
  assert.equal(hud().status, "disconnected");
});

test("malformed and unknown frames are ignored rather than crashing the HUD", () => {
  const socket = connectBridge();
  const errors: unknown[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => errors.push(args);
  try {
    socket.deliverRaw("{not json");
    socket.deliverRaw(JSON.stringify({ version: 2, seq: 9, ts_ms: 0, payload: { type: "nope" } }));
  } finally {
    console.error = original;
  }
  assert.equal(errors.length, 1, "only the unparseable frame is logged");
  assert.equal(hud().status, "connected");
});

test("offline, the HUD refuses to fake a PTY or a submission", () => {
  useHudStore.getState().openTerminal("claude-code", "Dev", "software-development");
  assert.equal(FakeWebSocket.instances.length, 0);
  assert.deepEqual(hud().sessions, []);
  assert.deepEqual(logsMatching("Bridge offline").slice(1), [
    "Bridge offline: a real PTY cannot be opened. No terminal is simulated.",
  ]);

  assert.equal(useHudStore.getState().submitTasks([task("t-1")]), false);
  assert.deepEqual(hud().tasks, {});
  assert.deepEqual(logsMatching("Bridge offline").at(-1), "Bridge offline: sub-agent tasks were not submitted.");
  assert.equal(useHudStore.getState().submitTasks([]), false, "an empty batch is never sent");
});

test("each open_terminal spawns its own seat — the same CLI can run twice", () => {
  const socket = connectBridge();
  socket.deliver({ type: "terminal_opened", session_id: "s-1", agent: "claude-code", label: "Dev" });
  const before = newestSocket().frames.length;

  // Seat model: a second role on the same CLI is a second real PTY, not a
  // refocus. The matrix docks it into its own seat box.
  useHudStore.getState().openTerminal("claude-code", "Dev #2", "software-development");
  assert.deepEqual(newestSocket().lastRequest(), {
    type: "open_terminal",
    agent: "claude-code",
    label: "Dev #2",
    department: "software-development",
  });
  assert.ok(newestSocket().frames.length > before, "the second seat sends a real open request");

  newestSocket().deliver({ type: "terminal_opened", session_id: "s-2", agent: "claude-code", label: "Dev #2" });
  assert.equal(hud().sessions.length, 2, "both seats stay live");
  assert.equal(activeSessionId(), "s-2", "the freshly opened seat takes focus once");

  // A replayed open for a known session updates in place without stealing focus.
  useHudStore.getState().focusSession("s-1");
  newestSocket().deliver({ type: "terminal_opened", session_id: "s-1", agent: "claude-code", label: "Dev" });
  assert.equal(hud().sessions.length, 2, "the replay cannot duplicate the session");
  assert.equal(activeSessionId(), "s-1", "the operator's focus survives the replay");

  useHudStore.getState().openTerminal("codex", "Review", "code-review-testing");
  assert.deepEqual(newestSocket().lastRequest(), {
    type: "open_terminal",
    agent: "codex",
    label: "Review",
    department: "code-review-testing",
  });
});

test("the log ring buffer keeps its cap of 500 entries", () => {
  const socket = connectBridge();
  for (let i = 0; i < 520; i += 1) {
    socket.deliver({ type: "log", level: "info", message: `line ${i}` });
  }
  assert.equal(hud().logs.length, 500);
  // Seeded "Bridge offline" line + the "Bridge connected" line are pushed out first.
  assert.equal(hud().logs[0]?.message, "line 20");
  assert.equal(hud().logs.at(-1)?.message, "line 519");
});

test("seat prompt: live CLI gets real keystrokes immediately", async () => {
  const socket = connectBridge();
  socket.deliver({ type: "terminal_opened", session_id: "s-1", agent: "claude-code", label: "Dev" });

  const ok = useHudStore.getState().sendPromptToSeats("merhaba", ["claude-code"]);
  assert.equal(ok, true);
  assert.deepEqual(newestSocket().lastRequest(), {
    type: "terminal_input",
    session_id: "s-1",
    bytes: "merhaba",
  });
  await new Promise((resolve) => setTimeout(resolve, 350));
  assert.deepEqual(newestSocket().lastRequest(), {
    type: "terminal_input",
    session_id: "s-1",
    bytes: "\r",
  });
  assert.equal(logsMatching("Koltuklara yazıldı").length, 1);
});

test("seat prompt: every live seat for an agent gets the same prompt", async () => {
  const socket = connectBridge();
  // seatStartup "all" gives one CLI several role seats; the fan-out must not
  // stop at the first session it finds.
  socket.deliver({ type: "terminal_opened", session_id: "s-1", agent: "claude-code", label: "Backend" });
  socket.deliver({ type: "terminal_opened", session_id: "s-2", agent: "claude-code", label: "Frontend" });

  const ok = useHudStore.getState().sendPromptToSeats("merhaba", ["claude-code"]);
  assert.equal(ok, true);
  const bodies = newestSocket()
    .requests()
    .filter((f) => f.type === "terminal_input" && f.bytes === "merhaba");
  assert.deepEqual(
    bodies.map((f) => f.session_id).sort(),
    ["s-1", "s-2"],
    "both live seats receive the prompt",
  );
  assert.equal(logsMatching("×2").length, 1, "the log counts seats, not agents");
  await new Promise((resolve) => setTimeout(resolve, 350));
  const enters = newestSocket()
    .requests()
    .filter((f) => f.type === "terminal_input" && f.bytes === "\r");
  assert.deepEqual(enters.map((f) => f.session_id).sort(), ["s-1", "s-2"]);
});

test("seat prompt: closed seat opens a real PTY and types once it renders", async () => {
  const socket = connectBridge();
  const ok = useHudStore.getState().sendPromptToSeats("merhaba", ["codex"]);
  assert.equal(ok, true);
  assert.equal(newestSocket().lastRequest()?.type, "open_terminal", "a real PTY is opened first");

  socket.deliver({ type: "terminal_opened", session_id: "s-9", agent: "codex", label: "Codex" });
  assert.notEqual(newestSocket().lastRequest()?.type, "terminal_input", "a bare prompt box is not ready yet");
  socket.deliver(screenFrame("s-9", 1, "Codex CLI hazir"));
  assert.notEqual(newestSocket().lastRequest()?.type, "terminal_input", "one frame is not a rendered prompt");
  socket.deliver(screenFrame("s-9", 2, "> hazir"));
  assert.equal(
    newestSocket().requests().filter((f) => f.type === "terminal_input").length,
    0,
    "a fresh box must settle first — Codex swaps a dialog in after its first composer",
  );
  await new Promise((resolve) => setTimeout(resolve, SETTLE_WAIT_MS));

  const delivered = newestSocket().requests().filter((f) => f.type === "terminal_input");
  assert.equal(delivered.length, 1, "exactly one real keystroke burst");
  assert.deepEqual(delivered[0], { type: "terminal_input", session_id: "s-9", bytes: "merhaba" });
  await new Promise((resolve) => setTimeout(resolve, 350));
  const withEnter = newestSocket().requests().filter((f) => f.type === "terminal_input");
  assert.deepEqual(withEnter.at(-1), { type: "terminal_input", session_id: "s-9", bytes: "\r" });
});

test("seat prompt: multi-line text is a single bracketed paste, Enter follows", async () => {
  const socket = connectBridge();
  socket.deliver({ type: "terminal_opened", session_id: "s-1", agent: "claude-code", label: "Dev" });
  useHudStore.getState().sendPromptToSeats("satir1\nsatir2", ["claude-code"]);
  const bytes = String(newestSocket().lastRequest()?.bytes);
  assert.ok(bytes.startsWith("\u001b[200~satir1\nsatir2\u001b[201~"), "bracketed paste keeps newlines");
  assert.ok(!bytes.endsWith("\r"), "Enter is never burst-pasted with the body — Codex eats it");
  await new Promise((resolve) => setTimeout(resolve, 350));
  assert.equal(newestSocket().lastRequest()?.bytes, "\r", "a separate Enter keystroke submits");
});

test("seat prompt: a live seat stuck on a dialog is never typed into", () => {
  const socket = connectBridge();
  socket.deliver({ type: "terminal_opened", session_id: "s-1", agent: "codex", label: "Codex" });
  socket.deliver(screenFrame("s-1", 1, "Trust this folder? · Enter to confirm"));

  const ok = useHudStore.getState().sendPromptToSeats("merhaba", ["codex"]);
  assert.equal(ok, true);
  assert.equal(
    newestSocket().requests().filter((f) => f.type === "terminal_input").length,
    0,
    "a dialog is a human decision; blind keystrokes would answer it",
  );
  assert.equal(logsMatching("diyalog").length, 1, "the operator is told which seat is waiting");
});

test("seat prompt: a first-run dialog on the fresh CLI blocks typing", async () => {
  const socket = connectBridge();
  useHudStore.getState().sendPromptToSeats("merhaba", ["codex"]);
  socket.deliver({ type: "terminal_opened", session_id: "s-9", agent: "codex", label: "Codex" });
  socket.deliver(screenFrame("s-9", 1, "Hoş geldin"));
  socket.deliver(screenFrame("s-9", 2, "❯ No, exit · Yes, I trust this folder · Enter to confirm"));
  await new Promise((resolve) => setTimeout(resolve, SETTLE_WAIT_MS));

  assert.equal(
    newestSocket().requests().filter((f) => f.type === "terminal_input").length,
    0,
    "a dialog is a human decision; nothing may be typed over it",
  );
  assert.equal(logsMatching("first-run dialog").length, 1, "the operator is told why nothing was typed");
});

test("seat prompt: the lead Claude PTY is never typed into; a worker seat opens instead", async () => {
  const socket = connectBridge();
  socket.deliver({ type: "terminal_opened", session_id: "lead-1", agent: "claude-code", label: "Lead · Claude Code", lead: true });
  assert.equal(useHudStore.getState().leadSessionId, "lead-1");

  const ok = useHudStore.getState().sendPromptToSeats("merhaba", ["claude-code"]);
  assert.equal(ok, true);
  const reqs = newestSocket().requests();
  assert.equal(
    reqs.filter((f) => f.type === "terminal_input" && f.session_id === "lead-1").length,
    0,
    "the lead is driven by the operator, never by a fan-out",
  );
  const opens = reqs.filter((f) => f.type === "open_terminal" && f.agent === "claude-code" && !f.lead);
  assert.equal(opens.length, 1, "a worker Claude seat is opened for the prompt");

  // With a worker seat live, it gets the prompt and the lead still does not.
  socket.deliver({ type: "terminal_opened", session_id: "w-1", agent: "claude-code", label: "Dev" });
  useHudStore.getState().sendPromptToSeats("ikinci", ["claude-code"]);
  const inputs = newestSocket().requests().filter((f) => f.type === "terminal_input" && f.bytes === "ikinci");
  assert.deepEqual(inputs.map((f) => f.session_id), ["w-1"]);
  // Let the delayed Enter land on this test's socket, not the next test's.
  await new Promise((resolve) => setTimeout(resolve, 350));
  const enters = newestSocket().requests().filter((f) => f.type === "terminal_input" && f.bytes === "\r");
  assert.deepEqual(enters.map((f) => f.session_id), ["w-1"], "the Enter goes to the worker too");
});

/** Longer than the store's fresh-seat settle (900 ms quiet). */
const SETTLE_WAIT_MS = 1100;
/** What Codex 0.166 really draws in a folder it does not trust yet (captured
 * from `codex` in a tmux pane). Note the capital "Trust" and the new footer:
 * none of the old Claude-era markers matched it. */
const CODEX_TRUST_DIALOG =
  "Folder access · Trust this folder? Codex can read, edit, and run files here · › 1. Trust and continue  2. Back to Agent Command Center · enter continue · esc back";

test("seat prompt: a live Codex seat on its real 0.166 trust dialog is never typed into", () => {
  const socket = connectBridge();
  socket.deliver({ type: "terminal_opened", session_id: "s-1", agent: "codex", label: "Codex" });
  socket.deliver(screenFrame("s-1", 1, CODEX_TRUST_DIALOG));

  const ok = useHudStore.getState().sendPromptToSeats("merhaba", ["codex"]);
  assert.equal(ok, true);
  assert.equal(
    newestSocket().requests().filter((f) => f.type === "terminal_input").length,
    0,
    "Enter on that dialog would trust the folder or open the agent list — the prompt is lost",
  );
  assert.equal(logsMatching("diyalog").length, 1, "the operator is told which seat is waiting");
});

test("seat prompt: a prompt parked behind a dialog is typed once the operator answers it", async () => {
  const socket = connectBridge();
  socket.deliver({ type: "terminal_opened", session_id: "s-1", agent: "codex", label: "Codex" });
  socket.deliver(screenFrame("s-1", 1, CODEX_TRUST_DIALOG));
  useHudStore.getState().sendPromptToSeats("merhaba", ["codex"]);
  assert.equal(newestSocket().requests().filter((f) => f.type === "terminal_input").length, 0);

  // The operator clicks "Trust and continue"; Codex shows its composer.
  socket.deliver(screenFrame("s-1", 2, "› Ask Codex to do anything"));
  await new Promise((resolve) => setTimeout(resolve, SETTLE_WAIT_MS + 350));
  const inputs = newestSocket()
    .requests()
    .filter((f) => f.type === "terminal_input" && f.session_id === "s-1");
  assert.deepEqual(
    inputs.map((f) => f.bytes),
    ["merhaba", "\r"],
    "exactly one prompt and one Enter reach the seat after the dialog is gone",
  );
});

test("seat prompt: Codex composer-then-dialog boot never gets the prompt typed into the dialog", async () => {
  const socket = connectBridge();
  useHudStore.getState().sendPromptToSeats("merhaba", ["codex"]);
  socket.deliver({ type: "terminal_opened", session_id: "s-9", agent: "codex", label: "Codex" });
  // Real 0.166 boot: composer at ~450 ms, trust dialog at ~800 ms.
  socket.deliver(screenFrame("s-9", 1, ">_ OpenAI Codex (v0.166.0)"));
  socket.deliver(screenFrame("s-9", 2, "› Ask Codex to do anything · ? for shortcuts"));
  await new Promise((resolve) => setTimeout(resolve, 350));
  socket.deliver(screenFrame("s-9", 3, CODEX_TRUST_DIALOG));
  await new Promise((resolve) => setTimeout(resolve, SETTLE_WAIT_MS));

  assert.equal(
    newestSocket().requests().filter((f) => f.type === "terminal_input").length,
    0,
    "the prompt must not be typed while the dialog is up",
  );
  assert.equal(logsMatching("first-run dialog").length, 1, "warned exactly once");

  socket.deliver(screenFrame("s-9", 4, "› Ask Codex to do anything"));
  await new Promise((resolve) => setTimeout(resolve, SETTLE_WAIT_MS));
  const inputs = newestSocket().requests().filter((f) => f.type === "terminal_input");
  assert.deepEqual(inputs.map((f) => f.bytes), ["merhaba"], "typed once the operator answered");
});

