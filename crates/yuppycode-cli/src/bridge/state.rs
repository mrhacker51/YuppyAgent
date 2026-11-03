//! Shared mutable state exposed by the bridge.
//!
//! The bridge is async, so terminal operations use a `tokio::sync::Mutex`
//! even though the underlying `TerminalManager` is synchronous. This keeps
//! the handlers simple and avoids blocking the WebSocket accept loop.

#![allow(dead_code)] // fully used in Tasks 5 and 6.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex as StdMutex, OnceLock, mpsc};

use tokio::sync::{Mutex, broadcast};

use yuppycode_agents::{AgentStatus, detect_all};
use yuppycode_hud::{DepartmentRegistry, HudStore, LayoutModel};
use yuppycode_orchestrator::CancelFlag;
use yuppycode_protocol::{AgentStatusDto, DepartmentDto, EngineInfo, LayoutDto};
use crate::terminals::{TerminalEvent, TerminalManager};

/// All mutable state the bridge handlers need.
pub struct BridgeState {
    pub terminals: Mutex<TerminalManager>,
    pub hud: Arc<HudStore>,
    pub departments: Mutex<DepartmentRegistry>,
    pub layout: Mutex<LayoutModel>,
    /// Default workspace for task runs and terminals.
    pub workspace: PathBuf,
    /// Broadcast source for orchestrator task-state updates.
    pub task_events_tx: broadcast::Sender<yuppycode_protocol::ServerPayload>,
    /// Per-task cancellation handles for submitted tasks.
    pub task_cancels: Arc<StdMutex<HashMap<String, CancelFlag>>>,
    /// Wake channel passed to `TerminalManager::open`. Threads inside the
    /// terminal crate send `TerminalEvent::Activity(id)` here; a forwarding
    /// thread broadcasts those events so each client connection can subscribe.
    pub terminal_wake_tx: mpsc::Sender<TerminalEvent>,
    /// Broadcast source for terminal output wakes. Client loops subscribe here.
    pub terminal_broadcast_tx: broadcast::Sender<TerminalEvent>,
    /// Where a lead seat's conductor MCP child connects back to. Set once by
    /// `yuppy bridge` after it binds; unset in unit tests that build a bare
    /// state, which then refuse to open a lead seat instead of faking one.
    pub conductor: OnceLock<ConductorEndpoint>,
}

/// Connection details handed to the lead seat's conductor MCP child.
///
/// The token is a second, private credential (never printed, never sent to
/// a client) that authorizes only task submit/cancel. It reaches the child
/// through the `env` block of an MCP config file written 0600 inside a 0700
/// directory, because that is the one channel Claude Code guarantees to pass
/// to an MCP server process.
pub struct ConductorEndpoint {
    pub url: String,
    pub token: super::auth::ConnectionToken,
    dir: OnceLock<PathBuf>,
}

/// Env var naming the bridge WebSocket URL for the conductor MCP child.
pub const CONDUCTOR_URL_ENV: &str = "YUPPY_CONDUCTOR_URL";
/// Env var carrying the conductor token. Never logged.
pub const CONDUCTOR_TOKEN_ENV: &str = "YUPPY_CONDUCTOR_TOKEN";
/// MCP server name the lead sees (tools appear as `mcp__yuppy-conductor__*`).
pub const CONDUCTOR_SERVER_NAME: &str = "yuppy-conductor";

impl ConductorEndpoint {
    pub fn new(url: String, token: super::auth::ConnectionToken) -> Self {
        Self {
            url,
            token,
            dir: OnceLock::new(),
        }
    }

    /// The `--mcp-config` JSON for a lead seat.
    pub fn mcp_config_json(&self, program: &std::path::Path) -> String {
        serde_json::json!({
            "mcpServers": {
                CONDUCTOR_SERVER_NAME: {
                    "command": program.display().to_string(),
                    "args": ["conductor-mcp"],
                    "env": {
                        CONDUCTOR_URL_ENV: self.url,
                        CONDUCTOR_TOKEN_ENV: self.token.as_str(),
                    }
                }
            }
        })
        .to_string()
    }

