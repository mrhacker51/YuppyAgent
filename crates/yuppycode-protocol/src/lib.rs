//! YuppyCode wire protocol.
//!
//! Versioned, transport-neutral types shared by every future transport
//! (local IPC, WebSocket bridge in Phase 2, Tauri shell in Phase 3).
//! Phase 1 never opens a socket: these types are what a bridge would carry.
//!
//! Envelope rule: every server->client message is wrapped in [`Envelope`] so a
//! relay can validate version, order (`seq`) and freshness (`ts_ms`) without
//! understanding the payload.

use serde::{Deserialize, Serialize};

/// Current protocol version. Bump on any incompatible change.
/// v2 adds terminal-session, department, layout and orchestrator
/// messages for the Phase 2 command-center frontends. All v1 variants
/// keep their exact wire shape; only new variants/messages were added,
/// so v1 clients can still parse every v1 message a v2 server sends.
pub const PROTOCOL_VERSION: u32 = 2;

/// Requests a client (TUI, web UI, script) sends to the engine.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum ClientRequest {
    /// Ask a prompt to be executed by the agent.
    Run {
        prompt: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        conversation_id: Option<String>,
    },
    /// Cancel the run currently in flight (if any).
    Cancel { run_id: String },
    /// Approve or deny a pending high-risk tool call.
    Approval { call_id: String, approved: bool },
    /// Switch model at runtime.
    SetModel { provider: String, model: String },
    /// Health check; answered with [`ServerPayload::Pong`].
    Ping,
    /// Open a live interactive CLI terminal session.
    OpenTerminal {
        /// "claude-code" | "codex" (adapter ids).
        agent: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        label: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        department: Option<String>,
        /// Open this seat as the team lead (conductor). Only valid for
        /// "claude-code": the bridge starts it with the conductor MCP tools
        /// (`yuppy_dispatch`, `yuppy_tasks`, `yuppy_cancel`, ...) and a brief
        /// describing the live team, so the operator talks to one CLI and
        /// that CLI distributes the work. Absent = `false` (v2 clients).
        #[serde(default)]
        lead: bool,
    },
    /// Send raw input (UTF-8) to a terminal session, verbatim.
    TerminalInput { session_id: String, bytes: String },
    /// Resize a terminal session's PTY (cells).
    TerminalResize {
        session_id: String,
        rows: u16,
        cols: u16,
    },
    /// Interrupt (Ctrl-C) a terminal session's foreground process.
    TerminalInterrupt { session_id: String },
    /// Close a terminal session (kills the child if needed).
    TerminalClose { session_id: String },
    /// Upsert a department definition (full replacement by id).
    DepartmentUpsert { department: DepartmentDto },
    /// Remove a department.
    DepartmentRemove { id: String },
    /// Persist the current HUD layout under a name.
    LayoutSave { name: String, layout: LayoutDto },
    /// Load a named layout (server replies [`ServerPayload::LayoutApplied`]).
    LayoutLoad { name: String },
    /// Schedule a batch of orchestrator tasks.
    TaskSubmit { tasks: Vec<TaskSpecDto> },
    /// Cancel a scheduled task (or the whole batch with "batch").
    TaskCancel { task_id: String },
}

/// Timestamped, versioned envelope for one server->client payload.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Envelope {
    pub version: u32,
    pub seq: u64,
    /// Unix epoch milliseconds.
    pub ts_ms: u64,
    pub payload: ServerPayload,
}

impl Envelope {
    pub fn new(seq: u64, ts_ms: u64, payload: ServerPayload) -> Self {
        Self {
            version: PROTOCOL_VERSION,
            seq,
            ts_ms,
            payload,
        }
    }
}

