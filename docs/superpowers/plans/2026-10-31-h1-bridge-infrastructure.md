# Milestone H1: WebSocket Bridge Infrastructure — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a local WebSocket bridge inside `yuppycode-cli` that exposes the existing `yuppycode-protocol` v2 messages to a Next.js frontend, with connection authorization, message routing to real Rust services, and verified end-to-end tests using real WebSocket connections.

**Architecture:** A `tokio-tungstenite` WebSocket server runs inside `yuppycode-cli` as the `yuppy bridge` subcommand. It accepts a single client connection on `127.0.0.1`, performs a handshake that verifies the protocol version and a locally-generated connection token, then translates `ClientRequest` JSON messages into calls on the existing `TerminalManager`, `Orchestrator`, and `HudStore` services. Outbound events are wrapped in `Envelope` and sent as JSON. No code in `yuppycode-core` or `yuppycode-protocol` depends on Ratatui, the frontend, or network code.

**Tech Stack:** Rust (`tokio-tungstenite`, `serde_json`, `tokio`), existing `yuppycode-protocol` v2, existing `yuppycode-cli` crate.

**Spec:** `docs/PHASE2_FRONTEND_DESIGN.md`, Section 2 (Bridge Architecture).

## Global Constraints

- Bridge must bind to `127.0.0.1` by default; host configurable via `--bridge-host`.
- Port must be configurable via `--bridge-port` (default `9090`).
- Only one frontend client may be connected at a time; a second connection is rejected cleanly.
- Protocol version mismatch must close the connection with a readable error.
- No secrets (API keys, tokens, credentials) are ever sent to the frontend over the bridge.
- Native Claude Code / Codex permission prompts must not be bypassed.
- All changes live inside `yuppycode-cli`; `yuppycode-core` and `yuppycode-protocol` remain UI/network-free.
- `cargo clippy --workspace --all-targets -- -D warnings` and `cargo fmt --check` must pass after each task.
- Origin header check is used as a defense-in-depth filter, not as authentication; a local connection token is required for authorization.

## Review Focus

1. **Connection token leak / replay:** A token written to disk or logged could let another local process connect. Test: token is only printed once at startup and never written to logs or env.
2. **Protocol version mismatch:** Older or newer frontend clients must be rejected. Test: sending a mismatched version in the handshake closes the socket with `ProtocolVersionMismatch`.
3. **Message deserialization failure:** Malformed JSON or unknown `type` must not crash the bridge. Test: garbage payload returns `Error` payload and keeps connection alive.
4. **Concurrent connections:** Two clients connecting at once must not share state or corrupt the terminal manager. Test: second connection is rejected while first is active.
5. **Service mutability across async boundaries:** `TerminalManager`, `HudStore`, and orchestrator state must be shared safely between the WebSocket task and message handlers. Test: spawn a terminal and submit a task over the bridge from separate messages; both complete without deadlock.

---

## File Structure

| File | Responsibility |
|------|----------------|
| `crates/yuppycode-cli/src/bridge/mod.rs` | Public bridge module: `run_bridge` entry point, argument parsing, server lifecycle. |
| `crates/yuppycode-cli/src/bridge/server.rs` | WebSocket accept loop, connection limit, handshake, inbound/outbound message pump. |
| `crates/yuppycode-cli/src/bridge/handlers.rs` | Dispatch table: `ClientRequest` → Rust service calls; builds `ServerPayload` responses. |
| `crates/yuppycode-cli/src/bridge/auth.rs` | Local connection token generation and verification; Origin header allow-list. |
| `crates/yuppycode-cli/src/bridge/error.rs` | Bridge-specific errors and their `ServerPayload::Error` mapping. |
| `crates/yuppycode-cli/src/bridge/tests.rs` | Integration tests using a real WebSocket client (`tokio-tungstenite`). |
| `crates/yuppycode-cli/src/main.rs` | Add `Command::Bridge(BridgeArgs)` and dispatch to `bridge::run_bridge`. |
| `crates/yuppycode-cli/Cargo.toml` | Add `tokio-tungstenite` dependency. |

---

## Task 1: Add bridge subcommand scaffolding and dependency

