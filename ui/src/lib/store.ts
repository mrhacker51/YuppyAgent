"use client";

import { create } from "zustand";
import { AGENT_CLI, agentShortName, supportedAgents } from "./agents";
import {
  LEAD_LABEL as TEAM_LEAD_LABEL,
  TASK_OUTPUT_TASKS_CAP,
  leadLabelFor,
  pickTeam,
  pushLines,
} from "./teamRoster";
import { autoSeats, planSeatOpens, planSeats } from "./autoTerminals";
import { VERIFY_COMMAND } from "./skills";
import { cellsToText, seatShowsDialog } from "./term";
import { pickSpeechLine } from "./speech";
import {
  PROTOCOL_VERSION,
  type ClientRequest,
  type DepartmentDto,
  type Envelope,
  type FloatingPanelDto,
  type LayoutDto,
  type ServerPayload,
  type AgentStatusDto,
  type EngineInfoDto,
  type TaskSpecDto,
  type TaskStateDto,
} from "./protocol";
import {
  DEFAULT_DOCK,
  DOCK_STORAGE_KEY,
  clampDockHeight,
  dockFromFloating,
  dockToFloating,
  loadDockState,
  persistDockState,
  type DockState,
} from "./dock";


export type BridgeStatus =
  | "disconnected"
  | "connecting"
  | "authenticating"
  | "connected"
  | "auth_failed"
  | "protocol_mismatch";

export interface Session {
  id: string;
  agent: string;
  label: string;
  /** Wall-clock time the PTY was opened (local, for the duration badge). */
  openedAt?: number;
  /** Department the terminal was launched for, when one was targeted. */
  department?: string;
  rows?: number;
  cols?: number;
  generation?: number;
  lastScreen?: ServerPayload;
  /** The team lead's Claude Code PTY (main command window), never a seat. */
  lead?: boolean;
  /** Lead sessions: the team they lead ("" = no teams on this bridge). */
  team?: string;
  /** Worker sessions opened for one role card: that role's id. */
  role?: string;
}

export interface TerminalExit {
  sessionId: string;
  agent?: string;
  label?: string;
  exitCode?: number | null;
  signal?: string | null;
  ts: number;
}

export interface Task {
  id: string;
  title?: string;
  state: TaskStateDto;
  detail?: string | null;
  /** Executor that owns the task (from the submitted spec). */
  cli?: string;
  /** Department the task was scoped to. */
  department?: string | null;
  /** Role id inside that department (TaskSpecDto.role) — picks the card. */
  role?: string | null;
  /** Who filed it: this window's `task_submit`, or anyone else on the
   * bridge — in practice the lead Claude via `yuppy_dispatch`. */
  origin?: "operator" | "lead";
  /** Final run facts from the bridge's `task_report`. */
  report?: { success: boolean; exitCode?: number | null; durationMs: number; outputTail: string };
}

/** One verbatim line a live seat printed — the "team chat" surface. Never
 * generated: the line is the real terminal text, paced per seat. */
export interface AgentSpeech {
  id: string;
  agent: string;
  label: string;
  line: string;
  ts: number;
}

/**
 * One message a real agent sent over its batch's team bus (`yuppy_send`).
 * Emitted by the bridge from the same SQLite mailbox the agents wrote to, so
 * this is the only inter-agent conversation the UI is allowed to show.
 */
export interface TeamMessage {
  /** `${batch}:${busId}` — stable across reconnects and re-renders. */
  id: string;
  batch: string;
  busId: number;
  sender: string;
  recipient: string;
  body: string;
  ts: number;
}

/** Worktree review payload emitted when an isolated task finishes. */
export interface TaskIntegration {
  taskId: string;
  branch: string;
  changedFiles: string[];
  committed: boolean;
  ts: number;
}

/** Two isolated tasks changed the same path — manual merge required. */
export interface TaskConflict {
  taskA: string;
  taskB: string;
  path: string;
  ts: number;
}

export interface LogEntry {
  id: string;
  /** "prompt" marks an operator-dispatched message. */
  level: "info" | "warn" | "error" | "prompt";
  message: string;
  ts: number;
}

/** The bottom visible content line of a real PTY screen snapshot ("" if none). */
export function lastScreenText(lastScreen: ServerPayload | undefined): string {
  if (!lastScreen || lastScreen.type !== "terminal_screen") return "";
  const text = cellsToText(lastScreen.cells, lastScreen.rows, lastScreen.cols);
  // Chrome-aware: a CLI redraws its TUI constantly, so the last non-empty row
  // is usually a spinner or a key hint, not something the agent said.
  const picked = pickSpeechLine(text.split("\n"));
  if (!picked) return "";
  const line = picked.text;
  return line.length > 160 ? `${line.slice(0, 157)}…` : line;
}

export type PanelId = "departments" | "agents" | "agentDetail" | "activity";

export interface PanelTransform {
  x: number;
  y: number;
  z: number;
  scale: number;
  visible: boolean;
  pinned: boolean;
  minimized: boolean;
  width: number;
  height: number;
  zOrder: number;
}

export type HandStatus = "idle" | "requesting" | "loading" | "ready" | "error";
export type HandGesture = "none" | "open_palm" | "pinch" | "point";

export const PANEL_IDS: PanelId[] = ["departments", "agents", "agentDetail", "activity"];

export const DEFAULT_PANELS: Record<PanelId, PanelTransform> = {
  departments: {
    x: -2.15,
    y: 0.95,
    z: 1.5,
    scale: 1,
    visible: true,
    pinned: false,
    minimized: false,
    width: 310,
    height: 330,
    zOrder: 1,
  },
  agents: {
    x: -1.95,
    y: -0.75,
    z: 1.9,
    scale: 1,
    visible: true,
    pinned: false,
    minimized: false,
    width: 320,
    height: 300,
    zOrder: 2,
  },
  agentDetail: {
    x: 2.1,
    y: 0.95,
    z: 1.5,
    scale: 1,
    visible: true,
    pinned: false,
    minimized: false,
    width: 310,
    height: 300,
    zOrder: 1,
  },
  activity: {
    x: 1.9,
    y: -0.75,
    z: 1.9,
    scale: 1,
    visible: true,
    pinned: false,
    minimized: false,
    width: 330,
    height: 300,
    zOrder: 2,
  },
};

const PANEL_STORAGE_KEY = "yuppy.panels.v1";
const URL_STORAGE_KEY = "yuppy.bridge.url";
const TOKEN_STORAGE_KEY = "yuppy.bridge.token";
const MATRIX_STORAGE_KEY = "yuppy.matrix.columns.v1";
const AUTO_TERMINALS_STORAGE_KEY = "yuppy.terminals.auto.v1";
const DEFAULT_BRIDGE_URL = "ws://127.0.0.1:9090";

/**
 * Matrix density. `auto` divides the grid by the number of seats so every
 * detected agent gets its own box; fixed values are an explicit override.
 * Invalid/stale stored values fall back to `auto`.
 */
export type MatrixColumns = "auto" | 2 | 3 | 4 | 5 | 6;

function loadMatrixColumns(): MatrixColumns {
  if (typeof window === "undefined") return "auto";
  const raw = localStorage.getItem(MATRIX_STORAGE_KEY);
  if (raw === "auto") return "auto";
  const value = Number(raw);
  return value === 2 || value === 3 || value === 4 || value === 5 || value === 6 ? value : "auto";
}

/**
 * Which PTYs open by themselves once the bridge is ready. Real
 * `open_terminal` requests only — nothing is simulated, and a failed spawn is
 * never faked. Every interactive Claude Code is a heavy process, so the
 * default is the smallest useful set.
 *
 * - `lead` (default): only the SELECTED team's lead PTY. Workers run
 *   headless (`claude -p`) and stream their lines to the cards; a worker PTY
 *   opens only when the operator asks for it.
 * - `all`: the lead plus one interactive PTY per worker role — explicit
 *   opt-in, warned in the settings (it is what made startup crawl).
 * - `off`: nothing opens, not even the lead; the operator starts it.
 */
export type SeatStartup = "lead" | "all" | "off";

function loadSeatStartup(): SeatStartup {
  if (typeof window === "undefined") return "lead";
  try {
    const raw = localStorage.getItem(AUTO_TERMINALS_STORAGE_KEY);
    // Legacy boolean "0" meant "nothing"; the old "primary" (one per CLI)
    // and "1" (every seat) both become the lead-only default.
    if (raw === "0" || raw === "off") return "off";
    if (raw === "all") return "all";
    return "lead";
  } catch {
    return "lead";
  }
}

const TEAM_STORAGE_KEY = "yuppy.team.selected.v1";

function loadStoredTeam(): string {
  if (typeof window === "undefined") return "";
  try {
    return localStorage.getItem(TEAM_STORAGE_KEY) ?? "";
  } catch {
    return "";
  }
}

function persistTeam(id: string) {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(TEAM_STORAGE_KEY, id);
  } catch {
    // Presentation only; private mode or quota is not fatal.
  }
}

const SEAT_SIZE_STORAGE_KEY = "yuppy.seat.size.v1";

/** A CLI seat size. "auto" follows the pane; anything else is a fixed PTY size
 * the operator picked — sent as terminal_resize so the CLI reflows to it. */
export type SeatSize = "auto" | { cols: number; rows: number };

export const SEAT_SIZE_CHOICES: { label: string; value: SeatSize }[] = [
  { label: "oto (pane)", value: "auto" },
  { label: "S · 90×26", value: { cols: 90, rows: 26 } },
  { label: "M · 120×36", value: { cols: 120, rows: 36 } },
  { label: "L · 150×46", value: { cols: 150, rows: 46 } },
  { label: "XL · 190×58", value: { cols: 190, rows: 58 } },
];

function loadSeatSize(): SeatSize {
  if (typeof window === "undefined") return "auto";
  try {
    const raw = localStorage.getItem(SEAT_SIZE_STORAGE_KEY);
    if (!raw || raw === "auto") return "auto";
    const m = /^(\d{2,4})x(\d{1,3})$/.exec(raw);
    if (!m) return "auto";
    const cols = Math.min(400, Math.max(20, Number(m[1])));
    const rows = Math.min(200, Math.max(6, Number(m[2])));
    return { cols, rows };
  } catch {
    return "auto";
  }
}

/**
 * Desktop shell pairing (Tauri only): the shell owns the `yuppy bridge`
 * sidecar and hands the one-shot token to its own webview. Held in memory
 * only — never localStorage, never a URL, never logged. The browser flow
 * (paste the token from `yuppy bridge` stderr) is untouched.
 */
