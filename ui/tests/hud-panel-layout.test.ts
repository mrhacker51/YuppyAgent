/**
 * Free-floating panel layout tests.
 *
 * These panels are positioned in 3D space and their geometry round-trips
 * through the bridge (`layout_save` out, `layout_applied` in) and through
 * localStorage. Two things are therefore worth locking down: the values stay
 * inside the range the renderer can actually draw, and a save never drops the
 * backend-owned panels it merely borrows.
 */
import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  connectBridge,
  FakeWebSocket,
  hud,
  logsMatching,
  resetHud,
  useHudStore,
} from "./helpers/dom-env";
import { DEFAULT_PANELS, PANEL_IDS } from "@/lib/store";
import type { FloatingPanelDto, LayoutDto } from "@/lib/protocol";

const STORAGE_KEY = "yuppy.panels.v1";

beforeEach(() => {
  resetHud();
  localStorage.removeItem(STORAGE_KEY);
});

function floating(id: string, over: Partial<FloatingPanelDto> = {}): FloatingPanelDto {
  return {
    id,
    x: 0,
    y: 0,
    z: 1,
    scale: 1,
    width: 300,
    height: 300,
    visible: true,
    pinned: false,
    minimized: false,
    z_order: 1,
    ...over,
  };
}

function layout(over: Partial<LayoutDto> = {}): LayoutDto {
  return { panels: [], focused: null, active_department: null, floating: [], ...over };
}

test("every HUD panel starts from a designed default", () => {
  assert.deepEqual(PANEL_IDS, ["departments", "agents", "agentDetail", "activity"]);
  for (const id of PANEL_IDS) {
    assert.deepEqual(hud().panelLayout[id], DEFAULT_PANELS[id], `${id} starts at its default`);
    const box = DEFAULT_PANELS[id];
    assert.ok(box.scale >= 0.5 && box.scale <= 1.6, `${id} default scale is drawable`);
    assert.ok(box.width >= 250 && box.width <= 560, `${id} default width is drawable`);
    assert.ok(box.height >= 160 && box.height <= 640, `${id} default height is drawable`);
    assert.equal(box.visible, true, `${id} must not start hidden`);
  }
  assert.equal(hud().selectedPanel, "departments");
});

test("drag/scale input is clamped so a panel can never leave the scene", () => {
  useHudStore.getState().setPanelTransform("agents", {
    scale: 99,
    width: 12,
    height: 99_999,
    zOrder: -4.6,
  });
  assert.deepEqual(hud().panelLayout.agents, {
    ...DEFAULT_PANELS.agents,
    scale: 1.6,
    width: 250,
    height: 640,
    zOrder: 0,
  });

  useHudStore.getState().setPanelTransform("agents", { scale: 0.01, width: 99_999, height: 1 });
  assert.equal(hud().panelLayout.agents.scale, 0.5);
  assert.equal(hud().panelLayout.agents.width, 560);
  assert.equal(hud().panelLayout.agents.height, 160);
  assert.deepEqual(
    hud().panelLayout.departments,
    DEFAULT_PANELS.departments,
    "one panel must not move another",
  );
});

test("non-finite coordinates fall back instead of poisoning the 3D transform", () => {
  useHudStore.getState().setPanelTransform("activity", {
    x: Number.NaN,
    y: Number.POSITIVE_INFINITY,
    z: Number.NaN,
    scale: Number.NaN,
  });
  const { x, y, z, scale } = hud().panelLayout.activity;
  assert.deepEqual([x, y, z, scale], [
    DEFAULT_PANELS.activity.x,
    DEFAULT_PANELS.activity.y,
    DEFAULT_PANELS.activity.z,
    DEFAULT_PANELS.activity.scale,
  ]);
});

test("a moved panel is persisted locally right away, even while offline", () => {
  useHudStore.getState().setPanelTransform("departments", { x: -3.5, y: 1.25 });
  const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}") as Record<
    string,
    { x: number; y: number }
  >;
  assert.equal(stored.departments?.x, -3.5);
  assert.equal(stored.departments?.y, 1.25);
  assert.equal(hud().status, "disconnected");
});

test("visibility, pin and minimize toggles are independent per panel", () => {
  useHudStore.getState().togglePanelVisible("agents");
  assert.equal(hud().panelLayout.agents.visible, false);
  assert.equal(hud().panelLayout.agents.minimized, false);
  useHudStore.getState().togglePanelVisible("agents");
  assert.equal(hud().panelLayout.agents.visible, true);

  useHudStore.getState().togglePanelPinned("agents");
  assert.equal(hud().panelLayout.agents.pinned, true);
  useHudStore.getState().togglePanelMinimized("agents");
  assert.deepEqual(
    { visible: hud().panelLayout.agents.visible, pinned: hud().panelLayout.agents.pinned, minimized: hud().panelLayout.agents.minimized },
    { visible: true, pinned: true, minimized: true },
  );
  assert.equal(hud().panelLayout.activity.visible, true, "the other panels are untouched");
});

test("bring-to-front stacks above the current top panel only", () => {
  const top = Math.max(...PANEL_IDS.map((id) => DEFAULT_PANELS[id].zOrder));
  useHudStore.getState().bringPanelForward("activity");
  assert.equal(hud().panelLayout.activity.zOrder, top + 1);
  useHudStore.getState().bringPanelForward("agents");
  assert.equal(hud().panelLayout.agents.zOrder, top + 2);
  assert.equal(hud().panelLayout.activity.zOrder, top + 1, "the rest of the stack is untouched");
});