**Files:**
- Create: `crates/yuppycode-cli/src/bridge/mod.rs`
- Modify: `crates/yuppycode-cli/src/main.rs:32-57` (add `Bridge` variant)
- Modify: `crates/yuppycode-cli/Cargo.toml:37-38` (dev-deps may also need test helper)

**Interfaces:**
- Consumes: `RunArgs` pattern from CLI.
- Produces: `struct BridgeArgs { host: String, port: u16 }`; `fn run_bridge(args: BridgeArgs) -> Result<(), Box<dyn Error>>` stub.

- [ ] **Step 1: Add `tokio-tungstenite = "0.26"` to `Cargo.toml` dependencies.**
- [ ] **Step 2: Add `Bridge(BridgeArgs)` variant to `Command` enum and parse it with clap.**
  - `--host` default `"127.0.0.1"`
  - `--port` default `9090`
- [ ] **Step 3: Create `bridge/mod.rs` with a public `run_bridge` stub that logs "bridge starting on {}:{}" and returns `Ok(())`.**
- [ ] **Step 4: Dispatch `Command::Bridge` in `main()` to `bridge::run_bridge`.**
- [ ] **Step 5: Verify build and format.**
  - Run: `cargo build --bin yuppy`
  - Run: `cargo fmt --check`
  - Run: `cargo clippy --workspace --all-targets -- -D warnings`
  - Expected: all clean.
- [ ] **Step 6: Commit.**
  ```bash
  git add crates/yuppycode-cli/src/bridge/mod.rs crates/yuppycode-cli/src/main.rs crates/yuppycode-cli/Cargo.toml
  git commit -m "feat(cli/bridge): add yuppy bridge subcommand scaffolding"
  ```

---

## Task 2: Implement local connection authorization

**Files:**
- Create: `crates/yuppycode-cli/src/bridge/auth.rs`
- Modify: `crates/yuppycode-cli/src/bridge/mod.rs`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `pub struct ConnectionToken(String)` — opaque, random 32-byte hex.
  - `pub fn generate_token() -> ConnectionToken`
  - `pub fn verify_token(expected: &ConnectionToken, provided: &str) -> bool`
  - `pub fn allowed_origins() -> Vec<&'static str>` — returns `["http://localhost:*", "http://127.0.0.1:*", "https://tauri.localhost"]` for defense-in-depth.

- [ ] **Step 1: Write a failing test in `bridge/tests.rs` (create file) that asserts a generated token is 64 hex chars and `verify_token` accepts it and rejects a different string.**
- [ ] **Step 2: Run the test; expect failure because `auth.rs` does not exist.**
- [ ] **Step 3: Implement `auth.rs` using `rand::thread_rng` and `rand::RngCore::fill_bytes`.**
  - Token entropy: 32 random bytes → 64 hex chars.
  - `allowed_origins()` is a hardcoded allow-list for local development and future Tauri.
- [ ] **Step 4: Re-export `auth` module from `bridge/mod.rs`.**
- [ ] **Step 5: Run tests; expect pass.**
  - Run: `cargo test -p yuppycode-cli bridge::auth`
- [ ] **Step 6: Update `run_bridge` stub to generate a token on startup and print it to stderr exactly once.**
  - Format: `bridge token: <token>`
  - Frontend will read this from the process stderr and include it in the handshake.
- [ ] **Step 7: Commit.**
  ```bash
  git add crates/yuppycode-cli/src/bridge/auth.rs crates/yuppycode-cli/src/bridge/mod.rs crates/yuppycode-cli/src/bridge/tests.rs
  git commit -m "feat(cli/bridge): local connection token generation and verification"
  ```

---

## Task 3: Implement handshake protocol

**Files:**
- Create: `crates/yuppycode-cli/src/bridge/error.rs`
- Modify: `crates/yuppycode-cli/src/bridge/server.rs` (create file)
- Modify: `crates/yuppycode-cli/src/bridge/mod.rs`

