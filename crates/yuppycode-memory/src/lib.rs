//! SQLite-backed workspace memory.
//!
//! All access is synchronous (rusqlite). The engine calls these methods from
//! its own task, not the rendering loop, so brief locks are acceptable for
//! Phase 1. Heavy queries are bounded by LIMIT / token budgets.

use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

use rusqlite::{Connection, params};

use yuppycode_core::memory::{AuditEvent, Memory, MemoryError, PruneStats};
use yuppycode_core::provider::{ChatMessage, Role};

mod query;
pub use query::{
    AuditRow, PREVIEW_CHARS, SessionDetail, SessionMessage, SessionSummary, StoreCounts,
};

/// Persistent workspace memory with lazy, one-time database open.
macro_rules! sql {
    ($e:expr) => {
        $e.map_err(|e| MemoryError::Storage(e.to_string()))?
    };
}

pub struct SqliteMemory {
    path: PathBuf,
    conn: OnceLock<Mutex<Connection>>,
}

impl SqliteMemory {
    pub fn new(path: PathBuf) -> Self {
        Self {
            path,
            conn: OnceLock::new(),
        }
    }

    fn conn(&self) -> Result<std::sync::MutexGuard<'_, Connection>, MemoryError> {
        let mutex = self.conn.get_or_init(|| {
            let mut conn = Connection::open(&self.path).expect("open SQLite");
            Self::migrate(&mut conn).expect("migrate");
            Mutex::new(conn)
        });
        mutex
            .lock()
            .map_err(|e| MemoryError::Storage(format!("lock poison: {e}")))
    }

    /// Bring an existing database up to `SCHEMA_VERSION`.
    ///
    /// Runs on every open, so it has to be idempotent for a file that was
    /// already migrated — by an earlier process, or by an earlier run days ago.
    /// The marker is one row that gets replaced, never `UPDATE`d: an `UPDATE`
    /// across a table that somehow holds more than one row collapses onto the
    /// primary key and aborts the open (which is what it used to do).
    fn migrate(conn: &mut Connection) -> rusqlite::Result<()> {
        conn.execute(
            "CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY)",
            [],
        )?;
        // An empty marker table *is* version 0; seeding a row there would put a
        // stale 0 next to the real marker on every later open.
        let version: i64 = conn.query_row(
            "SELECT COALESCE(MAX(version), 0) FROM schema_version",
            [],
            |r| r.get(0),
        )?;
        if version < SCHEMA_VERSION {
            if version < 1 {
                conn.execute_batch(V1_SCHEMA)?;
            }
            let tx = conn.transaction()?;
            tx.execute("DELETE FROM schema_version", [])?;
            tx.execute(
                "INSERT INTO schema_version (version) VALUES (?1)",
                [SCHEMA_VERSION],
            )?;
            tx.commit()?;
        }
        // Future migrations: if version < 2 { ... }
        Ok(())
    }
}

/// Schema this build of the crate expects; `migrate` converges on it.
const SCHEMA_VERSION: i64 = 1;

const V1_SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS workspaces (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    path TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);
CREATE INDEX IF NOT EXISTS idx_workspaces_path ON workspaces(path);

CREATE TABLE IF NOT EXISTS conversations (
    id TEXT PRIMARY KEY,
    workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);

CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    tool_calls_json TEXT NOT NULL DEFAULT '[]',
    tool_call_id TEXT,
    seq INTEGER NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);
CREATE INDEX IF NOT EXISTS idx_messages_conversation_seq ON messages(conversation_id, seq);

CREATE TABLE IF NOT EXISTS audits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workspace_id TEXT NOT NULL,
    conversation_id TEXT NOT NULL,
    tool TEXT NOT NULL,
    ok INTEGER NOT NULL,
    args_preview TEXT NOT NULL,
    duration_ms INTEGER NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);
CREATE INDEX IF NOT EXISTS idx_audits_workspace ON audits(workspace_id, created_at);

CREATE TABLE IF NOT EXISTS preferences (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    UNIQUE(workspace_id, key)
);
"#;

impl Memory for SqliteMemory {
    fn ensure_conversation(
        &self,
        workspace_path: &str,
        conversation_id: &str,
    ) -> Result<(), MemoryError> {
        let conn = self.conn()?;
        sql!(conn.execute(
            "INSERT OR IGNORE INTO workspaces (path) VALUES (?1)",
            [workspace_path],
        ));
        let ws_id: i64 = sql!(conn.query_row(
            "SELECT id FROM workspaces WHERE path = ?1",
            [workspace_path],
            |r| r.get(0),
        ));
        sql!(conn.execute(
            "INSERT OR IGNORE INTO conversations (id, workspace_id) VALUES (?1, ?2)",
            [conversation_id, &ws_id.to_string()],
        ));
        Ok(())
    }

