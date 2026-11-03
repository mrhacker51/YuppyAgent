//! Milestone B acceptance tests: real PTY behavior on Unix.
//!
//! These spawn genuine processes (`/bin/sh`) inside real PTYs — no mocks.

use std::path::PathBuf;
use std::time::{Duration, Instant};

use yuppycode_terminal::{SessionConfig, SessionEvent, TerminalSession, TerminalSize};

fn sh(label: &str, script: &str) -> TerminalSession {
    let mut cfg = SessionConfig::new(label, PathBuf::from("/bin/sh"));
    cfg.args = vec!["-c".into(), script.into()];
    cfg.cwd = Some(std::env::temp_dir());
    TerminalSession::spawn(cfg).expect("spawn sh in pty")
}

fn wait_until(session: &TerminalSession, what: &str, pred: impl Fn(&TerminalSession) -> bool) {
    let deadline = Instant::now() + Duration::from_secs(10);
    while Instant::now() < deadline {
        if pred(session) {
            return;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    let snap = session.snapshot();
    panic!(
        "timeout waiting for {what}\n--- screen ---\n{}",
        (0..snap.rows)
            .map(|r| snap.row_text(r))
            .collect::<Vec<_>>()
            .join("\n")
    );
}

fn grid_contains(session: &TerminalSession, needle: &str) -> bool {
    let snap = session.snapshot();
    (0..snap.rows).any(|r| snap.row_text(r).contains(needle))
}

#[test]
fn program_output_reaches_screen_and_exit_is_reported() {
    let s = sh("echo", "printf 'hello-pty\\n'");
    wait_until(&s, "exit event", |s| {
        s.poll_events()
            .iter()
            .any(|e| matches!(e, SessionEvent::Exited { .. }))
    });
    assert!(s.exit_status().unwrap().success);
    wait_until(&s, "output on screen", |s| grid_contains(s, "hello-pty"));
}

#[test]
fn input_is_forwarded_verbatim() {
    // `cat` echoes stdin: what we type must come back through the PTY.
    let s = sh("cat", "exec cat");
    s.send_bytes(b"typed-through-pty\r").unwrap();
    wait_until(&s, "echo of input", |s| {
        grid_contains(s, "typed-through-pty")
    });
    s.close(Duration::from_millis(200)).unwrap();
}

#[test]
fn resize_reaches_the_child_via_winsize() {
    let mut cfg = SessionConfig::new("stty", PathBuf::from("/bin/sh"));
    cfg.args = vec!["-c".into(), "exec sh".into()];
    cfg.size = TerminalSize { rows: 24, cols: 80 };
    let s = TerminalSession::spawn(cfg).unwrap();
    // Give the shell a moment, then resize and ask it what it sees.
    std::thread::sleep(Duration::from_millis(150));
    s.resize(TerminalSize {
        rows: 40,
        cols: 100,
    })
    .unwrap();
    assert_eq!(s.size().rows, 40);
    s.send_bytes(b"stty size\r").unwrap();
    wait_until(&s, "stty reporting new size", |s| {
        grid_contains(s, "40 100")
    });
    s.close(Duration::from_millis(300)).unwrap();
}

#[test]
fn ansi_attributes_survive_the_emulator() {
    // Red 'X' then reset.
    let s = sh("color", "printf '\\033[31mX\\033[0m\\n'");
    wait_until(&s, "red X", |s| {
        let snap = s.snapshot();
        snap.cell(0, 0)
            .is_some_and(|c| c.ch == "X" && c.fg == yuppycode_terminal::Color::Indexed(1))
    });
}

#[test]
fn kill_produces_an_exit_event_with_signal_or_code() {
    let s = sh("sleepy", "sleep 30");
    std::thread::sleep(Duration::from_millis(150));
    assert!(s.is_running());
    s.kill().unwrap();
    wait_until(&s, "Exited after kill", |s| s.exit_status().is_some());
    let exit = s.exit_status().unwrap();
    assert!(!exit.success, "killed process must not report success");
    assert!(
        exit.signal.is_some() || exit.exit_code.unwrap_or(0) != 0,
        "expected signal or non-zero code, got {exit:?}"
    );
}

#[test]
fn wide_glyphs_mark_continuation_cells() {
    let s = sh("wide", "printf 'あA\\n'");
    wait_until(&s, "wide glyph", |s| {
        let snap = s.snapshot();
        snap.cell(0, 0).is_some_and(|c| c.ch == "あ")
            && snap.cell(0, 1).is_some_and(|c| c.wide_continuation)
            && snap.cell(0, 2).is_some_and(|c| c.ch == "A")
    });
}

#[test]
fn generation_only_advances_with_output() {
    let s = sh("idle", "sleep 5");
    let g1 = s.generation();
    std::thread::sleep(Duration::from_millis(300));
    assert_eq!(g1, s.generation(), "idle session must not bump generation");
    s.send_bytes(b"\n").unwrap(); // echo from the tty itself bumps it
    wait_until(&s, "generation bump after input", |s| s.generation() > g1);
    s.close(Duration::from_millis(200)).unwrap();
}

#[test]
fn writing_to_an_exited_session_is_a_clear_error() {
    let s = sh("bye", "exit 3");
    wait_until(&s, "exit", |s| s.exit_status().is_some());
    let exit = s.exit_status().unwrap();
    assert_eq!(exit.exit_code, Some(3));
    assert!(!exit.success);
    let err = s.send_bytes(b"x").unwrap_err();
    assert!(matches!(err, yuppycode_terminal::TerminalError::Closed(_)));
}