**Interfaces:**
- Consumes: `ConnectionToken` from `auth.rs`; `Envelope`, `PROTOCOL_VERSION`, `ClientRequest`, `ServerPayload` from `yuppycode_protocol`.
- Produces:
  - `pub enum BridgeError { ProtocolVersionMismatch, Unauthorized, InvalidMessage, Service(String), Io(std::io::Error) }`
  - `impl From<BridgeError> for ServerPayload`
  - `async fn accept_connection(stream: TcpStream, token: ConnectionToken) -> Result<WebSocketStream, BridgeError>`
  - Handshake message shape:
    - Client sends: `{ "version": 2, "token": "..." }` as first text frame.
    - Server replies: `{ "type": "connected" }` on success or closes with error.

- [ ] **Step 1: Write a failing integration test in `bridge/tests.rs`:**
  - Start a listener on a random port, accept one connection, run handshake with correct token and version, expect `connected` reply.
- [ ] **Step 2: Run test; expect failure because `server.rs` and `error.rs` are missing.**
- [ ] **Step 3: Implement `error.rs` with `BridgeError` and `From` impls.**
- [ ] **Step 4: Implement `server.rs` with `accept_connection` that:**
  - Wraps raw TCP with `tokio_tungstenite::accept_async`.
  - Reads first text frame; parses JSON `{version, token}`.
  - Rejects if `version != PROTOCOL_VERSION` → close with `ProtocolVersionMismatch`.
  - Rejects if token invalid → close with `Unauthorized`.
  - Sends `ServerPayload::Connected` (add this variant to `ServerPayload` in `yuppycode-protocol`? **Decision:** use existing `Pong` or add a dedicated `Connected` variant. Since protocol v2 is additive, add `Connected` to `ServerPayload`.)
- [ ] **Step 5: Add `Connected` variant to `ServerPayload` in `crates/yuppycode-protocol/src/lib.rs` and bump no version (additive).**
- [ ] **Step 6: Re-export `server` from `bridge/mod.rs` and update `run_bridge` to bind to host/port, generate token, and call `accept_connection` in a loop (for now log and drop after handshake).**
- [ ] **Step 7: Run tests; expect pass.**
  - Run: `cargo test -p yuppycode-cli bridge::handshake`
- [ ] **Step 8: Add tests for version mismatch and bad token; expect rejection.**
- [ ] **Step 9: Commit.**
  ```bash
  git add crates/yuppycode-cli/src/bridge/error.rs crates/yuppycode-cli/src/bridge/server.rs crates/yuppycode-protocol/src/lib.rs crates/yuppycode-cli/src/bridge/mod.rs crates/yuppycode-cli/src/bridge/tests.rs
  git commit -m "feat(cli/bridge): WebSocket handshake with version and token checks"
  ```

---

## Task 4: Build bridge state container

**Files:**
- Create: `crates/yuppycode-cli/src/bridge/state.rs`
- Modify: `crates/yuppycode-cli/src/bridge/mod.rs`

**Interfaces:**
- Consumes: `TerminalManager`, `HudStore`, `DepartmentRegistry`, `LayoutModel` from existing crates.
- Produces:
  - `pub struct BridgeState { terminals: Mutex<TerminalManager>, hud: HudStore, departments: Mutex<DepartmentRegistry>, layout: Mutex<LayoutModel> }`
  - `impl BridgeState { pub fn new(cwd: Option<PathBuf>) -> Self; pub fn load_defaults(&self) -> Result<(), StoreError>; }`

- [ ] **Step 1: Write a test that creates `BridgeState`, loads defaults, and verifies default department count is 6.**
- [ ] **Step 2: Implement `state.rs` wrapping the services in `std::sync::Mutex` (bridge is single-threaded async; mutex is for shared mutable state across tasks).**
- [ ] **Step 3: Expose helper methods:**
  - `agent_inventory() -> Vec<AgentStatusDto>` using `yuppycode_agents::detect_all()`.
  - `departments() -> DepartmentRegistry` clone.
  - `layout() -> LayoutModel` clone.
- [ ] **Step 4: Run tests; expect pass.**
  - Run: `cargo test -p yuppycode-cli bridge::state`
- [ ] **Step 5: Commit.**
  ```bash
  git add crates/yuppycode-cli/src/bridge/state.rs crates/yuppycode-cli/src/bridge/mod.rs crates/yuppycode-cli/src/bridge/tests.rs
  git commit -m "feat(cli/bridge): shared state container for terminals, hud, and layout"
  ```

