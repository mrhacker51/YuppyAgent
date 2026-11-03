//! The lead seat's conductor: a stdio MCP server that lets the operator's
//! main Claude Code session distribute work to the team.
//!
//! The bridge starts the lead seat with `--mcp-config` pointing at
//! `yuppy conductor-mcp`. This process connects *back* to the bridge as a
//! WebSocket client (URL + a private conductor token arrive in its env) and
//! turns tool calls into ordinary `task_submit` / `task_cancel` requests. The
//! bridge's own validation, scheduler, team bus and event broadcast are
//! reused unchanged, so a batch the lead dispatches is indistinguishable from
//! one the UI dispatched — except it is labelled `lead: true` — and every
//! connected client sees its `task_state` stream.
//!
//! Tools: `yuppy_dispatch`, `yuppy_tasks`, `yuppy_cancel`, `yuppy_roster`,
//! `yuppy_team_log`.

use std::collections::{BTreeMap, HashSet};
use std::io::{BufRead, Write};
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde_json::{Value, json};
use yuppycode_protocol::{
    AgentStatusDto, ClientRequest, DepartmentDto, Envelope, PROTOCOL_VERSION, ServerPayload,
    TaskSpecDto, TaskStateDto,
};

/// `--allowed-tools` scope for the lead: the conductor server's tools only.
pub const CONDUCTOR_TOOL_SCOPE: &str = "mcp__yuppy-conductor";
/// Most tasks one `yuppy_dispatch` may carry (the bridge caps a batch's
/// parallelism at 8 as well).
pub const MAX_TASKS_PER_DISPATCH: usize = 8;
/// Longest a `yuppy_tasks` call may block waiting for results.
pub const MAX_WAIT_SECS: u64 = 600;
/// How long to wait for the bridge to accept or refuse one request.
const REPLY_TIMEOUT: Duration = Duration::from_secs(20);
/// Team messages kept for `yuppy_team_log`.
const MAX_TEAM_LOG: usize = 300;

// ---------------------------------------------------------------- brief ---

/// The system-prompt addendum for the lead seat, built from the live team.
pub fn lead_brief(
    departments: &[DepartmentDto],
    agents: &[AgentStatusDto],
    workspace: &Path,
    git_branch: Option<&str>,
) -> String {
    use std::fmt::Write as _;
    let mut s = String::new();
    let _ = writeln!(
        s,
        "YUPPYCODE TEAM LEAD. You are the lead (conductor) of a YuppyCode team. The operator \
         talks to you in this terminal; you plan the work and distribute it to worker agents \
         that run in PARALLEL as separate non-interactive CLI processes."
    );
    let _ = writeln!(s, "\nWorkspace: {}", workspace.display());
    match git_branch {
        Some(b) => {
            let _ = writeln!(
                s,
                "Git checkout on branch `{b}`: isolation \"worktree\" is available (each task \
                 gets its own worktree and review branch; nothing is merged automatically)."
            );
        }
        None => {
            let _ = writeln!(
                s,
                "Not a git checkout (or no commit yet): use isolation \"shared\"; parallel \
                 tasks then edit the same tree, so give them disjoint files."
            );
        }
    }

    let _ = writeln!(s, "\nWorker CLIs:");
    for a in agents {
        let state = if a.available {
            match &a.version {
                Some(v) => format!("available ({v})"),
                None => "available".to_string(),
            }
        } else {
            "NOT installed — do not dispatch to it".to_string()
        };
        let _ = writeln!(s, "- cli=\"{}\" ({}): {state}", a.id, a.display_name);
    }

    let live: Vec<&DepartmentDto> = departments.iter().filter(|d| d.enabled).collect();
    if live.is_empty() {
        let _ = writeln!(s, "\nDepartments: none enabled (omit `department`).");
    } else {
        let _ = writeln!(
            s,
            "\nDepartments (pass the id as `department`, a role id as `role`):"
        );
        for d in live {
            let _ = write!(s, "- {} \"{}\"", d.id, d.name);
            if !d.description.trim().is_empty() {
                let _ = write!(s, " — {}", d.description.trim());
            }
            let _ = writeln!(s, " [max {} at once]", d.max_concurrency.max(1));
            for r in d.roles.iter().filter(|r| r.enabled) {
                let _ = write!(s, "    · role {} \"{}\" on {}", r.id, r.name, r.cli);
                if !r.description.trim().is_empty() {
                    let _ = write!(s, " — {}", r.description.trim());
                }
                let _ = writeln!(s);
            }
        }
    }

    let _ = write!(
        s,
        "\nTools (server yuppy-conductor): yuppy_dispatch, yuppy_tasks, yuppy_cancel, \
         yuppy_roster, yuppy_team_log.\n\
         How to lead:\n\
         1. For anything bigger than a quick answer, split the request into independent \
         slices and send them in ONE yuppy_dispatch call — tasks in one call run at the same \
         time; every worker is its own Claude Code process.\n\
         2. Each worker sees only its own prompt, never this conversation: make every prompt \
         self-contained (goal, files/areas it owns, constraints, what to report back).\n\
         3. Give parallel slices disjoint files. Prefer isolation \"worktree\" for code changes \
         in a git checkout; \"shared\" for read-only analysis.\n\
         4. Follow progress with yuppy_tasks (pass wait_secs to block until they finish), read \
         each worker's output, then integrate and report to the operator: what changed, which \
         review branches exist, what failed, what is left.\n\
         5. Never claim a worker did something its output does not show. A failed or \
         cancelled task is reported as such.\n\
         6. Use yuppy_cancel when the operator changes direction.\n\
         7. Answer the operator in the language they write in."
    );
    s
}

// --------------------------------------------------------------- ledger ---

