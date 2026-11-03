//! Cooperative cancellation and the task runner contract.

use std::collections::HashMap;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

/// Cooperative cancellation handle shared by scheduler and runners.
#[derive(Debug, Clone, Default)]
pub struct CancelFlag(Arc<AtomicBool>);

impl CancelFlag {
    pub fn new() -> Self {
        Self::default()
    }
    pub fn cancel(&self) {
        self.0.store(true, Ordering::SeqCst);
    }
    pub fn is_cancelled(&self) -> bool {
        self.0.load(Ordering::SeqCst)
    }
}

#[derive(Debug, thiserror::Error)]
pub enum RunnerError {
    #[error("failed to start task process: {0}")]
    Spawn(String),
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("task timed out after {0:?}")]
    TimedOut(Duration),
    #[error("could not prepare the team MCP config for task {task_id}: {why}")]
    TeamConfig { task_id: String, why: String },
}

/// Live progress sink: `(task_id, line)`. Called from the runner's reader
/// tasks while the child runs, once per short human-readable line (see
/// [`yuppycode_agents::stream`]). Must be cheap and non-blocking — forward
/// to a channel, never do I/O inline.
pub type OutputEvents = Arc<dyn Fn(&str, &str) + Send + Sync>;

/// What a runner is asked to do. `workdir` is already isolated (shared
/// workspace or a private git worktree).
pub struct RunRequest<'a> {
    pub task_id: &'a str,
    /// CLI adapter id: "claude-code" (runner builds argv).
    pub cli: &'a str,
    pub model: Option<&'a str>,
    pub prompt: &'a str,
    pub workdir: &'a Path,
    pub cancel: CancelFlag,
    pub timeout: Duration,
    /// Team membership for this turn. `Some` connects the CLI to the shared
    /// bus and injects the team brief; `None` runs the agent alone.
    pub team: Option<&'a yuppycode_agents::TeamLink>,
    /// Claude Code `--permission-mode` for this headless turn
    /// ("default" | "acceptEdits" | "bypassPermissions"). `None` or
    /// "default" passes no flag: the CLI's native permission behaviour.
    pub permission_mode: Option<&'a str>,
    /// Where live progress lines go. `None` = nobody is watching; the run
    /// and its final report are unchanged.
    pub output: Option<OutputEvents>,
}

/// Authoritative process outcome for one task attempt.
#[derive(Debug, Clone)]
pub struct RunReport {
    pub success: bool,
    pub exit_code: Option<i32>,
    pub duration_ms: u64,
    /// The agent's final answer (the stream-json `result` text) when the CLI
    /// produced one; otherwise the trailing progress/stdout lines. Stderr is
    /// appended when there was no successful result. Bounded (~4000 chars).
    pub output_tail: String,
}

/// Abstraction over "run one agent turn non-interactively".
///
/// Object-safe: returns a boxed future so the scheduler can hold a
/// `&dyn TaskRunner`. Implementations MUST honour `cancel` promptly
/// (kill the child) and MUST NOT report success without a zero exit —
/// the scheduler only marks a task Completed from `success == true`.
pub trait TaskRunner: Send + Sync {
    fn run<'a>(
        &'a self,
        req: RunRequest<'a>,
    ) -> Pin<Box<dyn Future<Output = Result<RunReport, RunnerError>> + Send + 'a>>;
}

/// Runs Claude Code headless (`claude -p … --output-format stream-json
/// --verbose [--permission-mode <mode>]`) as child processes — no PTY, no
/// TUI — and streams parsed progress lines to [`RunRequest::output`].
///
/// The only permission flag ever added is the department's explicit
/// `permission_mode`; a CLI that refuses to act exits non-zero (or reports
/// `is_error`) and the task FAILS — never retried with fewer safeguards.
pub struct ProcessTaskRunner {
    /// Executable per adapter id.
    pub programs: HashMap<String, PathBuf>,
}

impl ProcessTaskRunner {
    pub fn new(programs: HashMap<String, PathBuf>) -> Self {
        Self { programs }
    }

