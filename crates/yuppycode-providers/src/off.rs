//! Off provider: the engine is intentionally disabled.
//!
//! This is used when the user wants to interact only through hosted CLI
//! sessions (Claude Code, Codex, etc.) and does not want a chat model
//! provider running at all. Every prompt returns a clear error that points
//! the user to the terminal panes.

use yuppycode_core::CancelToken;
use yuppycode_core::provider::{
    ChunkStream, CompletionRequest, ModelProvider, ProviderCapabilities, ProviderError,
    ProviderFuture, StreamChunk,
};

pub struct Off;

impl Off {
    pub fn new() -> Self {
        Self
    }
}

impl Default for Off {
    fn default() -> Self {
        Self::new()
    }
}

impl ModelProvider for Off {
    fn id(&self) -> &str {
        "off"
    }

    fn display_name(&self) -> String {
        "off".to_string()
    }

    fn capabilities(&self) -> ProviderCapabilities {
        ProviderCapabilities {
            streaming: false,
            tool_calls: false,
        }
    }

    fn stream(&self, _req: CompletionRequest, _cancel: CancelToken) -> ProviderFuture<'_> {
        Box::pin(async move {
            let (tx, rx) = tokio::sync::mpsc::channel::<Result<StreamChunk, ProviderError>>(1);
            let _ = tx
                .send(Err(ProviderError::Config(
                    "Engine is off. Use the Claude Code / Codex terminal panes to interact.".into(),
                )))
                .await;
            Ok(Box::pin(RecvStream { rx }) as ChunkStream)
        })
    }
}

struct RecvStream {
    rx: tokio::sync::mpsc::Receiver<Result<StreamChunk, ProviderError>>,
}

impl futures_util::Stream for RecvStream {
    type Item = Result<StreamChunk, ProviderError>;
    fn poll_next(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<Option<Self::Item>> {
        self.rx.poll_recv(cx)
    }
}
