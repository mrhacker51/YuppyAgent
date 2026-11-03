//! Scheduler behaviour when several CLI agents really do run at once.
//!
//! The user's mental model is simple: one command, both vendors working
//! side by side, and one agent's bad day must not become everyone's. These
//! tests drive the real scheduler with a scripted runner (so no CLI install is
//! needed) and assert the parts that are invisible from a unit test: that the
//! batch actually overlaps, that cancellation is per task, and that a task that
//! fails, times out or panics still comes back *as itself*.

use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Duration, Instant};

use orc::runner::RunRequest;
use orc::{CancelFlag, Isolation, Limits, RunReport, RunnerError, Task, TaskRunner, TaskState};
use yuppycode_orchestrator as orc;

/// Scripted crew: per-task outcome, an optional panic, and overlap bookkeeping.
struct Crew {
    /// task id -> behaviour
    behaviour: HashMap<String, Behaviour>,
    live: Arc<AtomicUsize>,
    peak: Arc<AtomicUsize>,
    /// (task id, cli, started_at) for every turn that began.
    started: Arc<Mutex<Vec<(String, String, Instant)>>>,
    /// Cancel flags the runner was handed, per task.
    flags: Arc<Mutex<HashMap<String, CancelFlag>>>,
    default_delay: Duration,
}

enum Behaviour {
    Ok,
    Fails,
    TimesOut,
    Panics,
    /// Succeeds and writes these paths into the task's working directory.
    Writes(Vec<String>),
}

impl Crew {
    fn new(default_delay: Duration) -> Self {
        Self {
            behaviour: HashMap::new(),
            live: Arc::new(AtomicUsize::new(0)),
            peak: Arc::new(AtomicUsize::new(0)),
            started: Arc::new(Mutex::new(Vec::new())),
            flags: Arc::new(Mutex::new(HashMap::new())),
            default_delay,
        }
    }

    fn with(mut self, id: &str, b: Behaviour) -> Self {
        self.behaviour.insert(id.to_string(), b);
        self
    }

    fn peak_live(&self) -> usize {
        self.peak.load(Ordering::SeqCst)
    }
}

impl TaskRunner for Crew {
    fn run<'a>(
        &'a self,
        req: RunRequest<'a>,
    ) -> Pin<Box<dyn Future<Output = Result<RunReport, RunnerError>> + Send + 'a>> {
        Box::pin(async move {
            let id = req.task_id.to_string();
            let behaviour = self.behaviour.get(&id).map_or(Behaviour::Ok, |b| match b {
                Behaviour::Ok => Behaviour::Ok,
                Behaviour::Fails => Behaviour::Fails,
                Behaviour::TimesOut => Behaviour::TimesOut,
                Behaviour::Panics => Behaviour::Panics,
                Behaviour::Writes(f) => Behaviour::Writes(f.clone()),
            });
            self.flags
                .lock()
                .unwrap()
                .insert(id.clone(), req.cancel.clone());
            let live = self.live.fetch_add(1, Ordering::SeqCst) + 1;
            self.peak.fetch_max(live, Ordering::SeqCst);
            self.started
                .lock()
                .unwrap()
                .push((id.clone(), req.cli.to_string(), Instant::now()));
            if matches!(behaviour, Behaviour::Panics) {
                self.live.fetch_sub(1, Ordering::SeqCst);
                panic!("agent {id} exploded");
            }

            let report = |success: bool, exit: Option<i32>, tail: &str| RunReport {
                success,
                exit_code: exit,
                duration_ms: self.default_delay.as_millis() as u64,
                output_tail: tail.to_string(),
            };

            // Every turn watches its own cancellation, like a real child does.
            let cancel = req.cancel.clone();
            let slept = tokio::time::sleep(self.default_delay);
            tokio::select! {
                _ = slept => {}
                _ = async move { while !cancel.is_cancelled() { tokio::time::sleep(Duration::from_millis(10)).await; } } => {
                    self.live.fetch_sub(1, Ordering::SeqCst);
                    return Ok(report(false, None, "<cancelled>"));
                }
            }

            match behaviour {
                Behaviour::Writes(files) => {
                    for f in &files {
                        let path = req.workdir.join(f);
                        if let Some(parent) = path.parent() {
                            std::fs::create_dir_all(parent).unwrap();
                        }
                        std::fs::write(&path, format!("written by {id}\n")).unwrap();
                    }
                    self.live.fetch_sub(1, Ordering::SeqCst);
                    Ok(report(true, Some(0), &format!("{id} finished")))
                }
                Behaviour::Ok => {
                    self.live.fetch_sub(1, Ordering::SeqCst);
                    Ok(report(true, Some(0), &format!("{id} finished")))
                }
                Behaviour::Fails => {
                    self.live.fetch_sub(1, Ordering::SeqCst);
                    Ok(report(false, Some(1), &format!("{id} failed")))
                }
                Behaviour::TimesOut => Err(RunnerError::TimedOut(self.default_delay)),
                Behaviour::Panics => unreachable!(),
            }
        })
    }
}

