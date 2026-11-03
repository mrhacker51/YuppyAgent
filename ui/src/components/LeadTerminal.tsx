"use client";

import { useEffect, useMemo, useRef } from "react";
import { Crown, Play, RotateCw, Square, SquareTerminal } from "lucide-react";
import { Skeleton, Tooltip } from "fancy-ui-react";
import { LEAD_AGENT, MAX_LEAD_PTYS, useHudStore } from "@/lib/store";
import { leadRole } from "@/lib/teamRoster";
import DeckPanel from "./fancy/Panel";
import TerminalPane from "./TerminalPane";
import { takePendingCommandTarget } from "./views/shared";

const LIVE_STATES = new Set(["queued", "running", "awaiting_approval"]);

/** Focus xterm's hidden input once it exists (the pane imports xterm async). */
function focusXterm(container: HTMLElement | null, attempt = 0) {
  if (!container) return;
  const input = container.querySelector<HTMLTextAreaElement>("textarea.xterm-helper-textarea");
  if (input) {
    input.focus();
    return;
  }
  if (attempt < 20) setTimeout(() => focusXterm(container, attempt + 1), 100);
}

function exitSummary(exit: { exitCode?: number | null; signal?: string | null } | undefined) {
  if (!exit) return "";
  if (exit.exitCode != null) return `çıkış ${exit.exitCode}`;
  if (exit.signal) return `sinyal ${exit.signal}`;
  return "kapatıldı";
}

/**
 * Ana komut penceresi — the SELECTED team's lead: a real, interactive Claude
 * Code CLI (e.g. "Optimus · Transformers"). Only this team's lead is mounted;
 * another team's lead may stay alive in the background (at most
 * MAX_LEAD_PTYS), but it never gets an xterm until its tab is selected.
 * The operator talks to the lead here; the lead splits the work itself with
 * its yuppy_dispatch / yuppy_tasks / yuppy_cancel MCP tools, and those tasks
 * show up as the team in the matrix and the information console. The PTY is
 * opened by the store once per connection (never duplicated); if it exits,
 * this panel says so and offers a real restart.
 */
