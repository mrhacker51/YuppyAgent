//! Dispatch incoming `ClientRequest` messages to real Rust services.

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use yuppycode_agents::{AgentKind, TeamLink};
use yuppycode_hud::Department;
use yuppycode_orchestrator as orc;
use yuppycode_protocol::{
    ClientRequest, DepartmentDto, LayoutDto, ServerPayload, TaskSpecDto, TaskStateDto,
};
use yuppycode_terminal::TerminalSize;

use super::error::BridgeError;
use super::state::BridgeState;

/// Who is on the other end of a bridge connection.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ClientRole {
    /// The operator's UI (desktop/web/TUI), authorized by the printed token.
    Operator,
    /// The lead seat's conductor MCP child, authorized by the private
    /// conductor token. Restricted to task submit/cancel (see server.rs).
    Conductor,
}

/// Handle one client request and return the server payloads to send back.
#[cfg_attr(not(test), allow(dead_code))] // operator-only entry point kept for tests
pub async fn handle_request(
    state: &BridgeState,
    req: ClientRequest,
) -> Result<Vec<ServerPayload>, BridgeError> {
    handle_request_from(state, req, ClientRole::Operator).await
}

/// [`handle_request`] for a connection of a known role. The role only
/// changes how a submitted batch is labelled (`tasks_dispatched.lead`);
/// what a role may send at all is enforced by the connection loop.
pub async fn handle_request_from(
    state: &BridgeState,
    req: ClientRequest,
    role: ClientRole,
) -> Result<Vec<ServerPayload>, BridgeError> {
    match req {
        ClientRequest::Ping => Ok(vec![ServerPayload::Pong]),

        ClientRequest::OpenTerminal {
            agent,
            label,
            department,
            lead,
        } => {
            handle_open_terminal(state, &agent, label.as_deref(), department.as_deref(), lead).await
        }

        ClientRequest::TerminalInput { session_id, bytes } => {
            handle_terminal_input(state, &session_id, &bytes).await
        }
        ClientRequest::TerminalResize {
            session_id,
            rows,
            cols,
        } => handle_terminal_resize(state, &session_id, rows, cols).await,
        ClientRequest::TerminalInterrupt { session_id } => {
            handle_terminal_interrupt(state, &session_id).await
        }
        ClientRequest::TerminalClose { session_id } => {
            handle_terminal_close(state, &session_id).await
        }

        ClientRequest::DepartmentUpsert { department } => {
            handle_department_upsert(state, department).await
        }
        ClientRequest::DepartmentRemove { id } => handle_department_remove(state, &id).await,

        ClientRequest::LayoutSave { name, layout } => {
            handle_layout_save(state, &name, layout).await
        }
        ClientRequest::LayoutLoad { name } => handle_layout_load(state, &name).await,

        ClientRequest::TaskSubmit { tasks } => {
            handle_task_submit(state, tasks, role == ClientRole::Conductor).await
        }
        ClientRequest::TaskCancel { task_id } => handle_task_cancel(state, &task_id).await,

        // Engine run/approval/model messages are not supported in the bridge
        // frontend yet; they remain TUI-only for now.
        other => Ok(vec![ServerPayload::Error {
            code: "unsupported".into(),
            message: format!("unsupported request type: {other:?}"),
        }]),
    }
}

async fn handle_open_terminal(
    state: &BridgeState,
    agent: &str,
    label: Option<&str>,
    _department: Option<&str>,
    lead: bool,
) -> Result<Vec<ServerPayload>, BridgeError> {
    let kind = parse_agent_kind(agent)
        .ok_or_else(|| BridgeError::InvalidMessage(format!("unknown agent id: {agent}")))?;

    // The lead seat is a real Claude Code session that additionally carries
    // the conductor tools and a brief describing the live team.
    let extra_args = if lead {
        if kind != AgentKind::ClaudeCode {
            return Ok(vec![ServerPayload::Error {
                code: "lead_requires_claude".into(),
                message: format!(
                    "the lead seat must be claude-code (it takes --mcp-config and \
                     --append-system-prompt); got {agent:?}"
                ),
            }]);
        }
        match lead_cli_args(state).await {
            Ok(args) => args,
            Err(e) => {
                return Ok(vec![ServerPayload::Error {
                    code: "lead_unavailable".into(),
                    message: e,
                }]);
            }
        }
    } else {
        Vec::new()
    };

    let mut mgr = state.terminals.lock().await;
    match mgr.open_with_args(kind, &state.terminal_wake_tx, extra_args) {
        Ok(display_name) => {
            let session_id = mgr
                .active_session()
                .map(|s| s.id().0.to_string())
                .unwrap_or_default();
            if lead {
                eprintln!("bridge: lead seat opened (session {session_id}) with conductor tools");
            }
            Ok(vec![ServerPayload::TerminalOpened {
                session_id,
                agent: agent.to_string(),
                label: label.unwrap_or(&display_name).to_string(),
                lead,
            }])
        }
        Err(e) => Ok(vec![ServerPayload::Error {
            code: "terminal_spawn_failed".into(),
            message: format!("{kind:?} session failed: {e}"),
        }]),
    }
}