/// Server->client event payloads. Mirrors `yuppycode_core::AgentEvent`
/// (the core crate owns the conversion) but stays dependency-light so any
/// language can codegen against it later.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ServerPayload {
    RunStarted {
        run_id: String,
        prompt_chars: usize,
    },
    TextDelta {
        run_id: String,
        text: String,
    },
    ReasoningDelta {
        run_id: String,
        text: String,
    },
    RunFinished {
        run_id: String,
        status: RunStatus,
    },
    TaskUpsert {
        node: TaskNodeDto,
    },
    ToolStarted {
        run_id: String,
        call_id: String,
        tool: String,
    },
    ToolFinished {
        run_id: String,
        call_id: String,
        ok: bool,
        summary: String,
    },
    ApprovalRequired {
        run_id: String,
        call_id: String,
        tool: String,
        arguments_pretty: String,
        reason: String,
    },
    Log {
        level: LogLevel,
        message: String,
    },
    Telemetry(TelemetrySnapshot),
    Info(EngineInfo),
    Error {
        code: String,
        message: String,
    },
    Pong,
    /// Handshake succeeded; the connection is now authorized.
    Connected,
    /// Workspace/engine facts for the desktop top bar (additive in v2):
    /// workspace path, git branch when the workspace is a working tree.
    Engine {
        info: EngineInfo,
    },
    /// A terminal session was created and is live.
    TerminalOpened {
        session_id: String,
        agent: String,
        label: String,
        /// True when this seat is the team lead (opened with `lead: true`
        /// and wired to the conductor tools). Absent on older servers.
        #[serde(default)]
        lead: bool,
    },
    /// Screen update of a terminal session. `cells` is a flat row-major
    /// array of `rows*cols` cell objects; clients blit it.
    TerminalScreen {
        session_id: String,
        rows: u16,
        cols: u16,
        cursor: (u16, u16),
        cursor_visible: bool,
        generation: u64,
        cells: Vec<TerminalCellDto>,
    },
    TerminalClosed {
        session_id: String,
        exit_code: Option<u32>,
        signal: Option<String>,
    },
    DepartmentUpserted {
        id: String,
        ok: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        error: Option<String>,
    },
    LayoutApplied {
        name: String,
        layout: LayoutDto,
    },
    TaskState {
        task_id: String,
        state: TaskStateDto,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        detail: Option<String>,
        /// CLI running the task ("claude-code" | "codex"), when the bridge
        /// knows it. Lets a client that did not submit the task (e.g. a
        /// lead-dispatched batch) label it without guessing.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        cli: Option<String>,
        /// Task title as submitted, when known.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        title: Option<String>,
    },
    /// A batch was accepted by the scheduler. Broadcast to every connected
    /// client — not only the one that submitted it — so a batch the lead
    /// seat dispatched shows up in the UI with its titles, CLIs and roles
    /// before the first `task_state` arrives. `lead` is true when the
    /// conductor (lead CLI) submitted it rather than the operator's UI.
    TasksDispatched {
        tasks: Vec<TaskSpecDto>,
        #[serde(default)]
        lead: bool,
    },
    /// What one finished task's CLI actually produced: exit status and the
    /// trailing output (bounded by the runner, ~8 KiB). Broadcast once per
    /// task that ran, so the lead can read its workers' results and the UI
    /// can show them. Never synthesized: no run, no report.
    TaskReport {
        task_id: String,
        success: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        exit_code: Option<i32>,
        duration_ms: u64,
        output_tail: String,
    },
    /// Review artifact for a completed worktree task.
    TaskIntegration {
        task_id: String,
        branch: String,
        changed_files: Vec<String>,
        committed: bool,
    },
    /// Two tasks touched the same path; a human must merge.
    TaskConflict {
        task_a: String,
        task_b: String,
        path: String,
    },
    /// One real message an agent sent to another agent (or to everyone) over
    /// the batch's team bus. The UI renders exactly this — it never invents
    /// inter-agent chatter.
    TeamMessage {
        /// The batch this message belongs to (its first task id).
        batch: String,
        sender: String,
        recipient: String,
        body: String,
        /// Unix epoch milliseconds, as the bus stored it.
        ts_ms: u64,
        /// Message id on the bus; strictly increasing within a batch, so a
        /// client can dedupe or resume with it.
        id: i64,
    },
    /// Detected CLIs and their versions (`yuppy agents` equivalent).
    AgentInventory {
        agents: Vec<AgentStatusDto>,
    },
    /// Full department registry, sent after handshake so the frontend can
    /// render names/icons/limits instead of bare ids.
    DepartmentsLoaded {
        departments: Vec<DepartmentDto>,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RunStatus {
    Completed,
    Failed,
    Cancelled,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LogLevel {
    Info,
    Warn,
    Error,
}

/// Serialized view of a task-graph node.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TaskNodeDto {
    pub id: String,
    pub parent_id: Option<String>,
    pub title: String,
    pub status: TaskStatusDto,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskStatusDto {
    Pending,
    Running,
    WaitingApproval,
    Success,
    Failed,
    Cancelled,
}

/// Periodic resource/throughput snapshot for the telemetry pane.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TelemetrySnapshot {
    /// Whole-run token estimates (heuristic tokenizer, see docs).
    pub prompt_tokens_est: u64,
    pub completion_tokens_est: u64,
    /// Approximate completion tokens/second over the sampling window.
    pub tokens_per_sec: f64,
    /// Milliseconds from run start to first streamed token.
    pub time_to_first_token_ms: Option<u64>,
    pub active_tool_calls: u32,
    /// Process resident set size in KiB (measured by the host).
    pub rss_kib: Option<u64>,
}

/// Static + dynamic engine information shown in header/status bar.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct EngineInfo {
    pub provider: String,
    pub model: String,
    pub engine_state: String,
    pub workspace: String,
    pub memory_enabled: bool,
    pub mcp_servers: Vec<String>,
    /// Branch of the workspace's working tree, when one exists. Sampled
    /// once at bridge startup; `None` honestly means "not a git checkout".
    #[serde(default)]
    pub git_branch: Option<String>,
}

