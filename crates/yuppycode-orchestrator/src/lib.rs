//! Jarvis-style orchestrator: schedules tasks onto CLI agents with
//! bounded concurrency, cancellation, isolated workspaces and honest
//! integration reporting.
//!
//! Contract (spec §4):
//! - A task is only marked Completed when its runner reports a zero
//!   exit — never before verification.
//! - Parallel code-changing tasks run in isolated git worktrees; the
//!   orchestrator collects review artifacts (branch + changed files)
//!   and never merges or overwrites another agent's work.
//! - Concurrency is bounded globally and per department.
//! - Every state transition is observable via an event callback.
//!
//! This crate depends on the CLI adapters for non-interactive argv only;
//! it owns no UI and no protocol concerns.

pub mod isolation;
pub mod runner;

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};

use tokio::sync::{Semaphore, SemaphorePermit};

pub use isolation::{Integration, Isolation};
pub use runner::{
    CancelFlag, OutputEvents, ProcessTaskRunner, RunReport, RunnerError, TaskRunner,
};

/// Task lifecycle states (spec §4).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TaskState {
    Queued,
    Running,
    AwaitingApproval,
    Completed,
    Failed,
    Cancelled,
}

impl TaskState {
    pub fn is_terminal(self) -> bool {
        matches!(
            self,
            TaskState::Completed | TaskState::Failed | TaskState::Cancelled
        )
    }
}

/// One unit of work for the orchestrator.
#[derive(Debug, Clone)]
pub struct Task {
    pub id: String,
    pub title: String,
    pub prompt: String,
    /// CLI adapter id to execute on ("claude-code").
    pub cli: String,
    pub model: Option<String>,
    pub department: Option<String>,
    pub isolation: Isolation,
    pub timeout_secs: u64,
    /// When set, the task runs as a named member of a team: it gets the
    /// YuppyCode bus as an MCP server and the team brief, so it can talk to
    /// the other members instead of guessing what they are doing.
    pub team: Option<yuppycode_agents::TeamLink>,
    /// Claude Code `--permission-mode` for this task's headless run, usually
    /// the owning department's `permission_mode`. `None`/"default" = no flag.
    pub permission_mode: Option<String>,
}

/// The final record of one task, including its review artifact.
#[derive(Debug, Clone)]
pub struct TaskOutcome {
    pub task_id: String,
    pub state: TaskState,
    pub report: Option<RunReport>,
    pub integration: Option<Integration>,
    pub error: Option<String>,
}

/// Scheduler resource limits.
#[derive(Debug, Clone)]
pub struct Limits {
    /// Global bound on simultaneously running tasks.
    pub max_parallel: usize,
    /// Per-department bound (departments absent here use max_parallel).
    pub per_department: HashMap<String, usize>,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            max_parallel: 2,
            per_department: HashMap::new(),
        }
    }
}

impl Limits {
    fn dept_limit(&self, dept: &Option<String>) -> usize {
        dept.as_ref()
            .and_then(|d| self.per_department.get(d))
            .copied()
            .unwrap_or(self.max_parallel)
            .max(1)
    }
}

/// Observer callback for state transitions; called from the scheduler.
pub type Events = Arc<dyn Fn(&str, TaskState) + Send + Sync>;

/// Called once per task with its final [`TaskOutcome`] the moment *that*
/// task finishes (after review-artifact collection and worktree cleanup),
/// not when the whole batch ends. Also called for a worker that panicked.
pub type OutcomeEvents = Arc<dyn Fn(&TaskOutcome) + Send + Sync>;

/// Every observer a batch reports to. `state` is the existing transition
/// callback; `output` receives live progress lines `(task_id, line)`;
/// `outcome` receives each task's final record as soon as it is known.
#[derive(Clone)]
pub struct BatchHooks {
    pub state: Events,
    pub output: Option<OutputEvents>,
    pub outcome: Option<OutcomeEvents>,
}

impl BatchHooks {
    /// State transitions only — what [`run_batch_with_cancels`] uses.
    pub fn new(state: Events) -> Self {
        Self {
            state,
            output: None,
            outcome: None,
        }
    }