/// Arguments that turn a Claude Code seat into the team lead.
///
/// Order matters: `--mcp-config` (variadic) is terminated by the next flag,
/// and `--allowed-tools` (also a list) must come last. The grant covers the
/// conductor server's own tools only — file and shell permissions keep
/// their native interactive prompts.
async fn lead_cli_args(state: &BridgeState) -> Result<Vec<String>, String> {
    let endpoint = state
        .conductor
        .get()
        .ok_or("the bridge has no conductor endpoint (not started by `yuppy bridge`)")?;
    let config = endpoint
        .write_mcp_config()
        .map_err(|e| format!("could not write the conductor MCP config: {e}"))?;
    let brief = crate::conductor::lead_brief(
        &state.departments_dto().await,
        &state.agent_inventory(),
        &state.workspace,
        state.engine_info().git_branch.as_deref(),
    );
    Ok(vec![
        "--mcp-config".into(),
        config.display().to_string(),
        "--append-system-prompt".into(),
        brief,
        "--allowed-tools".into(),
        crate::conductor::CONDUCTOR_TOOL_SCOPE.into(),
    ])
}

async fn handle_terminal_input(
    state: &BridgeState,
    session_id: &str,
    bytes: &str,
) -> Result<Vec<ServerPayload>, BridgeError> {
    let id = session_id
        .parse::<u64>()
        .map_err(|_| BridgeError::InvalidMessage(format!("invalid session_id: {session_id}")))?;
    let mgr = state.terminals.lock().await;
    let session = mgr
        .iter()
        .find(|m| m.session.id().0 == id)
        .map(|m| &m.session)
        .ok_or_else(|| BridgeError::InvalidMessage(format!("no session {session_id}")))?;
    session
        .send_bytes(bytes.as_bytes())
        .map_err(|e| BridgeError::Service(format!("terminal input failed: {e}")))?;
    Ok(vec![])
}

async fn handle_terminal_resize(
    state: &BridgeState,
    session_id: &str,
    rows: u16,
    cols: u16,
) -> Result<Vec<ServerPayload>, BridgeError> {
    let id = session_id
        .parse::<u64>()
        .map_err(|_| BridgeError::InvalidMessage(format!("invalid session_id: {session_id}")))?;
    let mut mgr = state.terminals.lock().await;
    mgr.note_pane_size(TerminalSize { rows, cols });
    let session = mgr
        .iter()
        .find(|m| m.session.id().0 == id)
        .map(|m| &m.session)
        .ok_or_else(|| BridgeError::InvalidMessage(format!("no session {session_id}")))?;
    session
        .resize(TerminalSize { rows, cols })
        .map_err(|e| BridgeError::Service(format!("terminal resize failed: {e}")))?;
    Ok(vec![])
}

async fn handle_terminal_interrupt(
    state: &BridgeState,
    session_id: &str,
) -> Result<Vec<ServerPayload>, BridgeError> {
    let id = session_id
        .parse::<u64>()
        .map_err(|_| BridgeError::InvalidMessage(format!("invalid session_id: {session_id}")))?;
    let mgr = state.terminals.lock().await;
    let session = mgr
        .iter()
        .find(|m| m.session.id().0 == id)
        .map(|m| &m.session)
        .ok_or_else(|| BridgeError::InvalidMessage(format!("no session {session_id}")))?;
    session
        .send_interrupt()
        .map_err(|e| BridgeError::Service(format!("terminal interrupt failed: {e}")))?;
    Ok(vec![])
}

async fn handle_terminal_close(
    state: &BridgeState,
    session_id: &str,
) -> Result<Vec<ServerPayload>, BridgeError> {
    let id = session_id
        .parse::<u64>()
        .map_err(|_| BridgeError::InvalidMessage(format!("invalid session_id: {session_id}")))?;
    let mut mgr = state.terminals.lock().await;
    // Never fall back to the active session: closing an unknown id must not
    // terminate an unrelated terminal.
    let Some(idx) = mgr.iter().position(|m| m.session.id().0 == id) else {
        return Ok(vec![ServerPayload::Error {
            code: "no_session".into(),
            message: format!("no session to close: {session_id}"),
        }]);
    };
    mgr.active = idx;
    let closed = mgr.close_active_with_exit();
    let payload = closed.map_or_else(
        || ServerPayload::Error {
            code: "no_session".into(),
            message: format!("no session to close: {session_id}"),
        },
        |(_kind, exit)| ServerPayload::TerminalClosed {
            session_id: session_id.to_string(),
            exit_code: exit.as_ref().and_then(|e| e.exit_code),
            signal: exit
                .as_ref()
                .and_then(|e| e.signal.clone())
                .or_else(|| Some("closed".to_string())),
        },
    );
    Ok(vec![payload])
}

async fn handle_department_upsert(
    state: &BridgeState,
    dto: DepartmentDto,
) -> Result<Vec<ServerPayload>, BridgeError> {
    let dept = dto_to_department(dto);
    let mut reg = state.departments.lock().await;
    let id = dept.id.clone();
    if let Some(existing) = reg.departments.iter_mut().find(|d| d.id == id) {
        *existing = dept;
    } else {
        reg.departments.push(dept);
    }
    let save_result = tokio::task::spawn_blocking({
        let hud = state.hud.clone();
        let reg = reg.clone();
        move || hud.save_departments(&reg)
    })
    .await
    .map_err(|e| BridgeError::Service(format!("save task panicked: {e}")))?;
    let error = save_result.err().map(|e| e.to_string());
    Ok(vec![ServerPayload::DepartmentUpserted {
        id,
        ok: error.is_none(),
        error,
    }])
}

