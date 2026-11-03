/**
 * Seat-based auto-deploy contract.
 *
 * One seat per department role whose CLI the bridge actually detected;
 * live sessions fill their own seats first; a seat attempted this connection
 * stays closed. Returns agent/department specs only — the store sends the
 * real `open_terminal` requests and nothing is ever simulated.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { autoMatrixColumns, autoSeats, planSeatOpens, planSeats } from "@/lib/autoTerminals";

const ALL = new Set<string>();

const DEPARTMENTS = [
  {
    id: "dev",
    name: "Ar-Ge",
    enabled: true,
    roles: [{ cli: "claude-code" }, { cli: "claude-code" }, { cli: "codex" }],
  },
  { id: "qa", name: "Test", enabled: true, roles: [{ cli: "codex" }] },
  { id: "off", name: "Kapalı", enabled: false, roles: [{ cli: "claude-code" }] },
];

const AGENTS = [
  { id: "claude-code", displayName: "Claude Code", available: true },
  { id: "codex", displayName: "Codex CLI", available: true },
  { id: "gemini", displayName: "Gemini", available: false },
];

test("every department role of an available CLI becomes a seat", () => {
  const seats = planSeats(DEPARTMENTS, AGENTS);
  assert.deepEqual(
    seats.map((s) => [s.seatKey, s.agent, s.label]),
    [
      ["dev:0", "claude-code", "Claude Code · Ar-Ge"],
      ["dev:1", "claude-code", "Claude Code · Ar-Ge #2"],
      ["dev:2", "codex", "Codex CLI · Ar-Ge"],
      ["qa:0", "codex", "Codex CLI · Test"],
    ],
  );
});

test("disabled departments and missing CLIs produce no fake seats", () => {
  const seats = planSeats(DEPARTMENTS, AGENTS);
  assert.ok(!seats.some((s) => s.department === "off"), "kapalı takım koltuk üretmez");
  assert.ok(!seats.some((s) => s.agent === "gemini"), "kurulu olmayan CLI koltuk üretmez");
});

test("auto-deploy fills empty seats and never disturbs live ones", () => {
  const seats = planSeats(DEPARTMENTS, AGENTS);
  const live = [
    { agent: "claude-code", department: "dev" },
    { agent: "codex", department: "qa" },
  ];
  const plan = planSeatOpens(seats, live, ALL);
  assert.deepEqual(plan.map((s) => s.seatKey), ["dev:1", "dev:2"]);
});

test("a closed or failed seat stays closed for this connection", () => {
  const seats = planSeats(DEPARTMENTS, AGENTS);
  const attempted = new Set(["dev:0"]);
  const plan = planSeatOpens(seats, [], attempted);
  assert.deepEqual(plan.map((s) => s.seatKey), ["dev:1", "dev:2", "qa:0"]);
});

test("extra live sessions of the same agent absorb duplicate roles honestly", () => {
  const seats = planSeats(DEPARTMENTS, AGENTS);
  const live = [
    { agent: "claude-code", department: "dev" },
    { agent: "claude-code", department: "dev" },
    { agent: "codex", department: "dev" },
    { agent: "codex", department: "qa" },
  ];
  assert.deepEqual(planSeatOpens(seats, live, ALL), []);
});

test("auto grid divides by seat count but keeps every box usable", () => {
  assert.equal(autoMatrixColumns(0), 1);
  assert.equal(autoMatrixColumns(1), 1);
  assert.equal(autoMatrixColumns(2, 900), 2);
  assert.equal(autoMatrixColumns(4, 1600), 4);
  assert.equal(autoMatrixColumns(9, 4000), 4, "never more than four columns");
  assert.equal(autoMatrixColumns(4, 320), 1, "a 320px dock stacks");
});

test("startup policy primary: one seat per CLI, not one per role", () => {
  const seats = planSeats(DEPARTMENTS, AGENTS);
  assert.ok(seats.length > 2, "the full roster has several role seats");
  const primary = autoSeats(seats, "primary");
  assert.deepEqual(
    primary.map((s) => s.agent),
    ["claude-code", "codex"],
    "exactly one live seat per available CLI",
  );
});

test("startup policy all keeps every role seat (explicit opt-in)", () => {
  const seats = planSeats(DEPARTMENTS, AGENTS);
  assert.equal(autoSeats(seats, "all").length, seats.length);
});

test("startup policy off opens nothing", () => {
  assert.deepEqual(autoSeats(planSeats(DEPARTMENTS, AGENTS), "off"), []);
});
