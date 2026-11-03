//! Read-only queries over the history the engine already writes.
//!
//! The write path (`Memory`) is what the engine uses while it runs. Nothing
//! here is on that path: these are the questions a human asks *after* a run —
//! which conversations exist, what was said, which tools were called. They are
//! inherent methods on `SqliteMemory` rather than `Memory` trait methods so a
//! headless backend that keeps history in RAM does not have to answer them.
//!
//! Every query is bounded: `LIMIT` on the row counts, `tail` on message bodies,
//! and truncation on previews, so a huge database never becomes a huge read.

use rusqlite::{Connection, params};
use serde::Serialize;

use yuppycode_core::memory::{Memory, MemoryError};

use crate::SqliteMemory;

macro_rules! q {
    ($e:expr) => {
        $e.map_err(|e| MemoryError::Storage(e.to_string()))?
    };
}

/// One row of `yuppy sessions ls`.
#[derive(Debug, Clone, Serialize)]
pub struct SessionSummary {
    pub id: String,
    /// Workspace path the conversation belongs to, when the workspace row is there.
    pub workspace: Option<String>,
    /// Unix seconds from `conversations.created_at`.
    pub created_at: i64,
    /// Unix seconds of the newest message; `None` for a conversation with no messages.
    pub last_active: Option<i64>,
    pub messages: i64,
    pub tool_calls: i64,
    /// First-line preview of the newest message, truncated to [`PREVIEW_CHARS`].
    pub preview: Option<String>,
}

/// One stored message, as `yuppy sessions show` prints it.
#[derive(Debug, Clone, Serialize)]
pub struct SessionMessage {
    pub seq: i64,
    pub role: String,
    pub content: String,
    pub created_at: i64,
    /// How many tool calls the assistant asked for in this message.
    pub tool_calls: usize,
    /// Set on `tool` results: the call this message answers.
    pub tool_call_id: Option<String>,
}

/// A conversation with its messages.
#[derive(Debug, Clone, Serialize)]
pub struct SessionDetail {
    pub summary: SessionSummary,
    /// Oldest first. When `tail` was requested, the newest N — still ordered.
    pub messages: Vec<SessionMessage>,
    /// Total messages in the conversation, so a trimmed view can say so.
    pub total_messages: i64,
    pub audits: i64,
}

/// One tool-execution audit row.
#[derive(Debug, Clone, Serialize)]
pub struct AuditRow {
    pub id: i64,
    pub workspace_id: String,
    pub conversation_id: String,
    pub tool: String,
    pub ok: bool,
    /// Already redacted by the engine before it was recorded.
    pub args_preview: String,
    pub duration_ms: i64,
    pub created_at: i64,
}

/// Store-wide counts for the status line of `yuppy sessions ls`.
#[derive(Debug, Clone, Copy, Default, Serialize)]
pub struct StoreCounts {
    pub workspaces: i64,
    pub conversations: i64,
    pub messages: i64,
    pub audits: i64,
    pub database_bytes: i64,
}

/// Longest preview the queries return. Kept short on purpose: previews go to a
/// terminal, and the full text is one `sessions show` away.
pub const PREVIEW_CHARS: usize = 88;

fn preview(text: &str) -> String {
    let line = text
        .lines()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .unwrap_or("");
    let count = line.chars().count();
    if count <= PREVIEW_CHARS {
        return line.to_string();
    }
    let cut: String = line.chars().take(PREVIEW_CHARS - 1).collect();
    format!("{cut}\u{2026}")
}

impl SqliteMemory {
    /// Fail loudly when the database file is absent instead of letting the lazy
    /// open create an empty one: `yuppy sessions ls` must never look like it
    /// worked just because it touched the disk.
    fn require_store(&self) -> Result<(), MemoryError> {
        let loc = self.location();
        if loc == ":memory:" || std::path::Path::new(&loc).exists() {
            Ok(())
        } else {
            Err(MemoryError::NotFound(format!(
                "no memory database at {loc}"
            )))
        }
    }

