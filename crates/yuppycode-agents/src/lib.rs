//! Adapters for the coding-agent CLI YuppyCode runs: Claude Code.
//!
//! Scope (spec §3): *detect*, *report versions*, *explain installation*,
//! *launch genuine interactive PTY sessions* through [`yuppycode_terminal`],
//! and describe the documented headless (`claude -p … --output-format
//! stream-json`) argv plus a parser for its output ([`stream`]). This crate
//! deliberately does NOT:
//! - install or update software,
//! - touch credentials or authentication state,
//! - silently bypass native permission/approval prompts (the permission
//!   mode is always the operator's explicit department setting).
//!
//! Every agent in YuppyCode is a Claude Code process. [`AgentKind`] stays an
//! enum so the adapter surface is explicit and a future CLI is an additive
//! change, but today it has exactly one variant. Interactive sessions inherit
//! the parent process environment, which is what makes Claude Code's own
//! authentication (config files, env keys) work exactly as on a normal shell
//! — no credential plumbing happens here.

pub mod stream;

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use yuppycode_terminal::{SessionConfig, TerminalError, TerminalSession, TerminalSize};

/// Which supported coding-agent CLI a session or probe refers to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AgentKind {
    ClaudeCode,
}

/// Permission modes a department may run its headless workers under. The
/// names are Claude Code's own `--permission-mode` values; `default` means
/// "pass no flag" so the CLI's native prompting applies unchanged.
pub const PERMISSION_MODES: [&str; 3] = ["default", "acceptEdits", "bypassPermissions"];

/// The permission mode a department gets when it does not set one.
pub const DEFAULT_PERMISSION_MODE: &str = "acceptEdits";

/// True when `mode` is one of [`PERMISSION_MODES`].
pub fn is_permission_mode(mode: &str) -> bool {
    PERMISSION_MODES.contains(&mode)
}

impl AgentKind {
    pub const ALL: [AgentKind; 1] = [AgentKind::ClaudeCode];

    /// Resolve an adapter id (or a common alias) to a kind. Legacy ids of
    /// removed CLIs resolve to `None`; config loaders migrate them first.
    pub fn from_id(id: &str) -> Option<AgentKind> {
        match id.trim().to_ascii_lowercase().as_str() {
            "claude-code" | "claude" | "claudecode" => Some(AgentKind::ClaudeCode),
            _ => None,
        }
    }

