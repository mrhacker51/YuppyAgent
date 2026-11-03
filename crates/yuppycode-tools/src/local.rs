//! Workspace-scoped file tools and shell execution.

use std::path::{Component, Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use serde_json::Value;
use tokio::fs;
use tokio::io::AsyncReadExt;
use tokio::process::Command;
use tokio::time::timeout;

use yuppycode_core::{
    ExecContext, Risk, ToolCall, ToolError, ToolExecutor, ToolFuture, ToolResult, ToolSpec,
};

use crate::policy::LocalToolPolicy;
use crate::schema::validate_arguments;

/// Max bytes `read_file` will load into memory / hand to the model.
const READ_MAX_BYTES: usize = 1024 * 1024;
/// Combined stdout+stderr cap for `shell`.
const SHELL_OUTPUT_CAP: usize = 256 * 1024;
const SHELL_DEFAULT_TIMEOUT: Duration = Duration::from_secs(30);

pub struct LocalToolExecutor {
    policy: LocalToolPolicy,
}

impl LocalToolExecutor {
    pub fn new(policy: LocalToolPolicy) -> Self {
        Self { policy }
    }

    fn read_spec() -> ToolSpec {
        ToolSpec {
            name: "read_file".into(),
            description: "Read the contents of a text file inside the workspace.".into(),
            input_schema: serde_json::json!({
                "type": "object",
                "required": ["path"],
                "properties": {
                    "path": {"type": "string", "description": "Relative or absolute workspace path"}
                },
                "additionalProperties": false
            }),
            risk: Risk::Safe,
        }
    }

    fn write_spec() -> ToolSpec {
        ToolSpec {
            name: "write_file".into(),
            description: "Write text content to a file inside the workspace. Creates parent directories as needed.".into(),
            input_schema: serde_json::json!({
                "type": "object",
                "required": ["path", "content"],
                "properties": {
                    "path": {"type": "string", "description": "Relative workspace path"},
                    "content": {"type": "string"}
                },
                "additionalProperties": false
            }),
            risk: Risk::Write,
        }
    }

    fn shell_spec() -> ToolSpec {
        ToolSpec {
            name: "shell".into(),
            description: concat!(
                "Execute a command. By default the command string is split into argv ",
                "and run directly without a shell. Set shell=true to run through /bin/sh -c."
            )
            .into(),
            input_schema: serde_json::json!({
                "type": "object",
                "required": ["command"],
                "properties": {
                    "command": {"type": "string", "description": "Command line"},
                    "shell": {"type": "boolean", "description": "Run via /bin/sh -c"},
                    "timeout_seconds": {"type": "integer", "description": "Per-command timeout (default 30)"}
                },
                "additionalProperties": false
            }),
            risk: Risk::Execute,
        }
    }

    async fn do_read(call: &ToolCall, ctx: &ExecContext) -> Result<ToolResult, ToolError> {
        let path = arg_str(&call.arguments, "path")?;
        let resolved = resolve_path(path, &ctx.workspace_root, false)?;
        let file = fs::File::open(&resolved)
            .await
            .map_err(|e| ToolError::Execution(format!("read_file failed: {e}")))?;
        let mut buf = Vec::with_capacity(4 * 1024);
        // Hard cap; anything larger is reported as truncated.
        let n = file
            .take(READ_MAX_BYTES as u64 + 1)
            .read_to_end(&mut buf)
            .await
            .map_err(|e| ToolError::Execution(format!("read_file failed: {e}")))?;
        let truncated = n > READ_MAX_BYTES;
        if truncated {
            buf.truncate(READ_MAX_BYTES);
        }
        let text = String::from_utf8_lossy(&buf).into_owned();
        let mut out = ToolResult::ok(call.id.clone(), text);
        out.truncated = truncated;
        Ok(out)
    }

    async fn do_write(call: &ToolCall, ctx: &ExecContext) -> Result<ToolResult, ToolError> {
        if !ctx.allow_write {
            return Err(ToolError::Denied("write_file disabled by policy".into()));
        }
        let path = arg_str(&call.arguments, "path")?;
        let content = arg_str(&call.arguments, "content")?;
        let resolved = resolve_path(path, &ctx.workspace_root, true)?;
        // Ensure parent is inside workspace.
        if let Some(parent) = resolved.parent() {
            fs::create_dir_all(parent)
                .await
                .map_err(|e| ToolError::Execution(format!("create_dir failed: {e}")))?;
        }
        fs::write(&resolved, content)
            .await
            .map_err(|e| ToolError::Execution(format!("write_file failed: {e}")))?;
        Ok(ToolResult::ok(
            call.id.clone(),
            format!("wrote {} bytes to {}", content.len(), resolved.display()),
        ))
    }

    async fn do_shell(call: &ToolCall, ctx: &ExecContext) -> Result<ToolResult, ToolError> {
        if !ctx.allow_write {
            // shell is treated as a write/exec capability; engine passes allow_write
            return Err(ToolError::Denied("shell disabled by policy".into()));
        }
        let command = arg_str(&call.arguments, "command")?;
        let use_shell = call
            .arguments
            .get("shell")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let secs = call
            .arguments
            .get("timeout_seconds")
            .and_then(Value::as_u64)
            .map(|n| n.clamp(1, 300))
            .unwrap_or(SHELL_DEFAULT_TIMEOUT.as_secs());
        let dur = Duration::from_secs(secs);

        let mut cmd = if use_shell {
            let mut c = Command::new("/bin/sh");
            c.arg("-c").arg(command);
            c
        } else {
            match split_args(command) {
                Some((prog, args)) => {
                    let mut c = Command::new(prog);
                    c.args(args);
                    c
                }
                None => {
                    return Err(ToolError::InvalidArguments {
                        tool: "shell".into(),
                        reason: "empty command".into(),
                    });
                }
            }
        };
        cmd.current_dir(&ctx.workspace_root)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);

        let run = async {
            let child = cmd
                .spawn()
                .map_err(|e| ToolError::Execution(format!("spawn failed: {e}")))?;
            let output = child
                .wait_with_output()
                .await
                .map_err(|e| ToolError::Execution(format!("wait failed: {e}")))?;
            Ok::<_, ToolError>(output)
        };
        let output = match timeout(dur, run).await {
            Ok(Ok(o)) => o,
            Ok(Err(e)) => return Err(e),
            Err(_elapsed) => return Err(ToolError::Timeout(dur)),
        };

        let mut out = String::new();
        if !output.stdout.is_empty() {
            out.push_str(&String::from_utf8_lossy(&output.stdout));
        }
        if !output.stderr.is_empty() {
            if !out.is_empty() {
                out.push('\n');
            }
            out.push_str("[stderr] ");
            out.push_str(&String::from_utf8_lossy(&output.stderr));
        }
        let truncated = out.len() > SHELL_OUTPUT_CAP;
        if truncated {
            truncate_at_boundary(&mut out, SHELL_OUTPUT_CAP);
            out.push_str("\n[output truncated by shell cap]");
        }
        let is_error = !output.status.success();
        let mut result = ToolResult::ok(call.id.clone(), out);
        result.is_error = is_error;
        result.truncated = truncated;
        result.summary = yuppycode_core::tools::summarize(&result.output);
        Ok(result)
    }
}

