//! Aggregate tool registry: local tools + MCP tools in one executor.

use serde_json::Value;

use yuppycode_core::{ExecContext, ToolCall, ToolError, ToolExecutor, ToolFuture, ToolSpec};

use crate::local::LocalToolExecutor;
use crate::mcp::McpToolExecutor;
use crate::policy::LocalToolPolicy;
use crate::schema::validate_arguments;

#[derive(Debug, thiserror::Error)]
pub enum ToolRegistryError {
    #[error("no executor registered for tool '{0}'")]
    UnknownTool(String),
    #[error("MCP discovery failed: {0}")]
    Mcp(yuppycode_mcp::McpError),
}

/// Combines local and MCP executors. Handles schema validation itself so
/// every sub-executor sees only validated arguments.
pub struct AggregateToolExecutor {
    local: LocalToolExecutor,
    mcps: Vec<McpToolExecutor>,
}

impl AggregateToolExecutor {
    pub fn new(local_policy: LocalToolPolicy) -> Self {
        Self {
            local: LocalToolExecutor::new(local_policy),
            mcps: Vec::new(),
        }
    }

    pub fn add_mcp(&mut self, mcp: McpToolExecutor) {
        self.mcps.push(mcp);
    }

    pub async fn discover_mcps(&mut self) -> Result<(), ToolRegistryError> {
        for mcp in &mut self.mcps {
            mcp.discover().await.map_err(ToolRegistryError::Mcp)?;
        }
        Ok(())
    }

    fn find_spec(&self, name: &str) -> Option<ToolSpec> {
        self.local
            .specs()
            .into_iter()
            .find(|s| s.name == name)
            .or_else(|| {
                self.mcps
                    .iter()
                    .flat_map(|m| m.specs())
                    .find(|s| s.name == name)
            })
    }

    fn find_executor(
        &self,
        name: &str,
    ) -> Result<Box<dyn Fn(ToolCall, ExecContext) -> ToolFuture + Send + Sync + '_>, ToolError>
    {
        if self.local.specs().iter().any(|s| s.name == name) {
            let local = &self.local;
            return Ok(Box::new(move |call, ctx| local.execute(call, ctx)));
        }
        for mcp in &self.mcps {
            if mcp.specs().iter().any(|s| s.name == name) {
                let mcp_ref = mcp;
                return Ok(Box::new(move |call, ctx| mcp_ref.execute(call, ctx)));
            }
        }
        Err(ToolError::Unknown(name.into()))
    }
}

impl ToolExecutor for AggregateToolExecutor {
    fn specs(&self) -> Vec<ToolSpec> {
        let mut out = self.local.specs();
        for m in &self.mcps {
            out.extend(m.specs());
        }
        out
    }

    fn validate(&self, name: &str, args: &Value) -> Result<(), String> {
        if let Some(spec) = self.find_spec(name) {
            validate_arguments(&spec.input_schema, args)
        } else {
            Err(format!("unknown tool '{name}'"))
        }
    }

    fn requires_approval(&self, call: &ToolCall) -> bool {
        if self.local.specs().iter().any(|s| s.name == call.name) {
            return self.local.requires_approval(call);
        }
        for m in &self.mcps {
            if m.specs().iter().any(|s| s.name == call.name) {
                return m.requires_approval(call);
            }
        }
        false
    }

    fn execute(&self, call: ToolCall, ctx: ExecContext) -> ToolFuture {
        match self.find_executor(&call.name) {
            Ok(exec) => exec(call, ctx),
            Err(e) => Box::pin(async move { Err(e) }),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use yuppycode_core::Risk;

    #[test]
    fn aggregate_lists_local_tools() {
        let agg = AggregateToolExecutor::new(LocalToolPolicy::ReadOnly);
        let names: Vec<_> = agg.specs().iter().map(|s| s.name.clone()).collect();
        assert!(names.contains(&"read_file".into()));
        assert!(!names.contains(&"write_file".into()));
    }

    #[test]
    fn validate_rejects_unknown() {
        let agg = AggregateToolExecutor::new(LocalToolPolicy::WorkspaceWrite);
        assert!(agg.validate("nope", &serde_json::json!({})).is_err());
    }

    #[test]
    fn write_spec_appears_in_workspace_write_mode() {
        let agg = AggregateToolExecutor::new(LocalToolPolicy::WorkspaceWrite);
        assert!(agg.specs().iter().any(|s| s.name == "write_file"));
        assert!(agg.specs().iter().any(|s| s.risk == Risk::Execute));
    }
}
