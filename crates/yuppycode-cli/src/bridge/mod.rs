//! WebSocket bridge server for the Phase 2 Next.js frontend.
//!
//! The bridge exposes the existing `yuppycode-protocol` v2 messages over a
//! local WebSocket. It is intentionally separate from the core and protocol
//! crates so those remain UI/network-free.

use std::error::Error;

pub mod auth;
pub mod error;
pub mod handlers;
pub mod server;
pub mod state;

/// Arguments for the `yuppy bridge` subcommand.
#[derive(Debug, Clone, clap::Args)]
pub struct BridgeArgs {
    /// Host address to bind to. Loopback only by default; set explicitly
    /// to a different value only when the frontend is served from another
    /// machine on a trusted network.
    #[arg(long, default_value = "127.0.0.1")]
    pub host: String,

    /// TCP port to listen on.
    #[arg(long, default_value_t = 9090)]
    pub port: u16,
}

/// Run the WebSocket bridge server.
pub async fn run_bridge(args: BridgeArgs) -> Result<(), Box<dyn Error>> {
    // Enforce loopback-only by default because the handshake token is sent
    // over an unencrypted ws:// connection.
    if !is_loopback(&args.host) && !allow_non_loopback() {
        return Err(
            "bridge host must be a loopback address (127.0.0.1 or ::1) when using ws://. \
             Set YUPPY_BRIDGE_ALLOW_NON_LOOPBACK=1 to override."
                .into(),
        );
    }

    let token = auth::token_from_env_or_generate();
    // Print the token exactly once so the frontend can read it from the
    // process stderr. It is never logged again.
    eprintln!("bridge token: {}", token.as_str());

    let listener = tokio::net::TcpListener::bind((args.host.as_str(), args.port))
        .await
        .map_err(|e| format!("failed to bind to {}:{}: {e}", args.host, args.port))?;
    let addr = listener.local_addr()?;
    eprintln!("bridge listening on ws://{addr}");

    let cwd = std::env::current_dir().ok();
    let state = std::sync::Arc::new(state::BridgeState::new(cwd));
    state.load_defaults().await;
    // A second, private credential for the lead seat's conductor. It is
    // never printed; the bridge writes it only into the lead's MCP config.
    let conductor_token = auth::generate_token();
    // A wildcard bind (explicit non-loopback override) is still reachable
    // from this machine over loopback, which is all the conductor needs.
    let conductor_addr = if addr.ip().is_unspecified() {
        std::net::SocketAddr::new(std::net::Ipv4Addr::LOCALHOST.into(), addr.port())
    } else {
        addr
    };
    let _ = state.conductor.set(state::ConductorEndpoint::new(
        format!("ws://{conductor_addr}"),
        conductor_token.clone(),
    ));

    // Connections are served concurrently so the lead's conductor can talk
    // to the bridge while the operator's UI is connected — and every client
    // receives the same task-event broadcast. Operator (UI) connections are
    // still served one at a time: a newer UI waits for the previous one to
    // end, then the previous UI's seats are closed (see below).
    let operator_gate = std::sync::Arc::new(tokio::sync::Mutex::new(()));
    let token = std::sync::Arc::new(token);
    let conductor_token = std::sync::Arc::new(conductor_token);
    loop {
        let (stream, peer) = match listener.accept().await {
            Ok(conn) => conn,
            Err(e) => {
                eprintln!("bridge accept failed: {e}");
                tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                continue;
            }
        };
        let state = state.clone();
        let token = token.clone();
        let conductor_token = conductor_token.clone();
        let operator_gate = operator_gate.clone();
        tokio::spawn(async move {
            let (ws, role) =
                match server::handshake_stream(stream, &token, Some(&conductor_token)).await {
                    Ok(conn) => conn,
                    Err(e) => {
                        // A bad handshake, wrong token or protocol mismatch
                        // rejects only that connection.
                        eprintln!("bridge rejected connection: {e}");
                        return;
                    }
                };
            match role {
                handlers::ClientRole::Conductor => {
                    eprintln!("bridge conductor connected from {peer}");
                    let wake_rx = state.terminal_broadcast_tx.subscribe();
                    if let Err(e) = server::run_client_loop_as(ws, state, wake_rx, role).await {
                        eprintln!("bridge conductor error: {e}");
                    }
                }
                handlers::ClientRole::Operator => {
                    let _turn = operator_gate.lock().await;
                    eprintln!("bridge client connected from {peer}");

                    // The UI discards its session list on `connected`. Seats
                    // from the previous operator connection can never be
                    // addressed again, so close them here: otherwise every
                    // reconnect leaves more Claude Code TUIs (and
                    // their PTY masters) alive for the lifetime of the bridge.
                    let stale = {
                        let mut terminals = state.terminals.lock().await;
                        let count = terminals.len();
                        if count > 0 {
                            terminals.close_all();
                        }
                        count
                    };
                    if stale > 0 {
                        eprintln!(
                            "bridge: closed {stale} stale terminal session(s) from the previous client"
                        );
                    }

                    let wake_rx = state.terminal_broadcast_tx.subscribe();
                    if let Err(e) = server::run_client_loop_as(ws, state, wake_rx, role).await {
                        eprintln!("bridge client error: {e}");
                    }
                }
            }
        });
    }
}

fn is_loopback(host: &str) -> bool {
    host == "127.0.0.1" || host == "::1" || host == "localhost"
}

fn allow_non_loopback() -> bool {
    std::env::var("YUPPY_BRIDGE_ALLOW_NON_LOOPBACK")
        .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn loopback_addresses_are_recognized() {
        assert!(is_loopback("127.0.0.1"));
        assert!(is_loopback("::1"));
        assert!(is_loopback("localhost"));
        assert!(!is_loopback("0.0.0.0"));
        assert!(!is_loopback("192.168.1.1"));
    }
}