    pub fn with_output(mut self, output: OutputEvents) -> Self {
        self.output = Some(output);
        self
    }

    pub fn with_outcome(mut self, outcome: OutcomeEvents) -> Self {
        self.outcome = Some(outcome);
        self
    }
}

#[derive(Debug, thiserror::Error)]
pub enum OrchestratorError {
    #[error("isolation: {0}")]
    Isolation(#[from] isolation::IsolationError),
    #[error("runner: {0}")]
    Runner(#[from] RunnerError),
}

struct DeptGates {
    semaphores: Mutex<HashMap<String, Arc<Semaphore>>>,
    limits: Limits,
}

impl DeptGates {
    fn gate(&self, dept: &Option<String>) -> Arc<Semaphore> {
        let key = dept.clone().unwrap_or_else(|| "*".into());
        // Poison-safe: the map holds plain entries, so continuing after a
        // panicking holder is strictly better than unwinding the scheduler.
        let mut map = self.semaphores.lock().unwrap_or_else(|e| e.into_inner());
        Arc::clone(
            map.entry(key.clone())
                .or_insert_with(|| Arc::new(Semaphore::new(self.limits.dept_limit(dept)))),
        )
    }
}

/// Outcome plus conflict analysis across the whole batch.
#[derive(Debug, Default)]
pub struct BatchReport {
    pub outcomes: Vec<TaskOutcome>,
    /// (task_a, task_b, shared_path) triples for tasks whose change
    /// sets overlap — a human must decide the merge order.
    pub conflicts: Vec<(String, String, String)>,
}

/// Run every task under the given limits.
///
/// `keep_worktrees`: when false, worktree directories are removed after
/// collection (review branches are always kept).
pub async fn run_batch(
    tasks: Vec<Task>,
    runner: Arc<dyn TaskRunner>,
    limits: &Limits,
    cancel: CancelFlag,
    events: Events,
    keep_worktrees: bool,
) -> BatchReport {
    run_batch_with_cancels(
        tasks,
        runner,
        limits,
        cancel,
        Arc::new(Mutex::new(HashMap::new())),
        events,
        keep_worktrees,
    )
    .await
}

/// Like [`run_batch`] but each task can be cancelled independently through
/// `task_cancels` (keyed by task id). A missing entry falls back to the
/// batch-wide `cancel` flag.
#[allow(clippy::too_many_arguments)]
pub async fn run_batch_with_cancels(
    tasks: Vec<Task>,
    runner: Arc<dyn TaskRunner>,
    limits: &Limits,
    cancel: CancelFlag,
    task_cancels: Arc<Mutex<HashMap<String, CancelFlag>>>,
    events: Events,
    keep_worktrees: bool,
) -> BatchReport {
    run_batch_with_hooks(
        tasks,
        runner,
        limits,
        cancel,
        task_cancels,
        BatchHooks::new(events),
        keep_worktrees,
    )
    .await
}

/// [`run_batch_with_cancels`] with live output and per-task outcome hooks.
///
/// `hooks.output` gets every progress line each headless worker prints;
/// `hooks.outcome` gets each task's final record as soon as that task is
/// done, so a caller can publish a finished worker's report while its
/// teammates are still running. The returned [`BatchReport`] still holds
/// every outcome plus the batch-level conflict scan.
#[allow(clippy::too_many_arguments)]
pub async fn run_batch_with_hooks(
    tasks: Vec<Task>,
    runner: Arc<dyn TaskRunner>,
    limits: &Limits,
    cancel: CancelFlag,
    task_cancels: Arc<Mutex<HashMap<String, CancelFlag>>>,
    hooks: BatchHooks,
    keep_worktrees: bool,
) -> BatchReport {
    let events = hooks.state.clone();
    let global = Arc::new(Semaphore::new(limits.max_parallel.max(1)));
    let gates = Arc::new(DeptGates {
        semaphores: Mutex::new(HashMap::new()),
        limits: limits.clone(),
    });

    for t in &tasks {
        events(&t.id, TaskState::Queued);
    }

    let mut handles = Vec::with_capacity(tasks.len());
    // A worker that panics never returns its outcome, so the id is kept aside:
    // the caller (the TUI supervisor, `yuppy task`) matches outcomes by task id
    // to release the task's department slot and unblock anything waiting on its
    // report. An outcome labelled "unknown" strands both of those.
    let mut ids = Vec::with_capacity(tasks.len());
    for task in tasks {
        ids.push(task.id.clone());
        let global = Arc::clone(&global);
        let gates = Arc::clone(&gates);
        let runner = Arc::clone(&runner);
        let cancel = cancel.clone();
        let task_cancels = Arc::clone(&task_cancels);
        let events: Events = Arc::clone(&events);
        let output = hooks.output.clone();
        let on_outcome = hooks.outcome.clone();
        handles.push(tokio::spawn(async move {
            let outcome = schedule_one(
                task,
                runner,
                global,
                gates,
                cancel,
                task_cancels,
                events,
                output,
                keep_worktrees,
            )
            .await;
            if let Some(f) = &on_outcome {
                f(&outcome);
            }
            outcome
        }));
    }

    let on_outcome = hooks.outcome.clone();
    let mut outcomes = Vec::with_capacity(handles.len());
    for (id, h) in ids.into_iter().zip(handles) {
        outcomes.push(match h.await {
            Ok(o) => o,
            Err(join_err) => {
                events(&id, TaskState::Failed);
                let o = TaskOutcome {
                    task_id: id,
                    state: TaskState::Failed,
                    report: None,
                    integration: None,
                    error: Some(format!("worker panicked: {join_err}")),
                };
                if let Some(f) = &on_outcome {
                    f(&o);
                }
                o
            }
        });
    }
    finish_batch(outcomes)
}

/// Admission, run and cleanup for one task inside a batch.
#[allow(clippy::too_many_arguments)]
async fn schedule_one(
    task: Task,
    runner: Arc<dyn TaskRunner>,
    global: Arc<Semaphore>,
    gates: Arc<DeptGates>,
    cancel: CancelFlag,
    task_cancels: Arc<Mutex<HashMap<String, CancelFlag>>>,
    events: Events,
    output: Option<OutputEvents>,
    keep_worktrees: bool,
) -> TaskOutcome {
    {
        {
            let id = task.id.clone();
            let dept = task.department.clone();
            // Poison-safe for the same reason as the dept gates: a plain map
            // of cancel flags stays perfectly usable after a panic elsewhere.
            let task_cancel = task_cancels
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .get(&id)
                .cloned()
                .unwrap_or_else(|| cancel.clone());

            // Bounded admission: global permit, then department permit.
            let g: SemaphorePermit<'_> = match global.acquire().await {
                Ok(p) => p,
                Err(_) => {
                    events(&id, TaskState::Failed);
                    return TaskOutcome {
                        task_id: id,
                        state: TaskState::Failed,
                        report: None,
                        integration: None,
                        error: Some("scheduler shut down".into()),
                    };
                }
            };
            let dept_gate = gates.gate(&dept);
            let d = match dept_gate.acquire().await {
                Ok(p) => p,
                Err(_) => {
                    events(&id, TaskState::Failed);
                    return TaskOutcome {
                        task_id: id,
                        state: TaskState::Failed,
                        report: None,
                        integration: None,
                        error: Some("department gate closed".into()),
                    };
                }
            };

            // A task may be cancelled while waiting for a permit; do not
            // start a runner for it after admission.
            if task_cancel.is_cancelled() {
                events(&id, TaskState::Cancelled);
                return TaskOutcome {
                    task_id: id,
                    state: TaskState::Cancelled,
                    report: None,
                    integration: None,
                    error: None,
                };
            }

            let outcome =
                run_one(&task, runner.as_ref(), &task_cancel, &events, output.as_ref()).await;
            drop(g);
            drop(d);
            if !keep_worktrees
                && let Isolation::GitWorktree { repo } = &task.isolation
                && let Some(Integration { worktree, .. }) = &outcome.integration
            {
                let _ = tokio::fs::remove_dir_all(worktree).await;
                let _ = tokio::process::Command::new("git")
                    .arg("-C")
                    .arg(repo)
                    .args(["worktree", "prune"])
                    .status()
                    .await;
            }
            outcome
        }
    }
}

/// Batch-level conflict scan over committed change sets.
fn finish_batch(outcomes: Vec<TaskOutcome>) -> BatchReport {
    let changed: Vec<(&str, Vec<String>)> = outcomes
        .iter()
        .filter(|o| o.state == TaskState::Completed)
        .filter_map(|o| {
            o.integration
                .as_ref()
                .map(|i| (o.task_id.as_str(), i.changed_files.clone()))
        })
        .collect();
    let conflicts = isolation::find_conflicts(
        &changed
            .iter()
            .map(|(id, f)| (*id, f.as_slice()))
            .collect::<Vec<_>>(),
    );

    BatchReport {
        outcomes,
        conflicts,
    }
}

async fn run_one(
    task: &Task,
    runner: &dyn TaskRunner,
    cancel: &CancelFlag,
    events: &Events,
    output: Option<&OutputEvents>,
) -> TaskOutcome {
    let id = task.id.as_str();
    if cancel.is_cancelled() {
        events(id, TaskState::Cancelled);
        return TaskOutcome {
            task_id: id.into(),
            state: TaskState::Cancelled,
            report: None,
            integration: None,
            error: None,
        };
    }

    let ws = match isolation::prepare(&task.isolation, id).await {
        Ok(ws) => ws,
        Err(e) => {
            events(id, TaskState::Failed);
            return TaskOutcome {
                task_id: id.into(),
                state: TaskState::Failed,
                report: None,
                integration: None,
                error: Some(format!("isolation setup failed: {e}")),
            };
        }
    };

    events(id, TaskState::Running);
    let req = runner::RunRequest {
        task_id: id,
        cli: &task.cli,
        model: task.model.as_deref(),
        prompt: &task.prompt,
        workdir: &ws.dir,
        cancel: cancel.clone(),
        timeout: std::time::Duration::from_secs(task.timeout_secs),
        team: task.team.as_ref(),
        permission_mode: task.permission_mode.as_deref(),
        output: output.cloned(),
    };
    let report = runner.run(req).await;

    // Cancelled wins over runner detail: cancellation is authoritative.
    if cancel.is_cancelled() {
        events(id, TaskState::Cancelled);
        return TaskOutcome {
            task_id: id.into(),
            state: TaskState::Cancelled,
            report: report.ok(),
            integration: None,
            error: None,
        };
    }

    match report {
        // Success is only claimed after the runner verified exit 0,
        // and the work is collected for review before any integration.
        Ok(rep) if rep.success => {
            let integration = match &task.isolation {
                Isolation::GitWorktree { .. } => {
                    match isolation::collect(&ws, &format!("task {}: {}", task.id, task.title))
                        .await
                    {
                        Ok(i) => Some(i),
                        Err(e) => {
                            events(id, TaskState::Failed);
                            return TaskOutcome {
                                task_id: id.into(),
                                state: TaskState::Failed,
                                report: Some(rep),
                                integration: None,
                                error: Some(format!("runner ok but collection failed: {e}")),
                            };
                        }
                    }
                }
                Isolation::Shared { .. } => None,
            };
            events(id, TaskState::Completed);
            TaskOutcome {
                task_id: id.into(),
                state: TaskState::Completed,
                report: Some(rep),
                integration,
                error: None,
            }
        }
        Ok(rep) => {
            events(id, TaskState::Failed);
            let why = format!("exit code {:?}", rep.exit_code);
            TaskOutcome {
                task_id: id.into(),
                state: TaskState::Failed,
                report: Some(rep),
                integration: None,
                error: Some(why),
            }
        }
        Err(e) => {
            events(id, TaskState::Failed);
            TaskOutcome {
                task_id: id.into(),
                state: TaskState::Failed,
                report: None,
                integration: None,
                error: Some(e.to_string()),
            }
        }
    }
}

/// Resolve each task's department concurrency limit from a registry
/// lookup (department id → max_concurrency), kept here so the scheduler
/// stays decoupled from the HUD crate.
pub fn dept_limits(
    tasks: &[Task],
    lookup: impl Fn(&str) -> Option<usize>,
) -> HashMap<String, usize> {
    let mut m = HashMap::new();
    let mut seen = HashSet::new();
    for t in tasks {
        if let Some(d) = &t.department
            && seen.insert(d.clone())
            && let Some(n) = lookup(d)
        {
            m.insert(d.clone(), n.max(1));
        }
    }
    m
}

/// Convenience: run one task to completion (used by `yuppy task`).
pub async fn run_single(
    task: Task,
    runner: Arc<dyn TaskRunner>,
    cancel: CancelFlag,
    events: Events,
    keep_worktrees: bool,
) -> TaskOutcome {
    let mut report = run_batch(
        vec![task],
        runner,
        &Limits::default(),
        cancel,
        events,
        keep_worktrees,
    )
    .await;
    report.outcomes.pop().expect("one outcome")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;
    use std::time::Instant;

    /// Scripted runner: records concurrency peaks, configurable delay.
    struct FakeRunner {
        delay_ms: u64,
        exit_zero: bool,
        live: Arc<AtomicUsize>,
        peak: Arc<AtomicUsize>,
        started: Mutex<Vec<(String, Instant)>>,
    }

    impl FakeRunner {
        fn new(delay_ms: u64, exit_zero: bool) -> (Self, Arc<AtomicUsize>) {
            let peak = Arc::new(AtomicUsize::new(0));
            (
                Self {
                    delay_ms,
                    exit_zero,
                    live: Arc::new(AtomicUsize::new(0)),
                    peak: Arc::clone(&peak),
                    started: Mutex::new(Vec::new()),
                },
                peak,
            )
        }
    }

    impl TaskRunner for FakeRunner {
        fn run<'a>(
            &'a self,
            req: runner::RunRequest<'a>,
        ) -> std::pin::Pin<Box<dyn Future<Output = Result<RunReport, RunnerError>> + Send + 'a>>
        {
            Box::pin(async move {
                let live = self.live.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
                self.peak
                    .fetch_max(live, std::sync::atomic::Ordering::SeqCst);
                self.started
                    .lock()
                    .unwrap()
                    .push((req.task_id.into(), Instant::now()));
                let slept = tokio::time::sleep(std::time::Duration::from_millis(self.delay_ms));
                tokio::select! {
                    _ = slept => {}
                    _ = wait_cancel(req.cancel.clone()) => {
                        self.live.fetch_sub(1, std::sync::atomic::Ordering::SeqCst);
                        return Ok(RunReport { success: false, exit_code: None, duration_ms: 1, output_tail: "cancelled".into() });
                    }
                }
                self.live.fetch_sub(1, std::sync::atomic::Ordering::SeqCst);
                Ok(RunReport {
                    success: self.exit_zero,
                    exit_code: Some(if self.exit_zero { 0 } else { 2 }),
                    duration_ms: self.delay_ms,
                    output_tail: format!("did: {}", req.prompt),
                })
            })
        }
    }

