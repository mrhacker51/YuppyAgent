//! Typed engine events over a bounded, backpressure-aware bus.
//!
//! High-frequency text deltas are *coalesced*: when the subscriber lags,
//! consecutive deltas merge into one event instead of growing a queue.
//! Non-delta events apply backpressure (`send().await`) — they are rare and
//! important, so they must never be dropped.

use std::sync::Mutex;

use tokio::sync::mpsc;

use crate::protocol::{self, LogLevel, RunStatus, ServerPayload, TaskStatusDto, TelemetrySnapshot};
use crate::task::TaskNode;

/// Everything the engine tells the world. Serializable to protocol payloads
/// so any transport can relay it verbatim.
#[derive(Debug, Clone)]
pub enum AgentEvent {
    RunStarted {
        run_id: String,
        prompt_chars: usize,
    },
    TextDelta {
        run_id: String,
        text: String,
    },
    RunFinished {
        run_id: String,
        status: RunStatus,
    },
    TaskUpsert(TaskNode),
    ToolStarted {
        run_id: String,
        call_id: String,
        tool: String,
    },
    ToolFinished {
        run_id: String,
        call_id: String,
        ok: bool,
        summary: String,
    },
    ApprovalRequired {
        run_id: String,
        call_id: String,
        tool: String,
        arguments_pretty: String,
        reason: String,
    },
    Log(LogLevel, String),
    Telemetry(TelemetrySnapshot),
    Info(protocol::EngineInfo),
    Error {
        code: String,
        message: String,
    },
}

impl AgentEvent {
    /// Convert to the wire representation (used by any transport, incl. TUI tests).
    pub fn to_payload(&self) -> ServerPayload {
        match self {
            AgentEvent::RunStarted {
                run_id,
                prompt_chars,
            } => ServerPayload::RunStarted {
                run_id: run_id.clone(),
                prompt_chars: *prompt_chars,
            },
            AgentEvent::TextDelta { run_id, text } => ServerPayload::TextDelta {
                run_id: run_id.clone(),
                text: text.clone(),
            },
            AgentEvent::RunFinished { run_id, status } => ServerPayload::RunFinished {
                run_id: run_id.clone(),
                status: *status,
            },
            AgentEvent::TaskUpsert(n) => ServerPayload::TaskUpsert {
                node: protocol::TaskNodeDto {
                    id: n.id.clone(),
                    parent_id: n.parent_id.clone(),
                    title: n.title.clone(),
                    status: match n.status {
                        crate::task::TaskStatus::Pending => TaskStatusDto::Pending,
                        crate::task::TaskStatus::Running => TaskStatusDto::Running,
                        crate::task::TaskStatus::WaitingApproval => TaskStatusDto::WaitingApproval,
                        crate::task::TaskStatus::Success => TaskStatusDto::Success,
                        crate::task::TaskStatus::Failed => TaskStatusDto::Failed,
                        crate::task::TaskStatus::Cancelled => TaskStatusDto::Cancelled,
                    },
                    detail: n.detail.clone(),
                },
            },
            AgentEvent::ToolStarted {
                run_id,
                call_id,
                tool,
            } => ServerPayload::ToolStarted {
                run_id: run_id.clone(),
                call_id: call_id.clone(),
                tool: tool.clone(),
            },
            AgentEvent::ToolFinished {
                run_id,
                call_id,
                ok,
                summary,
            } => ServerPayload::ToolFinished {
                run_id: run_id.clone(),
                call_id: call_id.clone(),
                ok: *ok,
                summary: summary.clone(),
            },
            AgentEvent::ApprovalRequired {
                run_id,
                call_id,
                tool,
                arguments_pretty,
                reason,
            } => ServerPayload::ApprovalRequired {
                run_id: run_id.clone(),
                call_id: call_id.clone(),
                tool: tool.clone(),
                arguments_pretty: arguments_pretty.clone(),
                reason: reason.clone(),
            },
            AgentEvent::Log(l, m) => ServerPayload::Log {
                level: *l,
                message: m.clone(),
            },
            AgentEvent::Telemetry(t) => ServerPayload::Telemetry(t.clone()),
            AgentEvent::Info(i) => ServerPayload::Info(i.clone()),
            AgentEvent::Error { code, message } => ServerPayload::Error {
                code: code.clone(),
                message: message.clone(),
            },
        }
    }

