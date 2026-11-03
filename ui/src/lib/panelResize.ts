/**
 * Pointer-resizable geometry for the deck.
 *
 * Two things are resizable horizontally, and both must survive a reload:
 *
 *   1. The AgentSpace split — the left column (office / orders / mission
 *      console) against the terminal matrix. Stored as one percentage share.
 *   2. The terminal matrix columns themselves. Stored as a fractional weight
 *      per column, so the grid still scales with the window and never pins a
 *      pixel width that overflows on a smaller screen.
 *
 * Everything here is pure + clamped: drags come from the pointer and
 * `localStorage`, both of which can hand us NaN, negatives or stale sizes.
 */

export const DECK_SPLIT_STORAGE_KEY = "yuppy.deck.split.v1";
export const MATRIX_WEIGHTS_STORAGE_KEY = "yuppy.matrix.weights.v1";
/** Office against the mission console, inside the left column. */
export const OFFICE_SPLIT_STORAGE_KEY = "yuppy.deck.office.v1";
/** Lead-agent column width, in CSS pixels (it is a fixed rail, not a share). */
export const LEAD_RAIL_STORAGE_KEY = "yuppy.deck.leadRail.v1";
/** Row heights inside the terminal matrix (which Claude/Codex cards grow). */
export const MATRIX_ROW_WEIGHTS_STORAGE_KEY = "yuppy.matrix.rows.v1";
/** Per-team lead monitor height. */
export const LEAD_CARD_HEIGHT_STORAGE_KEY = "yuppy.leads.height.v1";
/** Lead Claude command window against the worker matrix (right column). */
export const COMMAND_SPLIT_STORAGE_KEY = "yuppy.deck.command.v1";

/** The deck's left column can never be squeezed out or swallow the matrix. */
export const DECK_MIN_SHARE = 18;
export const DECK_MAX_SHARE = 82;
export const DECK_DEFAULT_SPLIT = 34;
/** One keyboard / double-click reset unit, in percent. */
export const DECK_KEYBOARD_STEP = 2;

/** Office share of its column; the console keeps at least 26%. */
export const OFFICE_MIN_SHARE = 28;
export const OFFICE_MAX_SHARE = 74;
export const OFFICE_DEFAULT_SHARE = 54;

/** The lead Claude terminal is the main surface: it gets the larger share of
 * its column by default, the worker matrix keeps at least 25%. */
export const COMMAND_MIN_SHARE = 30;
export const COMMAND_MAX_SHARE = 75;
export const COMMAND_DEFAULT_SHARE = 58;

/** The lead rail holds a role name, a CLI badge and a terminal monitor. */
export const LEAD_RAIL_MIN_PX = 260;
export const LEAD_RAIL_MAX_PX = 560;
export const LEAD_RAIL_DEFAULT_PX = 336;

/** Lead monitor height bounds (a real PTY frame needs a few rows). */
export const LEAD_CARD_MIN_PX = 88;
export const LEAD_CARD_MAX_PX = 420;
export const LEAD_CARD_DEFAULT_PX = 132;

/** A CLI column narrower than this is unusable — Claude/Codex wrap instantly. */
export const MATRIX_MIN_COL_PX = 240;
/** A terminal row shorter than this clips the CLI's own chrome. */
export const MATRIX_MIN_ROW_PX = 190;
/** Tailwind `gap-1` between matrix cards, in CSS pixels. */
export const MATRIX_GAP_PX = 4;
export const MATRIX_KEYBOARD_STEP_PX = 32;

function finite(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/** Clamp a percentage share into the drawable band. */
export function clampShare(
  value: number,
  min = DECK_MIN_SHARE,
  max = DECK_MAX_SHARE,
): number {
  const v = finite(value, DECK_DEFAULT_SPLIT);
  return Math.round(Math.min(max, Math.max(min, v)));
}

export function loadDeckSplit(): number {
  if (typeof window === "undefined") return DECK_DEFAULT_SPLIT;
  try {
    const raw = localStorage.getItem(DECK_SPLIT_STORAGE_KEY);
    if (raw === null) return DECK_DEFAULT_SPLIT;
    return clampShare(Number(raw));
  } catch {
    return DECK_DEFAULT_SPLIT;
  }
}

export function persistDeckSplit(share: number): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(DECK_SPLIT_STORAGE_KEY, String(clampShare(share)));
  } catch {
    // Presentation only; an unavailable storage backend is not fatal.
  }
}

/**
 * How many `minPx`-wide tracks fit in `containerPx` with `gapPx` gutters —
 * the same maths CSS `repeat(auto-fit, minmax(minPx, 1fr))` applies, done in
 * JS so a drag can be mapped onto a real column index.
 */