    fn kind(cli: &str) -> Option<yuppycode_agents::AgentKind> {
        match cli {
            "claude-code" => Some(yuppycode_agents::AgentKind::ClaudeCode),
            _ => None,
        }
    }

    fn argv(
        &self,
        cli: &str,
        model: Option<&str>,
        prompt: &str,
        permission_mode: Option<&str>,
    ) -> Vec<String> {
        let mut args = match Self::kind(cli) {
            Some(k) => k.headless_args(prompt, permission_mode),
            None => vec![prompt.to_string()],
        };
        if let Some(m) = model {
            args.extend(["--model".to_string(), m.to_string()]);
        }
        args
    }
}

/// Owned throwaway directory holding one run's MCP config.
///
/// Two reasons it is not a bare file in the shared temp dir: a fixed
/// predictable path (`/tmp/yuppy-mcp-<task>.json`) lets any other local user
/// pre-create or symlink the config a privileged run is about to read, and
/// concurrent processes running the same task id would clobber each other.
/// The directory carries the spawning process's pid, and the `Drop` impl
/// removes the whole directory however the run ends — completion, spawn
/// failure, timeout or cancellation — so nothing leaks on any early return.
struct McpConfigDir {
    dir: PathBuf,
    path: PathBuf,
}

impl McpConfigDir {
    fn write(task_id: &str, link: &yuppycode_agents::TeamLink) -> Result<Self, RunnerError> {
        let json = yuppycode_agents::AgentKind::mcp_server_json(link);
        let dir = std::env::temp_dir().join(format!("yuppy-mcp-{task_id}-{}", std::process::id()));
        let write_err = |e: std::io::Error| RunnerError::TeamConfig {
            task_id: task_id.to_string(),
            why: e.to_string(),
        };
        std::fs::create_dir_all(&dir).map_err(write_err)?;
        let path = dir.join("config.json");
        std::fs::write(&path, json).map_err(write_err)?;
        Ok(Self { dir, path })
    }
}

impl Drop for McpConfigDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

/// Bytes kept per tail buffer. The report only ever shows a short tail, so
/// buffering a chatty CLI's entire output would let one runaway agent grow
/// the orchestrator's memory without bound.
const TAIL_BYTES: usize = 8 * 1024;

/// Longest single stdout/stderr line held in memory. stream-json records
/// are one line each and can be large (the init record lists every tool),
/// but a line beyond this is dropped rather than buffered without bound.
const MAX_LINE_BYTES: usize = 4 * 1024 * 1024;

/// Bounded text tail made of whole lines.
#[derive(Default)]
struct LineTail(String);

impl LineTail {
    fn push(&mut self, line: &str) {
        if !self.0.is_empty() {
            self.0.push('\n');
        }
        self.0.push_str(line);
        if self.0.len() > TAIL_BYTES {
            let mut cut = self.0.len() - TAIL_BYTES;
            while !self.0.is_char_boundary(cut) {
                cut += 1;
            }
            self.0.drain(..cut);
        }
    }
}

/// Drain a child stream line by line, calling `f` for each complete line.
/// Lines longer than [`MAX_LINE_BYTES`] are skipped whole.
async fn for_each_line<R, F>(mut reader: R, mut f: F)
where
    R: tokio::io::AsyncRead + Unpin,
    F: FnMut(&str),
{
    use tokio::io::AsyncReadExt;
    let mut pending: Vec<u8> = Vec::new();
    let mut skipping = false;
    let mut chunk = vec![0u8; 16 * 1024];
    loop {
        let n = match reader.read(&mut chunk).await {
            Ok(0) => break,
            Ok(n) => n,
            // A broken pipe is just an early EOF; the exit status is the
            // authoritative outcome either way.
            Err(_) => break,
        };
        let mut rest = &chunk[..n];
        while let Some(i) = rest.iter().position(|b| *b == b'\n') {
            if !skipping {
                pending.extend_from_slice(&rest[..i]);
                f(&String::from_utf8_lossy(&pending));
            }
            pending.clear();
            skipping = false;
            rest = &rest[i + 1..];
        }
        if !skipping {
            pending.extend_from_slice(rest);
            if pending.len() > MAX_LINE_BYTES {
                pending.clear();
                skipping = true;
            }
        }
    }
    if !skipping && !pending.is_empty() {
        f(&String::from_utf8_lossy(&pending));
    }
}

