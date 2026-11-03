//! Execution isolation: shared workspace vs. per-task git worktree.
//!
//! Worktree isolation (spec §4): each parallel task that may touch code
//! runs in its own `git worktree` on a dedicated branch. Results are
//! *collected*, never integrated: finishing a task commits the worktree
//! to its branch and produces an [`Integration`] review artifact. The
//! orchestrator never merges, never force-pushes, never touches the
//! user's checked-out branch, and never overwrites another task's work
//! (separate branches by construction).

use std::path::{Path, PathBuf};

use tokio::process::Command;

#[derive(Debug, thiserror::Error)]
pub enum IsolationError {
    #[error("git failed: {cmd} -> {message}")]
    Git { cmd: String, message: String },
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
}

/// How a task's working directory is provisioned.
#[derive(Debug, Clone)]
pub enum Isolation {
    /// Run directly in the given workspace. Only safe when tasks are
    /// known not to conflict (or run sequentially).
    Shared { workspace: PathBuf },
    /// Create a detached worktree of `repo` for the task, on branch
    /// `yuppy/task-<id>`, in a private directory under the system temp
    /// dir (kept out of the repo so the user's `git status` stays
    /// untouched).
    GitWorktree { repo: PathBuf },
}

/// Provisioned working directory for one task.
#[derive(Debug, Clone)]
pub struct Workspace {
    pub dir: PathBuf,
    /// Some for worktree tasks: branch created for review.
    pub branch: Option<String>,
}

