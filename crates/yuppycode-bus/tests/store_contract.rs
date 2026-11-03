//! Contract tests for the durable bus, exercised through the public API the way
//! two agent processes actually use it.
//!
//! The unit tests inside `store.rs` cover single-connection behaviour. These
//! cover the claims that only become real when more than one connection is
//! involved — which is the entire premise of the bus: every teammate is a
//! separate process opening the same file.

use std::path::PathBuf;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use yuppycode_bus::store::{Bus, EVERYONE, HUMAN, JoinRequest, Outgoing};

/// A throwaway bus file that removes itself, so the suite leaves nothing behind.
struct Scratch {
    dir: PathBuf,
}

impl Scratch {
    fn new(tag: &str) -> Self {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or_default();
        let dir = std::env::temp_dir().join(format!(
            "yuppy-bus-contract-{tag}-{}-{nanos}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        Self { dir }
    }

    fn path(&self) -> PathBuf {
        self.dir.join("team.sqlite3")
    }
}

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

fn add(bus: &Bus, name: &str, role: &str, engine: &str) {
    bus.join(JoinRequest {
        name: name.into(),
        role: role.into(),
        engine: engine.into(),
        task_id: String::new(),
    })
    .unwrap();
}

fn out(sender: &str, to: &str, body: &str) -> Outgoing {
    Outgoing {
        sender: sender.into(),
        to: to.into(),
        body: body.into(),
        thread: None,
    }
}

#[test]
fn the_bus_file_and_its_directories_are_created_on_open() {
    // `yuppy team` points every engine child at a path that does not exist yet;
    // the first opener has to create the parent chain, not fail.
    let scratch = Scratch::new("open");
    let nested = scratch.dir.join("deep").join("nested").join("team.sqlite3");
    assert!(!nested.parent().unwrap().exists());
    let bus = Bus::open(&nested).unwrap();
    assert_eq!(bus.path(), nested.as_path());
    assert!(nested.exists(), "open must create the file and its parents");
}

#[test]
fn a_message_written_on_one_connection_is_readable_on_another() {
    // Two handles on one file is the cheapest honest stand-in for two agent
    // processes. If a reader ever needs the writing handle to see its own
    // traffic, multi-process teams break and no single-connection test notices.
    let scratch = Scratch::new("cross-conn");
    let path = scratch.path();

    let writer = Bus::open(&path).unwrap();
    add(&writer, "ada", "backend", "claude-code");
    add(&writer, "nova", "qa", "codex");

    let reader = Bus::open(&path).unwrap();
    writer
        .send(out("ada", "nova", "the migration is safe"))
        .unwrap();

    let got = reader.inbox("nova", 10).unwrap();
    assert_eq!(got.len(), 1, "a separate connection must see the message");
    assert_eq!(got[0].body, "the migration is safe");

    // The cursor moved in the file, so the writer connection agrees it is read.
    assert!(
        writer.inbox("nova", 10).unwrap().is_empty(),
        "consumed on one handle must not be re-delivered on another"
    );
}

#[test]
fn a_write_waits_for_a_competing_writer_instead_of_failing_busy() {
    // The bus promises that concurrent agents "wait instead of erroring with
    // SQLITE_BUSY". Many fast writes never collide, so hammering the file proves
    // nothing: this test takes the write lock away from the bus and holds it,
    // which is what a second agent's send does to the first one.
    //
    // Scope note: SQLite already waits a few seconds by default here, so this
    // pins "the bus queues behind a writer instead of dropping the message" —
    // it does not pin the exact 10s `busy_timeout` the store asks for.
    let scratch = Scratch::new("busy-wait");
    let path = scratch.path();
    let bus = Bus::open(&path).unwrap();
    add(&bus, "ada", "backend", "claude-code");
    add(&bus, "nova", "qa", "codex");

    // A separate process that does not go through the bus at all.
    let competitor = rusqlite::Connection::open(&path).unwrap();
    competitor
        .pragma_update(None, "journal_mode", "WAL")
        .unwrap();
    competitor.busy_timeout(Duration::from_secs(10)).unwrap();
    competitor.execute_batch("BEGIN IMMEDIATE").unwrap();

    // Locks belong to the connection, not the thread, so handing the handle to
    // another thread and committing there is the same thing a teammate's process
    // finishing its write looks like from the outside.
    let release = std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(300));
        competitor.execute_batch("COMMIT").unwrap();
    });

    let started = std::time::Instant::now();
    let sent = bus.send(out("ada", "nova", "sent while the bus was busy"));
    let waited = started.elapsed();

    release.join().unwrap();

    let sent = match sent {
        Ok(m) => m,
        Err(e) => panic!("the bus gave up instead of waiting for the other writer: {e}"),
    };
    assert!(
        waited >= Duration::from_millis(200),
        "a send that should have queued returned instantly in {waited:?} — \
         agents lose messages as soon as two of them talk at once"
    );
    assert_eq!(sent.body, "sent while the bus was busy");
    assert_eq!(
        bus.inbox("nova", 10).unwrap().len(),
        1,
        "the queued message was really stored, not silently dropped"
    );
}