---

## Task 5: Implement request dispatch and outbound event pump

**Files:**
- Create: `crates/yuppycode-cli/src/bridge/handlers.rs`
- Modify: `crates/yuppycode-cli/src/bridge/server.rs`

**Interfaces:**
- Consumes: `BridgeState`, `ClientRequest`, `ServerPayload`.
- Produces:
  - `pub async fn handle_request(state: &BridgeState, req: ClientRequest) -> Vec<ServerPayload>`
  - `pub async fn run_client_loop(ws: WebSocketStream, state: Arc<BridgeState>, token: ConnectionToken) -> Result<(), BridgeError>`

- [ ] **Step 1: Implement handlers for read-only / stateless messages first:**
  - `Ping` → `Pong`
  - `OpenTerminal` → spawn via `TerminalManager`, return `TerminalOpened`, start pushing `TerminalScreen` updates.
  - `TerminalInput` / `TerminalResize` / `TerminalInterrupt` / `TerminalClose` → forward to active `TerminalSession`.
  - `DepartmentUpsert` / `DepartmentRemove` → update `BridgeState.departments` and persist via `HudStore`; return `DepartmentUpserted`.
  - `LayoutSave` / `LayoutLoad` → persist/load via `HudStore`; return `LayoutApplied`.
  - `TaskSubmit` / `TaskCancel` → forward to orchestrator (see Task 6).
- [ ] **Step 2: Implement `run_client_loop` that:**
  - Performs handshake.
  - Sends initial `AgentInventory`, current departments, and layout.
  - Spawns a tokio task to pump terminal screen updates from `BridgeState` to the WebSocket at up to 30 FPS (throttle by generation).
  - Reads incoming text frames, deserializes to `ClientRequest`, dispatches via `handle_request`, sends replies.
  - On error, sends `ServerPayload::Error` and continues; on fatal error or close, cleans up.
- [ ] **Step 3: Add integration test:**
  - Connect over real WebSocket, handshake, send `Ping`, receive `Pong` wrapped in `Envelope`.
- [ ] **Step 4: Add integration test:**
  - Connect, receive initial `AgentInventory` and department list.
- [ ] **Step 5: Run tests; expect pass.**
  - Run: `cargo test -p yuppycode-cli bridge::dispatch`
- [ ] **Step 6: Commit.**
  ```bash
  git add crates/yuppycode-cli/src/bridge/handlers.rs crates/yuppycode-cli/src/bridge/server.rs
  git commit -m "feat(cli/bridge): request dispatch and outbound event pump"
  ```

---

## Task 6: Wire task scheduler into bridge

**Files:**
- Modify: `crates/yuppycode-cli/src/bridge/handlers.rs`
- Modify: `crates/yuppycode-cli/src/bridge/state.rs`

**Interfaces:**
- Consumes: `yuppycode_orchestrator::{run_batch, CancelFlag, Limits, Task, ProcessTaskRunner}`.
- Produces:
  - `BridgeState` gains an `orchestrator: Arc<OrchestratorHandle>` where `OrchestratorHandle` holds channels to submit/cancel tasks.
  - `TaskSubmit` spawns an async task that runs `run_batch` and streams `TaskState`, `TaskIntegration`, `TaskConflict` payloads back to the frontend.

- [ ] **Step 1: Design a minimal `OrchestratorHandle`:**
  - `pub fn spawn(tasks: Vec<orc::Task>, limits: Limits) -> (Self, mpsc::Receiver<ServerPayload>)`
  - `pub fn cancel(&self)`
- [ ] **Step 2: Implement `TaskSubmit` handler:**
  - Convert `TaskSpecDto` into `orc::Task`.
  - Build `Limits` from department registry.
  - Spawn orchestrator in a tokio task; forward events to frontend via a channel.
- [ ] **Step 3: Implement `TaskCancel` handler:**
  - Look up running batch by task id; call `CancelFlag::cancel()`.
- [ ] **Step 4: Add integration test using `bash` as a fake agent (no auth required):**
  - Submit a task with `"cli": "bash"` is not supported by `AgentKind`; instead create a test-only `ProcessTaskRunner` that runs `/bin/echo` directly.
  - Verify `TaskState::Completed` and `TaskIntegration` are received.
