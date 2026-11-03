/**
 * Office camera contract. These clamps are the difference between "the map
 * pans smoothly" and "the operator dragged the office off screen and cannot
 * find it again".
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  clampCamera,
  clampZoom,
  focusOn,
  MAX_ZOOM,
  MIN_ZOOM,
  panBounds,
  visibleRect,
  zoomAt,
} from "@/lib/officeCamera";

const W = 430;
const H = 330;

test("zoom is clamped into the usable band", () => {
  assert.equal(clampZoom(0.2), MIN_ZOOM);
  assert.equal(clampZoom(99), MAX_ZOOM);
  assert.equal(clampZoom(NaN), MIN_ZOOM);
  assert.equal(clampZoom(2), 2);
});

test("at 1x there is nothing to pan", () => {
  const c = clampCamera({ zoom: 1, x: 500, y: -500 }, W, H);
  assert.deepEqual(c, { zoom: 1, x: 0, y: 0 });
  assert.deepEqual(panBounds(1, W, H), { maxX: 0, maxY: 0 });
});

test("pan is limited to the overhang the zoom creates", () => {
  const { maxX, maxY } = panBounds(2, W, H);
  assert.equal(maxX, W / 2);
  assert.equal(maxY, H / 2);
  const c = clampCamera({ zoom: 2, x: maxX + 100, y: -(maxY + 100) }, W, H);
  assert.equal(c.x, maxX);
  assert.equal(c.y, -maxY);
});

test("zoom stays anchored on the point under the cursor", () => {
  // At zoom 1 with no pan, scene point (40, -20) sits 40/−20 from centre.
  const start = { zoom: 1, x: 0, y: 0 };
  const next = zoomAt(start, 2, 40, -20, W, H);
  // The scene point under the cursor must map back to the same screen offset.
  const screenBefore = 40 * start.zoom + start.x;
  const screenAfter = 40 * next.zoom + next.x;
  assert.ok(Math.abs(screenBefore - screenAfter) < 1e-6, `${screenBefore} vs ${screenAfter}`);
});

test("zooming past the limit is a no-op, not a jump", () => {
  const max = { zoom: MAX_ZOOM, x: 10, y: 10 };
  assert.deepEqual(zoomAt(max, 2, 30, 30, W, H), clampCamera(max, W, H));
});

test("focusing a pod centres it inside the clamp", () => {
  const c = focusOn(200, 180, 2, W, H);
  const screenX = 200 * c.zoom + c.x;
  assert.ok(Math.abs(screenX - (W / 2) * c.zoom) < 1e-6);
});

test("focusing a corner pod cannot push the scene out of frame", () => {
  const c = focusOn(0, 0, 3, W, H);
  const r = visibleRect(c, W, H);
  assert.ok(r.x >= -0.001 && r.y >= -0.001);
  assert.ok(r.x + r.w <= W + 0.001);
  assert.ok(r.y + r.h <= H + 0.001);
});

test("visible rect always covers the whole scene at 1x", () => {
  const r = visibleRect({ zoom: 1, x: 0, y: 0 }, W, H);
  assert.deepEqual([r.x, r.y, r.w, r.h], [0, 0, W, H]);
});
