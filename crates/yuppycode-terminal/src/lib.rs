//! YuppyCode terminal sessions: real PTY-backed processes with an
//! embeddable ANSI screen model.
//!
//! This crate is deliberately UI-free: it owns no rendering and no widget
//! types. A frontend (the Ratatui TUI today, the Tauri/web terminal pane
//! later) renders [`ScreenSnapshot`] grids and forwards user input through
//! [`TerminalSession::send_bytes`].
//!
//! Architecture contract:
//! - Platform specifics (Unix PTY today; Windows ConPTY via `portable-pty`)
//!   live entirely inside this crate. Callers see [`TerminalSession`] only.
//! - The child process is a *genuine* interactive program attached to a TTY:
//!   `TERM` is set, window size changes are delivered as `TIOCSWINSZ` /
//!   ConPTY resize events, and raw bytes pass through unmodified. The vt100
//!   parser exists purely to render a copy of the screen; it never gates
//!   input or rewrites output.
//! - One session == one child process == one PTY. No input is ever shared
//!   between sessions.
//!
//! Security note (spec §9): this crate will run *any* program it is asked
//! to. Authorization — which programs may be spawned, which working
//! directories are permitted — is the caller's responsibility (the CLI
//! adapter / TUI layer enforces it).

mod screen;
mod session;

pub use screen::{Color, ScreenCell, ScreenSnapshot};
pub use session::{
    OutputWake, SessionConfig, SessionEvent, SessionExit, SessionId, TerminalError,
    TerminalSession, TerminalSize,
};