fn task(id: &str, cli: &str, dept: Option<&str>) -> Task {
    Task {
        id: id.into(),
        title: format!("{id} work"),
        prompt: format!("{id} prompt"),
        cli: cli.into(),
        model: None,
        department: dept.map(str::to_string),
        isolation: Isolation::Shared {
            workspace: std::env::temp_dir(),
        },
        timeout_secs: 30,
        team: None,
        permission_mode: None,
    }
}

/// Every state transition the scheduler reports, in order.
type EventLog = Arc<Mutex<Vec<(String, TaskState)>>>;

fn recorder() -> (orc::Events, EventLog) {
    let log: EventLog = Arc::new(Mutex::new(Vec::new()));
    let sink = Arc::clone(&log);
    (
        Arc::new(move |id: &str, st: TaskState| sink.lock().unwrap().push((id.to_string(), st))),
        log,
    )
}

fn state_of(report: &orc::BatchReport, id: &str) -> TaskState {
    report
        .outcomes
        .iter()
        .find(|o| o.task_id == id)
        .unwrap_or_else(|| {
            panic!(
                "no outcome for {id}; got {:?}",
                report
                    .outcomes
                    .iter()
                    .map(|o| (&o.task_id, o.state))
                    .collect::<Vec<_>>()
            )
        })
        .state
}

/// A role team of Claude Code workers: the whole point is that they work
/// *at the same time*. A scheduler that quietly serialises them still
/// produces correct final states, so wall-clock overlap is the assertion that
/// matters, not just the peak counter.
#[tokio::test]
async fn a_claude_role_team_really_runs_at_the_same_time() {
    let delay = Duration::from_millis(300);
    let crew = Arc::new(Crew::new(delay));
    let (events, _log) = recorder();
    let tasks = vec![
        task("ada", "claude-code", Some("software-development")),
        task("nova", "claude-code", Some("software-development")),
        task("tess", "claude-code", Some("qa")),
    ];
    let mut per = HashMap::new();
    per.insert("software-development".to_string(), 2usize);
    per.insert("qa".to_string(), 1usize);

    let started = Instant::now();
    let report = orc::run_batch(
        tasks,
        crew.clone(),
        &Limits {
            max_parallel: 3,
            per_department: per,
        },
        CancelFlag::new(),
        events,
        false,
    )
    .await;

    assert!(
        report
            .outcomes
            .iter()
            .all(|o| o.state == TaskState::Completed),
        "{:?}",
        report.outcomes
    );
    assert_eq!(crew.peak_live(), 3, "three agents never ran together");

    let elapsed = started.elapsed();
    assert!(
        elapsed < delay * 2,
        "three agents took {elapsed:?} — that is serialised, not parallel \
         (one turn alone is {delay:?})"
    );

    // Every worker actually got work, keyed by the crew's own ids.
    let started = crew.started.lock().unwrap();
    let by_cli: HashMap<&str, usize> = started.iter().fold(HashMap::new(), |mut m, (_, cli, _)| {
        *m.entry(cli.as_str()).or_insert(0) += 1;
        m
    });
    assert_eq!(by_cli.get("claude-code"), Some(&3));
    assert_eq!(by_cli.len(), 1, "every agent is a Claude Code worker");

    // All three were in flight inside one small window.
    let begins: Vec<Instant> = started.iter().map(|(_, _, t)| *t).collect();
    let span = begins
        .iter()
        .max()
        .unwrap()
        .duration_since(*begins.iter().min().unwrap());
    assert!(span < delay, "starts were spread over {span:?}");
}