/// Keep only the last `max` characters of `s`.
fn last_chars(s: &str, max: usize) -> String {
    let n = s.chars().count();
    if n <= max {
        return s.to_string();
    }
    s.chars().skip(n - max).collect()
}

impl ProcessTaskRunner {
    /// Compose the argv and environment for one turn.
    ///
    /// Kept separate from spawning so the team wiring is testable without a
    /// real CLI: this is exactly what the child process will receive.
    pub fn build_command(
        &self,
        req: &RunRequest<'_>,
        mcp_config: Option<&Path>,
    ) -> (Vec<String>, Vec<(String, String)>) {
        let kind = Self::kind(req.cli);
        let mut args = self.argv(req.cli, req.model, req.prompt, req.permission_mode);
        let mut env = Vec::new();
        if let (Some(link), Some(k)) = (req.team, kind) {
            args.extend(k.team_args(link, mcp_config));
            args.extend(k.brief_args(&link.brief()));
            // Without this the tools are present but uncallable in a run that
            // has nobody to answer a permission prompt.
            if link.auto_allow_bus {
                args.extend(k.bus_allow_args());
            }
            env = k.team_env(link);
        }
        (args, env)
    }
}

/// Spawn a CLI, retrying briefly on `ETXTBSY`.
///
/// A CLI binary that was just installed, updated or written by a parallel
/// process can be open for writing for a few milliseconds; `exec` then fails
/// with "Text file busy" even though the file is a perfectly good executable.
/// That is transient, so a bounded retry is honest: any other error (missing
/// file, permissions) is returned immediately.
///
/// `tokio::process::Command` keeps its configured argv/env across spawn
/// attempts, so retrying the same command object is safe.
async fn spawn_executable(
    cmd: &mut tokio::process::Command,
    program: &Path,
) -> Result<tokio::process::Child, RunnerError> {
    /// Linux `ETXTBSY`.
    const TEXT_FILE_BUSY: i32 = 26;
    const RETRIES: usize = 25;
    let mut attempt = 0;
    loop {
        match cmd.spawn() {
            Ok(child) => return Ok(child),
            Err(e)
                if e.raw_os_error() == Some(TEXT_FILE_BUSY)
                    && attempt < RETRIES =>
            {
                attempt += 1;
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
            Err(e) => return Err(RunnerError::Spawn(format!("{program:?}: {e}"))),
        }
    }
}

impl TaskRunner for ProcessTaskRunner {
    fn run<'a>(
        &'a self,
        req: RunRequest<'a>,
    ) -> Pin<Box<dyn Future<Output = Result<RunReport, RunnerError>> + Send + 'a>> {
        Box::pin(async move {
            let program = self.programs.get(req.cli).ok_or_else(|| {
                RunnerError::Spawn(format!("no program configured for cli {:?}", req.cli))
            })?;
            // Team wiring: the name this agent speaks as, where the bus lives,
            // and how its own CLI reaches the shared team MCP server. The
            // guard removes its directory on every exit path, including the
            // spawn-failure `?` below.
            let mcp_config = match (req.team, Self::kind(req.cli)) {
                (Some(link), Some(yuppycode_agents::AgentKind::ClaudeCode)) => {
                    Some(McpConfigDir::write(req.task_id, link)?)
                }
                _ => None,
            };
            let (args, env) =
                self.build_command(&req, mcp_config.as_ref().map(|c| c.path.as_path()));
            let start = std::time::Instant::now();
            let mut cmd = tokio::process::Command::new(program);
            cmd.args(&args)
                .current_dir(req.workdir)
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped())
                // Dropping this future (cancel or timeout) kills the
                // child: no orphans, no post-cancel output.
                .kill_on_drop(true);
            for (k, v) in &env {
                cmd.env(k, v);
            }
            let mut child = spawn_executable(&mut cmd, program).await?;

            // Stream both pipes line by line while the child runs: stdout is
            // stream-json (parsed into progress lines and the final result),
            // stderr is shown as-is. Only bounded tails are kept, so a chatty
            // (or runaway) CLI cannot grow this process without bound.
            let stdout = child.stdout.take();
            let stderr = child.stderr.take();
            let task_id = req.task_id.to_string();
            let workdir = req.workdir.to_path_buf();
            let out_sink = req.output.clone();
            let err_sink = req.output.clone();
            let out_id = task_id.clone();
            let err_id = task_id.clone();

            // Cancellation wait: resolves once the flag is raised.
            let cancel = req.cancel.clone();
            let cancelled = async move {
                while !cancel.is_cancelled() {
                    tokio::time::sleep(Duration::from_millis(100)).await;
                }
            };

            let outcome = tokio::select! {
                biased; // prefer real completion over cancel races
                r = tokio::time::timeout(req.timeout, async {
                    let (out, err, status) = tokio::join!(
                        async move {
                            let mut parser =
                                yuppycode_agents::stream::StreamParser::new(Some(&workdir));
                            let mut tail = LineTail::default();
                            let mut result = None;
                            if let Some(s) = stdout {
                                for_each_line(s, |line| {
                                    for ev in parser.feed(line) {
                                        match ev {
                                            yuppycode_agents::stream::StreamEvent::Progress(p) => {
                                                if let Some(sink) = &out_sink {
                                                    sink(&out_id, &p);
                                                }
                                                tail.push(&p);
                                            }
                                            yuppycode_agents::stream::StreamEvent::Result(r) => {
                                                if let Some(sink) = &out_sink {
                                                    sink(&out_id, &r.line());
                                                }
                                                result = Some(r);
                                            }
                                        }
                                    }
                                })
                                .await;
                            }
                            (tail.0, result)
                        },
                        async move {
                            let mut tail = LineTail::default();
                            if let Some(s) = stderr {
                                for_each_line(s, |line| {
                                    let line = line.trim_end();
                                    if line.trim().is_empty() {
                                        return;
                                    }
                                    if let Some(sink) = &err_sink {
                                        sink(&err_id, &format!("! {line}"));
                                    }
                                    tail.push(line);
                                })
                                .await;
                            }
                            tail.0
                        },
                        child.wait(),
                    );
                    let status = status.map_err(RunnerError::Io)?;
                    let (progress_tail, result) = out;
                    // A turn the CLI itself reports as an error is a failure
                    // even if the process exited 0.
                    let reported_error = result.as_ref().is_some_and(|r| r.is_error);
                    let success = status.success() && !reported_error;
                    let mut tail = match &result {
                        Some(r) if !r.text.trim().is_empty() => r.text.clone(),
                        _ => progress_tail,
                    };
                    let clean = success && result.is_some();
                    if !clean && !err.is_empty() {
                        if !tail.is_empty() {
                            tail.push('\n');
                        }
                        tail.push_str(&err);
                    }
                    Ok::<_, RunnerError>(RunReport {
                        success,
                        exit_code: status.code(),
                        duration_ms: start.elapsed().as_millis() as u64,
                        output_tail: last_chars(&tail, 4000),
                    })
                }) => {
                    match r {
                        Err(_elapsed) => Err(RunnerError::TimedOut(req.timeout)),
                        Ok(r) => r,
                    }
                }
                _ = cancelled => Ok(RunReport {
                    success: false,
                    exit_code: None,
                    duration_ms: start.elapsed().as_millis() as u64,
                    output_tail: "<cancelled>".into(),
                }),
            };
            // The temp MCP config only ever had to outlive this child; the
            // guard's Drop removes its directory on every path, including
            // when this whole future is dropped mid-run.
            drop(mcp_config);
            outcome
        })
    }
}
