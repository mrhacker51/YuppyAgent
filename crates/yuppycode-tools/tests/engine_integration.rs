//! End-to-end integration: a scripted in-test provider + local tools
//! through the engine.
//!
//! There is no demo provider in the product anymore. These tests need a
//! deterministic assistant that sometimes requests a tool call, so the
//! double lives here, in test code only — nothing fabricated ever ships
//! in the binary.

use std::sync::Arc;
use std::time::Duration;

use tempfile::tempdir;
use tokio::runtime::Runtime;

use yuppycode_core::provider::{ChunkStream, ProviderFuture};
use yuppycode_core::{
    AgentEngine, AgentEvent, CancelToken, CompletionRequest, EngineConfig, EventBus, FinishReason,
    ModelProvider, ProviderCapabilities, ProviderError, Role, StreamChunk, ToolExecutor,
};
use yuppycode_tools::{AggregateToolExecutor, LocalToolPolicy};

/// Deterministic test double: when the prompt asks to read a file it
/// requests one `read_file` tool call; after the tool result arrives it
/// answers with text and stops.
struct Scripted;

impl ModelProvider for Scripted {
    fn id(&self) -> &str {
        "scripted-test"
    }
    fn display_name(&self) -> String {
        "scripted (test-only)".into()
    }
    fn capabilities(&self) -> ProviderCapabilities {
        ProviderCapabilities {
            streaming: true,
            tool_calls: true,
        }
    }
    fn stream(&self, req: CompletionRequest, _cancel: CancelToken) -> ProviderFuture<'_> {
        let has_tool_result = req.messages.iter().any(|m| m.role == Role::Tool);
        let last_user = req
            .messages
            .iter()
            .rev()
            .find(|m| m.role == Role::User)
            .map(|m| m.content.clone())
            .unwrap_or_default();
        let read_target = last_user
            .strip_prefix("use tool: read ")
            .map(str::trim)
            .filter(|p| !p.is_empty())
            .map(str::to_string);

        let chunks: Vec<Result<StreamChunk, ProviderError>> = match (read_target, has_tool_result) {
            (Some(path), false) => vec![
                Ok(StreamChunk::ToolCallDelta {
                    index: 0,
                    id: Some("call_test_1".into()),
                    name: Some("read_file".into()),
                    arguments_delta: format!("{{\"path\": \"{path}\"}}"),
                }),
                Ok(StreamChunk::Done {
                    finish: FinishReason::ToolCalls,
                }),
            ],
            _ => vec![
                Ok(StreamChunk::Text("turn complete.".into())),
                Ok(StreamChunk::Done {
                    finish: FinishReason::Stop,
                }),
            ],
        };

        Box::pin(async move {
            let stream: ChunkStream = Box::pin(futures_util::stream::iter(chunks));
            Ok(stream)
        })
    }
}

fn scripted_engine(
    root: std::path::PathBuf,
    capacity: usize,
) -> (Arc<AgentEngine>, tokio::sync::mpsc::Receiver<AgentEvent>) {
    let (bus, rx) = EventBus::channel(capacity);
    let provider: Arc<dyn ModelProvider> = Arc::new(Scripted);
    let tools: Arc<dyn ToolExecutor> =
        Arc::new(AggregateToolExecutor::new(LocalToolPolicy::ReadOnly));
    let cfg = EngineConfig::new(provider, tools, root);
    (Arc::new(AgentEngine::new(cfg, bus)), rx)
}

#[test]
fn scripted_turn_streams_text_and_finishes() {
    let rt = Runtime::new().unwrap();
    rt.block_on(async {
        let root = tempdir().unwrap().path().to_path_buf();
        let (engine, mut rx) = scripted_engine(root, 16);
        tokio::spawn(async move { engine.run_turn("hello").await });

        let mut got_text = false;
        let mut got_done = false;
        while let Some(ev) = tokio::time::timeout(Duration::from_secs(5), rx.recv())
            .await
            .unwrap()
        {
            match ev {
                AgentEvent::TextDelta { .. } => got_text = true,
                AgentEvent::RunFinished { .. } => {
                    got_done = true;
                    break;
                }
                _ => {}
            }
        }
        assert!(got_text, "expected text delta");
        assert!(got_done, "expected run finished");
    });
}

#[test]
fn read_file_tool_works_in_workspace() {
    let rt = Runtime::new().unwrap();
    rt.block_on(async {
        let tmp = tempdir().unwrap();
        let root = tmp.path().to_path_buf();
        std::fs::write(root.join("note.txt"), "secret").unwrap();

        let (engine, mut rx) = scripted_engine(root, 32);
        tokio::spawn(async move { engine.run_turn("use tool: read note.txt").await });

        let mut saw_tool = false;
        while let Some(ev) = tokio::time::timeout(Duration::from_secs(5), rx.recv())
            .await
            .unwrap()
        {
            match ev {
                AgentEvent::ToolFinished { summary, .. } if summary.contains("secret") => {
                    saw_tool = true;
                }
                AgentEvent::RunFinished { .. } => break,
                _ => {}
            }
        }
        assert!(saw_tool, "read_file tool did not return file contents");
    });
}

#[test]
fn path_traversal_is_blocked() {
    let rt = Runtime::new().unwrap();
    rt.block_on(async {
        let tmp = tempdir().unwrap();
        let root = tmp.path().to_path_buf();
        let mut outside = root.clone();
        outside.pop();
        std::fs::write(outside.join("outside.txt"), "leak").unwrap();

        let (engine, mut rx) = scripted_engine(root, 32);
        tokio::spawn(async move { engine.run_turn("use tool: read ../outside.txt").await });

        let mut blocked = false;
        while let Some(ev) = tokio::time::timeout(Duration::from_secs(5), rx.recv())
            .await
            .unwrap()
        {
            match ev {
                AgentEvent::ToolFinished { ok, summary, .. }
                    if !ok && summary.contains("escapes") =>
                {
                    blocked = true;
                }
                AgentEvent::RunFinished { .. } => break,
                _ => {}
            }
        }
        assert!(blocked, "path traversal should have been blocked");
    });
}
