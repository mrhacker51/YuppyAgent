//! Parser for Claude Code's headless `--output-format stream-json` output.
//!
//! A headless worker (`claude -p … --output-format stream-json --verbose`)
//! prints one JSON object per line: `system` records (init, hooks),
//! `assistant` messages (text and `tool_use` blocks), `user` messages
//! (`tool_result` blocks), rate-limit notices and one final `result` record.
//! [`StreamParser`] turns that into short human-readable progress lines for
//! the operator (`● Read src/lib.rs`, `● Bash: cargo test`, assistant text)
//! and the final [`ResultSummary`] the task report is built from.
//!
//! The parser is deliberately forgiving: unknown record types are skipped,
//! malformed JSON is shown verbatim (truncated), so a CLI upgrade that adds
//! record kinds degrades to "less detail", never to a failed task.

use std::path::{Path, PathBuf};

use serde_json::Value;

/// Longest progress line emitted, in characters.
pub const MAX_LINE_CHARS: usize = 240;

/// One thing worth telling the operator about.
#[derive(Debug, Clone, PartialEq)]
pub enum StreamEvent {
    /// A short, single-line, human-readable progress line.
    Progress(String),
    /// The terminal `result` record of the turn.
    Result(ResultSummary),
}

/// The final `result` record of one headless turn.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct ResultSummary {
    /// The agent's final answer text (`result`).
    pub text: String,
    /// `is_error` as reported by the CLI.
    pub is_error: bool,
    /// `subtype`, e.g. "success", "error_max_turns".
    pub subtype: String,
    pub num_turns: Option<u64>,
    pub duration_ms: Option<u64>,
    pub cost_usd: Option<f64>,
}

impl ResultSummary {
    /// One-line summary, e.g. `✓ done · 3 turns · 12.4s · $0.0812`.
    pub fn line(&self) -> String {
        let mut parts = vec![if self.is_error {
            format!("✗ failed ({})", if self.subtype.is_empty() { "error" } else { &self.subtype })
        } else {
            "✓ done".to_string()
        }];
        if let Some(n) = self.num_turns {
            parts.push(format!("{n} turn{}", if n == 1 { "" } else { "s" }));
        }
        if let Some(ms) = self.duration_ms {
            parts.push(format!("{:.1}s", ms as f64 / 1000.0));
        }
        if let Some(c) = self.cost_usd {
            parts.push(format!("${c:.4}"));
        }
        parts.join(" · ")
    }
}

/// Stateful line parser. `root` (the task's working directory) is stripped
/// from tool paths so `● Edit src/main.rs` stays short.
#[derive(Debug, Clone, Default)]
pub struct StreamParser {
    root: Option<PathBuf>,
}

impl StreamParser {
    pub fn new(root: Option<&Path>) -> Self {
        Self {
            root: root.map(Path::to_path_buf),
        }
    }

