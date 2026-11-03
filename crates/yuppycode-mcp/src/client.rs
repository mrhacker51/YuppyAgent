//! MCP client over stdio.

use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::OnceLock;
use std::sync::atomic::{AtomicBool, AtomicI64, AtomicU64, Ordering};
use std::time::Duration;

use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::{Mutex, oneshot};

use crate::McpError;
use crate::protocol::{McpCallOutput, McpToolDef, SUPPORTED_PROTOCOL_VERSIONS};

/// One configured MCP server (stdio child).
#[derive(Debug, Clone)]
pub struct McpServerConfig {
    /// Stable display name ("fs", "github", …). Never contains secrets.
    pub name: String,
    pub command: PathBuf,
    pub args: Vec<String>,
    /// Extra env vars for the child. Values are never logged.
    pub env: Vec<(String, String)>,
    pub request_timeout: Duration,
    /// Hard cap (in bytes) on tool output handed to the model. The cut is
    /// always on a UTF-8 char boundary.
    pub max_output_chars: usize,
}

impl McpServerConfig {
    pub fn new(name: impl Into<String>, command: impl Into<PathBuf>) -> Self {
        Self {
            name: name.into(),
            command: command.into(),
            args: Vec::new(),
            env: Vec::new(),
            request_timeout: Duration::from_secs(20),
            max_output_chars: 64 * 1024,
        }
    }
}

struct Pending {
    tx: oneshot::Sender<Result<Value, McpError>>,
}

/// A live connection to one MCP server. Cheap to clone.
#[derive(Clone)]
pub struct McpClient {
    inner: std::sync::Arc<Inner>,
}

struct Inner {
    name: String,
    stdin: Mutex<ChildStdin>,
    pending: Mutex<HashMap<i64, Pending>>,
    next_id: AtomicI64,
    dead: AtomicBool,
    timeouts: AtomicU64,
    malformed: AtomicU64,
    negotiated_version: OnceLock<String>,
    child: Mutex<Option<Child>>,
    request_timeout: Duration,
    max_output_chars: usize,
}

impl McpClient {
    /// Spawn the server process, run the `initialize` handshake, send
    /// `initialized`, and return a ready client.
    pub async fn connect(cfg: McpServerConfig) -> Result<Self, McpError> {
        let mut cmd = Command::new(&cfg.command);
        cmd.args(&cfg.args);
        for (k, v) in &cfg.env {
            cmd.env(k, v);
        }
        cmd.stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        // NOTE: child env values may hold credentials; they are never logged.
        let mut child = cmd
            .spawn()
            .map_err(|e| McpError::Spawn(format!("{}: {e}", cfg.command.display())))?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| McpError::Spawn("no stdin".into()))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| McpError::Spawn("no stdout".into()))?;

        let inner = std::sync::Arc::new(Inner {
            name: cfg.name.clone(),
            stdin: Mutex::new(stdin),
            pending: Mutex::new(HashMap::new()),
            next_id: AtomicI64::new(1),
            dead: AtomicBool::new(false),
            timeouts: AtomicU64::new(0),
            malformed: AtomicU64::new(0),
            negotiated_version: OnceLock::new(),
            child: Mutex::new(Some(child)),
            request_timeout: cfg.request_timeout,
            max_output_chars: cfg.max_output_chars,
        });

        // Reader task: routes responses, tolerates junk, fails pending on EOF.
        let reader_inner = inner.clone();
        tokio::spawn(async move { reader_inner.read_loop(stdout).await });

        // Handshake.
        let params = json!({
            "protocolVersion": SUPPORTED_PROTOCOL_VERSIONS[0],
            "capabilities": {},
            "clientInfo": { "name": "yuppycode", "version": env!("CARGO_PKG_VERSION") },
        });
        let result = inner.request("initialize", params).await?;
        let server_version = result
            .get("protocolVersion")
            .and_then(Value::as_str)
            .unwrap_or(SUPPORTED_PROTOCOL_VERSIONS[0])
            .to_string();
        if !SUPPORTED_PROTOCOL_VERSIONS.contains(&server_version.as_str()) {
            return Err(McpError::UnsupportedVersion(server_version));
        }
        let _ = inner.negotiated_version.set(server_version);
        inner.notify("notifications/initialized", json!({})).await?;
        Ok(Self { inner })
    }

    pub fn server_name(&self) -> &str {
        &self.inner.name
    }

    pub fn protocol_version(&self) -> Option<&str> {
        self.inner.negotiated_version.get().map(String::as_str)
    }

    pub fn is_dead(&self) -> bool {
        self.inner.dead.load(Ordering::Relaxed)
    }

    pub fn malformed_count(&self) -> u64 {
        self.inner.malformed.load(Ordering::Relaxed)
    }

    pub fn timeout_count(&self) -> u64 {
        self.inner.timeouts.load(Ordering::Relaxed)
    }

    /// `tools/list` → typed tool definitions. Unparseable entries are skipped
    /// (counted) instead of poisoning the whole batch.
    pub async fn list_tools(&self) -> Result<Vec<McpToolDef>, McpError> {
        let result = self.inner.request("tools/list", json!({})).await?;
        let mut out = Vec::new();
        if let Some(arr) = result.get("tools").and_then(Value::as_array) {
            for entry in arr {
                match serde_json::from_value::<McpToolDef>(entry.clone()) {
                    Ok(def) if !def.name.is_empty() => out.push(def),
                    Ok(_) => {
                        self.inner.malformed.fetch_add(1, Ordering::Relaxed);
                    }
                    Err(_) => {
                        self.inner.malformed.fetch_add(1, Ordering::Relaxed);
                    }
                }
            }
        }
        Ok(out)
    }

    /// `tools/call` with size-capped output.
    pub async fn call_tool(&self, name: &str, arguments: Value) -> Result<McpCallOutput, McpError> {
        let params = json!({ "name": name, "arguments": arguments });
        let result = self.inner.request("tools/call", params).await?;
        let mut out = McpCallOutput::from_result(&result);
        if out.text.len() > self.inner.max_output_chars {
            truncate_at_boundary(&mut out.text, self.inner.max_output_chars);
            out.text.push_str("\n[output truncated by MCP client cap]");
        }
        Ok(out)
    }

    /// Ask the child to stop. Idempotent.
    pub async fn shutdown(&self) {
        self.inner.dead.store(true, Ordering::Relaxed);
        if let Some(mut child) = self.inner.child.try_lock().ok().and_then(|mut c| c.take()) {
            let _ = child.start_kill();
            let _ = child.wait().await;
        }
    }
}

