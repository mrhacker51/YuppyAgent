//! stdio MCP server that exposes the team bus to real agent CLIs.
//!
//! This is the piece that makes two different vendor CLIs talk to each other:
//! `claude` is started with `--mcp-config` and `codex` with
//! `-c mcp_servers.yuppy.…`, and both then see the same five `yuppy_*` tools
//! backed by one SQLite file. A Claude Code worker can ask the Codex worker a
//! question and block until it answers, without either one knowing anything
//! about the other's protocol.

use std::io::{BufRead, Write};
use std::time::Duration;

use serde_json::{Value, json};

use crate::store::{Bus, BusError, EVERYONE, HUMAN, JoinRequest, Outgoing};

/// Longest a single `yuppy_wait` may block, so a stuck teammate cannot wedge
/// an agent process forever.
pub const MAX_WAIT_SECS: u64 = 300;
pub const DEFAULT_WAIT_SECS: u64 = 60;

/// Who this server process speaks for.
#[derive(Debug, Clone)]
pub struct Identity {
    pub name: String,
    pub role: String,
    pub engine: String,
    pub task_id: String,
}

impl Identity {
    /// Build the identity from the environment the engine child was spawned
    /// with (`YUPPY_AGENT`, `YUPPY_AGENT_ROLE`, `YUPPY_ENGINE`, `YUPPY_TASK_ID`).
    /// An unlabelled server still works — it just announces itself honestly.
    pub fn from_env() -> Self {
        let var = |k: &str| std::env::var(k).unwrap_or_default().trim().to_string();
        let name = var("YUPPY_AGENT");
        Self {
            engine: if var("YUPPY_ENGINE").is_empty() {
                "mcp".to_string()
            } else {
                var("YUPPY_ENGINE")
            },
            name: if name.is_empty() {
                format!("anon-{}", std::process::id())
            } else {
                name
            },
            role: var("YUPPY_AGENT_ROLE"),
            task_id: var("YUPPY_TASK_ID"),
        }
    }
}

/// The tool list advertised to every engine. Kept deliberately small: an
/// agent only needs to know who is here, how to say something, and how to
/// wait for a reply.
pub fn tool_defs() -> Vec<Value> {
    vec![
        json!({
            "name": "yuppy_team",
            "description": "List the agents on this mission: name, role, engine, status and how many messages are waiting for each. Call this before messaging anyone.",
            "inputSchema": {"type": "object", "properties": {}}
        }),
        json!({
            "name": "yuppy_send",
            "description": "Send a message to one teammate by name, or to \"*\" for the whole team including the human. Use it to announce what files you are about to change, to ask another agent a question, or to hand off work. Fails if the name is not on the team.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "to": {"type": "string", "description": "Teammate name, or \"*\" for everyone."},
                    "body": {"type": "string", "description": "The message. Say what you need or what you changed; keep it short."},
                    "thread": {"type": "string", "description": "Optional topic key to group the exchange, e.g. the file or task name."}
                },
                "required": ["to", "body"]
            }
        }),
        json!({
            "name": "yuppy_inbox",
            "description": "Read your unread messages and mark them read. Reading consumes them, so do not call it twice for the same thing.",
            "inputSchema": {
                "type": "object",
                "properties": {"limit": {"type": "integer", "description": "Max messages, default 20."}}
            }
        }),
        json!({
            "name": "yuppy_wait",
            "description": "Block until a teammate replies (or the timeout expires). This is how you get a real answer instead of guessing: send a question with yuppy_send, then yuppy_wait. An empty result means nobody answered in time — say so rather than inventing a reply.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "timeout_secs": {"type": "integer", "description": "How long to block, default 60, max 300."},
                    "from": {"type": "string", "description": "Only accept a reply from this teammate."},
                    "limit": {"type": "integer", "description": "Max messages to return, default 20."}
                }
            }
        }),
        json!({
            "name": "yuppy_history",
            "description": "Recent team messages (newest first), optionally filtered to one thread. Useful to catch up on a decision you missed.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "thread": {"type": "string"},
                    "limit": {"type": "integer", "description": "Default 30."}
                }
            }
        }),
    ]
}