impl ToolExecutor for LocalToolExecutor {
    fn specs(&self) -> Vec<ToolSpec> {
        match self.policy {
            LocalToolPolicy::ReadOnly => vec![Self::read_spec()],
            LocalToolPolicy::WorkspaceWrite | LocalToolPolicy::Full => {
                vec![Self::read_spec(), Self::write_spec(), Self::shell_spec()]
            }
        }
    }

    fn validate(&self, name: &str, args: &Value) -> Result<(), String> {
        let schema = self
            .specs()
            .into_iter()
            .find(|s| s.name == name)
            .ok_or_else(|| format!("unknown tool '{name}'"))?
            .input_schema;
        validate_arguments(&schema, args)
    }

    fn requires_approval(&self, call: &ToolCall) -> bool {
        let risk = self
            .specs()
            .iter()
            .find(|s| s.name == call.name)
            .map(|s| s.risk);
        match risk {
            Some(Risk::Execute) | Some(Risk::External) => true,
            Some(Risk::Write) if matches!(self.policy, LocalToolPolicy::WorkspaceWrite) => true,
            _ => false,
        }
    }

    fn execute(&self, call: ToolCall, ctx: ExecContext) -> ToolFuture {
        Box::pin(async move {
            let r = match call.name.as_str() {
                "read_file" => Self::do_read(&call, &ctx).await,
                "write_file" => Self::do_write(&call, &ctx).await,
                "shell" => Self::do_shell(&call, &ctx).await,
                other => Err(ToolError::Unknown(other.into())),
            };
            if ctx.cancel.is_cancelled() {
                return Err(ToolError::Cancelled);
            }
            r
        })
    }
}

fn arg_str<'a>(args: &'a Value, key: &str) -> Result<&'a str, ToolError> {
    args.get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| ToolError::InvalidArguments {
            tool: "?".into(),
            reason: format!("missing or non-string argument '{key}'"),
        })
}

