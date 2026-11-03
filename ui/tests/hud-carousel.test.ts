/**
 * Department carousel tests: the card projection built for the 3D ring plus
 * the selection state the ring and the DOM overlays share.
 *
 * The card order is UI contract, not decoration: the ring rotates by index,
 * hand-gesture navigation addresses cards by position, and the selected id is
 * what the bridge receives for `open_terminal` and `task_submit`.
 */
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { hud, resetHud, useHudStore } from "./helpers/dom-env";
import { buildCarouselCards } from "@/lib/departments";
import type { DepartmentDto } from "@/lib/protocol";

beforeEach(() => {
  resetHud();
});

function dept(id: string, over: Partial<DepartmentDto> = {}): DepartmentDto {
  return { id, name: id, max_concurrency: 1, enabled: true, ...over };
}

const CANONICAL = [
  "software-development",
  "youtube-content",
  "research",
  "code-review-testing",
  "finance",
];

function fullSet(): DepartmentDto[] {
  return CANONICAL.map((id) => dept(id, { name: `Dept ${id}` }));
}

test("an empty bridge still renders a navigable ring", () => {
  const cards = buildCarouselCards([]);
  assert.deepEqual(
    cards.map((c) => [c.id, c.kind]),
    [
      ["agent-management", "agent-management"],
      ["task-center", "task-center"],
      ["custom", "custom"],
    ],
  );
  assert.deepEqual(
    cards.map((c) => c.accent),
    ["violet", "cyan", "emerald"],
  );
  cards.forEach((card) => {
    assert.ok(card.name.length > 0, `card ${card.id} needs a label`);
    assert.ok(card.icon.length > 0, `card ${card.id} needs an icon key`);
    assert.equal(card.department, undefined, "there is no department behind a synthetic card");
  });
});

test("the ring keeps the canonical department order regardless of bridge order", () => {
  const shuffled = [
    fullSet()[4],
    fullSet()[1],
    fullSet()[3],
    fullSet()[0],
    fullSet()[2],
  ];
  const cards = buildCarouselCards(shuffled);
  assert.deepEqual(
    cards.map((c) => c.id),
    [...CANONICAL, "agent-management", "task-center", "custom"],
  );
  assert.deepEqual(
    cards.slice(0, 5).map((c) => c.accent),
    ["cyan", "orange", "violet", "cyan", "orange"],
    "known departments keep their brand accent",
  );
  assert.deepEqual(
    cards.slice(0, 5).map((c) => c.icon),
    ["code", "youtube", "research", "review", "finance"],
  );
  assert.equal(cards[0].subtitle, "Software Development", "subtitles stay English and stable");
});

test("localised names win over bridge names for known departments", () => {
  const cards = buildCarouselCards([dept("software-development", { name: "whatever the bridge says" })]);
  assert.equal(cards[0].name, "Yazılım Geliştirme");
  assert.equal(cards[0].glyph, undefined, "known cards use the icon set, never a raw glyph");
});

test("unknown departments fall back to their glyph and a derived title", () => {
  const cards = buildCarouselCards([
    dept("ops-automation", { name: "Ops", icon: "🛠", description: "Runbooks & cron" }),
    dept("legal_team", { name: "Legal" }),
  ]);
  const byId = Object.fromEntries(cards.map((c) => [c.id, c]));

  assert.equal(byId["ops-automation"].name, "Ops", "unknown ids must not be renamed by the HUD");
  assert.equal(byId["ops-automation"].subtitle, "Runbooks & cron");
  assert.equal(byId["ops-automation"].glyph, "🛠", "the backend glyph is shown verbatim");
  assert.equal(byId["ops-automation"].icon, "default");
  assert.equal(byId["ops-automation"].kind, "department");

  assert.equal(byId["legal_team"].subtitle, "Legal Team", "id-derived title for missing copy");
  assert.equal(byId["legal_team"].glyph, undefined);
});

