"use client";

import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, Cpu, UserRound } from "lucide-react";
import { useHudStore } from "@/lib/store";
import { agentShortName } from "@/lib/agents";
import { MODELS, modelCtx, modelLabel, useAgentModels } from "@/lib/agentModels";
import { CHARACTERS, characterFor, useCharacters } from "@/lib/characters";
import CharacterThumb from "./pixel/CharacterThumb";

/**
 * Control strip for the autonomous system: which executor runs, on which
 * model, and what its character looks like.
 *
 * Everything shown here is real:
 *  - executor availability comes from the bridge inventory;
 *  - the model list is the gateway catalog;
 *  - a model choice is written into the next `task_submit` (TaskSpecDto.model),
 *    which is why the note says a *running* seat keeps its current model.
 * Character choice is presentation-only and persists locally.
 */
export default function AgentControls() {
  const agents = useHudStore((s) => s.agents);
  const engine = useHudStore((s) => s.engineInfo);
  const departments = useHudStore((s) => s.departments);
  const [open, setOpen] = useState<"model" | "look" | null>(null);
  const { map: models, setModel } = useAgentModels();
  const { map: looks, assign } = useCharacters();
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(null);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const available = agents.filter((a) => a.available);
  if (available.length === 0) return null;

  /** Role default for an executor, as configured by the team. */
  const roleModel = (agentId: string) =>
    departments.flatMap((d) => d.roles ?? []).find((r) => r.cli === agentId)?.model ?? null;

  return (
    <div ref={rootRef} className="flex shrink-0 items-center gap-1 border-l border-line px-1.5">
      <span className="mr-0.5 hidden items-center gap-1 font-mono text-[8.5px] uppercase tracking-[0.12em] text-text-lo 2xl:flex">
        <Cpu size={9} aria-hidden />
        {engine?.provider ?? "provider"}
      </span>

      {available.map((agent) => {
        const chosen = models[agent.id] ?? null;
        // Effective model: operator override → team role → the model the
        // gateway actually reports. Never blank, so the chip always answers
        // "what will this agent run on".
        const active = modelForDisplay(chosen, roleModel(agent.id), engine?.model) ?? GATEWAY_DEFAULT;
        const look = characterFor(agent.id, looks);
        return (
          <span
            key={agent.id}
            className="flex items-center gap-1 rounded-sm border border-line bg-bg-2/60 py-0.5 pl-0.5 pr-1"
          >
            <button
              type="button"
              onClick={() => setOpen(open === "look" ? null : "look")}
              title={`${agentShortName(agent.id)} karakteri: ${look.name} — değiştir`}
              aria-label={`${agentShortName(agent.id)} karakterini değiştir`}
              className="grid size-5 place-items-center overflow-hidden rounded-sm transition-opacity hover:opacity-80 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/60"
            >
              <CharacterThumb sprite={look.sprite} size={18} />
            </button>
            <button
              type="button"
              onClick={() => setOpen(open === "model" ? null : "model")}
              title={`${agentShortName(agent.id)} · model: ${modelLabel(chosen)} (yeni görevler için)`}
              className="flex items-center gap-1 font-mono text-[9px] text-text-mid transition-colors hover:text-text-hi focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/60"
            >
              <span className="hidden lg:inline">{shortModel(active)}</span>
              <ChevronDown size={8} className="text-text-lo" aria-hidden />
            </button>
          </span>
        );
      })}

      {open === "model" && (
        <div className="absolute right-2 top-[38px] z-50 w-[286px] overflow-hidden rounded-md border border-line-mid bg-bg-1 shadow-2xl">
          <div className="flex items-center gap-1.5 border-b border-line px-2 py-1.5">
            <Cpu size={10} className="text-accent" aria-hidden />
            <span className="text-[10px] font-semibold text-text-hi">Model</span>
            <span className="ml-auto font-mono text-[9px] text-text-lo">
              yeni görevler · çalışan koltuk modelini korur
            </span>
          </div>
          {available.map((agent) => (
            <div key={agent.id} className="border-b border-line/60 px-2 py-1.5 last:border-b-0">
              <div className="mb-1 flex items-center gap-1.5">
                <CharacterThumb sprite={characterFor(agent.id, looks).sprite} size={13} />
                <span className="text-[10px] font-medium text-text-mid">
                  {agentShortName(agent.id)}
                </span>
                <span className="ml-auto font-mono text-[8.5px] text-text-lo">
                  şu an: {shortModel(modelForDisplay(models[agent.id] ?? null, roleModel(agent.id), engine?.model))}
                </span>
              </div>
              <div className="grid gap-0.5">
                {MODELS.map((m) => {
                  const selected = models[agent.id] === m.id;
                  return (
                    <button
                      key={m.id}
                      type="button"
                      onClick={() => setModel(agent.id, m.id)}
                      className={`flex items-center gap-1.5 rounded-sm px-1.5 py-1 text-left transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/60 ${
                        selected ? "bg-accent/10 text-accent" : "text-text-mid hover:bg-bg-2"
                      }`}
                    >
                      <span className="font-mono text-[9.5px]">{m.label}</span>
                      <span className="ml-auto font-mono text-[8px] text-text-lo">
                        {(m.ctx / 1000).toFixed(0)}K
                      </span>
                      {selected && <Check size={9} aria-hidden />}
                    </button>
                  );
                })}
                <button
                  type="button"
                  onClick={() => setModel(agent.id, null)}
                  className="mt-0.5 flex items-center gap-1.5 rounded-sm px-1.5 py-1 text-left font-mono text-[9px] text-text-lo transition-colors hover:bg-bg-2 hover:text-text-mid"
                >
                  <UserRound size={9} aria-hidden />
                  takım varsayılanına dön
                  {models[agent.id] === undefined && <Check size={9} className="ml-auto" aria-hidden />}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {open === "look" && (
        <div className="absolute right-2 top-[38px] z-50 w-[318px] overflow-hidden rounded-md border border-line-mid bg-bg-1 shadow-2xl">
          <div className="flex items-center gap-1.5 border-b border-line px-2 py-1.5">
            <UserRound size={10} className="text-accent" aria-hidden />
            <span className="text-[10px] font-semibold text-text-hi">Karakter</span>
            <span className="ml-auto font-mono text-[9px] text-text-lo">ofiste görünen kişi</span>
          </div>
          {available.map((agent) => (
            <div key={agent.id} className="border-b border-line/60 px-2 py-1.5 last:border-b-0">
              <div className="mb-1 flex items-center gap-1.5">
                <CharacterThumb sprite={characterFor(agent.id, looks).sprite} size={16} />
                <span className="text-[10px] font-medium text-text-mid">
                  {agentShortName(agent.id)}
                </span>
              </div>
              <div className="grid grid-cols-6 gap-1">
                {CHARACTERS.map((c) => {
                  const selected = characterFor(agent.id, looks).id === c.id;
                  return (
                    <button
                      key={c.id}
                      type="button"
                      onClick={() => assign(agent.id, c.id)}
                      title={c.name}
                      aria-label={`${agentShortName(agent.id)} → ${c.name}`}
                      aria-pressed={selected}
                      className={`grid place-items-center rounded-sm border p-0.5 transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/60 ${
                        selected
                          ? "border-accent/60 bg-accent/10"
                          : "border-transparent hover:border-line-mid hover:bg-bg-2"
                      }`}
                    >
                      <CharacterThumb sprite={c.sprite} size={22} />
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** The model both CLIs are configured with (settings.json / config.toml).
 * Used as the display fallback when the bridge reports no engine model. */
const GATEWAY_DEFAULT = "deepseek-v4.1-flash";

/** What the seat is actually running now, for the compact label. */
function modelForDisplay(
  override: string | null,
  role: string | null,
  engineModel?: string,
): string | null {
  if (override) return override;
  if (role) return role;
  // The bridge sends an EMPTY string when the CLI owns its own model choice —
  // `??` would keep that empty value, so trim and fall through instead.
  const reported = (engineModel ?? "").trim();
  if (reported) {
    const hit = MODELS.find(
      (m) => m.id === reported || reported.includes(m.id) || m.id.includes(reported),
    );
    return hit ? hit.id : reported;
  }
  return null;
}

function shortModel(id: string | null): string {
  if (!id || !id.trim()) return "varsayılan";
  const m = MODELS.find((x) => x.id === id);
  if (!m) {
    const ctx = modelCtx(id);
    return ctx ? `${id.split("-")[0]} ${(ctx / 1000).toFixed(0)}K` : id.split("-")[0];
  }
  // "DeepSeek V4.1 Flash" -> "DeepSeek 4.1", "Gemma 4 31B" -> "Gemma"
  const brand = m.label.split(/\s+/)[0];
  const ver = m.label.match(/V?(\d+(?:\.\d+)?)/)?.[1];
  return ver ? `${brand} ${ver}` : brand;
}
