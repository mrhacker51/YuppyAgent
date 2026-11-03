"use client";

import { useMemo, useState } from "react";
import { MessagesSquare, Radio } from "lucide-react";
import { Tabs, TabsList, TabsTrigger } from "fancy-ui-react";
import { useHudStore } from "@/lib/store";
import { agentShortName } from "@/lib/agents";
import CharacterThumb from "./pixel/CharacterThumb";
import { spriteBaseFor, useCharacters } from "@/lib/characters";
import { bodiesForSeats } from "@/lib/officeScene";
import { planSeats, type SeatAgent, type SeatDepartment } from "@/lib/autoTerminals";
import { classifySpeechLine } from "@/lib/speech";
import DeckPanel, { DeckStat } from "./fancy/Panel";

const KIND_STYLE: Record<string, { label: string; cls: string; title: string }> = {
  team: { label: "ekip", cls: "text-accent", title: "takım otobüsü (yuppy_send / inbox) trafiği" },
  message: { label: "mesaj", cls: "text-ok/80", title: "ajanın kendi yazdığı satır" },
  command: { label: "komut", cls: "text-struct", title: "çalıştırdığı komut / araç çağrısı" },
  output: { label: "çıktı", cls: "text-text-lo", title: "terminal çıktısı" },
};

type VoiceTab = "team" | "lines";

function clock(ts: number): string {
  return ts > 0
    ? new Date(ts).toLocaleTimeString([], {
        hour12: false,
        hour: "2-digit",
        minute: "2-digit",
      })
    : "—";
}

/**
 * "Ne diyor" — the real team bus (`yuppy_send`) first, and the last verbatim
 * line each live PTY printed as the second view. Nothing is generated: an
 * agent with no fresh line says so honestly, and an empty bus says it is
 * empty.
 */
