/**
 * Office scene geometry and sprite manifest.
 *
 * The room art, furniture and character sprites are the MIT-licensed set from
 * W17ant/Claude-Office (see `public/office/NOTICE.md`); the Dunder Mifflin fan
 * skin and its props are deliberately NOT copied. Sizes below are the display
 * sizes that set was authored against (an 800×600 room), so the whole scene
 * keeps the same proportions as the reference.
 *
 * Everything here is pure: seat → desk placement, department blocks, walking
 * waypoints and the direction→sprite rule. The canvas renderer only consumes
 * these values, which is what makes the layout testable.
 */

export const SCENE_W = 800;
export const SCENE_H = 600;

export interface SpriteDef {
  /** Path under `/office/…` */
  src: string;
  /** Display width/height in scene pixels */
  w: number;
  h: number;
}

/** Character sheets: four facings, one sprite each (no walk frames). */
export type Facing = "front-left" | "front-right" | "rear-left" | "rear-right";

export const CHAR_W = 32;
export const CHAR_H = 66;

export const CHAR_BASES = [
  "Claude-1",
  "dev-1",
  "dev-2",
  "employee-1",
  "employee-2",
  "employee-3",
  "Frontend-dev-1",
  "security-audit-1",
  "explore-1",
] as const;

/**
 * Every shipped body, tagged so the office can be staffed with a mixed crew
 * instead of nine copies of the same two men. Without this the room reads as
 * uniform, because every seat belongs to one of only two CLIs.
 */
export const CHAR_ROSTER: ReadonlyArray<{ base: (typeof CHAR_BASES)[number]; look: "f" | "m" }> = [
  { base: "Claude-1", look: "m" },
  { base: "dev-1", look: "m" },
  { base: "employee-1", look: "m" },
  { base: "employee-3", look: "m" },
  { base: "explore-1", look: "m" },
  { base: "dev-2", look: "f" },
  { base: "employee-2", look: "f" },
  { base: "Frontend-dev-1", look: "f" },
  { base: "security-audit-1", look: "f" },
];

/** Balanced body order: alternating looks, so any prefix is a mixed crew. */
export const CHAR_POOL: readonly string[] = (() => {
  const men = CHAR_ROSTER.filter((c) => c.look === "m").map((c) => c.base);
  const women = CHAR_ROSTER.filter((c) => c.look === "f").map((c) => c.base);
  const out: string[] = [];
  for (let i = 0; i < Math.max(men.length, women.length); i++) {
    if (women[i]) out.push(women[i]);
    if (men[i]) out.push(men[i]);
  }
  return out;
})();

/**
 * One body per seat, assigned round-robin from the balanced pool.
 *
 * Round-robin beats hashing here: with eight seats on the floor, a hash can
 * hand out five of the same body by chance, and the room reads as one person
 * cloned. Cycling guarantees every neighbour looks different and the crew is
 * evenly mixed.
 */
export function bodiesForSeats(seatKeys: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  seatKeys.forEach((key, i) => {
    out[key] = CHAR_POOL[i % CHAR_POOL.length];
  });
  return out;
}

/** Which body an agent gets when the operator has not picked one.
 *
 * `discriminator` is the seat key: every seat of the same CLI must look
 * different, otherwise a room full of Claude Code seats is a room full of one
 * person. Claude and Codex still lead with their signature bodies.
 */
export function charBaseFor(agent: string, discriminator = ""): string {
  const a = agent.toLowerCase();
  const key = `${a}|${discriminator}`;
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  const pool = CHAR_POOL;
  const pick = pool[h % pool.length];
  if (!discriminator) {
    // Identity default (no seat given): keep the CLI recognisable.
    if (a.includes("claude")) return "Claude-1";
    if (a.includes("codex")) return "dev-1";
  }
  if (a.includes("claude") && pick === "Claude-1") return "Claude-1";
  if (a.includes("codex") && pick === "dev-1") return "dev-1";
  return pick;
}

export function charSprite(base: string, facing: Facing): SpriteDef {
  return { src: `/office/characters/${base}-${facing}.png`, w: CHAR_W, h: CHAR_H };
}