/// The operating instructions injected into the initialize result and reused
/// verbatim in the engine prompt, so the agent is told the same rules twice
/// rather than having to discover them.
pub fn team_brief(name: &str, role: &str, teammates: &[String]) -> String {
    use std::fmt::Write as _;
    let mut s = String::new();
    let _ = write!(s, "TEAM BUS ACTIVE. You are {name}");
    if !role.trim().is_empty() {
        let _ = write!(s, " ({role})");
    }
    if teammates.is_empty() {
        let _ = write!(s, ", the only agent on this task.");
    } else {
        let _ = write!(
            s,
            ", one of {} agents: {}.",
            teammates.len() + 1,
            teammates.join(", ")
        );
    }
    let _ = write!(
        s,
        " You have yuppy_team, yuppy_send, yuppy_inbox, yuppy_wait and yuppy_history tools.\n\
         Rules:\n\
         1. Call yuppy_team once at the start to see who is here.\n\
         2. Before editing files another agent might touch, yuppy_send \"*\" what you are about to change.\n\
         3. When you need a decision that belongs to a teammate, ask them with yuppy_send and then \
         yuppy_wait for the answer. Never guess about their work — ask.\n\
         4. When a teammate addresses you, answer with yuppy_send. Silence is a bug.\n\
         5. If yuppy_wait returns nothing, say that nobody answered and state the assumption you made.\n\
         6. Finish by yuppy_send \"*\" a one-paragraph report: what changed, what is untested, what is left."
    );
    s
}

/// One JSON-RPC line in, one optional reply line out.
///
/// Notifications (no `id`) get no reply, which is what MCP clients expect.
/// Every tool error comes back as a normal `tools/call` result with
/// `isError: true` so the model can read and correct it, not as a transport
/// failure.
pub fn handle_line(bus: &Bus, me: &Identity, line: &str) -> Option<String> {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return None;
    }
    let msg: Value = match serde_json::from_str(trimmed) {
        Ok(v) => v,
        Err(e) => {
            return Some(
                json!({
                    "jsonrpc": "2.0",
                    "id": Value::Null,
                    "error": {"code": -32700, "message": format!("parse error: {e}")}
                })
                .to_string(),
            );
        }
    };
    let id = msg.get("id").cloned();
    let method = msg.get("method").and_then(Value::as_str).unwrap_or("");
    let params = msg.get("params").cloned().unwrap_or_else(|| json!({}));

    let result: Result<Value, (i64, String)> = match method {
        "initialize" => {
            let requested = params
                .get("protocolVersion")
                .and_then(Value::as_str)
                .unwrap_or(yuppycode_mcp::CURRENT_PROTOCOL_VERSION);
            let version = if yuppycode_mcp::SUPPORTED_PROTOCOL_VERSIONS.contains(&requested) {
                requested
            } else {
                yuppycode_mcp::CURRENT_PROTOCOL_VERSION
            };
            // Registering here means the model never has to announce itself:
            // the moment a CLI connects, it is addressable by name. If that
            // registration fails the agent MUST be told — a silent failure
            // leaves it convinced it has teammates while nobody can reach it.
            let join_result = bus.join(JoinRequest {
                name: me.name.clone(),
                role: me.role.clone(),
                engine: me.engine.clone(),
                task_id: me.task_id.clone(),
            });
            let mut instructions = team_brief(
                &me.name,
                &me.role,
                &bus.reachable()
                    .unwrap_or_default()
                    .into_iter()
                    .filter(|n| n != &me.name)
                    .collect::<Vec<_>>(),
            );
            if let Err(e) = join_result {
                instructions.push_str(&format!(
                    "\nWARNING: registering you ({name}) on the team bus FAILED: {e}. \
                     You are probably NOT addressable by teammates: they cannot send \
                     to you and yuppy_wait will never return an answer. Say so in \
                     your report instead of waiting for replies that cannot arrive.",
                    name = me.name
                ));
            }
            Ok(json!({
                "protocolVersion": version,
                "capabilities": {"tools": {"listChanged": false}},
                "serverInfo": {
                    "name": "yuppycode-team-bus",
                    "version": env!("CARGO_PKG_VERSION")
                },
                "instructions": instructions
            }))
        }
        "ping" => Ok(json!({})),
        "tools/list" => Ok(json!({"tools": tool_defs()})),
        "tools/call" => {
            let name = params.get("name").and_then(Value::as_str).unwrap_or("");
            let args = params
                .get("arguments")
                .cloned()
                .unwrap_or_else(|| json!({}));
            match call_tool(bus, me, name, &args) {
                Ok(text) => {
                    Ok(json!({"content": [{"type": "text", "text": text}], "isError": false}))
                }
                Err(e) => Ok(
                    json!({"content": [{"type": "text", "text": e.to_string()}], "isError": true}),
                ),
            }
        }
        // Notifications and anything we do not implement.
        "" => Err((-32600, "missing method".into())),
        other if other.starts_with("notifications/") => return None,
        other => Err((
            -32601,
            format!(
                "method not found: {other} (supported: initialize, tools/list, tools/call, ping)"
            ),
        )),
    };

    let reply = match result {
        Ok(value) => json!({"jsonrpc":"2.0","id": id.unwrap_or(Value::Null),"result": value}),
        Err((code, message)) => {
            json!({"jsonrpc":"2.0","id": id.unwrap_or(Value::Null),"error":{"code":code,"message":message}})
        }
    };
    Some(reply.to_string())
}

