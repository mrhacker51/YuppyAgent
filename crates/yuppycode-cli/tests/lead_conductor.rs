//! End-to-end proof of the lead seat: the operator's UI opens a lead
//! `claude-code` terminal, that seat is launched with the conductor MCP
//! server, and a `yuppy_dispatch` call through it runs two Claude Code
//! worker tasks *at the same time* — with their `task_state` stream reaching
//! the operator's own WebSocket, which is a different connection from the
//! conductor that submitted them.
//!
//! Nothing real is contacted: a fake `claude` executable is first on
//! `PATH`. The fake `claude` started in the lead PTY (no `-p`) records
//! the argv it was given; the test then reads the `--mcp-config` file from
//! that argv and drives the exact MCP server command it names, speaking
//! JSON-RPC over stdio the way Claude Code would.

use std::collections::{HashMap, HashSet};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::time::{Duration, Instant};

use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tokio_tungstenite::tungstenite::Message;
use yuppycode_protocol::{Envelope, PROTOCOL_VERSION, ServerPayload, TaskStateDto};

const TOKEN: &str = "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210";

struct Killed(Child);

impl Drop for Killed {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

fn stub_clis(dir: &Path) -> PathBuf {
    let bin = dir.join("bin");
    std::fs::create_dir_all(&bin).unwrap();
    // Worker mode (`claude -p …`): record a timed span.
    // Lead mode (interactive claude, no -p): record argv NUL-separated and
    // idle like a real interactive session would.
    let script = r#"#!/bin/sh
NAME=$(basename "$0")
if [ "$1" = "--version" ]; then
  printf 'stub %s 9.9.9\n' "$NAME"
  exit 0
fi
D="${YUPPY_STUB_DIR:?}"
WORKER=0
for a in "$@"; do
  case "$a" in -p) WORKER=1 ;; esac
done
if [ "$WORKER" = 0 ]; then
  for a in "$@"; do printf '%s\0' "$a"; done > "$D/lead-argv.tmp"
  mv "$D/lead-argv.tmp" "$D/lead-argv"
  printf 'lead stub ready\n'
  sleep 120
  exit 0
fi
ID="${YUPPY_TASK_ID:-$NAME-$$}"
printf 'start %s %s %s\n' "$NAME" "$ID" "$(date +%s%N)" >> "$D/trace"
sleep 1.2
printf 'end %s %s %s\n' "$NAME" "$ID" "$(date +%s%N)" >> "$D/trace"
printf 'work by %s\n' "$NAME"
"#;
    for name in ["claude"] {
        let path = bin.join(name);
        std::fs::write(&path, script).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
    }
    bin
}

fn free_port() -> u16 {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    listener.local_addr().unwrap().port()
}

type Ws =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

async fn connect(url: &str, bridge: &mut Child) -> Ws {
    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        match tokio_tungstenite::connect_async(url).await {
            Ok((mut ws, _)) => {
                ws.send(Message::Text(
                    json!({ "version": PROTOCOL_VERSION, "token": TOKEN })
                        .to_string()
                        .into(),
                ))
                .await
                .unwrap();
                loop {
                    let msg = ws.next().await.expect("stream ended").expect("ws error");
                    if let Message::Text(text) = msg
                        && let Ok(env) = serde_json::from_str::<Envelope>(&text)
                        && matches!(env.payload, ServerPayload::Connected)
                    {
                        break;
                    }
                }
                return ws;
            }
            Err(e) => {
                if let Some(status) = bridge.try_wait().unwrap() {
                    panic!("bridge exited before listening ({status}): {e}");
                }
                assert!(Instant::now() < deadline, "bridge never listened: {e}");
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        }
    }
}

async fn next_payload(ws: &mut Ws, deadline: Instant) -> ServerPayload {
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        assert!(!remaining.is_zero(), "timed out waiting for the bridge");
        let msg = tokio::time::timeout(remaining, ws.next())
            .await
            .expect("timed out waiting for the bridge")
            .expect("stream ended")
            .expect("ws error");
        if let Message::Text(text) = msg
            && let Ok(env) = serde_json::from_str::<Envelope>(&text)
        {
            return env.payload;
        }
    }
}

struct Mcp {
    _child: Killed,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
    next_id: u64,
}

impl Mcp {
    fn request(&mut self, method: &str, params: Value) -> Value {
        self.next_id += 1;
        let id = self.next_id;
        writeln!(
            self.stdin,
            "{}",
            json!({"jsonrpc":"2.0","id":id,"method":method,"params":params})
        )
        .unwrap();
        self.stdin.flush().unwrap();
        loop {
            let mut line = String::new();
            let n = self.stdout.read_line(&mut line).unwrap();
            assert!(n > 0, "conductor MCP server exited");
            let v: Value = serde_json::from_str(&line).unwrap();
            if v["id"] == json!(id) {
                return v;
            }
        }
    }

    fn call(&mut self, tool: &str, args: Value) -> (bool, String) {
        let v = self.request("tools/call", json!({"name": tool, "arguments": args}));
        let is_error = v["result"]["isError"].as_bool().unwrap_or(true);
        let text = v["result"]["content"][0]["text"]
            .as_str()
            .unwrap_or_default()
            .to_string();
        (is_error, text)
    }
}

