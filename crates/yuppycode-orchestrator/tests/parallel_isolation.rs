//! What several agents editing code *at the same time* leave behind.
//!
//! The parallel path the user actually drives is: one prompt → N role agents
//! → each in its own git worktree → each collected onto a review branch → a
//! human (or an integration agent) told which files which agent touched. Every
//! one of those reports is built from `collect()`'s change set, so a name that
//! arrives mangled is a review artifact pointing at a file that does not exist.

use std::path::{Path, PathBuf};

use yuppycode_orchestrator::isolation::{self, Integration, Isolation};

fn scratch(tag: &str) -> PathBuf {
    let p = std::env::temp_dir().join(format!("yuppy-piso-{tag}-{}", std::process::id()));
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
        git(dir, &args).await;
    }
    // Seed names that also exercise the change-set reader once they are
    // modified or deleted by an agent.
    std::fs::write(dir.join("README.md"), "hello\n").unwrap();
    std::fs::write(dir.join("Dockerfile"), "FROM scratch\n").unwrap();
    std::fs::create_dir_all(dir.join("src")).unwrap();
    std::fs::write(dir.join("src/lib.rs"), "pub fn a() {}\n").unwrap();
    git(dir, &["add", "-A"]).await;
    git(dir, &["commit", "-qm", "seed"]).await;
}

