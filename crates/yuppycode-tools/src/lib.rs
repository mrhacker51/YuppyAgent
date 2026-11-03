//! YuppyCode tool implementations and authorization.
//!
//! Phase 1 local tools:
//! - `read_file` / `write_file` — workspace-scoped, path-traversal-proof.
//! - `shell` — structured argv execution (or shell mode, both high-risk).
//!
//! Plus the MCP adapter so discovered external tools become first-class tools.

mod local;
mod mcp;
pub mod policy;
pub mod registry;
pub mod schema;

pub use local::LocalToolExecutor;
pub use mcp::McpToolExecutor;
pub use policy::LocalToolPolicy;
pub use registry::{AggregateToolExecutor, ToolRegistryError};

pub use schema::validate_arguments;

/// Argument keys common to local tools.
pub const ARG_PATH: &str = "path";
pub const ARG_CONTENT: &str = "content";
pub const ARG_COMMAND: &str = "command";
pub const ARG_SHELL: &str = "shell";
pub const ARG_TIMEOUT: &str = "timeout_seconds";