async fn handle_department_remove(
    state: &BridgeState,
    id: &str,
) -> Result<Vec<ServerPayload>, BridgeError> {
    let mut reg = state.departments.lock().await;
    reg.departments.retain(|d| d.id != id);
    let save_result = tokio::task::spawn_blocking({
        let hud = state.hud.clone();
        let reg = reg.clone();
        move || hud.save_departments(&reg)
    })
    .await
    .map_err(|e| BridgeError::Service(format!("save task panicked: {e}")))?;
    let error = save_result.err().map(|e| e.to_string());
    Ok(vec![ServerPayload::DepartmentUpserted {
        id: id.to_string(),
        ok: error.is_none(),
        error,
    }])
}

async fn handle_layout_save(
    state: &BridgeState,
    name: &str,
    dto: LayoutDto,
) -> Result<Vec<ServerPayload>, BridgeError> {
    let layout = dto_to_layout(dto);
    let problems = layout.validate();
    if !problems.is_empty() {
        return Err(BridgeError::InvalidMessage(format!(
            "invalid layout: {}",
            problems.join("; ")
        )));
    }
    let save_result = tokio::task::spawn_blocking({
        let hud = state.hud.clone();
        let layout = layout.clone();
        let name = name.to_string();
        move || {
            // Persist both the named copy and the current layout that is
            // replayed to every new client after the handshake.
            hud.save_named_layout(&name, &layout)?;
            hud.save_layout(&layout)
        }
    })
    .await
    .map_err(|e| BridgeError::Service(format!("save task panicked: {e}")))?;
    save_result.map_err(|e| BridgeError::Service(format!("layout save failed: {e}")))?;
    *state.layout.lock().await = layout.clone();
    Ok(vec![ServerPayload::LayoutApplied {
        name: name.to_string(),
        layout: dto::layout(&layout),
    }])
}

async fn handle_layout_load(
    state: &BridgeState,
    name: &str,
) -> Result<Vec<ServerPayload>, BridgeError> {
    let loaded = tokio::task::spawn_blocking({
        let hud = state.hud.clone();
        let name = name.to_string();
        move || hud.load_named_layout(&name)
    })
    .await
    .map_err(|e| BridgeError::Service(format!("load task panicked: {e}")))?
    .map_err(|e| BridgeError::Service(format!("layout load failed: {e}")))?;
    {
        let hud = state.hud.clone();
        let loaded_for_save = loaded.clone();
        let save_result = tokio::task::spawn_blocking(move || hud.save_layout(&loaded_for_save))
            .await
            .map_err(|e| BridgeError::Service(format!("save task panicked: {e}")))?;
        save_result.map_err(|e| BridgeError::Service(format!("layout save failed: {e}")))?;
    }
    *state.layout.lock().await = loaded.clone();
    Ok(vec![ServerPayload::LayoutApplied {
        name: name.to_string(),
        layout: dto::layout(&loaded),
    }])
}

fn task_state_dto(state: orc::TaskState) -> TaskStateDto {
    match state {
        orc::TaskState::Queued => TaskStateDto::Queued,
        orc::TaskState::Running => TaskStateDto::Running,
        orc::TaskState::AwaitingApproval => TaskStateDto::AwaitingApproval,
        orc::TaskState::Completed => TaskStateDto::Completed,
        orc::TaskState::Failed => TaskStateDto::Failed,
        orc::TaskState::Cancelled => TaskStateDto::Cancelled,
    }
}

/// Bus-safe, addressable name: lowercase ASCII alphanumerics, `-`, `_`.
fn team_bus_name(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    for ch in raw.chars() {
        let c = ch.to_ascii_lowercase();
        if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
            out.push(c);
        } else if !out.ends_with('-') {
            out.push('-');
        }
    }
    out.trim_matches('-').chars().take(24).collect()
}

/// One name per task, unique inside the batch. Roles win because that is how
/// teammates address each other ("backend", "review"); duplicate or empty
/// roles fall back to numbered names.
fn team_member_names(roles: &[String]) -> Vec<String> {
    let mut used = HashSet::new();
    roles
        .iter()
        .enumerate()
        .map(|(i, role)| {
            // The lead/worker contract rides in the role text (the brief
            // prints it), but the address must stay short: `lead`, `worker2`.
            let first = role.split_whitespace().next().unwrap_or("");
            let base = if first.eq_ignore_ascii_case("lead") {
                "lead".to_string()
            } else if first.eq_ignore_ascii_case("worker") {
                // The ordinal already lives in the role token (`worker2`).
                first.to_ascii_lowercase()
            } else {
                team_bus_name(role)
            };
            let base = if base.is_empty() {
                format!("t{}", i + 1)
            } else {
                base
            };
            let mut name = base.clone();
            let mut n = 2;
            while used.contains(&name) {
                name = format!("{base}{n}");
                n += 1;
            }
            used.insert(name.clone());
            name
        })
        .collect()
}

/// Turn the submitted roles into bus roles that make the team legible.
///
/// The desktop's quick dispatch labels its slices `primary`/`parallel`, which
/// says nothing about how the team should behave. The first slice of any
/// multi-agent batch is therefore the **lead**: it asks the others for status,
/// owns the integration summary and answers the operator. Everything it needs
/// is in the brief, which prints `You are <name> (<role>)` — so the role text
/// is where the lead contract is stated, with no extra protocol.
fn team_roles(roles: &[String]) -> Vec<String> {
    let mut workers = 0usize;
    roles
        .iter()
        .enumerate()
        .map(|(i, raw)| {
            let role = raw.trim();
            let generic = role.is_empty()
                || role.eq_ignore_ascii_case("primary")
                || role.eq_ignore_ascii_case("parallel")
                || role.eq_ignore_ascii_case("general");
            if !generic {
                return role.to_string();
            }
            if i == 0 {
                "lead — coordinate the team, ask teammates for status, integrate their reports"
                    .to_string()
            } else {
                workers += 1;
                format!("worker{workers} — own your slice, report to the lead")
            }
        })
        .collect()
}