- [ ] **Step 5: Document that `allowed_tools` and per-agent `model` are currently stored but not enforced by the orchestrator.**
- [ ] **Step 6: Run tests; expect pass.**
  - Run: `cargo test -p yuppycode-cli bridge::tasks`
- [ ] **Step 7: Commit.**
  ```bash
  git add crates/yuppycode-cli/src/bridge/handlers.rs crates/yuppycode-cli/src/bridge/state.rs
  git commit -m "feat(cli/bridge): task scheduler integration over WebSocket"
  ```

---

## Task 7: Final H1 verification and documentation

**Files:**
- Modify: `crates/yuppycode-cli/src/bridge/tests.rs`
- Modify: `docs/PHASE2_FRONTEND_DESIGN.md` (update H1 status if needed)
- Modify: `README.md` (add `yuppy bridge` usage)

- [ ] **Step 1: Add a comprehensive end-to-end test that:**
  - Starts `yuppy bridge` on a random port.
  - Connects a real WebSocket client.
  - Handshakes with correct protocol version and token.
  - Receives `AgentInventory` containing real `claude` and `codex` status (if installed) or honest `available: false`.
  - Receives department list with the 6 default departments.
  - Sends `Ping`, receives `Pong`.
  - Sends `OpenTerminal` for `claude-code` only if installed; otherwise verify the handler returns an honest `Error` payload (do not fake success).
- [ ] **Step 2: Run the full Rust verification battery.**
  - Run: `cargo test --workspace`
  - Run: `cargo clippy --workspace --all-targets -- -D warnings`
  - Run: `cargo fmt --check`
  - Expected: 120+ tests pass; no warnings; fmt clean.
- [ ] **Step 3: Manual smoke test.**
  - Run: `yuppy bridge --port 19090 &`
  - Run: `websocat ws://127.0.0.1:19090 -H "Origin: http://localhost:3000"` (requires token from stderr; this step documents expected behavior, not a hard test).
  - Verify the bridge rejects a connection without a token and accepts one with the token.
- [ ] **Step 4: Update `README.md` with `yuppy bridge` command and security notes.**
- [ ] **Step 5: Commit.**
  ```bash
  git add crates/yuppycode-cli/src/bridge/README.md crates/yuppycode-cli/src/bridge/tests.rs README.md
  git commit -m "docs(cli/bridge): H1 verification, tests, and usage docs"
  ```

---

## Allowed Tools / Model Constraints — Investigation Report

Before implementing `TaskSubmit`, the plan assumes the following (to be verified in Task 6):

- `Department::allowed_tools` and `AgentAssignment::model` are stored in `DepartmentRegistry` and serialized in `DepartmentDto`.
- `yuppycode-orchestrator::ProcessTaskRunner` currently does **not** read these fields; it only uses `Task.cli` to choose the program and passes `--model` only if `Task.model` is set.
- Therefore, the bridge must forward these values honestly in payloads but cannot claim they are enforced until the orchestrator is updated in a later milestone.
- The H1 implementation will document this gap in `handlers.rs` and will not fabricate enforcement.

---

## H1 Definition of Done

- [ ] `yuppy bridge --host 127.0.0.1 --port 9090` starts a WebSocket server.
- [ ] A real WebSocket client can handshake with protocol version 2 and the printed token.
- [ ] Protocol version mismatch and bad token are rejected.
- [ ] Second concurrent connection is rejected.
- [ ] `AgentInventory`, department list, and layout are sent automatically after handshake.
- [ ] `Ping` / `Pong`, `OpenTerminal`, `TerminalInput`, `TerminalResize`, `TerminalInterrupt`, `TerminalClose`, `DepartmentUpsert`, `DepartmentRemove`, `LayoutSave`, `LayoutLoad`, `TaskSubmit`, `TaskCancel` messages are handled by real Rust services.
- [ ] No secrets are sent to the frontend.
- [ ] Native CLI security prompts are not bypassed.
- [ ] `cargo test --workspace`, `cargo clippy`, `cargo fmt` pass.
- [ ] README documents `yuppy bridge` and the local token security model.