/// One terminal screen cell. `ch` is empty for blank; renderers treat
/// it as a space. `wide` marks the head of a double-width glyph.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TerminalCellDto {
    pub ch: String,
    /// "default" | "idx" | "rgb"
    pub fg: CellColorDto,
    pub bg: CellColorDto,
    pub bold: bool,
    pub italic: bool,
    pub underline: bool,
    pub inverse: bool,
    pub wide: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "t", rename_all = "snake_case")]
pub enum CellColorDto {
    Default,
    Idx { i: u8 },
    Rgb { r: u8, g: u8, b: u8 },
}

/// Wire form of a department (mirrors yuppycode-hud::Department).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DepartmentDto {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub icon: String,
    #[serde(default)]
    pub agents: Vec<DeptAgentDto>,
    /// Named sub-agents/roles that can be scheduled in parallel inside the
    /// department (e.g. Backend Developer, Frontend Developer).
    #[serde(default)]
    pub roles: Vec<DepartmentRoleDto>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace: Option<String>,
    #[serde(default)]
    pub allowed_tools: Vec<String>,
    #[serde(default)]
    pub max_concurrency: usize,
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub panels: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DeptAgentDto {
    pub cli: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
}

/// One named sub-agent inside a department. The `cli` points at a real
/// adapter ("claude-code"/"codex"); the orchestrator schedules one task per
/// role so roles can run concurrently subject to department limits.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DepartmentRoleDto {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub description: String,
    pub cli: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default = "default_true")]
    pub enabled: bool,
}

fn default_true() -> bool {
    true
}

/// Wire form of the HUD layout (mirrors yuppycode-hud::LayoutModel).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LayoutDto {
    #[serde(default)]
    pub panels: Vec<PanelDto>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub focused: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub active_department: Option<String>,
    /// Free-floating panel geometry used by spatial/web renderers.
    /// The terminal/TUI renderer keeps using `panels` above; this field is
    /// additive so older clients ignore it safely.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub floating: Vec<FloatingPanelDto>,
}

/// Geometry and UI state of one free-floating HUD panel.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FloatingPanelDto {
    pub id: String,
    #[serde(default)]
    pub x: f32,
    #[serde(default)]
    pub y: f32,
    #[serde(default)]
    pub z: f32,
    #[serde(default)]
    pub scale: f32,
    #[serde(default)]
    pub width: f32,
    #[serde(default)]
    pub height: f32,
    #[serde(default)]
    pub visible: bool,
    #[serde(default)]
    pub pinned: bool,
    #[serde(default)]
    pub minimized: bool,
    #[serde(default)]
    pub z_order: i32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PanelDto {
    pub id: String,
    pub kind: String,
    #[serde(default)]
    pub title: String,
    /// "left" | "right" | "center"
    pub zone: String,
    #[serde(default)]
    pub order: u32,
    #[serde(default)]
    pub visible: bool,
    #[serde(default)]
    pub collapsed: bool,
    #[serde(default)]
    pub maximized: bool,
    #[serde(default)]
    pub z: i32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub department: Option<String>,
}