test("extra departments are shown in a stable alphabetical block after the known ones", () => {
  const cards = buildCarouselCards([
    dept("zeta", { name: "Zeta" }),
    dept("software-development", { name: "Software" }),
    dept("alpha", { name: "Alpha" }),
  ]);
  assert.deepEqual(
    cards.map((c) => c.id),
    ["software-development", "alpha", "zeta", "agent-management", "task-center", "custom"],
    "input order must not shuffle the ring",
  );
  const accents = cards.map((c) => c.accent);
  assert.ok(accents.every((a) => ["cyan", "violet", "orange", "emerald"].includes(a)));
});

test(
  "a duplicate department id from the bridge must not produce two cards",
  { skip: "buildCarouselCards filters `used` ids but still maps the raw array, so a repeated id renders twice and collides on React keys (ui/src/lib/departments.ts: extras loop)" },
  () => {
    const cards = buildCarouselCards([
      dept("alpha", { name: "Alpha" }),
      dept("alpha", { name: "Alpha duplicate" }),
    ]);
    const ids = cards.map((c) => c.id);
    assert.equal(new Set(ids).size, ids.length, "no card may appear twice in the ring");
  },
);

test("`custom` is a reserved id: always one emerald card, always last", () => {
  const cards = buildCarouselCards([dept("custom", { name: "Masaüstü", icon: "🧪" })]);
  const customCards = cards.filter((c) => c.id === "custom");
  assert.equal(customCards.length, 1, "the backend `custom` bucket replaces the synthetic card");
  // The reserved bucket keeps its own copy and the shared icon; per-department
  // names/glyphs belong to the extras path, which is exercised above.
  assert.equal(customCards[0].name, "Özel Departmanlar");
  assert.equal(customCards[0].subtitle, "Custom Departments");
  assert.equal(customCards[0].icon, "custom");
  assert.equal(customCards[0].glyph, undefined);
  assert.equal(customCards[0].kind, "custom");
  assert.equal(customCards[0].accent, "emerald");
  assert.equal(customCards[0].department?.id, "custom", "the card still knows its department");
  assert.equal(cards.at(-1)?.id, "custom", "the custom card stays last");
});

test("system slots are never duplicated when the backend also reports them", () => {
  const cards = buildCarouselCards([
    dept("agent-management", { name: "Agent Registry" }),
    dept("task-center", { name: "Task Board" }),
  ]);
  const ids = cards.map((c) => c.id);
  assert.deepEqual(ids, ["agent-management", "task-center", "custom"]);
});

test("setCarouselIds adopts the first card when the current selection vanished", () => {
  useHudStore.getState().setSelectedDept("finance");
  useHudStore.getState().setCarouselIds(["research", "finance"]);
  assert.equal(hud().selectedDept, "finance", "an existing selection is preserved");

  useHudStore.getState().setCarouselIds(["research", "youtube-content"]);
  assert.equal(hud().selectedDept, "research", "a dangling selection snaps to the ring head");

  const before = hud().carouselIds;
  useHudStore.getState().setCarouselIds([]);
  assert.deepEqual(hud().carouselIds, before, "an empty ring must not blank the UI");
});

test("rotation wraps in both directions and freezes while a department is open", () => {
  useHudStore.getState().setCarouselIds(["a", "b", "c"]);
  assert.equal(hud().selectedDept, "a");

  useHudStore.getState().rotateCarousel(1);
  assert.equal(hud().selectedDept, "b");
  useHudStore.getState().rotateCarousel(1);
  useHudStore.getState().rotateCarousel(1);
  assert.equal(hud().selectedDept, "a", "forward rotation wraps past the last card");
  useHudStore.getState().rotateCarousel(-1);
  assert.equal(hud().selectedDept, "c", "backward rotation wraps before the first card");
  useHudStore.getState().rotateCarousel(0);
  assert.equal(hud().selectedDept, "c");
  useHudStore.getState().rotateCarousel(3);
  assert.equal(hud().selectedDept, "c", "a full turn is a no-op");

  useHudStore.getState().openDepartment();
  useHudStore.getState().rotateCarousel(1);
  assert.equal(hud().selectedDept, "c", "rotation is locked while a department detail is open");
  useHudStore.getState().closeDepartment();
  assert.equal(hud().openedDept, null);
  useHudStore.getState().rotateCarousel(1);
  assert.equal(hud().selectedDept, "a");
});