    fn append_message(&self, conversation_id: &str, msg: &ChatMessage) -> Result<(), MemoryError> {
        let conn = self.conn()?;
        let next_seq: i64 = sql!(conn.query_row(
            "SELECT COALESCE(MAX(seq), 0) + 1 FROM messages WHERE conversation_id = ?1",
            [conversation_id],
            |r| r.get(0),
        ));
        let tool_calls = serde_json::to_string(&msg.tool_calls)
            .map_err(|e| MemoryError::Storage(format!("serialize tool_calls: {e}")))?;
        sql!(conn.execute(
            "INSERT INTO messages (conversation_id, role, content, tool_calls_json, tool_call_id, seq) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                conversation_id,
                role_to_str(msg.role),
                msg.content,
                tool_calls,
                msg.tool_call_id.as_deref(),
                next_seq
            ],
        ));
        Ok(())
    }

    fn recent_messages(
        &self,
        conversation_id: &str,
        limit: usize,
    ) -> Result<Vec<ChatMessage>, MemoryError> {
        let conn = self.conn()?;
        let mut stmt = sql!(conn.prepare(
            "SELECT role, content, tool_calls_json, tool_call_id FROM messages WHERE conversation_id = ?1 ORDER BY seq ASC LIMIT ?2",
        ));
        let rows = stmt
            .query_map(params![conversation_id, limit as i64], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, Option<String>>(3)?,
                ))
            })
            .map_err(|e| MemoryError::Storage(e.to_string()))?;
        let mut out = Vec::new();
        for row in rows {
            let (role, content, tc_json, tc_id) =
                row.map_err(|e| MemoryError::Storage(e.to_string()))?;
            out.push(deserialize_message(role, content, tc_json, tc_id)?);
        }
        Ok(out)
    }

    fn prune_to_budget(
        &self,
        conversation_id: &str,
        budget_tokens: usize,
    ) -> Result<PruneStats, MemoryError> {
        let mut conn = self.conn()?;
        let tx = sql!(conn.transaction());

        let mut stmt = sql!(tx.prepare(
            "SELECT id, role, content, tool_calls_json, tool_call_id FROM messages WHERE conversation_id = ?1 ORDER BY seq ASC",
        ));
        let rows = stmt
            .query_map([conversation_id], |r| {
                Ok((
                    r.get::<_, i64>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, String>(3)?,
                    r.get::<_, Option<String>>(4)?,
                ))
            })
            .map_err(|e| MemoryError::Storage(e.to_string()))?;
        let mut messages: Vec<(i64, ChatMessage)> = Vec::new();
        for row in rows {
            let (id, role, content, tc_json, tc_id) =
                row.map_err(|e| MemoryError::Storage(e.to_string()))?;
            messages.push((id, deserialize_message(role, content, tc_json, tc_id)?));
        }
        drop(stmt);

        let tokens_before: usize = messages.iter().map(|(_, m)| m.approx_tokens()).sum();

        let total = messages.len();
        let mut keep_mask: Vec<bool> = Vec::with_capacity(total);
        let mut running: usize = 0;
        for (i, (_, m)) in messages.iter().enumerate() {
            let essential = is_essential(m, i, total);
            let t = m.approx_tokens();
            let fits = essential || running + t <= budget_tokens;
            if fits {
                running += t;
            }
            keep_mask.push(fits);
        }

        let mut removed: Vec<i64> = Vec::new();
        let mut removed_summaries: Vec<String> = Vec::new();
        for ((id, m), keep) in messages.iter().zip(&keep_mask) {
            if !keep {
                removed.push(*id);
                removed_summaries.push(format!(
                    "[{}] {}",
                    role_to_str(m.role),
                    yuppycode_core::tools::summarize(&m.content)
                ));
            }
        }

        let removed_count = removed.len();
        if removed_count > 0 {
            let summary = format!(
                "[SUMMARY] {} earlier message(s) were pruned to stay within the token budget:\n{}",
                removed_count,
                removed_summaries.join("\n")
            );
            // Insert the digest as a system message at the boundary of removal.
            let next_seq: i64 = sql!(tx.query_row(
                "SELECT COALESCE(MAX(seq), 0) + 1 FROM messages WHERE conversation_id = ?1",
                [conversation_id],
                |r| r.get(0),
            ));
            sql!(tx.execute(
                "INSERT INTO messages (conversation_id, role, content, tool_calls_json, tool_call_id, seq) VALUES (?1, 'system', ?2, '[]', NULL, ?3)",
                params![conversation_id, summary, next_seq],
            ));
            let placeholders: Vec<String> = removed.iter().map(|_| "?".to_string()).collect();
            let sql = format!(
                "DELETE FROM messages WHERE id IN ({}) AND conversation_id = ?",
                placeholders.join(",")
            );
            let mut params: Vec<&dyn rusqlite::ToSql> = Vec::new();
            for id in &removed {
                params.push(id);
            }
            params.push(&conversation_id);
            sql!(tx.execute(&sql, params.as_slice()));
        }

        sql!(tx.commit());
        let tokens_after: usize = tokens_before
            - removed
                .iter()
                .map(|i| {
                    messages
                        .iter()
                        .find(|(id, _)| id == i)
                        .map(|(_, m)| m.approx_tokens())
                        .unwrap_or(0)
                })
                .sum::<usize>()
            + yuppycode_core::estimate_tokens(&format!(
                "[SUMMARY] {} earlier message(s) were pruned...",
                removed_count
            ));
        Ok(PruneStats {
            removed_messages: removed_count,
            tokens_before,
            tokens_after,
        })
    }

    fn record_audit(&self, event: &AuditEvent) -> Result<(), MemoryError> {
        let conn = self.conn()?;
        sql!(conn.execute(
            "INSERT INTO audits (workspace_id, conversation_id, tool, ok, args_preview, duration_ms) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                event.workspace_id,
                event.conversation_id,
                event.tool,
                if event.ok { 1 } else { 0 },
                event.args_preview,
                event.duration_ms as i64
            ],
        ));
        Ok(())
    }

    fn get_preference(
        &self,
        workspace_path: &str,
        key: &str,
    ) -> Result<Option<String>, MemoryError> {
        let conn = self.conn()?;
        let mut stmt = sql!(conn.prepare(
            "SELECT p.value FROM preferences p JOIN workspaces w ON p.workspace_id = w.id WHERE w.path = ?1 AND p.key = ?2",
        ));
        let mut rows = sql!(stmt.query(params![workspace_path, key]));
        if let Some(row) = sql!(rows.next()) {
            Ok(Some(sql!(row.get(0))))
        } else {
            Ok(None)
        }
    }

    fn set_preference(
        &self,
        workspace_path: &str,
        key: &str,
        value: &str,
    ) -> Result<(), MemoryError> {
        let conn = self.conn()?;
        sql!(conn.execute(
            "INSERT OR IGNORE INTO workspaces (path) VALUES (?1)",
            [workspace_path],
        ));
        let ws_id: i64 = sql!(conn.query_row(
            "SELECT id FROM workspaces WHERE path = ?1",
            [workspace_path],
            |r| r.get(0),
        ));
        sql!(conn.execute(
            "INSERT INTO preferences (workspace_id, key, value) VALUES (?1, ?2, ?3) ON CONFLICT(workspace_id, key) DO UPDATE SET value = excluded.value",
            params![ws_id, key, value],
        ));
        Ok(())
    }

    fn delete_workspace(&self, workspace_path: &str) -> Result<(), MemoryError> {
        let conn = self.conn()?;
        sql!(conn.execute("DELETE FROM workspaces WHERE path = ?1", [workspace_path]));
        Ok(())
    }

    fn location(&self) -> String {
        self.path.display().to_string()
    }
}

