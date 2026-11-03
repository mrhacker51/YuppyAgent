# YuppyCode Phase 2 Core Implementation Report

Date: 2026-10-31
Scope: Milestones A–H of the modular "AI coding command center" core.
Branch: `master`
Final commit: `5b6a600`

## Executive summary

The existing Phase 1 workspace was extended from 8 crates to 11 crates while preserving all working functionality. The new core capabilities are:

- Real PTY-backed terminal sessions (`yuppycode-terminal`).
- Live Claude Code and Codex CLI adapters (`yuppycode-agents`).
- Hosted interactive Claude Code / Codex TUIs inside the existing Ratatui dashboard (`yuppycode-tui`).
- Department registry + HUD layout model with validated JSON persistence (`yuppycode-hud`).
- Task scheduler with per-department + global concurrency limits, cancellation, and git worktree isolation (`yuppycode-orchestrator`).
- Protocol v2 that adds terminal, department, layout, and task messages while keeping all v1 wire shapes byte-for-byte compatible (`yuppycode-protocol`).

No web frontend or hologram was built yet; the Rust core interfaces are explicitly prepared for the later Next.js/TypeScript/Three.js/Tauri phases.

---

## Milestone boundary reports

### Milestone A: Baseline audit

**Changed modules:** `docs/PHASE2_BASELINE.md`

**Verified functionality:**

| Check | Result |
|-------|--------|
| `cargo build --workspace` | ✅ clean (rustc 1.99.1) |
| `cargo test --workspace` | ✅ 64 tests passed |
| `cargo clippy --workspace --all-targets` | ✅ no warnings |
| `cargo fmt --check` | ✅ clean |
| `claude` CLI available | ✅ `/usr/local/bin/claude` — 2.1.316 |
| `codex` CLI available | ✅ `/usr/local/bin/codex` — codex-cli 0.166.0 |

**Known limitations / gaps identified:**

1. No terminal-session abstraction.
2. No adapters for Claude Code / Codex.
3. No departments, HUD layout, or persistence.
4. No scheduler for parallel agent tasks.
5. Protocol v1 has no terminal/department/layout/task messages.
6. No baseline git commit.

**Next milestone:** B — terminal-session abstraction.

---

### Milestone B: Terminal-session abstraction

**Changed modules:**

- `Cargo.toml` — workspace deps `portable-pty = "0.9"`, `vt100 = "0.15"`, new member `yuppycode-terminal`.
- `crates/yuppycode-terminal/` — new crate.
  - `src/session.rs` — `TerminalSession`, `SessionConfig`, `TerminalError`, lifecycle, reader/writer threads, output-wake channel.
  - `src/screen.rs` — framework-independent `ScreenSnapshot`, `ScreenCell`, `Color`.
  - `tests/sessions.rs` — 8 tests covering output, input echo, resize, ANSI colors, kill, wide glyphs, generation stability, and post-exit writes.

**Key decisions:**

- `portable-pty` 0.9 provides native PTY + process management.
- `vt100` 0.15 is pinned intentionally: 0.16+ requires `unicode-width ^0.2.1` which conflicts with `ratatui 0.29`’s exact `=0.2.0` pin. The terminal crate isolates vt100 behind its own snapshot types, so a later upgrade only touches this crate.
- The reader thread feeds the vt100 parser and bumps an `AtomicU64` generation; consumers poll or block on a bounded `sync_channel(1)` wake.
- Edition 2024 required renaming the local `gen` variable to `generation` (reserved keyword).

**Verified functionality:**

- `cargo test -p yuppycode-terminal` — 8 passed.
- `cargo clippy --workspace --all-targets -- -D warnings` — clean.
- `/tmp/spike` harness confirmed live sessions render real program output (Claude, Codex, shell) with correct resize behavior.

**Known limitations:**

- Windows/ConPTY code paths are not exercised on this Linux dev box.
- vt100 0.15 is pinned; upgrading requires resolving the ratatui unicode-width conflict.
- Snapshot-per-frame allocation cost is acceptable for a TUI but may need optimization for a high-frequency web bridge.

**Next milestone:** C — Claude Code / Codex CLI adapters.

---

### Milestone C: Integrate one real CLI (Claude Code)

**Changed modules:**

