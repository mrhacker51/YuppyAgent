/**
 * Office scene layout contract.
 *
 * The scene is painted onto a fixed 800×600 room, so every placement rule is
 * pure maths: which desk a seat gets, where its body stands, how a department
 * becomes a contiguous block, and which sprite answers to a movement delta.
 * These tests pin the rules that make the map read correctly; a canvas is not
 * needed (and would not catch a desk landing outside the room).
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  bodiesForSeats,
  BULLPEN,
  CHAR_POOL,
  CHAR_ROSTER,
  charBaseFor,
  charSprite,
  deskSlots,
  deskSprite,
  facingFor,
  layoutTeams,
  roomBackground,
  SCENE_H,
  SCENE_W,
  seatPoint,
  WAYPOINTS,
} from "@/lib/officeScene";
import { spriteBaseFor } from "@/lib/characters";

const shortName = (n: string) => n.toUpperCase().slice(0, 11);
const DEPTS = [
  { id: "software-development", name: "Software Development" },
  { id: "research", name: "Research" },
];

test("the room is the 4:3 scene the art was authored for", () => {
  assert.equal(SCENE_W / SCENE_H, 4 / 3);
});

test("every desk slot sits inside the room floor", () => {
  const slots = deskSlots();
  assert.equal(slots.length, BULLPEN.cols * BULLPEN.rows);
  for (const s of slots) {
    assert.ok(s.x > 60 && s.x < SCENE_W - 60, `x ${s.x}`);
    // Floor contact points live between the back wall and the front edge.
    assert.ok(s.y > 240 && s.y < SCENE_H - 60, `y ${s.y}`);
  }
});

test("no two desks share a slot", () => {
  const slots = deskSlots();
  const keys = new Set(slots.map((s) => `${s.x},${s.y}`));
  assert.equal(keys.size, slots.length);
});

test("adjacent desks are spaced at least a desk apart", () => {
  const slots = deskSlots();
  for (let i = 0; i < slots.length; i++) {
    for (let j = i + 1; j < slots.length; j++) {
      const dx = Math.abs(slots[i].x - slots[j].x);
      const dy = Math.abs(slots[i].y - slots[j].y);
      // Either clearly separated horizontally or clearly behind each other.
      assert.ok(dx > 40 || dy > 30, `${i}/${j} too close: ${dx},${dy}`);
    }
  }
});

test("the body stands in front of its desk so the desk never covers it", () => {
  for (const s of deskSlots()) {
    const p = seatPoint(s);
    assert.ok(p.y > s.y, "agent is nearer the viewer than the desk");
    // Painter's order: a larger y draws later, so the agent draws over the desk.
    assert.ok(p.y >= s.y);
  }
});

test("a department becomes one contiguous block of desks", () => {
  const { blocks, slots, overflow } = layoutTeams(
    [
      { department: "software-development", label: "Claude Code" },
      { department: "software-development", label: "Codex" },
      { department: "research", label: "Codex" },
    ],
    DEPTS,
    shortName,
  );
  assert.equal(overflow, 0);
  assert.equal(slots.length, 3);
  assert.deepEqual(
    blocks.map((b) => [b.id, b.seats, b.slots.length]),
    [
      ["software-development", 2, 2],
      ["research", 1, 1],
    ],
  );
  // Blocks are laid out front-to-back, never interleaved.
  const first = blocks[0].slots.map((s) => s.index);
  const second = blocks[1].slots.map((s) => s.index);
  assert.ok(Math.max(...first) < Math.min(...second));
});

test("more seats than desks is reported, not silently dropped", () => {
  const capacity = BULLPEN.cols * BULLPEN.rows;
  const seats = Array.from({ length: capacity + 5 }, (_, i) => ({
    department: i % 2 === 0 ? "software-development" : "research",
    label: `seat ${i}`,
  }));
  const { slots, overflow } = layoutTeams(seats, DEPTS, shortName);
  assert.equal(slots.length, capacity);
  assert.equal(overflow, 5);
});

test("an unknown department still gets a labelled block", () => {
  const { blocks } = layoutTeams([{ department: "ghost", label: "x" }], DEPTS, shortName);
  assert.equal(blocks[0].name, "ghost");
  assert.equal(blocks[0].label, "GHOST");
});

test("facing follows the isometric movement axes", () => {
  assert.equal(facingFor(5, -5), "front-left"); // up-right
  assert.equal(facingFor(-5, -5), "front-right"); // up-left
  assert.equal(facingFor(5, 5), "rear-left"); // down-right
  assert.equal(facingFor(-5, 5), "rear-right"); // down-left
  // Standing still keeps the last facing instead of snapping to a default.
  assert.equal(facingFor(0, 0, "rear-right"), "rear-right");
});

test("Claude and Codex keep recognisable bodies without a seat", () => {
  assert.equal(charBaseFor("claude-code"), "Claude-1");
  assert.equal(charBaseFor("codex"), "dev-1");
  // Unknown agents are stable across calls.
  assert.equal(charBaseFor("custom-agent"), charBaseFor("custom-agent"));
});

test("the roster ships both looks, so the floor is never all one gender", () => {
  const women = CHAR_ROSTER.filter((c) => c.look === "f").length;
  const men = CHAR_ROSTER.filter((c) => c.look === "m").length;
  assert.ok(women >= 4, `women in roster: ${women}`);
  assert.ok(men >= 4, `men in roster: ${men}`);
  assert.equal(new Set(CHAR_ROSTER.map((c) => c.base)).size, CHAR_ROSTER.length);
  // The balanced pool alternates, so any prefix is a mixed crew.
  for (let i = 0; i < Math.min(6, CHAR_POOL.length) - 1; i += 2) {
    const a = CHAR_ROSTER.find((c) => c.base === CHAR_POOL[i]);
    const b = CHAR_ROSTER.find((c) => c.base === CHAR_POOL[i + 1]);
    assert.notEqual(a?.look, b?.look, `pool ${i}/${i + 1} same look`);
  }
});

test("eight seats get eight different bodies, mixing looks", () => {
  const keys = Array.from({ length: 8 }, (_, i) => `seat-${i}`);
  const map = bodiesForSeats(keys);
  const bodies = Object.values(map);
  assert.equal(new Set(bodies).size, 8, "no duplicate body on the floor");
  const looks = bodies.map((b) => CHAR_ROSTER.find((c) => c.base === b)?.look);
  assert.ok(looks.includes("f") && looks.includes("m"), "both looks present");
  assert.ok(looks.filter((l) => l === "f").length >= 3, "at least three women");
});

test("an explicit pick still wins over the seat assignment", () => {
  assert.equal(spriteBaseFor("claude-code", { "claude-code": "security" }), "security-audit-1");
  assert.equal(spriteBaseFor("claude-code", {}, "seat-1", "employee-2"), "employee-2");
  // No pick and no assignment falls back to the identity default.
  assert.equal(spriteBaseFor("claude-code"), "Claude-1");
});

test("every sprite path points at the shipped art directory", () => {
  assert.match(charSprite("Claude-1", "front-left").src, /^\/office\/characters\/Claude-1-front-left\.png$/);
  for (const v of ["left-front", "left-rear", "right-front", "right-rear"] as const) {
    assert.match(deskSprite(v).src, /^\/office\/furniture\/standing-desk-.*\.png$/);
    assert.ok(deskSprite(v).w > 40 && deskSprite(v).h > 40);
  }
});

test("waypoints stay on the walkable floor and inside the room", () => {
  assert.ok(WAYPOINTS.length > 8);
  for (const w of WAYPOINTS) {
    assert.ok(w.x > 40 && w.x < SCENE_W - 40, `x ${w.x}`);
    assert.ok(w.y > 220 && w.y < SCENE_H - 40, `y ${w.y}`);
  }
});

test("the clock alone picks day or night art", () => {
  assert.match(roomBackground(12), /office-day/);
  assert.match(roomBackground(7), /office-day/);
  assert.match(roomBackground(18.9), /office-day/);
  assert.match(roomBackground(21), /office-night/);
  assert.match(roomBackground(3), /office-night/);
});
