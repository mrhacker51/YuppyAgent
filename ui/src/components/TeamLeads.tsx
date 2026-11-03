"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowUpRight, ChevronDown, Crown, Play } from "lucide-react";
import { useHudStore } from "@/lib/store";
import type { AgentStatusDto, DepartmentDto, DepartmentRoleDto } from "@/lib/protocol";
import { agentShortName } from "@/lib/agents";
import { teamIdentity, type Squad } from "@/lib/teamIdentity";
import {
  LEAD_CARD_DEFAULT_PX,
  LEAD_CARD_MAX_PX,
  LEAD_CARD_MIN_PX,
  clampPx,
  loadLeadCardHeight,
  persistLeadCardHeight,
} from "@/lib/panelResize";
import SquadGlyph from "./SquadGlyph";
import SplitSash from "./SplitSash";
import TerminalPreview from "./TerminalPreview";
import Badge from "./fancy/Badge";
import NumberTicker from "./fancy/NumberTicker";
import DeckPanel, { DeckStat } from "./fancy/Panel";

/**
 * A department role that explicitly manages the team. Bridges that do not
 * name a manager fall through to the first role that can actually run — the
 * panel never invents a lead the department does not list.
 */
const LEAD_ROLE = /lead|manager|chief|head|coordinator|principal|owner|yönetici|lider|şef|direktör|sorumlu/i;

/** The command the idle prompt shows — the real executable the seat would run. */
function cliCommand(cli: string | undefined): string {
  if (!cli) return "—";
  if (cli.includes("claude")) return "claude";
  if (cli.includes("codex")) return "codex";
  return cli;
}

interface LiveSession {
  id: string;
  agent: string;
  department?: string;
}

interface LeadRow {
  dept: DepartmentDto;
  squad: Squad;
  role: DepartmentRoleDto | null;
  agent: AgentStatusDto | undefined;
  /** Live PTY for this department + role CLI, when one is actually running. */
  session: LiveSession | undefined;
}

/** Sessions are replaced on every terminal frame, but only membership matters
 * here. A primitive signature keeps a busy PTY from re-rendering this panel;
 * frames themselves are read by TerminalPreview's own 1 Hz tick. */
function sessionSignature(sessions: ReadonlyArray<LiveSession>): string {
  return sessions.map((s) => `${s.id}\t${s.agent}\t${s.department ?? ""}`).join("\n");
}

function parseSessionSignature(signature: string): LiveSession[] {
  if (!signature) return [];
  return signature.split("\n").map((row) => {
    const [id, agent, department] = row.split("\t");
    return { id, agent, department: department || undefined };
  });
}

function pickLeadRole(
  dept: DepartmentDto,
  agents: readonly AgentStatusDto[],
): DepartmentRoleDto | null {
  const roles = (dept.roles ?? []).filter((r) => r.enabled !== false);
  if (roles.length === 0) return null;
  const explicit = roles.find((r) => LEAD_ROLE.test(`${r.id} ${r.name}`));
  if (explicit) return explicit;
  const available = new Set(agents.filter((a) => a.available).map((a) => a.id));
  return roles.find((r) => available.has(r.cli)) ?? roles[0];
}

/** The live terminal that belongs to this team only. A session opened
 * without a department is not claimed by every team. */
function leadSession(
  sessions: readonly LiveSession[],
  dept: string,
  role: DepartmentRoleDto | null,
  activeSessionId: string | undefined,
): LiveSession | undefined {
  if (!role) return undefined;
  const matching = sessions.filter((s) => s.agent === role.cli && s.department === dept);
  if (matching.length === 0) return undefined;
  return matching.find((s) => s.id === activeSessionId) ?? matching[matching.length - 1];
}

/**
 * ANA AJAN — the agent that runs each real department, with its actual CLI
 * terminal underneath. This rails owns the whole middle column: no work-order
 * list above it, no side panel below it.
 *
 * The monitor is the same PTY the matrix owns, painted as its last frame (a
 * second xterm would fight the matrix over the PTY size). Clicking it focuses
 * the one interactive terminal in the matrix; a team with no process says so
 * and offers a real spawn. The monitor height is drag-resizable and shared,
 * so the rail can be a strip of tall terminals or a compact roster.
 */
