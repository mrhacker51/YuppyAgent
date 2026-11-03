//! Human-in-the-loop approval for high-risk tool calls.

use std::future::Future;
use std::pin::Pin;

use crate::tools::ToolCall;

/// Sent to the user (TUI modal, future web dialog) before a risky call runs.
#[derive(Debug, Clone)]
pub struct ApprovalRequest {
    pub run_id: String,
    pub call: ToolCall,
    /// Why the engine is asking (risk class + workspace hints).
    pub reason: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ApprovalDecision {
    Approved,
    Denied {
        reason: String,
    },
    /// The gate could not reach a human in time.
    TimedOut,
}

impl ApprovalDecision {
    pub fn approved(&self) -> bool {
        matches!(self, ApprovalDecision::Approved)
    }
}

pub type ApprovalFuture = Pin<Box<dyn Future<Output = ApprovalDecision> + Send + 'static>>;

/// Decides whether a risky call may proceed.
pub trait ApprovalGate: Send + Sync {
    fn decide(&self, request: ApprovalRequest) -> ApprovalFuture;
}

/// Auto-approve everything. Only valid in explicitly opted-in sandboxes.
pub struct AlwaysApprove;

impl ApprovalGate for AlwaysApprove {
    fn decide(&self, _r: ApprovalRequest) -> ApprovalFuture {
        Box::pin(async { ApprovalDecision::Approved })
    }
}

/// Deny every high-risk call (read-only agents, CI).
pub struct AlwaysDeny;

impl ApprovalGate for AlwaysDeny {
    fn decide(&self, _r: ApprovalRequest) -> ApprovalFuture {
        Box::pin(async {
            ApprovalDecision::Denied {
                reason: "policy denies high-risk tool calls".into(),
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{CallId, tools::ToolCall};

    fn call() -> ToolCall {
        ToolCall {
            id: CallId::next(),
            name: "shell".into(),
            arguments: serde_json::json!({}),
        }
    }

    #[tokio::test]
    async fn gates_decide_deterministically() {
        let req = ApprovalRequest {
            run_id: "r".into(),
            call: call(),
            reason: "test".into(),
        };
        assert!(AlwaysApprove.decide(req.clone()).await.approved());
        assert!(!AlwaysDeny.decide(req).await.approved());
    }
}
