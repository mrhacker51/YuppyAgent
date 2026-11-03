"use client";

import { useMemo } from "react";
import {
  Cpu,
  Play,
  RotateCw,
  Square,
  SquareTerminal,
  Waypoints,
  X,
} from "lucide-react";
import { useHudStore } from "@/lib/store";
import { agentShortName, agentVersion } from "@/lib/agents";
import { cellsToText } from "@/lib/term";
import type { Task } from "@/lib/store";
import NetworkStage from "./NetworkStage";
import { dispatchCommandTarget } from "./views/shared";
import DeckPanel, { DeckStat } from "./fancy/Panel";

function latestTask(tasks: Record<string, Task>, cli: string | undefined): Task | undefined {
  if (!cli) return undefined;
  let latest: Task | undefined;
  for (const task of Object.values(tasks)) {
    if (task.cli === cli) latest = task;
  }
  return latest;
}

const TASK_STATE: Record<string, string> = {
  queued: "text-text-mid",
  running: "text-ok",
  awaiting_approval: "text-warn",
  completed: "text-accent",
  failed: "text-danger",
  cancelled: "text-text-lo",
};

/**
 * AgentSpace: a real department/seats map plus the selected executor's live
 * state. "Agents" here are the CLIs the bridge actually detected; department
 * roles are seats (configuration), never invented processes.
 */