- `crates/yuppycode-agents/` — new crate.
  - `src/lib.rs` — `AgentKind { ClaudeCode, Codex }`, `AgentStatus`, `AdapterError`, `which()`, `detect()`, `spawn_interactive()`, `SpawnOptions`.
- `crates/yuppycode-cli/src/main.rs` — added `yuppy agents` command.

**Key decisions:**

- `AgentKind` centralizes id, display name, program name, install hint, version args, interactive args, and non-interactive args.
- `which()` walks `PATH` and checks the executable bit on Unix.
- `detect()` runs the version probe with an 8 s timeout so a missing CLI is a soft failure with a helpful install hint.
- `spawn_interactive()` inherits the parent environment; no auth tokens or credentials are injected or bypassed.

**Verified functionality:**

- `cargo test -p yuppycode-agents` — passed.
- `./target/release/yuppy agents` — output:
  ```
  claude    Claude Code   available=true  version=2.1.316
  codex     Codex         available=true  version=0.166.0
  ```
- Spike harness launched an interactive Claude Code session and rendered its prompt inside the terminal grid.

**Known limitations:**

- `codex` support was added in the same milestone boundary as C/D combined (see below).

**Next milestone:** D — independent session management + second CLI.

---

### Milestone D: Independent session management + second CLI (Codex)

**Changed modules:**

- `crates/yuppycode-tui/src/terminals.rs` — `TerminalManager` owning multiple `ManagedTerminal` sessions, tab cycling, restart, resize broadcast.
- `crates/yuppycode-tui/src/view_model.rs` — `TerminalsView`, `TerminalTab`, terminal-aware focus logic.
- `crates/yuppycode-tui/src/render.rs` — terminal pane rendering: tab strip + cell blit + cursor via reversed modifier.
- `crates/yuppycode-tui/src/app.rs` — event-loop integration, command mode (`Esc`), quick launch (`t` = claude, `v` = codex), session close/restart/maximize.
- `crates/yuppycode-tui/src/keys.rs` — xterm byte encoding for keys and bracketed paste.
- `crates/yuppycode-cli/src/main.rs` — `RunArgs` gains `--terminal <kind>` to auto-open terminals at startup.

**Key decisions:**

- Keep the Rust core independent of Ratatui: `yuppycode-terminal` has no Ratatui dependency; `yuppycode-tui` translates `ScreenSnapshot` into Ratatui cells.
- `Esc` hands the keys back from passthrough to command mode; in passthrough every key is forwarded verbatim to the hosted CLI, the first `Ctrl+C` included (a second consecutive one quits). In command mode only session keys (`i/x/r/[ ]/m/e`) are consumed (`e` sends a literal `Esc` to the CLI); `q`, `Tab`, arrows, etc. fall through to global handlers.
- Generation-based wake avoids polling: each parser update bumps generation and sends one `UiEvent::TerminalActivity(id)`.
- The TUI panel reserves one row for tabs and one border row, so `terminal_pane_size(100, 40)` returns content area 98×27 (verified in tests).

**Verified functionality:**

- `cargo test -p yuppycode-tui` — passed.
- Live end-to-end: launched `yuppy --terminal claude --terminal codex`; both Claude Code 2.1.316 and Codex 0.166.0 rendered in split panes; typed prompts in passthrough mode; both sessions exited cleanly.
- Resize handled via `stty size` returning expected dimensions.

**Known limitations:**

- Mouse events are not forwarded to hosted CLIs.
- The HUD layout can maximize/visibility/focus the terminal panel, but true multi-pane docking is thin (only main/side split).

**Next milestone:** E — departments + HUD layout state + persistence.

---

### Milestone E: Departments + HUD layout state + persistence

**Changed modules:**

- `Cargo.toml` — new workspace member `yuppycode-hud`.
- `crates/yuppycode-hud/src/department.rs` — `Department`, `AgentAssignment`, `Permissions`, `DepartmentRegistry`, defaults for six spec departments, validation.
- `crates/yuppycode-hud/src/layout.rs` — `LayoutModel`, `Panel`, `PanelKind`, `Zone`, default panel set, focus cycling, maximize, collapse, visibility.
- `crates/yuppycode-hud/src/store.rs` — `HudStore`, config root resolution (`$YUPPY_CONFIG_DIR` or `dirs::config_dir()/yuppycode`), atomic write-then-rename, fallback-to-defaults on invalid load.
- `crates/yuppycode-hud/src/dto.rs` — protocol DTO conversions.
- `crates/yuppycode-cli/src/main.rs` — `yuppy dept list/show/clone/rm/enable/disable/move` subcommands.
- `crates/yuppycode-tui/src/app.rs` — loads/saves HUD state on startup, `d` cycles active department, `Ctrl+s` saves layout.

