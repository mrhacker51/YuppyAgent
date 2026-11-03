//! WebSocket accept loop and handshake.

use std::collections::HashSet;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use tokio::net::{TcpListener, TcpStream};
use tokio_tungstenite::{
    WebSocketStream, accept_hdr_async, tungstenite::Message,
    tungstenite::handshake::server::Request, tungstenite::http::Response,
};

use yuppycode_protocol::{ClientRequest, Envelope, PROTOCOL_VERSION, ServerPayload};

use super::auth::{ConnectionToken, origin_allowed, verify_token};
use super::error::BridgeError;
use super::handlers::{ClientRole, handle_request_from};
use super::state::BridgeState;

/// Maximum size of a single inbound text frame in bytes.
const MAX_FRAME_SIZE: usize = 256 * 1024; // 256 KiB
/// Time allowed for the client to complete the handshake.
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);
/// Deadline for a single outbound frame. A peer that stops reading (half-open
/// TCP, hung tab under backpressure) must not be able to wedge the bridge.
const SEND_TIMEOUT: Duration = Duration::from_secs(10);

/// Handshake payload sent by the client as the first message.
#[derive(Debug, Clone, serde::Deserialize)]
struct ClientHandshake {
    version: u32,
    token: String,
}

/// Accept a single WebSocket connection, perform the handshake, and return
/// the authorized stream. The caller is responsible for running the message
/// loop; before this function returns, no task or terminal operations are
/// possible. Only the operator token is accepted here.
#[cfg_attr(not(test), allow(dead_code))] // operator-only entry point kept for tests
pub async fn accept_connection(
    listener: &TcpListener,
    token: &ConnectionToken,
) -> Result<(WebSocketStream<TcpStream>, SocketAddr), BridgeError> {
    let (stream, addr) = listener.accept().await?;
    let (ws, _role) = handshake_stream(stream, token, None).await?;
    Ok((ws, addr))
}

/// Upgrade one accepted TCP stream and authorize it.
///
/// Two credentials exist. The operator token (printed once at startup) gives
/// the full UI surface. The conductor token is never printed: the bridge
/// hands it only to the MCP child of a lead seat, and it authorizes nothing
/// but task submission/cancellation (see [`ClientRole::Conductor`]).
pub async fn handshake_stream(
    stream: TcpStream,
    token: &ConnectionToken,
    conductor_token: Option<&ConnectionToken>,
) -> Result<(WebSocketStream<TcpStream>, ClientRole), BridgeError> {
    #[allow(clippy::result_large_err)]
    let origin_check = |req: &Request, response: Response<()>| {
        if let Some(origin) = req.headers().get("origin").and_then(|v| v.to_str().ok()) {
            if !origin_allowed(origin) {
                // Visible in the desktop shell's stderr; origins are not
                // secrets and this is the fastest way to diagnose a new
                // webview origin after a Tauri/WebKit upgrade.
                eprintln!("bridge rejected websocket origin {origin:?}");
                let denied = Response::builder()
                    .status(403)
                    .body(Some("origin not allowed".to_string()))
                    .unwrap();
                return Err(denied);
            }
        }
        Ok(response)
    };

    // Bound the HTTP upgrade too: a client that opens the TCP socket and
    // never sends a valid upgrade request must not hold a handshake slot
    // forever (a trivial denial of service).
    let mut ws = tokio::time::timeout(HANDSHAKE_TIMEOUT, accept_hdr_async(stream, origin_check))
        .await
        .map_err(|_| BridgeError::HandshakeTimeout)?
        .map_err(|e| BridgeError::InvalidMessage(format!("websocket accept failed: {e}")))?;

    // Read and validate the handshake. Any failure is rejected on this
    // socket only; the bridge accept loop must stay alive so the frontend
    // can show a useful auth/protocol error and retry without restarting
    // the server.
    let handshake_result: Result<ClientHandshake, BridgeError> = async {
        let handshake = tokio::time::timeout(HANDSHAKE_TIMEOUT, ws.next())
            .await
            .map_err(|_| BridgeError::HandshakeTimeout)?
            .ok_or_else(|| BridgeError::InvalidMessage("client closed during handshake".into()))?
            .map_err(|e| BridgeError::InvalidMessage(format!("websocket error: {e}")))?;

        let text = match handshake {
            Message::Text(t) => {
                if t.len() > MAX_FRAME_SIZE {
                    return Err(BridgeError::PayloadTooLarge(t.len()));
                }
                t
            }
            Message::Close(_) => {
                return Err(BridgeError::InvalidMessage(
                    "client closed during handshake".into(),
                ));
            }
            _ => {
                return Err(BridgeError::InvalidMessage(
                    "handshake must be a text frame".into(),
                ));
            }
        };

        serde_json::from_str(&text)
            .map_err(|e| BridgeError::InvalidMessage(format!("invalid handshake json: {e}")))
    }
    .await;

    let client_hs = match handshake_result {
        Ok(hs) => hs,
        Err(e) => {
            reject_handshake(&mut ws, &e).await;
            return Err(e);
        }
    };

    if client_hs.version != PROTOCOL_VERSION {
        let e = BridgeError::ProtocolVersionMismatch {
            expected: PROTOCOL_VERSION,
            got: client_hs.version,
        };
        reject_handshake(&mut ws, &e).await;
        return Err(e);
    }

    let role = if verify_token(token, &client_hs.token) {
        ClientRole::Operator
    } else if conductor_token.is_some_and(|t| verify_token(t, &client_hs.token)) {
        ClientRole::Conductor
    } else {
        let e = BridgeError::Unauthorized;
        reject_handshake(&mut ws, &e).await;
        return Err(e);
    };

    let envelope = Envelope::new(0, now_ms(), ServerPayload::Connected);
    let reply = serde_json::to_string(&envelope)
        .map_err(|e| BridgeError::Service(format!("serialize connected: {e}")))?;
    ws.send(Message::Text(reply.into()))
        .await
        .map_err(|e| BridgeError::Io(std::io::Error::other(e)))?;

    Ok((ws, role))
}