test("reset restores the designed layout, clears local storage and says so", () => {
  useHudStore.getState().setPanelTransform("agents", { x: 9, visible: false });
  useHudStore.getState().selectPanel(null);
  localStorage.setItem(STORAGE_KEY, "{}");

  useHudStore.getState().resetPanels();
  for (const id of PANEL_IDS) {
    assert.deepEqual(hud().panelLayout[id], DEFAULT_PANELS[id], `${id} is back to its default`);
  }
  assert.equal(hud().selectedPanel, "departments");
  assert.equal(localStorage.getItem(STORAGE_KEY), null);
  assert.deepEqual(logsMatching("HUD layout reset"), ["HUD layout reset to defaults."]);
});

test("saving while offline is reported as local-only instead of pretending to sync", () => {
  useHudStore.getState().savePanels();
  assert.deepEqual(logsMatching("HUD layout saved").at(-1),
    "HUD layout saved locally; bridge is offline, so no backend save was sent.");
  assert.equal(FakeWebSocket.instances.length, 0, "nothing may be written while disconnected");
});

test("layout_save carries the HUD geometry and preserves the backend's panels", () => {
  const socket = connectBridge();
  socket.deliver(
    layout_applied({
      panels: [{ id: "terminal-main", kind: "terminal", title: "Dev", zone: "center", order: 0 }],
      focused: "terminal-main",
      active_department: "software-development",
      floating: [],
    }),
  );
  useHudStore.getState().setPanelTransform("departments", { x: -2, y: 1, z: 2, scale: 1.2, width: 400, height: 420, zOrder: 7, pinned: true });

  useHudStore.getState().savePanels();
  const frame = socket.lastRequest();
  assert.equal(frame?.type, "layout_save");
  assert.equal(frame?.name, "web-default");
  const sent = frame?.layout as LayoutDto;
  assert.deepEqual(
    sent.panels.map((p) => p.id),
    ["terminal-main"],
    "the bridge owns docked panels; the HUD must echo them back untouched",
  );
  assert.equal(sent.focused, "terminal-main");
  assert.equal(sent.active_department, "software-development");
  assert.equal(
    sent.floating?.length,
    PANEL_IDS.length + 1,
    "all four floating panels plus the terminal dock are saved",
  );
  assert.ok(
    sent.floating?.some((p) => p.id === "terminal-dock"),
    "the dock rides in the same layout payload",
  );
  assert.deepEqual(sent.floating?.find((p) => p.id === "departments"), {
    id: "departments",
    x: -2,
    y: 1,
    z: 2,
    scale: 1.2,
    width: 400,
    height: 420,
    visible: true,
    pinned: true,
    minimized: false,
    z_order: 7,
  });
  assert.deepEqual(logsMatching("HUD layout saved").at(-1), "HUD layout saved locally and to the bridge.");
});

function layout_applied(payload: LayoutDto) {
  return { type: "layout_applied" as const, name: "web-default", layout: payload };
}

test("layout_applied restores geometry, clamps it, and only applies known panels", () => {
  const socket = connectBridge();
  socket.deliver(
    layout_applied(
      layout({
        active_department: "research",
        floating: [
          floating("agents", { x: -4.5, y: 2, z_order: 9, scale: 99, width: 10 }),
          floating("ghost-panel", { x: 42 }),
        ],
      }),
    ),
  );
  assert.deepEqual(hud().panelLayout.agents, {
    ...DEFAULT_PANELS.agents,
    x: -4.5,
    y: 2,
    z: 1,
    scale: 1.6,
    width: 250,
    zOrder: 9,
  });
  assert.equal(hud().selectedDept, "research", "the restored active department is adopted");
  assert.deepEqual(logsMatching("Layout restored from bridge"), [
    "Layout restored from bridge (1 floating panels).",
  ]);

  // The restore banner is a one-shot; later restores apply silently.
  socket.deliver(layout_applied(layout({ floating: [floating("agents", { x: 1 })] })));
  assert.equal(hud().panelLayout.agents.x, 1);
  assert.equal(logsMatching("Layout restored from bridge").length, 1);

  // An empty payload still tracks the active department, and a null one keeps
  // the local selection instead of clearing it.
  socket.deliver(layout_applied(layout({ active_department: "finance", floating: [] })));
  assert.equal(hud().selectedDept, "finance");
  socket.deliver(layout_applied(layout({ active_department: null })));
  assert.equal(hud().selectedDept, "finance");
  assert.equal(localStorage.getItem(STORAGE_KEY) !== null, true, "restores are cached offline-ready");
});

test("panel selection and edit mode drive the HUD chrome without touching geometry", () => {
  const before = hud().panelLayout;
  useHudStore.getState().selectPanel("activity");
  useHudStore.getState().setEditMode(true);
  useHudStore.getState().setMinimalHud(true);
  useHudStore.getState().setDraggingPanel(true);
  assert.deepEqual(
    {
      selectedPanel: hud().selectedPanel,
      editMode: hud().editMode,
      minimalHud: hud().minimalHud,
      draggingPanel: hud().draggingPanel,
    },
    { selectedPanel: "activity", editMode: true, minimalHud: true, draggingPanel: true },
  );
  assert.deepEqual(hud().panelLayout, before);
});
