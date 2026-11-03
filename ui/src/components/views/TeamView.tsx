"use client";

import { Check, CircleDot, Cpu, SquareTerminal, Users, Waypoints, X } from "lucide-react";
import {
  Badge,
  Skeleton,
  SubagentList,
  Tooltip,
  type SubagentData,
} from "fancy-ui-react";
import { useHudStore } from "@/lib/store";
import { Card, ViewShell, dispatchCommandTarget } from "./shared";
import TeamVoices from "../TeamVoices";
import { teamIdentity } from "@/lib/teamIdentity";
import SquadGlyph from "../SquadGlyph";

function agentShortName(agent: string): string {
  if (agent.includes("claude")) return "Claude Code";
  if (agent.includes("codex")) return "Codex";
  return agent;
}

interface Seat {
  id: string;
  name: string;
  cli: string;
  model?: string | null;
  enabled?: boolean;
}

/**
 * Team module: real departments, configured seats and detected CLIs. A seat
 * is configuration; a running PTY is the only thing shown as live.
 */
export default function TeamView() {
  const departments = useHudStore((s) => s.departments);
  const agents = useHudStore((s) => s.agents);
  const sessions = useHudStore((s) => s.sessions);
  const status = useHudStore((s) => s.status);
  const selectedDept = useHudStore((s) => s.selectedDept);
  const setSelectedDept = useHudStore((s) => s.setSelectedDept);
  const openTerminal = useHudStore((s) => s.openTerminal);
  const focusSession = useHudStore((s) => s.focusSession);
  const connected = status === "connected";

  const roleCount = departments.reduce((n, d) => n + (d.roles?.length ?? 0), 0);
  const liveSessions = sessions.length;

  const openSeat = (departmentId: string, departmentName: string, seat: Seat) => {
    setSelectedDept(departmentId);
    const live = sessions.find((s) => s.agent === seat.cli);
    if (live) {
      focusSession(live.id);
      return;
    }
    openTerminal(seat.cli, `${departmentName} · ${seat.name}`, departmentId);
  };

  return (
    <ViewShell
      title="Takım"
      kicker={`${departments.length} departman · ${roleCount} rol · ${agents.length} CLI`}
      right={
        <span className="flex items-center gap-2 font-mono text-[8px] uppercase tracking-wider text-text-lo">
          <span className="flex items-center gap-1">
            <span className={`size-1.5 rounded-full ${connected ? "bg-ok" : "bg-danger"}`} />
            {connected ? "bridge canlı" : "bridge offline"}
          </span>
          <span className="text-line">/</span>
          <span>{liveSessions} PTY</span>
        </span>
      }
      footer={
        <>
          <Users size={9} aria-hidden />
          <span>roller yapılandırma oturumlarıdır · canlı süreç yalnızca CLI yürütücüsüdür</span>
          <span className="ml-auto text-text-lo/70">düzenleme API&apos;si bridge v2&apos;de yok</span>
        </>
      }
    >
      <div className="grid gap-1 p-1 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <div className="space-y-1">
          {departments.map((dept) => {
            const seats: Seat[] = dept.roles?.length
              ? dept.roles
              : (dept.agents ?? []).map((a, i) => ({
                  id: `${dept.id}-agent-${i}`,
                  name: a.cli,
                  cli: a.cli,
                  model: a.model,
                  enabled: true,
                }));
            const departmentSessions = sessions.filter((s) => s.department === dept.id);
            const active = selectedDept === dept.id;
            return (
              <section
                key={dept.id}
                className={`border bg-bg-1/35 ${active ? "border-accent/40" : "border-line"}`}
              >
                <header className="flex items-center gap-1.5 border-b border-line bg-bg-1 px-2 py-1.5">
                  <span
                    className="grid size-5 shrink-0 place-items-center rounded-[3px] border"
                    style={{
                      borderColor: `${teamIdentity(dept.id, dept.name).accent}55`,
                      backgroundColor: `${teamIdentity(dept.id, dept.name).accent}18`,
                      color: teamIdentity(dept.id, dept.name).accent,
                    }}
                  >
                    <SquadGlyph icon={teamIdentity(dept.id, dept.name).icon} size={11} />
                  </span>
                  <button
                    type="button"
                    onClick={() => setSelectedDept(active ? "" : dept.id)}
                    className="flex min-w-0 flex-col items-start text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/50"
                    aria-pressed={active}
                    title="Takımı komut hedefi yap"
                  >
                    <span
                      className="font-mono text-[8px] font-semibold uppercase tracking-[0.16em]"
                      style={{ color: teamIdentity(dept.id, dept.name).accent }}
                    >
                      {teamIdentity(dept.id, dept.name).callsign}
                    </span>
                    <span className="min-w-0 truncate text-[10.5px] font-medium leading-tight text-text-hi hover:text-accent">
                      {dept.name}
                    </span>
                  </button>
                  <span className="ml-1 font-mono text-[8px] uppercase tracking-wider text-text-lo">
                    {departmentSessions.length} canlı / {seats.length} rol · max{" "}
                    {dept.max_concurrency}
                  </span>
                  <Badge
                    variant={dept.enabled ? "success" : "destructive"}
                    size="sm"
                    className="shrink-0"
                  >
                    {dept.enabled ? "aktif" : "kapalı"}
                  </Badge>
                  {active && (
                    <span className="ml-auto flex items-center gap-1 font-mono text-[8px] uppercase tracking-wider text-accent">
                      <Check size={8} aria-hidden /> hedef
                    </span>
                  )}
                </header>

                {dept.description && (
                  <p className="border-b border-line/50 px-2 py-1 text-[10px] leading-relaxed text-text-mid">
                    {dept.description}
                  </p>
                )}

                <div className="px-1 py-0.5">
                  {seats.length === 0 ? (
                    <p className="px-1 py-2 font-mono text-[9px] text-text-lo">
                      Bu takımda rol tanımlı değil.
                    </p>
                  ) : (
                    <SubagentList
                      label={`${dept.name} rolleri`}
                      agents={seats.map<SubagentData>((seat) => {
                        const live = sessions.find((s) => s.agent === seat.cli);
                        const status = live
                          ? "running"
                          : seat.enabled === false
                            ? "cancelled"
                            : "pending";
                        return {
                          id: seat.id,
                          name: seat.name,
                          status,
                          model: seat.model ?? undefined,
                          task: `${agentShortName(seat.cli)}${
                            seat.model ? ` · ${seat.model}` : ""
                          } · ${
                            live
                              ? `canlı PTY #${live.id.slice(-5)}`
                              : seat.enabled === false
                                ? "pasif rol"
                                : "CLI varsayılanı"
                          }`,
                        };
                      })}
                      item={(agent, index) => {
                        const seat = seats[index];
                        const live = sessions.find((s) => s.agent === seat.cli);
                        return (
                          <span className="flex min-w-0 flex-1 items-center gap-1.5">
                            <span className="min-w-0 flex-1">
                              <span className="flex items-center gap-1.5">
                                <span className="truncate text-[10px] text-text-mid">
                                  {seat.name}
                                </span>
                                {seat.enabled === false && (
                                  <span className="font-mono text-[8px] uppercase text-danger/80">
                                    pasif
                                  </span>
                                )}
                              </span>
                              <span className="block truncate font-mono text-[8px] text-text-lo">
                                {agent.task}
                              </span>
                            </span>
                            <Tooltip content={live ? "Canlı oturuma odaklan" : "Bu rol için PTY aç"}>
                              <button
                                type="button"
                                disabled={!connected || seat.enabled === false}
                                onClick={() => openSeat(dept.id, dept.name, seat)}
                                className="flex shrink-0 items-center gap-1 border border-line px-1.5 py-0.5 font-mono text-[8px] uppercase tracking-wider text-text-mid transition-colors hover:border-line-strong hover:text-accent disabled:cursor-not-allowed disabled:border-line/60 disabled:text-text-lo/60 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/50"
                              >
                                <SquareTerminal size={8} aria-hidden />
                                {live ? "odak" : "aç"}
                              </button>
                            </Tooltip>
                            <Tooltip content="Takımı seç ve lead Claude terminaline git">
                              <button
                                type="button"
                                onClick={() => {
                                  setSelectedDept(dept.id);
                                  dispatchCommandTarget(seat.cli, dept.id);
                                }}
                                className="shrink-0 border border-transparent px-1 py-0.5 font-mono text-[8px] uppercase tracking-wider text-text-lo transition-colors hover:border-line hover:text-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/50"
                              >
                                hedef
                              </button>
                            </Tooltip>
                          </span>
                        );
                      }}
                    />
                  )}
                </div>

                <div className="flex flex-wrap items-center gap-1.5 border-t border-line/60 px-2 py-1 font-mono text-[8px] text-text-lo">
                  <Waypoints size={8} aria-hidden />
                  <span className="normal-case tracking-normal">
                    ws: {dept.workspace || "miras alınır"}
                  </span>
                  {(dept.allowed_tools ?? []).slice(0, 5).map((tool) => (
                    <span key={tool} className="border border-line/70 px-1 py-px">
                      {tool}
                    </span>
                  ))}
                  {(dept.allowed_tools ?? []).length > 5 && (
                    <span>+{(dept.allowed_tools ?? []).length - 5}</span>
                  )}
                </div>
              </section>
            );
          })}

          {departments.length === 0 &&
            (status === "connecting" || status === "authenticating" ? (
              <div className="space-y-1" aria-busy="true">
                <Skeleton
                  variant="rect"
                  className="h-20 w-full"
                  loading
                  animation="pulse"
                  label="Takımlar yükleniyor"
                />
                <Skeleton
                  variant="rect"
                  className="h-20 w-full"
                  loading
                  animation="pulse"
                  label=""
                />
              </div>
            ) : (
              <div className="border border-dashed border-line px-3 py-8 text-center">
                <CircleDot size={16} className="mx-auto text-text-lo" aria-hidden />
                <p className="mt-1 font-mono text-[9px] uppercase tracking-wider text-text-lo">
                  {connected ? "departmanlar yükleniyor…" : "bridge bağlı değil"}
                </p>
              </div>
            ))}
        </div>

        <div className="space-y-1">
          <Card
            title="Yürütücüler"
            sub={`${agents.filter((a) => a.available).length}/${agents.length} hazır`}
          >
            <div className="divide-y divide-line/50">
              {agents.map((agent) => {
                const live = sessions.find((s) => s.agent === agent.id);
                return (
                  <div key={agent.id} className="px-2 py-1.5">
                    <div className="flex items-center gap-1.5">
                      <span
                        className={`size-1.5 shrink-0 rounded-full ${
                          live ? "bg-ok" : agent.available ? "bg-text-lo/50" : "bg-danger/60"
                        }`}
                        aria-hidden
                      />
                      <span className="min-w-0 flex-1 truncate text-[10px] text-text-hi">
                        {agent.display_name}
                      </span>
                      <span className="font-mono text-[8px] text-text-lo">
                        {agent.version ?? "sürüm ?"}
                      </span>
                    </div>
                    <div className="mt-1 flex items-center gap-1.5 font-mono text-[8px] text-text-lo">
                      <span className="truncate">id: {agent.id}</span>
                      <span
                        className={`ml-auto shrink-0 border px-1 py-px uppercase tracking-wider ${
                          live
                            ? "border-ok/30 text-ok"
                            : agent.available
                              ? "border-line text-text-mid"
                              : "border-danger/30 text-danger"
                        }`}
                      >
                        {live ? "canlı" : agent.available ? "hazır" : "yok"}
                      </span>
                      <button
                        type="button"
                        disabled={!connected || !agent.available}
                        onClick={() => {
                          if (live) focusSession(live.id);
                          else openTerminal(agent.id, agent.display_name, selectedDept || undefined);
                        }}
                        className="flex shrink-0 items-center gap-1 border border-line px-1.5 py-0.5 uppercase tracking-wider text-text-mid transition-colors hover:border-line-strong hover:text-accent disabled:cursor-not-allowed disabled:border-line/60 disabled:text-text-lo/60 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/50"
                      >
                        <SquareTerminal size={8} aria-hidden />
                        {live ? "odak" : "aç"}
                      </button>
                    </div>
                    {!agent.available && agent.install_hint && (
                      <p className="mt-1 border border-danger/20 bg-danger/[0.04] px-1.5 py-1 font-mono text-[8px] leading-relaxed text-danger/90">
                        {agent.install_hint}
                      </p>
                    )}
                  </div>
                );
              })}
              {agents.length === 0 && (
                <p className="px-2 py-3 font-mono text-[9px] text-text-lo">
                  CLI envanteri yok — bridge bağlantısını denetle.
                </p>
              )}
            </div>
          </Card>

          {/* "Ne diyor" moved here when the AgentSpace middle column became the
              team-lead panel. Same real last-line-per-agent view, full height
              on the Team screen. */}
          <div className="flex h-[360px] flex-col">
            <TeamVoices />
          </div>

          <Card title="Takım akışı" sub="gerçek olaylar">
            <div className="space-y-1 px-2 py-1.5 font-mono text-[8px] leading-relaxed text-text-lo">
              <p className="flex items-start gap-1.5">
                <Cpu size={8} className="mt-0.5 shrink-0 text-accent/70" aria-hidden />
                Departman rolleri görev hedefi ve worktree kapsamı sağlar; ayrı bir süreç
                başlatmaz.
              </p>
              <p className="flex items-start gap-1.5">
                <SquareTerminal size={8} className="mt-0.5 shrink-0 text-accent/70" aria-hidden />
                Her CLI için tek canlı PTY tutulur. Aynı ajanı yeniden açmak yeni süreç
                oluşturmaz; mevcut oturuma odaklanır.
              </p>
              <p className="flex items-start gap-1.5">
                <X size={8} className="mt-0.5 shrink-0 text-danger/70" aria-hidden />
                bridge v2&apos;de sohbet, dosya tarayıcı, bellek düzenleme veya beceri editörü
                endpoint&apos;i yok; bu ekranlar sahte içerikle doldurulmaz.
              </p>
            </div>
          </Card>
        </div>
      </div>
    </ViewShell>
  );
}