    /// Parse one stdout line. Blank lines yield nothing.
    pub fn feed(&mut self, line: &str) -> Vec<StreamEvent> {
        let line = line.trim();
        if line.is_empty() {
            return Vec::new();
        }
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            // Not JSON (a CLI warning printed to stdout, a plain-text mode):
            // show it rather than lose it.
            return vec![StreamEvent::Progress(clip(line))];
        };
        match v.get("type").and_then(Value::as_str) {
            Some("assistant") => self.assistant(&v),
            Some("user") => tool_errors(&v),
            Some("result") => vec![StreamEvent::Result(result(&v))],
            Some("system") if v.get("subtype").and_then(Value::as_str) == Some("init") => {
                let model = v.get("model").and_then(Value::as_str).unwrap_or("");
                vec![StreamEvent::Progress(if model.is_empty() {
                    "● session started".to_string()
                } else {
                    format!("● session started · {model}")
                })]
            }
            _ => Vec::new(),
        }
    }

    fn assistant(&self, v: &Value) -> Vec<StreamEvent> {
        let Some(blocks) = v.pointer("/message/content").and_then(Value::as_array) else {
            return Vec::new();
        };
        let mut out = Vec::new();
        for b in blocks {
            match b.get("type").and_then(Value::as_str) {
                Some("text") => {
                    let text = b.get("text").and_then(Value::as_str).unwrap_or("");
                    let one = one_line(text);
                    if !one.is_empty() {
                        out.push(StreamEvent::Progress(clip(&one)));
                    }
                }
                Some("tool_use") => {
                    let name = b.get("name").and_then(Value::as_str).unwrap_or("tool");
                    let input = b.get("input").cloned().unwrap_or(Value::Null);
                    out.push(StreamEvent::Progress(clip(&self.tool_line(name, &input))));
                }
                _ => {}
            }
        }
        out
    }

    fn tool_line(&self, name: &str, input: &Value) -> String {
        let s = |k: &str| input.get(k).and_then(Value::as_str).unwrap_or("");
        let path = |k: &str| self.short_path(s(k));
        match name {
            "Read" => format!("● Read {}", path("file_path")),
            "Edit" | "MultiEdit" => format!("● Edit {}", path("file_path")),
            "Write" => format!("● Write {}", path("file_path")),
            "NotebookEdit" => format!("● Edit {}", path("notebook_path")),
            "Bash" => format!("● Bash: {}", one_line(s("command"))),
            "Grep" => format!("● Grep {}", s("pattern")),
            "Glob" => format!("● Glob {}", s("pattern")),
            "WebFetch" => format!("● WebFetch {}", s("url")),
            "WebSearch" => format!("● WebSearch {}", s("query")),
            "Task" | "Agent" => format!("● Task: {}", one_line(s("description"))),
            "TodoWrite" => "● Update todos".to_string(),
            other => match other.strip_prefix("mcp__") {
                Some(rest) => {
                    let tool = rest.split("__").last().unwrap_or(rest);
                    format!("● {tool}")
                }
                None => format!("● {other}"),
            },
        }
    }

    fn short_path(&self, p: &str) -> String {
        if let Some(root) = &self.root
            && let Ok(rel) = Path::new(p).strip_prefix(root)
            && !rel.as_os_str().is_empty()
        {
            return rel.display().to_string();
        }
        p.to_string()
    }
}

fn tool_errors(v: &Value) -> Vec<StreamEvent> {
    let Some(blocks) = v.pointer("/message/content").and_then(Value::as_array) else {
        return Vec::new();
    };
    blocks
        .iter()
        .filter(|b| b.get("type").and_then(Value::as_str) == Some("tool_result"))
        .filter(|b| b.get("is_error").and_then(Value::as_bool) == Some(true))
        .map(|b| {
            let text = match b.get("content") {
                Some(Value::String(s)) => s.clone(),
                Some(Value::Array(parts)) => parts
                    .iter()
                    .filter_map(|p| p.get("text").and_then(Value::as_str))
                    .collect::<Vec<_>>()
                    .join(" "),
                _ => String::new(),
            };
            StreamEvent::Progress(clip(&format!("  ✗ {}", one_line(&text))))
        })
        .collect()
}

fn result(v: &Value) -> ResultSummary {
    ResultSummary {
        text: v
            .get("result")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        is_error: v.get("is_error").and_then(Value::as_bool).unwrap_or(false),
        subtype: v
            .get("subtype")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
        num_turns: v.get("num_turns").and_then(Value::as_u64),
        duration_ms: v.get("duration_ms").and_then(Value::as_u64),
        cost_usd: v.get("total_cost_usd").and_then(Value::as_f64),
    }
}