fn role_to_str(role: Role) -> &'static str {
    match role {
        Role::System => "system",
        Role::User => "user",
        Role::Assistant => "assistant",
        Role::Tool => "tool",
    }
}

fn str_to_role(s: &str) -> Option<Role> {
    Some(match s {
        "system" => Role::System,
        "user" => Role::User,
        "assistant" => Role::Assistant,
        "tool" => Role::Tool,
        _ => return None,
    })
}

fn deserialize_message(
    role: String,
    content: String,
    tc_json: String,
    tc_id: Option<String>,
) -> Result<ChatMessage, MemoryError> {
    let role =
        str_to_role(&role).ok_or_else(|| MemoryError::Storage(format!("bad role: {role}")))?;
    let tool_calls: Vec<yuppycode_core::ToolCall> = serde_json::from_str(&tc_json)
        .map_err(|e| MemoryError::Storage(format!("bad tool_calls JSON: {e}")))?;
    Ok(ChatMessage {
        role,
        content,
        tool_calls,
        tool_call_id: tc_id,
    })
}

fn is_essential(msg: &ChatMessage, index: usize, total: usize) -> bool {
    if msg.role == Role::System {
        return true;
    }
    if msg.content.starts_with("[ACTIVE-TASK]") {
        return true;
    }
    // Always keep the most recent two exchanges (roughly last 4 messages).
    if index + 4 >= total {
        return true;
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mem() -> SqliteMemory {
        SqliteMemory::new(PathBuf::from(":memory:"))
    }

    #[test]
    fn roundtrip_messages() {
        let m = mem();
        m.ensure_conversation("/ws", "c1").unwrap();
        m.append_message("c1", &ChatMessage::system("sys")).unwrap();
        m.append_message("c1", &ChatMessage::user("hi")).unwrap();
        let got = m.recent_messages("c1", 10).unwrap();
        assert_eq!(got.len(), 2);
        assert_eq!(got[0].content, "sys");
        assert_eq!(got[1].role, Role::User);
    }

    #[test]
    fn prune_keeps_system_and_recent() {
        let m = mem();
        m.ensure_conversation("/ws", "c1").unwrap();
        m.append_message("c1", &ChatMessage::system("sys")).unwrap();
        for i in 0..10 {
            m.append_message("c1", &ChatMessage::user(format!("msg {i}")))
                .unwrap();
        }
        let stats = m.prune_to_budget("c1", 2).unwrap();
        assert!(stats.removed_messages > 0);
        let kept = m.recent_messages("c1", 100).unwrap();
        assert!(kept.iter().any(|m| m.role == Role::System));
        assert!(kept.iter().any(|m| m.content.starts_with("[SUMMARY]")));
    }

    #[test]
    fn an_existing_database_can_be_opened_again_by_a_new_process() {
        // The engine used to be the only opener, so a file it wrote was never
        // re-migrated. `yuppy sessions` opens yesterday's database, and the old
        // marker update collapsed onto the primary key and panicked the open.
        let dir = std::env::temp_dir().join(format!("yuppy-mem-reopen-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("history.db");
        let _ = std::fs::remove_file(&path);

        {
            let first = SqliteMemory::new(path.clone());
            first.ensure_conversation("/ws", "c1").unwrap();
            first
                .append_message("c1", &ChatMessage::user("hello"))
                .unwrap();
        }
        // A second handle is what a second process is inside this process.
        let second = SqliteMemory::new(path.clone());
        assert_eq!(second.recent_messages("c1", 10).unwrap().len(), 1);
        assert_eq!(second.list_sessions(10).unwrap()[0].id, "c1");
        // And a third, because idempotence must not be a two-time trick.
        let third = SqliteMemory::new(path.clone());
        assert_eq!(third.stats().unwrap().messages, 1);

        // The marker stays exactly one row at the current version.
        let conn = Connection::open(&path).unwrap();
        let rows: i64 = conn
            .query_row("SELECT COUNT(*) FROM schema_version", [], |r| r.get(0))
            .unwrap();
        let version: i64 = conn
            .query_row("SELECT MAX(version) FROM schema_version", [], |r| r.get(0))
            .unwrap();
        assert_eq!(rows, 1, "the version marker must be a single row");
        assert_eq!(version, SCHEMA_VERSION);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_database_marked_at_the_current_version_is_left_alone() {
        // Simulates a file migrated by a future build: nothing here may rewrite
        // the marker or re-run the v1 batch.
        let dir = std::env::temp_dir().join(format!("yuppy-mem-future-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("history.db");
        let _ = std::fs::remove_file(&path);
        {
            let conn = Connection::open(&path).unwrap();
            conn.execute_batch(V1_SCHEMA).unwrap();
            conn.execute(
                "CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY)",
                [],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO schema_version (version) VALUES (?1)",
                [SCHEMA_VERSION + 1],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO workspaces (path) VALUES ('/from-a-future-build')",
                [],
            )
            .unwrap();
        }
        let m = SqliteMemory::new(path.clone());
        assert_eq!(m.stats().unwrap().workspaces, 1);
        let conn = Connection::open(&path).unwrap();
        let version: i64 = conn
            .query_row("SELECT MAX(version) FROM schema_version", [], |r| r.get(0))
            .unwrap();
        assert_eq!(
            version,
            SCHEMA_VERSION + 1,
            "must not downgrade a newer file"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn audit_and_preferences() {
        let m = mem();
        m.ensure_conversation("/ws", "c1").unwrap();
        m.record_audit(&AuditEvent {
            workspace_id: "/ws".into(),
            conversation_id: "c1".into(),
            tool: "read_file".into(),
            ok: true,
            args_preview: "{\"path\":\"a\"}".into(),
            duration_ms: 12,
        })
        .unwrap();
        m.set_preference("/ws", "theme", "dark").unwrap();
        assert_eq!(
            m.get_preference("/ws", "theme").unwrap(),
            Some("dark".into())
        );
        m.delete_workspace("/ws").unwrap();
        assert_eq!(m.get_preference("/ws", "theme").unwrap(), None);
    }
}