/// What the lead knows about one task it dispatched.
#[derive(Debug, Clone)]
pub struct TrackedTask {
    pub spec: TaskSpecDto,
    /// First task id of the dispatch this task belonged to (the bus batch).
    pub batch: String,
    pub state: TaskStateDto,
    pub detail: Option<String>,
    pub report: Option<RunResult>,
    pub integration: Option<(String, Vec<String>, bool)>,
    pub conflicts: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct RunResult {
    pub success: bool,
    pub exit_code: Option<i32>,
    pub duration_ms: u64,
    pub output_tail: String,
}

/// Everything the conductor has learned from the bridge's broadcast.
#[derive(Debug, Default)]
pub struct Ledger {
    /// Dispatch order is kept by insertion sequence.
    pub tasks: BTreeMap<u64, TrackedTask>,
    order: u64,
    pub team_log: Vec<(String, String, String, String)>,
    pub departments: Vec<DepartmentDto>,
    pub agents: Vec<AgentStatusDto>,
    pub connected: bool,
}

pub fn is_terminal(s: TaskStateDto) -> bool {
    matches!(
        s,
        TaskStateDto::Completed | TaskStateDto::Failed | TaskStateDto::Cancelled
    )
}

impl Ledger {
    fn find_mut(&mut self, id: &str) -> Option<&mut TrackedTask> {
        self.tasks.values_mut().find(|t| t.spec.id == id)
    }

    pub fn find(&self, id: &str) -> Option<&TrackedTask> {
        self.tasks.values().find(|t| t.spec.id == id)
    }

    pub fn track(&mut self, specs: &[TaskSpecDto]) {
        let batch = specs.first().map(|t| t.id.clone()).unwrap_or_default();
        for spec in specs {
            self.order += 1;
            self.tasks.insert(
                self.order,
                TrackedTask {
                    spec: spec.clone(),
                    batch: batch.clone(),
                    state: TaskStateDto::Queued,
                    detail: None,
                    report: None,
                    integration: None,
                    conflicts: Vec::new(),
                },
            );
        }
    }

    pub fn untrack(&mut self, ids: &[String]) {
        self.tasks.retain(|_, t| !ids.contains(&t.spec.id));
    }

    fn batches(&self) -> HashSet<&str> {
        self.tasks.values().map(|t| t.batch.as_str()).collect()
    }

    /// Fold one broadcast payload in. Only tasks this lead dispatched are
    /// tracked; everything else on the bridge is ignored.
    pub fn apply(&mut self, payload: &ServerPayload) {
        match payload {
            ServerPayload::TaskState {
                task_id,
                state,
                detail,
                ..
            } => {
                if let Some(t) = self.find_mut(task_id) {
                    // A terminal state is final: a late "running" replayed
                    // out of order must not resurrect a finished task.
                    if !is_terminal(t.state) || is_terminal(*state) {
                        t.state = *state;
                    }
                    if detail.is_some() {
                        t.detail = detail.clone();
                    }
                }
            }
            ServerPayload::TaskReport {
                task_id,
                success,
                exit_code,
                duration_ms,
                output_tail,
            } => {
                if let Some(t) = self.find_mut(task_id) {
                    t.report = Some(RunResult {
                        success: *success,
                        exit_code: *exit_code,
                        duration_ms: *duration_ms,
                        output_tail: output_tail.clone(),
                    });
                }
            }
            ServerPayload::TaskIntegration {
                task_id,
                branch,
                changed_files,
                committed,
            } => {
                if let Some(t) = self.find_mut(task_id) {
                    t.integration = Some((branch.clone(), changed_files.clone(), *committed));
                }
            }
            ServerPayload::TaskConflict {
                task_a,
                task_b,
                path,
            } => {
                if let Some(t) = self.find_mut(task_a) {
                    t.conflicts
                        .push(format!("{path} (also changed by {task_b})"));
                }
                if let Some(t) = self.find_mut(task_b) {
                    t.conflicts
                        .push(format!("{path} (also changed by {task_a})"));
                }
            }
            ServerPayload::TeamMessage {
                batch,
                sender,
                recipient,
                body,
                ..
            } => {
                if self.batches().contains(batch.as_str()) {
                    self.team_log.push((
                        batch.clone(),
                        sender.clone(),
                        recipient.clone(),
                        body.clone(),
                    ));
                    let excess = self.team_log.len().saturating_sub(MAX_TEAM_LOG);
                    if excess > 0 {
                        self.team_log.drain(..excess);
                    }
                }
            }
            ServerPayload::DepartmentsLoaded { departments } => {
                self.departments = departments.clone();
            }
            ServerPayload::AgentInventory { agents } => {
                self.agents = agents.clone();
            }
            _ => {}
        }
    }
}

// -------------------------------------------------------------- backend ---

/// How tool calls reach the bridge. The real one is a WebSocket link;
/// tests substitute a recorder.
pub trait Backend: Send + Sync {
    /// Submit one batch. `Ok` means the bridge accepted (queued) it.
    fn submit(&self, tasks: &[TaskSpecDto]) -> Result<(), String>;
    /// Ask the bridge to cancel one task.
    fn cancel(&self, task_id: &str) -> Result<(), String>;
}

/// The MCP-facing half: tool schemas and handlers over a backend + ledger.
pub struct Conductor {
    backend: Box<dyn Backend>,
    pub ledger: Arc<Mutex<Ledger>>,
    seq: AtomicU64,
}

fn base36(mut n: u128) -> String {
    const DIGITS: &[u8] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    if n == 0 {
        return "0".into();
    }
    let mut out = Vec::new();
    while n > 0 {
        out.push(DIGITS[(n % 36) as usize]);
        n /= 36;
    }
    out.reverse();
    String::from_utf8(out).unwrap_or_default()
}

/// Canonical CLI id for what a model typed.
fn canonical_cli(raw: &str) -> Option<&'static str> {
    match raw.trim().to_ascii_lowercase().as_str() {
        "claude-code" | "claude" | "claudecode" | "claude_code" => Some("claude-code"),
        _ => None,
    }
}