/// Resolve a user-supplied path against the workspace root, rejecting escapes
/// and symlink breakouts.
fn resolve_path(user: &str, root: &Path, create_parents: bool) -> Result<PathBuf, ToolError> {
    let root_abs = normalize_existing_dir(root)?;
    let path = Path::new(user);
    let resolved = if path.is_absolute() {
        path.to_path_buf()
    } else {
        root_abs.join(path)
    };
    let resolved = normalize_components(&resolved)?;
    secure_canonicalize(&resolved, &root_abs, create_parents)
}

/// Canonicalize a directory (workspace root must exist).
fn normalize_existing_dir(path: &Path) -> Result<PathBuf, ToolError> {
    std::fs::canonicalize(path)
        .map_err(|e| ToolError::Execution(format!("workspace path invalid: {e}")))
}

/// Canonicalize an existing path or its parent, then verify it stays inside
/// the workspace. Symlinks are resolved by `std::fs::canonicalize`, so any
/// symlink pointing outside the root is caught by the prefix check.
fn secure_canonicalize(
    path: &Path,
    root: &Path,
    create_parents: bool,
) -> Result<PathBuf, ToolError> {
    if let Ok(canon) = std::fs::canonicalize(path) {
        if canon.starts_with(root) {
            return Ok(canon);
        }
        return Err(ToolError::Denied(format!(
            "path escapes workspace: {}",
            path.display()
        )));
    }

    // Path does not exist yet (typical for write_file). Resolve and check the
    // parent directory, then keep the final file name local.
    let parent = path
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    let parent_canon = match std::fs::canonicalize(parent) {
        Ok(p) => p,
        Err(_) if create_parents => {
            let norm = normalize_components(parent)?;
            if !norm.starts_with(root) {
                return Err(ToolError::Denied(format!(
                    "parent directory escapes workspace: {}",
                    path.display()
                )));
            }
            std::fs::create_dir_all(&norm).map_err(|e| {
                ToolError::Execution(format!("cannot create parent directory: {e}"))
            })?;
            std::fs::canonicalize(&norm).map_err(|e| {
                ToolError::Execution(format!("cannot resolve parent directory: {e}"))
            })?
        }
        Err(e) => {
            return Err(ToolError::Execution(format!(
                "cannot resolve parent directory: {e}"
            )));
        }
    };
    if !parent_canon.starts_with(root) {
        return Err(ToolError::Denied(format!(
            "parent directory escapes workspace: {}",
            path.display()
        )));
    }
    let file_name = path
        .file_name()
        .ok_or_else(|| ToolError::InvalidArguments {
            tool: "write_file".into(),
            reason: "invalid file path".into(),
        })?;
    Ok(parent_canon.join(file_name))
}

