//! MCP wire types (subset used by YuppyCode).

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Protocol revisions this client accepts, newest first. The newest one is
/// offered in `initialize`; the server may negotiate down to any of these.
pub const SUPPORTED_PROTOCOL_VERSIONS: &[&str] = &["2025-06-18", "2025-03-26", "2024-11-05"];

pub const CURRENT_PROTOCOL_VERSION: &str = SUPPORTED_PROTOCOL_VERSIONS[0];

/// A tool as advertised by an MCP server.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct McpToolDef {
    pub name: String,
    #[serde(default)]
    pub description: String,
    /// JSON Schema for the `arguments` object.
    #[serde(default = "default_schema", rename = "inputSchema")]
    pub input_schema: Value,
}

fn default_schema() -> Value {
    serde_json::json!({"type": "object"})
}

/// Parsed content blocks from a `tools/call` result.
#[derive(Debug, Clone, PartialEq)]
pub struct McpCallOutput {
    pub text: String,
    pub is_error: bool,
}

impl McpCallOutput {
    /// Extract text from a tools/call `result` object. Non-text blocks are
    /// summarised inline so nothing silently vanishes.
    pub fn from_result(result: &Value) -> Self {
        let is_error = result
            .get("isError")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let mut text = String::new();
        if let Some(blocks) = result.get("content").and_then(Value::as_array) {
            for block in blocks {
                match block.get("type").and_then(Value::as_str) {
                    Some("text") => {
                        if let Some(t) = block.get("text").and_then(Value::as_str) {
                            if !text.is_empty() {
                                text.push('\n');
                            }
                            text.push_str(t);
                        }
                    }
                    Some(other) => {
                        text.push_str(&format!("[{other} content omitted]\n"));
                    }
                    None => {
                        text.push_str("[malformed content block]\n");
                    }
                }
            }
        }
        Self { text, is_error }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tool_def_deserialises_with_schema_alias() {
        let json = serde_json::json!({
            "name": "fetch",
            "description": "get url",
            "inputSchema": {"type": "object", "properties": {"url": {"type": "string"}}}
        });
        let t: McpToolDef = serde_json::from_value(json).unwrap();
        assert_eq!(t.name, "fetch");
        assert!(t.input_schema.get("properties").is_some());
    }

    #[test]
    fn missing_schema_defaults_to_object() {
        let t: McpToolDef = serde_json::from_str(r#"{"name":"x"}"#).unwrap();
        assert_eq!(t.input_schema["type"], "object");
    }

    #[test]
    fn call_output_collects_text_blocks_and_flags_errors() {
        let r = serde_json::json!({
            "content": [
                {"type":"text","text":"a"},
                {"type":"image","data":"…"},
                {"type":"text","text":"b"}
            ],
            "isError": true
        });
        let out = McpCallOutput::from_result(&r);
        assert!(out.is_error);
        assert!(out.text.contains('a') && out.text.contains('b'));
        assert!(out.text.contains("image content omitted"));
    }

    #[test]
    fn malformed_block_is_visible_not_dropped() {
        let r = serde_json::json!({"content":[{"nonsense":true}]});
        assert!(McpCallOutput::from_result(&r).text.contains("malformed"));
    }
}