    pub fn id(self) -> &'static str {
        match self {
            AgentKind::ClaudeCode => "claude-code",
        }
    }

    pub fn display_name(self) -> &'static str {
        match self {
            AgentKind::ClaudeCode => "Claude Code",
        }
    }

    /// The executable name looked up on `PATH`.
    pub fn program_name(self) -> &'static str {
        match self {
            AgentKind::ClaudeCode => "claude",
        }
    }

    /// What to tell the user when the CLI is missing. Never executed.
    pub fn install_hint(self) -> &'static str {
        match self {
            AgentKind::ClaudeCode => {
                "Claude Code not found. Install it from https://docs.anthropic.com/en/docs/claude-code (e.g. `npm install -g @anthropic-ai/claude-code`) and ensure `claude` is on PATH."
            }
        }
    }

    /// Args that make the CLI print its version and exit.
    pub fn version_args(self) -> &'static [&'static str] {
        match self {
            AgentKind::ClaudeCode => &["--version"],
        }
    }

    /// Args for a genuine interactive REPL: no positional prompt; user extra
    /// args are appended after these and pass through to the native CLI.
    pub fn interactive_args(self) -> &'static [&'static str] {
        match self {
            AgentKind::ClaudeCode => &[],
        }
    }

    /// Documented plain-text one-shot argv (`claude -p <prompt>`).
    pub fn noninteractive_args(self, prompt: &str) -> Vec<String> {
        match self {
            AgentKind::ClaudeCode => vec!["-p".into(), prompt.into()],
        }
    }

    /// Headless worker argv: `claude -p <prompt> --output-format stream-json
    /// --verbose [--permission-mode <mode>]`.
    ///
    /// Workers run without a PTY (no TUI, no per-agent terminal), which is
    /// what keeps a ten-agent team from lagging the machine; `stream-json`
    /// is what still gives the operator live progress (see [`stream`]).
    /// `--verbose` is required by Claude Code for `stream-json` in print
    /// mode. `permission_mode` `None`/`"default"` passes no flag, so the
    /// CLI's native permission behaviour applies; any other value must be
    /// one of [`PERMISSION_MODES`] and is passed through verbatim — an
    /// unknown value is dropped rather than handed to the CLI.
    pub fn headless_args(self, prompt: &str, permission_mode: Option<&str>) -> Vec<String> {
        match self {
            AgentKind::ClaudeCode => {
                let mut args: Vec<String> = vec![
                    "-p".into(),
                    prompt.into(),
                    "--output-format".into(),
                    "stream-json".into(),
                    "--verbose".into(),
                ];
                if let Some(mode) = permission_mode
                    && mode != "default"
                    && is_permission_mode(mode)
                {
                    args.extend(["--permission-mode".into(), mode.into()]);
                }
                args
            }
        }
    }

    /// Args that connect this CLI to the team bus over MCP. `mcp_config` is
    /// the JSON file path written from [`AgentKind::mcp_server_json`].
    /// Native permission handling is untouched: these args only add tools.
    pub fn team_args(self, link: &TeamLink, mcp_config: Option<&Path>) -> Vec<String> {
        let _ = link;
        match self {
            AgentKind::ClaudeCode => {
                let mut args = Vec::new();
                if let Some(cfg) = mcp_config {
                    // Deliberately NOT --strict-mcp-config: the user's own MCP
                    // servers must keep working alongside the team bus.
                    args.extend(["--mcp-config".into(), cfg.display().to_string()]);
                }
                args
            }
        }
    }

    /// Args that hand the team brief to the CLI as system-level context.
    pub fn brief_args(self, brief: &str) -> Vec<String> {
        match self {
            AgentKind::ClaudeCode => vec!["--append-system-prompt".into(), brief.into()],
        }
    }

    /// Environment a team member's child process needs: where the bus is, and
    /// which name it speaks as. Passed to the engine and, through it, to the
    /// MCP child, so every process opens the same file as the same agent.
    pub fn team_env(self, link: &TeamLink) -> Vec<(String, String)> {
        let _ = self;
        link.bus_env()
    }

    /// The MCP server config Claude Code expects, as JSON text. Written to a
    /// file by the caller because `--mcp-config` takes a path or a string and
    /// a path survives quoting far better than an inline string does.
    pub fn mcp_server_json(link: &TeamLink) -> String {
        let mut env = serde_json::Map::new();
        for (k, v) in link.bus_env() {
            env.insert(k, serde_json::Value::String(v));
        }
        serde_json::json!({
            "mcpServers": {
                "yuppy": {
                    "command": link.server_program.display().to_string(),
                    "args": ["mcp-bus"],
                    "env": env
                }
            }
        })
        .to_string()
    }

    /// Args that let the agent actually *use* the bus in a non-interactive run.
    ///
    /// A `claude -p` run has no human to answer a permission prompt, so the
    /// coordination tools would exist and be uncallable — the agent then
    /// reports "I have no teammates", which is worse than a missing tool.
    /// The grant is scoped to the YuppyCode server's own tools only: it is not
    /// `--dangerously-skip-permissions`, and file/shell permissions keep their
    /// configured behaviour exactly as before.
    pub fn bus_allow_args(self) -> Vec<String> {
        match self {
            AgentKind::ClaudeCode => {
                vec!["--allowed-tools".into(), BUS_SERVER_TOOL_SCOPE.into()]
            }
        }
    }
}

/// Scope string granting the YuppyCode bus tools to one Claude Code run.
pub const BUS_SERVER_TOOL_SCOPE: &str = "mcp__yuppy";