/**
 * Facing from a movement delta. The room is drawn in the same isometric
 * orientation as the reference art: down-right means we see the agent's back
 * on the left, down-left the back on the right, and so on.
 */
export function facingFor(dx: number, dy: number, previous: Facing = "front-left"): Facing {
  if (Math.abs(dx) < 0.01 && Math.abs(dy) < 0.01) return previous;
  if (dy < 0 && dx >= 0) return "front-left";
  if (dy < 0 && dx < 0) return "front-right";
  if (dy >= 0 && dx >= 0) return "rear-left";
  return "rear-right";
}

export const DESK_W = 84;
export const DESK_H = 106;

export type DeskVariant = "left-front" | "left-rear" | "right-front" | "right-rear";

export function deskSprite(variant: DeskVariant): SpriteDef {
  return {
    src: `/office/furniture/standing-desk-${variant}.png`,
    w: DESK_W,
    h: DESK_H,
  };
}

/* ── bullpen layout ─────────────────────────────────────────────────── */

/**
 * The bullpen grid, in scene pixels.
 *
 * Steps follow the room's own isometric axes: a column moves down-right and
 * back a row moves down-left. Spacing is deliberately generous (96 px against
 * an 84 px desk) so the clusters read as separate desks with aisles between
 * them, like the reference art, instead of one fused block of monitors.
 */
export const BULLPEN = {
  cols: 4,
  rows: 4,
  base: { x: 316, y: 292 },
  colStep: { x: 84, y: 38 },
  rowStep: { x: -58, y: 33 },
  /**
   * Extra gap injected between column 1 and 2. Without it the four columns
   * fuse into one wall of monitors; with it the room reads as two desk pods
   * either side of a centre aisle, like the reference office.
   */
  podGap: { x: 46, y: 22 },
};

export interface DeskSlot {
  index: number;
  col: number;
  row: number;
  x: number;
  y: number;
  variant: DeskVariant;
}

/**
 * Desk slots in department-block order: row by row from the front, so a team
 * filing into the room fills the nearest desks first and the room always looks
 * occupied from the front instead of having one lonely desk in a far corner.
 */
export function deskSlots(): DeskSlot[] {
  const slots: DeskSlot[] = [];
  const { cols, rows, base, colStep, rowStep, podGap } = BULLPEN;
  let index = 0;
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      // The pod gap shifts every desk to the right of the centre aisle.
      const gapK = col >= cols / 2 ? 1 : 0;
      slots.push({
        index,
        col,
        row,
        x: base.x + col * colStep.x + row * rowStep.x + gapK * podGap.x,
        y: base.y + col * colStep.y + row * rowStep.y + gapK * podGap.y,
        variant:
          row % 2 === 0
            ? col % 2 === 0
              ? "left-front"
              : "right-front"
            : col % 2 === 0
              ? "left-rear"
              : "right-rear",
      });
      index++;
    }
  }
  return slots;
}

export interface TeamBlock {
  /** Department id (or "" for the fallback group). */
  id: string;
  name: string;
  /** Short label for the floor chip. */
  label: string;
  seats: number;
  slots: DeskSlot[];
  /** Label anchor (scene px), centred over the block. */
  chipX: number;
  chipY: number;
}

/**
 * Split the seat list into contiguous desk blocks, one per department.
 *
 * A department never shares a desk, and blocks are sized by how many seats the
 * department actually has — no invented teams. When the room runs out of desks
 * the remainder is reported so the UI can be honest about it.
 */
