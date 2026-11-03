//! Wire contract of the `yuppy mcp-bus` subcommand the bridge wires into
//! every seat it puts on the team bus.

use tempfile::tempdir;

/// Drive the real `yuppy mcp-bus` binary over stdio, exactly as an agent CLI does.
///
/// This is the wire contract between YuppyCode and Claude Code: one
/// JSON-RPC line in, one reply line out, identity taken from the environment.
/// A handler-level test cannot catch framing, env plumbing or process startup,
/// so this one spawns the actual executable.
#[test]
fn mcp_bus_binary_speaks_mcp_and_registers_its_agent() {
    use std::io::{BufRead, BufReader, Write};
    use std::process::{Command, Stdio};

    let dir = tempdir().unwrap();
    let bus = dir.path().join("team.sqlite3");

    // A teammate that is already on the bus, so a send is checked for real
    // delivery instead of for a swallowed error.
    let seed = yuppycode_bus::Bus::open(&bus).unwrap();
    seed.join(yuppycode_bus::JoinRequest {
        name: "nova".into(),
        role: "qa".into(),
        engine: "claude-code".into(),
        task_id: String::new(),
    })
    .unwrap();
    drop(seed);

    let mut child = Command::new(env!("CARGO_BIN_EXE_yuppy"))
        .arg("mcp-bus")
        .env("YUPPY_BUS", &bus)
        .env("YUPPY_AGENT", "ada")
        .env("YUPPY_AGENT_ROLE", "backend")
        .env("YUPPY_ENGINE", "claude-code")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .expect("spawn yuppy mcp-bus");

    let mut stdin = child.stdin.take().unwrap();
    let mut lines = BufReader::new(child.stdout.take().unwrap()).lines();

    let mut ask = |line: &str| -> serde_json::Value {
        writeln!(stdin, "{line}").unwrap();
        stdin.flush().unwrap();
        let text = lines.next().expect("a reply").expect("readable stdout");
        serde_json::from_str(&text).expect("one JSON object per line")
    };

    let init = ask(
        r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"itest","version":"0"}}}"#,
    );
    assert_eq!(init["result"]["protocolVersion"], "2024-11-05");
    assert_eq!(init["result"]["serverInfo"]["name"], "yuppycode-team-bus");

    let tools = ask(r#"{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}"#);
    assert_eq!(tools["result"]["tools"].as_array().unwrap().len(), 5);

    // Claude Code addresses tools by fully-qualified name in some call paths;
    // the bus must understand it, or the agent concludes it has no teammates.
    let sent = ask(
        r#"{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"mcp__yuppy__yuppy_send","arguments":{"to":"nova","body":"hello from the wire test"}}}"#,
    );
    assert_eq!(sent["result"]["isError"], false);
    let sent_text = sent["result"]["content"][0]["text"].as_str().unwrap_or("");
    assert!(
        sent_text.contains("delivered"),
        "prefixed send: {sent_text}"
    );

    let team = ask(
        r#"{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"yuppy_team","arguments":{}}}"#,
    );
    let team_text = team["result"]["content"][0]["text"].as_str().unwrap_or("");
    assert!(team_text.contains("ada"), "self registered: {team_text}");
    assert!(team_text.contains("nova"), "teammate visible: {team_text}");

    // An unknown method is a JSON-RPC error, not a dropped connection.
    let bad = ask(r#"{"jsonrpc":"2.0","id":5,"method":"tools/nope","params":{}}"#);
    assert_eq!(bad["error"]["code"], -32601);

    drop(stdin);
    let _ = child.wait();

    // The human side reads exactly what the agent sent, under the right name.
    let bus = yuppycode_bus::Bus::open(&bus).unwrap();
    let inbox = bus.inbox("nova", 10).unwrap();
    assert_eq!(inbox.len(), 1, "delivered into the teammate's inbox");
    assert_eq!(inbox[0].sender, "ada", "identity came from the environment");
    assert!(inbox[0].body.contains("wire test"));
}