let desktopBridge: { url: string; token: string } | null = null;

function cloneDefaults(): Record<PanelId, PanelTransform> {
  return PANEL_IDS.reduce(
    (out, id) => {
      out[id] = { ...DEFAULT_PANELS[id] };
      return out;
    },
    {} as Record<PanelId, PanelTransform>,
  );
}

function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function normalizePanel(id: PanelId, value: unknown): PanelTransform {
  const fallback = DEFAULT_PANELS[id];
  if (!value || typeof value !== "object") return { ...fallback };
  const v = value as Partial<PanelTransform>;
  return {
    x: finiteNumber(v.x, fallback.x),
    y: finiteNumber(v.y, fallback.y),
    z: finiteNumber(v.z, fallback.z),
    scale: Math.min(1.6, Math.max(0.5, finiteNumber(v.scale, fallback.scale))),
    visible: typeof v.visible === "boolean" ? v.visible : fallback.visible,
    pinned: typeof v.pinned === "boolean" ? v.pinned : fallback.pinned,
    minimized: typeof v.minimized === "boolean" ? v.minimized : fallback.minimized,
    width: Math.min(560, Math.max(250, finiteNumber(v.width, fallback.width))),
    height: Math.min(640, Math.max(160, finiteNumber(v.height, fallback.height))),
    zOrder: Math.max(0, Math.round(finiteNumber(v.zOrder, fallback.zOrder))),
  };
}

function loadPanelLayout(): Record<PanelId, PanelTransform> {
  if (typeof window === "undefined") return cloneDefaults();
  try {
    const raw = localStorage.getItem(PANEL_STORAGE_KEY);
    if (!raw) return cloneDefaults();
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return PANEL_IDS.reduce(
      (out, id) => {
        out[id] = normalizePanel(id, parsed[id]);
        return out;
      },
      {} as Record<PanelId, PanelTransform>,
    );
  } catch {
    return cloneDefaults();
  }
}

function layoutFromBackendFloating(
  floating: FloatingPanelDto[] | undefined,
  current: Record<PanelId, PanelTransform>,
): { layout: Record<PanelId, PanelTransform>; applied: number } {
  if (!floating || floating.length === 0) return { layout: current, applied: 0 };
  const next = { ...current };
  let applied = 0;
  for (const panel of floating) {
    if (!PANEL_IDS.includes(panel.id as PanelId)) continue;
    const id = panel.id as PanelId;
    next[id] = normalizePanel(id, {
      ...current[id],
      x: panel.x,
      y: panel.y,
      z: panel.z,
      scale: panel.scale,
      width: panel.width,
      height: panel.height,
      visible: panel.visible,
      pinned: panel.pinned,
      minimized: panel.minimized,
      zOrder: panel.z_order,
    });
    applied += 1;
  }
  return { layout: next, applied };
}

interface HudState {
  status: BridgeStatus;
  bridgeError?: string;
  offline: boolean;
  bridgeUrl: string;
  departments: DepartmentDto[];
  agents: AgentStatusDto[];
  /** Workspace/engine facts from the handshake burst (top bar). */
  engineInfo: EngineInfoDto | null;
  sessions: Session[];
  activeSessionId?: string;
  lastExit?: TerminalExit;
  dockOpen: boolean;
  /** Dock height in CSS px (clamped); see `lib/dock.ts`. */
  dockHeight: number;
  dockMaximized: boolean;
  dockHidden: boolean;
  /** Terminal matrix column count (`auto` divides by seat count), persisted locally. */
  matrixColumns: MatrixColumns;
  /** Fixed CLI seat size ("auto" = fit to pane). Persisted locally. */
  seatSizePreset: SeatSize;
  setSeatSizePreset: (size: SeatSize) => void;
  /** Which seats open by themselves when the inventory arrives. */
  seatStartup: SeatStartup;
  setSeatStartup: (mode: SeatStartup) => void;
  /** Ask a live seat to list the skills it sees; the operator reads the
   * agent's own output in the terminal. Never parsed, never faked. */
  verifySkills: () => void;
  /** Verbatim PTY lines per seat, newest last (team chat + "ne diyor"). */
  speech: AgentSpeech[];
  /** Real `yuppy_send` traffic between the agents of a batch. */
  teamMessages: TeamMessage[];
  tasks: Record<string, Task>;
  /** Streamed `task_output` lines per task id (ring buffer, newest last). */
  taskOutput: Record<string, string[]>;
  /** The team (department id) the deck shows; "" when the bridge has none.
   * Persisted locally. */
  selectedTeam: string;
  /** Switch team: persists the choice and opens that team's lead PTY on its
   * first visit (or after the lead was evicted to save memory). */
  setSelectedTeam: (id: string) => void;
  /** Live lead PTY per team: team id → session id. */
  leadSessions: Record<string, string>;
  /** Teams whose open_terminal{lead} is in flight. */
  leadPendingTeams: Record<string, true>;
  /** How each team's last lead PTY ended — drives the restart action. */
  leadExits: Record<string, TerminalExit>;
  /** The SELECTED team's lead session (derived from `leadSessions`). */
  leadSessionId?: string;
  /** The selected team's lead request is in flight; the UI shows "açılıyor". */
  leadPending: boolean;
  /** How the selected team's last lead PTY ended. */
  leadExit?: TerminalExit;
  /** Open a team's lead PTY (default: the selected team). Refuses (false)
   * when that lead is live or in flight, the bridge is down or Claude Code
   * is not installed — never a duplicate. Keeps at most `MAX_LEAD_PTYS`
   * leads alive: the least recently used one is closed first. */
  openLeadTerminal: (teamId?: string) => boolean;
  integrations: TaskIntegration[];
  conflicts: TaskConflict[];
  logs: LogEntry[];
  selectedDept: string;
  openedDept: string | null;
  carouselIds: string[];
  carouselPull: number;
  selectedAgent: string;
  panelLayout: Record<PanelId, PanelTransform>;
  selectedPanel: PanelId | null;
  editMode: boolean;
  draggingPanel: boolean;
  minimalHud: boolean;
  handStatus: HandStatus;
  handEnabled: boolean;
  handError?: string;
  handCursor: { x: number; y: number } | null;
  handGesture: HandGesture;
  handPinch: boolean;
  handCount: number;
  handSpread: number;
  handHoverDept: string | null;
  connect: (url?: string, token?: string) => void;
  disconnect: () => void;
  send: (req: ClientRequest) => void;
  openTerminal: (agent: string, label?: string, department?: string, role?: string) => void;
  /**
   * Seat-mode dispatch: type the prompt into the agent's live interactive
   * CLI as real PTY keystrokes (Enter submits, multi-line pastes as one
   * bracketed block). Opens a real PTY first when the seat is closed; the
   * queued prompt is delivered once the fresh CLI has drawn a couple of
   * screens. This never fakes output — every byte is typed for real.
   */
  sendPromptToSeats: (text: string, agents: readonly string[]) => boolean;
  submitTasks: (tasks: TaskSpecDto[]) => boolean;
  focusSession: (id: string) => void;
  closeTerminal: (id: string) => void;
  /** Close + reopen a PTY for the same agent (real process replacement). */
  restartSession: (id: string) => void;
  clearLastExit: () => void;
  clearLogs: () => void;
  setDockOpen: (open: boolean) => void;
  setDockHeight: (height: number) => void;
  toggleDockMaximized: () => void;
  toggleDockHidden: (hidden?: boolean) => void;
  setMatrixColumns: (columns: MatrixColumns) => void;
  /** Open one real PTY per available agent that has none (auto-deploy). */
  autoDeployTerminals: () => void;
  /** Apply localStorage-only presentation after hydration (matrix density). */
  hydratePreferences: () => void;
  setSelectedDept: (id: string) => void;
  setSelectedAgent: (id: string) => void;
  setCarouselIds: (ids: string[]) => void;
  rotateCarousel: (delta: number) => void;
  selectDepartmentAt: (index: number) => void;
  openDepartment: (id?: string) => void;
  closeDepartment: () => void;
  setCarouselPull: (amount: number) => void;
  setHandHoverDept: (id: string | null) => void;
  setPanelTransform: (id: PanelId, patch: Partial<PanelTransform>) => void;
  selectPanel: (id: PanelId | null) => void;
  setEditMode: (on: boolean) => void;
  setMinimalHud: (on: boolean) => void;
  togglePanelVisible: (id: PanelId) => void;
  togglePanelPinned: (id: PanelId) => void;
  togglePanelMinimized: (id: PanelId) => void;
  bringPanelForward: (id: PanelId) => void;
  resetPanels: () => void;
  savePanels: () => void;
  setDraggingPanel: (dragging: boolean) => void;
  upsertDepartment: (dept: DepartmentDto) => void;
  removeDepartment: (id: string) => void;
  setHandTracking: (
    patch: Partial<
      Pick<
        HudState,
        | "handStatus"
        | "handEnabled"
        | "handError"
        | "handCursor"
        | "handGesture"
        | "handPinch"
        | "handCount"
        | "handSpread"
        | "handHoverDept"
      >
    >,
  ) => void;
  resetHandTracking: (error?: string) => void;
}