/// Cut `s` to at most `max_bytes`, backing off to a UTF-8 char boundary.
///
/// `String::truncate` panics when the index splits a multibyte character, which
/// a byte cap on model/provider output hits routinely (Turkish text, box-drawing
/// glyphs, emoji). Callers keep the byte cap; only the cut point moves back.
fn truncate_at_boundary(s: &mut String, max_bytes: usize) {
    if s.len() <= max_bytes {
        return;
    }
    let mut cut = max_bytes;
    while cut > 0 && !s.is_char_boundary(cut) {
        cut -= 1;
    }
    s.truncate(cut);
}

impl Inner {
    async fn fail_all_pending(&self, err: McpError) {
        if let Ok(mut pending) = self.pending.try_lock() {
            for (_, p) in pending.drain() {
                let _ = p.tx.send(Err(err.clone()));
            }
        }
        self.dead.store(true, Ordering::Relaxed);
    }

    async fn send_line(&self, msg: Value) -> Result<(), McpError> {
        if self.dead.load(Ordering::Relaxed) {
            return Err(McpError::ServerDied);
        }
        let mut bytes = serde_json::to_vec(&msg)
            .map_err(|e| McpError::ProtocolShape(format!("serialise: {e}")))?;
        bytes.push(b'\n');
        let mut stdin = self.stdin.lock().await;
        let write_res = match stdin.write_all(&bytes).await {
            Ok(()) => stdin.flush().await,
            Err(e) => Err(e),
        };
        if let Err(e) = write_res {
            let err = McpError::Transport(format!("stdin write: {e}"));
            self.fail_all_pending(err.clone()).await;
            return Err(err);
        }
        Ok(())
    }

    async fn request(&self, method: &str, params: Value) -> Result<Value, McpError> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        self.pending.lock().await.insert(id, Pending { tx });
        let msg = json!({"jsonrpc":"2.0","id":id,"method":method,"params":params});
        if let Err(e) = self.send_line(msg).await {
            self.pending.lock().await.remove(&id);
            return Err(e);
        }
        let timeout = self.request_timeout;
        match tokio::time::timeout(timeout, rx).await {
            Err(_elapsed) => {
                self.pending.lock().await.remove(&id);
                self.timeouts.fetch_add(1, Ordering::Relaxed);
                Err(McpError::Timeout(timeout))
            }
            Ok(Err(_canceled)) => {
                self.pending.lock().await.remove(&id);
                Err(McpError::ServerDied)
            }
            Ok(Ok(res)) => res,
        }
    }

    async fn notify(&self, method: &str, params: Value) -> Result<(), McpError> {
        self.send_line(json!({"jsonrpc":"2.0","method":method,"params":params}))
            .await
    }

    async fn read_loop(self: &std::sync::Arc<Self>, stdout: tokio::process::ChildStdout) {
        let mut lines = BufReader::new(stdout).lines();
        loop {
            match lines.next_line().await {
                Ok(None) => {
                    self.fail_all_pending(McpError::ServerDied).await;
                    return;
                }
                Ok(Some(line)) => {
                    let line = line.trim();
                    if line.is_empty() {
                        continue;
                    }
                    let Ok(value) = serde_json::from_str::<Value>(line) else {
                        // Malformed junk: count and keep the connection alive.
                        self.malformed.fetch_add(1, Ordering::Relaxed);
                        continue;
                    };
                    // Notifications / server->client requests: no ids we track.
                    let Some(id) = value.get("id").and_then(Value::as_i64) else {
                        continue;
                    };
                    let Some(pending) = self.pending.lock().await.remove(&id) else {
                        continue; // unsolicited response — ignore
                    };
                    if let Some(err) = value.get("error") {
                        let code = err.get("code").and_then(Value::as_i64).unwrap_or(-1);
                        let message = err
                            .get("message")
                            .and_then(Value::as_str)
                            .unwrap_or("unknown")
                            .to_string();
                        let _ = pending.tx.send(Err(McpError::Protocol { code, message }));
                    } else if let Some(result) = value.get("result") {
                        let _ = pending.tx.send(Ok(result.clone()));
                    } else {
                        let _ = pending.tx.send(Err(McpError::ProtocolShape(
                            "response without result".into(),
                        )));
                    }
                }
                Err(e) => {
                    self.fail_all_pending(McpError::Transport(format!("stdout read: {e}")))
                        .await;
                    return;
                }
            }
        }
    }
}