/// One team member's connection details, engine-agnostic.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TeamLink {
    /// Absolute path to the `yuppy` binary serving the bus over MCP.
    pub server_program: std::path::PathBuf,
    /// SQLite file backing the bus.
    pub bus: std::path::PathBuf,
    /// This agent's addressable name.
    pub name: String,
    pub role: String,
    pub task_id: String,
    /// Engine id this member runs on (always "claude-code" today).
    pub engine: String,
    /// Pre-allow the bus tools so a non-interactive run can use them. On by
    /// default (see [`AgentKind::bus_allow_args`]); `yuppy team
    /// --no-auto-allow` turns it off and the agent will then be unable to
    /// message anyone in `-p` mode.
    pub auto_allow_bus: bool,
    /// Everyone else on the mission, for the brief.
    pub teammates: Vec<String>,
}

impl TeamLink {
    /// The brief text this agent should be given, built from its own identity.
    pub fn brief(&self) -> String {
        yuppycode_bus::team_brief(&self.name, &self.role, &self.teammates)
    }

    /// The environment both the engine child and its MCP server child need.
    pub fn bus_env(&self) -> Vec<(String, String)> {
        vec![
            ("YUPPY_BUS".into(), self.bus.display().to_string()),
            ("YUPPY_AGENT".into(), self.name.clone()),
            ("YUPPY_AGENT_ROLE".into(), self.role.clone()),
            ("YUPPY_TASK_ID".into(), self.task_id.clone()),
            ("YUPPY_ENGINE".into(), self.engine.clone()),
        ]
    }
}

/// Detection outcome for one CLI.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentStatus {
    pub kind: AgentKind,
    pub path: Option<PathBuf>,
    /// Trimmed first line of `<cli> --version`, if it answered.
    pub version: Option<String>,
    /// Human-readable problem when detection failed (`Some` install hint
    /// or probe failure detail).
    pub problem: Option<String>,
}

impl AgentStatus {
    pub fn available(&self) -> bool {
        self.path.is_some()
    }
}

#[derive(Debug, thiserror::Error)]
pub enum AdapterError {
    #[error("{} is not installed. {hint}", kind.display_name(), hint = kind.install_hint())]
    NotInstalled { kind: AgentKind },
    #[error(transparent)]
    Terminal(#[from] TerminalError),
}

/// Locate `program` on PATH. Mirrors shell lookup order; on Unix the
/// file must be executable.
pub fn which(program: &str) -> Option<PathBuf> {
    if Path::new(program).is_absolute() {
        return (is_executable(Path::new(program))).then(|| PathBuf::from(program));
    }
    let path = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path) {
        let cand = dir.join(program);
        if is_executable(&cand) {
            return Some(cand);
        }
        #[cfg(windows)]
        {
            for ext in std::env::var("PATHEXT")
                .unwrap_or_else(|_| ".EXE;.CMD;.BAT".into())
                .split(';')
            {
                let cand = dir.join(format!("{program}{ext}"));
                if cand.is_file() {
                    return Some(cand);
                }
            }
        }
    }
    None
}

#[cfg(unix)]
fn is_executable(p: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(p)
        .map(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
        .unwrap_or(false)
}

#[cfg(not(unix))]
fn is_executable(p: &Path) -> bool {
    p.is_file()
}

/// Detect one CLI: presence on PATH plus a version probe.
///
/// The version probe has a hard timeout and cannot hang the caller; a
/// present-but-unresponsive binary still reports as installed.
pub fn detect(kind: AgentKind) -> AgentStatus {
    let path = which(kind.program_name());
    match path {
        None => AgentStatus {
            kind,
            path: None,
            version: None,
            problem: Some(kind.install_hint().to_string()),
        },
        Some(p) => AgentStatus {
            version: probe_version(&p, kind.version_args()),
            path: Some(p),
            kind,
            problem: None,
        },
    }
}

/// Detect every supported CLI (for `yuppy agents`).
pub fn detect_all() -> Vec<AgentStatus> {
    AgentKind::ALL.iter().copied().map(detect).collect()
}

fn probe_version(program: &Path, args: &[&str]) -> Option<String> {
    let mut child = Command::new(program)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .ok()?;
    let deadline = Instant::now() + Duration::from_secs(8);
    let status = loop {
        match child.try_wait() {
            Ok(Some(st)) => break st,
            Ok(None) => {
                if Instant::now() > deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    return None;
                }
                std::thread::sleep(Duration::from_millis(20));
            }
            Err(_) => return None,
        }
    };
    if !status.success() {
        return None;
    }
    let out = child.wait_with_output().ok()?;
    let stdout = String::from_utf8_lossy(&out.stdout).into_owned();
    let stderr = String::from_utf8_lossy(&out.stderr).into_owned();
    let line = stdout
        .lines()
        .chain(stderr.lines())
        .map(str::trim)
        .find(|l| !l.is_empty())?;
    Some(line.to_string())
}