async fn git(repo: &Path, args: &[&str]) -> String {
    let out = tokio::process::Command::new("git")
        .arg("-C")
        .arg(repo)
        .args(args)
        .output()
        .await
        .unwrap();
    assert!(
        out.status.success(),
        "git {args:?} failed: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8_lossy(&out.stdout).into_owned()
}

async fn worktree(repo: &Path, task_id: &str) -> isolation::Workspace {
    isolation::prepare(
        &Isolation::GitWorktree {
            repo: repo.to_path_buf(),
        },
        task_id,
    )
    .await
    .unwrap()
}

fn sorted(mut v: Vec<String>) -> Vec<String> {
    v.sort();
    v
}

/// A change set is only useful if a human can `git diff` the paths in it.
///
/// The bug this guards: the porcelain reader stripped *characters* rather than
/// the two-column status prefix, so every path beginning with R/A/M/D — most
/// famously `README.md`, `Dockerfile`, `MANIFEST.in` — reached the overlap
/// report and the integration prompt with its first letters eaten.
#[tokio::test]
async fn a_change_set_reports_the_paths_a_human_can_open() {
    let repo = scratch("paths");
    init_repo(&repo).await;
    let ws = worktree(&repo, "paths").await;

    // Untracked, modified, deleted, nested, and names whose first letters are
    // themselves porcelain status characters.
    std::fs::write(ws.dir.join("README.md"), "changed by the agent\n").unwrap();
    std::fs::write(ws.dir.join("MANIFEST.in"), "include *\n").unwrap();
    std::fs::write(ws.dir.join("src/Render.cs"), "class C {}\n").unwrap();
    std::fs::remove_file(ws.dir.join("Dockerfile")).unwrap();

    let Integration {
        changed_files,
        committed,
        branch,
        ..
    } = isolation::collect(&ws, "task paths: rename me")
        .await
        .unwrap();

    assert!(committed, "the work must be committed for review");
    assert_eq!(branch, "yuppy/task-paths");
    assert_eq!(
        sorted(changed_files),
        sorted(vec![
            "README.md".into(),
            "MANIFEST.in".into(),
            "src/Render.cs".into(),
            "Dockerfile".into(),
        ]),
        "every path must survive verbatim — the review says nothing about a file \
         that does not exist in the repo"
    );

    isolation::remove_worktree(&repo, &ws).await.unwrap();
    let _ = std::fs::remove_dir_all(&repo);
}

/// Non-ASCII and spaced paths are ordinary in real repositories (and the user
/// types Turkish prompts into this tool).
#[tokio::test]
async fn unicode_and_spaced_paths_are_not_reported_as_octal_escapes() {
    let repo = scratch("unicode");
    init_repo(&repo).await;
    let ws = worktree(&repo, "unicode").await;

    std::fs::write(ws.dir.join("Türkçe Açıklama.md"), "merhaba\n").unwrap();
    std::fs::write(ws.dir.join("notes taslak.txt"), "taslak\n").unwrap();

    let integ = isolation::collect(&ws, "task unicode: names")
        .await
        .unwrap();
    let files = sorted(integ.changed_files);
    assert_eq!(
        files,
        sorted(vec!["Türkçe Açıklama.md".into(), "notes taslak.txt".into()]),
        "got {files:?}"
    );
    for f in &files {
        assert!(
            ws.dir.join(f).exists(),
            "the reported path must exist in the worktree: {f}"
        );
    }

    isolation::remove_worktree(&repo, &ws).await.unwrap();
    let _ = std::fs::remove_dir_all(&repo);
}

/// A rename is one changed path — the new one — not an arrow expression.
#[tokio::test]
async fn a_rename_is_reported_under_its_new_path() {
    let repo = scratch("rename");
    init_repo(&repo).await;
    let ws = worktree(&repo, "rename").await;

    git(&ws.dir, &["mv", "README.md", "DOCS.md"]).await;
    let integ = isolation::collect(&ws, "task rename: move").await.unwrap();

    assert!(
        integ.changed_files.iter().any(|f| f == "DOCS.md"),
        "{:?}",
        integ.changed_files
    );
    assert!(
        !integ.changed_files.iter().any(|f| f.contains("->")),
        "an arrow is not a path: {:?}",
        integ.changed_files
    );

    isolation::remove_worktree(&repo, &ws).await.unwrap();
    let _ = std::fs::remove_dir_all(&repo);
}

/// Four agents from one prompt, all starting at the same instant.
///
/// This is the "/mission" fan-out: admission releases several tasks at once, so
/// `git worktree add` runs concurrently against one repository. Each agent must
/// get its own directory and its own branch, and one agent's commit must never
/// land on another agent's review branch.
#[tokio::test]
async fn agents_started_together_get_separate_worktrees_and_branches() {
    let repo = scratch("fanout");
    init_repo(&repo).await;

    let ids = ["m1-backend", "m1-frontend", "m1-qa", "m1-docs"];
    let jobs = ids.iter().copied().map(|id| {
        let repo = repo.clone();
        tokio::spawn(async move {
            let ws = worktree(&repo, id).await;
            // Each agent writes the same path: the classic collision.
            std::fs::write(ws.dir.join("CHANGELOG.md"), format!("written by {id}\n")).unwrap();
            let integ = isolation::collect(&ws, &format!("task {id}"))
                .await
                .unwrap();
            (ws, integ)
        })
    });
    let mut workspaces = Vec::new();
    let mut integs = Vec::new();
    for j in jobs {
        let (ws, integ) = j.await.unwrap();
        workspaces.push(ws);
        integs.push(integ);
    }

    // Separate directories.
    let dirs: std::collections::HashSet<PathBuf> =
        workspaces.iter().map(|w| w.dir.clone()).collect();
    assert_eq!(
        dirs.len(),
        ids.len(),
        "worktree directories collided: {dirs:?}"
    );

    for ((id, ws), integ) in ids.iter().zip(&workspaces).zip(&integs) {
        assert_eq!(integ.branch, format!("yuppy/task-{id}"));
        assert!(integ.committed, "{id} produced no review commit");
        assert_eq!(integ.changed_files, vec!["CHANGELOG.md".to_string()]);
        assert_eq!(
            std::fs::read_to_string(ws.dir.join("CHANGELOG.md")).unwrap(),
            format!("written by {id}\n"),
            "an agent saw another agent's file"
        );
        // Its review branch carries the seed plus exactly its own work commit,
        // never a sibling's.
        let log = git(&repo, &["log", "--format=%s", &format!("yuppy/task-{id}")]).await;
        let subjects: Vec<&str> = log.lines().collect();
        assert_eq!(subjects.len(), 2, "{id} branch log: {log}");
        assert_eq!(subjects[0], format!("task {id}"), "{id} branch log: {log}");
        assert_eq!(subjects[1], "seed", "{id} branch log: {log}");
    }

    // Same path touched by everyone: reported, never silently merged.
    let refs: Vec<(&str, &[String])> = ids
        .iter()
        .zip(&integs)
        .map(|(id, i)| (*id, i.changed_files.as_slice()))
        .collect();
    let conflicts = isolation::find_conflicts(&refs);
    assert!(
        conflicts
            .iter()
            .all(|(a, b, p)| a != b && p == "CHANGELOG.md"),
        "{conflicts:?}"
    );
    assert_eq!(
        conflicts.len(),
        ids.len() * (ids.len() - 1) / 2,
        "every pair that shares a path must be reported: {conflicts:?}"
    );

    for ws in &workspaces {
        let _ = std::fs::remove_dir_all(&ws.dir);
    }
    git(&repo, &["worktree", "prune"]).await;
    let _ = std::fs::remove_dir_all(&repo);
}

/// The supervisor runs with `keep_worktrees: false`: the first agent to finish
/// deletes its worktree and prunes the shared repository while its teammates
/// are still working. A prune must never reach into a live teammate's tree.
#[tokio::test]
async fn an_agent_finishing_early_leaves_its_running_teammates_usable() {
    let repo = scratch("prune");
    init_repo(&repo).await;

    let slow = vec![
        worktree(&repo, "slow-a").await,
        worktree(&repo, "slow-b").await,
    ];
    let finishing = worktree(&repo, "finishing").await;
    std::fs::write(finishing.dir.join("done.txt"), "done\n").unwrap();
    let before = isolation::collect(&finishing, "task finishing")
        .await
        .unwrap();
    assert_eq!(before.changed_files, vec!["done.txt".to_string()]);

    // What run_batch does after a shared-workspace-free task on `--no-keep`.
    let _ = std::fs::remove_dir_all(&finishing.dir);
    git(&repo, &["worktree", "prune"]).await;

    for ws in &slow {
        std::fs::write(ws.dir.join("work.rs"), "fn f() {}\n").unwrap();
        let integ = isolation::collect(ws, "task still running").await.unwrap();
        assert_eq!(
            integ.changed_files,
            vec!["work.rs".to_string()],
            "a teammate's worktree stopped working after a peer's prune"
        );
        assert!(integ.committed);
    }

    // The finished agent's review branch survived its own cleanup.
    let log = git(&repo, &["log", "--oneline", "yuppy/task-finishing", "-1"]).await;
    assert!(log.contains("task finishing"), "{log}");

    for ws in &slow {
        let _ = std::fs::remove_dir_all(&ws.dir);
    }
    git(&repo, &["worktree", "prune"]).await;
    let _ = std::fs::remove_dir_all(&repo);
}

/// Nothing in the parallel path may touch the user's own checkout.
#[tokio::test]
async fn parallel_agents_never_touch_the_users_checkout() {
    let repo = scratch("clean");
    init_repo(&repo).await;
    let head_before = git(&repo, &["rev-parse", "HEAD"]).await;
    let branch_before = git(&repo, &["rev-parse", "--abbrev-ref", "HEAD"]).await;

    let a = worktree(&repo, "edge-a").await;
    let b = worktree(&repo, "edge-b").await;
    std::fs::write(a.dir.join("README.md"), "agent a\n").unwrap();
    std::fs::write(b.dir.join("README.md"), "agent b\n").unwrap();
    let _ = isolation::collect(&a, "task edge-a").await.unwrap();
    let _ = isolation::collect(&b, "task edge-b").await.unwrap();

    assert_eq!(git(&repo, &["rev-parse", "HEAD"]).await, head_before);
    assert_eq!(
        git(&repo, &["rev-parse", "--abbrev-ref", "HEAD"]).await,
        branch_before
    );
    assert_eq!(
        std::fs::read_to_string(repo.join("README.md")).unwrap(),
        "hello\n",
        "the user's file was edited"
    );
    let dirty = git(&repo, &["status", "--porcelain"]).await;
    assert!(dirty.trim().is_empty(), "user checkout dirty: {dirty}");

    for ws in [&a, &b] {
        let _ = std::fs::remove_dir_all(&ws.dir);
    }
    git(&repo, &["worktree", "prune"]).await;
    let _ = std::fs::remove_dir_all(&repo);
}
