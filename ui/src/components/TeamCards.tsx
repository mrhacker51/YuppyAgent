"use client";

import { memo, useEffect, useMemo, useRef } from "react";
import { Ban, SquareTerminal, Square, Users, X } from "lucide-react";
import { useHudStore, type Task } from "@/lib/store";
import { AGENT_CLI } from "@/lib/agents";
import type { DepartmentDto, DepartmentRoleDto } from "@/lib/protocol";
import {
  assignTasksToCards,
  currentTask,
  isLiveState,
  roleCallsign,
  workerRoles,
} from "@/lib/teamRoster";
import DeckPanel from "./fancy/Panel";
import TerminalPane from "./TerminalPane";

/** DOM lines a card renders; the store keeps more (ring buffer of 200). */
const RENDERED_LINES = 60;
/** Outsider cards shown at once (live first, then newest). */
const OUTSIDER_CARDS = 6;

const STATE_LABEL: Record<string, string> = {
  queued: "sırada",
  running: "çalışıyor",
  awaiting_approval: "onay bekliyor",
  completed: "bitti",
  failed: "hata",
  cancelled: "iptal",
};

const STATE_TONE: Record<string, string> = {
  queued: "border-line text-text-mid",
  running: "border-ok/35 text-ok",
  awaiting_approval: "border-warn/40 text-warn",
  completed: "border-accent/35 text-accent",
  failed: "border-danger/40 text-danger",
  cancelled: "border-line text-text-lo",
};

const EMPTY: string[] = [];

function tailLines(text: string, n: number): string[] {
  const lines = text.split("\n").filter((l) => l.trim().length > 0);
  return lines.slice(-n);
}

const actionBtn =
  "flex h-5 shrink-0 items-center gap-1 rounded-[4px] border px-1.5 font-mono text-[8px] uppercase tracking-wider transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/60 disabled:cursor-not-allowed disabled:opacity-50";

/**
 * One agent card: callsign + state, the streamed output lines of its current
 * headless task, and a footer. Idle cards are placeholders — no PTY and no
 * xterm. An interactive Claude Code PTY opens only on "terminal aç"; only
 * then is an xterm mounted. Each card subscribes to its own task's lines, so
 * a chatty worker never re-renders the others.
 */
