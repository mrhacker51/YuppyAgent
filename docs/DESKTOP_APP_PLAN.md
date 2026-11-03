# YuppyCode / Jarvis Desktop — Architecture Report & Migration Plan

Date: 2026-11-02
Scope: turn the existing YuppyCode stack into a professional Linux desktop
application (Tauri 2 + Next.js) **without** rewriting or weakening the
existing Rust backend, CLI integrations, or orchestration.

---

## 1. What exists today (verified in code, not assumed)

### Rust workspace — `Cargo.toml` (13 crates, edition 2024, rust ≥ 1.85)

| Crate | Role (verified) |
| --- | --- |
| `yuppycode-cli` | `yuppy` binary: `run` (TUI), `chat`, `task`, `team`, `dept`, `msg`, `bridge`, `agents`. Hosts the **WebSocket bridge** (`src/bridge/`, ~2k LOC). |
| `yuppycode-terminal` | Real PTY layer (portable-pty + vt100): spawn, resize, input, exit codes/signals, wake-based snapshots. 8 tests. |
| `yuppycode-agents` | Claude Code + Codex adapters: CLI detection, argv, `spawn_interactive`, versions. **Untouched layer** (user directive). |
| `yuppycode-orchestrator` | Task planner, real `claude -p` / `codex exec` runner (exit codes, not keywords), git-worktree isolation, bounded concurrency. |
| `yuppycode-hud` | Department registry (6 defaults, CRUD, JSON persistence), layout model persistence. |
| `yuppycode-protocol` | Versioned v2 envelope: `ClientRequest` / `ServerPayload` DTOs (119 tests incl. compat). |
| `yuppycode-core`, `-providers`, `-tools`, `-mcp`, `-memory`, `-bus` | Engine, providers, tool exec, MCP, memory, team bus. |
| `yuppycode-tui` | Ratatui command center; the reference-board pane chrome (git facts, path badges) lives here. |

### Existing frontend — `ui/` (Next.js 16.4.3, React 19.3, TypeScript)

- **Real terminals already**: `TerminalPane.tsx` + `lib/term.ts` use **xterm.js 6** + fit addon; the backend PTY emulator sends full **cell snapshots** (`terminal_screen`, generation-counter dedup) and the pane converts cells→SGR; input is forwarded verbatim (`terminal_input`). No fake terminal.
- **State**: `lib/store.ts` (zustand, ~1.1k LOC) — WS client to `ws://127.0.0.1:9090`, token from `yuppy bridge` stderr (localStorage in browser flow), reconnect, session/task/department/log reducers.
- **Panels**: `AppShell`, `TerminalDock` (grid/focus), `MissionComposer`, `DepartmentsPanel`, `ActivityPanel`, `AgentsPanel`.
- **3D groundwork present**: `@react-three/fiber` + `drei` + `postprocessing` + `three` in deps (agent-universe milestone).
- **Tests**: `node --test` (`hud-*`, `terminal-sgr`), `eslint`, `next build` (port 3434 dev).

### Bridge protocol (already transport-agnostic)

- Requests: `Run`, `Cancel`, `Approval`, `SetModel`, `Ping`, `OpenTerminal{agent,label,department}`, `TerminalInput/Resize/Interrupt/Close`, `DepartmentUpsert/Remove`, `LayoutSave/Load`, `TaskSubmit`, `TaskCancel`.
- Payloads: `RunStarted`, `TextDelta`, `ReasoningDelta`, `RunFinished(status)`, `TaskUpsert`, `ToolStarted/Finished`, `ApprovalRequired`, `Log`, `Telemetry`, `Info`, `Error`, `TerminalOpened/TerminalScreen/TerminalClosed(exit)` — structured, session-id keyed.
- **Auth**: loopback bind, single-use random token printed once to stderr **or** `YUPPY_BRIDGE_TOKEN` env, constant-time verify, origin check as defense-in-depth. This is the documented, authenticated local IPC the spec asks for.

## 2. Assessment against the desktop spec

| Spec requirement | Status |
| --- | --- |
| Preserve Rust backend / CLIs / departments / tasks | ✅ already modular; we **add** a shell, we do not move code |
| Real streaming output, multiple sessions | ✅ bridge + xterm already deliver this |
| Session start/input/resize/close/exit codes | ✅ `OpenTerminal…TerminalClosed` |
| Cancel/orphan prevention | ✅ PTY killer + `Drop` SIGHUP; task cancel via `TaskCancel` |
| Worktree isolation / bounded parallelism | ✅ orchestrator (worktree flag) |
| Auth handling | ✅ bridge token; desktop adds **memory-only** token handoff |
| 3D agent universe | ◐ deps present, scene = milestone M5 |
| Desktop-native shell | ❌ the gap → Tauri 2 (this migration) |
| Panel resize/drag/hide/persist | ◐ grid/focus exists; free resize/drag = M3 |
| Inspector panel | ❌ task inspector = M4 (data already streams) |
| Design system (dark command center) | ◐ dark theme exists; polish = M2 |

