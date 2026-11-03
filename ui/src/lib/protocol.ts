/** Subset of the YuppyCode bridge protocol v2 used by the HUD. */
export const PROTOCOL_VERSION = 2 as const;

export type ServerPayload =
  | { type: "connected" }
  | { type: "pong" }
  | {
      type: "engine";
      info: EngineInfoDto;
    }
  | {
      type: "agent_inventory";
      agents: AgentStatusDto[];
    }
  | {
      type: "department_upserted";
      id: string;
      ok: boolean;
      error?: string | null;
    }
  | {
      type: "departments_loaded";
      departments: DepartmentDto[];
    }
  | {
      type: "layout_applied";
      name: string;
      layout: LayoutDto;
    }
  | {
      type: "terminal_opened";
      session_id: string;
      agent: string;
      label: string;
      /** True for the team lead's interactive Claude Code PTY (the main
       * command window). Older bridges omit it, which means "worker seat". */
      lead?: boolean;
    }
  | {
      type: "terminal_closed";
      session_id: string;
      exit_code?: number | null;
      signal?: string | null;
    }
  | {
      type: "terminal_screen";
      session_id: string;
      rows: number;
      cols: number;
      cursor: [number, number];
      cursor_visible: boolean;
      generation: number;
      cells: TerminalCellDto[];
    }
  | {
      type: "task_state";
      task_id: string;
      state: TaskStateDto;
      detail?: string | null;
      /** Optional executor/title for tasks this window did not submit (the
       * lead dispatches its own via `yuppy_dispatch`). Read when present;
       * the current bridge sends only id/state/detail. */
      cli?: string | null;
      title?: string | null;
    }
  | {
      /** Every accepted batch, broadcast to all clients — including the
       * lead's own `yuppy_dispatch` batches, so titles/CLIs are known. */
      type: "tasks_dispatched";
      tasks: TaskSpecDto[];
      lead: boolean;
    }
  | {
      /** One streamed output line of a headless worker (`claude -p`). Sent
       * while the task runs; the card for its (department, role) shows it. */
      type: "task_output";
      task_id: string;
      line: string;
    }
  | {
      /** One per task that actually ran, sent when its batch finishes. */
      type: "task_report";
      task_id: string;
      success: boolean;
      exit_code?: number | null;
      duration_ms: number;
      output_tail: string;
    }
  | {
      type: "task_integration";
      task_id: string;
      branch: string;
      changed_files: string[];
      committed: boolean;
    }
  | {
      type: "task_conflict";
      task_a: string;
      task_b: string;
      path: string;
    }
  | {
      type: "team_message";
      batch: string;
      sender: string;
      recipient: string;
      body: string;
      ts_ms: number;
      id: number;
    }
  | {
      type: "log";
      level: "info" | "warn" | "error";
      message: string;
    }
  | {
      type: "error";
      code: string;
      message: string;
    };

export type ClientRequest =
  | { type: "ping" }
  | {
      type: "open_terminal";
      agent: string;
      label?: string;
      department?: string;
      /** Ask for the lead PTY: Claude Code with the yuppy_dispatch /
       * yuppy_tasks / yuppy_cancel MCP tools. Serde default is false. */
      lead?: boolean;
    }
  | { type: "terminal_input"; session_id: string; bytes: string }
  | { type: "terminal_resize"; session_id: string; rows: number; cols: number }
  | { type: "terminal_interrupt"; session_id: string }
  | { type: "terminal_close"; session_id: string }
  | { type: "department_upsert"; department: DepartmentDto }
  | { type: "department_remove"; id: string }
  | { type: "layout_save"; name: string; layout: LayoutDto }
  | { type: "layout_load"; name: string }
  | { type: "task_submit"; tasks: TaskSpecDto[] }
  | { type: "task_cancel"; task_id: string };

export interface Envelope {
  version: number;
  seq: number;
  ts_ms: number;
  payload: ServerPayload;
}

export interface AgentStatusDto {
  id: string;
  display_name: string;
  available: boolean;
  version?: string | null;
  install_hint?: string | null;
}

/** Workspace/engine facts from the bridge's post-handshake burst. */
export interface EngineInfoDto {
  provider: string;
  /** Empty when the bridge hosts CLIs that own their model choice. */
  model: string;
  engine_state: string;
  workspace: string;
  memory_enabled: boolean;
  mcp_servers: string[];
  /** Branch of the workspace checkout, when one exists. */
  git_branch?: string | null;
}

export interface DeptAgentDto {
  cli: string;
  model?: string | null;
}

export interface DepartmentRoleDto {
  id: string;
  /** Job title, e.g. "Backend Developer". */
  name: string;
  description?: string;
  /** Always "claude-code" — every agent runs Claude Code. */
  cli: string;
  model?: string | null;
  enabled?: boolean;
  /** Persona name ("Ratchet"). Empty/absent → fall back to `name`. */
  callsign?: string;
  /** The team's lead (one per team). Absent on older bridges. */
  lead?: boolean;
}

/** How a team's Claude Code agents ask for permission. */
export type PermissionModeDto = "default" | "acceptEdits" | "bypassPermissions";

export interface TaskSpecDto {
  id: string;
  title: string;
  prompt: string;
  cli: string;
  model?: string | null;
  department?: string | null;
  role?: string | null;
  isolation: "shared" | "worktree" | string;
  timeout_secs?: number | null;
}

export interface DepartmentDto {
  id: string;
  name: string;
  description?: string;
  icon?: string;
  agents?: DeptAgentDto[];
  roles?: DepartmentRoleDto[];
  workspace?: string | null;
  allowed_tools?: string[];
  max_concurrency: number;
  enabled: boolean;
  panels?: string[];
  /** Claude Code permission mode for this team's agents. Absent → "default". */
  permission_mode?: PermissionModeDto;
}

export interface PanelDto {
  id: string;
  kind: string;
  title?: string;
  zone: "left" | "right" | "center" | string;
  order?: number;
  visible?: boolean;
  collapsed?: boolean;
  maximized?: boolean;
  z?: number;
  department?: string | null;
}

export interface FloatingPanelDto {
  id: string;
  x: number;
  y: number;
  z: number;
  scale: number;
  width: number;
  height: number;
  visible: boolean;
  pinned: boolean;
  minimized: boolean;
  z_order: number;
}

export interface LayoutDto {
  panels: PanelDto[];
  focused?: string | null;
  active_department?: string | null;
  floating?: FloatingPanelDto[];
}

export interface TerminalCellDto {
  ch: string;
  fg: CellColorDto;
  bg: CellColorDto;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  inverse: boolean;
  wide: boolean;
}

export type CellColorDto =
  | { t: "default" }
  | { t: "idx"; i: number }
  | { t: "rgb"; r: number; g: number; b: number };

export type TaskStateDto =
  | "queued"
  | "running"
  | "awaiting_approval"
  | "completed"
  | "failed"
  | "cancelled";