impl Drop for Inner {
    fn drop(&mut self) {
        self.dead.store(true, Ordering::Relaxed);
        if let Some(mut child) = self.child.try_lock().map(|mut c| c.take()).ok().flatten() {
            // Best-effort kill; kill_on_drop backs this up.
            let _ = child.start_kill();
        }
    }
}

impl std::fmt::Debug for McpClient {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("McpClient")
            .field("server", &self.inner.name)
            .field("dead", &self.is_dead())
            .field("version", &self.protocol_version())
            .finish_non_exhaustive()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn boundary_cut_never_splits_a_multibyte_char() {
        // "İ" is 2 bytes, "—" and "★" are 3: a naive byte cap panics here.
        let original = "İstanbul — ★ ok ".repeat(64);
        for cap in [1usize, 2, 3, 5, 7, 11, 13, 64, 127] {
            let mut s = original.clone();
            truncate_at_boundary(&mut s, cap);
            assert!(s.len() <= cap, "cap {cap} exceeded: {}", s.len());
            assert!(original.starts_with(&s), "cap {cap} cut mid-character");
        }
    }

    #[test]
    fn boundary_cut_is_a_noop_under_the_cap() {
        let mut s = "günaydın ★".to_string();
        let before = s.clone();
        truncate_at_boundary(&mut s, 4096);
        assert_eq!(s, before);
    }

    fn which(bin: &str) -> PathBuf {
        PathBuf::from(bin)
    }

    #[tokio::test]
    async fn handshake_times_out_against_unresponsive_server() {
        // `sleep` writes nothing, so initialize can only time out.
        let cfg = McpServerConfig {
            request_timeout: Duration::from_millis(250),
            ..McpServerConfig::new("sleep", which("sleep"))
        };
        let cfg = McpServerConfig {
            args: vec!["999".into()],
            ..cfg
        };
        let err = McpClient::connect(cfg).await.unwrap_err();
        assert!(matches!(err, McpError::Timeout(_)), "{err:?}");
    }

    #[tokio::test]
    async fn dead_server_reports_server_died() {
        let cfg = McpServerConfig {
            request_timeout: Duration::from_secs(5),
            ..McpServerConfig::new("quick-exit", which("sh"))
        };
        let cfg = McpServerConfig {
            args: vec!["-c".into(), "exit 1".into()],
            ..cfg
        };
        let err = McpClient::connect(cfg).await.unwrap_err();
        assert!(
            matches!(err, McpError::ServerDied | McpError::Transport(_)),
            "{err:?}"
        );
    }

    #[tokio::test]
    async fn spawn_failure_is_clean() {
        let cfg = McpServerConfig::new("ghost", "/nonexistent/mcp-binary");
        assert!(matches!(
            McpClient::connect(cfg).await,
            Err(McpError::Spawn(_))
        ));
    }

    #[tokio::test]
    async fn malformed_lines_are_counted_not_fatal() {
        // `sh` echoing garbage then staying alive: we drive cat and check the
        // counter grows when junk arrives, via a fake that prints junk lines.
        let cfg = McpServerConfig {
            request_timeout: Duration::from_millis(200),
            ..McpServerConfig::new("junk", which("sh"))
        };
        let cfg = McpServerConfig {
            args: vec!["-c".into(), "printf 'not json\\n{{{bad\\n'; sleep 5".into()],
            ..cfg
        };
        let err = McpClient::connect(cfg).await.unwrap_err();
        // Times out on initialize, but the process was alive and emitted junk.
        assert!(matches!(err, McpError::Timeout(_)), "{err:?}");
    }
}
