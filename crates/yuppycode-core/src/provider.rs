//! Provider-neutral chat completion + streaming abstractions.

use std::future::Future;
use std::pin::Pin;

use futures_util::Stream;
use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::cancel::CancelToken;
use crate::tools::ToolSpec;
use crate::{CallId, ToolCall};

/// A chat message in provider-neutral form.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ChatMessage {
    pub role: Role,
    pub content: String,
    /// Assistant -> tool requests.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tool_calls: Vec<ToolCall>,
    /// Set on `Tool` role messages: the call this message answers.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Role {
    System,
    User,
    Assistant,
    Tool,
}

impl ChatMessage {
    pub fn system(s: impl Into<String>) -> Self {
        Self {
            role: Role::System,
            content: s.into(),
            tool_calls: Vec::new(),
            tool_call_id: None,
        }
    }
    pub fn user(s: impl Into<String>) -> Self {
        Self {
            role: Role::User,
            content: s.into(),
            tool_calls: Vec::new(),
            tool_call_id: None,
        }
    }
    pub fn assistant(content: impl Into<String>, tool_calls: Vec<ToolCall>) -> Self {
        Self {
            role: Role::Assistant,
            content: content.into(),
            tool_calls,
            tool_call_id: None,
        }
    }
    pub fn tool(call_id: &CallId, content: impl Into<String>) -> Self {
        Self {
            role: Role::Tool,
            content: content.into(),
            tool_calls: Vec::new(),
            tool_call_id: Some(call_id.as_str().to_string()),
        }
    }

    pub fn approx_tokens(&self) -> usize {
        crate::estimate_tokens(&self.content)
            + self
                .tool_calls
                .iter()
                .map(|c| crate::estimate_tokens(&c.arguments.to_string()))
                .sum::<usize>()
    }
}

/// Everything the engine asks a provider for in one pass.
#[derive(Debug, Clone)]
pub struct CompletionRequest {
    pub model: String,
    pub messages: Vec<ChatMessage>,
    /// Tool schemas advertised to the model (empty = no tools).
    pub tools: Vec<ToolSpec>,
    pub temperature: Option<f32>,
    pub max_output_tokens: Option<u32>,
    /// Optional reasoning-effort hint. Adapters validate before sending;
    /// see `providers::openai::validate_reasoning_effort` for the accepted
    /// contract (DeepSeek V4.1 and OpenAI o-series agree on it).
    pub reasoning_effort: Option<String>,
}

/// One streamed piece of an assistant turn.
#[derive(Debug, Clone, PartialEq)]
pub enum StreamChunk {
    /// Incremental assistant text.
    Text(String),
    /// Incremental tool call; correlated by `index` within one turn.
    /// `id`/`name` arrive with the first delta, `arguments_delta` streams JSON text.
    ToolCallDelta {
        index: usize,
        id: Option<String>,
        name: Option<String>,
        arguments_delta: String,
    },
    /// Terminal chunk.
    Done { finish: FinishReason },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum FinishReason {
    Stop,
    ToolCalls,
    Length,
    Cancelled,
    Error,
}

#[derive(Debug, Error)]
pub enum ProviderError {
    #[error("transport failure: {0}")]
    Transport(String),
    #[error("provider returned HTTP {status}: {body}")]
    Http { status: u16, body: String },
    #[error("malformed provider response: {0}")]
    InvalidResponse(String),
    #[error("provider configuration error: {0}")]
    Config(String),
    #[error("cancelled")]
    Cancelled,
}

/// Boxed, cancellable stream of chunks (dyn-compatible without async_trait).
pub type ChunkStream =
    Pin<Box<dyn Stream<Item = Result<StreamChunk, ProviderError>> + Send + 'static>>;

pub type ProviderFuture<'a> =
    Pin<Box<dyn Future<Output = Result<ChunkStream, ProviderError>> + Send + 'a>>;

#[derive(Debug, Clone, Copy, Default)]
pub struct ProviderCapabilities {
    pub streaming: bool,
    pub tool_calls: bool,
}

/// A model provider adapter (OpenAI-compatible HTTP, simulated, …).
///
/// Adapters own their wire-format quirks; the engine only sees this trait.
pub trait ModelProvider: Send + Sync {
    /// Stable machine id, e.g. `"openai-compatible"`, `"simulated"`.
    fn id(&self) -> &str;
    /// Human-readable display name including current model.
    fn display_name(&self) -> String;
    fn capabilities(&self) -> ProviderCapabilities;
    /// Begin a completion. The returned stream must observe `cancel`
    /// (stop producing items promptly once set).
    fn stream(&self, req: CompletionRequest, cancel: CancelToken) -> ProviderFuture<'_>;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn message_token_estimate_includes_tool_args() {
        let m = ChatMessage::user("hello");
        let mut with_call = ChatMessage::assistant("", vec![]);
        with_call.tool_calls.push(ToolCall {
            id: CallId::next(),
            name: "x".into(),
            arguments: serde_json::json!({"k": "vvvv"}),
        });
        assert!(with_call.approx_tokens() > m.approx_tokens());
    }

    #[test]
    fn tool_message_carries_call_id() {
        let id = CallId::next();
        let m = ChatMessage::tool(&id, "ok");
        assert_eq!(m.tool_call_id.as_deref(), Some(id.as_str()));
        assert_eq!(m.role, Role::Tool);
    }
}