export default function TeamLeads() {
  const departments = useHudStore((s) => s.departments);
  const agents = useHudStore((s) => s.agents);
  const tasks = useHudStore((s) => s.tasks);
  const sessionKey = useHudStore((s) => sessionSignature(s.sessions));
  const activeSessionId = useHudStore((s) => s.activeSessionId);
  const selectedDept = useHudStore((s) => s.selectedDept);
  const setSelectedDept = useHudStore((s) => s.setSelectedDept);
  const openTerminal = useHudStore((s) => s.openTerminal);
  const focusSession = useHudStore((s) => s.focusSession);
  const status = useHudStore((s) => s.status);

  const sessions = useMemo(() => parseSessionSignature(sessionKey), [sessionKey]);

  const [monitorHeight, setMonitorHeight] = useState(LEAD_CARD_DEFAULT_PX);
  const heightRef = useRef(monitorHeight);
  useEffect(() => {
    heightRef.current = monitorHeight;
  }, [monitorHeight]);
  useEffect(() => {
    // Persisted presentation is applied after hydration, like every other
    // deck preference, so the exported HTML and the first render agree.
    queueMicrotask(() => setMonitorHeight(loadLeadCardHeight()));
  }, []);

  const rows = useMemo<LeadRow[]>(() => {
    const out = departments.map((dept, index) => {
      const role = pickLeadRole(dept, agents);
      return {
        dept,
        squad: teamIdentity(dept.id, dept.name, index),
        role,
        agent: role ? agents.find((a) => a.id === role.cli) : undefined,
        session: leadSession(sessions, dept.id, role, activeSessionId),
      };
    });
    // Selected team first, then teams that are running, then registry order.
    const rank = (row: LeadRow) =>
      (selectedDept === row.dept.id ? 0 : 2) + (row.session ? 0 : 1);
    return out
      .map((row, index) => ({ row, index }))
      .sort((a, b) => rank(a.row) - rank(b.row) || a.index - b.index)
      .map(({ row }) => row);
  }, [departments, agents, sessions, activeSessionId, selectedDept]);

  const liveCount = rows.filter((r) => r.session).length;
  const connected = status === "connected";
  /** Latest real task per CLI, for the worker rows. */
  const latestByCli = useMemo(() => {
    const map: Record<string, string> = {};
    for (const task of Object.values(tasks)) {
      if (task.cli) map[task.cli] = task.title ?? task.id;
    }
    return map;
  }, [tasks]);

  const focusTeam = (deptId: string) => {
    setSelectedDept(deptId);
    window.dispatchEvent(new CustomEvent("yuppy:focus-team", { detail: deptId }));
  };

  /** Bring the one real xterm into view — the monitor is read-only by design
   * so two views never resize the same PTY against each other. */
  const revealSession = (id: string) => {
    focusSession(id);
    requestAnimationFrame(() => {
      const cards = document.querySelectorAll<HTMLElement>("[data-session-id]");
      for (const card of cards) {
        if (card.dataset.sessionId !== id) continue;
        card.scrollIntoView({ block: "nearest", behavior: "smooth" });
        break;
      }
    });
  };

  return (
    <DeckPanel
      label="Ana ajan"
      icon={<Crown size={10} className="text-warn" aria-hidden />}
      meta={
        <span className="flex items-center gap-2">
          <DeckStat label="lider" value={liveCount} tone={liveCount > 0 ? "accent" : "neutral"} />
          <DeckStat label="takım" value={rows.length} />
        </span>
      }
      tone={liveCount > 0 ? "accent" : "neutral"}
      live={liveCount > 0}
      flush
      className="h-full min-h-0 flex-1"
      bodyClassName="min-h-0"
      actions={
        <Badge tone={liveCount > 0 ? "ok" : "muted"} size="sm">
          <NumberTicker value={liveCount} /> / {rows.length}
        </Badge>
      }
    >
      <div className="pixel-scroll min-h-0 flex-1 overflow-y-auto">
        {rows.length === 0 ? (
          <p className="pixel-body px-2 py-2 text-[12px] leading-tight text-text-lo">
            Takım kaydı yok — köprü bir departman bildirdiğinde lideri burada görünür.
          </p>
        ) : (
          <ul className="divide-y divide-line/50">
            {rows.map(({ dept, squad, role, agent, session }) => {
              const selected = selectedDept === dept.id;
              const available = agent?.available ?? false;
              const display = role ? agentShortName(role.cli) : "—";
              const model = role?.model?.split("/").pop() ?? null;
              return (
                <li
                  key={dept.id}
                  className={`relative transition-colors ${
                    selected ? "bg-bg-2/40" : "hover:bg-bg-2/25"
                  }`}
                  style={{ borderLeft: `2px solid ${selected ? squad.accent : "transparent"}` }}
                >
                  {/* Team line — selects the squad and frames its desks. */}
                  <button
                    type="button"
                    onClick={() => focusTeam(dept.id)}
                    title={`${squad.callsign} takımı — ${squad.name}${dept.enabled === false ? " · kapalı" : ""}`}
                    className="flex w-full items-center gap-1.5 px-2 pb-1 pt-1.5 text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent/60"
                  >
                    <SquadGlyph
                      icon={squad.icon}
                      size={12}
                      style={{ color: squad.accent }}
                      className="shrink-0"
                    />
                    <span
                      className="shrink-0 font-mono text-[7.5px] font-semibold uppercase tracking-[0.16em]"
                      style={{ color: squad.accent }}
                    >
                      {squad.callsign}
                    </span>
                    <span className="min-w-0 flex-1 truncate font-mono text-[8px] uppercase tracking-wider text-text-lo">
                      {squad.name}
                    </span>
                    {session ? (
                      <Badge tone="ok" size="sm">
                        <span className="size-1 rounded-full bg-ok deck-live" aria-hidden />
                        canlı
                      </Badge>
                    ) : (
                      <Badge tone={dept.enabled === false ? "danger" : "muted"} size="sm">
                        {dept.enabled === false ? "kapalı" : "boşta"}
                      </Badge>
                    )}
                  </button>

                  {/* Lead agent line — role first, executor second. */}
                  <div className="flex items-center gap-1.5 px-2 pb-1">
                    <Crown size={9} className="shrink-0 text-warn/80" aria-hidden />
                    <span className="min-w-0 flex-1 truncate text-[11px] leading-none text-text-hi">
                      {role?.name ?? "rol tanımlı değil"}
                    </span>
                    <Badge tone={available ? "outline" : "danger"} size="sm">
                      {display}
                    </Badge>
                  </div>

                  {/* Org chart: lead above, its real configured roles below.
                      Engine and task come from the store; no synthetic seat. */}
                  {(() => {
                    const workers = (dept.roles ?? []).filter(
                      (r) => r.id !== role?.id && r.enabled !== false,
                    );
                    if (workers.length === 0) return null;
                    return (
                      <ul className="mb-1 space-y-px border-l border-line/60 pl-2 pr-2">
                        {workers.map((worker) => {
                          const workerLive = sessions.some(
                            (s) => s.agent === worker.cli && s.department === dept.id,
                          );
                          const workerTask = latestByCli[worker.cli];
                          return (
                            <li
                              key={worker.id}
                              className="flex items-center gap-1.5 font-mono text-[8px] text-text-lo"
                              title={`${worker.name} · ${worker.cli}${
                                worker.model ? ` · ${worker.model}` : ""
                              }`}
                            >
                              <span className="shrink-0 text-line" aria-hidden>
                                └
                              </span>
                              <span
                                className={`size-1 shrink-0 rounded-full ${
                                  workerLive ? "bg-ok deck-live" : "bg-text-lo/40"
                                }`}
                                aria-hidden
                              />
                              <span className="min-w-0 flex-1 truncate text-text-mid">
                                {worker.name}
                              </span>
                              <span className="shrink-0 uppercase tracking-wider text-text-lo/70">
                                {agentShortName(worker.cli)}
                              </span>
                              {workerTask && (
                                <span className="hidden max-w-[88px] shrink-0 truncate text-accent/80 sm:inline">
                                  {workerTask}
                                </span>
                              )}
                            </li>
                          );
                        })}
                      </ul>
                    );
                  })()}

                  {/* Every team shows its CLI terminal, live or idle: the
                      rail is a stack of real terminal boxes, not a list of
                      status words. */}
                  <div className="px-2 pb-1.5">
                    <div
                      className="term-surface relative overflow-hidden rounded-[4px] border border-line/70 bg-[#080b0f] shadow-[inset_0_1px_0_rgba(0,0,0,0.6)]"
                      style={{ height: monitorHeight }}
                    >
                      {session ? (
                        <button
                          type="button"
                          onClick={() => revealSession(session.id)}
                          title="Bu takımın gerçek terminalini matriste odakla"
                          aria-label={`${squad.callsign} liderinin terminalini matriste aç`}
                          className="group block h-full w-full cursor-pointer text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent/60"
                        >
                          <TerminalPreview
                            sessionId={session.id}
                            label={`${squad.callsign} lideri`}
                            maxLines={Math.max(3, Math.floor((monitorHeight - 16) / 13))}
                          />
                          <span className="pointer-events-none absolute right-1.5 top-1 flex items-center gap-0.5 rounded-sm border border-line/60 bg-bg-0/85 px-1 font-mono text-[7px] uppercase tracking-wider text-text-lo transition-colors group-hover:border-accent/40 group-hover:text-accent">
                            matris <ArrowUpRight size={8} aria-hidden />
                          </span>
                        </button>
                      ) : (
                        // Idle: a real prompt with no process behind it yet,
                        // so the box still reads as a terminal, not a void.
                        <div className="flex h-full flex-col justify-between px-2 pb-[11px] pt-1.5">
                          <div className="flex min-w-0 items-center gap-1 font-mono text-[9px] leading-none">
                            <span className="shrink-0 text-accent/70" aria-hidden>
                              ❯
                            </span>
                            <span className="truncate text-text-mid/80">
                              {role ? cliCommand(role.cli) : "—"}
                            </span>
                            <span
                              className="ml-0.5 inline-block h-[9px] w-[5px] shrink-0 animate-pulse bg-text-lo/45"
                              aria-hidden
                            />
                          </div>
                          <div className="flex flex-col items-center gap-1">
                            <button
                              type="button"
                              disabled={!role || !available || !connected || dept.enabled === false}
                              onClick={() =>
                                role &&
                                openTerminal(
                                  role.cli,
                                  `${agentShortName(role.cli)} · ${role.name}`,
                                  dept.id,
                                )
                              }
                              title={
                                !role
                                  ? "Bu departmanda çalıştırılabilir bir rol yok"
                                  : !available
                                    ? `${display} PATH'te bulunamadı`
                                    : dept.enabled === false
                                      ? "Takım kapalı"
                                      : `${role.name} için gerçek PTY aç`
                              }
                              className="pixel-btn pixel-btn-primary !px-2 !py-0.5 !text-[7px] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/50 disabled:cursor-not-allowed disabled:opacity-40"
                            >
                              <Play size={8} aria-hidden />
                              lideri başlat
                            </button>
                            <p className="max-w-full truncate font-mono text-[7px] text-text-lo/50">
                              {!available && role
                                ? `${display} PATH'te yok`
                                : model ?? role?.description ?? ""}
                            </p>
                          </div>
                        </div>
                      )}

                      {/* Bottom edge: the monitor's own height grip. One value is
                          shared by every team so the rail reads as one roster. */}
                      <SplitSash
                        orientation="horizontal"
                        label="Lider terminal yüksekliği (tüm takımlar)"
                        valueNow={monitorHeight}
                        valueMin={LEAD_CARD_MIN_PX}
                        valueMax={LEAD_CARD_MAX_PX}
                        onDelta={(dy) =>
                          setMonitorHeight((h) =>
                            clampPx(h + dy, LEAD_CARD_MIN_PX, LEAD_CARD_MAX_PX, LEAD_CARD_DEFAULT_PX),
                          )
                        }
                        onCommit={() => persistLeadCardHeight(heightRef.current)}
                        onReset={() => {
                          setMonitorHeight(LEAD_CARD_DEFAULT_PX);
                          persistLeadCardHeight(LEAD_CARD_DEFAULT_PX);
                        }}
                        className="absolute inset-x-0 -bottom-[1px] h-[7px]"
                      />
                      <ChevronDown
                        size={7}
                        className="pointer-events-none absolute bottom-0.5 left-1/2 -translate-x-1/2 text-text-lo/25"
                        aria-hidden
                      />
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <footer className="flex h-5 shrink-0 items-center gap-1.5 border-t border-line/60 bg-bg-1/60 px-2 font-mono text-[7px] uppercase tracking-[0.14em] text-text-lo">
        <Crown size={8} className="text-warn/70" aria-hidden />
        <span>{rows.length} takım</span>
        <span className="text-line">·</span>
        <span>{liveCount} lider canlı</span>
        <span className="ml-auto normal-case tracking-normal text-text-lo/60">
          alt kenarı sürükle → yükseklik
        </span>
      </footer>
    </DeckPanel>
  );
}