    /// True for events safe to coalesce when the consumer lags.
    pub fn is_delta(&self) -> bool {
        matches!(self, AgentEvent::TextDelta { .. })
    }
}

/// Bounded publisher. Cheap to clone (Arc-backed channel handle).
#[derive(Clone)]
pub struct EventBus {
    tx: mpsc::Sender<AgentEvent>,
    /// Buffered, not-yet-delivered delta text (consumer lagging).
    pending_delta: std::sync::Arc<Mutex<Option<PendingDelta>>>,
}

struct PendingDelta {
    run_id: String,
    text: String,
}

/// Flush deltas that exceed this buffered size by applying real backpressure,
/// so the transcript is never silently truncated under sustained lag.
const DELTA_HARD_FLUSH_BYTES: usize = 64 * 1024;

impl EventBus {
    /// Capacity is the max number of non-delta events allowed to queue.
    pub fn channel(capacity: usize) -> (EventBus, mpsc::Receiver<AgentEvent>) {
        let (tx, rx) = mpsc::channel(capacity.max(8));
        (
            EventBus {
                tx,
                pending_delta: std::sync::Arc::new(Mutex::new(None)),
            },
            rx,
        )
    }

    pub fn capacity(&self) -> usize {
        self.tx.capacity()
    }

    /// Publish an important event: first flush any coalesced delta (in order),
    /// then await channel capacity.
    pub async fn publish(&self, event: AgentEvent) {
        debug_assert!(!event.is_delta(), "use publish_delta for deltas");
        self.flush_delta().await;
        // Channel closed => nobody listening; drop silently (engine keeps running).
        let _ = self.tx.send(event).await;
    }

    /// Publish a text delta with coalescing under lag.
    pub async fn publish_delta(&self, run_id: &str, text: &str) {
        if text.is_empty() {
            return;
        }
        let mut to_send: Option<PendingDelta> = None;
        {
            let mut guard = self.pending_delta.lock().unwrap();
            if let Some(p) = guard.as_mut() {
                if p.run_id == run_id {
                    p.text.push_str(text);
                    // Consumer lagging: keep buffering unless we hit the hard cap.
                    if p.text.len() >= DELTA_HARD_FLUSH_BYTES {
                        to_send = guard.take();
                    }
                } else {
                    // Run switched: ship the old text first, buffer the new one.
                    to_send = guard.take();
                    guard.replace(PendingDelta {
                        run_id: run_id.to_string(),
                        text: text.to_string(),
                    });
                }
            } else {
                // Fast path: hand off directly when the consumer is keeping up.
                let ev = AgentEvent::TextDelta {
                    run_id: run_id.to_string(),
                    text: text.to_string(),
                };
                match self.tx.try_send(ev) {
                    Ok(()) => {}
                    Err(mpsc::error::TrySendError::Full(ev)) => {
                        let AgentEvent::TextDelta { run_id, text } = ev else {
                            unreachable!()
                        };
                        guard.replace(PendingDelta { run_id, text });
                    }
                    Err(mpsc::error::TrySendError::Closed(_)) => {}
                }
            }
        }
        if let Some(p) = to_send {
            // Buffered content is delivered with real backpressure.
            let _ = self
                .tx
                .send(AgentEvent::TextDelta {
                    run_id: p.run_id,
                    text: p.text,
                })
                .await;
        }
    }