fn opt_str(v: &Value, k: &str) -> Option<String> {
    v.get(k)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

/// The tool list the lead sees.
pub fn tool_defs() -> Vec<Value> {
    vec![
        json!({
            "name": "yuppy_dispatch",
            "description": "Hand work to the team. All tasks in ONE call are submitted as one batch and run IN PARALLEL, each as its own non-interactive Claude Code process. Workers do not see this conversation: every prompt must be self-contained. Returns the task ids; follow them with yuppy_tasks.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "tasks": {
                        "type": "array",
                        "minItems": 1,
                        "maxItems": MAX_TASKS_PER_DISPATCH,
                        "items": {
                            "type": "object",
                            "properties": {
                                "cli": {"type": "string", "enum": ["claude-code"], "description": "Worker CLI (optional; claude-code is the only one)."},
                                "title": {"type": "string", "description": "Short label shown to the operator."},
                                "prompt": {"type": "string", "description": "Complete, self-contained instructions for the worker."},
                                "role": {"type": "string", "description": "Optional role id/name (e.g. backend, reviewer)."},
                                "department": {"type": "string", "description": "Optional department id; must exist and be enabled."},
                                "isolation": {"type": "string", "enum": ["worktree", "shared"], "description": "worktree = own git worktree + review branch (code changes in a git checkout); shared = the workspace itself. Default shared."},
                                "model": {"type": "string", "description": "Optional model override for the CLI."},
                                "timeout_secs": {"type": "integer", "description": "Optional per-task timeout (default 900)."}
                            },
                            "required": ["prompt"]
                        }
                    }
                },
                "required": ["tasks"]
            }
        }),
        json!({
            "name": "yuppy_tasks",
            "description": "State of the tasks you dispatched: queued/running/completed/failed/cancelled, error detail, the worker's output tail, review branch and changed files. Pass wait_secs to block until the selected tasks finish (or the wait expires).",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "task_ids": {"type": "array", "items": {"type": "string"}, "description": "Only these tasks (default: all you dispatched)."},
                    "wait_secs": {"type": "integer", "description": "Block up to this many seconds (max 600) until every selected task is finished."},
                    "output_chars": {"type": "integer", "description": "Max characters of each worker's output to include (default 2000, 0 = none)."}
                }
            }
        }),
        json!({
            "name": "yuppy_cancel",
            "description": "Cancel one task you dispatched (its CLI process is killed).",
            "inputSchema": {
                "type": "object",
                "properties": {"task_id": {"type": "string"}},
                "required": ["task_id"]
            }
        }),
        json!({
            "name": "yuppy_roster",
            "description": "The team you can dispatch to: installed worker CLIs and enabled departments with their roles and concurrency limits.",
            "inputSchema": {"type": "object", "properties": {}}
        }),
        json!({
            "name": "yuppy_team_log",
            "description": "Messages your workers sent each other on their team bus (batches of 2+ tasks share one bus).",
            "inputSchema": {
                "type": "object",
                "properties": {"limit": {"type": "integer", "description": "Most recent N messages, default 40."}}
            }
        }),
    ]
}

impl Conductor {
    pub fn new(backend: Box<dyn Backend>, ledger: Arc<Mutex<Ledger>>) -> Self {
        Self {
            backend,
            ledger,
            seq: AtomicU64::new(0),
        }
    }