/// Bus roles for a batch dispatched by the lead seat: everyone is a worker
/// (department roles are kept as written), and the lead is the conductor.
fn lead_worker_roles(roles: &[String]) -> Vec<String> {
    let mut workers = 0usize;
    roles
        .iter()
        .map(|raw| {
            let role = raw.trim();
            let generic = role.is_empty()
                || role.eq_ignore_ascii_case("primary")
                || role.eq_ignore_ascii_case("parallel")
                || role.eq_ignore_ascii_case("general")
                || role.eq_ignore_ascii_case("lead");
            if generic {
                workers += 1;
                format!(
                    "worker{workers} — own your slice; the team lead reads your final output, \
                     so end with a clear report"
                )
            } else {
                role.to_string()
            }
        })
        .collect()
}

static TEAM_BUS_SEQ: AtomicU64 = AtomicU64::new(0);

/// Poll the batch's bus and forward every new message to the client.
///
/// The UI can only show a team working together if it sees what the team
/// actually said. Messages are read from the same SQLite file the agents
/// wrote, in id order, once each — nothing is synthesised, and a quiet team
/// emits nothing. Runs on its own thread because the bus API is blocking;
/// `stop` is raised by the batch before the throwaway directory is removed.
fn spawn_team_transcript_pump(
    bus_path: PathBuf,
    batch: String,
    tx: tokio::sync::broadcast::Sender<ServerPayload>,
    stop: Arc<std::sync::atomic::AtomicBool>,
) {
    std::thread::spawn(move || {
        use std::sync::atomic::Ordering;
        let bus = match yuppycode_bus::Bus::open(&bus_path) {
            Ok(b) => b,
            Err(e) => {
                eprintln!(
                    "bridge: team transcript unavailable ({}): {e}",
                    bus_path.display()
                );
                return;
            }
        };
        let mut last_id = 0i64;
        while !stop.load(Ordering::Relaxed) {
            match bus.history(None, 100) {
                Ok(mut messages) => {
                    messages.reverse(); // history is newest-first
                    for m in messages {
                        if m.id <= last_id {
                            continue;
                        }
                        last_id = m.id;
                        let _ = tx.send(ServerPayload::TeamMessage {
                            batch: batch.clone(),
                            sender: m.sender,
                            recipient: m.recipient,
                            body: m.body,
                            ts_ms: m.ts.max(0) as u64,
                            id: m.id,
                        });
                    }
                }
                Err(e) => {
                    // A closed/removed bus is the normal end of a batch; any
                    // other failure is worth one line, not a spin of them.
                    if stop.load(Ordering::Relaxed) {
                        break;
                    }
                    eprintln!("bridge: team transcript read failed: {e}");
                    std::thread::sleep(std::time::Duration::from_millis(500));
                    continue;
                }
            }
            std::thread::sleep(std::time::Duration::from_millis(250));
        }
    });
}

/// Throwaway directory holding one batch's team bus.
///
/// A private directory (0700) is used instead of a predictable file in the
/// shared temp dir: the bus carries everything the agents say to each other,
/// and another local user must not be able to pre-create or symlink it.
struct TeamBusDir {
    dir: PathBuf,
}

impl TeamBusDir {
    fn new(batch: &str) -> std::io::Result<Self> {
        let slug = {
            let s = team_bus_name(batch);
            if s.is_empty() { "batch".to_string() } else { s }
        };
        let base = std::env::temp_dir();
        for _ in 0..64 {
            let n = TEAM_BUS_SEQ.fetch_add(1, Ordering::Relaxed);
            let dir = base.join(format!("yuppy-team-{slug}-{}-{n}", std::process::id()));
            match std::fs::create_dir(&dir) {
                Ok(()) => {
                    #[cfg(unix)]
                    {
                        use std::os::unix::fs::PermissionsExt;
                        let _ =
                            std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700));
                    }
                    return Ok(Self { dir });
                }
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(e) => return Err(e),
            }
        }
        Err(std::io::Error::other(
            "could not allocate a unique team bus directory",
        ))
    }

    fn bus_path(&self) -> PathBuf {
        self.dir.join("team.sqlite3")
    }
}

impl Drop for TeamBusDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

