//! The team bus: one SQLite file that lets several agent CLIs — including
//! different vendors' — talk to each other while they work.
//!
//! Two halves:
//! - [`store`] is the durable mailbox layer (members, messages, cursors,
//!   blocking wait). Any process that can open the file can participate.
//! - [`mcp_server`] is a stdio MCP server exposing that store as five tools,
//!   which is how a real `claude -p` process and a real `codex exec` process
//!   end up in the same conversation without either knowing the other's wire
//!   format.

pub mod mcp_server;
pub mod store;

pub use mcp_server::{
    Identity, MAX_WAIT_SECS, normalize_tool_name, serve, team_brief, tool_defs, wait_secs,
};
pub use store::{
    Bus, BusError, EVERYONE, HUMAN, JoinRequest, Member, Message, Outgoing, default_bus_path,
};