let ws: WebSocket | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let layoutSaveTimer: ReturnType<typeof setTimeout> | null = null;
let connectToken = "";
let suppressReconnect = false;
let reconnectAttempt = 0;
let lastServerLayout: LayoutDto | null = null;
let backendLayoutLoaded = false;
const pendingClose = new Map<string, { agent: string; label: string }>();
// Auto-deploy bookkeeping for the current bridge connection, keyed by seat
// (department + role index): a seat whose PTY was opened, closed or failed is
// not silently re-opened again.
const autoAttempted = new Set<string>();
// Auto-deploy generation: bumped on every fresh connection so paced spawn
// timers from the previous connection never fire against a new socket.
let autoGen = 0;
// Real CLI PTYs are heavy: the full seat roster is never burst-spawned.
// One seat opens per tick; the queue re-plans each tick, so live sessions
// and failed spawns drop out naturally.
let autoSpawnTimer: ReturnType<typeof setTimeout> | null = null;
const SEAT_SPAWN_INTERVAL_MS = 1200;
// The bridge's terminal_opened payload has no department field; queue what
// this window asked for (FIFO per agent) so the UI can label seats honestly.
const pendingTerminalDepartments = new Map<string, Array<{ department: string; role?: string }>>();
// Seat-mode dispatch: the main prompt typed into a real interactive CLI as
// real PTY keystrokes (never the headless task queue). An entry without a
// session id waits for its open_terminal to come back; a freshly spawned CLI
// needs a couple of screen frames before it is ready for input.
interface SeatPromptDelivery {
  agent: string;
  text: string;
  sessionId?: string;
  frames: number;
  /** When this seat's first frame arrived (settle cap). */
  firstFrameAt?: number;
  /** Latest screen text of the seat. */
  screen?: string;
  /** The "dialog in the way" warning was already logged. */
  dialogWarned?: boolean;
  timer?: ReturnType<typeof setTimeout>;
}
const seatPromptQueue: SeatPromptDelivery[] = [];
// Lead PTY bookkeeping for the current connection. Every team has its own
// lead; only the selected team's lead auto-opens, once per team per
// connection (React strict mode, reconnect bursts and repeated inventory
// frames never spawn a second one). At most MAX_LEAD_PTYS leads stay alive:
// opening another closes the least recently used. An in-flight request times
// out so a spawn the bridge never answered still leaves a restart action.
const leadAutoAttempted = new Set<string>();
/** Teams whose lead was closed to save memory — reopened on the next visit. */
const leadEvicted = new Set<string>();
/** Team → last time it was selected or opened (LRU for eviction). */
const leadLastUsed = new Map<string, number>();
/** FIFO of teams waiting for their terminal_opened{lead}. */
const pendingLeadTeams: string[] = [];
const leadPendingTimers = new Map<string, ReturnType<typeof setTimeout>>();
/** The bridge's department roster arrived on this connection. The lead
 * waits for it: the inventory comes first and the team is not known yet. */
let departmentsKnown = false;
let departmentsFallbackTimer: ReturnType<typeof setTimeout> | null = null;
const DEPARTMENTS_FALLBACK_MS = 2500;
const LEAD_PENDING_TIMEOUT_MS = 15_000;
let leadClock = 0;
/** Monotonic "now" for the LRU: two touches in one millisecond still order. */
function leadNow(): number {
  leadClock = Math.max(leadClock + 1, Date.now());
  return leadClock;
}
/** Interactive lead PTYs kept alive at once (each is a full Claude Code). */
export const MAX_LEAD_PTYS = 2;
export const LEAD_AGENT = AGENT_CLI;
export const LEAD_LABEL = TEAM_LEAD_LABEL;
function clearLeadPending(team?: string) {
  if (team === undefined) {
    for (const timer of leadPendingTimers.values()) clearTimeout(timer);
    leadPendingTimers.clear();
    return;
  }
  const timer = leadPendingTimers.get(team);
  if (timer) clearTimeout(timer);
  leadPendingTimers.delete(team);
}
type LeadMaps = Pick<HudState, "selectedTeam" | "leadSessions" | "leadPendingTeams" | "leadExits">;
/** The selected team's lead, flattened for the components that only care
 * about "the" command window. Recomputed whenever the maps change. */
function leadView(s: LeadMaps): Pick<HudState, "leadSessionId" | "leadPending" | "leadExit"> {
  const team = s.selectedTeam;
  return {
    leadSessionId: s.leadSessions[team],
    leadPending: Boolean(s.leadPendingTeams[team]),
    leadExit: s.leadExits[team],
  };
}
/** Merge a patch to the lead maps and recompute the derived view. */
function withLeadView(s: HudState, patch: Partial<LeadMaps> & Partial<HudState>): Partial<HudState> {
  const merged: LeadMaps = {
    selectedTeam: patch.selectedTeam ?? s.selectedTeam,
    leadSessions: patch.leadSessions ?? s.leadSessions,
    leadPendingTeams: patch.leadPendingTeams ?? s.leadPendingTeams,
    leadExits: patch.leadExits ?? s.leadExits,
  };
  return { ...patch, ...leadView(merged) };
}
function without<T>(map: Record<string, T>, key: string): Record<string, T> {
  if (!(key in map)) return map;
  const next = { ...map };
  delete next[key];
  return next;
}
/** The team whose lead runs in this session, if any. */
function teamOfLead(s: Pick<HudState, "leadSessions">, sessionId: string): string | undefined {
  for (const [team, id] of Object.entries(s.leadSessions)) if (id === sessionId) return team;
  return undefined;
}
/** Keyboard encoding for a prompt, sent as TWO keystroke bursts. Codex's
 * TUI treats a text+Enter burst as a paste and swallows the Enter, so the
 * Enter follows a beat later — every byte stays a real keystroke. Multi-line
 * text arrives as one bracketed paste (CLIs keep the newlines). */
export function seatInputChunks(text: string): [body: string, enter: string] {
  const body = text.includes("\n") ? `\u001b[200~${text}\u001b[201~` : text;
  return [body, "\r"];
}
/** Delay between the pasted body and the Enter keystroke (ms). */
const SEAT_ENTER_DELAY_MS = 250;
/** Text that means the CLI is asking a question instead of showing its
 * composer — the same markers the bridge conductor refuses to type over.
 * A dialog is a human decision; blind keystrokes would answer it for them
 * (the trust question even defaults to "No, exit"). */
function showsDialog(text: string): boolean {
  return seatShowsDialog(text);
}
/** A fresh seat must stay quiet this long before its prompt is typed: Codex
 * paints a normal composer first and swaps its trust dialog in ~0.3–0.8 s
 * later, so "two frames rendered" alone typed straight into that dialog. */
const SEAT_SETTLE_QUIET_MS = 900;
/** Upper bound on that wait for a CLI that keeps repainting while idle. */
const SEAT_SETTLE_MAX_MS = 4000;
/** Re-check a queued seat prompt; types it only once the box is settled and
 * shows no dialog. A dialog keeps the prompt queued (warned once): the
 * operator answers it in the seat and the prompt follows on its own. */
function scheduleSeatDelivery(
  entry: SeatPromptDelivery,
  get: () => HudState,
  set: (fn: (s: HudState) => Partial<HudState>) => void,
) {
  if (entry.timer) clearTimeout(entry.timer);
  const now = Date.now();
  const first = entry.firstFrameAt ?? now;
  const wait = now - first >= SEAT_SETTLE_MAX_MS ? 0 : SEAT_SETTLE_QUIET_MS;
  entry.timer = setTimeout(() => {
    entry.timer = undefined;
    if (!seatPromptQueue.includes(entry) || !entry.sessionId || entry.frames < 2) return;
    if (showsDialog(entry.screen ?? "")) {
      if (!entry.dialogWarned) {
        entry.dialogWarned = true;
        set((s) => ({
          logs: pushLog(
            s,
            makeLog(
              "warn",
              `${entry.agent} seat is showing a first-run dialog — the prompt was NOT typed yet. Decide in the seat's terminal (click it and answer); dialogs are human decisions. The prompt is typed automatically once the dialog is gone.`,
            ),
          ),
        }));
      }
      return;
    }
    seatPromptQueue.splice(seatPromptQueue.indexOf(entry), 1);
    const sessionId = entry.sessionId;
    const [body, enter] = seatInputChunks(entry.text);
    get().send({ type: "terminal_input", session_id: sessionId, bytes: body });
    setTimeout(() => {
      get().send({ type: "terminal_input", session_id: sessionId, bytes: enter });
    }, SEAT_ENTER_DELAY_MS);
    set((s) => ({
      logs: pushLog(s, makeLog("info", `prompt typed into the ${entry.agent} seat.`)),
    }));
  }, wait);
}
// High-frequency frames (PTY screens, task state) are buffered and applied
// in a single requestAnimationFrame set() to avoid render thrash.
const pendingScreens = new Map<string, Extract<ServerPayload, { type: "terminal_screen" }>>();
const pendingTaskStates = new Map<string, Extract<ServerPayload, { type: "task_state" }>>();
// Streamed worker lines (`task_output`) arrive one frame per line; they are
// batched per task and applied in the same rAF flush, so a chatty worker
// costs one store update per frame, not one per line.
const pendingTaskOutput = new Map<string, string[]>();
let coalesceScheduled = false;
let keepaliveTimer: ReturnType<typeof setInterval> | null = null;
let lastInboundFrame = 0;
let reconnecting = false;
const MAX_LOG_ENTRIES = 500;

function defaultBridgeUrl() {
  if (typeof window === "undefined") return DEFAULT_BRIDGE_URL;
  if (desktopBridge) return desktopBridge.url;
  const param = new URLSearchParams(window.location.search).get("bridge");
  return param || localStorage.getItem(URL_STORAGE_KEY) || DEFAULT_BRIDGE_URL;
}

function defaultBridgeToken() {
  if (typeof window === "undefined") return "";
  // Desktop shell: token comes from the app process (memory only).
  if (desktopBridge) return desktopBridge.token;
  // Tokens are deliberately never read from the URL or public build-time
  // environment variables: both leak into history/bundles. The user pastes
  // the value printed by `yuppy bridge`; it is kept in localStorage.
  return localStorage.getItem(TOKEN_STORAGE_KEY) || "";
}

function makeLog(level: LogEntry["level"], message: string): LogEntry {
  return {
    id: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    level,
    message,
    ts: Date.now(),
  };
}

function pushLog(s: HudState, entry: LogEntry): LogEntry[] {
  return [...s.logs, entry].slice(-MAX_LOG_ENTRIES);
}

function stopKeepalive() {
  if (keepaliveTimer) {
    clearInterval(keepaliveTimer);
    keepaliveTimer = null;
  }
}

function startKeepalive() {
  stopKeepalive();
  lastInboundFrame = Date.now();
  keepaliveTimer = setInterval(() => {
    if (!ws) return;
    if (Date.now() - lastInboundFrame > 50_000) {
      stopKeepalive();
      closeSocket();
      useHudStore.setState({
        status: "disconnected",
        offline: true,
        bridgeError: "Bridge unresponsive — reconnecting…",
      });
      scheduleReconnect();
      return;
    }
    try {
      useHudStore.getState().send({ type: "ping" });
    } catch {
      // Best-effort; the inbound-frame watchdog above reconnects.
    }
  }, 20_000);
}

function closeSocket() {
  if (!ws) return;
  stopKeepalive();
  const socket = ws;
  ws = null;
  socket.onopen = null;
  socket.onmessage = null;
  socket.onerror = null;
  socket.onclose = null;
  try {
    socket.close();
  } catch {
    // already closed
  }
}

