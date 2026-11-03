# Phase 2 Baseline Audit (Milestone A)

Date: 2026-10-31. This documents the verified state of Phase 1 before any
Phase 2 (command center) work begins.

## Verification results (measured on this machine)

| Check | Result |
|-------|--------|
| `cargo build --workspace` | ✅ clean (rustc 1.99.1) |
| `cargo test --workspace` | ✅ 64 tests passed, 0 failed |
| `cargo clippy --workspace --all-targets` | ✅ no warnings |
| `cargo fmt --check` | ✅ clean |
| `claude` CLI available | ✅ `/usr/local/bin/claude` — 2.1.316 |
| `codex` CLI available | ✅ `/usr/local/bin/codex` — codex-cli 0.166.0 |

Git note: the repository has **no commits yet** — the entire Phase 1 tree is
untracked on branch `master`. A baseline commit is strongly recommended before
Phase 2 changes land.

## Current working features (Phase 1)

### Workspace (8 crates, ~6.6k LoC Rust, edition 2024, MSRV 1.85)

- **`yuppycode-protocol`** — versioned serde wire types
  (`PROTOCOL_VERSION = 1`): `ClientRequest` (Run/Cancel/Approval/SetModel/Ping,
  `deny_unknown_fields`), `Envelope {version, seq, ts_ms}`, `ServerPayload`
  mirroring engine events. No UI/network/storage deps. Round-trip and
  unknown-field-rejection tests present.
- **`yuppycode-core`** — `AgentEngine` (814 LoC) with task graph, bounded
  `EventBus` of typed `AgentEvent`s, cooperative `CancelToken`, `ApprovalGate`
  trait, traits for `ModelProvider` / `ToolExecutor` / `Memory`. Explicit
  contract (crate docs): **no UI, HTTP, SQLite, or process dependencies**.
- **`yuppycode-providers`** — OpenAI-compatible SSE streaming adapter with
  incremental tool calls; offline `simulated` demo provider.
- **`yuppycode-tools`** — JSON-Schema subset validation, workspace-contained
  file tools, argv-style shell (opt-in), tool registry, risk policy, MCP tool
  bridge. Security tests for path traversal / symlink escape.
- **`yuppycode-mcp`** — MCP stdio client: lifecycle, tool discovery, invocation.
- **`yuppycode-memory`** — SQLite (bundled) persistence, pruning, audit events;
  lazy open on first access.
- **`yuppycode-tui`** — Ratatui dashboard: view-model separated from render,
  focus cycling, approval prompts, telemetry.
- **`yuppycode-cli`** — `yuppy` binary: env-first config, one-shot `chat`,
  integration tests for containment/security paths.

### Boundaries relevant to Phase 2

- Engine events already serialize 1:1 to `ServerPayload` — a transport bridge
  only needs `AgentEvent → Envelope → bytes`.
- Core must stay free of Ratatui/reqwest/rusqlite/process I/O (crate docs +
  ARCHITECTURE.md). New Phase 2 crates must obey the same rule.
- `docs/ARCHITECTURE.md` describes the planned transport bridge and Tauri
  sidecar reuse.

## Gaps against the Phase 1.5 spec

1. **No terminal-session abstraction** — nothing spawns or hosts a PTY today;
   the only process I/O is MCP stdio and tool `shell` (piped, capped).
2. **No CLI adapters** for Claude Code / Codex (detect, version, launch).
3. **No departments, HUD layout model, or persistence for either.**
4. **No Jarvis-level scheduler** — the engine runs one conversation loop;
   there is a `TaskGraph` but no multi-agent dispatch or bounded concurrency.
5. **Protocol v1 has no terminal/department/layout message types.**
6. **No baseline git commit.**

## Environment constraints observed

- Platform: Linux (development). Windows/ConPTY paths can be written behind
  cfg gates but **cannot be verified on this machine** — spec §8 says do not
  claim unverified platform support.
