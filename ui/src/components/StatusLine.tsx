"use client";

import { useHudStore } from "@/lib/store";
import { moduleLabel, type ModuleId } from "@/lib/modules";
import { DeckStat } from "./fancy/Panel";
import NumberTicker from "./fancy/NumberTicker";
import StatusMorph from "./fancy/StatusMorph";

const STATUS_LABEL: Record<string, string> = {
  disconnected: "köprü yok",
  connecting: "bağlanıyor",
  authenticating: "kimlik",
  connected: "bağlı",
  auth_failed: "kimlik hatası",
  protocol_mismatch: "protokol uyumsuz",
};

function Sep() {
  return <span className="mx-2 h-2.5 w-px shrink-0 bg-line" aria-hidden />;
}

/**
 * One-line 24px glass rail. Read left → right: bridge connection, workspace,
 * executors, live/queued load, then the module that owns the deck. The rail is
 * deliberately still — no entrance, hover or layout animation — so the moving
 * parts of the console are the only things that draw the eye.
 */
export default function StatusLine({ activeModule }: { activeModule: ModuleId }) {
  const status = useHudStore((s) => s.status);
  const engine = useHudStore((s) => s.engineInfo);
  const agents = useHudStore((s) => s.agents);
  const tasks = useHudStore((s) => s.tasks);

  let running = 0;
  let queued = 0;
  for (const t of Object.values(tasks)) {
    if (t.state === "running") running += 1;
    else if (t.state === "queued" || t.state === "awaiting_approval") queued += 1;
  }
  const available = agents.filter((a) => a.available).length;
  const connected = status === "connected";
  const connectionState = connected
    ? "success"
    : status === "connecting" || status === "authenticating"
      ? "loading"
      : status === "disconnected"
        ? "idle"
        : "error";
  const workspace = engine?.workspace.split("/").filter(Boolean).pop() ?? "—";
  const branch = engine?.git_branch ?? null;

  return (
    <footer
      className="deck-rail flex h-6 shrink-0 items-center overflow-hidden border-t border-line bg-bg-1/80 px-2.5 font-mono text-[8px] uppercase tracking-[0.13em] text-text-lo backdrop-blur-[2px]"
      aria-label="Sistem durumu"
    >
      <span className="flex shrink-0 items-center gap-1.5">
        <StatusMorph state={connectionState} size={10} />
        <span className={connected ? "text-ok" : "text-text-mid"}>
          {STATUS_LABEL[status] ?? status}
        </span>
      </span>

      <Sep />
      <span className="hidden min-w-0 sm:block" title={engine?.workspace}>
        <DeckStat
          label="ws"
          value={
            <span className="inline-block max-w-[170px] truncate align-bottom normal-case tracking-normal">
              {workspace}
              {branch ? <span className="text-accent/75"> · {branch}</span> : null}
            </span>
          }
        />
      </span>

      <Sep />
      <DeckStat
        label="exec"
        value={<span className="tabular-nums">{available}/{agents.length}</span>}
      />

      <Sep />
      <span className="flex shrink-0 items-center gap-3">
        <DeckStat
          label="canlı"
          tone="accent"
          value={<NumberTicker value={running} duration={0} />}
        />
        <DeckStat
          label="sırada"
          tone={queued > 0 ? "warn" : "neutral"}
          value={<NumberTicker value={queued} duration={0} />}
        />
      </span>

      <span className="ml-auto flex shrink-0 items-center gap-1.5 pl-2">
        <span className="hidden font-mono text-[8px] uppercase tracking-[0.14em] text-text-lo/70 md:inline">
          modül
        </span>
        <span className="rounded-[3px] border border-line bg-bg-2/60 px-1.5 py-px font-mono text-[8px] uppercase tracking-[0.12em] text-accent/90">
          {moduleLabel(activeModule)}
        </span>
      </span>
    </footer>
  );
}