function buildLayoutDto(
  panels: Record<PanelId, PanelTransform>,
  selectedDept: string,
  dock: DockState,
): LayoutDto {
  return {
    // Preserve the backend's TUI/docking panels; only replace the
    // free-floating spatial geometry owned by this web renderer.
    panels: lastServerLayout?.panels ?? [],
    focused: lastServerLayout?.focused ?? null,
    active_department: selectedDept || null,
    floating: [
      ...PANEL_IDS.map((id) => {
        const p = panels[id];
        return {
          id,
          x: p.x,
          y: p.y,
          z: p.z,
          scale: p.scale,
          width: p.width,
          height: p.height,
          visible: p.visible,
          pinned: p.pinned,
          minimized: p.minimized,
          z_order: p.zOrder,
        };
      }),
      // The terminal dock persists through the same channel under a
      // reserved id; see `lib/dock.ts` for the field mapping.
      dockToFloating(dock),
    ],
  };
}

function persistPanelsLocally(layout: Record<PanelId, PanelTransform>) {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(PANEL_STORAGE_KEY, JSON.stringify(layout));
  } catch {
    // Storage can be unavailable (private mode/quota); backend save still works.
  }
}

function sendLayoutNow() {
  if (layoutSaveTimer) {
    clearTimeout(layoutSaveTimer);
    layoutSaveTimer = null;
  }
  const state = useHudStore.getState();
  if (state.status !== "connected") return;
  state.send({
    type: "layout_save",
    name: "web-default",
    layout: buildLayoutDto(state.panelLayout, state.selectedDept, {
      height: state.dockHeight,
      maximized: state.dockMaximized,
      hidden: state.dockHidden,
    }),
  });
}

function scheduleLayoutSave() {
  const state = useHudStore.getState();
  persistPanelsLocally(state.panelLayout);
  if (state.status !== "connected") return;
  if (layoutSaveTimer) clearTimeout(layoutSaveTimer);
  layoutSaveTimer = setTimeout(() => {
    layoutSaveTimer = null;
    sendLayoutNow();
  }, 700);
}

/**
 * Write dock state to every persistence channel: localStorage immediately
 * (works offline) and the debounced bridge `layout_save` (works across
 * machines once connected).
 */
function commitDock(next: DockState) {
  persistDockState(next);
  useHudStore.setState({
    dockHeight: next.height,
    dockMaximized: next.maximized,
    dockHidden: next.hidden,
  });
  scheduleLayoutSave();
}

const initialDock = loadDockState();

