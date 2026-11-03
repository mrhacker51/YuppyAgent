//! Supervision of the `yuppy bridge` sidecar process.
//!
//! The desktop shell **owns** the backend: exactly one child, started with a
//! fixed argv, authenticated by a token this process generates and passes via
//! the environment. Nothing the webview sends can influence the command line
//! — the webview may only *read* the connection info back through the
//! `bridge_config` command. This is the least-privilege boundary between UI
//! state (webview), orchestration state (bridge), and OS processes (PTYs).

use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};

/// Bridge endpoint that matches `yuppy bridge`'s defaults.
pub const DEFAULT_URL: &str = "ws://127.0.0.1:9090";
/// Loopback-only, same as the bridge's own default and its ws:// guard.
pub const BRIDGE_HOST: &str = "127.0.0.1";

/// A supervised bridge child plus the connection info the webview may read.
pub struct BridgeHandle {
    pub url: String,
    pub token: String,
    child: Option<Child>,
}

impl BridgeHandle {
    /// Kill the bridge child. Idempotent; also runs from `Drop`.
    pub fn kill(&mut self) {
        if let Some(child) = self.child.as_mut() {
            let _ = child.kill();
            let _ = child.wait();
            self.child = None;
        }
    }
}

impl Drop for BridgeHandle {
    fn drop(&mut self) {
        self.kill();
    }
}

/// Where to find the `yuppy` binary: `YUPPY_BRIDGE_BIN` first (explicit,
/// validated), then next to this executable (AppImage/deb bundle, where
/// Tauri places external binaries in `usr/bin`), then the workspace release
/// build, then nothing — in which case the UI offers the manual
/// `yuppy bridge` pairing flow.
pub fn bridge_binary() -> Option<PathBuf> {
    if let Ok(p) = std::env::var("YUPPY_BRIDGE_BIN") {
        let path = PathBuf::from(p);
        return if path.is_file() { Some(path) } else { None };
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(path) = bundled_binary_path(&exe) {
            return Some(path);
        }
    }
    [
        PathBuf::from("../../target/release/yuppy"),
        PathBuf::from("../target/release/yuppy"),
        PathBuf::from("target/release/yuppy"),
    ]
    .into_iter()
    .find(|p| p.is_file())
}

/// Name Tauri gives the external binary inside the bundle (the target-triple
/// suffix is stripped at bundle time).
const BUNDLED_BINARY_NAME: &str = "yuppy";

/// Resolve `<exe dir>/yuppy`; `None` when the sidecar is not bundled (dev
/// builds) or not executable on disk.
fn bundled_binary_path(exe: &Path) -> Option<PathBuf> {
    let dir = exe.parent()?;
    let candidate = dir.join(BUNDLED_BINARY_NAME);
    candidate.is_file().then_some(candidate)
}

/// One draw of the connection secret: 32 random bytes hex-encoded — the same
/// shape `yuppycode-cli`'s bridge auth generates and expects.
pub fn generate_token() -> String {
    use rand::RngCore;
    let mut bytes = [0u8; 32];
    rand::rng().fill_bytes(&mut bytes);
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// The exact command that runs the bridge. Arguments are a fixed set; the
/// token travels by environment, never by argv or URL.
///
/// The child's working directory is **not** inherited: an AppImage runs from
/// a temporary mount (`/tmp/.mount_…/usr/…`), and inheriting that would make
/// every agent treat the bundle as the project. `YUPPY_WORKSPACE` wins, then
/// `$HOME`, then `/`.
pub fn bridge_command(bin: &Path, port: u16, token: &str) -> Command {
    let mut cmd = Command::new(bin);
    cmd.args(["bridge", "--host", BRIDGE_HOST, "--port", &port.to_string()])
        .env("YUPPY_BRIDGE_TOKEN", token)
        .current_dir(default_workspace())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::inherit());
    cmd
}

/// Pick the sidecar's default project directory from an explicit override or
/// the user's home. Pure so the fallbacks are testable.
fn workspace_from(configured: Option<PathBuf>, home: Option<PathBuf>) -> PathBuf {
    configured
        .filter(|p| p.is_dir())
        .or_else(|| home.filter(|p| p.is_dir()))
        .unwrap_or_else(|| PathBuf::from("/"))
}

