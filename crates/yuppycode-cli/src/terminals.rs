//! Manager for the live CLI terminal sessions the bridge hosts.
//!
//! Each managed session is one real child process in its own PTY with its
//! own lifecycle: opened, resized, written to and closed independently. Raw
//! output wakes the bridge through a channel; nothing here renders or polls.
//! The UI owns everything a human sees (dialog detection, layout, labels).

use std::path::PathBuf;
use std::sync::mpsc::Sender;

use yuppycode_agents::{AgentKind, SpawnOptions, spawn_interactive};
use yuppycode_terminal::{SessionExit, TerminalSession, TerminalSize};

/// Wake-up sent by a session's output thread. Carries the session id; the
/// bridge forwards it to the client so it can push a fresh screen.
#[derive(Debug, Clone)]
pub enum TerminalEvent {
    /// A hosted CLI session produced output or changed state.
    Activity(u64),
}

/// One live (or recently exited) CLI session.
pub struct ManagedTerminal {
    pub kind: AgentKind,
    pub session: TerminalSession,
}

/// The bridge's set of hosted sessions. Owned by the bridge state; clients
/// only receive cheap snapshots of it.
pub struct TerminalManager {
    items: Vec<ManagedTerminal>,
    /// Index of the session the next `close_active_with_exit` acts on.
    pub active: usize,
    default_cwd: Option<PathBuf>,
    last_pane: Option<TerminalSize>,
}

impl TerminalManager {
    pub fn new(default_cwd: Option<PathBuf>) -> Self {
        Self {
            items: Vec::new(),
            active: 0,
            default_cwd,
            last_pane: None,
        }
    }

    pub fn len(&self) -> usize {
        self.items.len()
    }

    pub fn active_session(&self) -> Option<&TerminalSession> {
        self.items.get(self.active).map(|m| &m.session)
    }

    /// Spawn a new CLI session with `extra_args` passed verbatim to the
    /// native CLI, make it active, and wire its wake pump into `wake_tx`.
    /// Returns the session's display label.
    pub fn open_with_args(
        &mut self,
        kind: AgentKind,
        wake_tx: &Sender<TerminalEvent>,
        extra_args: Vec<String>,
    ) -> Result<String, String> {
        let size = self
            .last_pane
            .unwrap_or(TerminalSize { rows: 24, cols: 80 });
        let session = spawn_interactive(
            kind,
            SpawnOptions {
                cwd: self.default_cwd.clone(),
                size,
                extra_args,
                ..Default::default()
            },
        )
        .map_err(|e| e.to_string())?;
        self.push(kind, session, wake_tx);
        Ok(self.label_for(self.active))
    }

    /// Track an already-spawned session and forward its output wakes.
    fn push(&mut self, kind: AgentKind, session: TerminalSession, wake_tx: &Sender<TerminalEvent>) {
        let id = session.id();
        if let Some(wake) = session.take_output_wake() {
            let tx = wake_tx.clone();
            std::thread::spawn(move || {
                while wake.recv().is_ok() {
                    if tx.send(TerminalEvent::Activity(id.0)).is_err() {
                        break;
                    }
                }
            });
        }
        self.items.push(ManagedTerminal { kind, session });
        self.active = self.items.len() - 1;
    }

    /// Display label for one session, numbered only when the same CLI kind
    /// has several sessions open ("Claude Code #2").
    pub fn label_for(&self, idx: usize) -> String {
        let Some(m) = self.items.get(idx) else {
            return "unknown".into();
        };
        let name = m.kind.display_name().to_string();
        let same: Vec<usize> = (0..self.items.len())
            .filter(|&i| self.items[i].kind == m.kind)
            .collect();
        if same.len() > 1 {
            let n = same.iter().position(|&i| i == idx).unwrap_or(0) + 1;
            format!("{name} #{n}")
        } else {
            name
        }
    }

    /// Close the active session and return its final exit status when the
    /// waiter thread recorded one. The bridge uses this to send an honest
    /// `TerminalClosed` payload instead of inventing an exit code.
    pub fn close_active_with_exit(&mut self) -> Option<(AgentKind, Option<SessionExit>)> {
        if self.items.is_empty() {
            return None;
        }
        let m = self.items.remove(self.active);
        m.session.close(std::time::Duration::from_millis(300)).ok();
        let exit = m.session.exit_status();
        if self.active >= self.items.len() {
            self.active = self.items.len().saturating_sub(1);
        }
        Some((m.kind, exit))
    }

