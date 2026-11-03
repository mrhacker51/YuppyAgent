//! Regression test for the path the desktop UI actually uses: one
//! `ClientRequest::TaskSubmit` with a batch of tasks must run those tasks at
//! the same time.
//!
//! The orchestrator's own tests already prove `run_batch` is concurrent, but
//! the bridge adds plumbing around it (agent detection, team-bus setup,
//! department limits, a spawned supervisor). This test drives the real bridge
//! binary over its WebSocket protocol with a fake `claude` executable
//! first on `PATH`, so no real model or account is touched. Each stub records
//! start/end timestamps; overlapping spans are the assertion.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use futures_util::{SinkExt, StreamExt};
use serde_json::json;
use tempfile::TempDir;
use tokio_tungstenite::tungstenite::Message;
use yuppycode_protocol::{Envelope, PROTOCOL_VERSION, ServerPayload, TaskStateDto};

const TOKEN: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const STUB_SLEEP: &str = "1.2";

/// A bridge child that is always killed, even when an assertion panics.
struct Bridge {
    child: Child,
    url: String,
}

impl Drop for Bridge {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn stub_clis(dir: &Path) -> PathBuf {
    let bin = dir.join("bin");
    std::fs::create_dir_all(&bin).unwrap();
    let script = r#"#!/bin/sh
NAME=$(basename "$0")
if [ "$1" = "--version" ]; then
  printf 'stub %s 9.9.9\n' "$NAME"
  exit 0
fi
D="${YUPPY_STUB_DIR:?}"
ID="${YUPPY_TASK_ID:-$NAME-$$}"
printf 'start %s %s %s\n' "$NAME" "$ID" "$(date +%s%N)" >> "$D/trace"
sleep "${YUPPY_STUB_SLEEP:-1.2}"
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

fn spawn_bridge(workspace: &Path, config: &Path, stubs: &Path, log: &Path) -> Bridge {
    let port = free_port();
    let path = format!(
        "{}:{}",
        stubs.display(),
        std::env::var("PATH").unwrap_or_default()
    );
    let child = Command::new(env!("CARGO_BIN_EXE_yuppy"))
        .args(["bridge", "--host", "127.0.0.1", "--port", &port.to_string()])
        .current_dir(workspace)
        .env("PATH", path)
        .env("YUPPY_CONFIG_DIR", config)
        .env("YUPPY_BRIDGE_TOKEN", TOKEN)
        .env("YUPPY_STUB_DIR", log)
        .env("YUPPY_STUB_SLEEP", STUB_SLEEP)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("spawn yuppy bridge");
    Bridge {
        child,
        url: format!("ws://127.0.0.1:{port}"),
    }
}

type Ws =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

async fn connect(bridge: &mut Bridge) -> Ws {
    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        match tokio_tungstenite::connect_async(&bridge.url).await {
            Ok((mut ws, _)) => {
                ws.send(Message::Text(
                    json!({ "version": PROTOCOL_VERSION, "token": TOKEN })
                        .to_string()
                        .into(),
                ))
                .await
                .expect("send handshake");
                // The server replies `connected`, then sends the initial
                // inventory/departments/layout burst. Consume both so later
                // reads are our task events.
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
                if let Some(status) = bridge.child.try_wait().expect("try_wait") {
                    panic!("bridge exited before listening ({status}): {e}");
                }
                if Instant::now() >= deadline {
                    panic!("bridge never listened on {}: {e}", bridge.url);
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        }
    }
}

async fn submit(ws: &mut Ws, tasks: serde_json::Value) {
    ws.send(Message::Text(
        json!({ "type": "task_submit", "tasks": tasks })
            .to_string()
            .into(),
    ))
    .await
    .expect("send task_submit");
}

/// Wait until every id reaches a terminal state, returning its final state and
/// error detail so a failure is diagnosable instead of just a timeout.
async fn wait_terminal(
    ws: &mut Ws,
    ids: &HashSet<String>,
    deadline: Instant,
) -> HashMap<String, (TaskStateDto, Option<String>)> {
    let mut done = HashMap::new();
    while done.len() < ids.len() {
        let remaining = deadline.saturating_duration_since(Instant::now());
        assert!(
            !remaining.is_zero(),
            "tasks never finished; still waiting for {:?}",
            ids.iter()
                .filter(|id| !done.contains_key(*id))
                .collect::<Vec<_>>()
        );
        let msg = tokio::time::timeout(remaining, ws.next())
            .await
            .unwrap_or_else(|_| panic!("timed out waiting for tasks"))
            .expect("stream ended before tasks finished")
            .expect("ws error");
        let Message::Text(text) = msg else {
            continue;
        };
        let Ok(env) = serde_json::from_str::<Envelope>(&text) else {
            continue;
        };
        if let ServerPayload::TaskState {
            task_id,
            state,
            detail,
            ..
        } = env.payload
            && ids.contains(&task_id)
            && matches!(
                state,
                TaskStateDto::Completed | TaskStateDto::Failed | TaskStateDto::Cancelled
            )
        {
            done.insert(task_id, (state, detail));
        }
    }
    done
}

/// Highest number of stub turns that were alive at the same instant.
fn peak_concurrency(trace: &Path, ids: &HashSet<String>) -> usize {
    let text = std::fs::read_to_string(trace).unwrap_or_default();
    let mut starts = HashMap::new();
    let mut ends = HashMap::new();
    for line in text.lines() {
        let mut parts = line.split_whitespace();
        let Some(kind) = parts.next() else { continue };
        let _name = parts.next();
        let Some(id) = parts.next() else { continue };
        if !ids.contains(id) {
            continue;
        }
        let Some(ts) = parts.next().and_then(|n| n.parse::<u128>().ok()) else {
            continue;
        };
        match kind {
            "start" => {
                starts.insert(id.to_string(), ts);
            }
            "end" => {
                ends.insert(id.to_string(), ts);
            }
            _ => {}
        }
    }

    let mut events = Vec::new();
    for id in ids {
        let (Some(&start), Some(&end)) = (starts.get(id), ends.get(id)) else {
            panic!("stub for {id:?} never recorded both timestamps; trace:\n{text}");
        };
        assert!(end > start, "stub for {id:?} recorded a non-positive span");
        events.push((start, 1i32));
        events.push((end, -1i32));
    }
    // Ends sort before starts at the same timestamp: touching spans are
    // sequential, not overlapping.
    events.sort_by_key(|e| (e.0, e.1));
    let mut live = 0usize;
    let mut peak = 0usize;
    for (_, delta) in events {
        if delta < 0 {
            live = live.saturating_sub(1);
        } else {
            live += 1;
            peak = peak.max(live);
        }
    }
    peak
}

fn setup() -> (TempDir, Bridge) {
    let root = tempfile::tempdir().unwrap();
    let workspace = root.path().join("workspace");
    let config = root.path().join("config");
    let log = root.path().join("log");
    std::fs::create_dir_all(&workspace).unwrap();
    std::fs::create_dir_all(&config).unwrap();
    std::fs::create_dir_all(&log).unwrap();
    let stubs = stub_clis(&log);
    let bridge = spawn_bridge(&workspace, &config, &stubs, &log);
    (root, bridge)
}

fn task(id: &str, cli: &str, department: Option<&str>) -> serde_json::Value {
    json!({
        "id": id,
        "title": format!("task {id}"),
        "prompt": format!("do work for {id}"),
        "cli": cli,
        "department": department,
        "isolation": "shared",
    })
}

/// Four tasks submitted in one request must overlap. Tasks with no department
/// are bounded only by the batch's global limit, so the bridge must not
/// serialize them on the way to the orchestrator.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn one_task_submit_runs_all_four_agents_at_once() {
    let (root, mut bridge) = setup();
    let log = root.path().join("log");
    let mut ws = connect(&mut bridge).await;

    let ids: HashSet<String> = ["t1", "t2", "t3", "t4"]
        .iter()
        .map(|s| s.to_string())
        .collect();
    let tasks = vec![
        task("t1", "claude-code", None),
        task("t2", "claude-code", None),
        task("t3", "claude-code", None),
        task("t4", "claude-code", None),
    ];
    let started = Instant::now();
    submit(&mut ws, json!(tasks)).await;

    let outcomes = wait_terminal(&mut ws, &ids, Instant::now() + Duration::from_secs(30)).await;
    let elapsed = started.elapsed();
    for (id, (state, detail)) in &outcomes {
        assert_eq!(
            *state,
            TaskStateDto::Completed,
            "task {id} ended as {state:?}: {detail:?}"
        );
    }

    let peak = peak_concurrency(&log.join("trace"), &ids);
    assert_eq!(
        peak, 4,
        "only {peak} of 4 agents overlapped; a batch submitted through the bridge serialized"
    );
    assert!(
        elapsed < Duration::from_secs(3),
        "four ~{STUB_SLEEP}s turns took {elapsed:?}; they did not overlap"
    );
}

/// An explicitly configured department limit is a user decision and still
/// applies. This pins the other side of the rule above: only *unconfigured*
/// department bounds are widened to the batch.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_explicit_department_limit_still_serializes_that_department() {
    let (root, mut bridge) = setup();
    let log = root.path().join("log");
    let mut ws = connect(&mut bridge).await;

