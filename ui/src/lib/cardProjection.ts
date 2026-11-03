/**
 * Projection bus between the 3D carousel (inside the R3F Canvas) and the
 * DOM card layer (outside it). Each frame the 3D card writes its projected
 * screen position/scale here; the DOM layer reads it in its own rAF loop and
 * moves always-mounted divs imperatively. This replaces Drei's `Html`
 * portals, which intermittently dropped one card's portal per mount.
 */
export interface CardProjection {
  /** Screen x in CSS pixels, relative to the canvas box. */
  x: number;
  /** Screen y in CSS pixels, relative to the canvas box. */
  y: number;
  /** Uniform scale that matches the 3D slab's projected width. */
  scale: number;
  /** Yaw in radians (three.js convention; same sign as CSS rotateY here). */
  rotY: number;
  /** Depth/selection opacity, 0..1. */
  opacity: number;
  /** False when the card is outside the visible arc band. */
  visible: boolean;
  /** Camera distance, used for stacking order. */
  dist: number;
}

/** Base CSS width of a card in the DOM layer, before projection scale. */
export const LABEL_WIDTH = 320;

const projections = new Map<string, CardProjection>();

export function writeCardProjection(id: string, p: CardProjection): void {
  const cur = projections.get(id);
  if (cur) Object.assign(cur, p);
  else projections.set(id, { ...p });
}

export function readCardProjection(id: string): CardProjection | undefined {
  return projections.get(id);
}

export function clearCardProjection(id: string): void {
  projections.delete(id);
}