/// Per-task cancellation is what the TUI's cancel key uses. Cancelling one
/// teammate must not silently cancel the mission.
#[tokio::test]
async fn cancelling_one_teammate_leaves_the_others_working() {
    let crew = Arc::new(Crew::new(Duration::from_millis(400)));
    let crew_ref = crew.clone();
    let (events, _log) = recorder();
    let tasks = vec![
        task("busy", "claude-code", None),
        task("mate-a", "claude-code", None),
        task("mate-b", "claude-code", None),
    ];
    let cancels: Arc<Mutex<HashMap<String, CancelFlag>>> = Arc::default();
    cancels
        .lock()
        .unwrap()
        .insert("busy".into(), CancelFlag::new());

    let scheduled = {
        let cancels = cancels.clone();
        tokio::spawn(async move {
            // Wait until all three are actually running, then cancel one.
            for _ in 0..200 {
                if crew_ref.started.lock().unwrap().len() == 3 {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
            cancels
                .lock()
                .unwrap()
                .get("busy")
                .expect("busy has its own flag")
                .cancel();
        })
    };

    let report = orc::run_batch_with_cancels(
        tasks,
        crew.clone(),
        &Limits {
            max_parallel: 3,
            per_department: HashMap::new(),
        },
        CancelFlag::new(),
        cancels,
        events,
        false,
    )
    .await;
    scheduled.await.unwrap();

    assert_eq!(state_of(&report, "busy"), TaskState::Cancelled);
    assert_eq!(state_of(&report, "mate-a"), TaskState::Completed);
    assert_eq!(state_of(&report, "mate-b"), TaskState::Completed);

    // The siblings' runners were never handed a raised flag.
    let flags = crew.flags.lock().unwrap();
    for mate in ["mate-a", "mate-b"] {
        assert!(
            !flags.get(mate).unwrap().is_cancelled(),
            "{mate} was cancelled along with its teammate"
        );
    }
    assert!(flags.get("busy").unwrap().is_cancelled());
}

/// A department limited to one agent at a time must not dead-stop the batch:
/// a finished (or failed) task hands its slot to the next queued one.
#[tokio::test]
async fn a_finished_agent_hands_its_department_slot_to_the_next_one() {
    let crew = Arc::new(
        Crew::new(Duration::from_millis(60))
            .with("r1", Behaviour::Fails)
            .with("r2", Behaviour::TimesOut),
    );
    let (events, _log) = recorder();
    let tasks = vec![
        task("r1", "claude-code", Some("research")),
        task("r2", "claude-code", Some("research")),
        task("r3", "claude-code", Some("research")),
        task("f1", "claude-code", Some("finance")),
    ];
    let mut per = HashMap::new();
    per.insert("research".to_string(), 1usize);
    per.insert("finance".to_string(), 1usize);

    let report = orc::run_batch(
        tasks,
        crew.clone(),
        &Limits {
            max_parallel: 4,
            per_department: per,
        },
        CancelFlag::new(),
        events,
        false,
    )
    .await;

    // Every task reached a terminal state — nothing was left queued forever.
    assert_eq!(report.outcomes.len(), 4);
    assert_eq!(state_of(&report, "r1"), TaskState::Failed);
    assert_eq!(state_of(&report, "r2"), TaskState::Failed);
    assert_eq!(state_of(&report, "r3"), TaskState::Completed);
    assert_eq!(state_of(&report, "f1"), TaskState::Completed);
    assert_eq!(
        report
            .outcomes
            .iter()
            .find(|o| o.task_id == "r2")
            .unwrap()
            .error
            .as_deref(),
        Some("task timed out after 60ms"),
        "a timeout must reach the caller as the runner reported it"
    );

    // research never ran two at once; the third one started only after r1 ended.
    assert!(crew.peak_live() <= 2, "research+finance overlapped twice");
    let starts = crew.started.lock().unwrap();
    let order: Vec<&str> = starts
        .iter()
        .filter(|(id, _, _)| id.starts_with('r'))
        .map(|(id, _, _)| id.as_str())
        .collect();
    assert_eq!(
        order,
        vec!["r1", "r2", "r3"],
        "research serialisation broke"
    );
}

/// One agent panicking must not turn into an anonymous failure: the caller
/// (the TUI supervisor, `yuppy task`) matches outcomes by task id to release
/// its department slot and to unblock anything waiting on that report.
#[tokio::test]
async fn a_panicking_agent_is_still_reported_as_itself() {
    let crew = Arc::new(
        Crew::new(Duration::from_millis(50))
            .with("boom", Behaviour::Panics)
            .with("after", Behaviour::Ok),
    );
    let (events, _log) = recorder();
    let tasks = vec![
        task("boom", "claude-code", Some("dev")),
        task("sibling", "claude-code", Some("dev")),
    ];
    let mut per = HashMap::new();
    per.insert("dev".to_string(), 2usize);

    let report = orc::run_batch(
        tasks,
        crew,
        &Limits {
            max_parallel: 2,
            per_department: per,
        },
        CancelFlag::new(),
        events,
        false,
    )
    .await;

    let boom = report.outcomes.iter().find(|o| o.task_id == "boom").expect(
        "the panicked task must come back under its own id, otherwise \
                 the caller cannot release its slot or unblock its dependents",
    );
    assert_eq!(boom.state, TaskState::Failed);
    assert!(
        boom.error
            .as_deref()
            .is_some_and(|e| e.contains("panicked")),
        "{:?}",
        boom.error
    );
    assert_eq!(state_of(&report, "sibling"), TaskState::Completed);
    assert_eq!(
        report
            .outcomes
            .iter()
            .filter(|o| o.task_id == "unknown")
            .count(),
        0,
        "an outcome nobody can attribute"
    );
}

/// The event stream the HUD renders: every task walks Queued → Running → one
/// terminal state, exactly once, even when several run together.
#[tokio::test]
async fn every_parallel_agent_reports_a_complete_event_trail() {
    let crew = Arc::new(
        Crew::new(Duration::from_millis(60))
            .with("bad", Behaviour::Fails)
            .with("late", Behaviour::TimesOut),
    );
    let (events, log) = recorder();
    let ids = ["ok1", "ok2", "bad", "late"];
    let tasks = ids
        .iter()
        .map(|id| {
            task(
                id,
"claude-code",
                None,
            )
        })
        .collect();

    let report = orc::run_batch(
        tasks,
        crew,
        &Limits {
            max_parallel: 4,
            per_department: HashMap::new(),
        },
        CancelFlag::new(),
        events,
        false,
    )
    .await;

    let log = log.lock().unwrap();
    for id in ids {
        let trail: Vec<TaskState> = log
            .iter()
            .filter(|(tid, _)| tid == id)
            .map(|(_, st)| *st)
            .collect();
        let terminal_count = trail.iter().filter(|s| s.is_terminal()).count();
        assert_eq!(terminal_count, 1, "{id} trail: {trail:?}");
        assert_eq!(
            trail.first(),
            Some(&TaskState::Queued),
            "{id} trail: {trail:?}"
        );
        let final_state = trail.last().copied().expect("at least one event");
        assert!(final_state.is_terminal(), "{id} trail: {trail:?}");
        let outcome = report
            .outcomes
            .iter()
            .find(|o| o.task_id == id)
            .expect("outcome for id");
        assert_eq!(outcome.state, final_state, "{id} trail: {trail:?}");
    }
    // A running agent is never announced after it ended.
    let mut seen_running: HashSet<String> = HashSet::new();
    for (id, st) in log.iter() {
        if *st == TaskState::Running {
            assert!(
                seen_running.insert(id.clone()),
                "{id} reported Running twice"
            );
        }
    }
}

// ───────────────── worktrees: the overlap report a human acts on ─────────────────

fn scratch(tag: &str) -> PathBuf {
    let p = std::env::temp_dir().join(format!("yuppy-pbatch-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&p);
    std::fs::create_dir_all(&p).unwrap();
    p
}

async fn init_repo(dir: &Path) {
    for args in [
        ["init", "-q", "."],
        ["config", "user.email", "t@t"],
        ["config", "user.name", "t"],
    ] {
        git(dir, &args).await;
    }
    std::fs::write(dir.join("README.md"), "hello\n").unwrap();
    git(dir, &["add", "-A"]).await;
    git(dir, &["commit", "-qm", "seed"]).await;
}

async fn git(repo: &Path, args: &[&str]) -> String {
    let out = tokio::process::Command::new("git")
        .arg("-C")
        .arg(repo)
        .args(args)
        .output()
        .await
        .unwrap();
    assert!(
        out.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8_lossy(&out.stdout).into_owned()
}

/// End-to-end fan-out: four role agents, one shared file, one integration pass
/// reading the result. This is the chain behind the TUI's one-prompt mission.
#[tokio::test]
async fn a_parallel_mission_reports_which_roles_collided_on_which_file() {
    let repo = scratch("mission");
    init_repo(&repo).await;
    let crew = Arc::new(
        Crew::new(Duration::from_millis(40))
            .with(
                "backend",
                Behaviour::Writes(vec!["api.rs".into(), "README.md".into()]),
            )
            .with(
                "frontend",
                Behaviour::Writes(vec!["panel.tsx".into(), "README.md".into()]),
            )
            .with(
                "docs",
                Behaviour::Writes(vec!["docs/Türkçe rehber.md".into()]),
            ),
    );
    let (events, _log) = recorder();
    let iso = Isolation::GitWorktree { repo: repo.clone() };
    let tasks = ["backend", "frontend", "docs"]
        .iter()
        .map(|id| Task {
            isolation: iso.clone(),
            department: Some("software-development".into()),
            cli: "claude-code".into(),
            ..task(id, "claude-code", Some("software-development"))
        })
        .collect();
    let mut per = HashMap::new();
    per.insert("software-development".to_string(), 3usize);

    let report = orc::run_batch(
        tasks,
        crew,
        &Limits {
            max_parallel: 3,
            per_department: per,
        },
        CancelFlag::new(),
        events,
        true,
    )
    .await;

    for id in ["backend", "frontend", "docs"] {
        let o = report.outcomes.iter().find(|o| o.task_id == id).unwrap();
        assert_eq!(o.state, TaskState::Completed, "{id}: {:?}", o.error);
        let integ = o.integration.as_ref().expect("worktree artifact");
        assert_eq!(integ.branch, format!("yuppy/task-{id}"));
        assert!(integ.committed);
    }

    // The collision the integration agent is told about, with real paths.
    assert_eq!(
        report.conflicts,
        vec![(
            "backend".to_string(),
            "frontend".to_string(),
            "README.md".to_string()
        )],
        "{:?}",
        report.conflicts
    );

    // Each review branch holds only its own agent's files.
    for id in ["backend", "frontend", "docs"] {
        let listing = git(
            &repo,
            &[
                "-c",
                "core.quotePath=false",
                "show",
                "--name-only",
                "--format=",
                &format!("yuppy/task-{id}"),
            ],
        )
        .await;
        let files: Vec<&str> = listing.lines().filter(|l| !l.trim().is_empty()).collect();
        match id {
            "backend" => assert_eq!(files, vec!["README.md", "api.rs"], "{files:?}"),
            "frontend" => assert_eq!(files, vec!["README.md", "panel.tsx"], "{files:?}"),
            _ => assert_eq!(files, vec!["docs/Türkçe rehber.md"], "{files:?}"),
        }
    }

    // The user's checkout is untouched by all of it.
    assert!(
        git(&repo, &["status", "--porcelain"])
            .await
            .trim()
            .is_empty()
    );
    let _ = std::fs::remove_dir_all(&repo);
}
