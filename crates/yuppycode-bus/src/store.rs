//! SQLite-backed message bus shared by every agent process.
//!
//! One row per team member, one row per message. Every agent talks to this
//! file through its own process (an MCP child of `claude`/`codex`), so the
//! database is opened in WAL mode with a real busy timeout: concurrent
//! writers wait instead of erroring with `SQLITE_BUSY`.

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};

/// Broadcast recipient: every member's inbox sees the message.
pub const EVERYONE: &str = "*";
/// Name used for the human sitting at the terminal.
pub const HUMAN: &str = "you";

#[derive(Debug, thiserror::Error)]
pub enum BusError {
    #[error("cannot open team bus at {path}: {source}")]
    Open {
        path: PathBuf,
        #[source]
        source: rusqlite::Error,
    },
    #[error("team bus query failed: {0}")]
    Storage(#[from] rusqlite::Error),
    #[error("no team member named {to:?}. on the bus: {known}")]
    UnknownMember { to: String, known: String },
    #[error("message body is empty")]
    EmptyBody,
    #[error("unknown tool {0} (this server exposes the yuppy_* team tools only)")]
    UnknownTool(String),
    #[error("message body is too large ({len} chars, cap {cap})")]
    BodyTooLarge { len: usize, cap: usize },
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or_default()
}

/// One teammate as the bus sees it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Member {
    pub name: String,
    #[serde(default)]
    pub role: String,
    /// Engine id that is running this member ("claude-code", "codex", "human").
    #[serde(default)]
    pub engine: String,
    /// Mission task id this member is working on, when any.
    #[serde(default)]
    pub task_id: String,
    /// `idle`, `working`, `waiting`, `done`, `gone`.
    pub status: String,
    pub joined_at: i64,
    pub last_seen: i64,
    pub unread: i64,
}

/// One delivered message.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Message {
    pub id: i64,
    pub thread: String,
    pub sender: String,
    pub recipient: String,
    pub body: String,
    pub ts: i64,
}

/// What a caller asks the bus to deliver.
#[derive(Debug, Clone, Default)]
pub struct Outgoing {
    pub sender: String,
    /// A member name, or [`EVERYONE`].
    pub to: String,
    pub body: String,
    pub thread: Option<String>,
}

/// Join/update request for a member row.
#[derive(Debug, Clone)]
pub struct JoinRequest {
    pub name: String,
    pub role: String,
    pub engine: String,
    pub task_id: String,
}