/// Launch options for an interactive session.
#[derive(Debug, Clone, Default)]
pub struct SpawnOptions {
    /// Working directory (authorized workspace).
    pub cwd: Option<PathBuf>,
    /// Extra arguments passed through to the native CLI untouched.
    pub extra_args: Vec<String>,
    pub size: TerminalSize,
    /// Tab label override.
    pub label: Option<String>,
}

/// Start a real interactive session of the given CLI inside a PTY.
///
/// The child inherits this process's environment so each CLI's native
/// authentication and configuration apply unchanged (spec §3.3).
pub fn spawn_interactive(
    kind: AgentKind,
    opts: SpawnOptions,
) -> Result<TerminalSession, AdapterError> {
    let status = detect(kind);
    let program = status.path.ok_or(AdapterError::NotInstalled { kind })?;
    let mut config = SessionConfig::new(
        opts.label
            .unwrap_or_else(|| kind.display_name().to_string()),
        program,
    );
    config.args = kind
        .interactive_args()
        .iter()
        .map(|s| s.to_string())
        .chain(opts.extra_args)
        .collect();
    config.cwd = opts.cwd;
    config.size = opts.size;
    Ok(TerminalSession::spawn(config)?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn which_finds_a_known_system_binary() {
        // sh exists on every unix CI box; the assertion is about the
        // lookup mechanics, not the CLI adapters.
        if cfg!(unix) {
            let p = which("sh").expect("sh must be findable on PATH");
            assert!(p.is_absolute());
            assert!(is_executable(&p));
        }
    }

    #[test]
    fn which_reports_missing_programs_as_none() {
        assert!(which("yuppycode-definitely-not-installed-xyz").is_none());
    }

    #[test]
    fn detection_reports_install_hint_when_missing() {
        // A nonsense program name can only be 'missing'.
        let st = AgentStatus {
            kind: AgentKind::ClaudeCode,
            path: None,
            version: None,
            problem: Some(AgentKind::ClaudeCode.install_hint().to_string()),
        };
        assert!(!st.available());
        assert!(st.problem.unwrap().contains("https://"));
    }

    #[test]
    fn noninteractive_argv_matches_documented_print_mode() {
        assert_eq!(
            AgentKind::ClaudeCode.noninteractive_args("hi"),
            vec!["-p".to_string(), "hi".to_string()]
        );
    }

    #[test]
    fn headless_argv_streams_json_and_carries_the_permission_mode() {
        let args = AgentKind::ClaudeCode.headless_args("do it", Some("acceptEdits"));
        assert_eq!(
            args,
            vec![
                "-p",
                "do it",
                "--output-format",
                "stream-json",
                "--verbose",
                "--permission-mode",
                "acceptEdits"
            ]
        );
        let bypass = AgentKind::ClaudeCode.headless_args("x", Some("bypassPermissions"));
        assert_eq!(bypass.last().map(String::as_str), Some("bypassPermissions"));
    }

    #[test]
    fn default_or_unknown_permission_mode_passes_no_flag() {
        for mode in [None, Some("default"), Some("yolo"), Some("")] {
            let args = AgentKind::ClaudeCode.headless_args("x", mode);
            assert!(
                !args.iter().any(|a| a == "--permission-mode"),
                "{mode:?} -> {args:?}"
            );
            assert_eq!(&args[..2], ["-p", "x"]);
        }
    }

    #[test]
    fn only_claude_code_is_a_known_cli() {
        assert_eq!(AgentKind::ALL, [AgentKind::ClaudeCode]);
        assert_eq!(AgentKind::from_id("claude-code"), Some(AgentKind::ClaudeCode));
        assert_eq!(AgentKind::from_id("Claude"), Some(AgentKind::ClaudeCode));
        assert_eq!(AgentKind::from_id("codex"), None);
        assert!(is_permission_mode("acceptEdits"));
        assert!(!is_permission_mode("plan"));
        assert!(is_permission_mode(DEFAULT_PERMISSION_MODE));
    }

    // Machine-dependent: probe the real CLIs when they are installed.
    #[test]
    fn detect_real_claude_when_present() {
        let st = detect(AgentKind::ClaudeCode);
        if st.path.is_none() {
            eprintln!("claude not installed here; skipping");
            return;
        }
        let v = st.version.expect("claude --version should answer");
        assert!(
            v.contains("Claude") || v.chars().next().is_some_and(|c| c.is_ascii_digit()),
            "{v}"
        );
    }
}

#[cfg(test)]
mod team_wiring_tests {
    use super::*;

    fn link() -> TeamLink {
        TeamLink {
            server_program: "/usr/local/bin/yuppy".into(),
            bus: "/home/dev/.config/yuppycode/team.sqlite3".into(),
            name: "ada".into(),
            role: "backend".into(),
            task_id: "m1-backend".into(),
            engine: "claude-code".into(),
            auto_allow_bus: true,
            teammates: vec!["nova".into()],
        }
    }

    #[test]
    fn the_bus_tools_are_pre_allowed_only_for_our_own_server() {
        let args = AgentKind::ClaudeCode.bus_allow_args();
        assert_eq!(args, vec!["--allowed-tools", "mcp__yuppy"]);
        let joined = args.join(" ");
        assert!(!joined.contains("dangerously"), "{joined}");
        assert!(!joined.contains("bypassPermissions"), "{joined}");
    }

    #[test]
    fn claude_gets_the_bus_as_an_mcp_server_without_disabling_user_servers() {
        let args = AgentKind::ClaudeCode.team_args(&link(), Some(Path::new("/tmp/mcp.json")));
        assert_eq!(args, vec!["--mcp-config", "/tmp/mcp.json"]);
        assert!(
            !args.iter().any(|a| a.contains("strict-mcp-config")),
            "the user's own MCP servers must survive: {args:?}"
        );
        let json = AgentKind::mcp_server_json(&link());
        let v: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert_eq!(v["mcpServers"]["yuppy"]["command"], "/usr/local/bin/yuppy");
        assert_eq!(v["mcpServers"]["yuppy"]["args"][0], "mcp-bus");
        assert_eq!(
            v["mcpServers"]["yuppy"]["env"]["YUPPY_AGENT"], "ada",
            "the server must know who it speaks for"
        );
    }

    #[test]
    fn claude_takes_the_brief_as_a_flag() {
        let args = AgentKind::ClaudeCode.brief_args("TEAM BUS ACTIVE");
        assert_eq!(args, vec!["--append-system-prompt", "TEAM BUS ACTIVE"]);
    }

    #[test]
    fn claude_gets_the_bus_environment() {
        for kind in AgentKind::ALL {
            let env = kind.team_env(&link());
            let get = |k: &str| env.iter().find(|(n, _)| n == k).map(|(_, v)| v.clone());
            assert_eq!(
                get("YUPPY_BUS").as_deref(),
                Some("/home/dev/.config/yuppycode/team.sqlite3")
            );
            assert_eq!(get("YUPPY_AGENT").as_deref(), Some("ada"));
            assert_eq!(get("YUPPY_TASK_ID").as_deref(), Some("m1-backend"));
            assert_eq!(get("YUPPY_ENGINE").as_deref(), Some("claude-code"));
        }
    }

    #[test]
    fn the_brief_names_the_agent_and_its_teammate() {
        let brief = link().brief();
        assert!(brief.contains("ada") && brief.contains("nova"), "{brief}");
        assert!(brief.contains("yuppy_wait"));
    }
}