/// One scheduled task definition.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TaskSpecDto {
    pub id: String,
    pub title: String,
    pub prompt: String,
    /// "claude-code" | "codex"
    pub cli: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub department: Option<String>,
    /// Optional named sub-agent role that owns this task.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub role: Option<String>,
    /// "shared" | "worktree"
    pub isolation: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timeout_secs: Option<u64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskStateDto {
    Queued,
    Running,
    AwaitingApproval,
    Completed,
    Failed,
    Cancelled,
}

/// Detection result for one CLI (see `yuppy agents`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AgentStatusDto {
    pub id: String,
    pub display_name: String,
    pub available: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub install_hint: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn roundtrip<T: serde::Serialize + serde::de::DeserializeOwned>(v: &T) -> T {
        let json = serde_json::to_string(v).unwrap();
        serde_json::from_str(&json).unwrap()
    }

    #[test]
    fn client_request_roundtrip_and_tag_format() {
        let req = ClientRequest::Run {
            prompt: "hi".into(),
            conversation_id: None,
        };
        let json = serde_json::to_string(&req).unwrap();
        assert!(json.contains("\"type\":\"run\""), "{json}");
        assert!(
            !json.contains("conversation_id"),
            "None must be skipped: {json}"
        );
        assert_eq!(roundtrip(&req), req);
    }

    #[test]
    fn envelope_roundtrip_carries_version() {
        let env = Envelope::new(
            7,
            1_700_000_000_000,
            ServerPayload::TextDelta {
                run_id: "r1".into(),
                text: "yo".into(),
            },
        );
        let back = roundtrip(&env);
        assert_eq!(back.version, PROTOCOL_VERSION);
        assert_eq!(back.seq, 7);
        assert_eq!(back, env);
    }

    #[test]
    fn unknown_fields_in_client_request_are_rejected() {
        let bad = r#"{"type":"run","prompt":"x","bogus":1}"#;
        assert!(serde_json::from_str::<ClientRequest>(bad).is_err());
    }

    #[test]
    fn unknown_request_type_is_rejected() {
        let bad = r#"{"type":"exfiltrate_secrets"}"#;
        assert!(serde_json::from_str::<ClientRequest>(bad).is_err());
    }

    #[test]
    fn v2_terminal_requests_roundtrip() {
        let req = ClientRequest::OpenTerminal {
            agent: "claude-code".into(),
            label: Some("main".into()),
            department: None,
            lead: false,
        };
        let json = serde_json::to_string(&req).unwrap();
        assert!(json.contains("\"type\":\"open_terminal\""), "{json}");
        assert!(!json.contains("department"));
        assert_eq!(roundtrip(&req), req);

        let inp = ClientRequest::TerminalInput {
            session_id: "1".into(),
            bytes: "ls\r".into(),
        };
        assert_eq!(roundtrip(&inp), inp);
    }

    /// What a browser sends when the operator edits a hosted CLI prompt: the
    /// keys arrive as a JSON string, so control characters (Backspace is
    /// 0x7f) and multibyte text must survive the frame byte-for-byte. If a
    /// delete byte were mangled on the way through, the CLI would never see
    /// it and the line would look undeletable.
    #[test]
    fn terminal_input_frames_preserve_control_bytes_and_unicode() {
        let cases = [
            ("backspace", "\u{7f}"),
            ("three backspaces", "\u{7f}\u{7f}\u{7f}"),
            ("tab and ctrl-c", "\t\u{3}"),
            ("turkish", "görev: README düzelt şıüğüçö"),
            ("mixed edit burst", "yuppy\u{7f}\u{7f}code\r"),
        ];
        for (label, bytes) in cases {
            let req = ClientRequest::TerminalInput {
                session_id: "7".into(),
                bytes: (*bytes).into(),
            };
            let json = serde_json::to_string(&req).unwrap();
            let back: ClientRequest = serde_json::from_str(&json).unwrap();
            assert_eq!(back, req, "{label} must survive the frame");
            let ClientRequest::TerminalInput {
                bytes: round_tripped,
                ..
            } = back
            else {
                panic!("wrong variant");
            };
            assert_eq!(
                round_tripped.as_bytes(),
                (*bytes).as_bytes(),
                "{label} must arrive as the same bytes the PTY expects"
            );
        }
        // And the DEL really is the single byte a terminal sends for Backspace.
        let req = ClientRequest::TerminalInput {
            session_id: "7".into(),
            bytes: "\u{7f}".into(),
        };
        let ClientRequest::TerminalInput { bytes, .. } = req else {
            unreachable!()
        };
        assert_eq!(bytes.as_bytes(), &[0x7f]);
    }

    #[test]
    fn v2_server_payloads_roundtrip() {
        let p = ServerPayload::TerminalScreen {
            session_id: "s1".into(),
            rows: 2,
            cols: 2,
            cursor: (0, 1),
            cursor_visible: true,
            generation: 42,
            cells: vec![
                TerminalCellDto {
                    ch: "x".into(),
                    fg: CellColorDto::Rgb { r: 1, g: 2, b: 3 },
                    bg: CellColorDto::Default,
                    bold: false,
                    italic: false,
                    underline: false,
                    inverse: false,
                    wide: false,
                },
                TerminalCellDto {
                    ch: "".into(),
                    fg: CellColorDto::Idx { i: 4 },
                    bg: CellColorDto::Default,
                    bold: false,
                    italic: false,
                    underline: false,
                    inverse: false,
                    wide: false,
                },
            ],
        };
        assert_eq!(roundtrip(&p), p);
        let env = Envelope::new(1, 2, p);
        assert_eq!(env.version, PROTOCOL_VERSION);
        assert_eq!(roundtrip(&env), env);
    }

    #[test]
    fn v2_layout_and_task_roundtrip_and_snake_case() {
        let req = ClientRequest::LayoutSave {
            name: "work".into(),
            layout: LayoutDto {
                panels: vec![PanelDto {
                    id: "terminal".into(),
                    kind: "terminal_workspace".into(),
                    title: "Terminal".into(),
                    zone: "center".into(),
                    order: 0,
                    visible: true,
                    collapsed: false,
                    maximized: true,
                    z: 0,
                    department: None,
                }],
                focused: Some("terminal".into()),
                active_department: Some("research".into()),
                floating: vec![FloatingPanelDto {
                    id: "departments".into(),
                    x: -2.0,
                    y: 1.0,
                    z: 1.5,
                    scale: 1.0,
                    width: 310.0,
                    height: 330.0,
                    visible: true,
                    pinned: false,
                    minimized: false,
                    z_order: 1,
                }],
            },
        };
        let json = serde_json::to_string(&req).unwrap();
        assert!(json.contains("\"type\":\"layout_save\""));
        assert!(json.contains("\"zone\":\"center\""));
        assert_eq!(roundtrip(&req), req);

        let st = ServerPayload::TaskState {
            task_id: "t1".into(),
            state: TaskStateDto::AwaitingApproval,
            detail: None,
            cli: None,
            title: None,
        };
        let json = serde_json::to_string(&st).unwrap();
        assert!(json.contains("\"state\":\"awaiting_approval\""), "{json}");
        assert_eq!(roundtrip(&st), st);
    }

    #[test]
    fn v1_payload_shapes_unchanged_in_v2() {
        // Backward-compat guard: the v1 core messages must serialize
        // byte-identically to v1 (v1 clients keep parsing what they knew).
        let p = ServerPayload::TextDelta {
            run_id: "r1".into(),
            text: "hi".into(),
        };
        assert_eq!(
            serde_json::to_string(&p).unwrap(),
            "{\"type\":\"text_delta\",\"run_id\":\"r1\",\"text\":\"hi\"}"
        );
        let req = ClientRequest::Approval {
            call_id: "c1".into(),
            approved: true,
        };
        assert_eq!(
            serde_json::to_string(&req).unwrap(),
            "{\"type\":\"approval\",\"call_id\":\"c1\",\"approved\":true}"
        );
    }

    #[test]
    fn lead_flag_on_open_terminal_is_optional_and_exact() {
        // A v2 client that never heard of the lead seat still parses.
        let old: ClientRequest =
            serde_json::from_str(r#"{"type":"open_terminal","agent":"codex"}"#).unwrap();
        assert_eq!(
            old,
            ClientRequest::OpenTerminal {
                agent: "codex".into(),
                label: None,
                department: None,
                lead: false,
            }
        );
        // Exactly what the UI sends for the conductor seat.
        let lead: ClientRequest = serde_json::from_str(
            r#"{"type":"open_terminal","agent":"claude-code","label":"Lead","lead":true}"#,
        )
        .unwrap();
        assert!(matches!(
            lead,
            ClientRequest::OpenTerminal { lead: true, .. }
        ));
        assert_eq!(roundtrip(&lead), lead);
    }

    #[test]
    fn terminal_opened_carries_lead_and_tolerates_its_absence() {
        let p = ServerPayload::TerminalOpened {
            session_id: "3".into(),
            agent: "claude-code".into(),
            label: "Lead".into(),
            lead: true,
        };
        assert_eq!(
            serde_json::to_string(&p).unwrap(),
            r#"{"type":"terminal_opened","session_id":"3","agent":"claude-code","label":"Lead","lead":true}"#
        );
        let old: ServerPayload = serde_json::from_str(
            r#"{"type":"terminal_opened","session_id":"1","agent":"codex","label":"Codex"}"#,
        )
        .unwrap();
        assert!(matches!(
            old,
            ServerPayload::TerminalOpened { lead: false, .. }
        ));
    }

    #[test]
    fn tasks_dispatched_roundtrip() {
        let p = ServerPayload::TasksDispatched {
            tasks: vec![TaskSpecDto {
                id: "lead-1".into(),
                title: "fix".into(),
                prompt: "fix it".into(),
                cli: "codex".into(),
                model: None,
                department: None,
                role: Some("backend".into()),
                isolation: "worktree".into(),
                timeout_secs: None,
            }],
            lead: true,
        };
        let json = serde_json::to_string(&p).unwrap();
        assert!(
            json.starts_with(r#"{"type":"tasks_dispatched","tasks":[{"#),
            "{json}"
        );
        assert!(json.ends_with(r#""lead":true}"#), "{json}");
        assert_eq!(roundtrip(&p), p);
    }

    #[test]
    fn task_state_cli_and_title_are_optional() {
        let old: ServerPayload =
            serde_json::from_str(r#"{"type":"task_state","task_id":"t","state":"running"}"#)
                .unwrap();
        assert!(matches!(
            old,
            ServerPayload::TaskState {
                cli: None,
                title: None,
                ..
            }
        ));
        let p = ServerPayload::TaskState {
            task_id: "lead-1".into(),
            state: TaskStateDto::Queued,
            detail: None,
            cli: Some("codex".into()),
            title: Some("write tests".into()),
        };
        assert_eq!(
            serde_json::to_string(&p).unwrap(),
            r#"{"type":"task_state","task_id":"lead-1","state":"queued","cli":"codex","title":"write tests"}"#
        );
        assert_eq!(roundtrip(&p), p);
    }

    #[test]
    fn task_report_roundtrip() {
        let p = ServerPayload::TaskReport {
            task_id: "lead-1".into(),
            success: true,
            exit_code: Some(0),
            duration_ms: 1200,
            output_tail: "done".into(),
        };
        let json = serde_json::to_string(&p).unwrap();
        assert!(json.contains(r#""type":"task_report""#), "{json}");
        assert_eq!(roundtrip(&p), p);
    }

    #[test]
    fn telemetry_serializes_floats_and_options() {
        let t = TelemetrySnapshot {
            prompt_tokens_est: 10,
            completion_tokens_est: 5,
            tokens_per_sec: 12.5,
            time_to_first_token_ms: None,
            active_tool_calls: 0,
            rss_kib: Some(21_000),
        };
        assert_eq!(roundtrip(&t), t);
    }
}