export function autoColumnCount(
  containerPx: number,
  minPx = MATRIX_MIN_COL_PX,
  gapPx = MATRIX_GAP_PX,
): number {
  const width = finite(containerPx, 0);
  if (width <= 0 || minPx <= 0) return 1;
  const count = Math.floor((width + gapPx) / (minPx + gapPx));
  return Math.max(1, count);
}

/** Normalize anything persisted into a positive finite weight list. */
export function normalizeWeights(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((v) => finite(v, 1))
    .map((v) => (v > 0 ? v : 1))
    .slice(0, 24);
}

/**
 * The weight list for a grid with exactly `count` columns: the operator's
 * stored weights, extended or truncated to match. A grid that grew a column
 * gets a neutral 1fr for the newcomer instead of shifting the others.
 */
export function weightsFor(count: number, stored: number[]): number[] {
  const n = Math.max(1, Math.floor(finite(count, 1)));
  const list = normalizeWeights(stored);
  return Array.from({ length: n }, (_, i) => finite(list[i], 1));
}

/**
 * `minmax(FLOORpx, Wfr)` tracks.
 *
 * The floor is what makes a stale localStorage weight harmless: a column
 * dragged when the deck was narrower could persist as 0.24fr and collapse a
 * terminal to ~11 columns, which makes Claude/Codex wrap every word. A real
 * CSS pixel floor keeps every live PTY usable, and the fr part still scales
 * with the window.
 */
export function gridTemplate(
  weights: number[],
  minPx = MATRIX_MIN_COL_PX,
): string {
  const list = normalizeWeights(weights);
  if (list.length === 0) return "minmax(0, 1fr)";
  const floor = Math.max(0, Math.round(finite(minPx, 0)));
  return list
    .map((w) => `minmax(${floor}px, ${Number(w.toFixed(4))}fr)`)
    .join(" ");
}

/**
 * Convert a pixel drag into fractional weight and move it from column `index`
 * to its right neighbour. The total is conserved, so dragging one column wider
 * genuinely steals width from the neighbour instead of reflowing the deck.
 * Neither column may drop below `minFr`.
 */
export function resizePair(
  weights: number[],
  index: number,
  deltaFr: number,
  minFr: number,
): number[] {
  const list = weightsFor(weights.length, weights);
  if (index < 0 || index + 1 >= list.length) return list;
  const left = list[index];
  const right = list[index + 1];
  const floor = Math.max(0, finite(minFr, 0));
  let delta = finite(deltaFr, 0);
  delta = Math.min(delta, Math.max(0, left - floor));
  delta = Math.max(delta, -Math.max(0, right - floor));
  if (delta === 0) return list;
  const next = [...list];
  next[index] = left + delta;
  next[index + 1] = right - delta;
  return next;
}

/** Fractional weight per CSS pixel for a grid of `weights` in `containerPx`. */
export function frPerPx(weights: number[], containerPx: number, gapPx = MATRIX_GAP_PX): number {
  const list = normalizeWeights(weights);
  const total = list.reduce((sum, w) => sum + w, 0);
  const available = finite(containerPx, 0) - Math.max(0, list.length - 1) * gapPx;
  if (total <= 0 || available <= 0) return 1;
  return total / available;
}

/**
 * Apply a pixel drag to a column pair. Returns the new weights, or the input
 * unchanged while the grid has no measurable width (hidden tab, first frame).
 */
export function dragColumn(
  weights: number[],
  index: number,
  deltaPx: number,
  containerPx: number,
  gapPx = MATRIX_GAP_PX,
  minColPx = MATRIX_MIN_COL_PX,
): number[] {
  const list = weightsFor(weights.length, weights);
  const available = finite(containerPx, 0) - Math.max(0, list.length - 1) * gapPx;
  if (available <= 0) return list;
  const scale = frPerPx(list, containerPx, gapPx);
  return resizePair(list, index, finite(deltaPx, 0) * scale, minColPx * scale);
}

export function loadMatrixWeights(): number[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(MATRIX_WEIGHTS_STORAGE_KEY);
    return raw ? normalizeWeights(JSON.parse(raw)) : [];
  } catch {
    return [];
  }
}

export function persistMatrixWeights(weights: number[]): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(MATRIX_WEIGHTS_STORAGE_KEY, JSON.stringify(normalizeWeights(weights)));
  } catch {
    // Presentation only.
  }
}

/** True when the operator actually widened something (drives the reset button). */
export function weightsAreCustom(weights: number[]): boolean {
  return normalizeWeights(weights).some((w) => Math.abs(w - 1) > 0.01);
}

/* ── Every panel edge is draggable ───────────────────────────────────────── */