const V1_SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS team (
    name       TEXT PRIMARY KEY,
    role       TEXT NOT NULL DEFAULT '',
    engine     TEXT NOT NULL DEFAULT '',
    task_id    TEXT NOT NULL DEFAULT '',
    status     TEXT NOT NULL DEFAULT 'idle',
    joined_at  INTEGER NOT NULL,
    last_seen  INTEGER NOT NULL,
    cursor     INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS messages (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    thread    TEXT NOT NULL DEFAULT 'main',
    sender    TEXT NOT NULL,
    recipient TEXT NOT NULL,
    body      TEXT NOT NULL,
    ts        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS msg_recv  ON messages(recipient, id);
CREATE INDEX IF NOT EXISTS msg_thread ON messages(thread, id);
";

/// Cap on one message body, so a runaway agent cannot fill the disk.
pub const MAX_BODY_CHARS: usize = 32_000;

/// A member quieter than this is treated as unreachable.
///
/// `leave()` only runs on a clean EOF, so a killed or crashed agent stays
/// `idle`/`working` forever and keeps collecting mail nobody will read.
/// `last_seen` is refreshed by `join` and by every read (`inbox`/`wait`) and
/// send, so silence for this long means the process is gone even when its
/// status never got to say so.
pub const STALE_MEMBER_MS: i64 = 24 * 60 * 60 * 1000;

/// The shared team bus.
pub struct Bus {
    conn: Connection,
    path: PathBuf,
}

impl Bus {
    /// Open (creating if needed) the bus database at `path`.
    pub fn open(path: impl AsRef<Path>) -> Result<Self, BusError> {
        let path = path.as_ref().to_path_buf();
        if let Some(parent) = path.parent()
            && !parent.as_os_str().is_empty()
        {
            let _ = std::fs::create_dir_all(parent);
        }
        let conn = Connection::open(&path).map_err(|source| BusError::Open {
            path: path.clone(),
            source,
        })?;
        // Every agent runs in its own process; writers must wait, not fail.
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "synchronous", "NORMAL")?;
        conn.busy_timeout(Duration::from_secs(10))?;
        conn.execute_batch(V1_SCHEMA)?;
        Ok(Self { conn, path })
    }

    /// Where this bus lives on disk.
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Register or refresh a member. Re-joining keeps the read cursor, so an
    /// agent that restarts never loses an unread message.
    pub fn join(&self, req: JoinRequest) -> Result<(), BusError> {
        let now = now_ms();
        self.conn.execute(
            "INSERT INTO team (name, role, engine, task_id, status, joined_at, last_seen, cursor)
             VALUES (?1, ?2, ?3, ?4, 'idle', ?5, ?5, 0)
             ON CONFLICT(name) DO UPDATE SET
                 role = excluded.role,
                 engine = excluded.engine,
                 task_id = excluded.task_id,
                 status = 'idle',
                 last_seen = excluded.last_seen",
            params![req.name, req.role, req.engine, req.task_id, now],
        )?;
        Ok(())
    }

    /// Mark a member as gone (its process finished). History stays put.
    pub fn leave(&self, name: &str) -> Result<(), BusError> {
        self.conn.execute(
            "UPDATE team SET status = 'gone', last_seen = ?2 WHERE name = ?1",
            params![name, now_ms()],
        )?;
        Ok(())
    }

    /// Update status + liveness for one member.
    pub fn touch(&self, name: &str, status: &str) -> Result<(), BusError> {
        self.conn.execute(
            "INSERT INTO team (name, status, joined_at, last_seen)
             VALUES (?1, ?2, ?3, ?3)
             ON CONFLICT(name) DO UPDATE SET status = ?2, last_seen = ?3",
            params![name, status, now_ms()],
        )?;
        Ok(())
    }

    /// Every member, longest-running first.
    pub fn members(&self) -> Result<Vec<Member>, BusError> {
        let mut stmt = self.conn.prepare(
            "SELECT t.name, t.role, t.engine, t.task_id, t.status, t.joined_at, t.last_seen,
                    (SELECT COUNT(*) FROM messages m
                      WHERE m.id > t.cursor
                        AND m.sender <> t.name
                        AND (m.recipient = t.name OR m.recipient = '*')) AS unread
               FROM team t
              ORDER BY t.joined_at ASC, t.name ASC",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok(Member {
                name: r.get(0)?,
                role: r.get(1)?,
                engine: r.get(2)?,
                task_id: r.get(3)?,
                status: r.get(4)?,
                joined_at: r.get(5)?,
                last_seen: r.get(6)?,
                unread: r.get(7)?,
            })
        })?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row?);
        }
        Ok(out)
    }

    /// Names currently able to receive a message: not `gone`, and seen within
    /// [`STALE_MEMBER_MS`] (see there for why silence counts as gone).
    pub fn reachable(&self) -> Result<Vec<String>, BusError> {
        let now = now_ms();
        Ok(self
            .members()?
            .into_iter()
            .filter(|m| m.status != "gone" && now - m.last_seen <= STALE_MEMBER_MS)
            .map(|m| m.name)
            .collect())
    }

    /// Deliver one message. A recipient that is not on the bus is an honest
    /// error naming the members that *are* — a misspelled teammate must not
    /// silently swallow a message.
    pub fn send(&self, msg: Outgoing) -> Result<Message, BusError> {
        let body = msg.body.trim();
        if body.is_empty() {
            return Err(BusError::EmptyBody);
        }
        let len = body.chars().count();
        if len > MAX_BODY_CHARS {
            return Err(BusError::BodyTooLarge {
                len,
                cap: MAX_BODY_CHARS,
            });
        }
        let to = msg.to.trim().to_string();
        if to != EVERYONE && !self.is_known(&to)? {
            return Err(BusError::UnknownMember {
                to,
                known: self.reachable()?.join(", "),
            });
        }
        let thread = msg
            .thread
            .filter(|t| !t.trim().is_empty())
            .unwrap_or_else(|| "main".into());
        let ts = now_ms();
        // Sending is activity: refresh the sender's liveness so a long-lived
        // agent that writes more than it reads is never wrongly aged out of
        // reachability. A no-op for senders not on the bus (e.g. the human
        // briefing a team before joining).
        self.conn.execute(
            "UPDATE team SET last_seen = ?2 WHERE name = ?1",
            params![msg.sender, ts],
        )?;
        self.conn.execute(
            "INSERT INTO messages (thread, sender, recipient, body, ts) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![thread, msg.sender, to, body, ts],
        )?;
        let id = self.conn.last_insert_rowid();
        Ok(Message {
            id,
            thread,
            sender: msg.sender,
            recipient: to,
            body: body.to_string(),
            ts,
        })
    }

    /// A member that exists, has not left, and has not been silent for longer
    /// than [`STALE_MEMBER_MS`]. A departed teammate is not a mailbox: a
    /// message nobody will ever read must fail, not succeed — and a crashed
    /// process that never reached `leave()` is departed all the same.
    fn is_known(&self, name: &str) -> Result<bool, BusError> {
        let row: Option<(String, i64)> = self
            .conn
            .query_row(
                "SELECT status, last_seen FROM team WHERE name = ?1",
                [name],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()?;
        let now = now_ms();
        Ok(row.is_some_and(|(s, seen)| s != "gone" && now - seen <= STALE_MEMBER_MS))
    }

    /// Unread messages for `name`, oldest first, advancing its cursor.
    ///
    /// The read and the cursor advance happen in one `BEGIN IMMEDIATE`
    /// transaction. Two processes may share a member name (a restarted agent,
    /// or two CLIs started with the same `YUPPY_AGENT`), and peek-then-update
    /// is not atomic across them: in WAL mode readers do not block writers, so
    /// both could read the same rows before either moved the cursor and each
    /// would deliver the same message. Taking the write lock up front makes
    /// the second reader wait, then see the already-advanced cursor.
    pub fn inbox(&self, name: &str, limit: usize) -> Result<Vec<Message>, BusError> {
        // The write lock is taken *before* the SELECT, not between the read
        // and the cursor update: in WAL mode a plain read never blocks on a
        // writer, so peek-then-update would let two readers under one member
        // name each deliver the same rows.
        self.conn.execute_batch("BEGIN IMMEDIATE")?;
        let read = (|| {
            let msgs = self.peek(name, limit)?;
            if let Some(max) = msgs.iter().map(|m| m.id).max() {
                self.conn.execute(
                    "UPDATE team SET cursor = max(cursor, ?2), last_seen = ?3 WHERE name = ?1",
                    params![name, max, now_ms()],
                )?;
            }
            Ok(msgs)
        })();
        match read {
            Ok(msgs) => {
                self.conn.execute_batch("COMMIT")?;
                Ok(msgs)
            }
            Err(e) => {
                let _ = self.conn.execute_batch("ROLLBACK");
                Err(e)
            }
        }
    }

    /// Same rows as [`Bus::inbox`] without moving the cursor.
    ///
    /// A member never sees its own message echoed back: a broadcast is for the
    /// others, and reading your own words as if a teammate sent them makes an
    /// agent answer itself.
    pub fn peek(&self, name: &str, limit: usize) -> Result<Vec<Message>, BusError> {
        let cursor: i64 = self
            .conn
            .query_row("SELECT cursor FROM team WHERE name = ?1", [name], |r| {
                r.get::<_, i64>(0)
            })
            .optional()?
            .unwrap_or(0);
        let limit = limit.clamp(1, 200) as i64;
        let mut stmt = self.conn.prepare(
            "SELECT id, thread, sender, recipient, body, ts FROM messages
              WHERE id > ?1 AND sender <> ?2 AND (recipient = ?2 OR recipient = '*')
              ORDER BY id ASC LIMIT ?3",
        )?;
        let rows = stmt.query_map(params![cursor, name, limit], Self::row_to_message)?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row?);
        }
        Ok(out)
    }

    /// Block until this member has something to read, or `timeout` expires.
    ///
    /// This is the primitive that turns two CLIs into a conversation: an agent
    /// can ask a question and actually wait for the answer instead of guessing.
    /// Returns an empty vec on timeout — the caller decides what to do then.
    ///
    /// `from` only decides *when to wake up*; the returned batch is always the
    /// member's full unread set. Filtering the payload as well would either
    /// discard a message the caller never got to read, or hand back the
    /// messages it skipped — both have real costs, so the choice is stated
    /// rather than hidden.
    pub fn wait(
        &self,
        name: &str,
        timeout: Duration,
        from: Option<&str>,
        limit: usize,
    ) -> Result<Vec<Message>, BusError> {
        let wanted = from.map(str::trim).filter(|f| !f.is_empty());
        let start = Instant::now();
        loop {
            let unread = self.peek(name, limit)?;
            let due = !unread.is_empty()
                && match wanted {
                    Some(f) => unread.iter().any(|m| m.sender == f),
                    None => true,
                };
            if due {
                // Everything unread goes to the caller, in order, consumed once.
                return self.inbox(name, limit);
            }
            if start.elapsed() >= timeout {
                return Ok(Vec::new());
            }
            std::thread::sleep(Duration::from_millis(200));
        }
    }

    /// Conversation transcript for one thread (or the whole bus), newest first.
    pub fn history(&self, thread: Option<&str>, limit: usize) -> Result<Vec<Message>, BusError> {
        let limit = limit.clamp(1, 500) as i64;
        let mut out = Vec::new();
        match thread {
            Some(t) => {
                let mut stmt = self.conn.prepare(
                    "SELECT id, thread, sender, recipient, body, ts FROM messages
                      WHERE thread = ?1 ORDER BY id DESC LIMIT ?2",
                )?;
                let rows = stmt.query_map(params![t, limit], Self::row_to_message)?;
                for row in rows {
                    out.push(row?);
                }
            }
            None => {
                let mut stmt = self.conn.prepare(
                    "SELECT id, thread, sender, recipient, body, ts FROM messages
                      ORDER BY id DESC LIMIT ?1",
                )?;
                let rows = stmt.query_map(params![limit], Self::row_to_message)?;
                for row in rows {
                    out.push(row?);
                }
            }
        }
        Ok(out)
    }

    /// Drop every message and member (used by `yuppy msg clear`).
    pub fn clear(&self) -> Result<(), BusError> {
        self.conn.execute("DELETE FROM messages", [])?;
        self.conn.execute("DELETE FROM team", [])?;
        Ok(())
    }

    fn row_to_message(row: &rusqlite::Row<'_>) -> rusqlite::Result<Message> {
        Ok(Message {
            id: row.get(0)?,
            thread: row.get(1)?,
            sender: row.get(2)?,
            recipient: row.get(3)?,
            body: row.get(4)?,
            ts: row.get(5)?,
        })
    }
}