    fn next_id(&self) -> String {
        let ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis();
        let n = self.seq.fetch_add(1, Ordering::Relaxed) + 1;
        format!("lead-{}-{n}", base36(ms))
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Ledger> {
        self.ledger
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// Parse and validate a `yuppy_dispatch` input into task specs.
    pub fn parse_dispatch(&self, args: &Value) -> Result<Vec<TaskSpecDto>, String> {
        let items = args
            .get("tasks")
            .and_then(Value::as_array)
            .ok_or("`tasks` must be a non-empty array")?;
        if items.is_empty() {
            return Err("`tasks` must contain at least one task".into());
        }
        if items.len() > MAX_TASKS_PER_DISPATCH {
            return Err(format!(
                "at most {MAX_TASKS_PER_DISPATCH} tasks per dispatch (got {}); merge slices or dispatch again after these finish",
                items.len()
            ));
        }
        let mut out = Vec::with_capacity(items.len());
        for (i, item) in items.iter().enumerate() {
            let n = i + 1;
            let raw_cli = opt_str(item, "cli").unwrap_or_else(|| "claude-code".into());
            let cli = canonical_cli(&raw_cli).ok_or(format!(
                "task {n}: unknown cli {raw_cli:?} (only \"claude-code\" is supported)"
            ))?;
            let prompt =
                opt_str(item, "prompt").ok_or(format!("task {n}: `prompt` must not be empty"))?;
            let title = opt_str(item, "title").unwrap_or_else(|| {
                let first = prompt.lines().next().unwrap_or("").trim();
                let mut t: String = first.chars().take(60).collect();
                if first.chars().count() > 60 {
                    t.push('…');
                }
                t
            });
            let isolation = match opt_str(item, "isolation").as_deref() {
                None | Some("shared") => "shared".to_string(),
                Some("worktree") => "worktree".to_string(),
                Some(other) => {
                    return Err(format!(
                        "task {n}: isolation {other:?} is not \"worktree\" or \"shared\""
                    ));
                }
            };
            let timeout_secs = match item.get("timeout_secs") {
                None | Some(Value::Null) => None,
                Some(v) => Some(
                    v.as_u64()
                        .filter(|s| *s > 0)
                        .ok_or(format!("task {n}: timeout_secs must be a positive integer"))?,
                ),
            };
            out.push(TaskSpecDto {
                id: self.next_id(),
                title,
                prompt,
                cli: cli.to_string(),
                model: opt_str(item, "model"),
                department: opt_str(item, "department"),
                role: opt_str(item, "role"),
                isolation,
                timeout_secs,
            });
        }
        Ok(out)
    }

    fn dispatch(&self, args: &Value) -> Result<String, String> {
        let specs = self.parse_dispatch(args)?;
        let ids: Vec<String> = specs.iter().map(|t| t.id.clone()).collect();
        // Track before sending so no early state change is missed.
        self.lock().track(&specs);
        if let Err(e) = self.backend.submit(&specs) {
            self.lock().untrack(&ids);
            return Err(format!("the bridge refused the dispatch: {e}"));
        }
        let mut out = format!(
            "dispatched {} task(s) as one parallel batch:\n",
            specs.len()
        );
        for t in &specs {
            out.push_str(&format!(
                "- {} · {} · {}{}{}\n",
                t.id,
                t.cli,
                t.title,
                t.role
                    .as_ref()
                    .map(|r| format!(" · role {r}"))
                    .unwrap_or_default(),
                if t.isolation == "worktree" {
                    " · worktree"
                } else {
                    ""
                }
            ));
        }
        out.push_str("Follow them with yuppy_tasks (wait_secs blocks until they finish).");
        Ok(out)
    }

    fn selected(&self, args: &Value) -> Result<Vec<String>, String> {
        let ledger = self.lock();
        match args.get("task_ids").and_then(Value::as_array) {
            Some(ids) if !ids.is_empty() => {
                let mut out = Vec::new();
                for v in ids {
                    let id = v.as_str().unwrap_or("").trim().to_string();
                    if ledger.find(&id).is_none() {
                        return Err(format!("{id:?} is not a task you dispatched"));
                    }
                    out.push(id);
                }
                Ok(out)
            }
            _ => Ok(ledger.tasks.values().map(|t| t.spec.id.clone()).collect()),
        }
    }

    fn tasks(&self, args: &Value) -> Result<String, String> {
        let ids = self.selected(args)?;
        if ids.is_empty() {
            return Ok("you have not dispatched any tasks yet".into());
        }
        let wait = args
            .get("wait_secs")
            .and_then(Value::as_u64)
            .unwrap_or(0)
            .min(MAX_WAIT_SECS);
        let output_chars = args
            .get("output_chars")
            .and_then(Value::as_u64)
            .unwrap_or(2000) as usize;
        let mut timed_out = false;
        if wait > 0 {
            let deadline = Instant::now() + Duration::from_secs(wait);
            // A finished task's output report follows its final state once
            // the whole batch is done, so allow it a short grace period.
            let mut settled_at: Option<Instant> = None;
            loop {
                let (all_terminal, all_reported) = {
                    let l = self.lock();
                    let sel: Vec<&TrackedTask> = ids.iter().filter_map(|id| l.find(id)).collect();
                    (
                        sel.iter().all(|t| is_terminal(t.state)),
                        sel.iter()
                            .all(|t| t.report.is_some() || t.state == TaskStateDto::Cancelled),
                    )
                };
                if all_terminal {
                    let at = *settled_at.get_or_insert_with(Instant::now);
                    if all_reported || at.elapsed() >= Duration::from_secs(3) {
                        break;
                    }
                }
                if Instant::now() >= deadline {
                    timed_out = !all_terminal;
                    break;
                }
                std::thread::sleep(Duration::from_millis(200));
            }
        }
        let l = self.lock();
        let mut out = String::new();
        if !l.connected {
            out.push_str("WARNING: not connected to the bridge right now; states may be stale.\n");
        }
        for id in &ids {
            let Some(t) = l.find(id) else { continue };
            out.push_str(&render_task(t, output_chars));
        }
        if timed_out {
            out.push_str("(wait expired before every selected task finished)\n");
        }
        Ok(out.trim_end().to_string())
    }

    fn cancel(&self, args: &Value) -> Result<String, String> {
        let id = opt_str(args, "task_id").ok_or("`task_id` is required")?;
        {
            let l = self.lock();
            let Some(t) = l.find(&id) else {
                return Err(format!("{id:?} is not a task you dispatched"));
            };
            if is_terminal(t.state) {
                return Ok(format!("{id} already finished ({:?})", t.state));
            }
        }
        self.backend.cancel(&id)?;
        Ok(format!("cancellation requested for {id}"))
    }

    fn roster(&self) -> String {
        let l = self.lock();
        let mut out = String::from("Worker CLIs:\n");
        if l.agents.is_empty() {
            out.push_str("- (inventory not received yet)\n");
        }
        for a in &l.agents {
            out.push_str(&format!(
                "- {} ({}): {}\n",
                a.id,
                a.display_name,
                if a.available {
                    a.version.clone().unwrap_or_else(|| "available".into())
                } else {
                    "NOT installed".into()
                }
            ));
        }
        out.push_str("Departments:\n");
        let mut any = false;
        for d in l.departments.iter().filter(|d| d.enabled) {
            any = true;
            let roles: Vec<String> = d
                .roles
                .iter()
                .filter(|r| r.enabled)
                .map(|r| format!("{} ({})", r.id, r.cli))
                .collect();
            out.push_str(&format!(
                "- {} \"{}\" max {} · roles: {}\n",
                d.id,
                d.name,
                d.max_concurrency.max(1),
                if roles.is_empty() {
                    "-".into()
                } else {
                    roles.join(", ")
                }
            ));
        }
        if !any {
            out.push_str("- none enabled\n");
        }
        out.trim_end().to_string()
    }

    fn team_log(&self, args: &Value) -> String {
        let limit = args
            .get("limit")
            .and_then(Value::as_u64)
            .unwrap_or(40)
            .max(1) as usize;
        let l = self.lock();
        if l.team_log.is_empty() {
            return "no team messages from your batches yet".into();
        }
        let start = l.team_log.len().saturating_sub(limit);
        l.team_log[start..]
            .iter()
            .map(|(batch, from, to, body)| format!("[{batch}] {from} -> {to}: {body}"))
            .collect::<Vec<_>>()
            .join("\n")
    }

    /// Run one tool by (possibly fully-qualified) name.
    pub fn call_tool(&self, raw_name: &str, args: &Value) -> Result<String, String> {
        let name = yuppycode_bus::normalize_tool_name(raw_name);
        match name.as_str() {
            "yuppy_dispatch" => self.dispatch(args),
            "yuppy_tasks" => self.tasks(args),
            "yuppy_cancel" => self.cancel(args),
            "yuppy_roster" => Ok(self.roster()),
            "yuppy_team_log" => Ok(self.team_log(args)),
            other => Err(format!("unknown tool {other:?}")),
        }
    }

    /// One JSON-RPC line in, one optional reply line out (same contract as
    /// the team-bus server: tool failures are `isError` results).
    pub fn handle_line(&self, line: &str) -> Option<String> {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            return None;
        }
        let msg: Value = match serde_json::from_str(trimmed) {
            Ok(v) => v,
            Err(e) => {
                return Some(
                    json!({"jsonrpc":"2.0","id":Value::Null,
                           "error":{"code":-32700,"message":format!("parse error: {e}")}})
                    .to_string(),
                );
            }
        };
        let id = msg.get("id").cloned();
        let method = msg.get("method").and_then(Value::as_str).unwrap_or("");
        let params = msg.get("params").cloned().unwrap_or_else(|| json!({}));
        let result: Result<Value, (i64, String)> = match method {
            "initialize" => {
                let requested = params
                    .get("protocolVersion")
                    .and_then(Value::as_str)
                    .unwrap_or(yuppycode_mcp::CURRENT_PROTOCOL_VERSION);
                let version = if yuppycode_mcp::SUPPORTED_PROTOCOL_VERSIONS.contains(&requested) {
                    requested
                } else {
                    yuppycode_mcp::CURRENT_PROTOCOL_VERSION
                };
                Ok(json!({
                    "protocolVersion": version,
                    "capabilities": {"tools": {"listChanged": false}},
                    "serverInfo": {"name": "yuppycode-conductor", "version": env!("CARGO_PKG_VERSION")},
                    "instructions": "You are the YuppyCode team lead. Split work into self-contained slices and send them in one yuppy_dispatch call so they run in parallel; follow with yuppy_tasks."
                }))
            }
            "ping" => Ok(json!({})),
            "tools/list" => Ok(json!({"tools": tool_defs()})),
            "tools/call" => {
                let name = params.get("name").and_then(Value::as_str).unwrap_or("");
                let args = params
                    .get("arguments")
                    .cloned()
                    .unwrap_or_else(|| json!({}));
                Ok(match self.call_tool(name, &args) {
                    Ok(text) => json!({"content":[{"type":"text","text":text}],"isError":false}),
                    Err(e) => json!({"content":[{"type":"text","text":e}],"isError":true}),
                })
            }
            "" => Err((-32600, "missing method".into())),
            other if other.starts_with("notifications/") => return None,
            other => Err((-32601, format!("method not found: {other}"))),
        };
        let reply = match result {
            Ok(v) => json!({"jsonrpc":"2.0","id":id.unwrap_or(Value::Null),"result":v}),
            Err((code, message)) => {
                json!({"jsonrpc":"2.0","id":id.unwrap_or(Value::Null),"error":{"code":code,"message":message}})
            }
        };
        Some(reply.to_string())
    }
}

fn render_task(t: &TrackedTask, output_chars: usize) -> String {
    let mut s = format!(
        "## {} · {} · {:?}{}\n  title: {}\n",
        t.spec.id,
        t.spec.cli,
        t.state,
        t.spec
            .role
            .as_ref()
            .map(|r| format!(" · role {r}"))
            .unwrap_or_default(),
        t.spec.title
    );
    if let Some(d) = &t.detail {
        s.push_str(&format!("  detail: {d}\n"));
    }
    if let Some((branch, files, committed)) = &t.integration {
        s.push_str(&format!(
            "  review branch: {branch} ({}committed) · changed: {}\n",
            if *committed { "" } else { "not " },
            if files.is_empty() {
                "-".to_string()
            } else {
                files.join(", ")
            }
        ));
    }
    for c in &t.conflicts {
        s.push_str(&format!("  CONFLICT: {c}\n"));
    }
    match &t.report {
        Some(r) => {
            s.push_str(&format!(
                "  exit: {} · {} ms · {}\n",
                r.exit_code
                    .map(|c| c.to_string())
                    .unwrap_or_else(|| "-".into()),
                r.duration_ms,
                if r.success { "success" } else { "failed" }
            ));
            if output_chars > 0 && !r.output_tail.trim().is_empty() {
                let tail: String = {
                    let chars: Vec<char> = r.output_tail.chars().collect();
                    let start = chars.len().saturating_sub(output_chars);
                    chars[start..].iter().collect()
                };
                s.push_str("  output (tail):\n");
                for line in tail.trim_end().lines() {
                    s.push_str("    ");
                    s.push_str(line);
                    s.push('\n');
                }
            }
        }
        None if is_terminal(t.state) => {
            s.push_str("  output: not reported yet (arrives when its whole batch finishes)\n")
        }
        None => {}
    }
    s
}

// ------------------------------------------------------- websocket link ---

/// What the reader expects as the reply to the one request in flight.
enum Expect {
    /// `task_submit`: any `task_state` for one of these ids = accepted.
    Submit(HashSet<String>),
    /// `task_cancel`: a `task_state` for this id = accepted.
    Cancel(String),
}

struct Pending {
    expect: Expect,
    reply: std::sync::mpsc::Sender<Result<(), String>>,
}

/// WebSocket link to the bridge, with automatic reconnect.
pub struct WsBackend {
    out: tokio::sync::mpsc::UnboundedSender<String>,
    pending: Arc<Mutex<Option<Pending>>>,
    ledger: Arc<Mutex<Ledger>>,
    /// Requests are one at a time so a reply can be matched without ids.
    in_flight: Mutex<()>,
    _rt: tokio::runtime::Runtime,
}

impl WsBackend {
    pub fn connect(
        url: String,
        token: String,
        ledger: Arc<Mutex<Ledger>>,
    ) -> std::io::Result<Self> {
        let rt = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(1)
            .enable_all()
            .build()?;
        let (out_tx, out_rx) = tokio::sync::mpsc::unbounded_channel::<String>();
        let pending: Arc<Mutex<Option<Pending>>> = Arc::new(Mutex::new(None));
        rt.spawn(link_loop(
            url,
            token,
            out_rx,
            Arc::clone(&pending),
            Arc::clone(&ledger),
        ));
        Ok(Self {
            out: out_tx,
            pending,
            ledger,
            in_flight: Mutex::new(()),
            _rt: rt,
        })
    }

