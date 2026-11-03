//! Contract tests for [`ProcessTaskRunner`] — the code that actually launches
//! headless `claude -p … --output-format stream-json` workers as child processes.
//!
//! These tests do NOT mock the runner: they run genuine child processes through
//! the production `ProcessTaskRunner::run`, using a small shell stub standing in
//! for the CLI binary. That keeps the real spawn/stdin/stdout/stderr/exit-code/
//! timeout/cancellation path under test while staying independent of the model
//! behind each CLI (no API calls, no credentials, no network).
//!
//! What they pin down, because a redesign of the TUI must not change it silently:
//!   * the exact argv each CLI is launched with,
//!   * that the child runs in the requested working directory,
//!   * that stdout *and* stderr both reach the report tail,
//!   * that only a zero exit counts as success,
//!   * that timeout and cancellation terminate the child (no orphans),
//!   * that a missing/broken binary fails honestly instead of pretending to run,
//!   * that several Claude workers can execute concurrently,
//!   * that stream-json output becomes live progress lines and a final report,
//!   * that team wiring still reaches the CLI.
#![cfg(unix)]

use std::collections::HashMap;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use yuppycode_orchestrator::runner::{CancelFlag, ProcessTaskRunner, RunRequest, TaskRunner};

/// Unique temp dir per test so parallel tests never share a stub or a probe file.
fn scratch(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "yuppy-runner-{tag}-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&dir).expect("create scratch dir");
    dir
}

/// Write an executable stub that behaves like a CLI for one turn.
///
/// `body` is POSIX shell; it receives the real argv the runner built, so the
/// stub can report exactly how it was invoked.
fn stub(dir: &Path, name: &str, body: &str) -> PathBuf {
    let path = dir.join(name);
    // Write to a scratch name and rename into place. Another test thread may
    // fork while this file is still open for writing; the child would inherit
    // the write descriptor, and exec of the same path then fails with
    // ETXTBSY ("Text file busy"). The executable's final path therefore never
    // has an open writer.
    let tmp = dir.join(format!(".{name}.tmp"));
    std::fs::write(&tmp, format!("#!/bin/sh\n{body}\n")).expect("write stub");
    std::fs::rename(&tmp, &path).expect("install stub");
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).expect("chmod stub");
    path
}

fn read(p: &Path) -> String {
    std::fs::read_to_string(p).unwrap_or_default()
}

/// The argv the stub recorded, one entry per line, owned.
fn argv_of(p: &Path) -> Vec<String> {
    read(p).lines().map(|s| s.to_string()).collect()
}

fn runner_with(programs: &[(&str, PathBuf)]) -> ProcessTaskRunner {
    let mut map = HashMap::new();
    for (id, path) in programs {
        map.insert((*id).to_string(), path.clone());
    }
    ProcessTaskRunner::new(map)
}

fn req<'a>(
    task_id: &'a str,
    cli: &'a str,
    prompt: &'a str,
    workdir: &'a Path,
    timeout: Duration,
) -> RunRequest<'a> {
    RunRequest {
        task_id,
        cli,
        model: None,
        prompt,
        workdir,
        cancel: CancelFlag::new(),
        timeout,
        team: None,
        permission_mode: None,
        output: None,
    }
}

/// The headless prefix every Claude worker is launched with.
const HEADLESS: [&str; 3] = ["--output-format", "stream-json", "--verbose"];

fn headless(prompt: &str, rest: &[&str]) -> Vec<String> {
    let mut v = vec!["-p".to_string(), prompt.to_string()];
    v.extend(HEADLESS.iter().map(|s| s.to_string()));
    v.extend(rest.iter().map(|s| s.to_string()));
    v
}

/// Collects `(task_id, line)` progress callbacks.
fn output_log() -> (
    yuppycode_orchestrator::OutputEvents,
    Arc<std::sync::Mutex<Vec<(String, String)>>>,
) {
    let log = Arc::new(std::sync::Mutex::new(Vec::new()));
    let sink = Arc::clone(&log);
    (
        Arc::new(move |id: &str, line: &str| {
            sink.lock().unwrap().push((id.to_string(), line.to_string()))
        }),
        log,
    )
}

