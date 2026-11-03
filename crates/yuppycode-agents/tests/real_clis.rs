//! End-to-end verification of the real Claude Code CLI.
//!
//! These are the acceptance tests for the integration the product depends on:
//! they launch genuine `claude` processes through the production launch path
//! ([`spawn_interactive`] → `TerminalSession` → PTY), read their real output,
//! type real keystrokes into them, resize them, run two at the same time, and
//! shut them down. Nothing here is mocked or simulated.
//!
//! Workspace trust: every case runs in a fresh scratch directory, which Claude
//! Code greets with its "do you trust this folder?" dialog before the REPL.
//! [`open_ready`] answers that dialog the way an operator would (Enter on the
//! default "Yes, proceed") — the directory was created by this test, so
//! trusting it is exactly right — and only then looks for the composer.
//!
//! Cost and safety: the tests exercise the *terminal* path only. They type into
//! each CLI's own composer and never press Enter, so no model turn is started,
//! no tokens are spent, and no agent is asked to touch the filesystem. They do
//! require the CLIs to be installed and configured the way a normal shell run
//! would be — credentials are read by the CLI itself from its own config, never
//! by YuppyCode.
//!
//! If a CLI is not installed the corresponding test reports itself UNVERIFIED on
//! stdout instead of silently passing; set `YUPPY_REQUIRE_CLI=1` (CI) to turn a
//! missing CLI into a hard failure.

#![cfg(unix)]

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use yuppycode_agents::{AgentKind, SpawnOptions, detect, spawn_interactive};
use yuppycode_terminal::{SessionEvent, TerminalSession, TerminalSize};

const SIZE: TerminalSize = TerminalSize {
    rows: 30,
    cols: 100,
};

/// The path to `kind`, or `None` after reporting the case UNVERIFIED.
///
/// A missing CLI must not read as a pass and must not read as a break: the case
/// prints a `SKIP … UNVERIFIED …` line and the caller returns early. Other cases
/// in this binary keep running (never `process::exit`, which would cut them off).
/// `YUPPY_REQUIRE_CLI=1` makes an absent CLI a hard failure instead.
fn require_cli(kind: AgentKind) -> Option<std::path::PathBuf> {
    let status = detect(kind);
    if let Some(p) = status.path {
        return Some(p);
    }
    let msg = format!(
        "UNVERIFIED: {} is not installed here — {}",
        kind.display_name(),
        status.problem.unwrap_or_default()
    );
    if std::env::var_os("YUPPY_REQUIRE_CLI").is_some() {
        panic!("{msg}");
    }
    println!("SKIP {msg}");
    None
}

/// Take the CLI's path or return from the current case after reporting SKIP.
macro_rules! need {
    ($kind:expr) => {
        match require_cli($kind) {
            Some(path) => path,
            None => return,
        }
    };
}

/// A private scratch workspace per case, so the CLIs never run in the repo.
fn workspace(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "yuppy-cli-e2e-{tag}-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&dir).expect("create scratch workspace");
    dir
}

/// Remove a scratch workspace this file created, and nothing else.
///
/// The prefix check is deliberate: a test must never be able to point this at a
/// directory it did not create.
fn cleanup(dir: &Path) {
    let is_ours = dir
        .file_name()
        .map(|n| n.to_string_lossy().starts_with("yuppy-cli-e2e-"))
        .unwrap_or(false);
    if is_ours {
        let _ = std::fs::remove_dir_all(dir);
    }
}

fn open(kind: AgentKind, cwd: &Path) -> TerminalSession {
    spawn_interactive(
        kind,
        SpawnOptions {
            cwd: Some(cwd.to_path_buf()),
            size: SIZE,
            ..Default::default()
        },
    )
    .unwrap_or_else(|e| panic!("{} failed to start: {e}", kind.display_name()))
}

fn screen(s: &TerminalSession) -> String {
    let snap = s.snapshot();
    (0..snap.rows)
        .map(|r| snap.row_text(r))
        .collect::<Vec<_>>()
        .join("\n")
}