    fn request(&self, req: &ClientRequest, expect: Expect) -> Result<(), String> {
        let _turn = self
            .in_flight
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let connected = self.ledger.lock().map(|l| l.connected).unwrap_or(false);
        if !connected {
            // Give a just-started link a moment to finish its handshake.
            let until = Instant::now() + Duration::from_secs(5);
            while Instant::now() < until {
                if self.ledger.lock().map(|l| l.connected).unwrap_or(false) {
                    break;
                }
                std::thread::sleep(Duration::from_millis(100));
            }
            if !self.ledger.lock().map(|l| l.connected).unwrap_or(false) {
                return Err("not connected to the YuppyCode bridge".into());
            }
        }
        let (tx, rx) = std::sync::mpsc::channel();
        *self
            .pending
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) =
            Some(Pending { expect, reply: tx });
        let text = serde_json::to_string(req).map_err(|e| e.to_string())?;
        self.out
            .send(text)
            .map_err(|_| "bridge link is closed".to_string())?;
        let result = rx
            .recv_timeout(REPLY_TIMEOUT)
            .unwrap_or_else(|_| Err("the bridge did not answer in time".into()));
        *self
            .pending
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = None;
        result
    }
}

impl Backend for WsBackend {
    fn submit(&self, tasks: &[TaskSpecDto]) -> Result<(), String> {
        let ids = tasks.iter().map(|t| t.id.clone()).collect();
        self.request(
            &ClientRequest::TaskSubmit {
                tasks: tasks.to_vec(),
            },
            Expect::Submit(ids),
        )
    }