/// Is this pid still alive?
fn alive(pid: u32) -> bool {
    std::process::Command::new("/bin/kill")
        .args(["-0", &pid.to_string()])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

/// Wait for the child to die, yielding to the runtime each poll.
///
/// `kill_on_drop` hands the kill to tokio's process driver rather than reaping
/// the child inline, so a *blocking* wait here would starve the very mechanism
/// under test. The supervisor runs on a multi-thread runtime that keeps driving
/// it; these tests match that with `flavor = "multi_thread"` plus an await.
async fn wait_for_death(pid: u32, grace: Duration) -> bool {
    let deadline = Instant::now() + grace;
    while Instant::now() < deadline {
        if !alive(pid) {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    !alive(pid)
}

// ─────────────────────────── argv contracts ───────────────────────────

#[tokio::test]
async fn claude_code_is_launched_headless_with_stream_json() {
    let dir = scratch("claude-argv");
    let out = dir.join("argv");
    let program = stub(
        &dir,
        "claude-stub",
        &format!("printf '%s\\n' \"$@\" > '{}'", out.display()),
    );
    let runner = runner_with(&[("claude-code", program)]);

    let report = runner
        .run(req(
            "t-claude",
            "claude-code",
            "fix the bug",
            &dir,
            Duration::from_secs(30),
        ))
        .await
        .expect("claude turn runs");

    assert_eq!(
        argv_of(&out),
        headless("fix the bug", &[]),
        "a worker must be launched as `claude -p <prompt> --output-format \
         stream-json --verbose` and nothing else (no permission flag when none is set)"
    );
    assert!(report.success);
    assert_eq!(report.exit_code, Some(0));
}

#[tokio::test]
async fn the_department_permission_mode_is_passed_through() {
    let dir = scratch("perm-mode");
    let out = dir.join("argv");
    let program = stub(
        &dir,
        "claude-stub",
        &format!("printf '%s\\n' \"$@\" > '{}'", out.display()),
    );
    let runner = runner_with(&[("claude-code", program)]);

    for (mode, tail) in [
        (Some("acceptEdits"), vec!["--permission-mode", "acceptEdits"]),
        (
            Some("bypassPermissions"),
            vec!["--permission-mode", "bypassPermissions"],
        ),
        (Some("default"), vec![]),
        (Some("not-a-mode"), vec![]),
    ] {
        let mut r = req("t-pm", "claude-code", "edit it", &dir, Duration::from_secs(30));
        r.permission_mode = mode;
        runner.run(r).await.expect("turn runs");
        assert_eq!(argv_of(&out), headless("edit it", &tail), "{mode:?}");
    }
}

#[tokio::test]
async fn an_unknown_cli_id_is_rejected_before_any_spawn() {
    let dir = scratch("unknown-cli");
    let out = dir.join("argv");
    let program = stub(
        &dir,
        "stub",
        &format!("printf '%s\\n' \"$@\" > '{}'", out.display()),
    );
    // Only claude-code is configured; asking for another engine must not run it.
    let runner = runner_with(&[("claude-code", program)]);

    let err = runner
        .run(req("t-x", "gemini", "hi", &dir, Duration::from_secs(5)))
        .await
        .expect_err("an unconfigured CLI must fail");
    assert!(matches!(err, yuppycode_orchestrator::RunnerError::Spawn(_)));
    assert!(
        !out.exists(),
        "no child process may be spawned for an unknown CLI"
    );
}

#[tokio::test]
async fn a_selected_model_is_passed_as_a_model_flag() {
    let dir = scratch("model-flag");
    let out = dir.join("argv");
    let program = stub(
        &dir,
        "stub",
        &format!("printf '%s\\n' \"$@\" > '{}'", out.display()),
    );
    let runner = runner_with(&[("claude-code", program)]);

    let mut r = req("t-m", "claude-code", "go", &dir, Duration::from_secs(30));
    r.model = Some("opus");
    runner.run(r).await.expect("turn runs");

    assert_eq!(argv_of(&out), headless("go", &["--model", "opus"]));
}

#[tokio::test]
async fn unicode_and_turkish_prompts_reach_the_child_intact() {
    let dir = scratch("unicode");
    let out = dir.join("argv");
    let program = stub(
        &dir,
        "stub",
        &format!("printf '%s\\n' \"$@\" > '{}'", out.display()),
    );
    let runner = runner_with(&[("claude-code", program)]);

    let prompt = "İşlemi tamamla — ğüşıöç ĞÜŞİÖÇ “tırnak” 你好 🚀";
    runner
        .run(req("t-u", "claude-code", prompt, &dir, Duration::from_secs(30)))
        .await
        .expect("turn runs");

    let argv = argv_of(&out);
    // `-p <prompt> --output-format stream-json --verbose`
    assert_eq!(argv.len(), 5, "the prompt must arrive as ONE argv entry: {argv:?}");
    assert_eq!(argv[1], prompt, "Turkish/unicode prompt was mangled");
}

// ─────────────────────── output / exit-code semantics ───────────────────────

#[tokio::test]
async fn stdout_and_stderr_both_reach_the_report_tail() {
    let dir = scratch("streams");
    let program = stub(
        &dir,
        "stub",
        "echo OUT-SENTINEL\necho ERR-SENTINEL >&2\nexit 0",
    );
    let runner = runner_with(&[("claude-code", program)]);

    let report = runner
        .run(req(
            "t-s",
            "claude-code",
            "go",
            &dir,
            Duration::from_secs(30),
        ))
        .await
        .expect("turn runs");

    assert!(report.success);
    assert!(
        report.output_tail.contains("OUT-SENTINEL"),
        "stdout lost: {:?}",
        report.output_tail
    );
    assert!(
        report.output_tail.contains("ERR-SENTINEL"),
        "stderr lost: {:?}",
        report.output_tail
    );
}

#[tokio::test]
async fn a_nonzero_exit_never_reports_success() {
    let dir = scratch("nonzero");
    let program = stub(&dir, "stub", "echo denied >&2\nexit 3");
    let runner = runner_with(&[("claude-code", program)]);

    let report = runner
        .run(req(
            "t-f",
            "claude-code",
            "go",
            &dir,
            Duration::from_secs(30),
        ))
        .await
        .expect("the turn itself completes; the CLI refused");

    assert!(
        !report.success,
        "a non-zero exit must never be reported as success"
    );
    assert_eq!(report.exit_code, Some(3));
    assert!(report.output_tail.contains("denied"));
}

#[tokio::test]
async fn the_child_runs_in_the_requested_working_directory() {
    let dir = scratch("workdir");
    let out = dir.join("cwd");
    // The child must see the task's directory, not YuppyCode's own cwd.
    let program = stub(&dir, "stub", &format!("pwd -P > '{}'", out.display()));
    let runner = runner_with(&[("claude-code", program)]);

    runner
        .run(req("t-w", "claude-code", "go", &dir, Duration::from_secs(30)))
        .await
        .expect("turn runs");

    let want = dir.canonicalize().expect("canonicalize scratch");
    assert_eq!(
        Path::new(read(&out).trim()),
        want,
        "the CLI must run in the task's working directory"
    );
}

#[tokio::test]
async fn a_child_that_cannot_start_fails_honestly() {
    let dir = scratch("spawn-fail");
    // Marked executable but not a valid program: exec fails.
    let bogus = dir.join("not-a-real-cli");
    std::fs::write(&bogus, "this is not an executable").unwrap();
    std::fs::set_permissions(&bogus, std::fs::Permissions::from_mode(0o755)).unwrap();
    let runner = runner_with(&[("claude-code", bogus)]);

    let err = runner
        .run(req(
            "t-b",
            "claude-code",
            "go",
            &dir,
            Duration::from_secs(5),
        ))
        .await
        .expect_err("a broken binary must not look like a successful turn");
    assert!(
        !format!("{err}").is_empty(),
        "the error must carry detail for the user"
    );
}

// ─────────────────────── timeout and cancellation ───────────────────────

#[tokio::test(flavor = "multi_thread")]
async fn a_hanging_turn_times_out_and_the_child_is_killed() {
    let dir = scratch("timeout");
    let pidfile = dir.join("pid");
    let program = stub(
        &dir,
        "stub",
        &format!("echo $$ > '{}'\nexec sleep 30", pidfile.display()),
    );
    let runner = runner_with(&[("claude-code", program)]);

    let started = Instant::now();
    let err = runner
        .run(req(
            "t-t",
            "claude-code",
            "go",
            &dir,
            Duration::from_millis(400),
        ))
        .await
        .expect_err("a 30s turn must not outrun a 400ms timeout");
    assert!(
        matches!(err, yuppycode_orchestrator::RunnerError::TimedOut(_)),
        "expected TimedOut, got {err:?}"
    );
    assert!(
        started.elapsed() < Duration::from_secs(10),
        "the timeout must not wait out the child's own clock"
    );

    let pid: u32 = read(&pidfile).trim().parse().expect("stub pid");
    assert!(
        wait_for_death(pid, Duration::from_secs(5)).await,
        "timed-out child {pid} survived: the TUI would leak processes"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn cancellation_stops_the_child_and_reports_failure() {
    let dir = scratch("cancel");
    let pidfile = dir.join("pid");
    let program = stub(
        &dir,
        "stub",
        &format!("echo $$ > '{}'\nexec sleep 30", pidfile.display()),
    );
    let runner = runner_with(&[("claude-code", program)]);

    let cancel = CancelFlag::new();
    // Cancel from a separate thread while the turn is awaited on this task.
    {
        let cancel = cancel.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(400));
            cancel.cancel();
        });
    }
    let r = RunRequest {
        task_id: "t-c",
        cli: "claude-code",
        model: None,
        prompt: "go",
        workdir: &dir,
        cancel,
        timeout: Duration::from_secs(60),
        team: None,
        permission_mode: None,
        output: None,
    };

    let report = runner
        .run(r)
        .await
        .expect("cancellation is an outcome, not an error");
    assert!(
        !report.success,
        "a cancelled turn must never be reported Completed"
    );
    assert_eq!(report.exit_code, None);
    assert!(report.output_tail.contains("cancelled"));

    let pid: u32 = read(&pidfile).trim().parse().expect("stub pid");
    assert!(
        wait_for_death(pid, Duration::from_secs(5)).await,
        "cancelled child {pid} kept running after the future returned"
    );
}

// ─────────────────────────── concurrency ───────────────────────────

#[tokio::test]
async fn several_claude_workers_run_concurrently_in_separate_processes() {
    let dir = scratch("concurrent");
    let shared = dir.join("log");
    // The stub marks its own start/end around a sleep and dumps its argv to a
    // file named after the prompt, so we can prove separate processes that
    // overlap in time.
    let claude = stub(
        &dir,
        "claude-stub",
        &format!(
            "printf 'start\\n' >> '{s}'; printf '%s\\n' \"$@\" > '{d}/argv-'\"$2\"; sleep 0.6; printf 'end\\n' >> '{s}'",
            s = shared.display(),
            d = dir.display()
        ),
    );
    let runner = Arc::new(runner_with(&[("claude-code", claude)]));

    let started = Instant::now();
    let work: &Path = &dir;
    let run = |id: &'static str, prompt: &'static str| {
        let r = Arc::clone(&runner);
        async move {
            let mut q = req(id, "claude-code", prompt, work, Duration::from_secs(30));
            q.permission_mode = Some("acceptEdits");
            r.run(q).await
        }
    };
    let (a, b, c) = tokio::join!(
        run("t-backend", "backend"),
        run("t-frontend", "frontend"),
        run("t-qa", "qa")
    );

    for (name, r) in [("backend", a), ("frontend", b), ("qa", c)] {
        let r = r.unwrap_or_else(|e| panic!("{name} turn: {e}"));
        assert!(r.success, "{name}");
        // Each child saw only its own prompt: no argv bleed between workers.
        assert_eq!(
            argv_of(&dir.join(format!("argv-{name}"))),
            headless(name, &["--permission-mode", "acceptEdits"])
        );
    }
    assert!(
        started.elapsed() < Duration::from_millis(1500),
        "three 0.6s turns took {:?} — they ran sequentially, not concurrently",
        started.elapsed()
    );

    let trace = read(&shared);
    assert_eq!(trace.matches("start").count(), 3, "all must have started: {trace}");
    assert_eq!(trace.matches("end").count(), 3, "all must have finished: {trace}");
}

// ─────────────────────── stream-json → live progress ───────────────────────

/// A stub that prints what a real `claude -p --output-format stream-json
/// --verbose` turn prints (trimmed): init, a tool use, text, the result.
fn stream_stub(dir: &Path, result: &str, is_error: bool, exit: i32) -> PathBuf {
    let lines = [
        r#"{"type":"system","subtype":"hook_started","hook_name":"SessionStart"}"#.to_string(),
        r#"{"type":"system","subtype":"init","model":"claude-test","tools":["Read"]}"#.to_string(),
        format!(
            r#"{{"type":"assistant","message":{{"content":[{{"type":"tool_use","name":"Read","input":{{"file_path":"{}/src/lib.rs"}}}}]}}}}"#,
            dir.canonicalize().unwrap().display()
        ),
        r#"{"type":"user","message":{"content":[{"type":"tool_result","content":"fn main() {}"}]}}"#.to_string(),
        r#"{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","input":{"command":"cargo test"}}]}}"#.to_string(),
        r#"{"type":"assistant","message":{"content":[{"type":"text","text":"Tests pass.\nDone."}]}}"#.to_string(),
        format!(
            r#"{{"type":"result","subtype":"{}","is_error":{is_error},"result":"{result}","num_turns":2,"duration_ms":1500,"total_cost_usd":0.01}}"#,
            if is_error { "error_during_execution" } else { "success" }
        ),
    ];
    let mut body = String::new();
    for l in lines {
        body.push_str(&format!("printf '%s\\n' '{}'\n", l.replace('\'', "'\\''")));
    }
    body.push_str(&format!("exit {exit}"));
    stub(dir, "claude-stream", &body)
}

#[tokio::test]
async fn stream_json_becomes_live_progress_lines_and_the_final_answer() {
    let dir = scratch("stream");
    let runner = runner_with(&[("claude-code", stream_stub(&dir, "All 12 tests pass.", false, 0))]);
    let (sink, log) = output_log();
    let mut r = req("t-live", "claude-code", "go", &dir, Duration::from_secs(30));
    r.workdir = &dir;
    r.output = Some(sink);
    let report = runner.run(r).await.expect("turn runs");

    assert!(report.success);
    assert_eq!(
        report.output_tail, "All 12 tests pass.",
        "the report carries the agent's final answer, not raw JSON"
    );
    let lines: Vec<String> = log.lock().unwrap().iter().map(|(id, l)| {
        assert_eq!(id, "t-live");
        l.clone()
    }).collect();
    assert_eq!(
        lines,
        vec![
            "● session started · claude-test",
            "● Read src/lib.rs",
            "● Bash: cargo test",
            "Tests pass. Done.",
            "✓ done · 2 turns · 1.5s · $0.0100",
        ]
    );
}

#[tokio::test]
async fn a_result_reported_as_error_is_a_failure_even_on_exit_zero() {
    let dir = scratch("stream-err");
    let runner = runner_with(&[("claude-code", stream_stub(&dir, "permission denied", true, 0))]);
    let report = runner
        .run(req("t-e", "claude-code", "go", &dir, Duration::from_secs(30)))
        .await
        .expect("turn runs");
    assert!(!report.success, "is_error must never read as success");
    assert!(report.output_tail.contains("permission denied"));
}

// ─────────────────────── team wiring stays intact ───────────────────────

fn link_for(dir: &Path, name: &str, engine: &str) -> yuppycode_agents::TeamLink {
    yuppycode_agents::TeamLink {
        server_program: PathBuf::from("/bin/true"),
        bus: dir.join("bus.sqlite"),
        name: name.into(),
        role: "Test Engineer".into(),
        task_id: "t-1".into(),
        engine: engine.into(),
        auto_allow_bus: true,
        teammates: vec!["nimbus".into()],
    }
}

#[tokio::test]
async fn claude_team_turn_keeps_mcp_brief_and_scoped_tool_grant() {
    let dir = scratch("team-claude");
    let out = dir.join("argv");
    let program = stub(
        &dir,
        "stub",
        &format!("printf '%s\\n' \"$@\" > '{}'", out.display()),
    );
    let runner = runner_with(&[("claude-code", program)]);
    let link = link_for(&dir, "atlas", "claude-code");

    let r = RunRequest {
        task_id: "t-team",
        cli: "claude-code",
        model: None,
        prompt: "do the job",
        workdir: &dir,
        cancel: CancelFlag::new(),
        timeout: Duration::from_secs(30),
        team: Some(&link),
        permission_mode: Some("acceptEdits"),
        output: None,
    };
    runner.run(r).await.expect("team turn runs");

    let argv = read(&out);
    assert!(
        argv.contains("stream-json") && argv.contains("acceptEdits"),
        "a team worker is still a headless stream-json worker:\n{argv}"
    );
    assert!(
        argv.contains("--mcp-config"),
        "the team bus must stay connected for Claude:\n{argv}"
    );
    assert!(
        argv.contains("--append-system-prompt"),
        "Claude must still receive the team brief as a flag:\n{argv}"
    );
    assert!(
        argv.contains("atlas"),
        "the member's own name must reach the child:\n{argv}"
    );
    // The grant is scoped to the YuppyCode bus tools only — never a blanket skip.
    assert!(
        argv.contains("mcp__yuppy"),
        "bus tools must be pre-allowed by scope:\n{argv}"
    );
    assert!(
        !argv.contains("--dangerously-skip-permissions"),
        "native permission handling must not be bypassed:\n{argv}"
    );
}