## 3. Target architecture (decisions)

1. **Backend stays a sidecar.** `desktop/` Tauri shell spawns `yuppy bridge
   --host 127.0.0.1 --port <p>` as a supervised child (explicit argv, no
   shell), injects `YUPPY_BRIDGE_TOKEN=<generated>`, kills it on exit.
   No duplicate-process risk on reload: the child is owned by the Rust
   process, not the webview. (spec rules 1, 2, 8, 9)
2. **Transport**: the existing authenticated localhost WS. The Tauri command
   `bridge_config` hands `{url, token}` to the app's own webview; the token
   lives in memory only in desktop mode (never localStorage, never logged,
   never in a URL). Browser dev flow unchanged.
3. **Frontend**: reuse `ui/`. Packaged build = conditional **static export**
   (`NEXT_EXPORT=1 next build` → `ui/out`), because every component is
   `"use client"` + zustand (no server actions/routes). Dev stays
   `next dev` + `devUrl`. `cacheComponents` stays off in export mode.
4. **No new layout library**: the dock is CSS-grid + pointer resize/drag —
   three to six panes do not justify another dependency (evaluated; none
   present today). Revisit only if the dock grows docking semantics.
5. **Least privilege**: capabilities = `core:default` only; **no** shell/fs/
   http plugins; CSP allows `ws://127.0.0.1:*` for the bridge; child argv is
   fixed (`bridge --host --port`, env token); nothing from web input reaches
   a command line.
6. `desktop/` is a **standalone crate** (own lockfile, own target dir) so the
   main workspace never depends on webkit system libs.

## 4. Milestones

| # | Deliverable | Verification |
| --- | --- | --- |
| M1 | This report; Tauri 2 shell (`desktop/`): sidecar supervisor + `bridge_config` + window; conditional static export; `docs/DESKTOP_APP.md` | `cargo check/test` in `desktop/src-tauri`; `ui` lint+tests+export build; workspace untouched |
| M2 | Design tokens (near-black/charcoal, cyan/violet accents, restrained glow); global top bar from real state (workspace, git, task counts, view controls) | `ui` tests + build; typecheck |
| M3 | Dock: pointer resize/drag/hide/maximize; layout save/restore via existing `LayoutSave/Load` | component tests (`node --test`) |
| M4 | Inspector (right): task/agent/dept/status/dependencies/tool events/errors from `TaskUpsert`/`ToolStarted/Finished` only when present | tests |
| M5 | 3D agent universe from real departments/sessions (r3f), 2D fallback | manual + build |
| M6 | Packaging (deb/AppImage) + end-to-end live run with real Claude/Codex CLIs | `tauri build`; live checklist |

Progress (2026-11-03): **M1–M3 shipped.** M2's `engine` payload and M3's
`terminal-dock` pseudo-panel were both verified against a live `yuppy bridge`
(handshake, layout accept + echo). M4–M6 pending.

## 5. Environment notes (this machine, 2026-11-02)

- Ubuntu jammy; node 22.14, pnpm 9.15, cargo 1.99.
- Tauri Linux deps installed via apt over **https** (port 80 to
  archive.canonical.com is firewalled; `sources.list` switched to https —
  backup at `/etc/apt/sources.list.bak-yuppy`): `pkg-config`,
  `libwebkit2gtk-4.1-dev` (2.50.4), `libgtk-3-dev`, `librsvg2-dev`,
  `libssl-dev`.
- Disk pressure: freed npm/pnpm/uv/pip caches, playwright browser cache and
  `target/debug/incremental` (all regenerable). Watch `df -h /` before builds.
- `archive.canonical.com` unreachable → partner repos unavailable (not needed).

## 6. Security checklist (enforced in M1 code)

- [x] No `shell` plugin / no unrestricted command execution.
- [x] Sidecar argv fixed; user web input never interpolated into commands.
- [x] Bridge binds loopback; token random per launch, memory-only in desktop.
- [x] Capabilities: `core:default` only; CSP scoped to self + local WS.
- [x] Child killed on exit (`RunEvent::Exit`), `Drop` belt-and-braces.