async fn reject_handshake(ws: &mut WebSocketStream<TcpStream>, err: &BridgeError) {
    let envelope = Envelope::new(
        0,
        now_ms(),
        ServerPayload::Error {
            code: err.code().to_string(),
            message: err.to_string(),
        },
    );
    if let Ok(text) = serde_json::to_string(&envelope) {
        let _ = ws.send(Message::Text(text.into())).await;
    }
    let _ = ws.send(Message::Close(None)).await;
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

/// Send the initial post-handshake burst: agent inventory, departments, and
/// the current layout. This gives the frontend everything it needs to render
/// without asking for it.
async fn send_initial_state(
    ws: &mut WebSocketStream<TcpStream>,
    state: &BridgeState,
    seq: &mut u64,
) -> Result<(), BridgeError> {
    let inventory = state.agent_inventory();
    send_payload(
        ws,
        *seq,
        ServerPayload::AgentInventory { agents: inventory },
    )
    .await?;
    *seq += 1;

    // Workspace facts for the desktop top bar (additive v2 payload).
    send_payload(
        ws,
        *seq,
        ServerPayload::Engine {
            info: state.engine_info(),
        },
    )
    .await?;
    *seq += 1;

    let departments = state.departments_dto().await;
    send_payload(ws, *seq, ServerPayload::DepartmentsLoaded { departments }).await?;
    *seq += 1;

    let layout = state.layout_dto().await;
    send_payload(
        ws,
        *seq,
        ServerPayload::LayoutApplied {
            name: "default".to_string(),
            layout,
        },
    )
    .await?;
    *seq += 1;

    Ok(())
}

fn terminal_screen_payload(m: &crate::terminals::ManagedTerminal) -> ServerPayload {
    let snap = m.session.snapshot();
    ServerPayload::TerminalScreen {
        session_id: m.session.id().0.to_string(),
        rows: snap.rows,
        cols: snap.cols,
        cursor: snap.cursor,
        cursor_visible: snap.cursor_visible,
        generation: snap.generation,
        cells: snap
            .cells
            .iter()
            .map(|c| yuppycode_protocol::TerminalCellDto {
                ch: c.ch.clone(),
                fg: match c.fg {
                    yuppycode_terminal::Color::Default => yuppycode_protocol::CellColorDto::Default,
                    yuppycode_terminal::Color::Indexed(i) => {
                        yuppycode_protocol::CellColorDto::Idx { i }
                    }
                    yuppycode_terminal::Color::Rgb(r, g, b) => {
                        yuppycode_protocol::CellColorDto::Rgb { r, g, b }
                    }
                },
                bg: match c.bg {
                    yuppycode_terminal::Color::Default => yuppycode_protocol::CellColorDto::Default,
                    yuppycode_terminal::Color::Indexed(i) => {
                        yuppycode_protocol::CellColorDto::Idx { i }
                    }
                    yuppycode_terminal::Color::Rgb(r, g, b) => {
                        yuppycode_protocol::CellColorDto::Rgb { r, g, b }
                    }
                },
                bold: c.bold,
                italic: c.italic,
                underline: c.underline,
                inverse: c.inverse,
                wide: !c.wide_continuation,
            })
            .collect(),
    }
}

async fn send_payload(
    ws: &mut WebSocketStream<TcpStream>,
    seq: u64,
    payload: ServerPayload,
) -> Result<(), BridgeError> {
    let envelope = Envelope::new(seq, now_ms(), payload);
    let text = serde_json::to_string(&envelope)
        .map_err(|e| BridgeError::Service(format!("serialize payload: {e}")))?;
    // A dead-but-not-closed peer (half-open TCP, stalled reader) fills the
    // socket buffer and would otherwise park this await forever, freezing
    // the whole single-client bridge. Dropping the connection on a send
    // deadline lets the accept loop move on to the next client.
    tokio::time::timeout(SEND_TIMEOUT, ws.send(Message::Text(text.into())))
        .await
        .map_err(|_| {
            BridgeError::Io(std::io::Error::other(format!(
                "client send stalled beyond {} s; dropping connection",
                SEND_TIMEOUT.as_secs()
            )))
        })?
        .map_err(|e| BridgeError::Io(std::io::Error::other(e)))?;
    Ok(())
}

/// Run the authorized operator client loop until the connection closes.
#[cfg_attr(not(test), allow(dead_code))] // operator-only entry point kept for tests
pub async fn run_client_loop(
    ws: WebSocketStream<TcpStream>,
    state: Arc<BridgeState>,
    wake_rx: tokio::sync::broadcast::Receiver<crate::terminals::TerminalEvent>,
) -> Result<(), BridgeError> {
    run_client_loop_as(ws, state, wake_rx, ClientRole::Operator).await
}

/// Why a conductor connection may not send `req`, or `None` when it may.
///
/// The conductor is a model-driven process (the lead CLI's MCP child), so
/// it gets the narrowest surface that lets it delegate: submit a batch,
/// cancel what *it* submitted, ping. It can never type into another seat's
/// PTY, close terminals, or rewrite departments and layouts.
fn conductor_refusal(req: &ClientRequest, own_tasks: &HashSet<String>) -> Option<String> {
    match req {
        ClientRequest::Ping | ClientRequest::TaskSubmit { .. } => None,
        ClientRequest::TaskCancel { task_id } if own_tasks.contains(task_id) => None,
        ClientRequest::TaskCancel { task_id } => Some(format!(
            "the lead may only cancel tasks it dispatched; {task_id:?} is not one of them"
        )),
        other => Some(format!(
            "request {:?} is not available to the lead conductor",
            request_kind(other)
        )),
    }
}

fn request_kind(req: &ClientRequest) -> String {
    serde_json::to_value(req)
        .ok()
        .and_then(|v| v.get("type").and_then(|t| t.as_str()).map(str::to_string))
        .unwrap_or_else(|| "unknown".into())
}

/// Run an authorized client loop for the given role until it closes.
///
/// Every connection subscribes to the task-event broadcast, so a batch any
/// client submits (the UI or the lead's conductor) reaches every client.
pub async fn run_client_loop_as(
    mut ws: WebSocketStream<TcpStream>,
    state: Arc<BridgeState>,
    mut wake_rx: tokio::sync::broadcast::Receiver<crate::terminals::TerminalEvent>,
    role: ClientRole,
) -> Result<(), BridgeError> {
    let mut seq: u64 = 1;
    let mut closed_sessions = std::collections::HashSet::new();
    let mut task_events = state.task_events_tx.subscribe();
    let mut own_tasks: HashSet<String> = HashSet::new();
    send_initial_state(&mut ws, &state, &mut seq).await?;

    loop {
        tokio::select! {
            Some(msg) = ws.next() => {
                let msg = msg.map_err(|e| BridgeError::InvalidMessage(format!("websocket error: {e}")))?;
                match msg {
                    Message::Text(text) => {
                        if text.len() > MAX_FRAME_SIZE {
                            send_payload(&mut ws, seq, BridgeError::PayloadTooLarge(text.len()).into()).await?;
                            seq += 1;
                            continue;
                        }
                        let req: ClientRequest = match serde_json::from_str(&text) {
                            Ok(r) => r,
                            Err(e) => {
                                send_payload(&mut ws, seq, BridgeError::InvalidMessage(format!("invalid request json: {e}")).into()).await?;
                                seq += 1;
                                continue;
                            }
                        };
                        if role == ClientRole::Conductor {
                            if let Some(why) = conductor_refusal(&req, &own_tasks) {
                                send_payload(&mut ws, seq, ServerPayload::Error {
                                    code: "forbidden".into(),
                                    message: why,
                                }).await?;
                                seq += 1;
                                continue;
                            }
                        }
                        let submitted: Vec<String> = match &req {
                            ClientRequest::TaskSubmit { tasks } => {
                                tasks.iter().map(|t| t.id.trim().to_string()).collect()
                            }
                            _ => Vec::new(),
                        };
                        match handle_request_from(&state, req, role).await {
                            Ok(payloads) => {
                                own_tasks.extend(submitted);
                                for payload in payloads {
                                    send_payload(&mut ws, seq, payload).await?;
                                    seq += 1;
                                }
                            }
                            Err(e) => {
                                send_payload(&mut ws, seq, e.into()).await?;
                                seq += 1;
                            }
                        }
                    }
                    Message::Close(_) => break,
                    Message::Binary(_) => {
                        send_payload(&mut ws, seq, BridgeError::InvalidMessage("binary frames not accepted".into()).into()).await?;
                        seq += 1;
                    }
                    _ => {}
                }
            }
            result = task_events.recv() => {
                match result {
                    Ok(payload) => {
                        send_payload(&mut ws, seq, payload).await?;
                        seq += 1;
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => {}
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                        // Task state is also replayed on reconnect; skip stale
                        // intermediate states rather than blocking the loop.
                    }
                }
            }
            result = wake_rx.recv() => {
                match result {
                    // The conductor never renders terminals; screens are
                    // the operator's business only.
                    Ok(_) if role == ClientRole::Conductor => {}
                    Ok(crate::terminals::TerminalEvent::Activity(id)) => {
                        let mut outgoing = Vec::new();
                        {
                            let mgr = state.terminals.lock().await;
                            if let Some(m) = mgr.iter().find(|m| m.session.id().0 == id) {
                                outgoing.push(terminal_screen_payload(m));
                            }
                            // The waiter thread wakes us when a child exits,
                            // even if it produced no final output. Check every
                            // session so silent exits are reported exactly once.
                            for m in mgr.iter() {
                                let sid = m.session.id().0;
                                if closed_sessions.contains(&sid) {
                                    continue;
                                }
                                if let Some(exit) = m.session.exit_status() {
                                    closed_sessions.insert(sid);
                                    outgoing.push(terminal_screen_payload(m));
                                    outgoing.push(ServerPayload::TerminalClosed {
                                        session_id: sid.to_string(),
                                        exit_code: exit.exit_code,
                                        signal: exit.signal,
                                    });
                                }
                            }
                        }
                        for payload in outgoing {
                            send_payload(&mut ws, seq, payload).await?;
                            seq += 1;
                        }
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {
                        // Client fell behind; keep going with the next message.
                    }
                }
            }
            else => break,
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio_tungstenite::connect_async;

    async fn bind_random() -> (TcpListener, String) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        (listener, format!("ws://127.0.0.1:{port}"))
    }

    fn test_token(value: &str) -> ConnectionToken {
        ConnectionToken(value.to_string())
    }

    fn handshake(value: &str) -> String {
        serde_json::json!({ "version": PROTOCOL_VERSION, "token": value }).to_string()
    }

    #[test]
    fn the_conductor_may_only_submit_ping_and_cancel_its_own_tasks() {
        let mut own = HashSet::new();
        own.insert("lead-1".to_string());
        assert!(conductor_refusal(&ClientRequest::Ping, &own).is_none());
        assert!(conductor_refusal(&ClientRequest::TaskSubmit { tasks: vec![] }, &own).is_none());
        assert!(
            conductor_refusal(
                &ClientRequest::TaskCancel {
                    task_id: "lead-1".into()
                },
                &own
            )
            .is_none()
        );
        assert!(
            conductor_refusal(
                &ClientRequest::TaskCancel {
                    task_id: "ui-7".into()
                },
                &own
            )
            .is_some()
        );
        for req in [
            ClientRequest::TerminalInput {
                session_id: "1".into(),
                bytes: "rm -rf /\r".into(),
            },
            ClientRequest::TerminalClose {
                session_id: "1".into(),
            },
            ClientRequest::OpenTerminal {
                agent: "claude-code".into(),
                label: None,
                department: None,
                lead: true,
            },
            ClientRequest::DepartmentRemove { id: "eng".into() },
        ] {
            let why = conductor_refusal(&req, &own).expect("must be refused");
            assert!(why.contains("not available to the lead"), "{why}");
        }
    }

    #[tokio::test]
    async fn the_conductor_token_authorizes_a_conductor_and_nothing_else_does() {
        let (listener, url) = bind_random().await;
        let token = test_token("a".repeat(64).as_str());
        let conductor = test_token("c".repeat(64).as_str());
        let server = tokio::spawn(async move {
            let (s1, _) = listener.accept().await.unwrap();
            let (_, role) = handshake_stream(s1, &token, Some(&conductor))
                .await
                .unwrap();
            assert_eq!(role, ClientRole::Conductor);
            let (s2, _) = listener.accept().await.unwrap();
            let (_, role) = handshake_stream(s2, &token, Some(&conductor))
                .await
                .unwrap();
            assert_eq!(role, ClientRole::Operator);
            // Without a conductor credential configured, "c…" is just wrong.
            let (s3, _) = listener.accept().await.unwrap();
            assert!(matches!(
                handshake_stream(s3, &token, None).await,
                Err(BridgeError::Unauthorized)
            ));
        });
        for value in ["c", "a", "c"] {
            let (mut ws, _) = connect_async(&url).await.unwrap();
            ws.send(Message::Text(handshake(value.repeat(64).as_str()).into()))
                .await
                .unwrap();
            let _ = ws.next().await;
        }
        server.await.unwrap();
    }

    #[tokio::test]
    async fn accepts_valid_handshake() {
        let (listener, url) = bind_random().await;
        let token = test_token("a".repeat(64).as_str());

        let server = tokio::spawn(async move {
            accept_connection(&listener, &token).await.unwrap();
        });

        let (mut ws, _response) = connect_async(&url).await.unwrap();
        ws.send(Message::Text(handshake("a".repeat(64).as_str()).into()))
            .await
            .unwrap();

        let msg = ws.next().await.unwrap().unwrap();
        let env: Envelope = serde_json::from_str(msg.to_text().unwrap()).unwrap();
        assert!(matches!(env.payload, ServerPayload::Connected));

        server.abort();
    }

    #[tokio::test]
    async fn initial_state_includes_inventory_and_departments() {
        let (listener, url) = bind_random().await;
        let token = test_token("a".repeat(64).as_str());

        let state = Arc::new(BridgeState::new(Some(std::env::temp_dir())));
        // Avoid depending on the developer's real HUD config dir.
        *state.departments.lock().await = yuppycode_hud::DepartmentRegistry::default();
        let wake_rx = state.terminal_broadcast_tx.subscribe();

        let server = tokio::spawn(async move {
            let (ws, _) = accept_connection(&listener, &token).await.unwrap();
            let _ = run_client_loop(ws, state, wake_rx).await;
        });

        let (mut ws, _response) = connect_async(&url).await.unwrap();
        ws.send(Message::Text(handshake("a".repeat(64).as_str()).into()))
            .await
            .unwrap();

        let mut saw_inventory = false;
        let mut saw_departments = false;
        for _ in 0..8 {
            let Some(msg) = ws.next().await else { break };
            let Ok(msg) = msg else { break };
            let Ok(env) = serde_json::from_str::<Envelope>(msg.to_text().unwrap()) else {
                continue;
            };
            match env.payload {
                ServerPayload::AgentInventory { agents } => {
                    assert!(!agents.is_empty(), "inventory should list CLIs");
                    saw_inventory = true;
                }
                ServerPayload::DepartmentsLoaded { departments } => {
                    assert_eq!(departments.len(), 6, "six default departments");
                    saw_departments = true;
                }
                _ => {}
            }
            if saw_inventory && saw_departments {
                break;
            }
        }

        assert!(saw_inventory, "missing AgentInventory in initial burst");
        assert!(
            saw_departments,
            "missing DepartmentsLoaded in initial burst"
        );
        server.abort();
    }

    #[tokio::test]
    async fn rejects_wrong_token() {
        let (listener, url) = bind_random().await;
        let token = test_token("a".repeat(64).as_str());

        let server = tokio::spawn(async move {
            let err = accept_connection(&listener, &token).await.unwrap_err();
            assert!(matches!(err, BridgeError::Unauthorized));
        });

        let (mut ws, _response) = connect_async(&url).await.unwrap();
        ws.send(Message::Text(handshake("b".repeat(64).as_str()).into()))
            .await
            .unwrap();

        // Server sends a machine-readable error, then closes this socket.
        let msg = ws.next().await.unwrap().unwrap();
        let env: Envelope = serde_json::from_str(msg.to_text().unwrap()).unwrap();
        match env.payload {
            ServerPayload::Error { code, .. } => assert_eq!(code, "unauthorized"),
            other => panic!("expected unauthorized error, got {other:?}"),
        }

        server.abort();
    }

    #[tokio::test]
    async fn rejects_bad_protocol_version() {
        let (listener, url) = bind_random().await;
        let token = test_token("a".repeat(64).as_str());

        let server = tokio::spawn(async move {
            let err = accept_connection(&listener, &token).await.unwrap_err();
            assert!(matches!(err, BridgeError::ProtocolVersionMismatch { .. }));
        });

        let bad = serde_json::json!({ "version": 999, "token": "a".repeat(64) }).to_string();
        let (mut ws, _response) = connect_async(&url).await.unwrap();
        ws.send(Message::Text(bad.into())).await.unwrap();

        let msg = ws.next().await.unwrap().unwrap();
        let env: Envelope = serde_json::from_str(msg.to_text().unwrap()).unwrap();
        match env.payload {
            ServerPayload::Error { code, .. } => assert_eq!(code, "protocol_mismatch"),
            other => panic!("expected protocol_mismatch error, got {other:?}"),
        }

        server.abort();
    }

    #[tokio::test]
    async fn rejected_handshake_does_not_consume_the_listener() {
        let (listener, url) = bind_random().await;
        let token = test_token("a".repeat(64).as_str());

        let server = tokio::spawn(async move {
            let err = accept_connection(&listener, &token).await.unwrap_err();
            assert!(matches!(err, BridgeError::Unauthorized));
            // The same listener must still accept a valid handshake.
            accept_connection(&listener, &token).await.unwrap();
        });

        let (mut bad, _) = connect_async(&url).await.unwrap();
        bad.send(Message::Text(handshake("b".repeat(64).as_str()).into()))
            .await
            .unwrap();
        let msg = bad.next().await.unwrap().unwrap();
        let env: Envelope = serde_json::from_str(msg.to_text().unwrap()).unwrap();
        assert!(matches!(
            env.payload,
            ServerPayload::Error { code, .. } if code == "unauthorized"
        ));

        let (mut good, _) = connect_async(&url).await.unwrap();
        good.send(Message::Text(handshake("a".repeat(64).as_str()).into()))
            .await
            .unwrap();
        let msg = good.next().await.unwrap().unwrap();
        let env: Envelope = serde_json::from_str(msg.to_text().unwrap()).unwrap();
        assert!(matches!(env.payload, ServerPayload::Connected));

        server.abort();
    }

    #[tokio::test]
    async fn rejects_bad_origin() {
        let (listener, url) = bind_random().await;
        let token = test_token("a".repeat(64).as_str());

        tokio::spawn(async move {
            let _ = accept_connection(&listener, &token).await;
        });

        let req = tokio_tungstenite::tungstenite::http::Request::builder()
            .uri(&url)
            .header("Host", "127.0.0.1")
            .header("Origin", "http://evil.com")
            .body(())
            .unwrap();

        let result = connect_async(req).await;
        assert!(result.is_err(), "connection from bad origin should fail");
    }
}
