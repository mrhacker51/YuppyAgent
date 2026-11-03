//! `yuppy`: the YuppyCode backend binary.
//!
//! The Desktop app starts it as its sidecar (`yuppy bridge`) and the web UI
//! talks to that bridge over WebSocket. The other subcommands are plumbing
//! the bridge itself launches for the agent CLIs it hosts.

use clap::{CommandFactory, Parser, Subcommand};

mod bridge;
mod conductor;
mod terminals;

#[derive(Parser)]
#[command(
    name = "yuppy",
    version,
    about = "YuppyCode backend: the WebSocket bridge behind the Desktop app and web UI"
)]
struct Cli {
    #[command(subcommand)]
    command: Option<Command>,
}

#[derive(Subcommand)]
enum Command {
    /// Start the WebSocket bridge the Desktop app and web UI connect to.
    Bridge(bridge::BridgeArgs),
    /// Plumbing: stdio MCP server exposing the team bus to agent CLIs. The
    /// bridge wires it into every seat it puts on the bus.
    McpBus,
    /// Plumbing: stdio MCP server for the lead seat (team conductor). The
    /// bridge starts it for a lead Claude Code session; it connects back to
    /// the bridge and exposes yuppy_dispatch / yuppy_tasks / yuppy_cancel.
    ConductorMcp,
}

fn main() {
    let cli = Cli::parse();
    match cli.command {
        None => {
            let _ = Cli::command().print_help();
            println!();
        }
        Some(Command::Bridge(args)) => {
            let rt = tokio::runtime::Runtime::new().expect("tokio runtime");
            if let Err(e) = rt.block_on(bridge::run_bridge(args)) {
                eprintln!("bridge error: {e}");
                std::process::exit(1);
            }
        }
        Some(Command::McpBus) => run_mcp_bus(),
        Some(Command::ConductorMcp) => conductor::run_conductor_mcp(),
    }
}

/// `yuppy mcp-bus`: the stdio MCP server the agent CLIs connect to.
fn run_mcp_bus() {
    let me = yuppycode_bus::Identity::from_env();
    let served = yuppycode_bus::store::Bus::open(yuppycode_bus::store::default_bus_path())
        .map_err(|e| e.to_string())
        .and_then(|bus| yuppycode_bus::serve(bus, me).map_err(|e| e.to_string()));
    if let Err(e) = served {
        eprintln!("team bus server: {e}");
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_cli_definition_is_consistent() {
        Cli::command().debug_assert();
    }
}
