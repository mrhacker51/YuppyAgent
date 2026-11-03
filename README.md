# YuppyCode — AI Coding Command Center

YuppyCode is a coding-agent command center. You use it through the **Desktop
app** (Tauri, `desktop/`) or the **web UI** (Next.js, `ui/`). Both talk to the
same Rust backend, `yuppy bridge`, over a versioned WebSocket protocol. The
bridge hosts real Claude Code sessions in PTYs, keeps departments and the HUD
layout, and runs parallel Claude Code worker tasks in isolated git worktrees.

There is no interactive terminal UI any more: `yuppy` is the backend binary.

## Quick start

### Desktop app

```bash
bash scripts/build_bundles.sh     # builds `yuppy`, copies it as the sidecar, bundles the app
```

The desktop shell starts `yuppy bridge --host 127.0.0.1 --port <free port>`
itself as its sidecar (`desktop/src-tauri/src/sidecar.rs`, `externalBin`
`binaries/yuppy` in `tauri.conf.json`) and hands the UI a fresh, memory-only
token. Nothing to start by hand. See [docs/DESKTOP_APP.md](docs/DESKTOP_APP.md).

### Web UI (development)

```bash
# terminal 1 — the bridge (a fixed token makes local pairing easy)
cargo build -p yuppycode-cli
YUPPY_BRIDGE_TOKEN=dev-token-123 ./target/debug/yuppy bridge --port 9090

# terminal 2 — the web UI
cd ui
npm install
NEXT_PUBLIC_BRIDGE_TOKEN=dev-token-123 npm run dev
```

Then open `http://localhost:3434`. While the bridge is offline the UI shows a
`DEMO / OFFLINE` badge and placeholder HUD data.

## The `yuppy` binary

| Subcommand | Who runs it |
|------------|-------------|
| `yuppy bridge [--host 127.0.0.1] [--port 9090]` | The Desktop app (sidecar) or you, for the web UI |
| `yuppy conductor-mcp` | The bridge, as the MCP server of the lead Claude Code seat (`yuppy_dispatch`, `yuppy_tasks`, `yuppy_cancel`, `yuppy_roster`, `yuppy_team_log`) |
| `yuppy mcp-bus` | The bridge, as the team-bus MCP server the workers of a multi-task batch share (`yuppy_team`, `yuppy_send`, `yuppy_inbox`, `yuppy_wait`, `yuppy_history`) |

`yuppy` with no arguments prints help; `yuppy --version` prints the version.

## Workspace layout

| Crate | Responsibility |
|-------|----------------|
| `yuppycode-protocol` | Versioned serde types for the WebSocket transport |
| `yuppycode-cli` | The `yuppy` binary: WebSocket bridge, hosted PTY sessions (`terminals.rs`), lead conductor MCP server, team-bus MCP entry point |
| `yuppycode-terminal` | PTY-backed terminal sessions with an embeddable ANSI screen model |
| `yuppycode-agents` | Claude Code detection and spawn adapters (argv, MCP wiring) |
| `yuppycode-orchestrator` | Task scheduler, concurrency, cancellation, git worktree isolation |
| `yuppycode-hud` | Department registry + HUD layout model + JSON persistence |
| `yuppycode-bus` | Team message bus (SQLite inboxes, blocking wait) + its stdio MCP server |
| `yuppycode-mcp` | MCP protocol versions and stdio client |
| `yuppycode-core`, `yuppycode-providers`, `yuppycode-tools`, `yuppycode-memory` | Built-in LLM agent engine, provider adapters, sandboxed tools and SQLite memory. Not used by the `yuppy` binary at the moment |

## Configuration

| Variable | Meaning |
|----------|---------|
| `YUPPY_BRIDGE_TOKEN` | Connection token for the bridge (generated and printed when unset; the Desktop app always passes its own) |
| `YUPPY_BRIDGE_ALLOW_NON_LOOPBACK` | Allow `--host` other than loopback (trusted networks only) |
| `YUPPY_CONFIG_DIR` | Department/layout config dir (default: platform config dir under `yuppycode/`) |
| `YUPPY_BUS` | Team-bus SQLite file (default: `<config dir>/yuppycode/team.sqlite3`) |

## Provider: Lisans Ofisi gateway

Claude Code runs against the Lisans Ofisi API gateway
(`https://claude.lisansofisi.com`, `sk-lo-…` key). `~/.claude/settings.json`
pins `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN` and lists the gateway's
models in `modelPicker`, so plain `claude` + `/model` shows them. Default
model: `claude-sonnet-5-5`. The gateway has no `/v1/messages/count_tokens`;
Claude Code ignores that 404. Remaining quota:
`https://claude.lisansofisi.com/usage/<token>`.

## Security model

- The bridge binds to loopback by default and requires the connection token
  on every WebSocket.
- Parallel workers never silently overwrite each other: tasks can run in
  private `git worktree` checkouts of `HEAD`; each task's work is committed to
  a `yuppy/task-<id>` review branch. Nothing is merged automatically and your
  checked-out branch is never touched.
- Claude Code's native permission prompts are preserved. Seats pre-allow
  **only** YuppyCode's own MCP tools (`mcp__yuppy`, `mcp__yuppy-conductor`),
  never `--dangerously-skip-permissions` or a bypass mode; file, shell and
  network permissions keep their native prompts.
- Secrets are never logged or passed on argv (the Desktop app hands the token
  to the sidecar through the environment).

## Testing

```bash
cargo test --workspace
cargo clippy --workspace --all-targets
cargo fmt --check
cd ui && npm test
```

The bridge is covered end to end by `crates/yuppycode-cli/tests/`
(`bridge_parallel.rs`: one `task_submit` batch really runs in parallel;
`lead_conductor.rs`: the lead seat dispatches workers through
`yuppy conductor-mcp`; `mcp_bus.rs`: the `yuppy mcp-bus` wire contract), all
with stub `claude` executables so no model or account is touched.

## Limitations

- Windows/ConPTY paths are written behind cfg gates but unverified on this
  Linux development machine.
- Department `allowed_tools` and per-agent `model` are stored and exposed over
  the protocol but not yet enforced by the task scheduler.
- Worktrees branch from `HEAD`, so uncommitted local work is not visible to
  worker tasks; commit first or use shared isolation.
- The team bus is local to one machine and one user.

## License

MIT — see `Cargo.toml` for crate metadata.
