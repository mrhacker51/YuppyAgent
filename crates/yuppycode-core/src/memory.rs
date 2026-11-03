//! Persistent-memory contract implemented by `yuppycode-memory` (SQLite).
//!
//! Kept as a trait in core so the engine works headless with memory disabled,
//! and so alternative backends can be swapped without touching orchestration.

use thiserror::Error;

use crate::provider::ChatMessage;

#[derive(Debug, Error, Clone)]
pub enum MemoryError {
    #[error("storage failure: {0}")]
    Storage(String),
    #[error("not found: {0}")]
    NotFound(String),
}

/// One audit record of a tool execution (never contains secrets by policy:
/// the engine sanitizes arguments before recording).
#[derive(Debug, Clone)]
pub struct AuditEvent {
    pub workspace_id: String,
    pub conversation_id: String,
    pub tool: String,
    pub ok: bool,
    /// Redacted / truncated argument preview.
    pub args_preview: String,
    pub duration_ms: u64,
}

/// Stats returned by a pruning pass.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct PruneStats {
    pub removed_messages: usize,
    pub tokens_before: usize,
    pub tokens_after: usize,
}

pub trait Memory: Send + Sync {
    /// Ensure a conversation exists for a workspace; returns its id.
    fn ensure_conversation(
        &self,
        workspace_path: &str,
        conversation_id: &str,
    ) -> Result<(), MemoryError>;

    /// Persist one message.
    fn append_message(&self, conversation_id: &str, msg: &ChatMessage) -> Result<(), MemoryError>;

    /// Bounded recent-history query, oldest first, capped by count.
    fn recent_messages(
        &self,
        conversation_id: &str,
        limit: usize,
    ) -> Result<Vec<ChatMessage>, MemoryError>;

    /// Trim history to a token budget by dropping oldest non-essential
    /// messages. Essential pieces (leading system instructions, the most
    /// recent exchanges, and any message whose content is flagged active-task
    /// state via `[ACTIVE-TASK]` prefix) are preserved. Removed messages are
    /// aggregated into one synthetic digest message so context is *never
    /// silently lost*.
    fn prune_to_budget(
        &self,
        conversation_id: &str,
        budget_tokens: usize,
    ) -> Result<PruneStats, MemoryError>;

    /// Record a tool execution audit event.
    fn record_audit(&self, event: &AuditEvent) -> Result<(), MemoryError>;

    /// Read a stored user preference.
    fn get_preference(
        &self,
        workspace_path: &str,
        key: &str,
    ) -> Result<Option<String>, MemoryError>;

    /// Store a user preference.
    fn set_preference(
        &self,
        workspace_path: &str,
        key: &str,
        value: &str,
    ) -> Result<(), MemoryError>;

    /// Delete everything belonging to a workspace (user-facing privacy control).
    fn delete_workspace(&self, workspace_path: &str) -> Result<(), MemoryError>;

    /// Human-readable store location for the status bar / `yuppy memory info`.
    fn location(&self) -> String;
}