export default function LeadTerminal() {
  const leadSessionId = useHudStore((s) => s.leadSessionId);
  const session = useHudStore((s) =>
    s.leadSessionId ? s.sessions.find((x) => x.id === s.leadSessionId) : undefined,
  );
  const leadPending = useHudStore((s) => s.leadPending);
  const leadExit = useHudStore((s) => s.leadExit);
  const status = useHudStore((s) => s.status);
  const claude = useHudStore((s) => s.agents.find((a) => a.id === LEAD_AGENT));
  const tasks = useHudStore((s) => s.tasks);
  const selectedTeam = useHudStore((s) => s.selectedTeam);
  const team = useHudStore((s) => s.departments.find((d) => d.id === s.selectedTeam));
  const liveLeads = useHudStore((s) => Object.keys(s.leadSessions).length);
  const openLeadTerminal = useHudStore((s) => s.openLeadTerminal);
  const restartSession = useHudStore((s) => s.restartSession);
  const focusSession = useHudStore((s) => s.focusSession);
  const setSelectedDept = useHudStore((s) => s.setSelectedDept);
  const send = useHudStore((s) => s.send);
  const bodyRef = useRef<HTMLDivElement>(null);

  const connected = status === "connected";
  const available = Boolean(claude?.available);

  const leadTasks = useMemo(() => {
    let running = 0;
    let queued = 0;
    for (const t of Object.values(tasks)) {
      if (t.origin !== "lead") continue;
      if (selectedTeam && t.department && t.department !== selectedTeam) continue;
      if (t.state === "running") running += 1;
      else if (LIVE_STATES.has(t.state)) queued += 1;
    }
    return { running, queued };
  }, [tasks, selectedTeam]);
  const callsign = leadRole(team)?.callsign?.trim() || "Lead";
  const heading = team ? `${callsign} · ${team.name} · lead` : "ana komut · lead claude";

  // ⌘K and every "aim the command" launcher land here: the lead terminal is
  // the one place commands are typed. A launcher pressed while AgentSpace was
  // unmounted parks its target; it is drained on mount.
  useEffect(() => {
    const focus = (detail?: { department?: string } | null) => {
      if (detail?.department) setSelectedDept(detail.department);
      const id = useHudStore.getState().leadSessionId;
      if (id) focusSession(id);
      focusXterm(bodyRef.current);
    };
    const pending = takePendingCommandTarget();
    if (pending) focus(pending);
    const onFocus = () => focus(null);
    const onTarget = (event: Event) => {
      takePendingCommandTarget();
      focus((event as CustomEvent<{ department?: string }>).detail ?? null);
    };
    window.addEventListener("yuppy:focus-prompt", onFocus);
    window.addEventListener("yuppy:command-target", onTarget);
    return () => {
      window.removeEventListener("yuppy:focus-prompt", onFocus);
      window.removeEventListener("yuppy:command-target", onTarget);
    };
  }, [focusSession, setSelectedDept]);

  const live = leadTasks.running > 0;
  const meta = session
    ? leadTasks.running + leadTasks.queued > 0
      ? `dağıtılan · ${leadTasks.running} çalışıyor · ${leadTasks.queued} sırada`
      : `yuppy_dispatch · ${liveLeads}/${MAX_LEAD_PTYS} lead açık`
    : leadPending
      ? "açılıyor"
      : leadExit
        ? `kapandı · ${exitSummary(leadExit)}`
        : connected
          ? "kapalı"
          : "köprü yok";

  return (
    <DeckPanel
      label={heading}
      icon={<Crown size={10} className="text-accent" aria-hidden />}
      meta={meta}
      tone={session ? "accent" : leadExit ? "warn" : "neutral"}
      live={live}
      flush
      className="h-full min-h-0 min-w-0 flex-1"
      bodyClassName="min-h-0"
      actions={
        session ? (
          <span className="flex shrink-0 items-center gap-1">
            <Tooltip content="SIGINT gönder (Ctrl-C)" side="bottom" align="end">
              <button
                type="button"
                onClick={() => send({ type: "terminal_interrupt", session_id: session.id })}
                aria-label="Lead'e SIGINT gönder"
                className="grid size-5 place-items-center rounded-[4px] border border-transparent text-text-lo transition-colors hover:border-warn/50 hover:text-warn focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/60"
              >
                <Square size={9} aria-hidden />
              </button>
            </Tooltip>
            <Tooltip content="Lead'i yeniden başlat" side="bottom" align="end">
              <button
                type="button"
                onClick={() => restartSession(session.id)}
                aria-label="Lead'i yeniden başlat"
                className="grid size-5 place-items-center rounded-[4px] border border-transparent text-text-lo transition-colors hover:border-line-strong hover:text-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/60"
              >
                <RotateCw size={10} aria-hidden />
              </button>
            </Tooltip>
          </span>
        ) : undefined
      }
    >
      <div
        ref={bodyRef}
        onMouseDown={() => {
          if (leadSessionId) focusSession(leadSessionId);
        }}
        className="term-surface relative flex min-h-0 flex-1 flex-col overflow-hidden bg-[#080b0f]"
      >
        {session ? (
          <TerminalPane key={session.id} session={session} autoFocus />
        ) : (
          <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 p-4 text-center">
            <SquareTerminal size={16} className="text-accent/60" aria-hidden />
            {leadPending ? (
              <>
                <p className="font-mono text-[9px] uppercase tracking-[0.16em] text-text-mid">
                  {callsign} açılıyor
                </p>
                <Skeleton
                  variant="text"
                  lines={2}
                  animation="shimmer"
                  label="lead Claude PTY bekleniyor"
                  className="w-48"
                />
              </>
            ) : (
              <>
                <p className="font-mono text-[9px] uppercase tracking-[0.16em] text-text-mid">
                  {!connected
                    ? "köprü bağlı değil"
                    : !available
                      ? "claude code yok"
                      : leadExit
                        ? `lead kapandı · ${exitSummary(leadExit)}`
                        : "lead kapalı"}
                </p>
                <p className="max-w-sm font-mono text-[9px] leading-relaxed text-text-lo">
                  {!connected
                    ? "Köprü bağlanınca lead Claude burada kendiliğinden açılır. Ayarlar'dan bağlan."
                    : !available
                      ? claude?.install_hint ||
                        "Claude Code PATH'te bulunamadı — kur; ana komut penceresi onunla çalışır."
                      : "Ana komut penceresi lead Claude'dur: işi ona yaz, ekibe o dağıtır. Yeniden başlatınca gerçek bir PTY açılır."}
                </p>
                {connected && available && (
                  <button
                    type="button"
                    onClick={() => openLeadTerminal()}
                    className="mt-1 flex items-center gap-1.5 rounded-[6px] border border-accent/50 bg-accent/15 px-3 py-1 font-mono text-[9px] uppercase tracking-[0.12em] text-accent transition-colors hover:border-accent hover:bg-accent/25 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/60"
                  >
                    {leadExit ? <RotateCw size={10} aria-hidden /> : <Play size={10} aria-hidden />}
                    {leadExit ? "lead'i yeniden başlat" : "lead'i başlat"}
                  </button>
                )}
              </>
            )}
          </div>
        )}
      </div>
    </DeckPanel>
  );
}
