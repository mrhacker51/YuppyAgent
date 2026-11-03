import type { FloatingPanelDto } from "./protocol";

/**
 * Terminal dock geometry and persistence.
 *
 * The dock is a *docked* panel, but its state still has to survive a reload
 * and a bridge restart. Two channels carry it, mirroring the spatial panels:
 *
 *   1. `localStorage` — written immediately, works offline.
 *   2. `LayoutSave` / `LayoutApplied` — the dock rides in `layout.floating`
 *      under a reserved pseudo-id so the existing bridge persistence works
 *      unchanged. Backend validation only requires a non-empty unique id and
 *      positive geometry, so `width` stays 1 while `height` carries the real
 *      dock height.
 *
 * Mapping into `FloatingPanelDto` (documented once, here):
 *   height  -> dock height in CSS pixels
 *   visible -> !hidden
 *   pinned  -> maximized (a "pinned open" dock takes the workspace)
 *   x/y/z/scale/z_order/minimized -> unused by the dock, kept neutral
 */

/** Reserved id of the dock's pseudo-entry inside `LayoutDto.floating`. */
export const DOCK_PANEL_ID = "terminal-dock";

export const DOCK_MIN_HEIGHT = 220;
export const DOCK_DEFAULT_HEIGHT = 360;
/** The dock may never eat more than this share of the viewport. */
export const DOCK_MAX_RATIO = 0.72;
export const DOCK_STORAGE_KEY = "yuppy.dock.v1";

export interface DockState {
  height: number;
  maximized: boolean;
  hidden: boolean;
}

export const DEFAULT_DOCK: DockState = {
  height: DOCK_DEFAULT_HEIGHT,
  maximized: false,
  hidden: false,
};

/** Viewport height for clamping; a sane fallback keeps SSR/tests finite. */
function viewportHeight(): number {
  if (
    typeof window !== "undefined" &&
    typeof window.innerHeight === "number" &&
    Number.isFinite(window.innerHeight) &&
    window.innerHeight > 0
  ) {
    return window.innerHeight;
  }
  return 900;
}

/** Clamp a requested dock height into the drawable band for `vh`. */
export function clampDockHeight(height: number, vh = viewportHeight()): number {
  const max = Math.max(DOCK_MIN_HEIGHT, Math.round(vh * DOCK_MAX_RATIO));
  const min = Math.min(DOCK_MIN_HEIGHT, max);
  const value = Number.isFinite(height) ? height : DOCK_DEFAULT_HEIGHT;
  return Math.round(Math.min(max, Math.max(min, value)));
}

/** Normalize untrusted persisted state (localStorage or the bridge). */
export function normalizeDockState(value: unknown, vh = viewportHeight()): DockState {
  const v = (value && typeof value === "object" ? value : {}) as Partial<DockState>;
  return {
    height: clampDockHeight(
      typeof v.height === "number" ? v.height : DOCK_DEFAULT_HEIGHT,
      vh,
    ),
    maximized: v.maximized === true,
    hidden: v.hidden === true,
  };
}

export function loadDockState(): DockState {
  if (typeof window === "undefined") return { ...DEFAULT_DOCK };
  try {
    const raw = localStorage.getItem(DOCK_STORAGE_KEY);
    return raw ? normalizeDockState(JSON.parse(raw)) : { ...DEFAULT_DOCK };
  } catch {
    return { ...DEFAULT_DOCK };
  }
}

export function persistDockState(state: DockState): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(DOCK_STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Storage can be unavailable (private mode/quota); the bridge save still works.
  }
}

/** Encode the dock for `LayoutSave` (see the mapping in the module docs). */
export function dockToFloating(state: DockState): FloatingPanelDto {
  return {
    id: DOCK_PANEL_ID,
    x: 0,
    y: 0,
    z: 0,
    scale: 1,
    // The backend validator requires positive width/height; a dock is
    // width-agnostic, so width is the neutral minimum.
    width: 1,
    height: clampDockHeight(state.height),
    visible: !state.hidden,
    pinned: state.maximized,
    minimized: false,
    z_order: 0,
  };
}

/**
 * Decode the dock from a `layout_applied` burst. Returns `null` when the
 * bridge has no dock entry (older backend) so callers keep local state.
 */
export function dockFromFloating(
  floating: FloatingPanelDto[] | undefined,
  vh = viewportHeight(),
): DockState | null {
  const entry = floating?.find((panel) => panel.id === DOCK_PANEL_ID);
  if (!entry) return null;
  return normalizeDockState(
    {
      height: entry.height,
      // A hidden dock must not also claim to be maximized.
      maximized: entry.pinned && entry.visible,
      hidden: !entry.visible,
    },
    vh,
  );
}