/// Normalise a tool name as an MCP client sent it.
///
/// Claude Code addresses server tools by their fully-qualified name
/// (`mcp__yuppy__yuppy_send`) in some call paths while Codex sends the bare
/// `yuppy_send`, and trailing whitespace has been seen too. Both must reach
/// the same handler: a coordination tool that answers "unknown tool" to a
/// correctly-intended call makes the agent believe it has no teammates.
pub fn normalize_tool_name(raw: &str) -> String {
    let name = raw.trim();
    match name.split_once("__") {
        // "mcp__<server>__<tool>" → "<tool>"; "mcp__yuppy" has no tool part.
        Some((_, rest)) if name.starts_with("mcp__") => match rest.split_once("__") {
            Some((_, tool)) => tool.to_string(),
            None => name.to_string(),
        },
        _ => name.to_string(),
    }
}

fn call_tool(bus: &Bus, me: &Identity, raw_name: &str, args: &Value) -> Result<String, BusError> {
    let name = normalize_tool_name(raw_name);
    let name = name.as_str();
    let field = |k: &str| {
        args.get(k)
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string()
    };
    let int_field = |k: &str, default: i64| args.get(k).and_then(Value::as_i64).unwrap_or(default);

    match name {
        "yuppy_team" => {
            let members = bus.members()?;
            if members.is_empty() {
                return Ok("no agents on the bus yet".into());
            }
            let mut out = String::new();
            for m in members {
                out.push_str(&format!(
                    "- {} | role={} | engine={} | status={} | unread={} | task={}\n",
                    m.name,
                    if m.role.is_empty() { "-" } else { &m.role },
                    if m.engine.is_empty() { "-" } else { &m.engine },
                    m.status,
                    m.unread,
                    if m.task_id.is_empty() {
                        "-"
                    } else {
                        &m.task_id
                    },
                ));
            }
            Ok(out.trim_end().to_string())
        }
        "yuppy_send" => {
            let to = field("to");
            let body = field("body");
            if to.is_empty() {
                return Err(BusError::EmptyBody);
            }
            let thread = {
                let t = field("thread");
                if t.is_empty() { None } else { Some(t) }
            };
            let sent = bus.send(Outgoing {
                sender: me.name.clone(),
                to,
                body,
                thread,
            })?;
            Ok(format!(
                "delivered #{} to {} (thread {})",
                sent.id, sent.recipient, sent.thread
            ))
        }
        "yuppy_inbox" => {
            let limit = int_field("limit", 20).max(1) as usize;
            let msgs = bus.inbox(&me.name, limit)?;
            Ok(render_messages(&msgs, &me.name))
        }
        "yuppy_wait" => {
            let secs = wait_secs(args);
            let from = field("from");
            let limit = int_field("limit", 20).max(1) as usize;
            let msgs = bus.wait(
                &me.name,
                Duration::from_secs(secs),
                if from.is_empty() { None } else { Some(&from) },
                limit,
            )?;
            if msgs.is_empty() {
                return Ok(format!(
                    "nobody answered within {secs}s. Say that in your report instead of guessing what they would have said."
                ));
            }
            Ok(render_messages(&msgs, &me.name))
        }
        "yuppy_history" => {
            let thread = field("thread");
            let limit = int_field("limit", 30).max(1) as usize;
            let msgs = bus.history(
                if thread.is_empty() {
                    None
                } else {
                    Some(&thread)
                },
                limit,
            )?;
            if msgs.is_empty() {
                return Ok("no team messages yet".into());
            }
            let mut out = String::new();
            for m in msgs.into_iter().rev() {
                out.push_str(&format!(
                    "#{} [{}] {} -> {}: {}\n",
                    m.id, m.thread, m.sender, m.recipient, m.body
                ));
            }
            Ok(out.trim_end().to_string())
        }
        other => Err(BusError::UnknownTool(other.to_string())),
    }
}