    ws.send(Message::Text(
        json!({
            "type": "department_upsert",
            "department": {
                "id": "bottleneck",
                "name": "Bottleneck",
                "description": "explicitly one at a time",
                "icon": "1",
                "agents": [],
                "roles": [],
                "workspace": null,
                "allowed_tools": [],
                "max_concurrency": 1,
                "enabled": true,
                "panels": [],
            }
        })
        .to_string()
        .into(),
    ))
    .await
    .expect("send department_upsert");
    loop {
        let msg = ws.next().await.expect("stream ended").expect("ws error");
        if let Message::Text(text) = msg
            && let Ok(env) = serde_json::from_str::<Envelope>(&text)
            && let ServerPayload::DepartmentUpserted { id, ok, error } = env.payload
        {
            assert_eq!(id, "bottleneck");
            assert!(ok, "department upsert failed: {error:?}");
            break;
        }
    }

    let ids: HashSet<String> = ["e1", "e2"].iter().map(|s| s.to_string()).collect();
    let started = Instant::now();
    submit(
        &mut ws,
        json!([
            task("e1", "claude-code", Some("bottleneck")),
            task("e2", "claude-code", Some("bottleneck")),
        ]),
    )
    .await;
    let outcomes = wait_terminal(&mut ws, &ids, Instant::now() + Duration::from_secs(30)).await;
    let elapsed = started.elapsed();
    for (id, (state, detail)) in &outcomes {
        assert_eq!(
            *state,
            TaskStateDto::Completed,
            "task {id} ended as {state:?}: {detail:?}"
        );
    }

    let peak = peak_concurrency(&log.join("trace"), &ids);
    assert_eq!(peak, 1, "an explicit max_concurrency=1 was ignored");
    assert!(
        elapsed >= Duration::from_millis(2_000),
        "two ~{STUB_SLEEP}s turns finished in {elapsed:?}; the explicit limit was bypassed"
    );
}