    /// Emit any buffered delta immediately (run boundaries, pre-important-event).
    pub async fn flush_delta(&self) {
        let taken = self.pending_delta.lock().unwrap().take();
        if let Some(p) = taken {
            let ev = AgentEvent::TextDelta {
                run_id: p.run_id,
                text: p.text,
            };
            let _ = self.tx.send(ev).await;
        }
    }

    /// Non-async best-effort publish for tests/teardown paths.
    pub fn try_publish(&self, event: AgentEvent) -> bool {
        self.tx.try_send(event).is_ok()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn deltas_coalesce_when_consumer_is_slow() {
        let (bus, mut rx) = EventBus::channel(8);
        // Fill the channel with blockers so deltas have nowhere to go.
        for i in 0..8 {
            assert!(bus.try_publish(AgentEvent::Log(LogLevel::Info, format!("filler {i}"))));
        }
        bus.publish_delta("r1", "a").await;
        bus.publish_delta("r1", "b").await;
        bus.publish_delta("r1", "c").await;
        // Nothing delta-shaped queued yet — it is buffered/coalescing.
        let mut drained = Vec::new();
        while let Ok(ev) = rx.try_recv() {
            drained.push(ev);
        }
        assert!(drained.iter().all(|e| !e.is_delta()));
        // Flush merges into a single event.
        bus.flush_delta().await;
        let merged = rx.recv().await.unwrap();
        match merged {
            AgentEvent::TextDelta { text, .. } => assert_eq!(text, "abc"),
            other => panic!("expected merged delta, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn publish_after_delta_preserves_order() {
        let (bus, mut rx) = EventBus::channel(8);
        bus.publish_delta("r1", "hello ").await;
        bus.publish_delta("r1", "world").await;
        bus.publish(AgentEvent::RunFinished {
            run_id: "r1".into(),
            status: RunStatus::Completed,
        })
        .await;
        let first = rx.recv().await.unwrap();
        match first {
            AgentEvent::TextDelta { text, .. } => assert_eq!(text, "hello "),
            other => panic!("delta must arrive first, got {other:?}"),
        }
        // Buffered-then-flushed path also keeps ordering: fill the bus so the
        // next delta coalesces, then publish a critical event.
        while rx.try_recv().is_ok() {} // free all slots first
        for i in 0..8 {
            assert!(bus.try_publish(AgentEvent::Log(LogLevel::Info, format!("f{i}"))));
        }
        bus.publish_delta("r1", "late").await; // buffered (bus full)
        let mut drained = Vec::new();
        while let Ok(ev) = rx.try_recv() {
            drained.push(ev);
        } // freed capacity
        let handle = tokio::spawn({
            let bus = bus.clone();
            async move {
                bus.publish(AgentEvent::Error {
                    code: "x".into(),
                    message: "boom".into(),
                })
                .await
            }
        });
        // The merged delta must surface before the Error event.
        let next = loop {
            let ev = rx.recv().await.unwrap();
            if ev.is_delta() {
                break ev;
            }
            if matches!(ev, AgentEvent::Error { .. }) {
                panic!("Error overtook buffered delta");
            }
        };
        match next {
            AgentEvent::TextDelta { text, .. } => assert_eq!(text, "late"),
            _ => unreachable!(),
        }
        handle.await.unwrap();
    }

    #[tokio::test]
    async fn fast_path_delta_goes_straight_through() {
        let (bus, mut rx) = EventBus::channel(8);
        bus.publish_delta("r1", "x").await;
        let ev = rx.try_recv().unwrap();
        assert!(matches!(ev, AgentEvent::TextDelta { text, .. } if text == "x"));
    }

    #[test]
    fn event_converts_to_protocol_payload() {
        let ev = AgentEvent::Log(LogLevel::Warn, "careful".into());
        let payload = ev.to_payload();
        let env = protocol::Envelope::new(1, 0, payload);
        let json = serde_json::to_string(&env).unwrap();
        assert!(json.contains("\"level\":\"warn\""));
    }
}