/// How long a `yuppy_wait` may block, bounded no matter what was asked.
///
/// A stuck teammate must not be able to wedge an agent process for an hour,
/// and a zero-second wait must not turn into an instant "nobody answered".
pub fn wait_secs(args: &Value) -> u64 {
    args.get("timeout_secs")
        .and_then(Value::as_i64)
        .unwrap_or(DEFAULT_WAIT_SECS as i64)
        .clamp(1, MAX_WAIT_SECS as i64) as u64
}

fn render_messages(msgs: &[crate::store::Message], me: &str) -> String {
    if msgs.is_empty() {
        return format!("no unread messages for {me}");
    }
    let mut out = String::new();
    for m in msgs {
        let addressed = if m.recipient == EVERYONE {
            "to everyone"
        } else {
            "to you"
        };
        out.push_str(&format!(
            "#{} [{}] from {} ({}): {}\n",
            m.id, m.thread, m.sender, addressed, m.body
        ));
    }
    out.trim_end().to_string()
}

/// Serve forever on the process' stdin/stdout.
///
/// One client per process is the MCP stdio contract, so a plain blocking loop
/// is correct here — and it means a `yuppy_wait` really blocks this agent and
/// nobody else's.
pub fn serve(bus: Bus, me: Identity) -> std::io::Result<()> {
    // Register up front so teammates can address this agent before the model
    // makes its first tool call.
    let _ = bus.join(JoinRequest {
        name: me.name.clone(),
        role: me.role.clone(),
        engine: me.engine.clone(),
        task_id: me.task_id.clone(),
    });
    let stdin = std::io::stdin();
    let mut stdin = stdin.lock();
    let mut stdout = std::io::stdout().lock();
    let mut line = String::new();
    loop {
        line.clear();
        match stdin.read_line(&mut line) {
            Ok(0) => break,
            Ok(_) => {}
            Err(e) => return Err(e),
        }
        if let Some(reply) = handle_line(&bus, &me, &line) {
            writeln!(stdout, "{reply}")?;
            stdout.flush()?;
        }
    }
    let _ = bus.leave(&me.name);
    Ok(())
}

/// The bus path this child should use (the parent exports `YUPPY_BUS`).
pub fn bus_path_from_env() -> std::path::PathBuf {
    crate::store::default_bus_path()
}

/// Open the bus for the current process, or fail loudly enough to be logged.
pub fn open_bus() -> Result<Bus, BusError> {
    Bus::open(bus_path_from_env())
}

