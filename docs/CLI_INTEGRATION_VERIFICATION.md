# Claude Code / Codex integration: source map and verification

> **Historical (2026-11).** The ratatui TUI (`crates/yuppycode-tui`), the
> user-facing `yuppy` commands (`task`, `team`, `msg`, `dept`, …) and Codex
> support have been removed. Hosted sessions now live in
> `crates/yuppycode-cli/src/terminals.rs` (the bridge's `TerminalManager`);
> the only front-ends are the Desktop app and the web UI in `ui/`, and every
> seat runs Claude Code. The rest of this page describes the old layout.

Audience: anyone changing the TUI. This documents **which files actually launch
and manage the two external CLIs**, what now guards them, and what has been
verified against the real binaries rather than assumed.

## 1. Where the integrations live

| Layer | File | Owns |
| --- | --- | --- |
| Adapter contract | `crates/yuppycode-agents/src/lib.rs` | `AgentKind` (`claude-code`, `codex`), detection (`detect`, `detect_all`, `which`), version probe, **argv per CLI** (`noninteractive_args`, `interactive_args`, `team_args`, `brief_args`, `bus_allow_args`), `spawn_interactive` |
| PTY transport | `crates/yuppycode-terminal/src/session.rs` | PTY spawn, stdin/stdout/stderr pumping, `send_bytes`, `send_interrupt`, `resize` (SIGWINCH + winsize), snapshot, `Exited` events, `kill`, `close`, orphan-proof `Drop` |
| Non-interactive turns | `crates/yuppycode-orchestrator/src/runner.rs` | `ProcessTaskRunner`: builds argv, spawns `claude -p …` / `codex exec …`, sets `current_dir`, captures stdout+stderr, exit code, timeout, cancellation, `kill_on_drop` |
| Background tasks | `crates/yuppycode-cli/src/supervisor.rs` | Queue, bounded parallel admission, per-department accounting, cancellation flags, report tails, team bus wiring |
| Team mode | `crates/yuppycode-cli/src/team.rs` | Multi-engine team sessions on one message bus |
| Live panels | `crates/yuppycode-tui/src/terminals.rs` | `TerminalManager`: one `TerminalSession` per tab, tab order, prompt injection, restart, close |
| Presentation | `crates/yuppycode-tui/src/render.rs`, `view_model.rs`, `app.rs` | Grid geometry, tiles/tabs view-model, key routing and passthrough |

Both CLIs are separate adapters on purpose: different argv, different team
dialects (`--mcp-config` file for Claude Code, inline `-c` overrides for Codex),
different brief delivery (`--append-system-prompt` vs prompt prefix). A change
that treats them as interchangeable will break one of them.

**Rules for anyone editing near these files**: do not replace real sessions with
simulated data, do not unify the two argv paths, do not add permission-bypass
flags, and keep `kill_on_drop` / `Drop` termination intact — they are what stops
orphaned `claude`/`codex` processes.

## 2. What now guards them

| Suite | Covers |
| --- | --- |
| `crates/yuppycode-orchestrator/tests/runner_cli_contract.rs` (14) | Real child processes through the production `ProcessTaskRunner`: exact argv per CLI, per-CLI flag isolation, `--model`, working directory, stdout **and** stderr in the report tail, non-zero exit never reported as success, unknown CLI rejected without spawning, timeout kills the child, cancellation kills the child and reports failure, both CLIs concurrently, team wiring in each CLI's own dialect, Turkish/unicode prompt integrity |
| `crates/yuppycode-agents/tests/real_clis.rs` (8) | Genuine `claude` / `codex` interactive sessions in real PTYs: detection with real versions, each CLI's own banner, requested working directory, typed input echoed by the CLI (incl. Turkish), both live at once with no input bleed, closing one leaves the other interactive, resize reflows each child, bounded shutdown with a real exit status |
| `crates/yuppycode-tui/src/terminals.rs::cli_smoke` (1, was `#[ignore]`) | The TUI's own multi-panel path opening both CLIs concurrently |
| `crates/yuppycode-cli/tests/cli_startup_contract.rs` (4) | Black-box `yuppy`: `agents` lists both adapters, invalid `--reasoning-effort` refused at startup with the accepted set, `--version`/`--help` |
| `crates/yuppycode-providers/tests/provider_params.rs` (9) | `reasoning_effort` contract, fail-fast before any request, no invented parameters, Turkish prompt serialisation |

```sh
cargo test -p yuppycode-orchestrator --test runner_cli_contract
cargo test -p yuppycode-agents --test real_clis            # ~35s, needs the CLIs
cargo test -p yuppycode-cli --test cli_startup_contract
cargo test -p yuppycode-providers --test provider_params
cargo test -p yuppycode-tui --test ui_contract
cargo test -p yuppycode-tui --lib terminals::cli_smoke
```

`real_clis` prints `SKIP … UNVERIFIED …` for a CLI that is not installed. In CI,
set `YUPPY_REQUIRE_CLI=1` to make an absent CLI a hard failure so "we never
checked" can never masquerade as green.

The interactive tests type into each CLI's own composer and never press Enter:
they verify stdin/stdout without starting a model turn or spending tokens.

## 3. Measured against the real binaries

Observed on this host (`claude` 2.1.316, `codex-cli 0.166.0`):

* Both CLIs paint their genuine TUIs inside YuppyCode PTYs, each showing its own
  banner, model line and working directory.
* Typed input round-trips through the PTY into both composers, including
  `ğüşıöç ĞÜŞİÖÇ`.
* `resize` to 20×60 reaches both children: each re-lays out at the new width and
  keeps echoing input afterwards. (An early draft of this test saw Codex miss one
  keystroke after a resize; with a realistic 2s settle it reproduces nothing —
  the miss was the test polling too early, not the CLI.)
* Concurrency is real: two live sessions, distinct ids, distinct binaries, input
  in one never appears in the other, and closing one leaves the other usable.

## 4. Findings for the owning layers (not fixed here)

1. **`close()` costs ~3.7 s for Claude Code.** `close` sends Ctrl-C and waits the
   grace period before escalating to kill. Codex exits on the interrupt in ~40 ms
   with status 0; Claude Code ignores it, burns the full 3 s grace, and is
   reported as status 129. Closing a Claude tab in the UI feels stuck. Options:
   shorter grace for TUIs, or an explicit "press Ctrl-C twice" affordance.
2. **`ViewModel::running_tasks()` counts `Pending` too**, while the status bar
   prints it as `tasks N/M running`. Queued work reads as running work.
3. **`ViewModel::dept_activity()` returns `(running, queued)` and ignores terminal
   states**, so a department with only failed tasks shows no failure signal —
   spec §6.C asks for visible failed agents.
4. **`validate_reasoning_effort("+5")` accepts a signed integer** (Rust's `i64`
   parse allows `+`) and `build_request_body` forwards the raw string. Pinned as
   a characterization test; tighten or normalise deliberately.
5. The **DeepSeek 400 itself originates outside YuppyCode's client** — the CLI
   config is now validated at startup and in `OpenAiCompatible::stream`, which is
   the correct layer; nothing in YuppyCode invents a `reasoning_effort` value.

## 5. Keystroke ownership (what the redesign added around the CLIs)

The TUI redesign changed geometry and chrome only. What protects each hosted
CLI while it holds the keyboard:

* a keystroke has exactly one owner; while a live box has focus and `passthrough`
  is on, keys are forwarded verbatim and **no** printable key is intercepted
  (`shift+tab` reaches Claude Code, `q`/`m`/`l` reach the CLI, and
  `ctrl+c` gets one real `0x03` before a second one quits YuppyCode);
* `Esc` is the single intercepted key and only ever takes the keys back to
  YuppyCode; a literal `Esc` or `Tab` for the CLI is `e` / `t` from there;
* box-command mode swallows unknown printable keys so they cannot leak into the
  command line, which is why every key it *does* answer is listed explicitly
  (including `q`, which now goes through the same confirm path as everywhere
  else rather than vanishing);
* the footer advertises only keys that work in the pane that has focus, and a
  test asserts it does not promise `q`/`m` while a goal is being typed;
* mouse clicks select, never execute; quitting with live children asks once.

The one TUI behaviour the redesign had to add for honesty: grid and focus views
keep a compact EVENTS strip, because `focus → Codex CLI`, `keys → YuppyCode` and
provider errors otherwise had nowhere to be drawn.

## 6. Live end-to-end check (the whole product, not a unit)

`scripts/verify_tui_live.py` runs the real release binary in a real 180×50 PTY
with **both** CLIs live, drives it with the documented keys, and asserts against
a terminal grid (`pip install pyte`):

```sh
cargo build --release
python3 scripts/verify_tui_live.py        # exit 0 = every check passed
```

It confirms the panels paint, both CLIs are detected with their own versions,
`sessions 2/2`, each CLI's own UI is visible in its own panel at the same time,
Turkish input round-trips into the focused CLI and nowhere else, digits/clicks/`tab`
switch the keyboard between them, `m` changes the real geometry, `l` changes the
visible filter, `q` asks and `n` cancels, 100×30 and 64×22 stay usable, and
`ctrl+c` twice leaves no orphaned `claude`/`codex` behind (compared against the
CLIs that were already running before the launch).

It never presses Enter on the mission console and never presses Enter inside a
CLI composer, so a verification pass cannot dispatch a mission or spend tokens,
and it works in its own throwaway workspace.

## 7. Not verified

* **Non-interactive model turns** (`claude -p`, `codex exec`) are verified down to
  "the correct command is launched in the correct directory with stdout, stderr
  and exit status captured and honoured" using real child processes. The model
  response itself was not exercised, so provider-side behaviour of each CLI's
  print mode remains unverified.
* Auth/credential flows: untouched by design; each CLI reads its own config.
* The Next.js Agent Map and the WebSocket bridge were not exercised here.