async fn handle_task_submit(
    state: &BridgeState,
    specs: Vec<TaskSpecDto>,
    from_lead: bool,
) -> Result<Vec<ServerPayload>, BridgeError> {
    if specs.is_empty() {
        return Err(BridgeError::InvalidMessage("no tasks submitted".into()));
    }

    // Only real, detected CLIs may be scheduled. Never fabricate an agent.
    let programs: HashMap<String, PathBuf> = yuppycode_agents::detect_all()
        .into_iter()
        .filter_map(|status| status.path.map(|p| (status.kind.id().to_string(), p)))
        .collect();
    let departments = state.departments.lock().await.clone();
    let mut seen = HashSet::new();
    let mut tasks = Vec::with_capacity(specs.len());
    let mut roles: Vec<String> = Vec::with_capacity(specs.len());
    let mut cancels = Vec::new();

    let accepted_specs = specs.clone();
    for spec in specs {
        let id = spec.id.trim().to_string();
        if id.is_empty() {
            return Err(BridgeError::InvalidMessage(
                "task id must not be empty".into(),
            ));
        }
        if !seen.insert(id.clone()) {
            return Err(BridgeError::InvalidMessage(format!(
                "duplicate task id {id:?} in one batch"
            )));
        }
        if spec.prompt.trim().is_empty() {
            return Err(BridgeError::InvalidMessage(format!(
                "task {id:?} has an empty prompt"
            )));
        }
        if !programs.contains_key(&spec.cli) {
            return Err(BridgeError::InvalidMessage(format!(
                "task {id:?} requests {:?}, which is not installed/detected",
                spec.cli
            )));
        }
        let department = spec.department.clone();
        if let Some(dept_id) = &department {
            let Some(dept) = departments.get(dept_id) else {
                return Err(BridgeError::InvalidMessage(format!(
                    "task {id:?} references unknown department {dept_id:?}"
                )));
            };
            if !dept.enabled {
                return Err(BridgeError::InvalidMessage(format!(
                    "department {dept_id:?} is disabled"
                )));
            }
        }
        let workspace = department
            .as_ref()
            .and_then(|d| departments.get(d))
            .and_then(|d| d.workspace.as_ref())
            .map(PathBuf::from)
            .unwrap_or_else(|| state.workspace.clone());
        let isolation = if spec.isolation == "worktree" {
            orc::Isolation::GitWorktree {
                repo: workspace.clone(),
            }
        } else {
            orc::Isolation::Shared { workspace }
        };
        let title = match &spec.role {
            Some(role) if !role.trim().is_empty() => format!("{} · {}", spec.title, role),
            _ => spec.title.clone(),
        };
        roles.push(spec.role.clone().unwrap_or_default());
        let cancel = orc::CancelFlag::new();
        cancels.push((id.clone(), cancel));
        tasks.push(orc::Task {
            id,
            title,
            prompt: spec.prompt,
            cli: spec.cli,
            model: spec.model,
            department,
            isolation,
            timeout_secs: spec.timeout_secs.unwrap_or(900).max(1),
            team: None,
            // No per-department permission mode is carried over the
            // protocol yet: the CLI keeps its own default.
            permission_mode: None,
        });
    }

    // Two or more agents in one batch is a team: they already run in
    // parallel, but without a bus every one of them guesses what the others
    // own. Name them, join them to one throwaway bus, and attach a TeamLink
    // so the runner injects the coordination brief and MCP server wiring.
    let mut team_transcript: Option<(PathBuf, String)> = None;
    let team_bus = if tasks.len() >= 2 {
        let bus_dir = TeamBusDir::new(&tasks[0].id)
            .map_err(|e| BridgeError::Service(format!("team bus directory: {e}")))?;
        let bus_path = bus_dir.bus_path();
        // Generic desktop labels become a real lead/worker contract; a
        // department role (backend, reviewer…) is kept as written.
        // A batch the lead seat dispatched already has its lead: the
        // conductor reads every worker's output. Naming one of the workers
        // "lead" too would give the team two leads.
        let bus_roles = if from_lead {
            lead_worker_roles(&roles)
        } else {
            team_roles(&roles)
        };
        let names = team_member_names(&bus_roles);
        let server = std::env::current_exe().unwrap_or_else(|_| PathBuf::from("yuppy"));
        let bus = yuppycode_bus::Bus::open(&bus_path)
            .map_err(|e| BridgeError::Service(format!("team bus: {e}")))?;
        for (i, task) in tasks.iter_mut().enumerate() {
            let peers: Vec<String> = names
                .iter()
                .enumerate()
                .filter(|(j, _)| *j != i)
                .map(|(_, n)| n.clone())
                .collect();
            let link = TeamLink {
                server_program: server.clone(),
                bus: bus_path.clone(),
                name: names[i].clone(),
                role: bus_roles[i].clone(),
                task_id: task.id.clone(),
                engine: task.cli.clone(),
                auto_allow_bus: true,
                teammates: peers,
            };
            // Every member is addressable before anyone starts, so the first
            // agent to call yuppy_team sees the full roster.
            let _ = bus.join(yuppycode_bus::JoinRequest {
                name: link.name.clone(),
                role: link.role.clone(),
                engine: link.engine.clone(),
                task_id: link.task_id.clone(),
            });
            task.team = Some(link);
        }
        drop(bus);
        eprintln!(
            "bridge: team batch · bus {} · members: {}",
            bus_path.display(),
            names.join(", ")
        );
        team_transcript = Some((bus_path, tasks[0].id.clone()));
        Some(bus_dir)
    } else {
        None
    };

    // Reject ids that are already owned by a live batch; never silently
    // overwrite another cancellation handle.
    {
        let mut live = state
            .task_cancels
            .lock()
            .map_err(|_| BridgeError::Service("task cancel map poisoned".into()))?;
        if let Some((id, _)) = cancels.iter().find(|(id, _)| live.contains_key(id)) {
            return Err(BridgeError::InvalidMessage(format!(
                "task id {id:?} is already running"
            )));
        }
        for (id, cancel) in &cancels {
            live.insert(id.clone(), cancel.clone());
        }
    }

    let ids: Vec<String> = tasks.iter().map(|t| t.id.clone()).collect();
    let limits = orc::Limits {
        // The department registry caps a single department at 8
        // (MAX_DEPT_CONCURRENCY); the bridge should not be the tighter gate
        // when the operator dispatched a wider batch.
        max_parallel: tasks.len().clamp(1, 8),
        // The department's bound still applies: it is the documented way to
        // size a team (`yuppy dept conc <id> <n>`), and the global bound is
        // only the ceiling on top of it. A department whose default equals its
        // role-team size is not a reason to widen the batch — missions fan out
        // to at most that many role slices anyway.
        per_department: orc::dept_limits(&tasks, |d| departments.get(d).map(|x| x.max_concurrency)),
    };
    // id -> (cli, title), so every state event can name its task for a
    // client that did not submit it.
    let labels: Arc<HashMap<String, (String, String)>> = Arc::new(
        tasks
            .iter()
            .map(|t| (t.id.clone(), (t.cli.clone(), t.title.clone())))
            .collect(),
    );
    let label = {
        let labels = Arc::clone(&labels);
        move |id: &str| -> (Option<String>, Option<String>) {
            match labels.get(id) {
                Some((cli, title)) => (Some(cli.clone()), Some(title.clone())),
                None => (None, None),
            }
        }
    };
    let queued: Vec<ServerPayload> = ids
        .iter()
        .map(|id| {
            let (cli, title) = label(id);
            ServerPayload::TaskState {
                task_id: id.clone(),
                state: TaskStateDto::Queued,
                detail: None,
                cli,
                title,
            }
        })
        .collect();

    // Every client learns about the batch — titles, CLIs, roles — not only
    // the one that sent it. This is how a batch the lead dispatched appears
    // in the operator's UI before its first state change.
    let _ = state.task_events_tx.send(ServerPayload::TasksDispatched {
        tasks: accepted_specs
            .into_iter()
            .map(|mut t| {
                t.id = t.id.trim().to_string();
                t
            })
            .collect(),
        lead: from_lead,
    });

    let runner: Arc<dyn orc::TaskRunner> = Arc::new(orc::ProcessTaskRunner::new(programs));
    let tx = state.task_events_tx.clone();
    let final_tx = state.task_events_tx.clone();
    let live_cancels = state.task_cancels.clone();
    // One pump per team batch: the operator sees the real messages the agents
    // exchange, not a rendering of guessed activity.
    let transcript_stop = Arc::new(std::sync::atomic::AtomicBool::new(false));
    if let Some((bus_path, batch)) = team_transcript {
        spawn_team_transcript_pump(
            bus_path,
            batch,
            state.task_events_tx.clone(),
            Arc::clone(&transcript_stop),
        );
    }
    let event_label = label.clone();
    let final_label = label.clone();
    let events: orc::Events = Arc::new(move |task_id: &str, st: orc::TaskState| {
        let (cli, title) = event_label(task_id);
        let _ = tx.send(ServerPayload::TaskState {
            task_id: task_id.to_string(),
            state: task_state_dto(st),
            detail: None,
            cli,
            title,
        });
    });

    tokio::spawn(async move {
        let report = orc::run_batch_with_cancels(
            tasks,
            runner,
            &limits,
            orc::CancelFlag::new(),
            live_cancels.clone(),
            events,
            true,
        )
        .await;

        // Final records carry review artifacts and failure reasons that the
        // state-only callback cannot express.
        for outcome in &report.outcomes {
            if let Some(run) = &outcome.report {
                let _ = final_tx.send(ServerPayload::TaskReport {
                    task_id: outcome.task_id.clone(),
                    success: run.success,
                    exit_code: run.exit_code,
                    duration_ms: run.duration_ms,
                    output_tail: run.output_tail.clone(),
                });
            }
            if let Some(error) = &outcome.error {
                let (cli, title) = final_label(&outcome.task_id);
                let _ = final_tx.send(ServerPayload::TaskState {
                    task_id: outcome.task_id.clone(),
                    state: task_state_dto(outcome.state),
                    detail: Some(error.clone()),
                    cli,
                    title,
                });
            }
            if let Some(integration) = &outcome.integration {
                let _ = final_tx.send(ServerPayload::TaskIntegration {
                    task_id: outcome.task_id.clone(),
                    branch: integration.branch.clone(),
                    changed_files: integration.changed_files.clone(),
                    committed: integration.committed,
                });
            }
        }
        for (a, b, path) in &report.conflicts {
            let _ = final_tx.send(ServerPayload::TaskConflict {
                task_a: a.clone(),
                task_b: b.clone(),
                path: path.clone(),
            });
        }
        for outcome in &report.outcomes {
            // Poison-safe: a panic anywhere in this task must not turn into
            // a second panic here that permanently leaks the cancel handles,
            // which would reject these task ids as "already running" forever.
            live_cancels
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .remove(&outcome.task_id);
        }
        // The bus outlives every worker but not the batch: dropping the
        // guard removes the throwaway directory and its SQLite files.
        transcript_stop.store(true, std::sync::atomic::Ordering::Relaxed);
        // Give the pump one poll interval to drain the last messages before
        // the directory disappears underneath it.
        tokio::time::sleep(std::time::Duration::from_millis(400)).await;
        drop(team_bus);
    });

    Ok(queued)
}