function readStored(key: string): string | null {
  if (typeof window === "undefined") return null;
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStored(key: string, value: string): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(key, value);
  } catch {
    // Presentation only.
  }
}

/** Clamp an arbitrary stored number into `[min, max]`. */
export function clampPx(value: unknown, min: number, max: number, fallback: number): number {
  const v = finite(typeof value === "string" ? Number(value) : value, fallback);
  return Math.round(Math.min(max, Math.max(min, v)));
}

/* Office / console split inside the left column. */

export function loadOfficeSplit(): number {
  const raw = readStored(OFFICE_SPLIT_STORAGE_KEY);
  return raw === null
    ? OFFICE_DEFAULT_SHARE
    : clampShare(Number(raw), OFFICE_MIN_SHARE, OFFICE_MAX_SHARE);
}

export function persistOfficeSplit(share: number): void {
  writeStored(OFFICE_SPLIT_STORAGE_KEY, String(clampShare(share, OFFICE_MIN_SHARE, OFFICE_MAX_SHARE)));
}

/* Lead command window / worker matrix split inside the right column. */

export function loadCommandSplit(): number {
  const raw = readStored(COMMAND_SPLIT_STORAGE_KEY);
  const value = raw === null ? NaN : Number(raw);
  return Number.isFinite(value)
    ? clampShare(value, COMMAND_MIN_SHARE, COMMAND_MAX_SHARE)
    : COMMAND_DEFAULT_SHARE;
}

export function persistCommandSplit(share: number): void {
  writeStored(
    COMMAND_SPLIT_STORAGE_KEY,
    String(clampShare(share, COMMAND_MIN_SHARE, COMMAND_MAX_SHARE)),
  );
}

/* Lead-agent rail width. */

export function loadLeadRail(): number {
  return clampPx(readStored(LEAD_RAIL_STORAGE_KEY), LEAD_RAIL_MIN_PX, LEAD_RAIL_MAX_PX, LEAD_RAIL_DEFAULT_PX);
}

export function persistLeadRail(width: number): void {
  writeStored(
    LEAD_RAIL_STORAGE_KEY,
    String(clampPx(width, LEAD_RAIL_MIN_PX, LEAD_RAIL_MAX_PX, LEAD_RAIL_DEFAULT_PX)),
  );
}

/* Lead monitor height, one value shared by every team card. */

export function loadLeadCardHeight(): number {
  return clampPx(
    readStored(LEAD_CARD_HEIGHT_STORAGE_KEY),
    LEAD_CARD_MIN_PX,
    LEAD_CARD_MAX_PX,
    LEAD_CARD_DEFAULT_PX,
  );
}

export function persistLeadCardHeight(height: number): void {
  writeStored(
    LEAD_CARD_HEIGHT_STORAGE_KEY,
    String(clampPx(height, LEAD_CARD_MIN_PX, LEAD_CARD_MAX_PX, LEAD_CARD_DEFAULT_PX)),
  );
}

/* Matrix rows — the vertical edge between Claude/Codex card rows. */

export function loadMatrixRowWeights(): number[] {
  const raw = readStored(MATRIX_ROW_WEIGHTS_STORAGE_KEY);
  if (!raw) return [];
  try {
    return normalizeWeights(JSON.parse(raw));
  } catch {
    return [];
  }
}

export function persistMatrixRowWeights(weights: number[]): void {
  writeStored(MATRIX_ROW_WEIGHTS_STORAGE_KEY, JSON.stringify(normalizeWeights(weights)));
}

/** `minmax(FLOORpx, Wfr)` row tracks, mirroring `gridTemplate`. */
export function rowsTemplate(weights: number[], minPx = MATRIX_MIN_ROW_PX): string {
  const list = normalizeWeights(weights);
  if (list.length === 0) return `minmax(${Math.round(minPx)}px, 1fr)`;
  const floor = Math.max(0, Math.round(finite(minPx, 0)));
  return list
    .map((w) => `minmax(${floor}px, ${Number(w.toFixed(4))}fr)`)
    .join(" ");
}

/** Pixel drag on the horizontal edge between row `index` and `index + 1`. */
export function dragRow(
  weights: number[],
  index: number,
  deltaPx: number,
  containerPx: number,
  gapPx = MATRIX_GAP_PX,
  minRowPx = MATRIX_MIN_ROW_PX,
): number[] {
  const list = weightsFor(weights.length, weights);
  const available = finite(containerPx, 0) - Math.max(0, list.length - 1) * gapPx;
  if (available <= 0) return list;
  const scale = frPerPx(list, containerPx, gapPx);
  return resizePair(list, index, finite(deltaPx, 0) * scale, minRowPx * scale);
}