    /// Write the lead's MCP config into this bridge's private directory and
    /// return its path. Same file for every lead seat of this bridge.
    pub fn write_mcp_config(&self) -> std::io::Result<PathBuf> {
        let dir = match self.dir.get() {
            Some(d) => d.clone(),
            None => {
                let d = private_dir()?;
                let _ = self.dir.set(d);
                self.dir.get().cloned().unwrap_or_default()
            }
        };
        let program = std::env::current_exe().unwrap_or_else(|_| PathBuf::from("yuppy"));
        let path = dir.join("lead-mcp.json");
        let body = self.mcp_config_json(&program);
        let mut opts = std::fs::OpenOptions::new();
        opts.write(true).create(true).truncate(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            opts.mode(0o600);
        }
        use std::io::Write as _;
        opts.open(&path)?.write_all(body.as_bytes())?;
        Ok(path)
    }
}

impl Drop for ConductorEndpoint {
    fn drop(&mut self) {
        if let Some(dir) = self.dir.get() {
            let _ = std::fs::remove_dir_all(dir);
        }
    }
}

/// A fresh 0700 directory under the temp dir, never a predictable path that
/// another local user could pre-create or symlink.
fn private_dir() -> std::io::Result<PathBuf> {
    use rand::RngCore;
    let base = std::env::temp_dir();
    for _ in 0..16 {
        let n = rand::thread_rng().next_u64();
        let dir = base.join(format!("yuppy-lead-{}-{n:016x}", std::process::id()));
        match std::fs::create_dir(&dir) {
            Ok(()) => {
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700))?;
                }
                return Ok(dir);
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(e),
        }
    }
    Err(std::io::Error::other(
        "could not allocate a private lead directory",
    ))
}

impl BridgeState {
    /// Workspace/engine facts for the desktop top bar: the workspace path,
    /// a one-shot git branch sample, sidecar identity. Sampled on demand —
    /// the initial handshake burst calls this once per client connect.
    pub fn engine_info(&self) -> EngineInfo {
        EngineInfo {
            provider: "yuppy-bridge".to_string(),
            // The hosted CLIs own their model choices; the bridge does not
            // guess one (the top bar shows the CLI inventory instead).
            model: String::new(),
            engine_state: "sidecar".to_string(),
            workspace: self.workspace.display().to_string(),
            memory_enabled: false,
            mcp_servers: Vec::new(),
            git_branch: git_branch(&self.workspace),
        }
    }

    pub fn new(default_cwd: Option<PathBuf>) -> Self {
        let workspace = default_cwd
            .clone()
            .or_else(|| std::env::current_dir().ok())
            .unwrap_or_else(|| PathBuf::from("."));
        let (std_tx, std_rx) = mpsc::channel::<TerminalEvent>();
        let (broadcast_tx, _broadcast_rx) = broadcast::channel::<TerminalEvent>(256);
        let (task_events_tx, _task_events_rx) =
            broadcast::channel::<yuppycode_protocol::ServerPayload>(256);

        // Forward synchronous terminal wakes into the async broadcast channel.
        // `broadcast::Sender::send` errors whenever *no subscriber* is live —
        // that is the normal state between client connections, NOT a reason
        // to stop. Breaking here would drop std_rx, kill every per-session
        // wake-pump thread, and leave the next client with no terminal
        // updates for the rest of the bridge's life. So: drain, drop events
        // when nobody is listening, keep running until the state is dropped.
        let forward_tx = broadcast_tx.clone();
        std::thread::spawn(move || {
            while let Ok(ev) = std_rx.recv() {
                // Err(Closed) = no subscribers right now → discard; the next
                // client to subscribe resumes the flow immediately.
                let _ = forward_tx.send(ev);
            }
        });

        Self {
            terminals: Mutex::new(TerminalManager::new(default_cwd)),
            hud: Arc::new(HudStore::from_env()),
            departments: Mutex::new(DepartmentRegistry::default()),
            layout: Mutex::new(LayoutModel::default()),
            workspace,
            task_events_tx,
            task_cancels: Arc::new(StdMutex::new(HashMap::new())),
            terminal_wake_tx: std_tx,
            terminal_broadcast_tx: broadcast_tx,
            conductor: OnceLock::new(),
        }
    }

