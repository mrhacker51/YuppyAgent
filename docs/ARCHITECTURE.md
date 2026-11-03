# YuppyCode Architecture Notes

This document is for contributors and future-phase authors. It describes the
boundaries that keep Phase 2 (web UI) and Phase 3 (Tauri desktop) possible
without rewriting the agent core.

## Crate boundaries

```
protocol  ←  no UI / no network / no storage; pure serde types
   ↑
core      ←  engine, task graph, events, cancellation, trait contracts
   ↑
providers, tools, mcp, memory  ←  concrete adapters injected into core
   ↑
cli (`yuppy bridge`)  ←  WebSocket bridge for the Desktop app / web UI;
                        owns no business logic
```

- **`yuppycode-core` must never depend on Ratatui, browser APIs, React,
  Tauri, reqwest, rusqlite, or tokio process I/O.** It owns the orchestration
  loop and publishes events through a bounded channel.
- **`yuppycode-protocol` is the future IPC/WebSocket contract.** Any event the
  engine emits is serializable to a `ServerPayload`. A future bridge only needs
  to translate `AgentEvent → Envelope → bytes`.
- **Providers, tools, memory and MCP are swappable adapters.** The engine only
  sees traits: `ModelProvider`, `ToolExecutor`, `Memory`, `ApprovalGate`.

## Engine event flow

1. User input arrives at the transport (the bridge's WebSocket).
2. Transport submits the prompt to `AgentEngine`.
3. Engine assembles context, calls `ModelProvider::stream`, accumulates text
   and tool calls.
4. Tool calls are validated against declared schemas **before** approval or
   execution.
5. High-risk calls go through `ApprovalGate`.
6. Results are fed back into context; the loop repeats until the assistant
   finishes or `max_tool_iterations` is reached.
7. Every step emits typed `AgentEvent`s to the bounded `EventBus`.

## Future transport bridge (Phase 2)

A local WebSocket/IPC bridge will:

- Accept `ClientRequest` messages (Run, Cancel, Approval, SetModel, Ping).
- Run the same `AgentEngine` on the server side.
- Serialize each `AgentEvent` with `AgentEvent::to_payload()` into an
  `Envelope` and send it over the wire.

Because the protocol crate has no dependency on core, it can be code-generated
or imported directly by the TypeScript frontend.

## Future web/desktop UI (Phase 2 / Phase 3)

- Phase 2 frontend receives `Envelope` payloads and renders them with
  Three.js/WebGL. It does not drive the engine; it only sends `ClientRequest`s.
- Phase 3 Tauri shell reuses the same Rust backend as a sidecar and the same
  protocol messages as Tauri commands or a local socket.

## Performance constraints carried forward

- Core keeps no heavy global state; `AgentEngine` is cheap to construct.
- Storage and network adapters are lazy: `SqliteMemory` opens on first access,
  `OpenAiCompatible` builds its HTTP client on first stream.
- Events are bounded and coalesced; future transports must preserve backpressure.