export const useHudStore = create<HudState>((set, get) => ({
  status: "disconnected",
  offline: true,
  bridgeUrl: DEFAULT_BRIDGE_URL,
  departments: [],
  agents: [],
  engineInfo: null,
  sessions: [],
  dockOpen: false,
  dockHeight: initialDock.height,  dockMaximized: initialDock.maximized,
  dockHidden: initialDock.hidden,
  matrixColumns: 4 as MatrixColumns,
  seatSizePreset: "auto" as SeatSize,
  seatStartup: "lead" as SeatStartup,
  selectedTeam: "",
  leadSessions: {},
  leadPendingTeams: {},
  leadExits: {},
  leadPending: false,
  taskOutput: {},
  speech: [],
  teamMessages: [],
  tasks: {},
  integrations: [],
  conflicts: [],
  // Static first frame: the seed must render identically on the server and
  // during hydration. A wall-clock timestamp here caused the exported HTML
  // and the browser to disagree on the rendered time (React #418).
  logs: [
    {
      id: "boot",
      level: "info",
      message: "Bridge offline — waiting for live backend data.",
      ts: 0,
    },
  ],
  selectedDept: "",
  openedDept: null,
  carouselIds: [],
  carouselPull: 0,
  selectedAgent: "claude-code",
  panelLayout: loadPanelLayout(),
  selectedPanel: "departments",
  editMode: false,
  draggingPanel: false,
  minimalHud: false,
  handStatus: "idle",
  handEnabled: false,
  handCursor: null,
  handGesture: "none",
  handPinch: false,
  handCount: 0,
  handSpread: 0,
  handHoverDept: null,

  connect: (url, token) => {
    if (typeof window === "undefined") return;
    // Fresh (user-initiated) connects start the backoff from scratch; connects
    // triggered by scheduleReconnect keep the accumulated attempt count.
    if (!reconnecting) reconnectAttempt = 0;
    reconnecting = false;
    suppressReconnect = false;
    closeSocket();
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }

    const bridgeUrl = (url || defaultBridgeUrl()).trim();
    connectToken = (token ?? (connectToken || defaultBridgeToken())).trim();
    // In desktop mode the shell's per-launch port must never leak into
    // localStorage (the browser pairing flow owns that key).
    if (url && !desktopBridge) localStorage.setItem(URL_STORAGE_KEY, bridgeUrl);

    if (!connectToken) {
      set({
        status: "auth_failed",
        offline: true,
        bridgeError:
          "Bridge token required. Open “token” and paste the value printed by `yuppy bridge`.",
        bridgeUrl,
      });
      return;
    }

    set({ status: "connecting", offline: true, bridgeError: undefined, bridgeUrl });

    let socket: WebSocket;
    try {
      socket = new WebSocket(bridgeUrl);
    } catch (e) {
      // A syntactically invalid URL will never connect — retrying would just
      // loop forever. Surface it and stop.
      const message = e instanceof Error ? e.message : String(e);
      console.error(`Invalid bridge URL "${bridgeUrl}": ${message}`);
      set({
        status: "disconnected",
        offline: true,
        bridgeError: `Invalid bridge URL: ${message}`,
      });
      return;
    }
    ws = socket;

    socket.onopen = () => {
      if (ws !== socket) return;
      set({ status: "authenticating", offline: true });
      socket.send(JSON.stringify({ version: PROTOCOL_VERSION, token: connectToken }));
    };

    socket.onmessage = (ev) => {
      if (ws !== socket) return;
      lastInboundFrame = Date.now();
      try {
        const env: Envelope = JSON.parse(ev.data);
        handleEnvelope(env, set, get);
      } catch (e) {
        console.error("bridge parse error", e);
      }
    };

    socket.onerror = () => {
      if (ws !== socket) return;
      set({
        bridgeError: `WebSocket error — is \`yuppy bridge\` listening at ${bridgeUrl}?`,
      });
    };

    socket.onclose = (ev) => {
      if (ws !== socket) return;
      ws = null;
      stopKeepalive();
      if (suppressReconnect) {
        set({ offline: true });
        return;
      }
      set({
        status: "disconnected",
        offline: true,
        bridgeError:
          ev.code === 1000 || ev.code === 1005
            ? "Bridge connection closed."
            : `Bridge disconnected (code ${ev.code}). Retrying…`,
      });
      scheduleReconnect();
    };
  },

  disconnect: () => {
    suppressReconnect = true;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = null;
    if (layoutSaveTimer) clearTimeout(layoutSaveTimer);
    layoutSaveTimer = null;
    closeSocket();
    set({ status: "disconnected", offline: true, bridgeError: undefined });
  },

  send: (req) => {
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(req));
    }
  },

  verifySkills: () => {
    const state = get();
    // Deliberately NOT parsed: the seats are interactive CLIs whose answers
    // come from their own tools; the honest signal is what the terminal shows.
    if (!state.sendPromptToSeats(VERIFY_COMMAND, ["claude-code"])) {
      set((s) => ({
        logs: pushLog(
          s,
          makeLog("warn", "Beceri doğrulama komutu koltuğa yazılamadı — bridge bağlı değil."),
        ),
      }));
    }
  },

  openLeadTerminal: (teamId) => {
    const state = get();
    const team = teamId ?? state.selectedTeam;
    if (state.status !== "connected") return false;
    if (state.leadSessions[team] || state.leadPendingTeams[team]) return false;
    if (!state.agents.some((a) => a.id === LEAD_AGENT && a.available)) return false;
    const dept = team ? state.departments.find((d) => d.id === team) : undefined;
    if (team && !dept) return false;
    // Memory cap: every lead is a full interactive Claude Code. Close the
    // least recently used live lead (never one still opening) first.
    const others = Object.keys(state.leadSessions).filter((t) => t !== team);
    const pendingOthers = Object.keys(state.leadPendingTeams).filter((t) => t !== team);
    if (others.length + pendingOthers.length >= MAX_LEAD_PTYS && others.length > 0) {
      const victim = [...others].sort(
        (a, b) => (leadLastUsed.get(a) ?? 0) - (leadLastUsed.get(b) ?? 0),
      )[0];
      const victimSession = state.leadSessions[victim];
      const session = state.sessions.find((x) => x.id === victimSession);
      if (session) pendingClose.set(victimSession, { agent: session.agent, label: session.label });
      state.send({ type: "terminal_close", session_id: victimSession });
      leadEvicted.add(victim);
      set((s) =>
        withLeadView(s, {
          sessions: s.sessions.filter((x) => x.id !== victimSession),
          activeSessionId: s.activeSessionId === victimSession ? undefined : s.activeSessionId,
          leadSessions: without(s.leadSessions, victim),
          logs: pushLog(
            s,
            makeLog(
              "info",
              `${session?.label ?? "lead"} kapatıldı — en fazla ${MAX_LEAD_PTYS} lead PTY açık tutulur; takıma dönünce yeniden açılır.`,
            ),
          ),
        }),
      );
    }
    leadEvicted.delete(team);
    leadLastUsed.set(team, leadNow());
    clearLeadPending(team);
    pendingLeadTeams.push(team);
    const label = leadLabelFor(dept);
    set((s) =>
      withLeadView(s, {
        leadPendingTeams: { ...s.leadPendingTeams, [team]: true },
        logs: pushLog(s, makeLog("info", `${label} açılıyor — ana komut penceresi (yuppy_dispatch MCP).`)),
      }),
    );
    state.send({
      type: "open_terminal",
      agent: LEAD_AGENT,
      label,
      lead: true,
      ...(team ? { department: team } : null),
    });
    leadPendingTimers.set(
      team,
      setTimeout(() => {
        leadPendingTimers.delete(team);
        if (!get().leadPendingTeams[team]) return;
        const at = pendingLeadTeams.indexOf(team);
        if (at >= 0) pendingLeadTeams.splice(at, 1);
        set((s) =>
          withLeadView(s, {
            leadPendingTeams: without(s.leadPendingTeams, team),
            logs: pushLog(
              s,
              makeLog("warn", `${label} PTY yanıt vermedi — ana komut penceresinden yeniden başlat.`),
            ),
          }),
        );
      }, LEAD_PENDING_TIMEOUT_MS),
    );
    return true;
  },

  setSelectedTeam: (id) => {
    persistTeam(id);
    leadLastUsed.set(id, leadNow());
    set((s) => withLeadView(s, { selectedTeam: id, selectedDept: id }));
    autoOpenLead(get);
  },

  openTerminal: (agent, label, department, role) => {
    const state = get();
    if (state.status !== "connected") {
      set((s) => ({
        logs: pushLog(
          s,
          makeLog("warn", "Bridge offline: a real PTY cannot be opened. No terminal is simulated."),
        ),
      }));
      return;
    }
    set({ dockOpen: true });
    const targetedDepartment = department || state.selectedDept || undefined;
    if (targetedDepartment) {
      const queue = pendingTerminalDepartments.get(agent) ?? [];
      queue.push({ department: targetedDepartment, role });
      pendingTerminalDepartments.set(agent, queue);
    }
    state.send({
      type: "open_terminal",
      agent,
      label,
      department: targetedDepartment,
    });
  },

  sendPromptToSeats: (text, agents) => {
    const state = get();
    const prompt = text.trim();
    if (!prompt || agents.length === 0) return false;
    if (state.status !== "connected") {
      set((s) => ({
        logs: pushLog(
          s,
          makeLog("warn", "Bridge offline: no real keystrokes can be typed. Nothing was sent."),
        ),
      }));
      return false;
    }
    set({ dockOpen: true });
    // One agent may own several live seats (seatStartup "all": one per role).
    // A single prompt is a fan-out, so every live seat for a requested agent
    // receives it; a seat is opened only when that agent has none at all.
    const typed: string[] = [];
    const opened: string[] = [];
    const blocked: string[] = [];
    for (const agent of agents) {
      // The lead PTY (main command window) is driven by the operator
      // directly; a seat fan-out never types into it.
      const live = state.sessions.filter((x) => x.agent === agent && !x.lead);
      if (live.length > 0) {
        const blockedBefore = blocked.length;
        let delivered = 0;
        for (const seat of live) {
          // The seat's last real frame decides: typing into a trust/theme
          // dialog answers it for the operator (and "No, exit" kills the box).
          const frame = seat.lastScreen;
          if (
            frame &&
            frame.type === "terminal_screen" &&
            showsDialog(cellsToText(frame.cells, frame.rows, frame.cols))
          ) {
            blocked.push(seat.label || agentShortName(agent));
            // Keep the prompt for this seat: once the operator answers the
            // dialog, the next settled frame types it (newest prompt wins).
            for (let i = seatPromptQueue.length - 1; i >= 0; i--) {
              if (seatPromptQueue[i].sessionId === seat.id) {
                const old = seatPromptQueue[i];
                if (old.timer) clearTimeout(old.timer);
                seatPromptQueue.splice(i, 1);
              }
            }
            seatPromptQueue.push({
              agent,
              text: prompt,
              sessionId: seat.id,
              frames: 2,
              firstFrameAt: Date.now(),
              screen: cellsToText(frame.cells, frame.rows, frame.cols),
              dialogWarned: true,
            });
            continue;
          }
          // A prompt still parked behind an earlier dialog is superseded.
          for (let i = seatPromptQueue.length - 1; i >= 0; i--) {
            if (seatPromptQueue[i].sessionId === seat.id) {
              const old = seatPromptQueue[i];
              if (old.timer) clearTimeout(old.timer);
              seatPromptQueue.splice(i, 1);
            }
          }
          const [body, enter] = seatInputChunks(prompt);
          state.send({ type: "terminal_input", session_id: seat.id, bytes: body });
          setTimeout(() => {
            get().send({ type: "terminal_input", session_id: seat.id, bytes: enter });
          }, SEAT_ENTER_DELAY_MS);
          typed.push(agentShortName(agent));
          delivered += 1;
        }
        // Every seat for this agent is stuck in an operator dialog.
        if (delivered === 0 && blocked.length === blockedBefore)
          blocked.push(agentShortName(agent));
        continue;
      }
      // The newest prompt wins: a stale entry with no session (spawn failed
      // earlier) would otherwise hijack this agent's next PTY and retype it.
      for (let i = seatPromptQueue.length - 1; i >= 0; i--) {
        if (seatPromptQueue[i].agent === agent && !seatPromptQueue[i].sessionId)
          seatPromptQueue.splice(i, 1);
      }
      seatPromptQueue.push({ agent, text: prompt, frames: 0 });
      state.openTerminal(agent, undefined, state.selectedDept || undefined);
      opened.push(agentShortName(agent));
    }
    const seats = [...typed, ...opened, ...blocked].join(" + ");
    set((s) => ({
      logs: [
        ...s.logs,
        makeLog("prompt", prompt),
        makeLog(
          "info",
          opened.length > 0
            ? `Koltuklara yazıldı ×${typed.length + opened.length} → ${seats} · ${opened.length} yeni PTY açılıyor, prompt gerçek tuşlarla iletilecek.`
            : `Koltuklara yazıldı ×${typed.length} → ${seats} · gerçek PTY tuş girişi.`,
        ),
        ...(blocked.length > 0
          ? [
              makeLog(
                "warn",
                `${blocked.join(" + ")} koltuğu diyalog ekranında bekliyor — prompt henüz YAZILMADI. Kutuya tıklayıp kararı sen ver (trust/tema ekranları insana aittir); diyalog kapanınca prompt kendiliğinden yazılır.`,
              ),
            ]
          : []),
      ].slice(-MAX_LOG_ENTRIES),
    }));
    return true;
  },

  submitTasks: (tasks) => {
    const state = get();
    if (tasks.length === 0) return false;
    if (state.status !== "connected") {
      set((s) => ({
        logs: pushLog(s, makeLog("warn", "Bridge offline: sub-agent tasks were not submitted.")),
      }));
      return false;
    }
    state.send({ type: "task_submit", tasks });
    set((s) => ({
      tasks: tasks.reduce(
        (out, task) => {
          out[task.id] = {
            id: task.id,
            title: task.title,
            state: "queued",
            detail: task.role ?? null,
            cli: task.cli,
            department: task.department ?? null,
            role: task.role ?? null,
            origin: "operator",
          };
          return out;
        },
        { ...s.tasks },
      ),
      logs: [
        ...s.logs,
        makeLog("prompt", tasks[0]?.prompt ?? tasks[0]?.title ?? ""),
        makeLog(
          "info",
          `Dispatched ×${tasks.length} → ${[...new Set(tasks.map((t) => agentShortName(t.cli ?? "")))].join(" + ")} · ${
            tasks[0]?.isolation === "worktree" ? "worktree" : "paylaşılan workspace"
          }${tasks.length >= 2 ? ` · ${tasks.length} CLI paralel + ortak yuppy_* mesaj veriyolu` : " · tek CLI"}.`,
        ),
      ].slice(-MAX_LOG_ENTRIES),
    }));
    return true;
  },

  focusSession: (id) => set({ activeSessionId: id }),

  closeTerminal: (id) => {
    const session = get().sessions.find((s) => s.id === id);
    if (session) pendingClose.set(id, { agent: session.agent, label: session.label });
    get().send({ type: "terminal_close", session_id: id });
    set((state) => {
      const team = teamOfLead(state, id);
      return withLeadView(state, {
        sessions: state.sessions.filter((s) => s.id !== id),
        activeSessionId: state.activeSessionId === id ? undefined : state.activeSessionId,
        ...(team !== undefined
          ? {
              leadSessions: without(state.leadSessions, team),
              leadExits: {
                ...state.leadExits,
                [team]: { sessionId: id, agent: session?.agent, label: session?.label, ts: Date.now() },
              },
            }
          : null),
      });
    });
  },

  restartSession: (id) => {
    const session = get().sessions.find((s) => s.id === id);
    if (!session) return;
    const { agent, label, department, role } = session;
    const leadTeam = teamOfLead(get(), id);
    get().closeTerminal(id);
    set((s) => ({
      logs: pushLog(s, makeLog("info", `restarting ${label} — closing the old PTY first.`)),
    }));
    // Give the backend a moment to reap the old PTY before spawning the same
    // agent again; the seat keeps its box position across the restart.
    setTimeout(() => {
      if (get().status !== "connected") return;
      // The lead restarts as the lead (with its MCP tools), never as a seat.
      if (leadTeam !== undefined) get().openLeadTerminal(leadTeam);
      else get().openTerminal(agent, label, department, role);
    }, 450);
  },

  clearLastExit: () => set({ lastExit: undefined }),
  clearLogs: () => set({ logs: [] }),
  setDockOpen: (open) => set({ dockOpen: open }),

  setMatrixColumns: (columns) => {
    if (typeof window !== "undefined") {
      try {
        localStorage.setItem(MATRIX_STORAGE_KEY, String(columns));
      } catch {
        // Presentation only; an unavailable storage backend is not fatal.
      }
    }
    set({ matrixColumns: columns });
  },

  setSeatSizePreset: (size) => {
    if (typeof window !== "undefined") {
      try {
        localStorage.setItem(
          SEAT_SIZE_STORAGE_KEY,
          size === "auto" ? "auto" : `${size.cols}x${size.rows}`,
        );
      } catch {
        // Presentation only; an unavailable storage backend is not fatal.
      }
    }
    set({ seatSizePreset: size });
  },

  setSeatStartup: (mode) => {
    if (typeof window !== "undefined") {
      try {
        localStorage.setItem(AUTO_TERMINALS_STORAGE_KEY, mode);
      } catch {
        // Presentation only.
      }
    }
    set({ seatStartup: mode });
    if (mode !== "all" && autoSpawnTimer) {
      clearTimeout(autoSpawnTimer);
      autoSpawnTimer = null;
    }
    if (mode !== "off") autoOpenLead(get);
    if (mode === "all") get().autoDeployTerminals();
  },

  /**
   * Spawn the worker seats the startup policy allows. Only the explicit
   * "all" mode opens worker PTYs, paced one-per-tick so it never starts a
   * dozen heavy CLIs in one burst; the default ("lead") opens none — workers
   * run headless and stream to their cards.
   *
   * Called on connect, on inventory refresh and when departments load;
   * `autoAttempted` keeps an opened/closed/failed seat closed for the rest of
   * this connection so the operator is never fought by the auto-deployer.
   */
  autoDeployTerminals: () => {
    if (autoSpawnTimer) return; // paced queue already running
    const policy = get().seatStartup;
    if (policy !== "all" || get().status !== "connected") return;
    const spawnNext = () => {
      autoSpawnTimer = null;
      const state = get();
      const mode = state.seatStartup;
      if (mode !== "all" || state.status !== "connected") return;
      const wanted = autoSeats(planSeats(state.departments, state.agents), mode);
      // The lead PTY is not a worker seat: it must not absorb Claude's seat.
      const workers = state.sessions.filter((x) => !x.lead);
      const seats = planSeatOpens(wanted, workers, autoAttempted);
      const seat = seats[0];
      if (!seat) return;
      autoAttempted.add(seat.seatKey);
      state.openTerminal(seat.agent, seat.label, seat.department, seat.role);
      const gen = autoGen;
      autoSpawnTimer = setTimeout(() => {
        autoSpawnTimer = null;
        if (gen === autoGen) spawnNext();
      }, SEAT_SPAWN_INTERVAL_MS);
    };
    spawnNext();
  },

  // Hydration starts from the deterministic auto default; consume the
  // persisted density only after React has attached to the exported HTML.
  hydratePreferences: () => {
    if (typeof window === "undefined") return;
    const columns = loadMatrixColumns();
    if (columns !== get().matrixColumns) set({ matrixColumns: columns });
    const startup = loadSeatStartup();
    if (startup !== get().seatStartup) set({ seatStartup: startup });
    const seatSize = loadSeatSize();
    if (JSON.stringify(seatSize) !== JSON.stringify(get().seatSizePreset))
      set({ seatSizePreset: seatSize });
    const stored = loadStoredTeam();
    if (stored && !get().selectedTeam && !departmentsKnown) {
      set((s) => withLeadView(s, { selectedTeam: stored, selectedDept: stored }));
    }
    get().autoDeployTerminals();
  },

  setDockHeight: (height) => {
    const state = get();
    commitDock({
      height: clampDockHeight(height),
      maximized: state.dockMaximized,
      hidden: state.dockHidden,
    });
  },

  toggleDockMaximized: () => {
    const state = get();
    const maximized = !state.dockMaximized;
    commitDock({
      height: state.dockHeight,
      maximized,
      // A maximized dock is always visible; restoring maximizes nothing.
      hidden: maximized ? false : state.dockHidden,
    });
  },

  toggleDockHidden: (hidden) => {
    const state = get();
    const next = hidden ?? !state.dockHidden;
    commitDock({
      height: state.dockHeight,
      maximized: next ? false : state.dockMaximized,
      hidden: next,
    });
  },

  setSelectedDept: (id) => set({ selectedDept: id }),
  setSelectedAgent: (id) => set({ selectedAgent: id }),

  setCarouselIds: (ids) => {
    if (ids.length === 0) return;
    const current = get().selectedDept;
    if (!ids.includes(current)) {
      set({ carouselIds: ids, selectedDept: ids[0] });
    } else {
      set({ carouselIds: ids });
    }
  },

  rotateCarousel: (delta) => {
    const state = get();
    if (state.openedDept || delta === 0) return;
    const ids =
      state.carouselIds.length > 0 ? state.carouselIds : state.departments.map((d) => d.id);
    if (ids.length === 0) return;
    const current = ids.indexOf(state.selectedDept);
    const next = (((current < 0 ? 0 : current) + delta) % ids.length + ids.length) % ids.length;
    set({ selectedDept: ids[next] });
  },

  selectDepartmentAt: (index) => {
    const ids = get().carouselIds;
    if (index >= 0 && index < ids.length) set({ selectedDept: ids[index] });
  },

  openDepartment: (id) => {
    const target = id ?? get().selectedDept;
    if (!target) return;
    set({ selectedDept: target, openedDept: target, selectedPanel: null });
  },

  closeDepartment: () => set({ openedDept: null }),

  setCarouselPull: (amount) =>
    set({ carouselPull: Math.min(1, Math.max(0, Number.isFinite(amount) ? amount : 0)) }),

  setHandHoverDept: (id) => {
    if (get().handHoverDept !== id) set({ handHoverDept: id });
  },

  setPanelTransform: (id, patch) => {
    set((state) => ({
      panelLayout: {
        ...state.panelLayout,
        [id]: normalizePanel(id, { ...state.panelLayout[id], ...patch }),
      },
    }));
    scheduleLayoutSave();
  },

  selectPanel: (id) => set({ selectedPanel: id }),
  setEditMode: (on) => set({ editMode: on }),
  setMinimalHud: (on) => set({ minimalHud: on }),

  togglePanelVisible: (id) => {
    set((state) => ({
      panelLayout: {
        ...state.panelLayout,
        [id]: { ...state.panelLayout[id], visible: !state.panelLayout[id].visible },
      },
    }));
    scheduleLayoutSave();
  },

  togglePanelPinned: (id) => {
    set((state) => ({
      panelLayout: {
        ...state.panelLayout,
        [id]: { ...state.panelLayout[id], pinned: !state.panelLayout[id].pinned },
      },
    }));
    scheduleLayoutSave();
  },

  togglePanelMinimized: (id) => {
    set((state) => ({
      panelLayout: {
        ...state.panelLayout,
        [id]: { ...state.panelLayout[id], minimized: !state.panelLayout[id].minimized },
      },
    }));
    scheduleLayoutSave();
  },

  bringPanelForward: (id) => {
    set((state) => {
      const top = Math.max(...PANEL_IDS.map((p) => state.panelLayout[p].zOrder));
      return {
        panelLayout: {
          ...state.panelLayout,
          [id]: { ...state.panelLayout[id], zOrder: top + 1 },
        },
      };
    });
    scheduleLayoutSave();
  },

  resetPanels: () => {
    set({
      panelLayout: cloneDefaults(),
      selectedPanel: "departments",
      dockHeight: DEFAULT_DOCK.height,
      dockMaximized: DEFAULT_DOCK.maximized,
      dockHidden: DEFAULT_DOCK.hidden,
    });
    if (typeof window !== "undefined") {
      try {
        localStorage.removeItem(PANEL_STORAGE_KEY);
        localStorage.removeItem(DOCK_STORAGE_KEY);
      } catch {
        // ignore
      }
    }
    sendLayoutNow();
    set((s) => ({ logs: pushLog(s, makeLog("info", "HUD layout reset to defaults.")) }));
  },

  savePanels: () => {
    const state = get();
    persistPanelsLocally(state.panelLayout);
    if (state.status === "connected") {
      sendLayoutNow();
      set((s) => ({
        logs: pushLog(s, makeLog("info", "HUD layout saved locally and to the bridge.")),
      }));
    } else {
      set((s) => ({
        logs: pushLog(
          s,
          makeLog("info", "HUD layout saved locally; bridge is offline, so no backend save was sent."),
        ),
      }));
    }
  },

  setDraggingPanel: (dragging) => set({ draggingPanel: dragging }),

  upsertDepartment: (dept) => {
    const existed = get().departments.some((d) => d.id === dept.id);
    set((state) => ({
      departments: existed
        ? state.departments.map((d) => (d.id === dept.id ? dept : d))
        : [...state.departments, dept],
      selectedDept: dept.id,
    }));
    if (get().status !== "connected") {
      set((s) => ({
        logs: pushLog(s, makeLog("warn", "Department changed locally only — bridge is offline.")),
      }));
      return;
    }
    get().send({ type: "department_upsert", department: dept });
  },

  removeDepartment: (id) => {
    const state = get();
    const next = state.departments.filter((d) => d.id !== id);
    set({
      departments: next,
      selectedDept: state.selectedDept === id ? (next[0]?.id ?? "") : state.selectedDept,
    });
    if (state.status !== "connected") {
      set((s) => ({
        logs: pushLog(s, makeLog("warn", "Department removed locally only — bridge is offline.")),
      }));
      return;
    }
    state.send({ type: "department_remove", id });
  },

  setHandTracking: (patch) => set(patch),

  resetHandTracking: (error) =>
    set({
      handStatus: error ? "error" : "idle",
      handEnabled: false,
      handError: error,
      handCursor: null,
      handGesture: "none",
      handPinch: false,
      handCount: 0,
      handSpread: 0,
      handHoverDept: null,
    }),
}));