    fn cancel(&self, task_id: &str) -> Result<(), String> {
        self.request(
            &ClientRequest::TaskCancel {
                task_id: task_id.to_string(),
            },
            Expect::Cancel(task_id.to_string()),
        )
    }
}

/// Resolve the in-flight request if `payload` answers it.
fn settle_pending(pending: &Mutex<Option<Pending>>, payload: &ServerPayload) {
    let mut slot = pending
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let Some(p) = slot.as_ref() else { return };
    let outcome = match (payload, &p.expect) {
        // Task broadcasts never carry `error`, so an error now is our reply.
        (ServerPayload::Error { code, message }, _) => Some(Err(format!("{code}: {message}"))),
        (ServerPayload::TaskState { task_id, .. }, Expect::Submit(ids))
            if ids.contains(task_id) =>
        {
            Some(Ok(()))
        }
        (ServerPayload::TasksDispatched { tasks, .. }, Expect::Submit(ids))
            if tasks.iter().any(|t| ids.contains(&t.id)) =>
        {
            Some(Ok(()))
        }
        (ServerPayload::TaskState { task_id, .. }, Expect::Cancel(id)) if task_id == id => {
            Some(Ok(()))
        }
        _ => None,
    };
    if let Some(result) = outcome {
        let _ = p.reply.send(result);
        *slot = None;
    }
}

async fn link_loop(
    url: String,
    token: String,
    mut out_rx: tokio::sync::mpsc::UnboundedReceiver<String>,
    pending: Arc<Mutex<Option<Pending>>>,
    ledger: Arc<Mutex<Ledger>>,
) {
    use futures_util::{SinkExt, StreamExt};
    use tokio_tungstenite::tungstenite::Message;

    let set_connected = |v: bool| {
        if let Ok(mut l) = ledger.lock() {
            l.connected = v;
        }
    };
    let mut backoff = Duration::from_millis(200);
    loop {
        let attempt = async {
            let (mut ws, _) = tokio_tungstenite::connect_async(url.as_str())
                .await
                .map_err(|e| format!("connect: {e}"))?;
            ws.send(Message::Text(
                json!({"version": PROTOCOL_VERSION, "token": token})
                    .to_string()
                    .into(),
            ))
            .await
            .map_err(|e| format!("handshake: {e}"))?;
            // First frame is `connected` or an error.
            let first = tokio::time::timeout(Duration::from_secs(10), ws.next())
                .await
                .map_err(|_| "handshake timeout".to_string())?
                .ok_or("closed during handshake")?
                .map_err(|e| format!("handshake: {e}"))?;
            let env: Envelope = serde_json::from_str(first.to_text().unwrap_or(""))
                .map_err(|e| format!("handshake reply: {e}"))?;
            match env.payload {
                ServerPayload::Connected => {}
                ServerPayload::Error { code, message } => {
                    return Err(format!("bridge refused the conductor: {code}: {message}"));
                }
                other => return Err(format!("unexpected handshake reply: {other:?}")),
            }
            Ok::<_, String>(ws)
        };
        let mut ws = match attempt.await {
            Ok(ws) => ws,
            Err(e) => {
                eprintln!("yuppy conductor: {e}; retrying");
                tokio::time::sleep(backoff).await;
                backoff = (backoff * 2).min(Duration::from_secs(5));
                continue;
            }
        };
        backoff = Duration::from_millis(200);
        set_connected(true);
        loop {
            tokio::select! {
                frame = ws.next() => {
                    let Some(Ok(msg)) = frame else { break };
                    let Message::Text(text) = msg else {
                        if matches!(msg, Message::Close(_)) { break; }
                        continue;
                    };
                    let Ok(env) = serde_json::from_str::<Envelope>(&text) else { continue };
                    if let Ok(mut l) = ledger.lock() {
                        l.apply(&env.payload);
                    }
                    settle_pending(&pending, &env.payload);
                }
                out = out_rx.recv() => {
                    let Some(text) = out else { return };
                    if ws.send(Message::Text(text.into())).await.is_err() {
                        break;
                    }
                }
            }
        }
        set_connected(false);
        // Fail the request in flight instead of letting it time out.
        if let Some(p) = pending
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .take()
        {
            let _ = p.reply.send(Err("bridge connection dropped".into()));
        }
        tokio::time::sleep(backoff).await;
    }
}

/// A backend for a conductor started without bridge coordinates: every
/// call fails honestly instead of pretending work was dispatched.
struct Unwired;

impl Backend for Unwired {
    fn submit(&self, _: &[TaskSpecDto]) -> Result<(), String> {
        Err(format!(
            "this conductor was started without {} / {}; open the lead seat from the YuppyCode bridge",
            crate::bridge::state::CONDUCTOR_URL_ENV,
            crate::bridge::state::CONDUCTOR_TOKEN_ENV
        ))
    }
    fn cancel(&self, task_id: &str) -> Result<(), String> {
        self.submit(&[])
            .map_err(|e| format!("cannot cancel {task_id}: {e}"))
    }
}