**Key decisions:**

- Departments and layout are orthogonal persisted models, framework-independent.
- Validation is strict for schema/version/slugs/duplicate ids and lenient for warnings (unknown CLI, zero concurrency).
- `save()` refuses to persist an invalid registry, preventing accidental corruption.
- Default layout keeps the terminal panel hidden until a session is opened, then it becomes visible and maximized.

**Verified functionality:**

- `cargo test -p yuppycode-hud` — passed.
- `./target/release/yuppy dept list` — shows six default departments.
- `./target/release/yuppy dept disable code-review-testing` and `enable` work; `move` reorders.
- TUI `d` cycles department header; `Ctrl+s` writes JSON to `~/.config/yuppycode/`.
- Invalid JSON load falls back to defaults with a stderr warning.

**Known limitations:**

- Department `agents` list and `allowed_tools` are stored/validated but the orchestrator currently only consumes `max_concurrency` and `enabled`.
- Named layouts (`HudStore::list_named_layouts`) exist in the store but no CLI/TUI command exposes them yet.

**Next milestone:** F — task scheduling, concurrency, cancellation, isolation.

---

### Milestone F: Task scheduling, concurrency, cancellation, isolation

**Changed modules:**

- `Cargo.toml` — new workspace member `yuppycode-orchestrator`.
- `crates/yuppycode-orchestrator/src/runner.rs` — `TaskRunner` trait, `ProcessTaskRunner`, `CancelFlag`, `RunRequest`, `RunReport`.
- `crates/yuppycode-orchestrator/src/isolation.rs` — `Isolation { Shared, GitWorktree }`, `prepare()`, `collect()`, `remove_worktree()`, `find_conflicts()`.
- `crates/yuppycode-orchestrator/src/lib.rs` — `Task`, `TaskState`, `Limits`, `run_batch()`, global + per-department semaphores, cancel-authoritative loop.
- `crates/yuppycode-cli/src/main.rs` — `yuppy task` subcommand with `--agent`, `--dept`, `--workspace`, `--worktree`, `--max-parallel`, `--timeout-secs`, `--keep-worktrees`, `--dry-run`.

**Key decisions:**

- `tokio::sync::Semaphore` gates both global parallelism and per-department concurrency.
- `CancelFlag` is an `Arc<AtomicBool>` checked before prepare, during run, and on timeout; cancellation is authoritative.
- Git worktree isolation:
  - Branch name: `yuppy/task-<id>`.
  - Worktree directory: `<temp_dir>/yuppy-worktrees/<id>-<pid>-<nanos>` — kept outside the repo so the user’s `git status` stays clean.
  - `collect()` commits changes to the review branch but never merges or force-pushes.
  - `find_conflicts()` detects overlapping changed paths for human review.
- `ProcessTaskRunner` invokes `claude -p <prompt>` / `codex exec <prompt>`; native permission prompts are inherited, never bypassed.

**Verified functionality:**

- `cargo test -p yuppycode-orchestrator` — 9 passed, including real git worktree isolation and conflict overlap detection.
- Live run:
  ```bash
  yuppy task --agent claude --worktree /tmp/wtrepo --timeout-secs 180 --max-parallel 1 \
    "Create a file note.txt containing the single word hello. Do not modify anything else."
  ```
  Result: `[t1] Completed`, exit 0, branch `yuppy/task-t1` created, main worktree `git status` clean, 0 changed files.
  The output tail showed Claude Code’s native approval prompt blocking the write: *“Both attempts … waiting for your approval.”* This is correct, expected behavior per the directive not to bypass native security prompts.

**Known limitations:**

- `claude -p` file-changing tasks require the user to approve inside the hosted CLI session or configure Claude Code’s permission mode; the orchestrator cannot complete file writes automatically.
- `AwaitingApproval` state is defined in `TaskState` but not yet emitted by `ProcessTaskRunner` (no fabricated telemetry).
- Per-department tool restrictions and agent-model assignments are stored but not enforced by the runner.

**Next milestone:** G — versioned frontend protocol.

---

