//! One PTY session: a real child process attached to a real terminal.

use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, SyncSender};
use std::thread;
use std::time::Duration;

use portable_pty::{Child, CommandBuilder, MasterPty, PtySize, native_pty_system};

use crate::screen::{Color, ScreenCell, ScreenSnapshot, map_color};

static NEXT_SESSION_ID: AtomicU64 = AtomicU64::new(1);

/// Stable identity of a terminal session for the lifetime of the process.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct SessionId(pub u64);

impl SessionId {
    fn next() -> Self {
        Self(NEXT_SESSION_ID.fetch_add(1, Ordering::Relaxed))
    }
}

impl std::fmt::Display for SessionId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "term-{}", self.0)
    }
}

/// Terminal window size in cells.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TerminalSize {
    pub rows: u16,
    pub cols: u16,
}

impl Default for TerminalSize {
    fn default() -> Self {
        Self { rows: 24, cols: 80 }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum TerminalError {
    #[error("failed to open pty: {0}")]
    Pty(String),
    #[error("failed to spawn `{program}`: {message}")]
    Spawn { program: String, message: String },
    #[error("session `{0}` is closed")]
    Closed(SessionId),
    #[error(transparent)]
    Io(#[from] std::io::Error),
}

/// How to launch a session. The caller is responsible for having
/// authorized `program` and `cwd` (see crate docs, spec §9).
#[derive(Debug, Clone)]
pub struct SessionConfig {
    /// Human-readable label shown in session tabs ("Claude Code", …).
    pub label: String,
    pub program: PathBuf,
    pub args: Vec<String>,
    /// Working directory; strongly encouraged to be an authorized
    /// workspace root.
    pub cwd: Option<PathBuf>,
    /// Extra environment variables (added to the inherited environment).
    pub env: Vec<(String, String)>,
    pub size: TerminalSize,
    /// Rows of scrollback kept by the emulator (memory-bounded).
    pub scrollback: usize,
    /// `TERM` value for the child; xterm-256color matches what the
    /// vt100 emulator and Ratatui rendering both understand.
    pub term: String,
}

impl SessionConfig {
    pub fn new(label: impl Into<String>, program: impl Into<PathBuf>) -> Self {
        Self {
            label: label.into(),
            program: program.into(),
            args: Vec::new(),
            cwd: None,
            env: Vec::new(),
            size: TerminalSize::default(),
            scrollback: 2000,
            term: "xterm-256color".into(),
        }
    }
}

/// Terminal process lifecycle notification. Screen content itself is
/// polled via [`TerminalSession::generation`] + [`TerminalSession::snapshot`]
/// (coalesced, bounded by the emulator grid — no per-chunk queue).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SessionEvent {
    /// The child exited. `code` is absent when terminated by a signal.
    Exited {
        exit_code: Option<u32>,
        signal: Option<String>,
    },
    /// The PTY master hit EOF on the child's output while the process
    /// table entry may still exist (rare; treat as pre-Exited).
    OutputClosed,
}

/// How a session ended, once it has.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionExit {
    pub exit_code: Option<u32>,
    pub signal: Option<String>,
    pub success: bool,
}

/// Wakeup notifications for renderers: one token per output burst,
/// capacity-bounded so a flood never grows memory (coalesced wakes).
pub type OutputWake = Receiver<()>;

/// A live interactive terminal session.
///
/// Threading model:
/// - a reader thread drains the PTY master, feeding the vt100 emulator and
///   bumping `generation` (so renderers only redraw on real change);
/// - a waiter thread blocks in `child.wait()` and reports [`SessionEvent`];
/// - callers write input / resize through the master (each op short and
///   non-blocking, under a mutex).
///
/// Dropping the session asks the child to terminate (SIGHUP on drop of the
/// PTY master on Unix; explicit kill as belt-and-braces) and detaches the
/// helper threads.
pub struct TerminalSession {
    id: SessionId,
    label: String,
    program: PathBuf,
    master: Arc<Mutex<Box<dyn MasterPty + Send>>>,
    writer: Mutex<Box<dyn Write + Send>>,
    killer: Mutex<Box<dyn portable_pty::ChildKiller + Send + Sync>>,
    parser: Arc<Mutex<vt100::Parser>>,
    generation: Arc<AtomicU64>,
    events: Mutex<Receiver<SessionEvent>>,
    exited: Arc<Mutex<Option<SessionExit>>>,
    size: Mutex<TerminalSize>,
    wake_rx: Mutex<Option<OutputWake>>,
    wake_tx: SyncSender<()>,
}

impl TerminalSession {
    /// Spawn `config.program` inside a fresh PTY.
    pub fn spawn(config: SessionConfig) -> Result<Self, TerminalError> {
        let id = SessionId::next();
        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows: config.size.rows,
                cols: config.size.cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| TerminalError::Pty(e.to_string()))?;