async fn handle_task_cancel(
    state: &BridgeState,
    task_id: &str,
) -> Result<Vec<ServerPayload>, BridgeError> {
    let cancel = state
        .task_cancels
        .lock()
        .map_err(|_| BridgeError::Service("task cancel map poisoned".into()))?
        .get(task_id)
        .cloned();
    let Some(cancel) = cancel else {
        return Err(BridgeError::InvalidMessage(format!(
            "no live task {task_id:?} to cancel"
        )));
    };
    cancel.cancel();
    Ok(vec![ServerPayload::TaskState {
        task_id: task_id.to_string(),
        state: TaskStateDto::Cancelled,
        detail: Some("cancellation requested".into()),
        cli: None,
        title: None,
    }])
}

fn parse_agent_kind(agent: &str) -> Option<AgentKind> {
    match agent.to_ascii_lowercase().as_str() {
        "claude" | "claude-code" | "claudecode" => Some(AgentKind::ClaudeCode),
        _ => None,
    }
}

fn dto_to_department(dto: DepartmentDto) -> Department {
    Department {
        id: dto.id,
        name: dto.name,
        description: dto.description,
        icon: dto.icon,
        agents: dto
            .agents
            .into_iter()
            .map(|a| yuppycode_hud::AgentAssignment {
                cli: a.cli,
                model: a.model,
            })
            .collect(),
        roles: dto
            .roles
            .into_iter()
            .map(|r| yuppycode_hud::DepartmentRole {
                id: r.id,
                name: r.name,
                description: r.description,
                cli: r.cli,
                model: r.model,
                enabled: r.enabled,
            })
            .collect(),
        workspace: dto.workspace,
        allowed_tools: dto.allowed_tools,
        permissions: yuppycode_hud::Permissions {
            require_approval: true,
        },
        max_concurrency: dto.max_concurrency.max(1),
        // A DTO department carries an explicit bound from the client.
        concurrency_explicit: true,
        enabled: dto.enabled,
        panels: dto.panels,
    }
}

