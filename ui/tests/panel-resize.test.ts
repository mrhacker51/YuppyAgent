/**
 * Matrix column geometry. The important contract: a stale or extreme weight
 * from localStorage can never collapse a terminal into an unusable sliver —
 * a 0.24fr column used to become ~90px, which made Claude/Codex wrap at 11
 * columns and look broken.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  autoColumnCount,
  clampPx,
  dragColumn,
  dragRow,
  gridTemplate,
  LEAD_RAIL_DEFAULT_PX,
  LEAD_RAIL_MAX_PX,
  LEAD_RAIL_MIN_PX,
  MATRIX_MIN_COL_PX,
  MATRIX_MIN_ROW_PX,
  normalizeWeights,
  rowsTemplate,
  weightsAreCustom,
  weightsFor,
} from "@/lib/panelResize";

test("every track carries a real pixel floor", () => {
  const template = gridTemplate([0.24, 0.82, 1]);
  assert.equal((template.match(/minmax\(/g) ?? []).length, 3);
  for (const t of template.match(/minmax\([^)]*\)/g) ?? []) {
    assert.match(t, new RegExp(`^minmax\\(${MATRIX_MIN_COL_PX}px, .+fr\\)$`));
  }
});

test("a collapsed stored weight still renders with the floor", () => {
  // The exact value found in a real desktop profile.
  const template = gridTemplate([0.241923727111289, 0.822017186275005, 1]);
  assert.ok(template.startsWith(`minmax(${MATRIX_MIN_COL_PX}px,`), template);
});

test("weights stay fractional so the grid still scales with the window", () => {
  assert.equal(gridTemplate([1, 1]), `minmax(${MATRIX_MIN_COL_PX}px, 1fr) minmax(${MATRIX_MIN_COL_PX}px, 1fr)`);
  assert.match(gridTemplate([2, 1]), /2fr/);
});

test("no weights means one neutral track", () => {
  assert.equal(gridTemplate([]), "minmax(0, 1fr)");
});

test("a drag never produces a weight that maps below the minimum", () => {
  const out = dragColumn([1, 1], 0, -5000, 900);
  assert.equal(out.length, 2);
  for (const w of out) assert.ok(Number.isFinite(w) && w > 0, String(w));
  // the dragged column kept a usable share of the row
  assert.ok(out[0] / (out[0] + out[1]) > 0.2, JSON.stringify(out));
});

test("stored junk is normalized instead of trusted", () => {
  assert.deepEqual(normalizeWeights([NaN, -3, "x", 2]), [1, 1, 1, 2]);
  assert.deepEqual(weightsFor(3, [2]), [2, 1, 1]);
  assert.equal(weightsAreCustom([1, 1]), false);
  assert.equal(weightsAreCustom([1, 1.2]), true);
});

test("auto column count never returns zero", () => {
  assert.equal(autoColumnCount(0), 1);
  assert.equal(autoColumnCount(1000, 240, 4), 4);
});

test("row tracks mirror column tracks, with their own floor", () => {
  const template = rowsTemplate([1, 1]);
  assert.equal(
    template,
    `minmax(${MATRIX_MIN_ROW_PX}px, 1fr) minmax(${MATRIX_MIN_ROW_PX}px, 1fr)`,
  );
  assert.equal(rowsTemplate([]), `minmax(${MATRIX_MIN_ROW_PX}px, 1fr)`);
});

test("dragging a row edge conserves the two rows' total height", () => {
  const before = [1, 1];
  const after = dragRow(before, 0, 60, 900);
  const total = after.reduce((sum, w) => sum + w, 0);
  assert.ok(Math.abs(total - 2) < 1e-9, JSON.stringify(after));
  assert.ok(after[0] > after[1], JSON.stringify(after));
});

test("a row drag can never squash a terminal below the usable floor", () => {
  const out = dragRow([1, 1], 0, -5000, 900);
  for (const w of out) assert.ok(Number.isFinite(w) && w > 0, String(w));
  assert.ok(out[0] / (out[0] + out[1]) > 0.2, JSON.stringify(out));
});

test("panel pixels are clamped into their advertised band", () => {
  assert.equal(clampPx("nan", 10, 20, 15), 15);
  assert.equal(clampPx(-999, LEAD_RAIL_MIN_PX, LEAD_RAIL_MAX_PX, LEAD_RAIL_DEFAULT_PX), LEAD_RAIL_MIN_PX);
  assert.equal(clampPx(9999, LEAD_RAIL_MIN_PX, LEAD_RAIL_MAX_PX, LEAD_RAIL_DEFAULT_PX), LEAD_RAIL_MAX_PX);
});
