"use client";

import { useMemo } from "react";
import { OctagonX, Users } from "lucide-react";
import { useHudStore } from "@/lib/store";
import { agentShortName } from "@/lib/agents";
import PixelAvatar from "./pixel/PixelAvatar";
import DeckPanel, { DeckStat } from "./fancy/Panel";

const LIVE = new Set(["queued", "running", "awaiting_approval"]);

const STATE_STYLE: Record<string, { label: string; cls: string }> = {
  queued: { label: "sırada", cls: "text-text-lo" },
  running: { label: "çalışıyor", cls: "text-ok" },
  awaiting_approval: { label: "onay", cls: "text-warn" },
  completed: { label: "bitti", cls: "text-accent" },
  failed: { label: "hata", cls: "text-danger" },
  cancelled: { label: "iptal", cls: "text-text-lo" },
};

/**
 * Siparişler — the team's work orders, exactly as the bridge reports them.
 * One row per real task: who is on it, which team, how long, and a real
 * `task_cancel` stop. Nothing here is a local to-do list: a row exists only
 * because a bridge task exists.
 */
export default function TeamOrders() {
  const tasks = useHudStore((s) => s.tasks);
  const departments = useHudStore((s) => s.departments);
  const send = useHudStore((s) => s.send);
  const status = useHudStore((s) => s.status);

  const deptNames = useMemo(
    () => Object.fromEntries(departments.map((d) => [d.id, d.name])),
    [departments],
  );

  const rows = useMemo(() => {
    const all = Object.values(tasks);
    const live = all.filter((t) => LIVE.has(t.state));
    const done = all.filter((t) => !LIVE.has(t.state));

    return [...live, ...done].slice(0, 6);
  }, [tasks]);

  const liveCount = Object.values(tasks).filter((t) => LIVE.has(t.state)).length;

  return (
    <DeckPanel
      label="Siparişler"
      icon={<Users size={10} className="text-accent" aria-hidden />}
      meta={
        <span className="flex items-center gap-2">
          <DeckStat label="canlı" value={liveCount} tone={liveCount > 0 ? "accent" : "neutral"} />
          <DeckStat label="toplam" value={Object.keys(tasks).length} />
        </span>
      }
      tone={liveCount > 0 ? "accent" : "neutral"}
      flush
      className="min-h-0 flex-1"
      bodyClassName="min-h-0"
    >
      <div className="pixel-scroll min-h-0 flex-1 overflow-y-auto">
        {rows.length === 0 ? (
          <p className="pixel-body px-2 py-1.5 text-[12px] leading-tight text-text-lo">
            Henüz sipariş yok — lead Claude&apos;a bir iş ver.
          </p>
        ) : (
          <ul className="divide-y divide-line/50">
            {rows.map((t) => {
              const st = STATE_STYLE[t.state] ?? STATE_STYLE.queued;
              const live = LIVE.has(t.state);
              const team = t.department ? deptNames[t.department] ?? t.department : "—";
              return (
                <li key={t.id} className="flex items-center gap-1.5 px-1.5 py-1">
                  <PixelAvatar seed={`${t.cli ?? "cli"}:${t.id}`} size={18} />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-baseline gap-1">
                      <span className="pixel-body truncate text-[13px] leading-none text-text-hi">
                        {agentShortName(t.cli ?? "")}
                      </span>
                      <span className="shrink-0 font-mono text-[7px] uppercase tracking-wider text-text-lo">
                        {team !== "—" ? team.slice(0, 10) : ""}
                      </span>
                    </span>
                    <span className="mt-0.5 flex items-baseline gap-1">
                      <span className={`shrink-0 font-mono text-[7.5px] uppercase tracking-wider ${st.cls}`}>
                        {st.label}
                      </span>
                      <span className="min-w-0 truncate font-mono text-[8px] text-text-lo">
                        {t.title ?? t.id}
                      </span>
                    </span>
                  </span>
                  <button
                    type="button"
                    onClick={() => send({ type: "task_cancel", task_id: t.id })}
                    disabled={!live || status !== "connected"}
                    title={
                      live
                        ? "Bu görevi durdur — köprüye gerçek task_cancel gider"
                        : "Görev zaten bitmiş"
                    }
                    aria-label={`${t.title ?? t.id} görevini durdur`}
                    className="grid size-5 shrink-0 place-items-center border border-line text-text-lo transition-colors hover:border-danger/50 hover:text-danger focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-danger/50 disabled:cursor-not-allowed disabled:opacity-30"
                  >
                    <OctagonX size={10} aria-hidden />
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </DeckPanel>
  );
}