/**
 * Team chat watch: whenever a live seat's screen shows a new content line it
 * enters `speech`, paced per seat. The text is verbatim PTY output — nothing
 * here is generated. Installed once, at module scope.
 */
const SPEECH_CAP = 60;
const SPEECH_EVERY_MS = 4000;
const speechSeen = new Map<string, { line: string; ts: number }>();
function installSpeechWatch() {
  if (typeof window === "undefined") return;
  const w = window as unknown as { __yuppySpeechWatch?: boolean };
  if (w.__yuppySpeechWatch) return;
  w.__yuppySpeechWatch = true;
  useHudStore.subscribe((state, prev) => {
    if (state.sessions === prev.sessions) return;
    const now = Date.now();
    const additions: AgentSpeech[] = [];
    for (const session of state.sessions) {
      const line = lastScreenText(session.lastScreen);
      if (!line) continue;
      const old = speechSeen.get(session.id);
      if (old && (old.line === line || now - old.ts < SPEECH_EVERY_MS)) continue;
      speechSeen.set(session.id, { line, ts: now });
      additions.push({
        id: `${session.id}.${now.toString(36)}`,
        agent: session.agent,
        label: session.label || agentShortName(session.agent),
        line,
        ts: now,
      });
    }
    if (additions.length > 0) {
      useHudStore.setState((s) => ({ speech: [...s.speech, ...additions].slice(-SPEECH_CAP) }));
    }
  });
}
installSpeechWatch();

// Debug handle for browser probes (read-only usage); not part of the UI.
if (typeof window !== "undefined") {
  (window as unknown as { __hud?: typeof useHudStore }).__hud = useHudStore;
}

/** Last state narrated per task id (reset on every fresh connection). */
const lastTaskStates = new Map<string, TaskStateDto>();

const TASK_STATE_TR: Record<TaskStateDto, string> = {
  queued: "sırada",
  running: "çalışıyor",
  awaiting_approval: "onay bekliyor",
  completed: "bitti",
  failed: "hata",
  cancelled: "iptal",
};

function taskLogLevel(state: TaskStateDto): LogEntry["level"] {
  if (state === "failed") return "error";
  if (state === "cancelled" || state === "awaiting_approval") return "warn";
  return "info";
}

/** One feed line for a real task transition: who runs it, what, new state. */
export function taskStateLine(
  p: { task_id: string; state: TaskStateDto; detail?: string | null; cli?: string | null; title?: string | null },
  known: Task | undefined,
): string {
  const cli = known?.cli ?? p.cli ?? undefined;
  const who = cli ? agentShortName(cli) : "ajan ?";
  const origin = known?.origin === "operator" ? "" : "lead · ";
  const title = known?.title ?? p.title ?? p.task_id;
  const detail = p.detail && (p.state === "failed" || p.state === "cancelled") ? ` — ${p.detail}` : "";
  return `görev ${origin}${who} · ${title} → ${TASK_STATE_TR[p.state] ?? p.state}${detail}`;
}