export function layoutTeams(
  seats: Array<{ department: string; label: string }>,
  departments: Array<{ id: string; name: string }>,
  shortName: (name: string) => string,
): { blocks: TeamBlock[]; overflow: number; slots: DeskSlot[] } {
  const slots = deskSlots();
  const blocks: TeamBlock[] = [];
  const order: string[] = [];
  const byDept = new Map<string, number>();
  for (const seat of seats) {
    const id = seat.department || "";
    if (!byDept.has(id)) {
      byDept.set(id, 0);
      order.push(id);
    }
    byDept.set(id, (byDept.get(id) ?? 0) + 1);
  }

  let cursor = 0;
  let overflow = 0;
  for (const id of order) {
    const count = byDept.get(id) ?? 0;
    const take = Math.min(count, slots.length - cursor);
    if (take < count) overflow += count - take;
    if (take <= 0) continue;
    const own = slots.slice(cursor, cursor + take);
    cursor += take;
    const dept = departments.find((d) => d.id === id);
    const name = dept?.name ?? (id || "Ofis");
    const xs = own.map((s) => s.x);
    const ys = own.map((s) => s.y);
    blocks.push({
      id,
      name,
      label: shortName(name).slice(0, 12),
      seats: count,
      slots: own,
      chipX: (Math.min(...xs) + Math.max(...xs)) / 2,
      // Under the front row of the block, where a rug label belongs.
      chipY: Math.max(...ys) + 16,
    });
  }
  return { blocks, overflow, slots: slots.slice(0, cursor) };
}

/**
 * Seat point for a desk.
 *
 * The agents stand at the near edge of their workstation (slightly in front of
 * the desk's floor contact point), which is how the reference art reads: the
 * body is fully visible with the monitors behind it, not cropped by the desk
 * top. Their larger scene-y also puts them after the desk in the painter's
 * order, so the desk never draws over a person.
 */
export function seatPoint(slot: DeskSlot) {
  return { x: slot.x - 10, y: slot.y + 12 };
}

/* ── wandering ──────────────────────────────────────────────────────── */

export interface Waypoint {
  x: number;
  y: number;
  /** What the spot is, for debugging and for future ambient props. */
  kind: "aisle" | "coffee" | "window" | "plant" | "board" | "water";
}

/**
 * Aisle network. Agents only walk on these lines, so they never stroll through
 * a desk cluster — the same idea as the reference project's waypoints, trimmed
 * to the aisles this bullpen actually has.
 */
export const WAYPOINTS: Waypoint[] = [
  { x: 246, y: 408, kind: "aisle" },
  { x: 326, y: 408, kind: "aisle" },
  { x: 406, y: 408, kind: "aisle" },
  { x: 486, y: 408, kind: "aisle" },
  { x: 566, y: 408, kind: "aisle" },

  { x: 246, y: 296, kind: "aisle" },
  { x: 326, y: 296, kind: "aisle" },
  { x: 406, y: 296, kind: "aisle" },
  { x: 486, y: 296, kind: "aisle" },
  { x: 566, y: 296, kind: "aisle" },

  { x: 326, y: 520, kind: "aisle" },
  { x: 406, y: 520, kind: "aisle" },
  { x: 486, y: 520, kind: "aisle" },

  { x: 690, y: 330, kind: "coffee" },
  { x: 660, y: 300, kind: "coffee" },
  { x: 150, y: 330, kind: "window" },
  { x: 120, y: 420, kind: "window" },
  { x: 700, y: 470, kind: "plant" },
  { x: 600, y: 280, kind: "board" },
  { x: 470, y: 268, kind: "water" },
];

/* ── furniture ──────────────────────────────────────────────────────── */

export interface PropPlacement {
  /** Sprite key in `/office/…`. */
  src: string;
  w: number;
  h: number;
  x: number;
  y: number;
  /** Optional tint/light pulse kind. */
  live?: "coffee" | "printer";
}

/** Static furniture that dresses the room. Positions follow the room art. */
export const PROPS: PropPlacement[] = [
  { src: "/office/appliances/coffee-on.png", w: 24, h: 31, x: 690, y: 322, live: "coffee" },
  { src: "/office/decoration/printer-working.png", w: 25, h: 31, x: 640, y: 286, live: "printer" },
  { src: "/office/decoration/monstera-plant.png", w: 23, h: 32, x: 706, y: 470 },
  { src: "/office/decoration/snake-plant.png", w: 18, h: 28, x: 150, y: 296 },
  { src: "/office/decoration/money-tree.png", w: 19, h: 28, x: 96, y: 458 },
  { src: "/office/furniture/filling-closed.png", w: 19, h: 25, x: 612, y: 340 },
];

/** Day/night room art, chosen from the operator's real clock. */
export function roomBackground(hour: number): string {
  return hour >= 7 && hour < 19
    ? "/office/rooms/office-day.png"
    : "/office/rooms/office-night.png";
}