/// `yuppy conductor-mcp`: serve the conductor tools on stdin/stdout.
pub fn run_conductor_mcp() {
    let ledger = Arc::new(Mutex::new(Ledger::default()));
    let url = std::env::var(crate::bridge::state::CONDUCTOR_URL_ENV).unwrap_or_default();
    let token = std::env::var(crate::bridge::state::CONDUCTOR_TOKEN_ENV).unwrap_or_default();
    let backend: Box<dyn Backend> = if url.trim().is_empty() || token.trim().is_empty() {
        eprintln!("yuppy conductor: no bridge coordinates in the environment; tools will refuse");
        Box::new(Unwired)
    } else {
        match WsBackend::connect(url, token, Arc::clone(&ledger)) {
            Ok(b) => Box::new(b),
            Err(e) => {
                eprintln!("yuppy conductor: runtime: {e}");
                Box::new(Unwired)
            }
        }
    };
    let conductor = Conductor::new(backend, ledger);
    let stdin = std::io::stdin();
    let mut stdout = std::io::stdout();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        if let Some(reply) = conductor.handle_line(&line) {
            if writeln!(stdout, "{reply}").is_err() || stdout.flush().is_err() {
                break;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Default)]
    struct Recorder {
        submits: Mutex<Vec<Vec<TaskSpecDto>>>,
        cancels: Mutex<Vec<String>>,
        refuse: Option<String>,
    }

    impl Backend for Arc<Recorder> {
        fn submit(&self, tasks: &[TaskSpecDto]) -> Result<(), String> {
            if let Some(e) = &self.refuse {
                return Err(e.clone());
            }
            self.submits.lock().unwrap().push(tasks.to_vec());
            Ok(())
        }
        fn cancel(&self, task_id: &str) -> Result<(), String> {
            self.cancels.lock().unwrap().push(task_id.into());
            Ok(())
        }
    }

    fn conductor(rec: Arc<Recorder>) -> Conductor {
        Conductor::new(Box::new(rec), Arc::new(Mutex::new(Ledger::default())))
    }

    fn call(c: &Conductor, name: &str, args: Value) -> Value {
        let line = json!({"jsonrpc":"2.0","id":1,"method":"tools/call",
                          "params":{"name":name,"arguments":args}})
        .to_string();
        serde_json::from_str(&c.handle_line(&line).unwrap()).unwrap()
    }

    fn text(v: &Value) -> String {
        v["result"]["content"][0]["text"]
            .as_str()
            .unwrap()
            .to_string()
    }

    #[test]
    fn tools_list_advertises_the_conductor_tools_with_schemas() {
        let c = conductor(Arc::default());
        let v: Value = serde_json::from_str(
            &c.handle_line(r#"{"jsonrpc":"2.0","id":1,"method":"tools/list"}"#)
                .unwrap(),
        )
        .unwrap();
        let tools = v["result"]["tools"].as_array().unwrap();
        let names: Vec<&str> = tools.iter().map(|t| t["name"].as_str().unwrap()).collect();
        assert_eq!(
            names,
            [
                "yuppy_dispatch",
                "yuppy_tasks",
                "yuppy_cancel",
                "yuppy_roster",
                "yuppy_team_log"
            ]
        );
        let dispatch = &tools[0]["inputSchema"];
        assert_eq!(dispatch["required"], json!(["tasks"]));
        let item = &dispatch["properties"]["tasks"]["items"];
        assert_eq!(item["required"], json!(["prompt"]));
        assert_eq!(item["properties"]["cli"]["enum"], json!(["claude-code"]));
        assert_eq!(
            item["properties"]["isolation"]["enum"],
            json!(["worktree", "shared"])
        );
        assert_eq!(tools[2]["inputSchema"]["required"], json!(["task_id"]));
    }

    #[test]
    fn initialize_negotiates_and_notifications_are_silent() {
        let c = conductor(Arc::default());
        let v: Value = serde_json::from_str(
            &c.handle_line(
                r#"{"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":"2024-11-05"}}"#,
            )
            .unwrap(),
        )
        .unwrap();
        assert!(v["result"]["capabilities"]["tools"].is_object());
        assert!(
            c.handle_line(r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#)
                .is_none()
        );
    }

    #[test]
    fn one_dispatch_is_one_batch_with_unique_lead_ids() {
        let rec = Arc::new(Recorder::default());
        let c = conductor(Arc::clone(&rec));
        let v = call(
            &c,
            "mcp__yuppy-conductor__yuppy_dispatch",
            json!({"tasks":[
                {"cli":"claude-code","title":"api","prompt":"build the api","role":"backend","isolation":"worktree"},
                {"prompt":"write the tests\nfor the api"}
            ]}),
        );
        assert_eq!(v["result"]["isError"], false, "{v}");
        let submits = rec.submits.lock().unwrap();
        assert_eq!(submits.len(), 1, "both tasks must go out in ONE submit");
        let batch = &submits[0];
        assert_eq!(batch.len(), 2);
        assert!(batch.iter().all(|t| t.id.starts_with("lead-")));
        assert_ne!(batch[0].id, batch[1].id);
        assert_eq!(batch[0].cli, "claude-code");
        assert_eq!(batch[0].isolation, "worktree");
        assert_eq!(batch[0].role.as_deref(), Some("backend"));
        assert_eq!(batch[1].cli, "claude-code", "cli defaults to claude-code");
        assert_eq!(batch[1].isolation, "shared", "shared is the default");
        assert_eq!(
            batch[1].title, "write the tests",
            "title defaults to the first line"
        );
        let t = text(&v);
        assert!(t.contains(&batch[0].id) && t.contains(&batch[1].id), "{t}");
        // Both are tracked as queued.
        let l = c.ledger.lock().unwrap();
        assert_eq!(l.tasks.len(), 2);
        assert!(l.tasks.values().all(|t| t.state == TaskStateDto::Queued));
    }

    #[test]
    fn invalid_dispatches_are_tool_errors_and_send_nothing() {
        let rec = Arc::new(Recorder::default());
        let c = conductor(Arc::clone(&rec));
        for args in [
            json!({}),
            json!({"tasks": []}),
            json!({"tasks": [{"cli":"gemini","prompt":"x"}]}),
            json!({"tasks": [{"cli":"codex","prompt":"x"}]}),
            json!({"tasks": [{"prompt":"  "}]}),
            json!({"tasks": [{"prompt":"x","isolation":"vm"}]}),
            json!({"tasks": (0..9).map(|_| json!({"prompt":"x"})).collect::<Vec<_>>()}),
        ] {
            let v = call(&c, "yuppy_dispatch", args.clone());
            assert_eq!(v["result"]["isError"], true, "{args} must be refused: {v}");
        }
        assert!(rec.submits.lock().unwrap().is_empty());
    }

    #[test]
    fn a_refused_dispatch_is_reported_and_not_tracked() {
        let rec = Arc::new(Recorder {
            refuse: Some("invalid_message: claude-code is not installed".into()),
            ..Default::default()
        });
        let c = conductor(rec);
        let v = call(
            &c,
            "yuppy_dispatch",
            json!({"tasks":[{"prompt":"x"}]}),
        );
        assert_eq!(v["result"]["isError"], true);
        assert!(text(&v).contains("not installed"));
        assert!(c.ledger.lock().unwrap().tasks.is_empty());
    }

    #[test]
    fn task_events_update_only_the_leads_own_tasks() {
        let rec = Arc::new(Recorder::default());
        let c = conductor(Arc::clone(&rec));
        call(
            &c,
            "yuppy_dispatch",
            json!({"tasks":[{"prompt":"x"}]}),
        );
        let id = rec.submits.lock().unwrap()[0][0].id.clone();
        {
            let mut l = c.ledger.lock().unwrap();
            l.apply(&ServerPayload::TaskState {
                task_id: "someone-elses".into(),
                state: TaskStateDto::Running,
                detail: None,
                cli: None,
                title: None,
            });
            l.apply(&ServerPayload::TaskState {
                task_id: id.clone(),
                state: TaskStateDto::Completed,
                detail: None,
                cli: None,
                title: None,
            });
            // A stale "running" must not resurrect a finished task.
            l.apply(&ServerPayload::TaskState {
                task_id: id.clone(),
                state: TaskStateDto::Running,
                detail: None,
                cli: None,
                title: None,
            });
            l.apply(&ServerPayload::TaskReport {
                task_id: id.clone(),
                success: true,
                exit_code: Some(0),
                duration_ms: 42,
                output_tail: "all green".into(),
            });
            l.apply(&ServerPayload::TeamMessage {
                batch: id.clone(),
                sender: "lead".into(),
                recipient: "*".into(),
                body: "hello".into(),
                ts_ms: 1,
                id: 1,
            });
            l.apply(&ServerPayload::TeamMessage {
                batch: "other".into(),
                sender: "x".into(),
                recipient: "*".into(),
                body: "not ours".into(),
                ts_ms: 1,
                id: 2,
            });
            assert_eq!(l.tasks.len(), 1);
            assert_eq!(l.find(&id).unwrap().state, TaskStateDto::Completed);
        }
        let v = call(&c, "yuppy_tasks", json!({"wait_secs": 1}));
        let t = text(&v);
        assert!(t.contains("Completed") && t.contains("all green"), "{t}");
        assert!(!t.contains("someone-elses"));
        let log = text(&call(&c, "yuppy_team_log", json!({})));
        assert!(log.contains("hello") && !log.contains("not ours"), "{log}");
    }

    #[test]
    fn cancel_is_limited_to_own_live_tasks() {
        let rec = Arc::new(Recorder::default());
        let c = conductor(Arc::clone(&rec));
        let v = call(&c, "yuppy_cancel", json!({"task_id":"t-ui-1"}));
        assert_eq!(v["result"]["isError"], true);
        call(
            &c,
            "yuppy_dispatch",
            json!({"tasks":[{"prompt":"x"}]}),
        );
        let id = rec.submits.lock().unwrap()[0][0].id.clone();
        let v = call(&c, "yuppy_cancel", json!({"task_id": id}));
        assert_eq!(v["result"]["isError"], false, "{v}");
        assert_eq!(rec.cancels.lock().unwrap().as_slice(), [id]);
    }

    #[test]
    fn the_brief_names_live_departments_roles_and_clis() {
        let depts = vec![
            DepartmentDto {
                id: "eng".into(),
                name: "Engineering".into(),
                description: "builds things".into(),
                icon: String::new(),
                agents: vec![],
                roles: vec![yuppycode_protocol::DepartmentRoleDto {
                    id: "backend".into(),
                    name: "Backend Developer".into(),
                    description: String::new(),
                    cli: "claude-code".into(),
                    model: None,
                    enabled: true,
                }],
                workspace: None,
                allowed_tools: vec![],
                max_concurrency: 3,
                enabled: true,
                panels: vec![],
            },
            DepartmentDto {
                id: "off".into(),
                name: "Disabled".into(),
                description: String::new(),
                icon: String::new(),
                agents: vec![],
                roles: vec![],
                workspace: None,
                allowed_tools: vec![],
                max_concurrency: 1,
                enabled: false,
                panels: vec![],
            },
        ];
        let agents = vec![
            AgentStatusDto {
                id: "claude-code".into(),
                display_name: "Claude Code".into(),
                available: false,
                version: None,
                install_hint: Some("npm i".into()),
            },
        ];
        let b = lead_brief(&depts, &agents, Path::new("/w"), Some("main"));
        assert!(b.contains("eng \"Engineering\""), "{b}");
        assert!(
            b.contains("role backend \"Backend Developer\" on claude-code"),
            "{b}"
        );
        assert!(
            !b.contains("Disabled"),
            "disabled departments are not offered"
        );
        assert!(
            b.contains("cli=\"claude-code\" (Claude Code): NOT installed"),
            "{b}"
        );
        assert!(b.contains("yuppy_dispatch") && b.contains("worktree"));
    }

    #[test]
    fn ids_are_lead_prefixed_base36() {
        assert_eq!(base36(0), "0");
        assert_eq!(base36(35), "z");
        assert_eq!(base36(36), "10");
        let c = conductor(Arc::default());
        let a = c.next_id();
        let b = c.next_id();
        assert!(a.starts_with("lead-") && a.ends_with("-1"), "{a}");
        assert!(b.ends_with("-2"));
    }
}