/// Remove `.` and `..` without touching the filesystem. `..` that climbs above
/// the original absolute prefix is treated as traversal.
fn normalize_components(path: &Path) -> Result<PathBuf, ToolError> {
    let mut stack = Vec::new();
    let mut started = false;
    for comp in path.components() {
        match comp {
            Component::Prefix(p) => {
                stack.push(Path::new(p.as_os_str()).to_path_buf());
                started = true;
            }
            Component::RootDir => {
                if !started {
                    stack.push(PathBuf::from(std::path::MAIN_SEPARATOR.to_string()));
                    started = true;
                }
            }
            Component::CurDir => {}
            Component::ParentDir => {
                if stack.pop().is_none() {
                    return Err(ToolError::Denied("path traversal detected".into()));
                }
            }
            Component::Normal(s) => stack.push(PathBuf::from(s)),
        }
    }
    if stack.is_empty() {
        return Ok(PathBuf::from("."));
    }
    let mut out = stack[0].clone();
    for p in &stack[1..] {
        out.push(p);
    }
    Ok(out)
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

/// Minimal shlex-like split. Returns None for empty input.
fn split_args(s: &str) -> Option<(String, Vec<String>)> {
    let s = s.trim();
    if s.is_empty() {
        return None;
    }
    let mut args = Vec::new();
    let mut current = String::new();
    let mut in_single = false;
    let mut in_double = false;
    let mut escape = false;
    for ch in s.chars() {
        if escape {
            current.push(ch);
            escape = false;
            continue;
        }
        match ch {
            '\\' if !in_single => escape = true,
            '\'' if !in_double => in_single = !in_single,
            '"' if !in_single => in_double = !in_double,
            c if c.is_whitespace() && !in_single && !in_double => {
                if !current.is_empty() {
                    args.push(std::mem::take(&mut current));
                }
            }
            c => current.push(c),
        }
    }
    if !current.is_empty() {
        args.push(current);
    }
    if args.is_empty() {
        None
    } else {
        let mut it = args.into_iter();
        Some((it.next().unwrap(), it.collect()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use yuppycode_core::CallId;

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

    fn ctx(tmp: &std::path::Path, allow_write: bool) -> ExecContext {
        ExecContext {
            workspace_id: yuppycode_core::WorkspaceId::next(),
            workspace_root: tmp.to_path_buf(),
            cancel: yuppycode_core::CancelToken::new(),
            allow_write,
        }
    }

    fn call(name: &str, args: Value) -> ToolCall {
        ToolCall {
            id: CallId::next(),
            name: name.into(),
            arguments: args,
        }
    }

    #[test]
    fn split_args_respects_quotes_and_escapes() {
        assert_eq!(
            split_args("git commit -m \"hello world\""),
            Some((
                "git".into(),
                vec!["commit".into(), "-m".into(), "hello world".into()]
            ))
        );
        assert_eq!(
            split_args("echo 'a b'"),
            Some(("echo".into(), vec!["a b".into()]))
        );
        assert_eq!(split_args(""), None);
    }

    #[test]
    fn normalize_rejects_traversal() {
        let _base = PathBuf::from("/workspace");
        assert_eq!(
            normalize_components(Path::new("/workspace/a/../b")).unwrap(),
            PathBuf::from("/workspace/b")
        );
        assert!(normalize_components(Path::new("a/../../b")).is_err());
    }

    #[tokio::test]
    async fn read_write_inside_workspace() {
        let tmp = tempfile::tempdir().unwrap();
        let exe = LocalToolExecutor::new(LocalToolPolicy::WorkspaceWrite);
        let write = call(
            "write_file",
            serde_json::json!({"path": "sub/greeting.txt", "content": "hello"}),
        );
        let r = exe.execute(write, ctx(tmp.path(), true)).await.unwrap();
        assert!(r.output.contains("wrote 5 bytes"));

        let read = call("read_file", serde_json::json!({"path": "sub/greeting.txt"}));
        let r = exe.execute(read, ctx(tmp.path(), true)).await.unwrap();
        assert!(r.output.contains("hello"));
    }

    #[tokio::test]
    async fn write_denied_when_readonly() {
        let tmp = tempfile::tempdir().unwrap();
        let exe = LocalToolExecutor::new(LocalToolPolicy::ReadOnly);
        let write = call(
            "write_file",
            serde_json::json!({"path": "x.txt", "content": "!"}),
        );
        assert!(exe.execute(write, ctx(tmp.path(), false)).await.is_err());
    }

    #[tokio::test]
    async fn traversal_is_rejected() {
        let tmp = tempfile::tempdir().unwrap();
        let mut outside = tmp.path().to_path_buf();
        outside.pop();
        let bad = outside.join("secret.txt");
        std::fs::File::create(&bad)
            .unwrap()
            .write_all(b"secret".as_slice())
            .unwrap();
        let exe = LocalToolExecutor::new(LocalToolPolicy::WorkspaceWrite);
        let read = call("read_file", serde_json::json!({"path": "../secret.txt"}));
        let err = exe.execute(read, ctx(tmp.path(), true)).await.unwrap_err();
        assert!(err.to_string().contains("escapes") || err.to_string().contains("traversal"));
    }

    #[tokio::test]
    async fn symlink_escape_is_rejected() {
        let tmp = tempfile::tempdir().unwrap();
        let mut outside = tmp.path().to_path_buf();
        outside.pop();
        std::fs::File::create(outside.join("secret2.txt"))
            .unwrap()
            .write_all(b"secret2")
            .unwrap();
        std::os::unix::fs::symlink(outside.join("secret2.txt"), tmp.path().join("link.txt"))
            .unwrap();
        let exe = LocalToolExecutor::new(LocalToolPolicy::WorkspaceWrite);
        let read = call("read_file", serde_json::json!({"path": "link.txt"}));
        let err = exe.execute(read, ctx(tmp.path(), true)).await.unwrap_err();
        assert!(err.to_string().contains("escapes"));
    }

    #[tokio::test]
    async fn shell_runs_argv_and_captures_output() {
        let tmp = tempfile::tempdir().unwrap();
        let exe = LocalToolExecutor::new(LocalToolPolicy::Full);
        let sh = call("shell", serde_json::json!({"command": "echo ok"}));
        let r = exe.execute(sh, ctx(tmp.path(), true)).await.unwrap();
        assert!(r.output.contains("ok"));
    }

    #[tokio::test]
    async fn shell_respects_timeout() {
        let tmp = tempfile::tempdir().unwrap();
        let exe = LocalToolExecutor::new(LocalToolPolicy::Full);
        let sh = call(
            "shell",
            serde_json::json!({"command": "sleep 10", "timeout_seconds": 1}),
        );
        assert!(matches!(
            exe.execute(sh, ctx(tmp.path(), true)).await,
            Err(ToolError::Timeout(_))
        ));
    }
}
