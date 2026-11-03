//! Tool abstractions: specs, calls, results and the executor contract.

use std::future::Future;
use std::pin::Pin;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use thiserror::Error;

use crate::cancel::CancelToken;
use crate::{CallId, ids::WorkspaceId};
use std::path::PathBuf;

/// Risk classification drives the approval policy.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Risk {
    /// Read-only inside the workspace.
    Safe,
    /// Writes / deletes files inside the workspace.
    Write,
    /// Spawns processes.
    Execute,
    /// Talks to external systems (MCP servers over the network, web, …).
    External,
}

impl Risk {
    pub fn is_high_risk(self) -> bool {
        matches!(self, Risk::Execute | Risk::External)
    }
}

/// Declared tool: name + JSON-Schema for arguments + risk class.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ToolSpec {
    pub name: String,
    pub description: String,
    /// JSON Schema (subset validated by `yuppycode-tools::schema`).
    pub input_schema: Value,
    pub risk: Risk,
}

/// A model's request to run a tool.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ToolCall {
    pub id: CallId,
    pub name: String,
    pub arguments: Value,
}

/// Structured result of a tool execution.
#[derive(Debug, Clone, PartialEq)]
pub struct ToolResult {
    pub call_id: CallId,
    /// Tool output shown to the model.
    pub output: String,
    pub is_error: bool,
    /// True when output was truncated by the size cap.
    pub truncated: bool,
    /// Short one-line summary for the TUI task tree / logs.
    pub summary: String,
}

impl ToolResult {
    pub fn ok(call_id: CallId, output: impl Into<String>) -> Self {
        let output = output.into();
        let summary = summarize(&output);
        Self {
            call_id,
            output,
            is_error: false,
            truncated: false,
            summary,
        }
    }
    pub fn err(call_id: CallId, message: impl Into<String>) -> Self {
        let output = message.into();
        let summary = summarize(&output);
        Self {
            call_id,
            output,
            is_error: true,
            truncated: false,
            summary,
        }
    }
}

pub fn summarize(s: &str) -> String {
    const MAX: usize = 120;
    let first_line = s.lines().next().unwrap_or("").trim();
    if first_line.chars().count() <= MAX {
        first_line.to_string()
    } else {
        let cut: String = first_line.chars().take(MAX - 1).collect();
        format!("{cut}…")
    }
}

/// Everything a tool needs to run safely.
#[derive(Debug, Clone)]
pub struct ExecContext {
    pub workspace_id: WorkspaceId,
    pub workspace_root: PathBuf,
    pub cancel: CancelToken,
    /// When false, write/exec tools must refuse even if schemas validate.
    pub allow_write: bool,
}

#[derive(Debug, Error)]
pub enum ToolError {
    #[error("unknown tool: {0}")]
    Unknown(String),
    #[error("invalid arguments for {tool}: {reason}")]
    InvalidArguments { tool: String, reason: String },
    #[error("denied by policy: {0}")]
    Denied(String),
    #[error("tool execution failed: {0}")]
    Execution(String),
    #[error("tool timed out after {0:?}")]
    Timeout(std::time::Duration),
    #[error("cancelled")]
    Cancelled,
    #[error("transport error: {0}")]
    Transport(String),
}

pub type ToolFuture = Pin<Box<dyn Future<Output = Result<ToolResult, ToolError>> + Send + 'static>>;

/// The engine talks to local + MCP tools through this trait.
pub trait ToolExecutor: Send + Sync {
    /// All currently advertised tools.
    fn specs(&self) -> Vec<ToolSpec>;
    /// Validate `args` against the declared schema for `name`.
    /// Must be called by the engine *before* execution or approval.
    fn validate(&self, name: &str, args: &Value) -> Result<(), String>;
    /// Whether this call needs a human approval round-trip.
    fn requires_approval(&self, call: &ToolCall) -> bool;
    /// Execute. Implementations must respect `ctx.cancel` and all caps.
    fn execute(&self, call: ToolCall, ctx: ExecContext) -> ToolFuture;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn summarize_cuts_first_line() {
        assert_eq!(summarize("hello\nworld"), "hello");
        let long = "x".repeat(300);
        let s = summarize(&long);
        assert!(s.chars().count() <= 120);
        assert!(s.ends_with('…'));
    }

    #[test]
    fn risk_classification() {
        assert!(!Risk::Safe.is_high_risk());
        assert!(!Risk::Write.is_high_risk());
        assert!(Risk::Execute.is_high_risk());
        assert!(Risk::External.is_high_risk());
    }
}