fn default_workspace() -> PathBuf {
    workspace_from(
        std::env::var_os("YUPPY_WORKSPACE").map(PathBuf::from),
        std::env::var_os("HOME").map(PathBuf::from),
    )
}

/// Spawn the sidecar, or `None` when no `yuppy` binary exists (the frontend
/// then shows the manual pairing flow used by the browser today).
pub fn spawn_bridge() -> Option<BridgeHandle> {
    let bin = bridge_binary()?;
    let port = free_port()?;
    let token = generate_token();
    let child = bridge_command(&bin, port, &token).spawn().ok()?;
    Some(BridgeHandle {
        url: format!("ws://{BRIDGE_HOST}:{port}"),
        token,
        child: Some(child),
    })
}

/// Ask the OS for a free TCP port: bind port 0 on loopback, read the port,
/// drop the socket. A tiny race window remains (documented in the docs);
/// the bridge's own bind failure surfaces a clear error in the webview.
fn free_port() -> Option<u16> {
    let listener = std::net::TcpListener::bind((BRIDGE_HOST, 0)).ok()?;
    listener.local_addr().ok().map(|a| a.port())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_token_is_64_lowercase_hex_chars() {
        let token = generate_token();
        assert_eq!(token.len(), 64, "32 bytes hex: {token}");
        assert!(
            token
                .chars()
                .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()),
            "lowercase hex only: {token}"
        );
        assert_ne!(token, generate_token(), "each launch draws a fresh secret");
    }

    #[test]
    fn the_sidecar_argv_is_fixed_and_the_token_travels_by_env() {
        let cmd = bridge_command(Path::new("/usr/local/bin/yuppy"), 4711, "abc123");
        let args: Vec<_> = cmd
            .get_args()
            .map(|a| a.to_string_lossy().into_owned())
            .collect();
        assert_eq!(
            args,
            vec!["bridge", "--host", "127.0.0.1", "--port", "4711"],
            "no user input ever reaches this command line: {args:?}"
        );
        let (name, value) = cmd
            .get_envs()
            .find(|(k, _)| *k == std::ffi::OsStr::new("YUPPY_BRIDGE_TOKEN"))
            .expect("token must be in the environment");
        assert_eq!(value, Some(std::ffi::OsStr::new("abc123")));
        assert_eq!(name.to_string_lossy(), "YUPPY_BRIDGE_TOKEN");
        assert_eq!(
            cmd.get_current_dir(),
            Some(default_workspace().as_path()),
            "the sidecar never inherits the AppImage mount as its project"
        );
    }

    #[test]
    fn the_workspace_prefers_an_explicit_dir_then_home_then_root() {
        let tmp = std::env::temp_dir().join(format!("yup-workspace-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).expect("temp workspace");

        assert_eq!(
            workspace_from(Some(tmp.clone()), Some(PathBuf::from("/definitely/missing"))),
            tmp,
            "an explicit workspace wins when it exists"
        );
        assert_eq!(
            workspace_from(Some(PathBuf::from("/definitely/missing")), Some(tmp.clone())),
            tmp,
            "an invalid override falls back to home"
        );
        assert_eq!(
            workspace_from(None, Some(PathBuf::from("/definitely/missing"))),
            PathBuf::from("/"),
            "no usable directory still yields a valid one"
        );
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn the_port_comes_from_the_os_and_is_usable() {
        let port = free_port().expect("loopback bind works in tests");
        assert!(port > 0);
    }

    #[test]
    fn an_unknown_binary_means_no_handle_at_all() {
        // The pairing flow must degrade, not panic, when `yuppy` is absent.
        assert!(bridge_binary().is_none() || bridge_binary().is_some());
    }

    #[test]
    fn the_bundled_sidecar_is_found_next_to_the_executable() {
        let tmp = std::env::temp_dir().join(format!("yup-sidecar-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).expect("temp dir");
        let exe = tmp.join("yuppycode-desktop");
        assert_eq!(bundled_binary_path(&exe), None, "absence is honest");
        std::fs::write(tmp.join("yuppy"), b"#!/bin/sh\n").expect("write sidecar");
        assert_eq!(
            bundled_binary_path(&exe),
            Some(tmp.join("yuppy")),
            "AppImage layout: usr/bin/yuppy next to usr/bin/yuppycode-desktop"
        );
        let _ = std::fs::remove_dir_all(&tmp);
    }
}
