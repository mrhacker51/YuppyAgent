"use client";

import { ArrowUpRight, Command, TriangleAlert } from "lucide-react";
import { useHudStore } from "@/lib/store";
import { agentShortName } from "@/lib/agents";
import { dispatchCommandTarget } from "./views/shared";

/**
 * Global status + launcher strip. It intentionally holds NO text input:
 * commands are typed into the lead Claude terminal in AgentSpace, and this
 * bar only reads real backend state and jumps there. Command text is
 * never queued locally; the bridge owns the queue.
 */
export default function CommandBar() {
  const status = useHudStore((s) => s.status);
  const agents = useHudStore((s) => s.agents);
  const departments = useHudStore((s) => s.departments);
  const selectedDept = useHudStore((s) => s.selectedDept);
  const tasks = useHudStore((s) => s.tasks);
  const sessions = useHudStore((s) => s.sessions);
  const engineInfo = useHudStore((s) => s.engineInfo);

  const missing = agents.filter((a) => !a.available);
  const dept = departments.find((d) => d.id === selectedDept);
  const deptDisabled = dept ? !dept.enabled : false;
  const connected = status === "connected";
  const gitWorkspace = engineInfo === null || Boolean(engineInfo.git_branch);

  let running = 0;
  let queued = 0;
  for (const t of Object.values(tasks)) {
    if (t.state === "running") running += 1;
    else if (t.state === "queued" || t.state === "awaiting_approval") queued += 1;
  }

  return (
    <section className="shrink-0 border-t border-line bg-bg-1" aria-label="Durum ve hızlı erişim">
      <div className="flex h-9 items-center gap-2 overflow-x-auto px-2 font-mono text-[9px] uppercase tracking-[0.12em] text-text-lo [scrollbar-width:none]">
        <button
          type="button"
          onClick={() => dispatchCommandTarget(undefined, undefined)}
          title="Ana komut penceresine git — lead Claude'a yaz, ekibe o dağıtır"
          className="flex h-6 w-[112px] shrink-0 items-center justify-center gap-1 rounded-[6px] border border-accent/45 bg-accent/15 font-mono text-[9px] font-semibold uppercase tracking-[0.12em] text-accent-hi transition-colors hover:border-accent hover:bg-accent/25 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/60"
        >
          <Command size={10} aria-hidden />
          <span className="whitespace-nowrap">lead</span>
          <ArrowUpRight size={9} aria-hidden />
        </button>

        <span className="hidden shrink-0 items-center gap-1 normal-case tracking-normal text-text-lo/80 sm:flex">
          ⌘K lead terminali
        </span>
        {!gitWorkspace && (
          <span className="hidden shrink-0 items-center gap-1 normal-case tracking-normal text-warn lg:flex">
            git yok — görevler paylaşılan alanda çalışır
          </span>
        )}

        <span className="ml-auto flex shrink-0 items-center gap-2">
          <span className="hidden sm:inline">
            <span className="text-text-mid">{sessions.length}</span> koltuk
          </span>
          <span className="hidden text-line sm:inline">·</span>
          <span>
            <span className="text-ok">{running}</span> çalışan
          </span>
          <span className="text-line">·</span>
          <span>
            <span className={queued > 0 ? "text-warn" : "text-text-lo"}>{queued}</span> kuyruk
          </span>
          <span className="flex h-6 items-center gap-1 rounded-[6px] border border-line px-1.5">
            <span className={`size-1.5 rounded-full ${connected ? "bg-ok" : "bg-danger"}`} />
            {connected ? "canlı" : "offline"}
          </span>
        </span>
      </div>

      {missing.length > 0 && (
        <p className="flex items-center gap-1.5 border-t border-danger/20 bg-danger/[0.05] px-2 py-1 font-mono text-[9px] text-danger">
          <TriangleAlert size={9} aria-hidden />
          {missing.map((a) => agentShortName(a.id)).join(" + ")} PATH&apos;te bulunamadı — CLI&apos;yi
          kur; prompt onun koltuğuna/görevine gidemez.
        </p>
      )}
      {deptDisabled && (
        <p className="flex items-center gap-1.5 border-t border-warn/20 bg-warn/[0.05] px-2 py-1 font-mono text-[9px] text-warn">
          <TriangleAlert size={9} aria-hidden />
          {dept?.name} kapalı — backend bu takıma görev kabul etmez. Başka bir takım seç.
        </p>
      )}

    </section>
  );
}