export default function AgentSpace() {
  const departments = useHudStore((s) => s.departments);
  const agents = useHudStore((s) => s.agents);
  const sessions = useHudStore((s) => s.sessions);
  const tasks = useHudStore((s) => s.tasks);
  const status = useHudStore((s) => s.status);
  const selectedDept = useHudStore((s) => s.selectedDept);
  const setSelectedDept = useHudStore((s) => s.setSelectedDept);
  const selectedAgent = useHudStore((s) => s.selectedAgent);
  const setSelectedAgent = useHudStore((s) => s.setSelectedAgent);
  const openTerminal = useHudStore((s) => s.openTerminal);
  const focusSession = useHudStore((s) => s.focusSession);
  const closeTerminal = useHudStore((s) => s.closeTerminal);
  const restartSession = useHudStore((s) => s.restartSession);
  const send = useHudStore((s) => s.send);

  const executor =
    agents.find((a) => a.id === selectedAgent) ?? agents.find((a) => a.available) ?? agents[0];
  const session = executor ? sessions.find((s) => s.agent === executor.id) : undefined;
  const dept = departments.find((d) => d.id === selectedDept);
  const task = latestTask(tasks, executor?.id);
  const connected = status === "connected";

  const screenLines = useMemo(() => {
    const screen = session?.lastScreen;
    if (!screen || screen.type !== "terminal_screen") return [];
    return cellsToText(screen.cells, screen.rows, screen.cols)
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .slice(-4);
  }, [session?.lastScreen]);

  const selectRole = (departmentId: string, cli: string) => {
    setSelectedDept(departmentId);
    setSelectedAgent(cli);
    dispatchCommandTarget(cli, departmentId);
  };

  return (
    <DeckPanel
      label="AgentSpace"
      icon={<Waypoints size={10} className="text-accent" aria-hidden />}
      meta={
        <span className="flex items-center gap-2">
          <DeckStat label="pty" value={sessions.length} tone={sessions.length > 0 ? "accent" : "neutral"} />
          <DeckStat label="takım" value={departments.length} />
        </span>
      }
      tone={sessions.length > 0 ? "accent" : "neutral"}
      live={sessions.length > 0}
      flush
      className="h-full min-h-0 flex-1"
      bodyClassName="min-h-0"
    >
      <div className="grid min-h-0 flex-1 grid-cols-1 md:grid-cols-[minmax(0,1fr)_224px] xl:grid-cols-[minmax(0,1fr)_240px]">
        <div className="min-h-0 p-1">
          <NetworkStage />
        </div>

        <aside className="thin-scroll flex min-h-0 flex-col overflow-y-auto border-t border-line p-1.5 md:border-l md:border-t-0">
          <div className="flex items-center gap-1 font-mono text-[8px] uppercase tracking-[0.16em] text-text-lo">
            <Cpu size={9} aria-hidden />
            yürütücüler
          </div>
          <ul className="mt-1 space-y-px">
            {agents.map((a, index) => {
              const live = sessions.some((s) => s.agent === a.id);
              const selected = executor?.id === a.id;
              return (
                <li key={a.id} className="deck-enter" style={{ animationDelay: `${index * 45}ms` }}>
                  <button
                    type="button"
                    onClick={() => {
                      setSelectedAgent(a.id);
                      const current = sessions.find((s) => s.agent === a.id);
                      if (current) focusSession(current.id);
                    }}
                    aria-pressed={selected}
                    data-active={selected}
                    className={`deck-row deck-focus flex w-full items-center gap-1.5 border px-1 py-1 text-left transition-colors ${
                      selected
                        ? "border-accent/40 bg-accent/[0.06]"
                        : "border-transparent hover:border-line hover:bg-bg-2/60"
                    }`}
                  >
                    <span
                      className={`size-1.5 shrink-0 rounded-full ${
                        live ? "bg-ok deck-live" : a.available ? "bg-text-lo/50" : "bg-danger/60"
                      }`}
                      aria-hidden
                    />
                    <span className="min-w-0 flex-1 truncate font-mono text-[9px] text-text-mid">
                      {agentShortName(a.id)}
                    </span>
                    <span className="shrink-0 font-mono text-[8px] text-text-lo">
                      {live ? "canlı" : a.available ? "hazır" : "yok"}
                    </span>
                  </button>
                </li>
              );
            })}
            {agents.length === 0 && (
              <li className="border border-dashed border-line px-1.5 py-2 font-mono text-[8px] text-text-lo">
                CLI envanteri yok
              </li>
            )}
          </ul>

          {executor && (
            <div className="mt-2 border-t border-line pt-1.5">
              <div className="font-mono text-[8px] uppercase tracking-[0.16em] text-text-lo">
                seçili ajan
              </div>
              <div className="mt-0.5 flex items-center gap-1.5">
                <SquareTerminal size={10} className="text-accent" aria-hidden />
                <span className="min-w-0 truncate text-[10px] text-text-hi" title={agentShortName(executor.id)}>
                  {agentShortName(executor.id)}
                </span>
                <span
                  className="ml-auto shrink-0 font-mono text-[8px] text-text-lo"
                  title={executor.version ?? undefined}
                >
                  {agentVersion(executor.version) ?? "sürüm ?"}
                </span>
              </div>
              <div className="mt-1 flex flex-wrap items-center gap-1 font-mono text-[8px]">
                <span
                  className={`border px-1 py-px uppercase tracking-wider ${
                    session
                      ? "border-ok/30 bg-ok/[0.06] text-ok"
                      : executor.available
                        ? "border-line text-text-mid"
                        : "border-danger/30 text-danger"
                  }`}
                >
                  {session ? "oturum canlı" : executor.available ? "oturum kapalı" : "cli yok"}
                </span>
                {task && (
                  <span
                    className={`max-w-full truncate border border-line px-1 py-px ${
                      TASK_STATE[task.state] ?? "text-text-mid"
                    }`}
                    title={task.title ?? task.id}
                  >
                    {task.state}
                  </span>
                )}
              </div>

              {session ? (
                <div className="mt-1 grid grid-cols-2 gap-1">
                  <button
                    type="button"
                    onClick={() => focusSession(session.id)}
                    className="flex items-center justify-center gap-1 border border-line px-1 py-1 font-mono text-[8px] uppercase tracking-wider text-text-mid transition-colors hover:border-line-strong hover:text-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/50"
                  >
                    <Play size={8} aria-hidden /> odak
                  </button>
                  <button
                    type="button"
                    onClick={() => send({ type: "terminal_interrupt", session_id: session.id })}
                    title="PTY'ye SIGINT gönder"
                    className="flex items-center justify-center gap-1 border border-warn/30 px-1 py-1 font-mono text-[8px] uppercase tracking-wider text-warn transition-colors hover:border-warn/60 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-warn/50"
                  >
                    <Square size={7} aria-hidden /> sigint
                  </button>
                  <button
                    type="button"
                    onClick={() => restartSession(session.id)}
                    className="flex items-center justify-center gap-1 border border-line px-1 py-1 font-mono text-[8px] uppercase tracking-wider text-text-mid transition-colors hover:border-line-strong hover:text-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/50"
                  >
                    <RotateCw size={8} aria-hidden /> yenile
                  </button>
                  <button
                    type="button"
                    onClick={() => closeTerminal(session.id)}
                    className="flex items-center justify-center gap-1 border border-danger/30 px-1 py-1 font-mono text-[8px] uppercase tracking-wider text-danger transition-colors hover:border-danger/60 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-danger/50"
                  >
                    <X size={8} aria-hidden /> kapat
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  disabled={!connected || !executor.available}
                  onClick={() =>
                    openTerminal(executor.id, executor.display_name, selectedDept || undefined)
                  }
                  className="mt-1 flex w-full items-center justify-center gap-1 border border-accent/40 bg-accent-dim py-1 font-mono text-[8px] uppercase tracking-wider text-accent transition-colors hover:border-accent/70 disabled:cursor-not-allowed disabled:border-line disabled:bg-transparent disabled:text-text-lo focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/50"
                >
                  <SquareTerminal size={9} aria-hidden /> terminal aç
                </button>
              )}

              {executor.install_hint && !executor.available && (
                <p className="mt-1 border border-danger/20 bg-danger/[0.04] px-1 py-1 font-mono text-[8px] leading-relaxed text-danger/90">
                  {executor.install_hint}
                </p>
              )}

              {screenLines.length > 0 && (
                <div className="mt-1.5 border-t border-line pt-1">
                  <div className="font-mono text-[8px] uppercase tracking-[0.16em] text-text-lo">
                    son çıktı
                  </div>
                  <pre className="mt-0.5 max-h-[54px] overflow-hidden whitespace-pre-wrap break-all font-mono text-[8px] leading-[1.35] text-text-mid">
                    {screenLines.join("\n")}
                  </pre>
                </div>
              )}
            </div>
          )}

          {dept && (
            <div className="mt-2 border-t border-line pt-1.5">
              <div className="flex items-center gap-1 font-mono text-[8px] uppercase tracking-[0.16em] text-text-lo">
                roller
                <span className="min-w-0 truncate normal-case tracking-normal text-text-mid">
                  {dept.name}
                </span>
              </div>
              {dept.description && (
                <p className="mt-0.5 text-[8px] leading-relaxed text-text-lo/85">
                  {dept.description}
                </p>
              )}
              <ul className="mt-1 space-y-px">
                {(dept.roles ?? []).map((r) => (
                  <li key={r.id}>
                    <button
                      type="button"
                      onClick={() => selectRole(dept.id, r.cli)}
                      title={`${r.name} · ${r.cli}${r.model ? ` · ${r.model}` : ""} — komut hedefi yap`}
                      className="flex w-full items-center gap-1 border border-transparent px-1 py-0.5 text-left transition-colors hover:border-line hover:bg-bg-2/60 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/50"
                    >
                      <span className="min-w-0 flex-1 truncate text-[9px] text-text-mid">
                        {r.name}
                      </span>
                      <span className="max-w-[72px] shrink-0 truncate font-mono text-[8px] text-text-lo">
                        {r.cli}
                        {r.model ? ` · ${r.model}` : ""}
                      </span>
                    </button>
                  </li>
                ))}
                {(dept.roles ?? []).length === 0 && (
                  <li className="px-1 py-1 font-mono text-[8px] italic text-text-lo">
                    bu takımda rol tanımlı değil
                  </li>
                )}
              </ul>
            </div>
          )}
        </aside>
      </div>
    </DeckPanel>
  );
}