fn dto_to_layout(dto: LayoutDto) -> yuppycode_hud::LayoutModel {
    yuppycode_hud::LayoutModel {
        schema_version: 1,
        panels: dto
            .panels
            .into_iter()
            .map(|p| yuppycode_hud::Panel {
                id: p.id,
                kind: serde_json::from_str(&format!("\"{}\"", p.kind))
                    .unwrap_or(yuppycode_hud::PanelKind::Custom(p.kind)),
                title: p.title,
                zone: serde_json::from_str(&format!("\"{}\"", p.zone))
                    .unwrap_or(yuppycode_hud::Zone::Center),
                order: p.order,
                visible: p.visible,
                collapsed: p.collapsed,
                maximized: p.maximized,
                z: p.z,
                department: p.department,
            })
            .collect(),
        focused: dto.focused,
        active_department: dto.active_department,
        floating: dto
            .floating
            .into_iter()
            .map(|f| yuppycode_hud::FloatingPanel {
                id: f.id,
                x: f.x,
                y: f.y,
                z: f.z,
                scale: f.scale,
                width: f.width,
                height: f.height,
                visible: f.visible,
                pinned: f.pinned,
                minimized: f.minimized,
                z_order: f.z_order,
            })
            .collect(),
    }
}

mod dto {
    use super::*;

    /// Delegates to `yuppycode-hud`, which owns this mapping. The local copy
    /// this replaced emitted serde's *encoded* variant form, so an unrecognised
    /// panel kind left as `{"custom":"name"}` and came back from
    /// `dto_to_layout` mangled.
    pub fn layout(l: &yuppycode_hud::LayoutModel) -> LayoutDto {
        yuppycode_hud::dto::layout_dto(l)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn ping_returns_pong() {
        let state = BridgeState::new(Some(std::env::current_dir().unwrap()));
        let reply = handle_request(&state, ClientRequest::Ping).await.unwrap();
        assert_eq!(reply.len(), 1);
        assert!(matches!(reply[0], ServerPayload::Pong));
    }

    #[test]
    fn team_names_are_addressable_and_unique() {
        let roles = vec![
            "backend".to_string(),
            "backend".to_string(),
            "Code Review".to_string(),
            String::new(),
        ];
        let names = team_member_names(&roles);
        assert_eq!(names, vec!["backend", "backend2", "code-review", "t4"]);
        let unique: HashSet<_> = names.iter().collect();
        assert_eq!(unique.len(), names.len(), "names must be unique: {names:?}");
        for name in &names {
            assert!(
                name.chars()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '_'),
                "not addressable on the bus: {name:?}"
            );
        }
    }

    #[test]
    fn a_lead_dispatched_batch_has_only_workers() {
        let roles = lead_worker_roles(&["".into(), "backend".into(), "lead".into()]);
        assert!(roles[0].starts_with("worker1"));
        assert_eq!(roles[1], "backend");
        assert!(roles[2].starts_with("worker2"), "{roles:?}");
        let names = team_member_names(&roles);
        assert!(!names.contains(&"lead".to_string()), "{names:?}");
    }

    #[test]
    fn generic_slices_become_a_lead_and_workers() {
        let roles = vec![
            "primary".to_string(),
            "parallel".to_string(),
            "reviewer".to_string(),
        ];
        let out = team_roles(&roles);
        assert!(out[0].starts_with("lead"), "{}", out[0]);
        assert!(out[1].starts_with("worker"), "{}", out[1]);
        assert_eq!(out[2], "reviewer", "an explicit role is never rewritten");
        // …and the lead keeps the addressable name the roster advertises.
        assert_eq!(team_member_names(&out)[0], "lead");
    }