        let mut cmd = CommandBuilder::new(&config.program);
        cmd.args(&config.args);
        cmd.env("TERM", &config.term);
        for (k, v) in &config.env {
            cmd.env(k, v);
        }
        if let Some(cwd) = &config.cwd {
            cmd.cwd(cwd);
        }

        let mut child: Box<dyn Child + Send + Sync> =
            pair.slave
                .spawn_command(cmd)
                .map_err(|e| TerminalError::Spawn {
                    program: config.program.display().to_string(),
                    message: e.to_string(),
                })?;
        // The slave is only needed to spawn; holding it open would keep
        // the master reader from seeing EOF when the child dies.
        drop(pair.slave);

        let mut reader = pair
            .master
            .try_clone_reader()
            .map_err(|e| TerminalError::Pty(e.to_string()))?;
        let writer = pair
            .master
            .take_writer()
            .map_err(|e| TerminalError::Pty(e.to_string()))?;
        // Grab a killer handle before the waiter thread moves the child.
        let killer = child.clone_killer();

        let parser = Arc::new(Mutex::new(vt100::Parser::new(
            config.size.rows,
            config.size.cols,
            config.scrollback,
        )));
        let generation = Arc::new(AtomicU64::new(0));
        let exited: Arc<Mutex<Option<SessionExit>>> = Arc::new(Mutex::new(None));
        let (tx, rx) = mpsc::channel();
        // Bounded to 1: renders coalesce, so one queued wake is enough.
        let (wake_tx, wake_rx) = mpsc::sync_channel::<()>(1);

        // Reader thread: parse output into the emulator grid.
        {
            let parser = Arc::clone(&parser);
            let generation = Arc::clone(&generation);
            let tx_out = tx.clone();
            let wake_tx = wake_tx.clone();
            let id_str = id.to_string();
            thread::spawn(move || {
                let mut buf = [0u8; 8192];
                loop {
                    match reader.read(&mut buf) {
                        Ok(0) => break,
                        Ok(n) => {
                            if let Ok(mut p) = parser.lock() {
                                p.process(&buf[..n]);
                                generation.fetch_add(1, Ordering::Release);
                            }
                            // Wake a renderer if none is queued yet;
                            // Full just means a redraw is already pending.
                            let _ = wake_tx.try_send(());
                        }
                        // EIO on Linux once the session leader is gone:
                        // normal end of stream, not an error to surface.
                        Err(_) => break,
                    }
                }
                let _ = tx_out.send(SessionEvent::OutputClosed);
                tracing_read_thread_exit(&id_str);
            });
        }

        // Waiter thread: authoritative exit status.
        {
            let exited = Arc::clone(&exited);
            let wake_tx = wake_tx.clone();
            thread::spawn(move || {
                let status = child.wait();
                let exit = match status {
                    Ok(st) => SessionExit {
                        exit_code: Some(st.exit_code()),
                        signal: st.signal().map(str::to_owned),
                        success: st.success(),
                    },
                    Err(e) => SessionExit {
                        exit_code: None,
                        signal: Some(format!("wait-failed: {e}")),
                        success: false,
                    },
                };
                *exited.lock().expect("exited mutex poisoned") = Some(exit.clone());
                let _ = tx.send(SessionEvent::Exited {
                    exit_code: exit.exit_code,
                    signal: exit.signal,
                });
                // Wake renderers even when the child exited without writing
                // a final chunk; otherwise a bridge client would never learn
                // the process finished.
                let _ = wake_tx.try_send(());
            });
        }

        Ok(Self {
            id,
            label: config.label,
            program: config.program,
            master: Arc::new(Mutex::new(pair.master)),
            writer: Mutex::new(writer),
            killer: Mutex::new(killer),
            parser,
            generation,
            events: Mutex::new(rx),
            exited,
            size: Mutex::new(config.size),
            wake_rx: Mutex::new(Some(wake_rx)),
            wake_tx,
        })
    }

    /// Take the output wakeup stream (once). A renderer blocks/drains it
    /// to know when [`Self::snapshot`] may have changed, instead of
    /// polling. Wakes are coalesced: at most one is ever queued.
    pub fn take_output_wake(&self) -> Option<OutputWake> {
        self.wake_rx.lock().expect("wake mutex poisoned").take()
    }

    pub fn id(&self) -> SessionId {
        self.id
    }
    pub fn label(&self) -> &str {
        &self.label
    }
    pub fn program(&self) -> &PathBuf {
        &self.program
    }

    /// Current window size (cells).
    pub fn size(&self) -> TerminalSize {
        *self.size.lock().expect("size mutex poisoned")
    }

    /// Forward raw keystrokes to the child, verbatim. No interpretation:
    /// the child's own line editing / TUI receives exactly what the user
    /// typed (spec: preserve interactive input).
    pub fn send_bytes(&self, bytes: &[u8]) -> Result<(), TerminalError> {
        if self.exit_status().is_some() {
            return Err(TerminalError::Closed(self.id));
        }
        let mut w = self.writer.lock().expect("writer mutex poisoned");
        w.write_all(bytes)?;
        w.flush()?;
        Ok(())
    }

