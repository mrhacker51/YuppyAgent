//! YuppyCode MCP client (stdio transport).
//!
//! Implements the subset of the Model Context Protocol the agent needs:
//! lifecycle (`initialize` → `initialized`), `tools/list`, `tools/call`.
//! Messages are newline-delimited JSON-RPC 2.0 over the child's stdio.
//!
//! Robustness posture:
//! - malformed / unexpected lines are counted and skipped, never fatal;
//! - every request has a timeout; pending calls fail fast when the child dies;
//! - output is size-capped;
//! - the child process is killed on drop (kill_on_drop).

mod client;
mod protocol;

pub use client::{McpClient, McpServerConfig};
pub use protocol::{
    CURRENT_PROTOCOL_VERSION, McpCallOutput, McpToolDef, SUPPORTED_PROTOCOL_VERSIONS,
};

use thiserror::Error;

#[derive(Debug, Error, Clone)]
pub enum McpError {
    #[error("failed to spawn MCP server: {0}")]
    Spawn(String),
    #[error("MCP transport failure: {0}")]
    Transport(String),
    #[error("MCP server died")]
    ServerDied,
    #[error("MCP request timed out after {0:?}")]
    Timeout(std::time::Duration),
    #[error("MCP protocol error {code}: {message}")]
    Protocol { code: i64, message: String },
    #[error("MCP handshake incompatible: server wants version {0:?}")]
    UnsupportedVersion(String),
    #[error("MCP message not initialised / malformed: {0}")]
    ProtocolShape(String),
}
