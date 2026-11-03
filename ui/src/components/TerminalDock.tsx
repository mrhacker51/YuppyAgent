"use client";

import { useEffect, useRef } from "react";
import {
  ChevronDown,
  GripHorizontal,
  Maximize2,
  Minimize2,
  SquareTerminal,
  X,
} from "lucide-react";
import { useHudStore } from "@/lib/store";
import { DOCK_DEFAULT_HEIGHT, DOCK_MIN_HEIGHT, clampDockHeight } from "@/lib/dock";
import { useMounted } from "@/lib/useMounted";
import TerminalPane from "./TerminalPane";

function agentShortName(agent: string): string {
  if (agent.includes("claude")) return "Claude Code";
  if (agent.includes("codex")) return "Codex";
  return agent;
}

/**
 * Session dock: tabs for every hosted CLI session, launch buttons for the
 * available CLIs, and controls that reach the real PTY (interrupt, close).
 */
export default function TerminalDock() {
  const sessions = useHudStore((s) => s.sessions);
  const activeSessionId = useHudStore((s) => s.activeSessionId);
  const agents = useHudStore((s) => s.agents);
  const status = useHudStore((s) => s.status);
  const openTerminal = useHudStore((s) => s.openTerminal);
  const focusSession = useHudStore((s) => s.focusSession);
  const closeTerminal = useHudStore((s) => s.closeTerminal);
  const send = useHudStore((s) => s.send);
  const lastExit = useHudStore((s) => s.lastExit);
  const clearLastExit = useHudStore((s) => s.clearLastExit);
  const dockHeight = useHudStore((s) => s.dockHeight);
  const dockMaximized = useHudStore((s) => s.dockMaximized);
  const dockHidden = useHudStore((s) => s.dockHidden);
  const setDockHeight = useHudStore((s) => s.setDockHeight);
  const toggleDockMaximized = useHudStore((s) => s.toggleDockMaximized);
  const toggleDockHidden = useHudStore((s) => s.toggleDockHidden);

  const active = sessions.find((s) => s.id === activeSessionId) ?? sessions[0];
  // Persisted presentation (height/hidden/maximized) is applied after the
  // hydration pass so the prerendered HTML and the first client render agree.
  const mounted = useMounted();
  const hidden = mounted && dockHidden;
  const maximized = mounted && dockMaximized;
  const shownHeight = mounted ? dockHeight : DOCK_DEFAULT_HEIGHT;
  const drag = useRef<{ pointerId: number; startY: number; startHeight: number } | null>(null);

  /** Pointer-drag resize: the splitter and the header grip share this. */
  const beginResize = (e: React.PointerEvent<HTMLElement>) => {
    if (dockMaximized) return;
    const el = e.currentTarget;
    el.setPointerCapture?.(e.pointerId);
    drag.current = { pointerId: e.pointerId, startY: e.clientY, startHeight: dockHeight };
    e.preventDefault();
  };
  const moveResize = (e: React.PointerEvent<HTMLElement>) => {
    const d = drag.current;
    if (!d || d.pointerId !== e.pointerId) return;
    // Dragging up grows the dock, like every split pane.
    setDockHeight(clampDockHeight(d.startHeight + (d.startY - e.clientY)));
  };
  const endResize = (e: React.PointerEvent<HTMLElement>) => {
    if (drag.current?.pointerId === e.pointerId) drag.current = null;
  };
  const nudgeResize = (e: React.KeyboardEvent<HTMLElement>) => {
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setDockHeight(clampDockHeight(dockHeight + 32));
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setDockHeight(clampDockHeight(dockHeight - 32));
    } else if (e.key === "Home") {
      e.preventDefault();
      setDockHeight(DOCK_DEFAULT_HEIGHT);
    }
  };

  useEffect(() => {
    if (!lastExit) return;
    const t = setTimeout(clearLastExit, 6000);
    return () => clearTimeout(t);
  }, [lastExit, clearLastExit]);

  const launchable = agents.filter((a) => a.available);

  // Hidden dock: a slim, always-reachable strip. The PTYs keep running in
  // the backend; only the view unmounts.
  if (hidden) {
    return (
      <section
        aria-label="CLI sessions dock (hidden)"
        className="flex shrink-0 items-center gap-3 rounded-md border border-[var(--line)] bg-[var(--panel)] px-3 py-1.5 backdrop-blur-sm"
      >
        <SquareTerminal size={12} className="text-[var(--accent)]" aria-hidden />
        <span className="text-[10px] font-medium uppercase tracking-[0.18em] text-[var(--text-lo)]">
          CLI Sessions
        </span>
        <span className="font-mono text-[11px] text-[var(--text-mid)]">
          {sessions.length === 0
            ? "no live session"
            : `${sessions.length} session${sessions.length === 1 ? "" : "s"} live`}
        </span>
        <span className="flex-1" />
        <button
          type="button"
          onClick={() => toggleDockHidden(false)}
          className="rounded border border-[var(--line-strong)] px-2 py-0.5 text-[11px] text-[var(--accent)] transition-colors hover:bg-[var(--accent-dim)] focus-visible:outline-1 focus-visible:outline-[var(--accent)]"
        >
          Show dock
        </button>
      </section>
    );
  }

  return (
    <section
      style={maximized ? undefined : { height: shownHeight }}
      className={`relative flex min-h-0 flex-col overflow-hidden rounded-md border border-[var(--line)] bg-[var(--panel)] backdrop-blur-sm ${
        maximized ? "flex-1" : "shrink-0"
      }`}
    >
      {/* Pointer resize handle on the dock's top edge. It also accepts
          keyboard focus so the dock can be resized without a mouse. */}
      {!maximized && (
        <div
          role="separator"
          aria-orientation="horizontal"
          aria-label="Resize terminal dock"
          aria-valuenow={shownHeight}
          aria-valuemin={DOCK_MIN_HEIGHT}
          tabIndex={0}
          onPointerDown={beginResize}
          onPointerMove={moveResize}
          onPointerUp={endResize}
          onPointerCancel={endResize}
          onDoubleClick={() => setDockHeight(DOCK_DEFAULT_HEIGHT)}
          onKeyDown={nudgeResize}
          className="absolute inset-x-0 top-0 z-10 h-1.5 cursor-row-resize touch-none bg-transparent transition-colors hover:bg-[var(--line-strong)] focus-visible:bg-[var(--line-strong)] focus-visible:outline-none"
        />
      )}
      {/* micro-label strip + PTY controls */}
      <header className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-[var(--line)] bg-[var(--bg-1)]/60 px-3 py-1.5">
        <span className="flex items-center gap-1.5 pr-1 text-[10px] font-medium uppercase tracking-[0.18em] text-[var(--text-lo)]">
          <SquareTerminal size={12} className="text-[var(--accent)]" aria-hidden />
          CLI Sessions
        </span>
        {!maximized && (
          <button
            type="button"
            aria-label="Drag to resize terminal dock (arrow keys also resize)"
            title="Drag to resize"
            onPointerDown={beginResize}
            onPointerMove={moveResize}
            onPointerUp={endResize}
            onPointerCancel={endResize}
            onDoubleClick={() => setDockHeight(DOCK_DEFAULT_HEIGHT)}
            className="cursor-row-resize touch-none rounded p-0.5 text-[var(--text-lo)] transition-colors hover:text-[var(--accent)] focus-visible:outline-1 focus-visible:outline-[var(--accent)]"
          >
            <GripHorizontal size={12} aria-hidden />
          </button>
        )}
        <span className="flex-1" />
        {launchable.map((a) => (
          <button
            key={a.id}
            type="button"
            disabled={status !== "connected" || sessions.some((s) => s.agent === a.id)}
            onClick={() => openTerminal(a.id, a.display_name)}
            className="rounded border border-[var(--line-strong)] px-2 py-0.5 text-[11px] text-[var(--accent)] transition-colors hover:bg-[var(--accent-dim)] focus-visible:outline-1 focus-visible:outline-[var(--accent)] disabled:cursor-not-allowed disabled:border-[var(--line)] disabled:text-[var(--text-lo)] disabled:hover:bg-transparent"
          >
            + {agentShortName(a.id)}
          </button>
        ))}
        {launchable.length === 0 && (
          <span className="text-[10px] uppercase tracking-wider text-[var(--text-lo)]">
            {status === "connected" ? "no CLIs reported by bridge" : "bridge offline"}
          </span>
        )}
        {active && (
          <>
            <button
              type="button"
              onClick={() => send({ type: "terminal_interrupt", session_id: active.id })}
              className="rounded border border-[var(--warn)]/40 px-2 py-0.5 text-[11px] text-[var(--warn)] transition-colors hover:bg-[var(--warn)]/10 focus-visible:outline-1 focus-visible:outline-[var(--warn)]"
              title="Send SIGINT to the PTY"
            >
              Ctrl-C
            </button>
            <button
              type="button"
              onClick={() => closeTerminal(active.id)}
              className="rounded border border-[var(--danger)]/40 px-2 py-0.5 text-[11px] text-[var(--danger)] transition-colors hover:bg-[var(--danger)]/10 focus-visible:outline-1 focus-visible:outline-[var(--danger)]"
            >
              Close
            </button>
          </>
        )}
        <button
          type="button"
          onClick={toggleDockMaximized}
          aria-label={maximized ? "Restore terminal dock" : "Maximize terminal dock"}
          title={maximized ? "Restore dock" : "Maximize dock"}
          className="rounded border border-[var(--line)] px-2 py-0.5 text-[var(--text-mid)] transition-colors hover:border-[var(--line-strong)] hover:text-[var(--accent)] focus-visible:outline-1 focus-visible:outline-[var(--accent)]"
        >
          {maximized ? <Minimize2 size={12} aria-hidden /> : <Maximize2 size={12} aria-hidden />}
        </button>
        <button
          type="button"
          onClick={() => toggleDockHidden(true)}
          aria-label="Hide terminal dock"
          title="Hide dock"
          className="rounded border border-[var(--line)] px-2 py-0.5 text-[var(--text-mid)] transition-colors hover:border-[var(--line-strong)] hover:text-[var(--accent)] focus-visible:outline-1 focus-visible:outline-[var(--accent)]"
        >
          <ChevronDown size={12} aria-hidden />
        </button>
      </header>

      {/* session tab bar */}
      {sessions.length > 0 && (
        <div
          className="flex items-stretch gap-1 overflow-x-auto border-b border-[var(--line)] bg-[var(--bg-0)]/40 px-2 [scrollbar-color:rgba(148,163,184,0.25)_transparent] [scrollbar-width:thin] [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-[rgba(148,163,184,0.22)] [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar]:h-1"
          role="tablist"
          aria-label="Terminal sessions"
        >
          {sessions.map((s) => {
            const isActive = active?.id === s.id;
            const label = s.label || agentShortName(s.agent);
            return (
              <div
                key={s.id}
                role="tab"
                aria-selected={isActive}
                className={`group relative flex shrink-0 items-center gap-1.5 border-b-2 py-1.5 pl-2.5 pr-1.5 text-xs transition-colors ${
                  isActive
                    ? "border-[var(--accent)] bg-[var(--accent-dim)] text-[var(--accent)] shadow-[inset_0_-6px_12px_-8px_rgba(34,211,238,0.6)]"
                    : "border-transparent text-[var(--text-mid)] hover:border-[var(--line-strong)] hover:text-[var(--text-hi)]"
                }`}
              >
                <button
                  type="button"
                  tabIndex={isActive ? 0 : -1}
                  onClick={() => focusSession(s.id)}
                  className="max-w-44 truncate focus-visible:outline-1 focus-visible:outline-[var(--accent)]"
                  title={label}
                >
                  {label}
                </button>
                <button
                  type="button"
                  aria-label={`Close ${label}`}
                  onClick={() => closeTerminal(s.id)}
                  className="rounded p-0.5 text-[var(--text-lo)] opacity-60 transition-colors hover:bg-[var(--danger)]/10 hover:text-[var(--danger)] focus-visible:opacity-100 focus-visible:outline-1 focus-visible:outline-[var(--danger)] group-hover:opacity-100"
                >
                  <X size={12} aria-hidden />
                </button>
              </div>
            );
          })}
        </div>
      )}

      {lastExit && (
        <div className="flex items-center gap-2 border-b border-[var(--line)] bg-[var(--warn)]/[0.07] px-3 py-1 font-mono text-[11px] text-[var(--warn)]">
          <span
            className="size-1.5 shrink-0 rounded-full bg-[var(--warn)]"
            aria-hidden
          />
          <span className="truncate">
            {lastExit.label || agentShortName(lastExit.agent ?? "")} exited
            {typeof lastExit.exitCode === "number" ? ` (code ${lastExit.exitCode})` : ""}
            {lastExit.signal ? ` (signal ${lastExit.signal})` : ""}
          </span>
        </div>
      )}

      {/* terminal body — flex-1 + min-h-0 keeps the fit addon measuring a real box */}
      <div className="min-h-0 flex-1 p-2">
        {active ? (
          <div className="h-full min-h-0 overflow-hidden rounded-md border border-[var(--line)] bg-[var(--bg-1)]">
            <TerminalPane key={active.id} session={active} />
          </div>
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-3 rounded-md border border-dashed border-[var(--line)] text-center">
            <SquareTerminal size={28} className="text-[var(--text-lo)]" aria-hidden />
            <div className="space-y-1">
              <p className="text-xs uppercase tracking-[0.18em] text-[var(--text-mid)]">
                No CLI session attached
              </p>
              <p className="max-w-sm text-[11px] leading-relaxed text-[var(--text-lo)]">
                Launch Claude Code or Codex above — sessions are real PTYs hosted by the backend,
                never simulated.
              </p>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