    /// Deliver Ctrl-C to the foreground process group (like typing it).
    pub fn send_interrupt(&self) -> Result<(), TerminalError> {
        self.send_bytes(&[0x03])
    }

    /// Resize the PTY (delivers SIGWINCH on Unix) and the emulator grid.
    pub fn resize(&self, size: TerminalSize) -> Result<(), TerminalError> {
        if size.rows == 0 || size.cols == 0 {
            return Err(TerminalError::Pty("terminal size must be non-zero".into()));
        }
        self.master
            .lock()
            .expect("master mutex poisoned")
            .resize(PtySize {
                rows: size.rows,
                cols: size.cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| TerminalError::Pty(e.to_string()))?;
        if let Ok(mut p) = self.parser.lock() {
            p.set_size(size.rows, size.cols);
        }
        *self.size.lock().expect("size mutex poisoned") = size;
        self.generation.fetch_add(1, Ordering::Release);
        let _ = self.wake_tx.try_send(());
        Ok(())
    }

    /// Bumped whenever the screen content changed. Renderers compare
    /// against their last drawn value and skip idle frames (event-driven
    /// refresh, not polling output).
    pub fn generation(&self) -> u64 {
        self.generation.load(Ordering::Acquire)
    }

    /// Copy of the current screen grid.
    pub fn snapshot(&self) -> ScreenSnapshot {
        let generation = self.generation();
        let p = self.parser.lock().expect("parser mutex poisoned");
        let screen = p.screen();
        let (rows, cols) = screen.size();
        let mut cells = Vec::with_capacity(rows as usize * cols as usize);
        for row in 0..rows {
            for col in 0..cols {
                match screen.cell(row, col) {
                    Some(c) => cells.push(ScreenCell {
                        // vt100 reports blank cells as empty strings;
                        // renderers need a real space to keep geometry.
                        ch: {
                            let s = c.contents();
                            if s.is_empty() { " ".into() } else { s }
                        },
                        fg: map_color(c.fgcolor()),
                        bg: map_color(c.bgcolor()),
                        bold: c.bold(),
                        italic: c.italic(),
                        underline: c.underline(),
                        inverse: c.inverse(),
                        wide_continuation: c.is_wide_continuation(),
                    }),
                    None => cells.push(ScreenCell {
                        ch: " ".into(),
                        fg: Color::Default,
                        bg: Color::Default,
                        bold: false,
                        italic: false,
                        underline: false,
                        inverse: false,
                        wide_continuation: false,
                    }),
                }
            }
        }
        let cursor = screen.cursor_position();
        ScreenSnapshot {
            rows,
            cols,
            cursor: (
                cursor.0.min(rows.saturating_sub(1)),
                cursor.1.min(cols.saturating_sub(1)),
            ),
            cursor_visible: !screen.hide_cursor(),
            title: screen.title().to_owned(),
            cells,
            generation,
        }
    }

    /// Drain pending lifecycle events (non-blocking).
    pub fn poll_events(&self) -> Vec<SessionEvent> {
        let mut out = Vec::new();
        let rx = self.events.lock().expect("events mutex poisoned");
        while let Ok(ev) = rx.try_recv() {
            out.push(ev);
        }
        out
    }

    /// Set once the child has exited (authoritative, race-free).
    pub fn exit_status(&self) -> Option<SessionExit> {
        self.exited.lock().expect("exited mutex poisoned").clone()
    }

    pub fn is_running(&self) -> bool {
        self.exit_status().is_none()
    }

    /// Hard-kill the child. The waiter thread still reports the resulting
    /// [`SessionEvent::Exited`] (usually with a signal).
    pub fn kill(&self) -> Result<(), TerminalError> {
        let _ = self.killer.lock().expect("killer mutex poisoned").kill();
        Ok(())
    }

    /// Close the session: interrupt, then kill if still alive after
    /// `grace`. Idempotent.
    pub fn close(&self, grace: Duration) -> Result<(), TerminalError> {
        if self.is_running() {
            let _ = self.send_interrupt();
            let deadline = std::time::Instant::now() + grace;
            while std::time::Instant::now() < deadline && self.is_running() {
                thread::sleep(Duration::from_millis(20));
            }
        }
        if self.is_running() {
            self.kill()?;
            // Give the waiter thread a short moment to record the real exit
            // status so callers can report it instead of guessing.
            let deadline = std::time::Instant::now() + Duration::from_millis(300);
            while std::time::Instant::now() < deadline && self.is_running() {
                thread::sleep(Duration::from_millis(10));
            }
        }
        Ok(())
    }
}

impl Drop for TerminalSession {
    fn drop(&mut self) {
        // Never orphan a CLI process behind a dropped handle.
        if self.is_running() {
            let _ = self.kill();
        }
    }
}

fn tracing_read_thread_exit(_id: &str) {
    // Hook for future structured tracing; keeps the reader thread free
    // of dependencies today.
}