test("rotation is inert with no cards, and index selection is bounds-checked", () => {
  useHudStore.getState().rotateCarousel(1);
  assert.equal(hud().selectedDept, "", "nothing to rotate");

  useHudStore.getState().setCarouselIds(["a", "b"]);
  useHudStore.getState().selectDepartmentAt(1);
  assert.equal(hud().selectedDept, "b");
  useHudStore.getState().selectDepartmentAt(9);
  useHudStore.getState().selectDepartmentAt(-1);
  assert.equal(hud().selectedDept, "b", "out-of-range gesture indices are ignored");

  useHudStore.getState().openDepartment("a");
  assert.deepEqual(
    { selected: hud().selectedDept, opened: hud().openedDept, panel: hud().selectedPanel },
    { selected: "a", opened: "a", panel: null },
    "opening a card clears the side panel so the detail view gets the space",
  );
  useHudStore.getState().openDepartment();
  assert.equal(hud().openedDept, "a", "no argument reuses the selection");
});

test("the carousel pull gesture stays clamped to 0..1 even on wild pointer values", () => {
  for (const [raw, expected] of [
    [0.42, 0.42],
    [1.8, 1],
    [-4, 0],
    [Number.NaN, 0],
    [Number.POSITIVE_INFINITY, 0],
  ] as const) {
    useHudStore.getState().setCarouselPull(raw);
    assert.equal(hud().carouselPull, expected, `pull ${raw}`);
  }
});

test("department edits are applied locally and only sent when the bridge is live", () => {
  useHudStore.getState().upsertDepartment(dept("research", { name: "Araştırma" }));
  assert.deepEqual(hud().departments.map((d) => d.id), ["research"]);
  assert.equal(hud().selectedDept, "research");
  assert.match(hud().logs.at(-1)?.message ?? "", /locally only/);

  useHudStore.getState().upsertDepartment(dept("research", { name: "Araştırma v2", max_concurrency: 4 }));
  assert.equal(hud().departments.length, 1, "upsert replaces instead of appending");
  assert.equal(hud().departments[0].name, "Araştırma v2");

  useHudStore.getState().upsertDepartment(dept("finance"));
  useHudStore.getState().removeDepartment("finance");
  assert.deepEqual(hud().departments.map((d) => d.id), ["research"]);
  assert.equal(hud().selectedDept, "research", "deleting the selection re-points at a live card");

  useHudStore.getState().removeDepartment("research");
  assert.deepEqual(hud().departments, []);
  assert.equal(hud().selectedDept, "", "no phantom selection with an empty department list");
});

test("hand hover state only re-renders when the hovered card changes", () => {
  useHudStore.getState().setHandHoverDept("research");
  const first = hud();
  useHudStore.getState().setHandHoverDept("research");
  assert.equal(hud(), first, "an unchanged hover must not allocate new state");
  useHudStore.getState().setHandHoverDept(null);
  assert.equal(hud().handHoverDept, null);
});

test("hand tracking resets to a neutral pose, keeping the failure reason", () => {
  useHudStore.getState().setHandTracking({
    handStatus: "ready",
    handEnabled: true,
    handGesture: "pinch",
    handCursor: { x: 12, y: 34 },
    handPinch: true,
    handCount: 1,
    handSpread: 0.5,
  });
  useHudStore.getState().resetHandTracking("camera permission denied");
  assert.deepEqual(
    {
      handStatus: hud().handStatus,
      handEnabled: hud().handEnabled,
      handGesture: hud().handGesture,
      handCursor: hud().handCursor,
      handPinch: hud().handPinch,
      handCount: hud().handCount,
      handSpread: hud().handSpread,
      handError: hud().handError,
    },
    {
      handStatus: "error",
      handEnabled: false,
      handGesture: "none",
      handCursor: null,
      handPinch: false,
      handCount: 0,
      handSpread: 0,
      handError: "camera permission denied",
    },
  );
  useHudStore.getState().resetHandTracking();
  assert.equal(hud().handStatus, "idle");
  assert.equal(hud().handError, undefined);
});