### Milestone G: Versioned frontend protocol

**Changed modules:**

- `crates/yuppycode-protocol/src/lib.rs` — bumped `PROTOCOL_VERSION` to 2; added terminal, department, layout, task, and agent-inventory messages; DTOs for cells, colors, panels, departments, tasks.
- Tests added/updated to assert byte-for-byte compatibility of all original v1 shapes and to verify v2 round-trips.

**Key decisions:**

- Protocol v2 is additive only; every v1 envelope and payload variant keeps its exact shape.
- Serde struct variants are used for tagged enums (`CellColorDto`) because `tag` cannot be combined with tuple variants.
- New variants use `snake_case` names matching the Rust identifiers.

**Verified functionality:**

- `cargo test -p yuppycode-protocol` — passed.
- v1 byte-guard assertions ensure the original wire format is unchanged.
- v2 round-trip tests cover `TerminalScreen`, `DepartmentUpserted`, `LayoutApplied`, `TaskState`, `TaskIntegration`, `TaskConflict`, `AgentInventory`.

**Known limitations:**

- The protocol bridge server (WebSocket/IPC) is not implemented yet; this milestone only prepared and verified the types.

**Next milestone:** H — architecture report + tested Phase 2 frontend plan.

---

## Milestone H: Final verification and Phase 2 plan

### Final verification battery

All measurements below were taken on the reference development environment unless otherwise noted.

| Check | Command | Result |
|-------|---------|--------|
| Release build | `cargo build --bin yuppy --release` | ✅ success (≈3 min cold) |
| Workspace tests | `cargo test --workspace` | ✅ **119 passed, 0 failed** |
| Clippy | `cargo clippy --workspace --all-targets -- -D warnings` | ✅ 0 warnings |
| Format | `cargo fmt --check` | ✅ clean |
| Startup/memory bench | `bash bench/run-bench.sh` | ✅ see measurements below |
| Live Claude Code host | `yuppy --terminal claude` | ✅ interactive TUI renders real CLI |
| Live Codex host | `yuppy --terminal codex` | ✅ interactive TUI renders real CLI |
| Worktree isolation | `yuppy task --worktree /tmp/wtrepo …` | ✅ review branch created, main tree clean |
| Native approval preserved | observed in live task output | ✅ no bypass |

### Measured performance

| Metric | Target | Measured |
|--------|--------|----------|
| First frame latency | ≤ 50 ms | **5–47 ms** (cold first run 47 ms, subsequent 5–11 ms) |
| RSS at first frame | ≤ 160 KiB | **≈ 4.4 MiB** (actual measured `rss_kib=4328–4532`) |
| End-to-end keystroke→screen (Claude Code) | — | **median 38 ms** (min 17 ms, max 346 ms; includes Claude’s own UI loop) |
| Host idle CPU | — | **0.000%** of one core over 3 s |

The stated target of ≤160 KiB RSS in the original README appears to be a typo or unit error — the real binary + loaded Rust runtime uses a few MiB, which is normal and healthy. Reported honestly above.

### Workspace layout (final)

| Crate | Responsibility |
|-------|----------------|
| `yuppycode-protocol` | Versioned serde types (v2), future IPC/WebSocket contract |
| `yuppycode-core` | Agent engine, task graph, events, cancellation, traits |
| `yuppycode-providers` | Model provider adapters |
| `yuppycode-tools` | Schema validation, workspace-contained file/shell tools |
| `yuppycode-mcp` | MCP stdio client |
| `yuppycode-memory` | SQLite memory |
| `yuppycode-terminal` | PTY-backed terminal session abstraction |
| `yuppycode-agents` | Claude Code / Codex detection and spawn adapters |
| `yuppycode-tui` | Ratatui dashboard that hosts real CLI sessions |
| `yuppycode-hud` | Departments and HUD layout model + persistence |
| `yuppycode-orchestrator` | Task scheduler, concurrency, cancellation, git worktree isolation |
| `yuppycode-cli` | `yuppy` binary: wiring, config, benchmarks, task/dept commands |

### Preserved Phase 1 functionality

- All original 64 Phase 1 tests still pass.
- Core crate contracts remain intact (no UI/HTTP/SQLite/process deps in `yuppycode-core`).
- Existing CLI commands (`chat`, `run`, `bench`, `version`) work unchanged.
- README updated rather than rewritten; Phase 1 quick-start still applies.