/// Start the MCP server exactly as the lead's `--mcp-config` describes it.
fn spawn_conductor_from(config_path: &Path) -> Mcp {
    let cfg: Value = serde_json::from_str(&std::fs::read_to_string(config_path).unwrap()).unwrap();
    let servers = cfg["mcpServers"].as_object().expect("mcpServers");
    assert_eq!(servers.len(), 1, "exactly one conductor server: {cfg}");
    let (name, server) = servers.iter().next().unwrap();
    assert_eq!(name, "yuppy-conductor");
    let mut cmd = Command::new(server["command"].as_str().unwrap());
    for a in server["args"].as_array().unwrap() {
        cmd.arg(a.as_str().unwrap());
    }
    // Only what the config passes — not the test's own bridge token.
    cmd.env_remove("YUPPY_BRIDGE_TOKEN");
    for (k, v) in server["env"].as_object().unwrap() {
        cmd.env(k, v.as_str().unwrap());
    }
    let mut child = cmd
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .expect("spawn conductor-mcp");
    let stdin = child.stdin.take().unwrap();
    let stdout = BufReader::new(child.stdout.take().unwrap());
    Mcp {
        _child: Killed(child),
        stdin,
        stdout,
        next_id: 0,
    }
}

fn peak_concurrency(trace: &Path, ids: &HashSet<String>) -> usize {
    let text = std::fs::read_to_string(trace).unwrap_or_default();
    let mut spans: HashMap<String, (u128, u128)> = HashMap::new();
    for line in text.lines() {
        let p: Vec<&str> = line.split_whitespace().collect();
        if p.len() < 4 || !ids.contains(p[2]) {
            continue;
        }
        let ts: u128 = p[3].parse().unwrap();
        let e = spans.entry(p[2].to_string()).or_insert((0, 0));
        match p[0] {
            "start" => e.0 = ts,
            "end" => e.1 = ts,
            _ => {}
        }
    }
    let mut events = Vec::new();
    for id in ids {
        let (s, e) = spans
            .get(id)
            .copied()
            .unwrap_or_else(|| panic!("no span for {id}; trace:\n{text}"));
        assert!(s > 0 && e > s, "bad span for {id}");
        events.push((s, 1i32));
        events.push((e, -1i32));
    }
    events.sort_by_key(|e| (e.0, e.1));
    let (mut live, mut peak) = (0i32, 0i32);
    for (_, d) in events {
        live += d;
        peak = peak.max(live);
    }
    peak as usize
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_lead_seat_dispatches_two_claude_workers_in_parallel_and_the_ui_sees_it() {
    let root = tempfile::tempdir().unwrap();
    let workspace = root.path().join("workspace");
    let config = root.path().join("config");
    let log = root.path().join("log");
    for d in [&workspace, &config, &log] {
        std::fs::create_dir_all(d).unwrap();
    }
    let stubs = stub_clis(&log);
    let port = free_port();
    let path = format!(
        "{}:{}",
        stubs.display(),
        std::env::var("PATH").unwrap_or_default()
    );
    let mut bridge = Killed(
        Command::new(env!("CARGO_BIN_EXE_yuppy"))
            .args(["bridge", "--host", "127.0.0.1", "--port", &port.to_string()])
            .current_dir(&workspace)
            .env("PATH", path)
            .env("YUPPY_CONFIG_DIR", &config)
            .env("YUPPY_BRIDGE_TOKEN", TOKEN)
            .env("YUPPY_STUB_DIR", &log)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn bridge"),
    );
    let url = format!("ws://127.0.0.1:{port}");
    let mut ui = connect(&url, &mut bridge.0).await;
    let deadline = Instant::now() + Duration::from_secs(40);

    // 1. The UI opens the lead seat exactly as the frontend does.
    ui.send(Message::Text(
        json!({"type":"open_terminal","agent":"claude-code","label":"Lead","lead":true})
            .to_string()
            .into(),
    ))
    .await
    .unwrap();
    loop {
        match next_payload(&mut ui, deadline).await {
            ServerPayload::TerminalOpened {
                agent, lead, label, ..
            } => {
                assert_eq!(agent, "claude-code");
                assert_eq!(label, "Lead");
                assert!(lead, "terminal_opened must echo lead=true");
                break;
            }
            ServerPayload::Error { code, message } => panic!("open failed: {code}: {message}"),
            _ => {}
        }
    }

    // 2. The lead CLI was launched with the conductor wiring.
    let argv_file = log.join("lead-argv");
    while !argv_file.exists() {
        assert!(Instant::now() < deadline, "the lead stub never started");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    let raw = std::fs::read(&argv_file).unwrap();
    let argv: Vec<String> = raw
        .split(|b| *b == 0)
        .filter(|s| !s.is_empty())
        .map(|s| String::from_utf8_lossy(s).into_owned())
        .collect();
    let at = |flag: &str| {
        argv.iter()
            .position(|a| a == flag)
            .unwrap_or_else(|| panic!("{flag} missing from lead argv {argv:?}"))
    };
    assert!(
        !argv.iter().any(|a| a == "--strict-mcp-config"),
        "the user's own MCP servers must keep working"
    );
    let config_path = PathBuf::from(&argv[at("--mcp-config") + 1]);
    let brief = &argv[at("--append-system-prompt") + 1];
    assert!(brief.contains("TEAM LEAD") && brief.contains("yuppy_dispatch"));
    assert!(
        brief.contains("cli=\"claude-code\""),
        "brief lists the CLIs: {brief}"
    );
    assert_eq!(
        &argv[argv.len() - 2..],
        ["--allowed-tools", "mcp__yuppy-conductor"],
        "the tool grant comes last and covers only the conductor"
    );

    // 3. Drive the conductor exactly as Claude Code would.
    let mut mcp = spawn_conductor_from(&config_path);
    let init = mcp.request("initialize", json!({"protocolVersion":"2024-11-05"}));
    assert!(
        init["result"]["capabilities"]["tools"].is_object(),
        "{init}"
    );
    let list = mcp.request("tools/list", json!({}));
    let names: Vec<&str> = list["result"]["tools"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| t["name"].as_str().unwrap())
        .collect();
    for n in ["yuppy_dispatch", "yuppy_tasks", "yuppy_cancel"] {
        assert!(names.contains(&n), "{n} missing from {names:?}");
    }

    let started = Instant::now();
    let (is_error, text) = mcp.call(
        "mcp__yuppy-conductor__yuppy_dispatch",
        json!({"tasks":[
            {"cli":"claude-code","title":"backend slice","prompt":"implement the api","role":"backend"},
            {"title":"test slice","prompt":"write the tests","role":"qa"}
        ]}),
    );
    assert!(!is_error, "dispatch failed: {text}");
    let ids: Vec<String> = text
        .split_whitespace()
        .filter(|w| w.starts_with("lead-"))
        .map(str::to_string)
        .collect();
    assert_eq!(ids.len(), 2, "two task ids expected in {text:?}");
    let idset: HashSet<String> = ids.iter().cloned().collect();

    // 4. The operator's connection — not the one that submitted — sees the
    //    batch announced and both tasks run to completion.
    let mut announced = false;
    let mut seen_running = HashSet::new();
    let mut done: HashMap<String, (TaskStateDto, Option<String>)> = HashMap::new();
    while done.len() < 2 {
        match next_payload(&mut ui, deadline).await {
            ServerPayload::TasksDispatched { tasks, lead } => {
                if tasks.iter().any(|t| idset.contains(&t.id)) {
                    assert!(lead, "a lead-dispatched batch is labelled lead=true");
                    assert_eq!(tasks.len(), 2);
                    assert!(
                        tasks.iter().all(|t| t.cli == "claude-code"),
                        "every worker is Claude Code"
                    );
                    announced = true;
                }
            }
            ServerPayload::TaskState {
                task_id,
                state,
                detail,
                cli,
                title,
            } if idset.contains(&task_id) => {
                // The UI did not submit these, yet every state names its task.
                let cli = cli.unwrap_or_else(|| panic!("{task_id} {state:?} without cli"));
                let title = title.unwrap_or_else(|| panic!("{task_id} {state:?} without title"));
                assert!(
                    cli == "claude-code"
                        && (title.starts_with("backend slice") || title.starts_with("test slice")),
                    "{task_id}: {cli} / {title}"
                );
                match state {
                    TaskStateDto::Running => {
                        seen_running.insert(task_id);
                    }
                    TaskStateDto::Completed | TaskStateDto::Failed | TaskStateDto::Cancelled => {
                        done.insert(task_id, (state, detail));
                    }
                    _ => {}
                }
            }
            _ => {}
        }
    }
    let elapsed = started.elapsed();
    assert!(
        announced,
        "the UI never saw tasks_dispatched for the lead batch"
    );
    assert_eq!(seen_running, idset, "the UI saw both tasks running");
    for (id, (state, detail)) in &done {
        assert_eq!(*state, TaskStateDto::Completed, "{id}: {detail:?}");
    }
    let peak = peak_concurrency(&log.join("trace"), &idset);
    assert_eq!(peak, 2, "the two claude slices did not overlap");
    assert!(
        elapsed < Duration::from_secs(4),
        "two ~1.2s turns took {elapsed:?}; they did not run in parallel"
    );

    // 5. The lead can read its workers' results.
    let (is_error, text) = mcp.call("yuppy_tasks", json!({"wait_secs": 10}));
    assert!(!is_error, "{text}");
    assert_eq!(text.matches("Completed").count(), 2, "{text}");
    assert_eq!(
        text.matches("work by claude").count(),
        2,
        "both workers' output must reach the lead: {text}"
    );

    // 6. Cancelling something that is not the lead's is refused.
    let (is_error, _) = mcp.call("yuppy_cancel", json!({"task_id":"not-mine"}));
    assert!(is_error);
}