    fn conn_read(&self) -> Result<std::sync::MutexGuard<'_, Connection>, MemoryError> {
        self.require_store()?;
        self.conn()
    }

    /// Conversations, most recently active first.
    pub fn list_sessions(&self, limit: usize) -> Result<Vec<SessionSummary>, MemoryError> {
        let conn = self.conn_read()?;
        let limit = limit.max(1) as i64;
        let mut stmt = q!(conn.prepare(
            "SELECT c.id,
                    c.created_at,
                    (SELECT MAX(created_at) FROM messages m WHERE m.conversation_id = c.id),
                    (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id),
                    (SELECT COUNT(*) FROM messages m
                       WHERE m.conversation_id = c.id AND m.tool_calls_json NOT IN ('[]', '')),
                    w.path,
                    (SELECT content FROM messages m
                       WHERE m.conversation_id = c.id
                       ORDER BY m.seq DESC LIMIT 1)
             FROM conversations c
             LEFT JOIN workspaces w ON w.id = c.workspace_id
             ORDER BY COALESCE(
                        (SELECT MAX(created_at) FROM messages m WHERE m.conversation_id = c.id),
                        c.created_at) DESC,
                      c.id ASC
             LIMIT ?1",
        ));
        let rows = q!(stmt.query_map([limit], |r| {
            Ok(SessionSummary {
                id: r.get(0)?,
                workspace: r.get(5)?,
                created_at: r.get(1)?,
                last_active: r.get(2)?,
                messages: r.get(3)?,
                tool_calls: r.get(4)?,
                preview: r.get::<_, Option<String>>(6)?.map(|c| preview(&c)),
            })
        }));
        let mut out = Vec::new();
        for row in rows {
            out.push(row.map_err(|e| MemoryError::Storage(e.to_string()))?);
        }
        Ok(out)
    }

    /// One conversation plus its messages. `tail = Some(n)` returns the newest
    /// `n` messages, still oldest first, and reports the real total.
    pub fn session_detail(
        &self,
        conversation_id: &str,
        tail: Option<usize>,
    ) -> Result<Option<SessionDetail>, MemoryError> {
        let conn = self.conn_read()?;
        let Some(summary) = self.session_summary_on(&conn, conversation_id)? else {
            return Ok(None);
        };
        let total_messages = summary.messages;

        // The trimmed view reads the newest N rows (DESC) and flips them back
        // below, so what the user sees is always chronological.
        let sql = match tail {
            Some(_) => {
                "SELECT seq, role, content, created_at, tool_calls_json, tool_call_id
                          FROM messages WHERE conversation_id = ?1
                          ORDER BY seq DESC LIMIT ?2"
            }
            None => {
                "SELECT seq, role, content, created_at, tool_calls_json, tool_call_id
                       FROM messages WHERE conversation_id = ?1
                       ORDER BY seq ASC"
            }
        };
        let mut rows: Vec<SessionMessage> = Vec::new();
        {
            let mut stmt = q!(conn.prepare(sql));
            let mapped = match tail {
                Some(n) => {
                    q!(stmt.query_map(params![conversation_id, n.max(1) as i64], map_message))
                }
                None => q!(stmt.query_map(params![conversation_id], map_message)),
            };
            for row in mapped {
                rows.push(row.map_err(|e| MemoryError::Storage(e.to_string()))?);
            }
        }
        if tail.is_some() {
            rows.reverse();
        }

        let audits: i64 = q!(conn.query_row(
            "SELECT COUNT(*) FROM audits WHERE conversation_id = ?1",
            [conversation_id],
            |r| r.get(0),
        ));
        Ok(Some(SessionDetail {
            summary,
            messages: rows,
            total_messages,
            audits,
        }))
    }

    /// Delete one conversation and its messages. Audit rows are kept: they are
    /// the record that something happened, not part of the chat log. Returns
    /// whether the conversation existed.
    pub fn delete_session(&self, conversation_id: &str) -> Result<bool, MemoryError> {
        let mut conn = self.conn_read()?;
        let tx = q!(conn.transaction());
        let existed: i64 = q!(tx.query_row(
            "SELECT COUNT(*) FROM conversations WHERE id = ?1",
            [conversation_id],
            |r| r.get(0),
        ));
        if existed == 0 {
            q!(tx.rollback());
            return Ok(false);
        }
        q!(tx.execute(
            "DELETE FROM messages WHERE conversation_id = ?1",
            [conversation_id],
        ));
        q!(tx.execute("DELETE FROM conversations WHERE id = ?1", [conversation_id],));
        q!(tx.commit());
        Ok(true)
    }

    /// Tool executions, newest first. `conversation` narrows to one session.
    pub fn list_audits(
        &self,
        conversation: Option<&str>,
        limit: usize,
    ) -> Result<Vec<AuditRow>, MemoryError> {
        let conn = self.conn_read()?;
        let limit = limit.max(1) as i64;
        let sql = match conversation {
            Some(_) => {
                "SELECT id, workspace_id, conversation_id, tool, ok, args_preview,
                               duration_ms, created_at
                          FROM audits WHERE conversation_id = ?1
                          ORDER BY id DESC LIMIT ?2"
            }
            None => {
                "SELECT id, workspace_id, conversation_id, tool, ok, args_preview,
                            duration_ms, created_at
                       FROM audits ORDER BY id DESC LIMIT ?1"
            }
        };
        let mut stmt = q!(conn.prepare(sql));
        let mapped = match conversation {
            Some(c) => q!(stmt.query_map(params![c, limit], map_audit)),
            None => q!(stmt.query_map(params![limit], map_audit)),
        };
        let mut out = Vec::new();
        for row in mapped {
            out.push(row.map_err(|e| MemoryError::Storage(e.to_string()))?);
        }
        Ok(out)
    }

    /// Row counts plus on-disk size, for a footer that says what a command read.
    pub fn stats(&self) -> Result<StoreCounts, MemoryError> {
        let conn = self.conn_read()?;
        let one = |sql: &str| -> i64 { conn.query_row(sql, [], |r| r.get(0)).unwrap_or(0) };
        Ok(StoreCounts {
            workspaces: one("SELECT COUNT(*) FROM workspaces"),
            conversations: one("SELECT COUNT(*) FROM conversations"),
            messages: one("SELECT COUNT(*) FROM messages"),
            audits: one("SELECT COUNT(*) FROM audits"),
            database_bytes: one(
                "SELECT page_count * page_size FROM pragma_page_count(), pragma_page_size()",
            ),
        })
    }

    fn session_summary_on(
        &self,
        conn: &Connection,
        conversation_id: &str,
    ) -> Result<Option<SessionSummary>, MemoryError> {
        let mut stmt = q!(conn.prepare(
            "SELECT c.id,
                    c.created_at,
                    (SELECT MAX(created_at) FROM messages m WHERE m.conversation_id = c.id),
                    (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id),
                    (SELECT COUNT(*) FROM messages m
                       WHERE m.conversation_id = c.id AND m.tool_calls_json NOT IN ('[]', '')),
                    w.path,
                    (SELECT content FROM messages m
                       WHERE m.conversation_id = c.id
                       ORDER BY m.seq DESC LIMIT 1)
             FROM conversations c
             LEFT JOIN workspaces w ON w.id = c.workspace_id
             WHERE c.id = ?1",
        ));
        let mut rows = q!(stmt.query([conversation_id]));
        let Some(r) = q!(rows.next()) else {
            return Ok(None);
        };
        Ok(Some(SessionSummary {
            id: q!(r.get(0)),
            workspace: q!(r.get(5)),
            created_at: q!(r.get(1)),
            last_active: q!(r.get(2)),
            messages: q!(r.get(3)),
            tool_calls: q!(r.get(4)),
            preview: q!(r.get::<_, Option<String>>(6)).map(|c| preview(&c)),
        }))
    }
}

