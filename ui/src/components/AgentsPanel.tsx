"use client";

import { LoaderCircle, PlugZap, SquareTerminal } from "lucide-react";
import { useHudStore } from "@/lib/store";

const thinScrollbar =
  "[scrollbar-width:thin] [scrollbar-color:var(--line-strong)_transparent] [&::-webkit-scrollbar]:w-1 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-[var(--line-strong)]";

function agentShortName(agent: string): string {
  if (agent.includes("claude")) return "Claude Code";
  if (agent.includes("codex")) return "Codex";
  return agent;
}

/** CLI inventory reported by the bridge: availability, version, install hints. */
export default function AgentsPanel() {
  const agents = useHudStore((s) => s.agents);
  const sessions = useHudStore((s) => s.sessions);
  const status = useHudStore((s) => s.status);
  const openTerminal = useHudStore((s) => s.openTerminal);

  const liveCount = agents.filter((a) => sessions.some((s) => s.agent === a.id)).length;

  return (
    <section className="overflow-hidden rounded-md border border-[var(--line)] bg-[var(--panel)]">
      <header className="flex items-center justify-between gap-2 border-b border-[var(--line)] bg-[var(--bg-1)]/40 px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <SquareTerminal className="h-3 w-3 shrink-0 text-[var(--text-lo)]" aria-hidden />
          <span className="truncate text-[10px] font-semibold uppercase tracking-[0.2em] text-[var(--text-lo)]">
            CLI Agents
          </span>
        </div>
        <span className="shrink-0 font-mono text-[10px] tabular-nums text-[var(--text-lo)]">
          {liveCount}/{agents.length} live
        </span>
      </header>

      {agents.length === 0 ? (
        <div className="flex flex-col items-center gap-1.5 px-3 py-6 text-center">
          {status === "connected" ? (
            <LoaderCircle className="h-4 w-4 animate-spin text-[var(--accent)]/70" aria-hidden />
          ) : (
            <PlugZap className="h-4 w-4 text-[var(--text-lo)]/60" aria-hidden />
          )}
          <p className="text-[11px] text-[var(--text-lo)]">
            {status === "connected" ? "Waiting for agent inventory…" : "Bridge offline."}
          </p>
        </div>
      ) : (
        <ul className={`max-h-56 overflow-y-auto ${thinScrollbar}`}>
          {agents.map((a) => {
            const live = sessions.find((s) => s.agent === a.id);
            return (
              <li
                key={a.id}
                className="group flex items-center gap-2 border-b border-[var(--line)]/50 px-3 py-2 text-xs transition-colors last:border-b-0 hover:bg-[var(--bg-2)]/60"
              >
                <span className="relative flex h-2 w-2 shrink-0" aria-hidden>
                  {live && (
                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[var(--accent)]/50" />
                  )}
                  <span
                    className={`relative inline-flex h-2 w-2 rounded-full ${
                      live
                        ? "bg-[var(--accent)]"
                        : a.available
                          ? "bg-[var(--ok)]/80"
                          : "bg-[var(--text-lo)]/40"
                    }`}
                  />
                </span>
                <span
                  className={`min-w-0 truncate ${
                    a.available ? "text-[var(--text-hi)]" : "text-[var(--text-lo)]"
                  }`}
                  title={a.display_name || agentShortName(a.id)}
                >
                  {agentShortName(a.id)}
                </span>
                <span
                  className={`ml-auto min-w-0 truncate font-mono text-[10px] ${
                    live ? "text-[var(--accent)]" : "text-[var(--text-lo)]"
                  }`}
                  title={live ? "session live" : a.version || a.install_hint || undefined}
                >
                  {live ? "live" : a.version || a.install_hint || ""}
                </span>
                <button
                  type="button"
                  disabled={!a.available || !!live || status !== "connected"}
                  onClick={() => openTerminal(a.id, a.display_name)}
                  title={live ? "session already open" : `open ${agentShortName(a.id)} terminal`}
                  className="shrink-0 rounded border border-[var(--line)] px-1.5 py-0.5 text-[10px] text-[var(--text-mid)] transition-colors hover:border-[var(--line-strong)] hover:bg-[var(--accent-dim)] hover:text-[var(--accent)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--accent)]/60 disabled:invisible"
                >
                  open
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
