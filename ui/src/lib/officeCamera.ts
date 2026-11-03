/**
 * Isometric office camera.
 *
 * The scene is a fixed 430×330 canvas blitted into a panel of any size, so
 * zoom and pan live in *scene* pixels, not CSS pixels. Two invariants matter:
 *
 *   1. The scene can never be panned away from the viewport — at 1× there is
 *      nothing to pan at all, and at any zoom the visible rectangle stays
 *      inside the scene.
 *   2. Zooming at the cursor keeps the point under the cursor still, which is
 *      what makes wheel zoom feel anchored instead of drifting.
 *
 * Everything here is pure so the clamps can be tested without a canvas.
 */

export interface Camera {
  zoom: number;
  /** Pan offset in scene pixels, relative to the centred scene. */
  x: number;
  y: number;
}

export const MIN_ZOOM = 1;
export const MAX_ZOOM = 3.2;

export function clampZoom(zoom: number): number {
  if (!Number.isFinite(zoom)) return MIN_ZOOM;
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
}

/** Largest pan that still fills the viewport at this zoom. */
export function panBounds(zoom: number, width: number, height: number) {
  const z = clampZoom(zoom);
  return {
    maxX: ((z - 1) * width) / 2,
    maxY: ((z - 1) * height) / 2,
  };
}

export function clampCamera(camera: Camera, width: number, height: number): Camera {
  const zoom = clampZoom(camera.zoom);
  const { maxX, maxY } = panBounds(zoom, width, height);
  const x = Number.isFinite(camera.x) ? camera.x : 0;
  const y = Number.isFinite(camera.y) ? camera.y : 0;
  // `+ 0` normalises -0, which would otherwise make deepEqual (and any
  // serialized camera state) compare unequal to a clean 0.
  return {
    zoom,
    x: Math.min(maxX, Math.max(-maxX, x)) + 0,
    y: Math.min(maxY, Math.max(-maxY, y)) + 0,
  };
}

/**
 * Multiply the zoom while keeping the scene point under (ox, oy) fixed.
 * `ox`/`oy` are scene-space offsets from the scene centre.
 */
export function zoomAt(
  camera: Camera,
  factor: number,
  ox = 0,
  oy = 0,
  width = 0,
  height = 0,
): Camera {
  const from = clampCamera(camera, width, height);
  const to = clampCamera({ ...from, zoom: from.zoom * factor }, width, height);
  if (to.zoom === from.zoom) return from;
  const k = to.zoom / from.zoom;
  return clampCamera(
    { zoom: to.zoom, x: ox - (ox - from.x) * k, y: oy - (oy - from.y) * k },
    width,
    height,
  );
}

/**
 * Camera that centres a scene point in the viewport at a given zoom, clamped
 * so a pod near the room's edge cannot push the scene out of frame.
 */
export function focusOn(
  sx: number,
  sy: number,
  zoom: number,
  width: number,
  height: number,
): Camera {
  const z = clampZoom(zoom);
  return clampCamera(
    { zoom: z, x: -(sx - width / 2) * z, y: -(sy - height / 2) * z },
    width,
    height,
  );
}

/** The visible scene rectangle for a camera (used to sample weather panes). */
export function visibleRect(camera: Camera, width: number, height: number) {
  const c = clampCamera(camera, width, height);
  const w = width / c.zoom;
  const h = height / c.zoom;
  return { x: width / 2 - c.x / c.zoom - w / 2, y: height / 2 - c.y / c.zoom - h / 2, w, h };
}