/// The five tools plus a name is everything an agent needs; this helper exists
/// so the CLI can print the same brief a human would get.
pub fn human_handle(name: &str) -> Identity {
    Identity {
        name: name.to_string(),
        role: "human at the terminal".into(),
        engine: HUMAN.into(),
        task_id: String::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn scratch(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "yuppy-mcp-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir.join("team.sqlite3")
    }

    fn rpc(bus: &Bus, me: &Identity, method: &str, params: Value) -> Value {
        let line = json!({"jsonrpc":"2.0","id":1,"method":method,"params":params}).to_string();
        let out = handle_line(bus, me, &line).expect("a reply");
        serde_json::from_str(&out).unwrap()
    }

    fn call(bus: &Bus, me: &Identity, tool: &str, args: Value) -> (String, bool) {
        let r = rpc(
            bus,
            me,
            "tools/call",
            json!({"name": tool, "arguments": args}),
        );
        let res = &r["result"];
        (
            res["content"][0]["text"].as_str().unwrap_or("").to_string(),
            res["isError"].as_bool().unwrap_or(false),
        )
    }

    fn ada() -> Identity {
        Identity {
            name: "ada".into(),
            role: "backend".into(),
            engine: "claude-code".into(),
            task_id: "m1-backend".into(),
        }
    }

    fn nova() -> Identity {
        Identity {
            name: "nova".into(),
            role: "qa".into(),
            engine: "codex".into(),
            task_id: "m1-qa".into(),
        }
    }

    #[test]
    fn initialize_negotiates_version_and_registers_the_agent() {
        let bus = Bus::open(scratch("init")).unwrap();
        let r = rpc(
            &bus,
            &ada(),
            "initialize",
            json!({"protocolVersion":"2024-11-05","capabilities":{}}),
        );
        assert_eq!(r["result"]["protocolVersion"], "2024-11-05");
        assert_eq!(r["result"]["serverInfo"]["name"], "yuppycode-team-bus");
        let names: Vec<String> = bus.members().unwrap().into_iter().map(|m| m.name).collect();
        assert_eq!(names, vec!["ada".to_string()], "connect == addressable");
    }

    #[test]
    fn claude_can_ask_codex_something_and_read_the_answer() {
        // The whole point of the bus, exercised over the real MCP surface.
        let path = scratch("conversation");
        let bus = Bus::open(&path).unwrap();
        rpc(&bus, &ada(), "initialize", json!({}));
        rpc(&bus, &nova(), "initialize", json!({}));

        let (text, err) = call(
            &bus,
            &ada(),
            "yuppy_send",
            json!({"to":"nova","body":"does /users already validate the tenant id?","thread":"api"}),
        );
        assert!(!err, "{text}");
        assert!(text.contains("delivered"), "{text}");

        let (text, err) = call(&bus, &nova(), "yuppy_wait", json!({"timeout_secs": 5}));
        assert!(!err, "{text}");
        assert!(text.contains("tenant id"), "nova read the question: {text}");

        let (text, _) = call(
            &bus,
            &nova(),
            "yuppy_send",
            json!({"to":"ada","body":"no — middleware is missing, add it in src/middleware"}),
        );
        assert!(text.contains("delivered"), "{text}");

        let (text, _) = call(&bus, &ada(), "yuppy_inbox", json!({}));
        assert!(
            text.contains("src/middleware"),
            "ada got the answer: {text}"
        );
        let (text, _) = call(&bus, &ada(), "yuppy_inbox", json!({}));
        assert!(text.contains("no unread messages"), "consumed once: {text}");
    }

    #[test]
    fn team_lists_teammates_with_unread_counts() {
        let bus = Bus::open(scratch("team")).unwrap();
        rpc(&bus, &ada(), "initialize", json!({}));
        rpc(&bus, &nova(), "initialize", json!({}));
        call(
            &bus,
            &ada(),
            "yuppy_send",
            json!({"to":"*","body":"touching src/api"}),
        );
        let (text, err) = call(&bus, &ada(), "yuppy_team", json!({}));
        assert!(!err);
        assert!(text.contains("nova"), "{text}");
        assert!(text.contains("engine=codex"), "{text}");
        assert!(text.contains("unread=1"), "{text}");
    }

    #[test]
    fn a_wrong_teammate_name_is_correctable_not_fatal() {
        let bus = Bus::open(scratch("badname")).unwrap();
        rpc(&bus, &ada(), "initialize", json!({}));
        rpc(&bus, &nova(), "initialize", json!({}));
        let (text, err) = call(
            &bus,
            &ada(),
            "yuppy_send",
            json!({"to":"novva","body":"hi"}),
        );
        assert!(err, "a typo must be reported as a tool error");
        assert!(text.contains("novva") && text.contains("nova"), "{text}");
        // …and the same agent can still carry on after correcting itself.
        let (_, err) = call(&bus, &ada(), "yuppy_send", json!({"to":"nova","body":"hi"}));
        assert!(!err);
    }

    #[test]
    fn wait_times_out_with_honest_text() {
        let bus = Bus::open(scratch("wait")).unwrap();
        rpc(&bus, &ada(), "initialize", json!({}));
        let start = std::time::Instant::now();
        let (text, err) = call(&bus, &ada(), "yuppy_wait", json!({"timeout_secs": 1}));
        assert!(!err, "a timeout is not an error: {text}");
        assert!(text.contains("nobody answered"), "{text}");
        assert!(start.elapsed() >= Duration::from_millis(900));
    }

    #[test]
    fn the_wait_timeout_is_bounded_whatever_the_agent_asks_for() {
        assert_eq!(wait_secs(&json!({"timeout_secs": 99_999})), MAX_WAIT_SECS);
        assert_eq!(wait_secs(&json!({"timeout_secs": 0})), 1);
        assert_eq!(wait_secs(&json!({"timeout_secs": -5})), 1);
        assert_eq!(wait_secs(&json!({})), DEFAULT_WAIT_SECS);
        assert_eq!(wait_secs(&json!({"timeout_secs": 20})), 20);
    }

    #[test]
    fn notifications_are_not_answered_and_unknown_methods_are_rejected() {
        let bus = Bus::open(scratch("methods")).unwrap();
        let me = ada();
        assert!(
            handle_line(
                &bus,
                &me,
                &json!({"jsonrpc":"2.0","method":"notifications/initialized"}).to_string()
            )
            .is_none()
        );
        let r = rpc(&bus, &me, "tools/nope", json!({}));
        assert_eq!(r["error"]["code"], -32601);
        assert!(
            r["error"]["message"]
                .as_str()
                .unwrap()
                .contains("initialize")
        );
    }

    #[test]
    fn tools_list_exposes_the_five_bus_tools() {
        let bus = Bus::open(scratch("list")).unwrap();
        let r = rpc(&bus, &ada(), "tools/list", json!({}));
        let tools = r["result"]["tools"].as_array().unwrap();
        assert_eq!(tools.len(), 5);
        for name in [
            "yuppy_team",
            "yuppy_send",
            "yuppy_inbox",
            "yuppy_wait",
            "yuppy_history",
        ] {
            assert!(tools.iter().any(|t| t["name"] == name), "missing {name}");
        }
    }

    #[test]
    fn every_client_spelling_of_a_tool_name_reaches_the_same_handler() {
        // Claude Code sends the fully-qualified name in some call paths and
        // Codex sends the bare one; both must work, or an agent concludes it
        // has no coordination tools at all.
        let bus = Bus::open(scratch("names")).unwrap();
        rpc(&bus, &ada(), "initialize", json!({}));
        rpc(&bus, &nova(), "initialize", json!({}));
        for raw in [
            "yuppy_send",
            "  yuppy_send  ",
            "mcp__yuppy__yuppy_send",
            "mcp__anything__yuppy_send",
        ] {
            let (_text, err) = call(
                &bus,
                &ada(),
                raw,
                json!({"to": "nova", "body": format!("via {raw}")}),
            );
            assert!(!err, "{raw} must be understood");
        }
        let (text, _) = call(&bus, &nova(), "yuppy_inbox", json!({}));
        assert_eq!(text.lines().count(), 4, "all four landed: {text}");
        assert_eq!(normalize_tool_name("mcp__yuppy"), "mcp__yuppy");
        assert_eq!(normalize_tool_name("yuppy_team"), "yuppy_team");
    }

    #[test]
    fn brief_names_the_teammates_and_the_wait_rule() {
        let brief = team_brief("ada", "backend", &["nova".into(), "sol".into()]);
        assert!(brief.contains("ada") && brief.contains("backend"));
        assert!(brief.contains("nova") && brief.contains("sol"));
        assert!(
            brief.contains("yuppy_wait"),
            "the agent must be told to wait"
        );
        assert!(brief.contains("Never guess"));
    }
}
