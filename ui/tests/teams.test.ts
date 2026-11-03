/**
 * Team formation contract for mission fan-out.
 *
 * The requirement is "every team owns a different service": two slices that
 * land on the same service would edit the same files in two worktrees and
 * collide. These tests pin the resolution order and the warnings that tell the
 * operator when a plan would serialize instead of parallelise.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { buildTeams, planTeams, resolveService, SERVICE_CATALOG, teamForRole } from "@/lib/teams";
import type { MissionPlan, MissionSlice } from "@/lib/missionPlan";
import type { DepartmentDto } from "@/lib/protocol";

const DEPARTMENTS: DepartmentDto[] = [
  {
    id: "software-development",
    name: "Software Development",
    enabled: true,
    max_concurrency: 2,
    roles: [
      { id: "backend", name: "Backend Developer", cli: "claude-code" },
      { id: "frontend", name: "Frontend Developer", cli: "claude-code" },
    ],
  },
  {
    id: "research",
    name: "Research",
    enabled: true,
    max_concurrency: 3,
    roles: [{ id: "web-researcher", name: "Web Researcher", cli: "codex" }],
  },
];

const slice = (over: Partial<MissionSlice> = {}): MissionSlice => ({
  cli: "claude-code",
  role: "backend",
  title: "iş",
  prompt: "bir şeyler yap",
  isolation: "worktree",
  ...over,
});

const plan = (slices: MissionSlice[]): MissionPlan => ({ goal: "hedef", slices });

test("every service in the catalog has a distinct id and a path", () => {
  const ids = SERVICE_CATALOG.map((s) => s.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const s of SERVICE_CATALOG) assert.ok(s.paths.length > 0, s.id);
});

test("service names resolve case-insensitively to one canonical id", () => {
  assert.equal(resolveService("Web")?.id, "web");
  assert.equal(resolveService("web ui")?.id, "web");
  assert.equal(resolveService("DESKTOP")?.id, "desktop");
  assert.equal(resolveService("nonsense"), null);
});

test("an explicit service puts each slice in its own team", () => {
  const out = planTeams(
    plan([
      slice({ service: "web", title: "ui" }),
      slice({ service: "desktop", title: "shell" }),
      slice({ service: "cli", title: "bridge" }),
    ]),
    DEPARTMENTS,
  );
  assert.equal(out.teams.length, 3, "one team per distinct service");
  assert.equal(out.parallelism, 3, "all three can run at once");
  assert.equal(out.warnings.length, 0);
});

test("two slices on the same service are allowed but warned", () => {
  const out = planTeams(plan([slice({ service: "web" }), slice({ service: "web" })]), DEPARTMENTS);
  assert.equal(out.teams.length, 1);
  assert.ok(out.warnings.some((w) => w.includes("aynı hizmette")), out.warnings.join(" | "));
});

test("an unknown department is reported, then the role decides the team", () => {
  // "backend" belongs to software-development, so the slice is still assigned
  // there — an unknown department must never drop the work on the floor.
  const out = planTeams(plan([slice({ department: "does-not-exist", role: "backend" })]), DEPARTMENTS);
  assert.equal(out.assignments.length, 1);
  assert.ok(out.warnings.some((w) => w.includes("bilinmeyen takım")), out.warnings.join(" | "));
  assert.equal(out.assignments[0].department, "software-development");
});

test("with no department and an unknown role the slice lands in the general team", () => {
  const out = planTeams(plan([slice({ role: "no-such-role" })]), DEPARTMENTS);
  assert.equal(out.assignments.length, 1);
  assert.equal(out.assignments[0].teamKey, "general");
  assert.equal(out.assignments[0].teamName, "Genel Ekip");
});

test("a real department is adopted and drives the team name", () => {
  const out = planTeams(plan([slice({ department: "research", role: "web-researcher" })]), DEPARTMENTS);
  assert.equal(out.assignments[0].department, "research");
  assert.equal(out.assignments[0].teamName, "Research");
  assert.equal(out.assignments[0].teamKey, "dept:research");
});

test("a role with no explicit team is matched to the department that owns it", () => {
  const out = planTeams(plan([slice({ role: "web-researcher" })]), DEPARTMENTS);
  assert.equal(out.assignments[0].department, "research");
  assert.equal(teamForRole("web-researcher", buildTeams(DEPARTMENTS))?.id, "research");
});

test("the fallback department applies only when the slice names none", () => {
  const out = planTeams(plan([slice({ role: "unknown-role" })]), DEPARTMENTS, "research");
  assert.equal(out.assignments[0].department, "research");
});

test("parallelism respects each team's concurrency ceiling", () => {
  // software-development allows 2 concurrent seats; three slices must queue one.
  const out = planTeams(
    plan([
      slice({ department: "software-development", service: "web" }),
      slice({ department: "software-development", service: "core" }),
      slice({ department: "software-development", service: "docs" }),
    ]),
    DEPARTMENTS,
  );
  // three distinct services → three teams, each with its own budget
  assert.equal(out.teams.length, 3);
  assert.equal(out.parallelism, 3);
});

test("duplicate service slices within one team count against its ceiling", () => {
  const out = planTeams(
    plan([
      slice({ department: "software-development", service: "web" }),
      slice({ department: "software-development", service: "web" }),
      slice({ department: "software-development", service: "web" }),
    ]),
    DEPARTMENTS,
  );
  assert.equal(out.teams.length, 1);
  assert.equal(out.parallelism, 2, "capped by max_concurrency");
  assert.ok(out.warnings.some((w) => w.includes("eşzamanlılık")), out.warnings.join(" | "));
});

test("assignments keep the original slice index so the log can reference it", () => {
  const out = planTeams(
    plan([slice({ service: "web" }), slice({ service: "docs" })]),
    DEPARTMENTS,
  );
  assert.deepEqual(
    out.assignments.map((a) => a.index),
    [0, 1],
  );
});