#[test]
fn paging_past_the_limit_still_delivers_every_message_once() {
    // `inbox` advances the cursor to the newest row it actually returned, so a
    // backlog must drain over several reads. If it ever advanced to the newest
    // row overall, an agent reading 2 at a time would silently lose the rest.
    let bus = Bus::open(Scratch::new("paging").path()).unwrap();
    add(&bus, "ada", "backend", "claude-code");
    add(&bus, "nova", "qa", "codex");
    for i in 0..5 {
        bus.send(out("ada", "nova", &format!("part {i}"))).unwrap();
    }

    let mut got = Vec::new();
    for _ in 0..5 {
        let batch = bus.inbox("nova", 2).unwrap();
        if batch.is_empty() {
            break;
        }
        got.extend(batch.into_iter().map(|m| m.body));
    }
    assert_eq!(
        got,
        vec!["part 0", "part 1", "part 2", "part 3", "part 4"],
        "a backlog drains in order, nothing skipped"
    );
    assert!(bus.inbox("nova", 2).unwrap().is_empty(), "and stops there");
}

#[test]
fn zero_limit_still_reads_one_message_rather_than_none() {
    // `--limit 0` must not look like "no mail" to an agent that is polling.
    let bus = Bus::open(Scratch::new("limit0").path()).unwrap();
    add(&bus, "ada", "backend", "claude-code");
    add(&bus, "nova", "qa", "codex");
    bus.send(out("ada", "nova", "ping")).unwrap();
    assert_eq!(
        bus.inbox("nova", 0).unwrap().len(),
        1,
        "the limit is clamped up to one, never down to zero"
    );
}