/// Default bus location: `<config dir>/yuppycode/team.sqlite3`, overridable
/// with `$YUPPY_BUS` (which is what the engine child processes get).
pub fn default_bus_path() -> PathBuf {
    if let Ok(p) = std::env::var("YUPPY_BUS")
        && !p.trim().is_empty()
    {
        return PathBuf::from(p);
    }
    let base = std::env::var("YUPPY_CONFIG_DIR")
        .map(PathBuf::from)
        .ok()
        .or_else(dirs::config_dir)
        .unwrap_or_else(|| PathBuf::from("."))
        .join("yuppycode");
    base.join("team.sqlite3")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "yuppy-bus-{tag}-{}-{}",
            std::process::id(),
            now_ms()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        dir.join("team.sqlite3")
    }

    fn member(name: &str, role: &str, engine: &str) -> JoinRequest {
        JoinRequest {
            name: name.into(),
            role: role.into(),
            engine: engine.into(),
            task_id: String::new(),
        }
    }

    #[test]
    fn members_can_message_each_other_by_name() {
        let bus = Bus::open(scratch("send")).unwrap();
        bus.join(member("ada", "backend", "claude-code")).unwrap();
        bus.join(member("nova", "qa", "codex")).unwrap();

        let m = bus
            .send(Outgoing {
                sender: "ada".into(),
                to: "nova".into(),
                body: "the /users handler now returns 429 with Retry-After".into(),
                thread: None,
            })
            .unwrap();
        assert_eq!(m.recipient, "nova");

        let inbox = bus.inbox("nova", 10).unwrap();
        assert_eq!(inbox.len(), 1, "nova sees ada's message");
        assert_eq!(inbox[0].sender, "ada");
        assert!(
            bus.inbox("nova", 10).unwrap().is_empty(),
            "a read message is not replayed"
        );
        assert!(
            bus.inbox("ada", 10).unwrap().is_empty(),
            "ada was not the recipient"
        );
    }

    #[test]
    fn messaging_an_unknown_teammate_fails_honestly() {
        let bus = Bus::open(scratch("unknown")).unwrap();
        bus.join(member("ada", "backend", "claude-code")).unwrap();
        bus.join(member("nova", "qa", "codex")).unwrap();
        let err = bus
            .send(Outgoing {
                sender: "ada".into(),
                to: "novva".into(),
                body: "typo".into(),
                thread: None,
            })
            .unwrap_err();
        let msg = err.to_string();
        assert!(msg.contains("novva"), "{msg}");
        assert!(msg.contains("ada"), "{msg} must list real members");
        assert!(msg.contains("nova"), "{msg} must list real members");
    }

    #[test]
    fn broadcast_reaches_every_member_once() {
        let bus = Bus::open(scratch("bc")).unwrap();
        for n in ["ada", "nova", "sol"] {
            bus.join(member(n, "role", "codex")).unwrap();
        }
        bus.send(Outgoing {
            sender: HUMAN.into(),
            to: EVERYONE.into(),
            body: "who is touching src/api?".into(),
            thread: Some("api".into()),
        })
        .unwrap();
        for n in ["ada", "nova", "sol"] {
            let got = bus.inbox(n, 10).unwrap();
            assert_eq!(got.len(), 1, "{n} got the broadcast once");
            assert_eq!(got[0].thread, "api");
        }
        assert_eq!(
            bus.members()
                .unwrap()
                .iter()
                .filter(|m| m.unread > 0)
                .count(),
            0
        );
    }

    #[test]
    fn wait_returns_as_soon_as_a_teammate_answers() {
        let path = scratch("wait");
        let bus = Bus::open(&path).unwrap();
        bus.join(member("ada", "backend", "claude-code")).unwrap();
        bus.join(member("nova", "qa", "codex")).unwrap();

        let answerer = {
            let path = path.clone();
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_millis(300));
                let bus = Bus::open(&path).unwrap();
                bus.send(Outgoing {
                    sender: "nova".into(),
                    to: "ada".into(),
                    body: "yes, the migration is safe".into(),
                    thread: None,
                })
                .unwrap();
            })
        };
        let got = bus.wait("ada", Duration::from_secs(5), None, 10).unwrap();
        answerer.join().unwrap();
        assert_eq!(got.len(), 1, "wait woke up on the reply");
        assert!(got[0].body.contains("migration"));
    }

    #[test]
    fn an_agent_never_reads_its_own_broadcast_back() {
        // A real Codex worker concluded it had been pinged, when the "ping" it
        // read was its own broadcast. Reading your own words is not news.
        let bus = Bus::open(scratch("self-echo")).unwrap();
        for n in ["ada", "nova"] {
            bus.join(member(n, "role", "codex")).unwrap();
        }
        bus.send(Outgoing {
            sender: "nova".into(),
            to: EVERYONE.into(),
            body: "nova here, waiting".into(),
            thread: None,
        })
        .unwrap();
        assert!(
            bus.peek("nova", 10).unwrap().is_empty(),
            "nova must not see its own message"
        );
        assert_eq!(bus.peek("ada", 10).unwrap().len(), 1, "ada does see it");
        assert_eq!(
            bus.members()
                .unwrap()
                .iter()
                .find(|m| m.name == "nova")
                .unwrap()
                .unread,
            0,
            "and it must not be counted as waiting for nova"
        );
    }

    #[test]
    fn waiting_for_one_teammate_never_eats_another_message() {
        // `from` decides when to wake; the batch handed back is the whole
        // unread set, so a message can never be consumed by being filtered out.
        let bus = Bus::open(scratch("wait-from")).unwrap();
        for n in ["ada", "nova", "sol"] {
            bus.join(member(n, "role", "codex")).unwrap();
        }
        bus.send(Outgoing {
            sender: "sol".into(),
            to: "nova".into(),
            body: "unrelated question".into(),
            thread: None,
        })
        .unwrap();
        // Nothing from ada yet: waiting must keep waiting, not wake on sol.
        let start = Instant::now();
        let early = bus
            .wait("nova", Duration::from_millis(400), Some("ada"), 10)
            .unwrap();
        assert!(early.is_empty(), "sol is not ada");
        assert!(start.elapsed() >= Duration::from_millis(300));
        bus.send(Outgoing {
            sender: "ada".into(),
            to: "nova".into(),
            body: "the answer".into(),
            thread: None,
        })
        .unwrap();
        let got = bus
            .wait("nova", Duration::from_secs(5), Some("ada"), 10)
            .unwrap();
        assert_eq!(
            got.len(),
            2,
            "sol's message is still there to read: {got:?}"
        );
        assert_eq!(got[0].sender, "sol");
        assert_eq!(got[1].body, "the answer");
    }

    #[test]
    fn wait_reports_timeout_instead_of_inventing_an_answer() {
        let bus = Bus::open(scratch("wait-timeout")).unwrap();
        bus.join(member("ada", "backend", "claude-code")).unwrap();
        let got = bus
            .wait("ada", Duration::from_millis(400), None, 10)
            .unwrap();
        assert!(got.is_empty(), "no message, no fabrication");
    }

    #[test]
    fn a_restarting_agent_keeps_its_unread_messages() {
        let path = scratch("resume");
        let bus = Bus::open(&path).unwrap();
        bus.join(member("ada", "backend", "claude-code")).unwrap();
        bus.join(member("nova", "qa", "codex")).unwrap();
        bus.send(Outgoing {
            sender: "nova".into(),
            to: "ada".into(),
            body: "unread while ada was down".into(),
            thread: None,
        })
        .unwrap();
        // Ada's process restarts and re-registers.
        bus.join(member("ada", "backend", "claude-code")).unwrap();
        assert_eq!(bus.peek("ada", 10).unwrap().len(), 1, "still waiting");
        assert_eq!(bus.inbox("ada", 10).unwrap().len(), 1);
    }

    #[test]
    fn empty_and_oversized_bodies_are_refused() {
        let bus = Bus::open(scratch("caps")).unwrap();
        bus.join(member("ada", "backend", "claude-code")).unwrap();
        assert!(matches!(
            bus.send(Outgoing {
                sender: "ada".into(),
                to: "ada".into(),
                body: "   ".into(),
                thread: None,
            }),
            Err(BusError::EmptyBody)
        ));
        assert!(matches!(
            bus.send(Outgoing {
                sender: "ada".into(),
                to: "ada".into(),
                body: "x".repeat(MAX_BODY_CHARS + 1),
                thread: None,
            }),
            Err(BusError::BodyTooLarge { .. })
        ));
    }

    #[test]
    fn gone_members_are_not_reachable_but_history_survives() {
        let bus = Bus::open(scratch("gone")).unwrap();
        bus.join(member("ada", "backend", "claude-code")).unwrap();
        bus.join(member("nova", "qa", "codex")).unwrap();
        bus.send(Outgoing {
            sender: "ada".into(),
            to: "nova".into(),
            body: "hello".into(),
            thread: None,
        })
        .unwrap();
        bus.leave("nova").unwrap();
        assert_eq!(bus.reachable().unwrap(), vec!["ada".to_string()]);
        assert_eq!(bus.history(None, 10).unwrap().len(), 1, "history kept");
        assert!(
            bus.send(Outgoing {
                sender: "ada".into(),
                to: "nova".into(),
                body: "again".into(),
                thread: None,
            })
            .is_err_and(|e| e.to_string().contains("nova")),
            "messaging a gone member must not look like a success"
        );
    }
}