export default function TeamVoices() {
  const speech = useHudStore((s) => s.speech);
  const sessions = useHudStore((s) => s.sessions);
  const agents = useHudStore((s) => s.agents);
  const departments = useHudStore((s) => s.departments);
  const teamMessages = useHudStore((s) => s.teamMessages);
  const focusSession = useHudStore((s) => s.focusSession);
  const { map: looks } = useCharacters();
  const [tab, setTab] = useState<VoiceTab>("team");

  /* The floor assigns one body per seat (round-robin). Resolve the same seat
     here so an agent's avatar never disagrees with the body walking around. */
  const seats = useMemo(
    () => planSeats(departments as SeatDepartment[], agents as SeatAgent[]),
    [departments, agents],
  );
  const bodyBySeat = useMemo(
    () => bodiesForSeats(seats.map((s) => s.seatKey)),
    [seats],
  );
  const rows = useMemo(() => {
    /* Live sessions and seats are paired exactly like the office renderer, so
       the avatar in this panel is the same body standing on the floor. */
    const bodyFor = (agent: string, department?: string): string => {
      const seat = department
        ? seats.find((s) => s.agent === agent && (s.department === department || !s.department))
        : seats.find((s) => s.agent === agent);
      return seat
        ? spriteBaseFor(agent, looks, seat.seatKey, bodyBySeat[seat.seatKey])
        : spriteBaseFor(agent, looks);
    };

    const latest = new Map<string, (typeof speech)[number]>();
    for (const line of speech) latest.set(line.agent, line);
    // One row per live seat; idle executors appear only when they spoke.
    const seen = new Set<string>();
    const out: Array<{
      agent: string;
      label: string;
      line: string | null;
      ts: number;
      live: boolean;
      sessionId?: string;
      /** Body sprite, resolved from the same seat map the office draws. */
      body: string;
    }> = [];
    for (const session of sessions) {
      if (seen.has(session.agent)) continue;
      seen.add(session.agent);
      const sp = latest.get(session.agent);
      out.push({
        agent: session.agent,
        label: session.label || agentShortName(session.agent),
        line: sp?.line ?? null,
        ts: sp?.ts ?? 0,
        live: true,
        sessionId: session.id,
        body: bodyFor(session.agent, session.department),
      });
    }
    for (const agent of agents) {
      if (seen.has(agent.id)) continue;
      const sp = latest.get(agent.id);
      if (!sp) continue;
      seen.add(agent.id);
      out.push({
        agent: agent.id,
        label: agentShortName(agent.id),
        line: sp.line,
        ts: sp.ts,
        live: false,
        body: bodyFor(agent.id),
      });
    }
    return out;
  }, [speech, sessions, agents, seats, bodyBySeat, looks]);

  const messages = useMemo(() => [...teamMessages].reverse(), [teamMessages]);

  return (
    <DeckPanel
      label="Ne diyor"
      icon={<Radio size={10} className="text-accent" aria-hidden />}
      meta={
        <span className="flex items-center gap-2">
          <DeckStat
            label="mesaj"
            value={teamMessages.length}
            tone={teamMessages.length > 0 ? "accent" : "neutral"}
          />
          <DeckStat label="ajan" value={rows.length} />
        </span>
      }
      tone={teamMessages.length > 0 ? "accent" : "neutral"}
      flush
      className="min-h-0 flex-1"
      bodyClassName="min-h-0"
    >
      <Tabs
        value={tab}
        onValueChange={(value) => setTab(value as VoiceTab)}
        variant="underline"
        activation="automatic"
        className="shrink-0 border-b border-line/70 bg-bg-1/30"
      >
        <TabsList className="!h-6 !gap-0 !border-0 !bg-transparent !p-0">
          <TabsTrigger
            value="team"
            className="!h-6 !rounded-none !px-2 font-mono !text-[8px] uppercase tracking-[0.14em]"
          >
            <MessagesSquare size={9} aria-hidden /> ekip
          </TabsTrigger>
          <TabsTrigger
            value="lines"
            className="!h-6 !rounded-none !px-2 font-mono !text-[8px] uppercase tracking-[0.14em]"
          >
            ne yazdı
          </TabsTrigger>
        </TabsList>
      </Tabs>

      <div className="pixel-scroll min-h-0 flex-1 overflow-y-auto">
        {tab === "team" ? (
          messages.length === 0 ? (
            <p className="px-2 py-3 font-mono text-[9px] leading-relaxed text-text-lo">
              henüz takım mesajı yok.
            </p>
          ) : (
            <ul className="divide-y divide-line/40">
              {messages.map((m) => (
                <li key={m.id} className="px-2 py-1">
                  <div className="flex items-baseline gap-1 font-mono text-[8px]">
                    <span className="shrink-0 tabular-nums text-text-lo/70">{clock(m.ts)}</span>
                    <span className="min-w-0 truncate text-text-hi">{m.sender}</span>
                    <span className="shrink-0 text-text-lo">→</span>
                    <span className="shrink-0 text-accent">
                      {m.recipient === "*" ? "herkes" : m.recipient}
                    </span>
                    <span
                      className="ml-auto shrink-0 text-[7px] uppercase tracking-wider text-text-lo/50"
                      title={m.batch}
                    >
                      #{m.busId}
                    </span>
                  </div>
                  <p className="mt-0.5 whitespace-pre-wrap break-words font-mono text-[9px] leading-[1.45] text-text-mid">
                    {m.body}
                  </p>
                </li>
              ))}
            </ul>
          )
        ) : rows.length === 0 ? (
          <p className="p-2 font-mono text-[9px] leading-relaxed text-text-lo">
            Canlı koltuk yok — bir koltuk açınca ajanların son satırı burada görünür.
          </p>
        ) : (
          <ul className="divide-y divide-line/40">
            {rows.map((r, i) => (
              <li
                key={r.agent}
                onClick={() => r.sessionId && focusSession(r.sessionId)}
                className={`px-2 py-1 ${r.sessionId ? "cursor-pointer hover:bg-bg-2/60" : ""}`}
              >
                <div className="flex items-center gap-1">
                  <span className="font-mono text-[7px] tabular-nums text-text-lo">C{i + 1}</span>
                  <CharacterThumb sprite={r.body} size={16} />
                  <span className="min-w-0 flex-1 truncate font-mono text-[10px] leading-none text-text-hi">
                    {r.label.replace(/ · .*$/, "")}
                  </span>
                  <span
                    className={`shrink-0 font-mono text-[7px] uppercase tracking-wider ${
                      r.live ? "text-ok" : "text-text-lo"
                    }`}
                  >
                    {r.live ? "canlı" : "kapalı"} {clock(r.ts)}
                  </span>
                </div>
                {r.line ? (
                  <p className="mt-0.5 flex gap-1">
                    <span
                      className={`shrink-0 pt-px font-mono text-[6.5px] uppercase tracking-wider ${KIND_STYLE[classifySpeechLine(r.line).kind].cls}`}
                      title={KIND_STYLE[classifySpeechLine(r.line).kind].title}
                    >
                      {KIND_STYLE[classifySpeechLine(r.line).kind].label}
                    </span>
                    <span className="line-clamp-3 min-w-0 break-words font-mono text-[8px] leading-[1.45] text-text-mid">
                      {r.line}
                    </span>
                  </p>
                ) : (
                  <p className="mt-0.5 font-mono text-[8px] italic text-text-lo/60">
                    henüz çıktı yok
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </DeckPanel>
  );
}