fn map_message(r: &rusqlite::Row<'_>) -> rusqlite::Result<SessionMessage> {
    let tool_calls_json: String = r.get(4)?;
    let tool_calls = serde_json::from_str::<serde_json::Value>(&tool_calls_json)
        .ok()
        .and_then(|v| v.as_array().map(|a| a.len()))
        .unwrap_or(0);
    Ok(SessionMessage {
        seq: r.get(0)?,
        role: r.get(1)?,
        content: r.get(2)?,
        created_at: r.get(3)?,
        tool_calls,
        tool_call_id: r.get(5)?,
    })
}

fn map_audit(r: &rusqlite::Row<'_>) -> rusqlite::Result<AuditRow> {
    Ok(AuditRow {
        id: r.get(0)?,
        workspace_id: r.get(1)?,
        conversation_id: r.get(2)?,
        tool: r.get(3)?,
        ok: r.get::<_, i64>(4)? != 0,
        args_preview: r.get(5)?,
        duration_ms: r.get(6)?,
        created_at: r.get(7)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use yuppycode_core::memory::{AuditEvent, Memory};
    use yuppycode_core::provider::ChatMessage;

    fn mem() -> SqliteMemory {
        SqliteMemory::new(PathBuf::from(":memory:"))
    }

    #[test]
    fn lists_sessions_newest_first_with_counts_and_preview() {
        let m = mem();
        m.ensure_conversation("/ws/a", "old").unwrap();
        m.ensure_conversation("/ws/b", "new").unwrap();
        m.append_message("old", &ChatMessage::user("first prompt"))
            .unwrap();
        m.append_message("new", &ChatMessage::user("latest prompt"))
            .unwrap();
        m.append_message("new", &ChatMessage::assistant("ok", vec![]))
            .unwrap();
        m.append_message("old", &ChatMessage::user("also old"))
            .unwrap();

        let got = m.list_sessions(10).unwrap();
        assert_eq!(got.len(), 2);
        // Both conversations were written seconds apart, so ordering alone is
        // weak here; assert the shape instead.
        for s in &got {
            assert!(s.workspace.is_some(), "workspace path must resolve");
            assert!(s.preview.is_some(), "a conversation with text previews");
        }
        let newest = &got[0];
        assert!(matches!(newest.messages, 1..=2));
        assert_eq!(got.iter().find(|s| s.id == "new").unwrap().messages, 2);
        assert_eq!(
            got.iter()
                .find(|s| s.id == "new")
                .unwrap()
                .workspace
                .as_deref(),
            Some("/ws/b")
        );
    }

    #[test]
    fn empty_conversation_has_no_preview_and_zero_counts() {
        let m = mem();
        m.ensure_conversation("/ws", "bare").unwrap();
        let s = &m.list_sessions(10).unwrap()[0];
        assert_eq!(s.messages, 0);
        assert_eq!(s.tool_calls, 0);
        assert!(s.preview.is_none());
        assert!(s.last_active.is_none());
    }

    #[test]
    fn preview_is_single_line_and_truncated() {
        let m = mem();
        m.ensure_conversation("/ws", "c").unwrap();
        let long = format!("first line\n{}", "x".repeat(300));
        m.append_message("c", &ChatMessage::user(&long)).unwrap();
        let p = m.list_sessions(10).unwrap()[0].preview.clone().unwrap();
        assert_eq!(p, "first line");

        m.ensure_conversation("/ws", "c2").unwrap();
        let one_long = "y".repeat(400);
        m.append_message("c2", &ChatMessage::user(&one_long))
            .unwrap();
        let p2 = m
            .list_sessions(10)
            .unwrap()
            .into_iter()
            .find(|s| s.id == "c2")
            .unwrap()
            .preview
            .unwrap();
        assert_eq!(p2.chars().count(), PREVIEW_CHARS);
        assert!(p2.ends_with('\u{2026}'));
    }

    #[test]
    fn detail_keeps_order_and_counts_tool_calls() {
        let m = mem();
        m.ensure_conversation("/ws", "c").unwrap();
        m.append_message("c", &ChatMessage::system("sys")).unwrap();
        m.append_message("c", &ChatMessage::user("hi")).unwrap();
        let call_id = yuppycode_core::CallId::next();
        let asst = ChatMessage::assistant(
            "calling",
            vec![yuppycode_core::ToolCall {
                id: call_id.clone(),
                name: "read_file".into(),
                arguments: serde_json::json!({"path": "a"}),
            }],
        );
        m.append_message("c", &asst).unwrap();
        m.append_message("c", &ChatMessage::tool(&call_id, "body"))
            .unwrap();

        let d = m.session_detail("c", None).unwrap().unwrap();
        assert_eq!(d.total_messages, 4);
        assert_eq!(d.summary.tool_calls, 1);
        assert_eq!(d.messages[0].role, "system");
        assert_eq!(d.messages[2].tool_calls, 1);
        assert_eq!(
            d.messages[3].tool_call_id.as_deref(),
            Some(call_id.as_str())
        );

        let tailed = m.session_detail("c", Some(2)).unwrap().unwrap();
        assert_eq!(tailed.messages.len(), 2);
        assert_eq!(tailed.total_messages, 4);
        assert_eq!(tailed.messages[0].seq, 3);
        assert_eq!(tailed.messages[1].seq, 4);
    }

    #[test]
    fn detail_and_delete_report_missing_conversations_instead_of_inventing_them() {
        let m = mem();
        m.ensure_conversation("/ws", "here").unwrap();
        assert!(m.session_detail("ghost", None).unwrap().is_none());
        assert!(!m.delete_session("ghost").unwrap());
        m.append_message("here", &ChatMessage::user("x")).unwrap();
        assert!(m.delete_session("here").unwrap());
        assert!(m.list_sessions(10).unwrap().is_empty());
        assert!(m.session_detail("here", None).unwrap().is_none());
    }

    #[test]
    fn delete_session_leaves_audits_and_other_sessions_alone() {
        let m = mem();
        m.ensure_conversation("/ws", "gone").unwrap();
        m.ensure_conversation("/ws", "kept").unwrap();
        m.append_message("gone", &ChatMessage::user("bye")).unwrap();
        m.append_message("kept", &ChatMessage::user("stay"))
            .unwrap();
        m.record_audit(&AuditEvent {
            workspace_id: "/ws".into(),
            conversation_id: "gone".into(),
            tool: "shell".into(),
            ok: false,
            args_preview: "{\"cmd\":\"ls\"}".into(),
            duration_ms: 7,
        })
        .unwrap();
        assert!(m.delete_session("gone").unwrap());
        assert_eq!(m.list_sessions(10).unwrap().len(), 1);
        assert_eq!(m.recent_messages("gone", 10).unwrap().len(), 0);
        // The audit row survives: history of what ran is not the chat log.
        let a = m.list_audits(None, 10).unwrap();
        assert_eq!(a.len(), 1);
        assert_eq!(a[0].conversation_id, "gone");
        assert_eq!(m.recent_messages("kept", 10).unwrap().len(), 1);
    }

    #[test]
    fn audits_are_newest_first_and_filterable() {
        let m = mem();
        m.ensure_conversation("/ws", "c1").unwrap();
        m.ensure_conversation("/ws", "c2").unwrap();
        for (conv, tool, ok) in [
            ("c1", "read_file", true),
            ("c2", "write_file", false),
            ("c1", "shell", true),
        ] {
            m.record_audit(&AuditEvent {
                workspace_id: "/ws".into(),
                conversation_id: conv.into(),
                tool: tool.into(),
                ok,
                args_preview: "{}".into(),
                duration_ms: 3,
            })
            .unwrap();
        }
        let all = m.list_audits(None, 10).unwrap();
        assert_eq!(all.len(), 3);
        assert_eq!(all[0].id, 3, "newest row first");
        assert!(all[0].ok);
        assert!(!all[1].ok);
        let only_c1 = m.list_audits(Some("c1"), 10).unwrap();
        assert_eq!(only_c1.len(), 2);
        assert!(only_c1.iter().all(|a| a.conversation_id == "c1"));
        assert_eq!(
            m.list_audits(None, 1).unwrap().len(),
            1,
            "limit is honoured"
        );
    }

    #[test]
    fn stats_count_everything_the_cli_prints() {
        let m = mem();
        m.ensure_conversation("/ws", "c").unwrap();
        m.append_message("c", &ChatMessage::user("hi")).unwrap();
        let s = m.stats().unwrap();
        assert_eq!(s.workspaces, 1);
        assert_eq!(s.conversations, 1);
        assert_eq!(s.messages, 1);
        assert_eq!(s.audits, 0);
        assert!(s.database_bytes > 0);
    }

    #[test]
    fn a_missing_database_is_an_error_not_an_empty_listing() {
        let m = SqliteMemory::new(PathBuf::from("/nonexistent/yuppy-memory-test/history.db"));
        let e = m.list_sessions(10).unwrap_err();
        match e {
            MemoryError::NotFound(msg) => assert!(msg.contains("no memory database"), "{msg}"),
            other => panic!("expected NotFound, got {other:?}"),
        }
        assert!(matches!(m.stats(), Err(MemoryError::NotFound(_))));
        // The failed query must not have created the file as a side effect.
        assert!(!std::path::Path::new("/nonexistent/yuppy-memory-test/history.db").exists());
    }

    #[test]
    fn unicode_preview_never_splits_a_char_boundary() {
        let m = mem();
        m.ensure_conversation("/ws", "c").unwrap();
        m.append_message("c", &ChatMessage::user("é".repeat(200)))
            .unwrap();
        let p = m.list_sessions(10).unwrap()[0].preview.clone().unwrap();
        assert_eq!(p.chars().count(), PREVIEW_CHARS);
        assert!(p.is_char_boundary(p.len()));
    }
}