    /// Close and remove every session.
    ///
    /// The bridge serves one client at a time and the UI starts from an empty
    /// session list on every connection. Seats opened for the previous client
    /// are therefore unreachable — leaving them alive leaks one Claude
    /// process and its PTY master per reconnect. `kill` is used instead of the
    /// graceful `close` so a long roster cannot stall the accept loop.
    pub fn close_all(&mut self) {
        self.active = 0;
        for m in std::mem::take(&mut self.items) {
            let _ = m.session.kill();
            // Dropping the session closes the PTY master and every clone the
            // reader/writer threads held.
            drop(m);
        }
    }

    /// Keep every session's PTY geometry in sync with the client's pane.
    pub fn note_pane_size(&mut self, size: TerminalSize) {
        if self.last_pane == Some(size) {
            return;
        }
        self.last_pane = Some(size);
        for m in &self.items {
            if m.session.is_running() && m.session.size() != size {
                let _ = m.session.resize(size);
            }
        }
    }

    pub fn iter(&self) -> impl Iterator<Item = &ManagedTerminal> {
        self.items.iter()
    }
}

impl Drop for TerminalManager {
    fn drop(&mut self) {
        // Belt-and-braces: TerminalSession::Drop kills individually, this
        // just sequences shutdown visibly for the reader.
        for m in &self.items {
            let _ = m.session.kill();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;
    use std::time::{Duration, Instant};
    use yuppycode_terminal::SessionConfig;

    fn bash(mgr: &mut TerminalManager, tag: &str, tx: &Sender<TerminalEvent>) {
        let mut cfg = SessionConfig::new(tag, "/bin/bash");
        cfg.size = mgr.last_pane.unwrap_or(TerminalSize { rows: 12, cols: 60 });
        let session = TerminalSession::spawn(cfg).expect("spawn bash PTY");
        mgr.push(AgentKind::ClaudeCode, session, tx);
    }

    fn screen_text(mgr: &TerminalManager) -> String {
        let snap = mgr.active_session().unwrap().snapshot();
        (0..snap.rows)
            .map(|r| snap.row_text(r))
            .collect::<Vec<_>>()
            .join("\n")
    }

    fn wait_for(mgr: &TerminalManager, find: &str) -> bool {
        let deadline = Instant::now() + Duration::from_secs(5);
        while Instant::now() < deadline {
            if screen_text(mgr).contains(find) {
                return true;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        false
    }

    /// A real bash PTY session receives input, its output appears in the
    /// snapshot, and the output thread wakes the bridge with its id. This
    /// verifies the plumbing without requiring Claude authentication.
    #[test]
    fn real_bash_session_receives_input_and_wakes_the_bridge() {
        let (tx, rx) = mpsc::channel::<TerminalEvent>();
        let mut mgr = TerminalManager::new(None);
        mgr.note_pane_size(TerminalSize { rows: 12, cols: 40 });
        bash(&mut mgr, "bash-test", &tx);
        let sid = mgr.active_session().unwrap().id().0;

        let marker = "YUPPY_BRIDGE_TEST_MARKER";
        mgr.active_session()
            .unwrap()
            .send_bytes(format!("echo {marker}\r").as_bytes())
            .expect("send input");
        assert!(wait_for(&mgr, marker), "bash output did not reach the snapshot");
        let TerminalEvent::Activity(id) = rx
            .recv_timeout(Duration::from_secs(5))
            .expect("an output wake");
        assert_eq!(id, sid);
    }

    /// The delete path the operator actually uses: keystroke bytes (DEL for
    /// Backspace, as xterm.js sends it) go into a real PTY, and a Backspace
    /// must remove the character the CLI echoed. Regression guard for "I
    /// can't delete what I typed in the prompt".
    #[test]
    fn backspace_deletes_the_echoed_text_in_a_real_cli_session() {
        let (tx, _rx) = mpsc::channel::<TerminalEvent>();
        let mut mgr = TerminalManager::new(None);
        bash(&mut mgr, "bash-delete", &tx);
        let press = |mgr: &TerminalManager, bytes: &[u8]| {
            mgr.active_session()
                .unwrap()
                .send_bytes(bytes)
                .expect("send to PTY");
        };

        assert!(
            wait_for(&mgr, "$") || wait_for(&mgr, "#"),
            "bash never printed a prompt"
        );
        for c in "YUPPY_DEL".chars() {
            press(&mgr, c.to_string().as_bytes());
        }
        assert!(
            wait_for(&mgr, "YUPPY_DEL"),
            "typed text never reached the CLI screen:\n{}",
            screen_text(&mgr)
        );
        for _ in 0..3 {
            press(&mgr, b"\x7f");
            std::thread::sleep(Duration::from_millis(80));
        }
        let deadline = Instant::now() + Duration::from_secs(5);
        let mut deleted = false;
        while Instant::now() < deadline {
            let text = screen_text(&mgr);
            if !text.contains("YUPPY_DEL") && text.contains("YUPPY_") {
                deleted = true;
                break;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        assert!(
            deleted,
            "backspace did not delete in the hosted CLI; screen still shows:\n{}",
            screen_text(&mgr)
        );
    }

    /// A reconnecting bridge client starts from an empty session list, so no
    /// seat may outlive the connection it was opened for — otherwise every
    /// reconnect leaks a CLI process and its PTY master.
    #[test]
    fn close_all_releases_every_session() {
        let (tx, _rx) = mpsc::channel::<TerminalEvent>();
        let mut mgr = TerminalManager::new(None);
        for tag in ["a", "b", "c"] {
            bash(&mut mgr, tag, &tx);
        }
        assert_eq!(mgr.len(), 3);
        mgr.close_all();
        assert_eq!(mgr.len(), 0, "every session must be gone");
        assert_eq!(mgr.active, 0);
    }

    /// Closing by index removes exactly that session and keeps `active` in
    /// range; labels are numbered only while several sessions share a kind.
    #[test]
    fn close_active_removes_one_session_and_labels_renumber() {
        let (tx, _rx) = mpsc::channel::<TerminalEvent>();
        let mut mgr = TerminalManager::new(None);
        assert_eq!(mgr.label_for(0), "unknown");
        bash(&mut mgr, "one", &tx);
        assert_eq!(mgr.label_for(0), "Claude Code");
        bash(&mut mgr, "two", &tx);
        assert_eq!(mgr.label_for(0), "Claude Code #1");
        assert_eq!(mgr.label_for(1), "Claude Code #2");

        let keep = mgr.iter().next().unwrap().session.id().0;
        assert_eq!(mgr.active, 1);
        let (kind, _) = mgr.close_active_with_exit().expect("closed");
        assert_eq!(kind, AgentKind::ClaudeCode);
        assert_eq!(mgr.len(), 1);
        assert_eq!(mgr.active, 0);
        assert_eq!(mgr.active_session().unwrap().id().0, keep);
        assert_eq!(mgr.label_for(0), "Claude Code");
    }

    /// Two real Claude Code seats spawn side by side through the manager and
    /// both paint. Skipped (loudly) when Claude Code is not installed.
    #[test]
    fn real_claude_seats_spawn_concurrently() {
        if yuppycode_agents::which(AgentKind::ClaudeCode.program_name()).is_none() {
            if std::env::var_os("YUPPY_REQUIRE_CLI").is_some() {
                panic!("Claude Code required but not installed");
            }
            println!("SKIP UNVERIFIED: Claude Code not installed");
            return;
        }
        let (tx, _rx) = mpsc::channel::<TerminalEvent>();
        let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
        let mut mgr = TerminalManager::new(Some(cwd));
        mgr.note_pane_size(TerminalSize { rows: 24, cols: 80 });
        for _ in 0..2 {
            let opened = mgr.open_with_args(AgentKind::ClaudeCode, &tx, Vec::new());
            assert!(opened.is_ok(), "claude spawn failed: {opened:?}");
        }
        assert_eq!(mgr.len(), 2);
        for (i, m) in mgr.iter().enumerate() {
            let deadline = Instant::now() + Duration::from_secs(20);
            loop {
                let snap = m.session.snapshot();
                if (0..snap.rows).any(|r| !snap.row_text(r).trim().is_empty()) {
                    break;
                }
                assert!(m.session.is_running(), "session {i} exited before painting");
                assert!(Instant::now() < deadline, "session {i} never painted anything");
                std::thread::sleep(Duration::from_millis(200));
            }
        }
        mgr.close_all();
        assert_eq!(mgr.len(), 0);
    }
}
