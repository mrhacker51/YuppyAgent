/**
 * Terminal dock geometry & persistence tests.
 *
 * The dock is resized with the pointer and must survive both a reload
 * (localStorage) and a bridge restart (`layout_save` / `layout_applied`,
 * where it rides as a reserved pseudo-panel). These tests pin the clamp
 * band, the persistence channels and the field mapping documented in
 * `src/lib/dock.ts`.
 */
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  connectBridge,
  hud,
  resetHud,
  useHudStore,
} from "./helpers/dom-env";
import {
  DOCK_DEFAULT_HEIGHT,
  DOCK_MAX_RATIO,
  DOCK_MIN_HEIGHT,
  DOCK_PANEL_ID,
  DOCK_STORAGE_KEY,
  clampDockHeight,
  dockFromFloating,
  dockToFloating,
} from "@/lib/dock";
import type { FloatingPanelDto, LayoutDto } from "@/lib/protocol";

// The headless shim has no innerHeight; the module falls back to 900px.
const VIEWPORT = 900;

beforeEach(() => {
  resetHud();
  localStorage.removeItem(DOCK_STORAGE_KEY);
});

function dockEntry(over: Partial<FloatingPanelDto> = {}): FloatingPanelDto {
  return {
    id: DOCK_PANEL_ID,
    x: 0,
    y: 0,
    z: 0,
    scale: 1,
    width: 1,
    height: 400,
    visible: true,
    pinned: false,
    minimized: false,
    z_order: 0,
    ...over,
  };
}

function layoutWith(floating: FloatingPanelDto[]): LayoutDto {
  return { panels: [], focused: null, active_department: null, floating };
}

test("dock height is clamped to the drawable band for the viewport", () => {
  assert.equal(clampDockHeight(10, VIEWPORT), DOCK_MIN_HEIGHT);
  assert.equal(clampDockHeight(400, VIEWPORT), 400);
  assert.equal(
    clampDockHeight(99_999, VIEWPORT),
    Math.round(VIEWPORT * DOCK_MAX_RATIO),
    "the dock may never swallow the workspace",
  );
  assert.equal(clampDockHeight(Number.NaN, VIEWPORT), DOCK_DEFAULT_HEIGHT);
  assert.equal(dockFromFloating([]), null, "absent entry means 'keep local state'");
  const stored = dockFromFloating([dockEntry({ height: 9_999, pinned: true })]);
  assert.deepEqual(stored, {
    height: Math.round(VIEWPORT * DOCK_MAX_RATIO),
    maximized: true,
    hidden: false,
  });
});

test("pointer resize persists locally right away, even while offline", () => {
  useHudStore.getState().setDockHeight(9_999);
  assert.equal(hud().dockHeight, Math.round(VIEWPORT * DOCK_MAX_RATIO));
  assert.equal(hud().status, "disconnected");
  const stored = JSON.parse(localStorage.getItem(DOCK_STORAGE_KEY) ?? "{}") as {
    height?: number;
  };
  assert.equal(stored.height, hud().dockHeight, "localStorage sees the clamped height");
});

test("hide and maximize are exclusive, independent toggles", () => {
  useHudStore.getState().toggleDockMaximized();
  assert.deepEqual(
    { max: hud().dockMaximized, hidden: hud().dockHidden, height: hud().dockHeight },
    { max: true, hidden: false, height: DOCK_DEFAULT_HEIGHT },
  );

  useHudStore.getState().toggleDockHidden();
  assert.deepEqual(
    { max: hud().dockMaximized, hidden: hud().dockHidden },
    { max: false, hidden: true },
    "hiding a maximized dock restores the normal workspace",
  );

  useHudStore.getState().toggleDockHidden(false);
  assert.equal(hud().dockHidden, false);
  assert.equal(hud().dockMaximized, false, "restoring a dock does not re-maximize it");

  useHudStore.getState().setDockHeight(480);
  const stored = JSON.parse(localStorage.getItem(DOCK_STORAGE_KEY) ?? "{}") as {
    height?: number;
    maximized?: boolean;
    hidden?: boolean;
  };
  assert.deepEqual(stored, { height: 480, maximized: false, hidden: false });
});

test("the dock rides through layout_save without disturbing panel geometry", () => {
  const socket = connectBridge();
  useHudStore.getState().setDockHeight(470);
  useHudStore.getState().savePanels();

  const frame = socket.lastRequest();
  assert.equal(frame?.type, "layout_save");
  const sent = frame?.layout as LayoutDto;
  const entry = sent.floating?.find((p) => p.id === DOCK_PANEL_ID);
  assert.ok(entry, "the dock is part of the saved layout");
  assert.deepEqual(entry, dockToFloating({ height: 470, maximized: false, hidden: false }));
  assert.ok((entry?.width ?? 0) > 0 && (entry?.height ?? 0) > 0, "backend validator needs positive geometry");
});

test("layout_applied restores the dock even when no spatial panel is known", () => {
  const socket = connectBridge();
  socket.deliver({
    type: "layout_applied",
    name: "web-default",
    layout: layoutWith([dockEntry({ height: 512, visible: false })]),
  });
  assert.deepEqual(
    { height: hud().dockHeight, max: hud().dockMaximized, hidden: hud().dockHidden },
    { height: 512, max: false, hidden: true },
    "a hidden dock stays hidden after restart",
  );
  const stored = JSON.parse(localStorage.getItem(DOCK_STORAGE_KEY) ?? "{}") as {
    hidden?: boolean;
  };
  assert.equal(stored.hidden, true, "restored state is also kept locally");

  socket.deliver({
    type: "layout_applied",
    name: "web-default",
    layout: layoutWith([dockEntry({ height: 300, pinned: true })]),
  });
  assert.deepEqual(
    { height: hud().dockHeight, max: hud().dockMaximized, hidden: hud().dockHidden },
    { height: 300, max: true, hidden: false },
  );
});

test("an older bridge without the dock entry leaves local state untouched", () => {
  useHudStore.getState().setDockHeight(455);
  const socket = connectBridge();
  socket.deliver({
    type: "layout_applied",
    name: "web-default",
    layout: layoutWith([{ ...dockEntry(), id: "departments", x: 1 }]),
  });
  assert.equal(hud().dockHeight, 455);
  assert.equal(hud().dockHidden, false);
});