/**
 * Auto-open the SELECTED team's lead: once per team per connection (a lead
 * the operator closed, or one that exited, stays closed), plus once more
 * after it was evicted by the memory cap. Waits until the roster is known —
 * the bridge sends its inventory before its departments.
 */
function autoOpenLead(get: () => HudState) {
  const state = get();
  if (state.status !== "connected" || state.seatStartup === "off") return;
  if (!departmentsKnown) return;
  if (!state.agents.some((a) => a.id === LEAD_AGENT && a.available)) return;
  const team = state.selectedTeam;
  if (leadAutoAttempted.has(team) && !leadEvicted.has(team)) return;
  if (state.leadSessions[team] || state.leadPendingTeams[team]) return;
  leadAutoAttempted.add(team);
  state.openLeadTerminal(team);
}

function handleEnvelope(
  env: Envelope,
  set: (partial: Partial<HudState> | ((s: HudState) => Partial<HudState>)) => void,
  get: () => HudState,
) {
  const p = env.payload;
  switch (p.type) {
    case "connected": {
      suppressReconnect = false;
      reconnectAttempt = 0;
      // A restarted bridge must not leave ghost sessions/tasks behind.
      lastServerLayout = null;
      backendLayoutLoaded = false;
      pendingScreens.clear();
      pendingTaskStates.clear();
      pendingTaskOutput.clear();
      set({
        status: "connected",
        offline: false,
        bridgeError: undefined,
        sessions: [],
        activeSessionId: undefined,
        tasks: {},
        taskOutput: {},
        // A new bridge process starts new batches; old bus ids would collide.
        teamMessages: [],
        leadSessions: {},
        leadPendingTeams: {},
        leadExits: {},
        leadSessionId: undefined,
        leadPending: false,
        leadExit: undefined,
      });
      set((s) => ({ logs: pushLog(s, makeLog("info", "Bridge connected and authorized.")) }));
      get().send({ type: "ping" });
      // Re-send any close requests that were dropped while the socket was down.
      for (const sessionId of pendingClose.keys()) {
        try {
          get().send({ type: "terminal_close", session_id: sessionId });
        } catch {
          // socket may have dropped again; entry stays pending for next connect
        }
      }
      startKeepalive();
      // Fresh connection: the auto-deploy ledger starts over so a bridge
      // restart re-opens the seats it just lost.
      autoGen += 1;
      if (autoSpawnTimer) {
        clearTimeout(autoSpawnTimer);
        autoSpawnTimer = null;
      }
      autoAttempted.clear();
      pendingTerminalDepartments.clear();
      seatPromptQueue.length = 0;
      lastTaskStates.clear();
      clearLeadPending();
      leadAutoAttempted.clear();
      leadEvicted.clear();
      pendingLeadTeams.length = 0;
      departmentsKnown = false;
      if (departmentsFallbackTimer) {
        clearTimeout(departmentsFallbackTimer);
        departmentsFallbackTimer = null;
      }
      autoOpenLead(get);
      get().autoDeployTerminals();
      break;
    }
    case "pong":
      break;
    case "agent_inventory": {
      // Every agent runs Claude Code; other CLIs a bridge still reports are
      // ignored, so no chip, seat or picker ever offers them.
      set({ agents: supportedAgents(p.agents) });
      // The lead opens first: it is the main command window. It waits for
      // the roster; an older bridge that never sends one still gets a lead.
      if (!departmentsKnown && !departmentsFallbackTimer) {
        const gen = autoGen;
        departmentsFallbackTimer = setTimeout(() => {
          departmentsFallbackTimer = null;
          if (gen !== autoGen || departmentsKnown) return;
          departmentsKnown = true;
          autoOpenLead(get);
        }, DEPARTMENTS_FALLBACK_MS);
      }
      autoOpenLead(get);
      get().autoDeployTerminals();
      break;
    }
    case "engine":
      set({ engineInfo: p.info });
      break;
    case "departments_loaded": {
      departmentsKnown = true;
      if (departmentsFallbackTimer) {
        clearTimeout(departmentsFallbackTimer);
        departmentsFallbackTimer = null;
      }
      set((s) => {
        // The deck shows one team: the operator's last choice when it still
        // exists, else the first enabled team. A live lead keeps its team.
        const team = pickTeam(p.departments, s.selectedTeam || loadStoredTeam());
        return withLeadView(s, { departments: p.departments, selectedTeam: team, selectedDept: team });
      });
      autoOpenLead(get);
      // Seats are department roles: deploy once the roster is known.
      get().autoDeployTerminals();
      break;
    }
    case "department_upserted":
      if (!p.ok) {
        set((s) => ({
          logs: pushLog(
            s,
            makeLog("error", `Department save failed (${p.id}): ${p.error ?? "unknown error"}`),
          ),
        }));
      }
      break;
    case "layout_applied": {
      lastServerLayout = p.layout;
      const result = layoutFromBackendFloating(p.layout.floating, get().panelLayout);
      // The dock rides in the same floating array under a reserved id. It is
      // applied independently: an older bridge without the entry leaves the
      // locally remembered dock untouched instead of resetting it.
      const dock = dockFromFloating(p.layout.floating);
      if (dock) {
        persistDockState(dock);
        set({
          dockHeight: dock.height,
          dockMaximized: dock.maximized,
          dockHidden: dock.hidden,
        });
      }
      if (result.applied > 0) {
        set({
          panelLayout: result.layout,
          selectedDept: p.layout.active_department ?? get().selectedDept,
        });
        persistPanelsLocally(result.layout);
        if (!backendLayoutLoaded) {
          backendLayoutLoaded = true;
          set((s) => ({
            logs: pushLog(
              s,
              makeLog("info", `Layout restored from bridge (${result.applied} floating panels).`),
            ),
          }));
        }
      } else {
        set({ selectedDept: p.layout.active_department ?? get().selectedDept });
      }
      break;
    }
    case "terminal_opened": {
      const lead = p.lead === true;
      // A queued seat prompt belongs to a worker seat, never to the lead.
      const waiting = lead
        ? undefined
        : seatPromptQueue.find((d) => d.agent === p.agent && !d.sessionId);
      if (waiting) waiting.sessionId = p.session_id;
      // A lead answers the oldest lead request (FIFO); a replay of a known
      // session keeps the team it already had.
      const knownLead = get().sessions.find((x) => x.id === p.session_id && x.lead);
      const leadTeam = lead
        ? (knownLead?.team ?? pendingLeadTeams.shift() ?? get().selectedTeam)
        : undefined;
      if (leadTeam !== undefined) clearLeadPending(leadTeam);
      set((s) => {
        // Dedup by session_id: replace in place so a replayed envelope after
        // reconnect cannot push a duplicate session. A replayed open must
        // also not steal focus from whichever terminal the operator is using.
        // The lead never asked for a department, so it must not consume the
        // FIFO entry a worker seat of the same CLI is waiting for.
        const queue = lead ? undefined : pendingTerminalDepartments.get(p.agent);
        const requested = queue?.shift();
        const requestedDepartment = leadTeam ? leadTeam : requested?.department;
        if (queue && queue.length === 0) pendingTerminalDepartments.delete(p.agent);
        const known = s.sessions.some((x) => x.id === p.session_id);
        const leadPatch =
          leadTeam !== undefined
            ? {
                leadSessions: { ...s.leadSessions, [leadTeam]: p.session_id },
                leadPendingTeams: without(s.leadPendingTeams, leadTeam),
                leadExits: without(s.leadExits, leadTeam),
              }
            : {};
        if (known) {
          return withLeadView(s, {
            ...leadPatch,
            sessions: s.sessions.map((x) =>
              x.id === p.session_id
                ? {
                    ...x,
                    agent: p.agent,
                    label: p.label,
                    department: requestedDepartment ?? x.department,
                    lead: lead || x.lead,
                    ...(leadTeam !== undefined ? { team: leadTeam } : null),
                    ...(requested?.role ? { role: requested.role } : null),
                  }
                : x,
            ),
            dockOpen: true,
          });
        }
        // Multiple seats may run the same CLI (role × department), so a new
        // session id is always appended — the bridge spawns a real PTY per
        // request. The lead takes focus; a worker seat only takes it while
        // there is no lead to type into.
        // The selected team's lead takes focus; a background team's lead
        // or a worker only takes it while there is no lead to type into.
        const takesFocus =
          (leadTeam !== undefined && leadTeam === s.selectedTeam) || !s.leadSessionId;
        return withLeadView(s, {
          ...leadPatch,
          sessions: [
            ...s.sessions,
            {
              id: p.session_id,
              agent: p.agent,
              label: p.label,
              openedAt: Date.now(),
              department: requestedDepartment || undefined,
              ...(leadTeam !== undefined ? { lead: true, team: leadTeam } : null),
              ...(requested?.role ? { role: requested.role } : null),
            },
          ],
          activeSessionId: takesFocus ? p.session_id : s.activeSessionId,
          dockOpen: true,
        });
      });
      set((s) => ({
        logs: pushLog(
          s,
          makeLog("info", lead ? `lead hazır: ${p.label} — görevleri o dağıtır` : `terminal opened: ${p.label}`),
        ),
      }));
      break;
    }
    case "terminal_closed": {
      const known =
        get().sessions.find((x) => x.id === p.session_id) ?? pendingClose.get(p.session_id);
      pendingClose.delete(p.session_id);
      // A box that dies before delivery must not keep its prompt hostage:
      // drop the queued entry so the next prompt for this agent isn't starved.
      const lostPrompt = seatPromptQueue.find((d) => d.sessionId === p.session_id);
      if (lostPrompt) seatPromptQueue.splice(seatPromptQueue.indexOf(lostPrompt), 1);
      const summary =
        p.exit_code != null
          ? `exit ${p.exit_code}`
          : p.signal
            ? `signal ${p.signal}`
            : "exit status unavailable";
      const exit: TerminalExit = {
        sessionId: p.session_id,
        agent: known?.agent,
        label: known?.label,
        exitCode: p.exit_code,
        signal: p.signal,
        ts: Date.now(),
      };
      const leadTeam = teamOfLead(get(), p.session_id);
      const wasLead = leadTeam !== undefined;
      set((s) => withLeadView(s, {
        sessions: s.sessions.filter((x) => x.id !== p.session_id),
        activeSessionId: s.activeSessionId === p.session_id ? undefined : s.activeSessionId,
        lastExit: exit,
        ...(wasLead
          ? { leadSessions: without(s.leadSessions, leadTeam), leadExits: { ...s.leadExits, [leadTeam]: exit } }
          : null),
        logs: pushLog(
          s,
          makeLog(
            wasLead ? "warn" : "info",
            wasLead
              ? `Lead Claude kapandı (${summary}) — ana komut penceresinden yeniden başlat.`
              : `${known?.label ?? "terminal"} closed (${summary}).`,
          ),
        ),
      }));
      break;
    }
    case "terminal_screen": {
      // A queued seat prompt types itself once its fresh CLI has drawn
      // a couple of frames — real input to a real, rendered prompt box.
      // Delivery waits for the box to settle (see scheduleSeatDelivery):
      // Codex draws a composer first and its trust dialog a beat later.
      const ready = seatPromptQueue.find((d) => d.sessionId === p.session_id);
      if (ready) {
        ready.frames += 1;
        ready.firstFrameAt ??= Date.now();
        ready.screen = cellsToText(p.cells, p.rows, p.cols);
        if (ready.frames >= 2) scheduleSeatDelivery(ready, get, set);
      }
      // Buffer the newest frame per session; one rAF flush applies them all.
      pendingScreens.set(p.session_id, p);
      scheduleCoalescedUpdates();
      break;
    }
    case "task_state": {
      pendingTaskStates.set(p.task_id, p);
      scheduleCoalescedUpdates();
      // The information console narrates every real transition once (a
      // replayed or repeated state is not news). Tasks this window never
      // submitted are the lead's own dispatches and are labelled so.
      if (lastTaskStates.get(p.task_id) !== p.state) {
        lastTaskStates.set(p.task_id, p.state);
        const known = get().tasks[p.task_id];
        set((s) => ({
          logs: pushLog(s, makeLog(taskLogLevel(p.state), taskStateLine(p, known))),
        }));
      }
      break;
    }
    case "tasks_dispatched": {
      // Fill in what a bare task_state cannot say (title, CLI, department)
      // for batches this window did not file — the lead's dispatches.
      set((s) => {
        const tasks = { ...s.tasks };
        for (const t of p.tasks) {
          const prev = tasks[t.id];
          tasks[t.id] = {
            id: t.id,
            title: prev?.title ?? t.title,
            state: prev?.state ?? "queued",
            detail: prev?.detail ?? t.role ?? null,
            cli: prev?.cli ?? t.cli,
            department: prev?.department ?? t.department ?? null,
            role: prev?.role ?? t.role ?? null,
            origin: prev?.origin ?? (p.lead ? "lead" : "operator"),
            ...(prev?.report ? { report: prev.report } : null),
          };
        }
        const fresh = p.tasks.filter((t) => !s.tasks[t.id]);
        return {
          tasks,
          logs:
            p.lead && fresh.length > 0
              ? pushLog(
                  s,
                  makeLog(
                    "info",
                    `Lead dağıttı ×${fresh.length} paralel → ${fresh.map((t) => t.title || t.id).join(" + ")}`,
                  ),
                )
              : s.logs,
        };
      });
      break;
    }
    case "task_output": {
      if (typeof p.line !== "string") break;
      const queue = pendingTaskOutput.get(p.task_id);
      if (queue) queue.push(p.line);
      else pendingTaskOutput.set(p.task_id, [p.line]);
      scheduleCoalescedUpdates();
      break;
    }
    case "task_report": {
      const known = get().tasks[p.task_id];
      const report = {
        success: p.success,
        exitCode: p.exit_code ?? null,
        durationMs: p.duration_ms,
        outputTail: p.output_tail,
      };
      set((s) => ({
        tasks: known ? { ...s.tasks, [p.task_id]: { ...known, report } } : s.tasks,
        logs: pushLog(
          s,
          makeLog(
            p.success ? "info" : "warn",
            `rapor ${known?.title ?? p.task_id} · ${p.success ? "başarılı" : "başarısız"}${
              p.exit_code != null ? ` (çıkış ${p.exit_code})` : ""
            } · ${(p.duration_ms / 1000).toFixed(1)} sn`,
          ),
        ),
      }));
      break;
    }
    case "task_integration":
      set((s) => ({
        integrations: [
          ...s.integrations,
          {
            taskId: p.task_id,
            branch: p.branch,
            changedFiles: p.changed_files,
            committed: p.committed,
            ts: Date.now(),
          },
        ].slice(-100),
        logs: pushLog(
          s,
          makeLog(
            "info",
            `task ${p.task_id} review branch ${p.branch} (${p.changed_files.length} changed file(s), ${p.committed ? "committed" : "not committed"}).`,
          ),
        ),
      }));
      break;
    case "task_conflict":
      set((s) => ({
        conflicts: [
          ...s.conflicts,
          { taskA: p.task_a, taskB: p.task_b, path: p.path, ts: Date.now() },
        ].slice(-100),
        logs: pushLog(
          s,
          makeLog(
            "warn",
            `task conflict on ${p.path}: ${p.task_a} and ${p.task_b} both changed it. Manual merge required.`,
          ),
        ),
      }));
      break;
    case "team_message": {
      const id = `${p.batch}:${p.id}`;
      set((s) => {
        // The bridge already emits each bus id once; the guard makes a
        // reconnect or a duplicated envelope harmless.
        if (s.teamMessages.some((m) => m.id === id)) return {};
        const next: TeamMessage = {
          id,
          batch: p.batch,
          busId: p.id,
          sender: p.sender,
          recipient: p.recipient,
          body: p.body,
          ts: p.ts_ms || Date.now(),
        };
        return { teamMessages: [...s.teamMessages, next].slice(-300) };
      });
      break;
    }
    case "log":
      set((s) => ({ logs: pushLog(s, makeLog(p.level, p.message)) }));
      break;
    case "error": {
      if (p.code === "unauthorized" || p.code === "handshake_timeout") {
        suppressReconnect = true;
        set({
          status: "auth_failed",
          offline: true,
          bridgeError: p.message,
        });
        closeSocket();
      } else if (p.code === "protocol_mismatch") {
        suppressReconnect = true;
        set({
          status: "protocol_mismatch",
          offline: true,
          bridgeError: p.message,
        });
        closeSocket();
      } else {
        set((s) => ({
          bridgeError: `${p.code}: ${p.message}`,
          logs: pushLog(s, makeLog("error", `${p.code}: ${p.message}`)),
        }));
      }
      break;
    }
    default:
      break;
  }
}

