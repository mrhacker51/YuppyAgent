//! Adapt an MCP server connection into a core [`ToolExecutor`].

use serde_json::Value;

use yuppycode_core::{
    ExecContext, Risk, ToolCall, ToolError, ToolExecutor, ToolFuture, ToolResult, ToolSpec,
};
use yuppycode_mcp::{McpClient, McpToolDef};

use crate::schema::validate_arguments;

pub struct McpToolExecutor {
    client: McpClient,
    tools: Vec<McpToolDef>,
    risk: Risk,
}

impl McpToolExecutor {
    pub fn new(client: McpClient) -> Self {
        Self {
            client,
            tools: Vec::new(),
            risk: Risk::External,
        }
    }

    pub async fn discover(&mut self) -> Result<(), yuppycode_mcp::McpError> {
        self.tools = self.client.list_tools().await?;
        Ok(())
    }

    pub fn set_risk(&mut self, risk: Risk) {
        self.risk = risk;
    }

    fn to_spec(def: &McpToolDef) -> ToolSpec {
        ToolSpec {
            name: def.name.clone(),
            description: def.description.clone(),
            input_schema: def.input_schema.clone(),
            risk: Risk::External,
        }
    }
}

impl ToolExecutor for McpToolExecutor {
    fn specs(&self) -> Vec<ToolSpec> {
        self.tools.iter().map(Self::to_spec).collect()
    }

    fn validate(&self, name: &str, args: &Value) -> Result<(), String> {
        let def = self
            .tools
            .iter()
            .find(|d| d.name == name)
            .ok_or_else(|| format!("unknown MCP tool '{name}'"))?;
        validate_arguments(&def.input_schema, args)
    }

    fn requires_approval(&self, _call: &ToolCall) -> bool {
        // MCP servers are always treated as external / high-risk.
        true
    }

    fn execute(&self, call: ToolCall, ctx: ExecContext) -> ToolFuture {
        let client = self.client.clone();
        let tools = self.tools.clone();
        Box::pin(async move {
            if ctx.cancel.is_cancelled() {
                return Err(ToolError::Cancelled);
            }
            let def = tools
                .iter()
                .find(|d| d.name == call.name)
                .ok_or_else(|| ToolError::Unknown(call.name.clone()))?;
            let out = client
                .call_tool(&def.name, call.arguments)
                .await
                .map_err(|e| {
                    ToolError::Transport(format!("MCP {}/{}: {e}", client.server_name(), def.name))
                })?;
            let mut result = ToolResult::ok(call.id.clone(), out.text);
            result.is_error = out.is_error;
            result.summary = yuppycode_core::tools::summarize(&result.output);
            Ok(result)
        })
    }
}