    /// Load persisted departments and layout, falling back to defaults on
    /// error so the bridge always starts in a usable state.
    pub async fn load_defaults(&self) {
        match self.hud.load_departments() {
            Ok(loaded) => {
                if let Some(w) = &loaded.warning {
                    eprintln!("departments warning: {w}");
                }
                *self.departments.lock().await = loaded.value;
            }
            Err(e) => eprintln!("departments unavailable ({e}); using defaults"),
        }
        match self.hud.load_layout() {
            Ok(loaded) => {
                if let Some(w) = &loaded.warning {
                    eprintln!("layout warning: {w}");
                }
                *self.layout.lock().await = loaded.value;
            }
            Err(e) => eprintln!("layout unavailable ({e}); using defaults"),
        }
    }

    pub fn agent_inventory(&self) -> Vec<AgentStatusDto> {
        detect_all().into_iter().map(dto::agent_status).collect()
    }

    pub async fn departments_dto(&self) -> Vec<DepartmentDto> {
        self.departments
            .lock()
            .await
            .departments
            .iter()
            .map(dto::department)
            .collect()
    }

    pub async fn layout_dto(&self) -> LayoutDto {
        dto::layout(&*self.layout.lock().await)
    }
}

/// Bridge-specific DTO conversions.
mod dto {
    use super::*;

    pub fn agent_status(s: AgentStatus) -> AgentStatusDto {
        AgentStatusDto {
            id: s.kind.id().to_string(),
            display_name: s.kind.display_name().to_string(),
            available: s.path.is_some(),
            version: s.version,
            install_hint: if s.path.is_some() {
                None
            } else {
                Some(s.kind.install_hint().to_string())
            },
        }
    }

    pub fn department(d: &yuppycode_hud::Department) -> DepartmentDto {
        DepartmentDto {
            id: d.id.clone(),
            name: d.name.clone(),
            description: d.description.clone(),
            icon: d.icon.clone(),
            agents: d
                .agents
                .iter()
                .map(|a| yuppycode_protocol::DeptAgentDto {
                    cli: a.cli.clone(),
                    model: a.model.clone(),
                })
                .collect(),
            roles: d
                .roles
                .iter()
                .map(|r| yuppycode_protocol::DepartmentRoleDto {
                    id: r.id.clone(),
                    name: r.name.clone(),
                    description: r.description.clone(),
                    cli: r.cli.clone(),
                    model: r.model.clone(),
                    enabled: r.enabled,
                })
                .collect(),
            workspace: d.workspace.clone(),
            allowed_tools: d.allowed_tools.clone(),
            max_concurrency: d.max_concurrency,
            enabled: d.enabled,
            panels: d.panels.clone(),
        }
    }

    /// The wire form of a layout is owned by `yuppycode-hud`. Rebuilding it here
    /// is what let the terminal and the browser drift apart, so this is a
    /// forwarding call rather than a second mapping.
    pub fn layout(l: &LayoutModel) -> LayoutDto {
        yuppycode_hud::dto::layout_dto(l)
    }
}

#[cfg(test)]
mod dto_parity {
    use super::BridgeState;
    use yuppycode_hud::dto::layout_dto as hud_layout_dto;
    use yuppycode_hud::{LayoutModel, PanelKind};

    async fn bridge_layout(model: LayoutModel) -> yuppycode_protocol::LayoutDto {
        let state = BridgeState::new(Some(std::env::current_dir().unwrap()));
        *state.layout.lock().await = model;
        state.layout_dto().await
    }

    /// The terminal and the browser render the same screen from two different
    /// conversions of one model. They are maintained separately, so the wire
    /// form the UI gets has to be pinned against the HUD's own.
    #[tokio::test]
    async fn the_bridge_and_the_hud_agree_on_the_default_layout() {
        let model = LayoutModel::default();
        let expected = hud_layout_dto(&model);
        let got = bridge_layout(model.clone()).await;
        assert_eq!(
            got.panels.len(),
            expected.panels.len(),
            "the browser must be shown every panel the terminal shows"
        );
        assert_eq!(got, expected, "the two DTO builders disagree");
    }

    #[tokio::test]
    async fn the_two_conversions_agree_for_every_known_panel_kind() {
        let kinds: Vec<PanelKind> = LayoutModel::default()
            .panels
            .iter()
            .map(|p| p.kind.clone())
            .collect();
        let mut model = LayoutModel::default();
        for (i, kind) in kinds.iter().enumerate() {
            model.panels[i].kind = kind.clone();
        }
        assert_eq!(
            bridge_layout(model.clone()).await,
            hud_layout_dto(&model),
            "a stock panel must not reach the browser in a different shape"
        );
    }