function scheduleReconnect() {
  if (reconnectTimer || suppressReconnect) return;
  const delay = Math.min(10_000, 1500 * 2 ** reconnectAttempt);
  reconnectAttempt += 1;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    reconnecting = true;
    useHudStore.getState().connect();
  }, delay);
}

function scheduleCoalescedUpdates() {
  if (coalesceScheduled) return;
  coalesceScheduled = true;
  if (typeof requestAnimationFrame === "undefined") {
    flushCoalescedUpdates();
    return;
  }
  requestAnimationFrame(flushCoalescedUpdates);
}

function flushCoalescedUpdates() {
  coalesceScheduled = false;
  const screens = [...pendingScreens.values()];
  const taskStates = [...pendingTaskStates.values()];
  const outputs = [...pendingTaskOutput.entries()];
  pendingScreens.clear();
  pendingTaskStates.clear();
  pendingTaskOutput.clear();
  if (screens.length === 0 && taskStates.length === 0 && outputs.length === 0) return;
  useHudStore.setState((s) => {
    const patch: Partial<HudState> = {};
    if (screens.length > 0) {
      const bySession = new Map(screens.map((p) => [p.session_id, p]));
      patch.sessions = s.sessions.map((sess) => {
        const p = bySession.get(sess.id);
        return p
          ? { ...sess, rows: p.rows, cols: p.cols, generation: p.generation, lastScreen: p }
          : sess;
      });
    }
    if (taskStates.length > 0) {
      const tasks = { ...s.tasks };
      for (const p of taskStates) {
        const prev = tasks[p.task_id];
        // Live state events carry no detail; keep the earlier one (failure
        // reason, role) instead of blanking it, and keep the submitted title.
        // An unknown id is not dropped: the lead files its own tasks over
        // MCP, so the first event for them is a bare task_state.
        tasks[p.task_id] = {
          id: p.task_id,
          title: prev?.title ?? p.title ?? undefined,
          state: p.state,
          detail: p.detail ?? prev?.detail ?? null,
          cli: prev?.cli ?? p.cli ?? undefined,
          department: prev?.department,
          ...(prev?.role ? { role: prev.role } : null),
          origin: prev?.origin ?? "lead",
          ...(prev?.report ? { report: prev.report } : null),
        };
      }
      patch.tasks = tasks;
    }
    if (outputs.length > 0) {
      const next = { ...s.taskOutput };
      for (const [taskId, lines] of outputs) {
        // Re-insert so the key order is "most recently written last".
        const prev = next[taskId];
        delete next[taskId];
        next[taskId] = pushLines(prev, lines);
      }
      const keys = Object.keys(next);
      for (let i = 0; i < keys.length - TASK_OUTPUT_TASKS_CAP; i++) delete next[keys[i]];
      patch.taskOutput = next;
    }
    return patch;
  });
}

/**
 * Apply the desktop shell's `{url, token}` and dial it. Exported so the
 * pairing regression can be tested without a Tauri runtime: the store's
 * `bridgeUrl` was computed at module load (before `bridge_config` resolved),
 * so the URL must be passed explicitly instead of relying on that default.
 */
export function applyDesktopBridgeConfig(
  cfg: { url?: string; token?: string | null } | null | undefined,
): void {
  const url = cfg?.url ?? "ws://127.0.0.1:9090";
  if (cfg?.token) desktopBridge = { url, token: cfg.token };
  useHudStore.setState({ bridgeUrl: url });
  useHudStore.getState().connect(url, cfg?.token ?? undefined);
}

/**
 * Desktop pairing bootstrap (Tauri only). The shell spawns `yuppy bridge`
 * with a fresh token and hands `{url, token}` to its own webview here. The
 * token lives in `desktopBridge` (memory) for the lifetime of the window and
 * is never persisted. In the browser this block is inert.
 */
if (typeof window !== "undefined" && "__TAURI_INTERNALS__" in window) {
  type ShellBridge = {
    invoke: (cmd: string) => Promise<{ url?: string; token?: string | null }>;
  };
  const shell = (window as unknown as { __TAURI_INTERNALS__?: ShellBridge })
    .__TAURI_INTERNALS__;
  void shell
    ?.invoke("bridge_config")
    .then((cfg) => applyDesktopBridgeConfig(cfg))
    .catch(() => {
      /* fall back to the manual pairing flow */
    });
}