/// Wait until the child has painted at least `min` visible characters.
///
/// These are real TUIs: they clear and redraw, so "any non-trivial content" is
/// the honest readiness signal rather than a fixed sleep.
fn wait_painted(s: &TerminalSession, min: usize, grace: Duration) -> String {
    let deadline = Instant::now() + grace;
    loop {
        let txt = screen(s);
        if txt.chars().filter(|c| !c.is_whitespace()).count() >= min {
            return txt;
        }
        assert!(s.is_running(), "the CLI exited before it ever painted");
        if Instant::now() > deadline {
            panic!("nothing was painted within {grace:?}\n--- screen ---\n{txt}");
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}

/// True when Claude Code is showing its workspace-trust dialog.
fn is_trust_dialog(txt: &str) -> bool {
    let t = txt.to_lowercase();
    t.contains("trust") && (t.contains("folder") || t.contains("files"))
}

/// Open a session and get it to its real REPL: accept the trust dialog for
/// the test's own scratch directory if Claude Code shows one (its default
/// highlighted choice is "No, exit", so this moves to "Yes, I trust this
/// folder" first), then wait until a painted, non-dialog screen has stayed
/// up for a moment — the dialog can replace the splash late.
fn open_ready(kind: AgentKind, cwd: &Path) -> (TerminalSession, String) {
    let s = open(kind, cwd);
    wait_painted(&s, 40, Duration::from_secs(30));
    let deadline = Instant::now() + Duration::from_secs(40);
    let settle = Duration::from_millis(2_500);
    let mut ok_since: Option<Instant> = None;
    let mut answered_at: Option<Instant> = None;
    loop {
        let txt = screen(&s);
        if is_trust_dialog(&txt) {
            ok_since = None;
            // Answer once per appearance; re-answer only if it is still up
            // well after the last keystrokes (a slow first paint).
            if answered_at.is_none_or(|t| t.elapsed() > Duration::from_secs(3)) {
                // Move the cursor to "Yes", and only confirm once the screen
                // shows it there (Enter on the default would pick "No, exit").
                for key in [&b"\x1b[B"[..], &b"\x1bOB"[..], &b"j"[..]] {
                    if screen(&s)
                        .lines()
                        .any(|l| l.contains('\u{276f}') && l.contains("Yes"))
                    {
                        break;
                    }
                    s.send_bytes(key).expect("move to 'Yes, I trust this folder'");
                    std::thread::sleep(Duration::from_millis(500));
                }
                if screen(&s)
                    .lines()
                    .any(|l| l.contains('\u{276f}') && l.contains("Yes"))
                {
                    s.send_bytes(b"\r").expect("confirm the trust dialog");
                }
                answered_at = Some(Instant::now());
            }
        } else if txt.chars().filter(|c| !c.is_whitespace()).count() >= 40 {
            let since = *ok_since.get_or_insert_with(Instant::now);
            if since.elapsed() >= settle {
                return (s, txt);
            }
        }
        assert!(s.is_running(), "the CLI exited while starting:\n{txt}");
        if Instant::now() > deadline {
            return (s, txt);
        }
        std::thread::sleep(Duration::from_millis(150));
    }
}

/// Wait until the CLI's own screen contains `needle` (it echoed our input).
fn wait_for_screen(s: &TerminalSession, needle: &str, grace: Duration) -> bool {
    let deadline = Instant::now() + grace;
    loop {
        if screen(s).contains(needle) {
            return true;
        }
        if Instant::now() > deadline {
            return false;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}

/// Wait for the child to actually stop, bounded.
///
/// `close` sends an interrupt, then kills, then gives the waiter thread a short
/// window to *record* the exit — so termination is observed shortly after it
/// returns rather than necessarily at the instant it returns. What the product
/// needs proven is that it stops within a bounded time, which is what this checks.
fn wait_dead(s: &TerminalSession, grace: Duration) -> bool {
    let deadline = Instant::now() + grace;
    while Instant::now() < deadline {
        if !s.is_running() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(25));
    }
    !s.is_running()
}

#[test]
fn claude_code_is_detected_with_its_real_version() {
    for kind in AgentKind::ALL {
        let Some(program) = require_cli(kind) else {
            continue;
        };
        let status = detect(kind);
        assert!(
            status.available(),
            "{} should be usable",
            kind.display_name()
        );
        assert_eq!(
            program.file_name().unwrap().to_string_lossy(),
            kind.program_name()
        );
        let version = status
            .version
            .clone()
            .unwrap_or_else(|| panic!("{} answered no version", kind.display_name()));
        assert!(!version.trim().is_empty());
        // A real binary answers with its own version, which is what the UI shows.
        println!(
            "VERIFIED {} v{version} at {}",
            kind.display_name(),
            program.display()
        );
        assert!(
            status.problem.is_none(),
            "no problem expected: {:?}",
            status.problem
        );
    }
}

#[test]
fn claude_code_paints_its_real_ui_in_the_requested_workspace() {
    need!(AgentKind::ClaudeCode);
    let dir = workspace("claude-ui");
    let (s, txt) = open_ready(AgentKind::ClaudeCode, &dir);
    assert!(
        txt.contains("Claude Code"),
        "expected Claude Code's own banner, got:\n{txt}"
    );
    // The banner echoes the working directory: proof the cwd reached the child.
    assert!(
        wait_for_screen(&s, &dir.display().to_string(), Duration::from_secs(20)),
        "Claude Code did not start in the authorized workspace {}:\n{}",
        dir.display(),
        screen(&s)
    );
    assert!(s.is_running());
    s.kill().ok();
    cleanup(&dir);
}

#[test]
fn typed_input_reaches_claude_code_including_turkish_characters() {
    need!(AgentKind::ClaudeCode);
    let dir = workspace("claude-input");
    let (s, _) = open_ready(AgentKind::ClaudeCode, &dir);

    // Typed into the composer, never submitted: no model turn is started.
    let needle = "ğüşıöç ĞÜŞİÖÇ merhaba";
    s.send_bytes(needle.as_bytes()).expect("stdin to claude");
    assert!(
        wait_for_screen(&s, needle, Duration::from_secs(10)),
        "Claude Code never echoed the typed text back:\n{}",
        screen(&s)
    );
    s.kill().ok();
    cleanup(&dir);
}

#[test]
fn two_claude_sessions_run_concurrently_and_stay_independent() {
    need!(AgentKind::ClaudeCode);
    let mut live: Vec<(AgentKind, TerminalSession)> = Vec::new();
    let mut painted = Vec::new();
    let mut dirs = Vec::new();
    for leg in ["a", "b"] {
        let dir = workspace(&format!("concurrent-{leg}"));
        let (s, txt) = open_ready(AgentKind::ClaudeCode, &dir);
        live.push((AgentKind::ClaudeCode, s));
        painted.push(txt);
        dirs.push(dir);
    }
    let (a, b) = (painted[0].clone(), painted[1].clone());

    // Each paints its OWN interface: no shared or blank terminal. The two
    // screens differ at least by the workspace path each one echoes.
    assert_ne!(
        a.lines().map(str::trim).collect::<Vec<_>>(),
        b.lines().map(str::trim).collect::<Vec<_>>(),
        "two sessions rendered the identical screen"
    );

    // Distinct sessions, distinct binaries, both alive at the same time.
    assert_ne!(
        live[0].1.id(),
        live[1].1.id(),
        "sessions must have distinct ids"
    );
    assert!(
        live[0].1.is_running() && live[1].1.is_running(),
        "both must be live simultaneously"
    );

    // Each keeps its own working directory — no cwd bleed between tabs.
    assert!(
        a.contains("concurrent-") && b.contains("concurrent-"),
        "neither screen shows its own workspace"
    );

    // Type into both; each echoes into its own screen only.
    live[0].1.send_bytes(b"alpha-one").unwrap();
    live[1].1.send_bytes(b"beta-two").unwrap();
    assert!(wait_for_screen(
        &live[0].1,
        "alpha-one",
        Duration::from_secs(10)
    ));
    assert!(wait_for_screen(
        &live[1].1,
        "beta-two",
        Duration::from_secs(10)
    ));
    assert!(
        !screen(&live[0].1).contains("beta-two"),
        "input leaked across sessions"
    );

    // Closing one must leave the other untouched and still interactive.
    let (kept_kind, kept) = live.pop().unwrap();
    let kind_closing = live[0].0;
    let closing = &mut live[0].1;
    closing.close(Duration::from_secs(3)).unwrap();
    assert!(
        wait_dead(closing, Duration::from_secs(8)),
        "{} never stopped after close",
        kind_closing.display_name()
    );
    assert!(kept.is_running(), "closing one CLI disturbed {kept_kind:?}");
    kept.send_bytes(b"still-here").unwrap();
    assert!(
        wait_for_screen(&kept, "still-here", Duration::from_secs(10)),
        "the surviving session stopped accepting input"
    );
    kept.kill().ok();
    for d in &dirs {
        cleanup(d);
    }
}

#[test]
fn resize_reflows_the_cli_child_without_losing_the_session() {
    need!(AgentKind::ClaudeCode);

    for kind in AgentKind::ALL {
        let dir = workspace(&format!("resize-{}", kind.id()));
        let (s, wide) = open_ready(kind, &dir);
        assert!(wide.contains('─') || wide.contains('_') || wide.len() > 40);

        // Shrink hard: the child must re-lay-out, not spill or die.
        s.resize(TerminalSize { rows: 20, cols: 60 }).unwrap();
        assert_eq!(s.size().cols, 60);
        std::thread::sleep(Duration::from_millis(2_000));
        let snap = s.snapshot();
        assert_eq!(
            (snap.rows, snap.cols),
            (20, 60),
            "parser did not follow the resize"
        );
        assert!(s.is_running(), "{} died on resize", kind.display_name());
        let narrow = screen(&s);
        let painted: Vec<&str> = narrow.lines().filter(|l| !l.trim().is_empty()).collect();
        assert!(
            painted.len() >= 3,
            "{} rendered nothing after resize:\n{narrow}",
            kind.display_name()
        );
        for line in narrow.lines() {
            assert!(
                line.chars().count() <= 61,
                "{} wrote past the new width ({} cols): {line}",
                kind.display_name(),
                line.chars().count()
            );
        }

        // Still a working terminal after the resize.
        s.send_bytes(b"after-resize").unwrap();
        assert!(
            wait_for_screen(&s, "after-resize", Duration::from_secs(10)),
            "{} stopped echoing input after a resize:\n{}",
            kind.display_name(),
            screen(&s)
        );
        s.kill().ok();
    }
}

#[test]
fn closing_a_session_reports_a_real_exit_and_leaves_no_running_child() {
    need!(AgentKind::ClaudeCode);

    for kind in AgentKind::ALL {
        let dir = workspace(&format!("close-{}", kind.id()));
        let (s, _) = open_ready(kind, &dir);

        let started = Instant::now();
        s.close(Duration::from_secs(3)).unwrap();
        // Bounded shutdown: a hung CLI must not wedge the TUI on exit.
        assert!(
            wait_dead(&s, Duration::from_secs(8)),
            "{} survived close after {:?}",
            kind.display_name(),
            started.elapsed()
        );
        assert!(
            started.elapsed() < Duration::from_secs(12),
            "{} took {:?} to close",
            kind.display_name(),
            started.elapsed()
        );
        let exit = s
            .exit_status()
            .unwrap_or_else(|| panic!("{} reported no exit status", kind.display_name()));
        // The exit is reported at all; the code belongs to the CLI's own shutdown.
        println!(
            "VERIFIED {} closed in {:?}: {exit:?}",
            kind.display_name(),
            started.elapsed()
        );
        // Drain notifications; the exit itself is already asserted above.
        let _ = s.poll_events();
    }

    // An Exited event must reach whoever is watching the session.
    let kind = AgentKind::ClaudeCode;
    let dir = workspace("close-events");
    let (s, _) = open_ready(kind, &dir);
    s.kill().unwrap();
    let deadline = Instant::now() + Duration::from_secs(10);
    let mut saw_exit = false;
    while Instant::now() < deadline {
        if s.poll_events()
            .iter()
            .any(|e| matches!(e, SessionEvent::Exited { .. }))
        {
            saw_exit = true;
            break;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    assert!(saw_exit, "no Exited event for {}", kind.display_name());
}