#[test]
fn two_handles_reading_as_one_member_deliver_each_message_once() {
    // Two processes can run under the same member name (a restarted agent, or
    // two CLIs started with the same YUPPY_AGENT). `inbox` must be atomic: if
    // the peek and the cursor advance are separate steps, WAL readers do not
    // block writers, so both handles can read the same rows before either
    // moves the cursor and the message is delivered twice.
    //
    // The race is made deterministic by holding the write lock with a peek +
    // pending cursor update (exactly what a mid-`inbox` process looks like)
    // while a second, independent Bus handle runs a full `inbox`.
    let scratch = Scratch::new("double-read");
    let path = scratch.path();
    let bus = Bus::open(&path).unwrap();
    add(&bus, "ada", "backend", "claude-code");
    add(&bus, "nova", "qa", "codex");
    bus.send(out("ada", "nova", "one shot, one delivery"))
        .unwrap();

    // Handle A: a process parked inside its own read — it has seen the rows
    // and is about to commit the cursor move.
    let peeker = rusqlite::Connection::open(&path).unwrap();
    peeker.pragma_update(None, "journal_mode", "WAL").unwrap();
    peeker.busy_timeout(Duration::from_secs(10)).unwrap();
    peeker.execute_batch("BEGIN IMMEDIATE").unwrap();
    let a_rows: i64 = peeker
        .query_row(
            "SELECT COUNT(*) FROM messages
              WHERE id > (SELECT cursor FROM team WHERE name = 'nova')
                AND sender <> 'nova' AND (recipient = 'nova' OR recipient = '*')",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(a_rows, 1, "handle A is holding an unread message");

    // Handle B: a fully independent Bus reading as the same member. It must
    // wait for A, then see the cursor already advanced.
    let reader = Bus::open(&path).unwrap();
    let b_read = std::thread::spawn(move || reader.inbox("nova", 10).unwrap().len());
    std::thread::sleep(Duration::from_millis(300));
    // A commits its half of the read: consume the rows it peeked, release.
    peeker
        .execute_batch(
            "UPDATE team SET cursor = (SELECT MAX(id) FROM messages) WHERE name = 'nova';
             COMMIT;",
        )
        .unwrap();
    let b_delivered = b_read.join().unwrap();

    assert_eq!(
        a_rows as usize + b_delivered,
        1,
        "handle A delivered {a_rows}, handle B delivered {b_delivered}: \
         two readers under one member name must not both get the message"
    );
}

#[test]
fn a_silent_member_stops_being_reachable_once_stale() {
    // `leave()` only runs on clean EOF, so a crashed agent would otherwise
    // stay reachable forever and swallow every broadcast. A member silent for
    // longer than STALE_MEMBER_MS is treated as unreachable: not listed by
    // `reachable`, and not a valid `send` target.
    let scratch = Scratch::new("stale");
    let bus = Bus::open(scratch.path()).unwrap();
    add(&bus, "ada", "backend", "claude-code");
    add(&bus, "ghost", "qa", "codex");

    // Age ghost well past the cutoff by hand — the same row a crash leaves.
    let conn = rusqlite::Connection::open(scratch.path()).unwrap();
    conn.execute(
        "UPDATE team SET last_seen = ?1 WHERE name = 'ghost'",
        rusqlite::params![
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_millis() as i64
                - yuppycode_bus::store::STALE_MEMBER_MS
                - 1000
        ],
    )
    .unwrap();
    drop(conn);

    assert!(
        !bus.reachable().unwrap().contains(&"ghost".to_string()),
        "a 24h-silent member must not be listed as reachable"
    );
    assert!(
        bus.send(out("ada", "ghost", "are you there?")).is_err(),
        "messaging a stale member must fail, not post into the void"
    );
    // A live member is unaffected, and ghost coming back (any activity)
    // makes it addressable again.
    assert!(bus.reachable().unwrap().contains(&"ada".to_string()));
    bus.touch("ghost", "working").unwrap();
    assert!(bus.reachable().unwrap().contains(&"ghost".to_string()));
    bus.send(out("ada", "ghost", "welcome back")).unwrap();
}

#[test]
fn a_rejoined_member_is_reachable_again_without_losing_its_place() {
    // A crashed worker that comes back must resume delivery, not be treated as
    // gone forever, and must not have its unread backlog replayed away.
    let bus = Bus::open(Scratch::new("rejoin").path()).unwrap();
    add(&bus, "ada", "backend", "claude-code");
    add(&bus, "nova", "qa", "codex");
    bus.send(out("ada", "nova", "before the crash")).unwrap();

    bus.leave("nova").unwrap();
    assert!(!bus.reachable().unwrap().contains(&"nova".to_string()));
    assert!(
        bus.send(out("ada", "nova", "dropped on the floor"))
            .is_err(),
        "while gone, nova is not a mailbox"
    );

    add(&bus, "nova", "qa", "codex");
    assert!(bus.reachable().unwrap().contains(&"nova".to_string()));
    let got = bus.inbox("nova", 10).unwrap();
    assert_eq!(
        got.iter().map(|m| m.body.as_str()).collect::<Vec<_>>(),
        vec!["before the crash"],
        "the message sent before the crash is still waiting, and the one \
         rejected while gone never entered the log"
    );
}

#[test]
fn a_broadcast_with_no_members_yet_is_not_an_error() {
    // `yuppy msg brief` is how the human briefs a team; briefing before the
    // first engine process has joined has to succeed or the run cannot start.
    let bus = Bus::open(Scratch::new("brief-empty").path()).unwrap();
    let m = bus
        .send(out(HUMAN, EVERYONE, "goal: ship the demo"))
        .unwrap();
    assert_eq!(m.recipient, EVERYONE);
    assert_eq!(bus.history(None, 10).unwrap().len(), 1);

    // Whoever joins later reads it as their first message.
    add(&bus, "ada", "backend", "claude-code");
    let got = bus.inbox("ada", 10).unwrap();
    assert_eq!(got.len(), 1, "a member joining late still gets the brief");
}

#[test]
fn touch_registers_a_member_that_never_joined() {
    // `touch` upserts. That is deliberate — the MCP tools mark liveness without
    // a prior join — but it also means an arbitrary name becomes a real,
    // addressable member, so the behaviour is pinned here rather than implied.
    let bus = Bus::open(Scratch::new("touch").path()).unwrap();
    bus.touch("ghost", "working").unwrap();

    let names: Vec<String> = bus.members().unwrap().into_iter().map(|m| m.name).collect();
    assert_eq!(names, vec!["ghost".to_string()]);
    bus.send(out(HUMAN, "ghost", "you are on the bus now"))
        .unwrap();
    let member = bus
        .members()
        .unwrap()
        .into_iter()
        .find(|m| m.name == "ghost")
        .unwrap();
    assert_eq!(member.status, "working");
    assert_eq!(member.unread, 1);
    assert_eq!(
        member.role, "",
        "touch invents a member, it does not describe one"
    );
}

#[test]
fn history_is_newest_first_and_can_be_filtered_by_thread() {
    let bus = Bus::open(Scratch::new("history").path()).unwrap();
    add(&bus, "ada", "backend", "claude-code");
    add(&bus, "nova", "qa", "codex");
    bus.send(Outgoing {
        thread: Some("api".into()),
        ..out("ada", "nova", "api one")
    })
    .unwrap();
    bus.send(Outgoing {
        thread: Some("db".into()),
        ..out("ada", "nova", "db one")
    })
    .unwrap();
    bus.send(Outgoing {
        thread: Some("api".into()),
        ..out("ada", "nova", "api two")
    })
    .unwrap();

    let all = bus.history(None, 10).unwrap();
    assert_eq!(
        all.iter().map(|m| m.body.as_str()).collect::<Vec<_>>(),
        vec!["api two", "db one", "api one"],
        "newest first, whatever the thread"
    );
    let api = bus.history(Some("api"), 10).unwrap();
    assert_eq!(api.len(), 2);
    assert!(api.iter().all(|m| m.thread == "api"));

    // `yuppy msg ls` takes a limit; it must keep the newest rows, not the oldest.
    let two = bus.history(Some("api"), 1).unwrap();
    assert_eq!(two[0].body, "api two");

    // A thread nobody used is empty, not an error.
    assert!(bus.history(Some("nope"), 10).unwrap().is_empty());
}

#[test]
fn clear_empties_members_and_transcript_together() {
    // `yuppy msg clear` promises to forget traffic *and* members. If it only
    // cleared messages, stale members would linger in `yuppy msg team` and keep
    // absorbing broadcasts on the next run.
    let bus = Bus::open(Scratch::new("clear").path()).unwrap();
    add(&bus, "ada", "backend", "claude-code");
    add(&bus, "nova", "qa", "codex");
    bus.send(out("ada", "nova", "work in progress")).unwrap();

    bus.clear().unwrap();
    assert!(bus.members().unwrap().is_empty(), "members forgotten");
    assert!(
        bus.history(None, 10).unwrap().is_empty(),
        "traffic forgotten"
    );
    assert!(bus.reachable().unwrap().is_empty());

    // And the bus is usable afterwards, not left in a half-reset state.
    add(&bus, "ada", "backend", "claude-code");
    add(&bus, "nova", "qa", "codex");
    bus.send(out("ada", "nova", "second run")).unwrap();
    assert_eq!(bus.inbox("nova", 10).unwrap().len(), 1);
}

#[test]
fn a_new_bus_on_an_existing_file_keeps_its_data() {
    // Every engine child opens the same path, so reopening must never reset
    // cursors, members, or history.
    let scratch = Scratch::new("reopen");
    let path = scratch.path();
    {
        let bus = Bus::open(&path).unwrap();
        add(&bus, "ada", "backend", "claude-code");
        add(&bus, "nova", "qa", "codex");
        bus.send(out("ada", "nova", "durable")).unwrap();
    }
    let bus = Bus::open(&path).unwrap();
    assert_eq!(bus.members().unwrap().len(), 2, "members survived");
    assert_eq!(bus.history(None, 10).unwrap().len(), 1, "traffic survived");
    assert_eq!(bus.inbox("nova", 10).unwrap()[0].body, "durable");
    drop(bus);

    // Reopening a third time: the read cursor also survived, so no replay.
    let bus = Bus::open(&path).unwrap();
    assert!(bus.inbox("nova", 10).unwrap().is_empty());
}