    #[tokio::test]
    async fn an_unknown_panel_kind_reaches_the_browser_as_a_plain_name() {
        // Deserialising a panel kind neither crate knows about yields `Custom`,
        // which is the mechanism that lets a newer layout open in an older
        // binary. `kind` is a string on the wire (`kind: string` in the UI), so
        // the name has to survive the trip as a readable name.
        let mut model = LayoutModel::default();
        model.panels[0].kind = PanelKind::Custom("mission_control".into());

        let expected = hud_layout_dto(&model);
        assert_eq!(expected.panels[0].kind, "mission_control");

        let got = bridge_layout(model).await;
        assert_eq!(
            got.panels[0].kind, "mission_control",
            "the bridge sends {:?} where the HUD sends \"mission_control\" — \
             the browser renders a JSON blob as a panel type",
            got.panels[0].kind
        );
    }
}

/// Branch of the working tree at `dir`, or `None` when git is missing, the
/// directory is not a checkout, or HEAD is unborn. One synchronous call:
/// the handshake burst runs it once per connect, never per frame.
fn git_branch(dir: &std::path::Path) -> Option<String> {
    let out = std::process::Command::new("git")
        .arg("-C")
        .arg(dir)
        .args(["rev-parse", "--abbrev-ref", "HEAD"])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let branch = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if branch.is_empty() || branch == "HEAD" {
        None
    } else {
        Some(branch)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_real_checkout_reports_its_branch_and_a_stranger_reports_none() {
        let tmp = std::env::temp_dir().join(format!("yup-git-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).expect("temp workspace");
        assert_eq!(git_branch(&tmp), None, "not a checkout: absence is honest");

        let ok = std::process::Command::new("git")
            .args(["-C"])
            .arg(&tmp)
            .args(["init", "-q", "-b", "main"])
            .status();
        if ok.map(|s| s.success()).unwrap_or(false) {
            // Unborn HEAD: no commit yet, so no branch name — honest absence.
            assert_eq!(
                git_branch(&tmp),
                None,
                "unborn HEAD must not invent a branch"
            );
            let committed = std::process::Command::new("git")
                .args(["-C"])
                .arg(&tmp)
                .args([
                    "-c",
                    "user.email=yuppy@test",
                    "-c",
                    "user.name=yuppy",
                    "commit",
                    "--allow-empty",
                    "-q",
                    "-m",
                    "init",
                ])
                .status();
            if committed.map(|s| s.success()).unwrap_or(false) {
                assert_eq!(git_branch(&tmp), Some("main".into()), "branch after commit");
            }
        }
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn the_lead_mcp_config_is_private_and_points_back_at_the_bridge() {
        let ep = ConductorEndpoint::new(
            "ws://127.0.0.1:1234".into(),
            super::super::auth::ConnectionToken("c".repeat(64)),
        );
        let path = ep.write_mcp_config().expect("write config");
        let v: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        let server = &v["mcpServers"][CONDUCTOR_SERVER_NAME];
        assert_eq!(server["args"], serde_json::json!(["conductor-mcp"]));
        assert_eq!(server["env"][CONDUCTOR_URL_ENV], "ws://127.0.0.1:1234");
        assert_eq!(server["env"][CONDUCTOR_TOKEN_ENV], "c".repeat(64));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let file = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
            let dir = std::fs::metadata(path.parent().unwrap())
                .unwrap()
                .permissions()
                .mode()
                & 0o777;
            assert_eq!(file, 0o600, "the token file must be owner-only");
            assert_eq!(dir, 0o700, "the token directory must be owner-only");
        }
        let dir = path.parent().unwrap().to_path_buf();
        drop(ep);
        assert!(
            !dir.exists(),
            "the private directory is removed with the endpoint"
        );
    }

    #[test]
    fn engine_info_names_the_workspace_and_its_branch() {
        let state = BridgeState::new(Some(std::path::PathBuf::from("/tmp")));
        let info = state.engine_info();
        assert_eq!(info.workspace, "/tmp");
        assert_eq!(info.provider, "yuppy-bridge");
        assert!(info.model.is_empty(), "the bridge never invents a model");
    }
}