async fn git(repo: &Path, args: &[&str]) -> Result<String, IsolationError> {
    let out = Command::new("git")
        .arg("-C")
        .arg(repo)
        .args(args)
        .output()
        .await?;
    if !out.status.success() {
        return Err(IsolationError::Git {
            cmd: format!("git -C {} {}", repo.display(), args.join(" ")),
            message: String::from_utf8_lossy(&out.stderr).trim().to_string(),
        });
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// Prepare the working directory for a task.
pub async fn prepare(iso: &Isolation, task_id: &str) -> Result<Workspace, IsolationError> {
    match iso {
        Isolation::Shared { workspace } => Ok(Workspace {
            dir: workspace.clone(),
            branch: None,
        }),
        Isolation::GitWorktree { repo } => {
            let branch = format!("yuppy/task-{task_id}");
            let stamp = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos();
            let dir = std::env::temp_dir()
                .join("yuppy-worktrees")
                .join(format!("{task_id}-{}-{stamp}", std::process::id()));
            if let Some(parent) = dir.parent() {
                std::fs::create_dir_all(parent)?;
            }
            // -B: recreate the branch if a previous run left one.
            git(
                repo,
                &[
                    "worktree",
                    "add",
                    "-B",
                    &branch,
                    &dir.to_string_lossy(),
                    "HEAD",
                ],
            )
            .await?;
            Ok(Workspace {
                dir,
                branch: Some(branch),
            })
        }
    }
}

/// What a worktree task produced, staged for human review.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Integration {
    pub branch: String,
    pub worktree: PathBuf,
    pub changed_files: Vec<String>,
    /// True when changes were committed to `branch` for review.
    pub committed: bool,
}

/// Inspect (and optionally commit) what the task changed. Never merges.
pub async fn collect(ws: &Workspace, commit_message: &str) -> Result<Integration, IsolationError> {
    let branch = ws
        .branch
        .clone()
        .unwrap_or_else(|| "HEAD (shared workspace)".into());
    // `-z` is not a style preference: NUL-terminated records are the only
    // porcelain form that prints paths verbatim. Line-based output quotes every
    // path with a space or a non-ASCII byte (`"notes taslak.txt"`), which the
    // old character-strip reader turned into `"EADME.md`-shaped garbage — and a
    // review artifact naming a file that does not exist is worse than none,
    // because both the overlap report and the integration agent act on it.
    let status = git(&ws.dir, &["status", "--porcelain", "-z"]).await?;
    let changed_files = parse_porcelain_z(&status);
    let mut committed = false;
    if !changed_files.is_empty() {
        git(&ws.dir, &["add", "-A"]).await?;
        git(&ws.dir, &["commit", "-m", commit_message]).await?;
        committed = true;
    }
    Ok(Integration {
        branch,
        worktree: ws.dir.clone(),
        changed_files,
        committed,
    })
}

/// Remove the worktree directory (the review branch is kept).
pub async fn remove_worktree(repo: &Path, ws: &Workspace) -> Result<(), IsolationError> {
    if ws.branch.is_some() {
        let _ = git(
            repo,
            &["worktree", "remove", "--force", &ws.dir.to_string_lossy()],
        )
        .await;
    }
    Ok(())
}

/// Paths from `git status --porcelain -z` output.
///
/// Records are NUL-separated and shaped `XY <space><path>`. A rename or copy
/// is followed by an extra record holding the original path; the changed path
/// that matters for overlap review is the new one, so the origin is consumed
/// and skipped. The status columns are ASCII, so byte slicing is safe here.
pub fn parse_porcelain_z(raw: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut records = raw.split('\0');
    while let Some(record) = records.next() {
        // Shorter than `XY ` + one character: a trailing empty record or
        // truncated output, never a path.
        if record.len() < 4 {
            continue;
        }
        let (status, path) = record.split_at(3);
        if status.starts_with('R') || status.starts_with('C') {
            // Consume the source path that follows a rename/copy entry.
            let _ = records.next();
        }
        out.push(path.to_string());
    }
    out
}

/// Detect two tasks whose change sets touch the same paths — these need
/// a conflict-aware merge review, and nothing here will merge them.
pub fn find_conflicts(items: &[(&str, &[String])]) -> Vec<(String, String, String)> {
    let mut out = Vec::new();
    for (i, (a_id, a_files)) in items.iter().enumerate() {
        for (b_id, b_files) in items.iter().skip(i + 1) {
            for f in a_files.iter().filter(|f| b_files.contains(f)) {
                out.push((a_id.to_string(), b_id.to_string(), f.clone()));
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(tag: &str) -> PathBuf {
        let p = std::env::temp_dir().join(format!("yuppy-iso-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&p);
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    async fn init_repo(dir: &Path) {
        for args in [
            vec!["init", "-q", "."],
            vec!["config", "user.email", "t@t"],
            vec!["config", "user.name", "t"],
        ] {
            git(dir, &args).await.unwrap();
        }
        std::fs::write(dir.join("README.md"), "hello\n").unwrap();
        git(dir, &["add", "-A"]).await.unwrap();
        git(dir, &["commit", "-qm", "seed"]).await.unwrap();
    }

    #[tokio::test]
    async fn worktree_isolates_and_produces_review_branch() {
        let repo = scratch("wt");
        init_repo(&repo).await;
        let ws = prepare(&Isolation::GitWorktree { repo: repo.clone() }, "demo1")
            .await
            .unwrap();
        assert_eq!(ws.branch.as_deref(), Some("yuppy/task-demo1"));
        assert!(
            ws.dir.join("README.md").exists(),
            "worktree has repo content"
        );
        // The worktree checkout must NOT be the main working tree.
        assert_ne!(ws.dir, repo);
        // Simulate a task change.
        std::fs::write(ws.dir.join("feature.rs"), "fn f() {}\n").unwrap();
        let integ = collect(&ws, "task demo1: change").await.unwrap();
        assert_eq!(integ.changed_files, vec!["feature.rs".to_string()]);
        assert!(integ.committed);
        // Committed on the review branch; the main tree is untouched.
        let head = git(&repo, &["status", "--porcelain"]).await.unwrap();
        assert!(head.trim().is_empty(), "main worktree dirty: {head}");
        let log = git(&repo, &["log", "--oneline", "yuppy/task-demo1", "-1"])
            .await
            .unwrap();
        assert!(log.contains("task demo1"), "{log}");
        remove_worktree(&repo, &ws).await.unwrap();
        // A removed worktree directory must not stay behind in /tmp either.
        let _ = std::fs::remove_dir_all(&ws.dir);
        let _ = std::fs::remove_dir_all(&repo);
    }

    #[tokio::test]
    async fn concurrent_worktrees_never_share_files() {
        let repo = scratch("wt2");
        init_repo(&repo).await;
        let a = prepare(&Isolation::GitWorktree { repo: repo.clone() }, "a")
            .await
            .unwrap();
        let b = prepare(&Isolation::GitWorktree { repo: repo.clone() }, "b")
            .await
            .unwrap();
        assert_ne!(a.dir, b.dir);
        std::fs::write(a.dir.join("shared.txt"), "A").unwrap();
        std::fs::write(b.dir.join("shared.txt"), "B").unwrap();
        // Each worktree sees only its own content.
        assert_eq!(
            std::fs::read_to_string(a.dir.join("shared.txt")).unwrap(),
            "A"
        );
        assert_eq!(
            std::fs::read_to_string(b.dir.join("shared.txt")).unwrap(),
            "B"
        );
        let ia = collect(&a, "task a").await.unwrap();
        let ib = collect(&b, "task b").await.unwrap();
        // Overlap detected explicitly — review workflow, never a merge.
        let conflicts = find_conflicts(&[
            ("a", ia.changed_files.as_slice()),
            ("b", ib.changed_files.as_slice()),
        ]);
        assert_eq!(
            conflicts,
            vec![("a".into(), "b".into(), "shared.txt".into())]
        );
        for ws in [&a, &b] {
            let _ = std::fs::remove_dir_all(&ws.dir);
        }
        let _ = std::fs::remove_dir_all(&repo);
    }

    /// The exact regressions this reader used to ship: a status-letter eaten
    /// from the start of a name, a quoted path kept quoted, a rename reported
    /// as one arrow expression.
    #[test]
    fn porcelain_records_are_paths_not_status_prefixes() {
        let raw = " M README.md\0?? Dockerfile\0?? MANIFEST.in\0 D src/lib.rs\0";
        assert_eq!(
            parse_porcelain_z(raw),
            vec![
                "README.md".to_string(),
                "Dockerfile".to_string(),
                "MANIFEST.in".to_string(),
                "src/lib.rs".to_string(),
            ]
        );
        // Spaces and non-ASCII arrive unquoted with -z, and stay as written.
        assert_eq!(
            parse_porcelain_z("?? notes taslak.txt\0?? Türkçe Açıklama.md\0"),
            vec![
                "notes taslak.txt".to_string(),
                "Türkçe Açıklama.md".to_string(),
            ]
        );
        // A rename contributes its new path; the origin record is consumed.
        assert_eq!(
            parse_porcelain_z("R  DOCS.md\0README.md\0"),
            vec!["DOCS.md".to_string()]
        );
        // Trailing NUL and empty output are not paths.
        assert!(parse_porcelain_z("").is_empty());
        assert!(parse_porcelain_z("\0").is_empty());
    }

    #[test]
    fn conflict_scan_disjoint_is_empty() {
        assert!(find_conflicts(&[("a", &["x".to_string()]), ("b", &["y".to_string()])]).is_empty());
    }
}