    async fn wait_cancel(c: CancelFlag) {
        while !c.is_cancelled() {
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
    }

    fn task(id: &str, dept: Option<&str>) -> Task {
        Task {
            id: id.into(),
            title: format!("task {id}"),
            prompt: format!("prompt {id}"),
            cli: "fake".into(),
            model: None,
            department: dept.map(str::to_string),
            isolation: Isolation::Shared {
                workspace: std::env::temp_dir(),
            },
            team: None,
            timeout_secs: 30,
            permission_mode: None,
        }
    }

    type EventLog = Arc<Mutex<Vec<(String, TaskState)>>>;

    fn recorder() -> (Events, EventLog) {
        let log: EventLog = Arc::new(Mutex::new(Vec::new()));
        let log2 = Arc::clone(&log);
        (
            Arc::new(move |id: &str, st: TaskState| {
                log2.lock().unwrap().push((id.to_string(), st));
            }),
            log,
        )
    }

    #[tokio::test]
    async fn happy_path_marks_completed_with_report() {
        let (runner, _peak) = FakeRunner::new(30, true);
        let (events, log) = recorder();
        let out = run_single(
            task("t1", None),
            Arc::new(runner),
            CancelFlag::new(),
            events,
            false,
        )
        .await;
        assert_eq!(out.state, TaskState::Completed);
        assert_eq!(out.report.unwrap().output_tail, "did: prompt t1");
        let states: Vec<TaskState> = log
            .lock()
            .unwrap()
            .iter()
            .map(|(_, s)| *s)
            .filter(|s| s.is_terminal() || matches!(s, TaskState::Queued | TaskState::Running))
            .collect();
        assert_eq!(
            states,
            vec![TaskState::Queued, TaskState::Running, TaskState::Completed]
        );
    }

    #[tokio::test]
    async fn failing_exit_never_reports_completed() {
        let (runner, _peak) = FakeRunner::new(10, false);
        let (events, _log) = recorder();
        let out = run_single(
            task("t1", None),
            Arc::new(runner),
            CancelFlag::new(),
            events,
            false,
        )
        .await;
        assert_eq!(out.state, TaskState::Failed);
        assert!(out.error.unwrap().contains("exit code Some(2)"));
    }

    #[tokio::test]
    async fn global_concurrency_is_bounded() {
        let (runner, peak) = FakeRunner::new(120, true);
        let (events, _) = recorder();
        let tasks: Vec<Task> = (0..6).map(|i| task(&format!("t{i}"), None)).collect();
        let report = run_batch(
            tasks,
            Arc::new(runner),
            &Limits {
                max_parallel: 2,
                per_department: HashMap::new(),
            },
            CancelFlag::new(),
            events,
            false,
        )
        .await;
        assert_eq!(report.outcomes.len(), 6);
        assert!(
            report
                .outcomes
                .iter()
                .all(|o| o.state == TaskState::Completed)
        );
        assert!(
            peak.load(std::sync::atomic::Ordering::SeqCst) <= 2,
            "peak > global limit"
        );
    }

    #[tokio::test]
    async fn department_limits_apply_independently() {
        let (runner, peak) = FakeRunner::new(120, true);
        let (events, _) = recorder();
        let tasks: Vec<Task> = (0..6)
            .map(|i| task(&format!("a{i}"), Some("research")))
            .chain((0..4).map(|i| task(&format!("b{i}"), Some("finance"))))
            .collect();
        let mut per = HashMap::new();
        per.insert("research".to_string(), 1usize);
        per.insert("finance".to_string(), 2usize);
        let report = run_batch(
            tasks,
            Arc::new(runner),
            &Limits {
                max_parallel: 10,
                per_department: per,
            },
            CancelFlag::new(),
            events,
            false,
        )
        .await;
        assert_eq!(report.outcomes.len(), 10);
        assert!(
            report
                .outcomes
                .iter()
                .all(|o| o.state == TaskState::Completed)
        );
        // Peak <= 3 (1 research + 2 finance).
        assert!(peak.load(std::sync::atomic::Ordering::SeqCst) <= 3);
    }

    #[tokio::test]
    async fn cancellation_stops_running_and_queued_tasks() {
        let (runner, _peak) = FakeRunner::new(5_000, true);
        let (events, _) = recorder();
        let cancel = CancelFlag::new();
        let tasks: Vec<Task> = (0..4).map(|i| task(&format!("t{i}"), None)).collect();
        let cancel2 = cancel.clone();
        tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(150)).await;
            cancel2.cancel();
        });
        let report = run_batch(
            tasks,
            Arc::new(runner),
            &Limits {
                max_parallel: 1,
                per_department: HashMap::new(),
            },
            cancel.clone(),
            events,
            false,
        )
        .await;
        assert!(
            report
                .outcomes
                .iter()
                .all(|o| o.state == TaskState::Cancelled),
            "{:?}",
            report
                .outcomes
                .iter()
                .map(|o| (o.task_id.clone(), o.state))
                .collect::<Vec<_>>()
        );
    }

    #[test]
    fn dept_limits_deduces_and_clamps() {
        let tasks = vec![
            task("a", Some("research")),
            task("b", Some("research")),
            task("c", Some("finance")),
            task("d", None),
        ];
        let m = dept_limits(&tasks, |d| match d {
            "research" => Some(3),
            "finance" => Some(0),
            _ => None,
        });
        assert_eq!(m.get("research"), Some(&3));
        assert_eq!(m.get("finance"), Some(&1), "0 clamped to 1");
        assert!(!m.contains_key("*"));
    }
}