    /// The UI can only claim the team talked if this pump delivered the exact
    /// rows the agents wrote. One bus, one message, one envelope.
    #[tokio::test]
    async fn the_transcript_pump_forwards_real_bus_messages_once() {
        let dir = TeamBusDir::new("pump").unwrap();
        let bus_path = dir.bus_path();
        let bus = yuppycode_bus::Bus::open(&bus_path).unwrap();
        for name in ["lead", "worker1"] {
            bus.join(yuppycode_bus::JoinRequest {
                name: name.into(),
                role: String::new(),
                engine: "claude-code".into(),
                task_id: name.into(),
            })
            .unwrap();
        }
        bus.send(yuppycode_bus::Outgoing {
            sender: "worker1".into(),
            to: "lead".into(),
            body: "slice done, tests red".into(),
            thread: None,
        })
        .unwrap();
        drop(bus);

        let (tx, mut rx) = tokio::sync::broadcast::channel(16);
        let stop = Arc::new(std::sync::atomic::AtomicBool::new(false));
        spawn_team_transcript_pump(bus_path, "batch-1".into(), tx, Arc::clone(&stop));

        let env = tokio::time::timeout(std::time::Duration::from_secs(5), rx.recv())
            .await
            .expect("pump delivered nothing")
            .expect("broadcast closed");
        match env {
            ServerPayload::TeamMessage {
                batch,
                sender,
                recipient,
                body,
                id,
                ..
            } => {
                assert_eq!(batch, "batch-1");
                assert_eq!(sender, "worker1");
                assert_eq!(recipient, "lead");
                assert_eq!(body, "slice done, tests red");
                assert!(id > 0);
            }
            other => panic!("unexpected payload: {other:?}"),
        }
        stop.store(true, std::sync::atomic::Ordering::Relaxed);
    }

    #[test]
    fn a_team_bus_directory_is_private_and_removed_on_drop() {
        let dir = TeamBusDir::new("mis-abc-s1").unwrap();
        let bus = dir.bus_path();
        assert_eq!(bus.file_name().unwrap(), "team.sqlite3");
        std::fs::write(&bus, b"state").unwrap();
        let parent = bus.parent().unwrap().to_path_buf();
        assert!(parent.is_dir());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&parent).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o700, "the team bus directory must be private");
        }
        drop(dir);
        assert!(!parent.exists(), "the throwaway bus directory leaked");
    }

    #[tokio::test]
    async fn department_upsert_updates_state_and_persists() {
        let tmp = tempfile::tempdir().unwrap();
        unsafe {
            std::env::set_var("YUPPY_CONFIG_DIR", tmp.path().as_os_str());
        }
        let state = BridgeState::new(Some(std::env::current_dir().unwrap()));
        state.load_defaults().await;

        let reply = handle_request(
            &state,
            ClientRequest::DepartmentUpsert {
                department: DepartmentDto {
                    id: "custom-test".into(),
                    name: "Custom Test".into(),
                    description: "test dept".into(),
                    icon: "🧪".into(),
                    agents: vec![],
                    roles: vec![],
                    workspace: None,
                    allowed_tools: vec![],
                    max_concurrency: 1,
                    enabled: true,
                    panels: vec![],
                },
            },
        )
        .await
        .unwrap();

        assert!(
            matches!(reply[0], ServerPayload::DepartmentUpserted { ref id, ok: true, .. } if id == "custom-test")
        );
        assert!(state.departments.lock().await.get("custom-test").is_some());

        // Verify persistence by reloading into a fresh state.
        let state2 = BridgeState::new(Some(std::env::current_dir().unwrap()));
        state2.load_defaults().await;
        assert!(state2.departments.lock().await.get("custom-test").is_some());
    }
}

#[cfg(test)]
mod dto_round_trip {
    use super::{dto::layout as to_dto, dto_to_layout};
    use yuppycode_hud::{LayoutModel, PanelKind};

    /// The browser is handed a layout, edits it, and sends it straight back.
    /// Whatever goes out must therefore be readable by `dto_to_layout`
    /// unchanged — and what comes back must still name the same panels, because
    /// a saved layout is written to disk and replayed to every later client.
    #[test]
    fn a_layout_survives_being_sent_out_and_coming_back() {
        let model = LayoutModel::default();
        let back = dto_to_layout(to_dto(&model));

        assert_eq!(back.panels.len(), model.panels.len(), "no panel lost");
        for (want, got) in model.panels.iter().zip(back.panels.iter()) {
            assert_eq!(
                got.kind, want.kind,
                "panel `{}` came back as {:?} instead of {:?}",
                want.id, got.kind, want.kind
            );
            assert_eq!(got.zone, want.zone, "panel `{}` moved zones", want.id);
            assert_eq!(got.title, want.title);
        }
        assert_eq!(back.focused, model.focused);
    }

    #[test]
    fn a_panel_kind_neither_crate_knows_survives_the_round_trip_by_name() {
        // `Custom` is what an unrecognised kind becomes, so it is the one case
        // where the wire form has to carry the plain name for the panel to be
        // recognisable on the way back in.
        let mut model = LayoutModel::default();
        model.panels[0].kind = PanelKind::Custom("mission_control".into());

        let dto = to_dto(&model);
        assert_eq!(
            dto.panels[0].kind, "mission_control",
            "the wire form must carry a plain name, not an encoded variant"
        );

        let back = dto_to_layout(dto);
        assert_eq!(
            back.panels[0].kind,
            PanelKind::Custom("mission_control".into()),
            "a future panel must not come back mangled into a quoted mystery kind"
        );
    }
}