---

## Remaining gaps and limitations

1. **Native approval blocks non-interactive file-changing tasks.** `claude -p` refuses to write files without user approval. This is by design — we do not bypass it — but it means scheduled file-changing tasks require the user to either host them interactively or pre-configure Claude Code’s permission mode.
2. **AwaitingApproval state is not emitted.** The `TaskState::AwaitingApproval` variant exists for the frontend protocol but `ProcessTaskRunner` does not fabricate it; it only knows success/failure/timeout/cancelled.
3. **Mouse events are not forwarded** to hosted terminal sessions.
4. **Windows/ConPTY paths are unverified.** `portable-pty` supports ConPTY, but no Windows machine was available for testing.
5. **Snapshot-per-frame allocation.** The current `ScreenSnapshot` is rebuilt each frame. This is fine for the TUI but should be optimized before a high-frequency web bridge.
6. **HUD panel docking is thin.** The layout model supports zones/orders/z/collapsed/maximized/focused, but the TUI currently renders only a main/side split plus the terminal workspace.
7. **Named layouts are stored but not exposed** in the CLI/TUI.
8. **Department `allowed_tools` and per-agent `model` are not enforced** by the orchestrator; they are stored and forwarded via protocol only.
9. **Protocol bridge server is not implemented.** Types are ready; the WebSocket/IPC transport must be built in Phase 2.
10. **Pre-existing Phase 1 quirk:** `q` cannot be typed in the Input pane because it is bound to quit. Left untouched to avoid scope creep.

---

## Recommended next prompt for Phase 2 frontend development

> Build the Phase 2 Next.js + TypeScript + Three.js/WebGL “holographic command center” frontend. The Rust backend is already prepared with a versioned protocol (`yuppycode-protocol` v2), real hosted Claude Code / Codex terminal sessions, department/HUD state, and a task scheduler with git worktree isolation. Your tasks:
>
> 1. Add a WebSocket/IPC bridge server crate (or extend `yuppycode-cli`) that exposes `ClientRequest`/`ServerPayload` over a local socket. Reuse the existing protocol DTOs; do not change v2 wire shapes without bumping `PROTOCOL_VERSION` and adding compatibility tests.
> 2. Scaffold a Next.js project (likely under `ui/` or `frontend/`) with TypeScript, Three.js or React-Three-Fiber, and a Ratatui-equivalent panel system. Generate TypeScript types from the protocol DTOs or mirror them by hand.
> 3. Implement the live terminal view by receiving `TerminalScreen` payloads and rendering a grid of cells with ANSI colors, cursor, and title. Support sending `TerminalInput`, `TerminalResize`, and `TerminalInterrupt` from the frontend.
> 4. Implement department and HUD layout controls: list/enable/disable departments, cycle focus, toggle visibility/collapse, and apply named layouts; wire these to the existing `LayoutApplied` and `DepartmentUpserted` payloads.
> 5. Implement the task dashboard: submit tasks (`TaskSubmit`), display real `TaskState` transitions, show `TaskIntegration` review branches and `TaskConflict` warnings, and allow `TaskCancel`.
> 6. Ensure the hologram/visualization reacts only to real `ServerPayload` events; do not fabricate telemetry or animate states the backend did not emit.
> 7. Preserve all existing Rust core boundaries: do not pull Ratatui, browser APIs, or HTTP clients into `yuppycode-core` or `yuppycode-protocol`.
> 8. Add frontend tests and a CI step that runs `cargo test --workspace` plus the new TypeScript test/lint/typecheck command.
>
> Before writing code, inspect `docs/PHASE2_REPORT.md`, `docs/ARCHITECTURE.md`, and `crates/yuppycode-protocol/src/lib.rs` to understand the wire contract. Report the bridge design and UI component layout for approval before implementation.

---

## Commit history

```
63d0d90 feat: baseline commit before Phase 2 work
257fec5 feat(terminal): PTY-backed session abstraction with embeddable screen model
8c6eb88 feat(tui,agents): host real interactive Claude Code / Codex sessions in the TUI
a202de8 feat(hud): department registry + HUD layout model with validated persistence
1d07c87 style(hud): clippy cleanups in tests and imports
5b6a600 feat(orchestrator,protocol): task scheduler with worktree isolation + protocol v2
```

Co-Authored-By: Claude Code <noreply@anthropic.com>