/// Collapse all whitespace runs (newlines included) into single spaces.
fn one_line(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn clip(s: &str) -> String {
    if s.chars().count() <= MAX_LINE_CHARS {
        return s.to_string();
    }
    let mut out: String = s.chars().take(MAX_LINE_CHARS - 1).collect();
    out.push('…');
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn progress(events: Vec<StreamEvent>) -> Vec<String> {
        events
            .into_iter()
            .filter_map(|e| match e {
                StreamEvent::Progress(p) => Some(p),
                StreamEvent::Result(_) => None,
            })
            .collect()
    }

    #[test]
    fn tool_uses_become_short_bullets_relative_to_the_workdir() {
        let mut p = StreamParser::new(Some(Path::new("/work/repo")));
        let line = r#"{"type":"assistant","message":{"content":[
            {"type":"tool_use","name":"Read","input":{"file_path":"/work/repo/src/lib.rs"}},
            {"type":"tool_use","name":"Edit","input":{"file_path":"/work/repo/src/main.rs","old_string":"a","new_string":"b"}},
            {"type":"tool_use","name":"Bash","input":{"command":"cargo test\n  -p x"}},
            {"type":"tool_use","name":"mcp__yuppy__yuppy_send","input":{}},
            {"type":"tool_use","name":"Write","input":{"file_path":"/elsewhere/a.txt"}}
        ]}}"#
            .replace('\n', " ");
        assert_eq!(
            progress(p.feed(&line)),
            vec![
                "● Read src/lib.rs",
                "● Edit src/main.rs",
                "● Bash: cargo test -p x",
                "● yuppy_send",
                "● Write /elsewhere/a.txt",
            ]
        );
    }

    #[test]
    fn assistant_text_is_one_clipped_line_and_thinking_is_skipped() {
        let mut p = StreamParser::default();
        let long = "word ".repeat(200);
        let line = serde_json::json!({"type":"assistant","message":{"content":[
            {"type":"thinking","thinking":"secret"},
            {"type":"text","text":"Plan:\n1. read\n2. edit"},
            {"type":"text","text": long}
        ]}})
        .to_string();
        let out = progress(p.feed(&line));
        assert_eq!(out[0], "Plan: 1. read 2. edit");
        assert_eq!(out[1].chars().count(), MAX_LINE_CHARS);
        assert!(out[1].ends_with('…'));
        assert_eq!(out.len(), 2);
    }

    #[test]
    fn result_record_is_parsed_with_a_summary_line() {
        let mut p = StreamParser::default();
        let ev = p.feed(
            r#"{"type":"result","subtype":"success","is_error":false,"result":"All green.","num_turns":3,"duration_ms":12400,"total_cost_usd":0.0812}"#,
        );
        let StreamEvent::Result(r) = &ev[0] else {
            panic!("{ev:?}")
        };
        assert_eq!(r.text, "All green.");
        assert!(!r.is_error);
        assert_eq!(r.line(), "✓ done · 3 turns · 12.4s · $0.0812");
        let err = ResultSummary {
            is_error: true,
            subtype: "error_max_turns".into(),
            ..Default::default()
        };
        assert_eq!(err.line(), "✗ failed (error_max_turns)");
    }

    #[test]
    fn noise_is_skipped_and_garbage_is_shown_verbatim() {
        let mut p = StreamParser::default();
        assert!(p.feed("").is_empty());
        assert!(p.feed(r#"{"type":"rate_limit_event"}"#).is_empty());
        assert!(p.feed(r#"{"type":"system","subtype":"hook_started"}"#).is_empty());
        assert_eq!(
            progress(p.feed(r#"{"type":"system","subtype":"init","model":"claude-x"}"#)),
            vec!["● session started · claude-x"]
        );
        assert_eq!(progress(p.feed("warning: something")), vec!["warning: something"]);
        // Successful tool results are not echoed; failures are.
        assert!(p
            .feed(r#"{"type":"user","message":{"content":[{"type":"tool_result","content":"ok"}]}}"#)
            .is_empty());
        assert_eq!(
            progress(p.feed(
                r#"{"type":"user","message":{"content":[{"type":"tool_result","is_error":true,"content":"permission denied\nfor Bash"}]}}"#
            )),
            vec!["  ✗ permission denied for Bash"]
        );
    }
}