const AgentCard = memo(function AgentCard({
  team,
  role,
  tasks,
  outsider,
}: {
  team: DepartmentDto | undefined;
  role: DepartmentRoleDto | null;
  tasks: readonly Task[];
  outsider?: boolean;
}) {
  const task = currentTask(tasks);
  const lines = useHudStore((s) => (task ? (s.taskOutput[task.id] ?? EMPTY) : EMPTY));
  const session = useHudStore((s) =>
    role && team
      ? s.sessions.find((x) => !x.lead && x.department === team.id && x.role === role.id)
      : undefined,
  );
  const connected = useHudStore((s) => s.status === "connected");
  const claudeReady = useHudStore((s) => s.agents.some((a) => a.id === AGENT_CLI && a.available));
  const openTerminal = useHudStore((s) => s.openTerminal);
  const closeTerminal = useHudStore((s) => s.closeTerminal);
  const send = useHudStore((s) => s.send);
  const bodyRef = useRef<HTMLPreElement>(null);

  const name = role ? roleCallsign(role) : (task?.title ?? task?.id ?? "görev");
  const title = role ? (role.callsign?.trim() ? role.name : "") : "ekip dışı";
  const live = task ? isLiveState(task.state) : false;

  // Streamed lines first; a finished task without a stream shows its report
  // tail (the bridge's own `output_tail`). Nothing else is ever shown.
  const shown = useMemo(() => {
    if (lines.length > 0) return lines.slice(-RENDERED_LINES);
    if (task?.report?.outputTail) return tailLines(task.report.outputTail, RENDERED_LINES);
    return EMPTY;
  }, [lines, task?.report?.outputTail]);

  useEffect(() => {
    const el = bodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [shown]);

  const status = session
    ? "etkileşimli PTY canlı"
    : !task
      ? "boşta · PTY yok"
      : task.report
        ? `${task.report.success ? "başarılı" : "başarısız"}${
            task.report.exitCode != null ? ` · çıkış ${task.report.exitCode}` : ""
          } · ${(task.report.durationMs / 1000).toFixed(1)} sn`
        : `${STATE_LABEL[task.state] ?? task.state} · ${lines.length} satır`;

  return (
    <article
      className={`flex min-h-0 min-w-0 flex-col overflow-hidden rounded-[10px] border bg-surface-1/70 ${
        session ? "row-span-2 sm:col-span-2" : ""
      } ${live ? "border-accent/30" : "border-line"}`}
      aria-label={`${name} kartı`}
    >
      <header className="flex h-7 shrink-0 items-center gap-1.5 border-b border-line bg-surface-2/70 px-2">
        <span
          className={`size-1.5 shrink-0 rounded-full ${
            session || live ? "bg-ok deck-live" : "bg-text-lo/45"
          }`}
          aria-hidden
        />
        <span className="min-w-0 truncate text-[10.5px] font-medium text-text-hi" title={name}>
          {name}
        </span>
        {title && (
          <span className="hidden min-w-0 truncate font-mono text-[8px] text-text-lo sm:inline" title={title}>
            {title}
          </span>
        )}
        <span className="ml-auto flex min-w-0 shrink items-center gap-1">
          {task ? (
            <span
              className={`min-w-0 truncate rounded-[4px] border px-1 font-mono text-[8px] ${
                STATE_TONE[task.state] ?? "border-line text-text-mid"
              }`}
              title={`${task.title ?? task.id} · ${task.id}`}
            >
              {live ? (task.title ?? task.id) : (STATE_LABEL[task.state] ?? task.state)}
            </span>
          ) : (
            <span className="rounded-[4px] border border-line px-1 font-mono text-[8px] text-text-lo">
              Boşta
            </span>
          )}
          {task && live && (
            <button
              type="button"
              onClick={() => send({ type: "task_cancel", task_id: task.id })}
              disabled={!connected}
              title="Görevi iptal et (task_cancel)"
              aria-label={`${name} görevini iptal et`}
              className={`${actionBtn} border-danger/30 text-danger hover:border-danger/60`}
            >
              <Ban size={8} aria-hidden />
            </button>
          )}
          {role && team && !session && (
            <button
              type="button"
              onClick={() => openTerminal(AGENT_CLI, `${name} · ${team.name}`, team.id, role.id)}
              disabled={!connected || !claudeReady}
              title="Bu ajan için etkileşimli Claude Code PTY aç"
              className={`${actionBtn} border-line text-text-mid hover:border-accent/50 hover:text-accent`}
            >
              <SquareTerminal size={8} aria-hidden />
              <span className="hidden md:inline">terminal aç</span>
            </button>
          )}
          {session && (
            <>
              <button
                type="button"
                onClick={() => send({ type: "terminal_interrupt", session_id: session.id })}
                title="PTY'ye SIGINT gönder"
                aria-label={`${name} terminaline SIGINT gönder`}
                className={`${actionBtn} border-warn/30 text-warn hover:border-warn/60`}
              >
                <Square size={7} aria-hidden />
              </button>
              <button
                type="button"
                onClick={() => closeTerminal(session.id)}
                title="Terminali kapat (süreç sonlanır)"
                aria-label={`${name} terminalini kapat`}
                className={`${actionBtn} border-line text-text-lo hover:border-danger/50 hover:text-danger`}
              >
                <X size={8} aria-hidden />
              </button>
            </>
          )}
        </span>
      </header>

      <div className="term-surface relative flex min-h-[96px] flex-1 flex-col overflow-hidden bg-[#080b0f]">
        {session ? (
          <TerminalPane key={session.id} session={session} autoFocus={false} />
        ) : shown.length > 0 ? (
          <pre
            ref={bodyRef}
            className="thin-scroll min-h-0 flex-1 overflow-y-auto whitespace-pre-wrap break-words px-2 py-1 font-mono text-[9px] leading-[1.4] text-text-mid"
          >
            {shown.join("\n")}
          </pre>
        ) : (
          <p className="m-auto max-w-[220px] px-2 text-center font-mono text-[8.5px] leading-relaxed text-text-lo">
            {task
              ? live
                ? "Görev başladı — çıktı satırları geldikçe burada akar."
                : "Bu görev çıktı göndermedi."
              : outsider
                ? "Takım rolüne bağlı olmayan görev."
                : "Boşta — lead bu ajana görev verince çıktısı burada akar."}
          </p>
        )}
      </div>

      <footer className="flex h-5 shrink-0 items-center gap-1.5 border-t border-line/70 px-2 font-mono text-[7.5px] uppercase tracking-[0.12em] text-text-lo">
        <span className="min-w-0 truncate">{status}</span>
        {task && <span className="ml-auto shrink-0 normal-case tracking-normal text-text-lo/70">{task.id.slice(-8)}</span>}
      </footer>
    </article>
  );
});

/**
 * TERMINALS — the selected team's agents. One card per enabled worker role,
 * idle or not; tasks land on the card of their (department, role). Tasks with
 * no matching role are grouped under "ekip dışı". The lead is not here: it is
 * the large interactive window above.
 */
export default function TeamCards() {
  const departments = useHudStore((s) => s.departments);
  const selectedTeam = useHudStore((s) => s.selectedTeam);
  const tasks = useHudStore((s) => s.tasks);
  const status = useHudStore((s) => s.status);
  const team = departments.find((d) => d.id === selectedTeam);
  const roles = useMemo(() => workerRoles(team), [team]);

  const { byRole, outsiders } = useMemo(
    () => assignTasksToCards(team, departments, Object.values(tasks)),
    [team, departments, tasks],
  );
  const outsiderCards = useMemo(() => {
    const live = outsiders.filter((t) => isLiveState(t.state));
    const done = outsiders.filter((t) => !isLiveState(t.state));
    return [...live.reverse(), ...done.reverse()].slice(0, OUTSIDER_CARDS);
  }, [outsiders]);
  const running = useMemo(
    () => [...byRole.values()].filter((list) => isLiveState(currentTask(list)?.state ?? "")).length,
    [byRole],
  );

  return (
    <DeckPanel
      label={team ? `terminals · ${team.name}` : "terminals"}
      icon={<Users size={10} className="text-accent" aria-hidden />}
      meta={
        team
          ? `${roles.length} ajan · ${running} çalışıyor · arka planda claude -p`
          : status === "connected"
            ? "takım yok"
            : "köprü bağlı değil"
      }
      tone={running > 0 ? "accent" : "neutral"}
      live={running > 0}
      flush
      className="h-full min-h-0 min-w-0 flex-1"
      bodyClassName="min-h-0"
    >
      <div className="thin-scroll grid min-h-0 flex-1 auto-rows-[minmax(150px,1fr)] grid-cols-[repeat(auto-fill,minmax(min(100%,230px),1fr))] content-start gap-2 overflow-y-auto p-2">
        {roles.map((role) => (
          <AgentCard key={role.id} team={team} role={role} tasks={byRole.get(role.id) ?? EMPTY_TASKS} />
        ))}
        {outsiderCards.length > 0 && (
          <div className="col-span-full flex items-center gap-1.5 pt-1 font-mono text-[8px] uppercase tracking-[0.16em] text-text-lo">
            <span className="h-px flex-1 bg-line" aria-hidden />
            ekip dışı · {outsiders.length}
            <span className="h-px flex-1 bg-line" aria-hidden />
          </div>
        )}
        {outsiderCards.map((task) => (
          <AgentCard key={task.id} team={team} role={null} tasks={[task]} outsider />
        ))}
        {roles.length === 0 && outsiderCards.length === 0 && (
          <p className="col-span-full m-auto max-w-sm px-3 py-6 text-center font-mono text-[9px] leading-relaxed text-text-lo">
            {team
              ? "Bu takımda lead dışında etkin ajan yok. Takım modülünden ajan ekle ya da etkinleştir."
              : status === "connected"
                ? "Köprü takım bildirmedi. Takım modülünden bir takım tanımla."
                : "Köprü bağlanınca seçili takımın ajanları burada kart olarak belirir."}
          </p>
        )}
      </div>
    </DeckPanel>
  );
}

const EMPTY_TASKS: Task[] = [];
