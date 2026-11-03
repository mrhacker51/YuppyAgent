//! YuppyCode core: agent engine, task graph, typed events, cancellation.
//!
//! Design rules (Phase 1 contract):
//! - No UI, HTTP, SQLite or process dependencies here — only traits + types + orchestration.
//! - The engine is drivable headless: everything it emits goes through a
//!   bounded [`events::EventBus`]; transports (TUI, future WebSocket) only subscribe.
//! - Cancellation is cooperative via [`cancel::CancelToken`] and honoured by
//!   providers and tool executors.

pub mod approval;
pub mod cancel;
pub mod engine;
pub mod error;
pub mod events;
pub mod ids;
pub mod memory;
pub mod provider;
pub mod task;
pub mod tools;

pub use approval::{AlwaysApprove, AlwaysDeny, ApprovalDecision, ApprovalGate, ApprovalRequest};
pub use cancel::CancelToken;
pub use engine::{AgentEngine, EngineConfig, EngineState, RunOutcome};
pub use error::CoreError;
pub use events::{AgentEvent, EventBus};
pub use ids::{CallId, ConversationId, RunId, TaskId, WorkspaceId};
pub use memory::{AuditEvent, Memory};
pub use provider::{
    ChatMessage, CompletionRequest, FinishReason, ModelProvider, ProviderCapabilities,
    ProviderError, Role, StreamChunk,
};
pub use task::{TaskGraph, TaskNode, TaskStatus};
pub use tools::{
    ExecContext, Risk, ToolCall, ToolError, ToolExecutor, ToolFuture, ToolResult, ToolSpec,
};

/// Re-export so adapters can build payloads without a direct dependency.
pub use yuppycode_protocol as protocol;

/// Rough token estimate: ~4 chars/token.
///
/// Deliberately not a real tokenizer: tiktoken-class data files cost startup
/// time and RAM. Providers report authoritative usage when available; this is
/// only used for budgeting/pruning heuristics. See docs/limitations.
pub fn estimate_tokens(text: &str) -> usize {
    text.len().div_ceil(4)
}

#[cfg(test)]
mod tests {
    use super::estimate_tokens;

    #[test]
    fn token_estimate_is_monotonic_and_roughly_quarter_length() {
        assert_eq!(estimate_tokens(""), 0);
        assert_eq!(estimate_tokens("abcd"), 1);
        assert_eq!(estimate_tokens("abcde"), 2);
        let a = estimate_tokens("hello world");
        let b = estimate_tokens("hello world, hello world");
        assert!(b > a && b < a * 3);
    }
}
