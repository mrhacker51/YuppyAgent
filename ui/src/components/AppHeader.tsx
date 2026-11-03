"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Bell,
  ChevronDown,
  HelpCircle,
  Power,
  Search,
  Settings2,
  Users,
} from "lucide-react";
import { CommandMenu, Tooltip, type CommandItem } from "fancy-ui-react";
import { useHudStore } from "@/lib/store";
import { squadList } from "@/lib/teamIdentity";
import { MODULES, type ModuleId } from "@/lib/modules";
import { useMounted } from "@/lib/useMounted";
import AgentControls from "./AgentControls";
import SquadGlyph from "./SquadGlyph";
import NumberTicker from "./fancy/NumberTicker";
import StatusMorph from "./fancy/StatusMorph";
import { dispatchCommandTarget } from "./views/shared";

const STATUS_LABEL: Record<string, string> = {
  disconnected: "köprü yok",
  connecting: "bağlanıyor",
  authenticating: "kimlik",
  connected: "bağlı",
  auth_failed: "kimlik hatası",
  protocol_mismatch: "protokol uyumsuz",
};

function connectionState(status: string, connected: boolean) {
  if (connected) return "success" as const;
  if (status === "connecting" || status === "authenticating") return "loading" as const;
  if (status === "disconnected") return "idle" as const;
  return "error" as const;
}

/**
 * Application chrome, two rows: a 44px command bar and a 34px module dock.
 *
 * Row 1 is identity plus the operator's right-hand cluster (connection,
 * pending decisions, palette, team selector, settings). Row 2 is the module
 * dock: icon + label, one lit edge and one accent wash on the active module.
 * Every count still comes from the bridge; nothing here is synthesised.
 */
export default function AppHeader({
  active,
  onSelect,
}: {
  active: ModuleId;
  onSelect: (id: ModuleId) => void;
}) {
  const status = useHudStore((s) => s.status);
  const url = useHudStore((s) => s.bridgeUrl);
  const departments = useHudStore((s) => s.departments);
  const selectedDept = useHudStore((s) => s.selectedDept);
  const setSelectedDept = useHudStore((s) => s.setSelectedDept);
  const connect = useHudStore((s) => s.connect);
  const disconnect = useHudStore((s) => s.disconnect);
  const engine = useHudStore((s) => s.engineInfo);
  const tasks = useHudStore((s) => s.tasks);
  const sessions = useHudStore((s) => s.sessions);
  const pending = Object.values(tasks).filter((t) => t.state === "awaiting_approval").length;
  const mounted = useMounted();
  const desktopShell = mounted && typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
  const connected = status === "connected";
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [teamOpen, setTeamOpen] = useState(false);
  const teamRef = useRef<HTMLDivElement>(null);

  /**
   * Team tabs are real departments wearing a callsign. `squadList` adds the
   * whole-deck row and keeps the mapping stable; role and live counts come
   * straight from the bridge, so a tab never claims work that is not there.
   */
  const teams = useMemo(() => {
    const totalRoles = departments.reduce((n, d) => n + (d.roles?.length ?? 0), 0);
    const liveByDept = new Map<string, number>();
    for (const session of sessions) {
      if (!session.department) continue;
      liveByDept.set(session.department, (liveByDept.get(session.department) ?? 0) + 1);
    }
    return squadList(departments).map((squad) => {
      if (!squad.id) {
        return { ...squad, roles: totalRoles, live: sessions.length, members: [] as string[] };
      }
      const dept = departments.find((d) => d.id === squad.id);
      const roles = dept?.roles ?? [];
      return {
        ...squad,
        roles: roles.length,
        live: liveByDept.get(squad.id) ?? 0,
        members: [...new Set(roles.map((r) => r.cli))],
      };
    });
  }, [departments, sessions]);

  const selectedSquad = teams.find((t) => t.id === selectedDept) ?? teams[0];
  const state = connectionState(status, connected);

  /** Close the team disclosure on an outside click or Escape. */
  useEffect(() => {
    if (!teamOpen) return;
    const onDown = (e: MouseEvent) => {
      if (!teamRef.current?.contains(e.target as Node)) setTeamOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setTeamOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [teamOpen]);

  /**
   * ⌘⇧K / Ctrl+Shift+K opens the palette. Plain ⌘K belongs to the shell: it
   * focuses the lead Claude terminal (the main command window).
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || !e.shiftKey) return;
      if (e.key.toLowerCase() !== "k") return;
      e.preventDefault();
      e.stopImmediatePropagation();
      setPaletteOpen((open) => !open);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  const closePalette = () => setPaletteOpen(false);

  // A real "toggle help" without a second source of truth: AppShell already
  // owns the help state and listens for "?", so replay the real shortcut.
  const toggleHelp = () => {
    requestAnimationFrame(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "?", bubbles: true }));
    });
  };

  /** Roving focus for the module dock / ⌘1…⌘9 order. */
  const moveModule = (dir: 1 | -1 | "home" | "end") => {
    const current = Math.max(
      0,
      MODULES.findIndex((m) => m.id === active),
    );
    const nextIndex =
      dir === "home"
        ? 0
        : dir === "end"
          ? MODULES.length - 1
          : (current + dir + MODULES.length) % MODULES.length;
    const next = MODULES[nextIndex];
    onSelect(next.id);
    requestAnimationFrame(() => {
      document
        .querySelector<HTMLElement>(`[data-module="${next.id}"]`)
        ?.focus();
    });
  };

  /**
   * Palette vocabulary: every module plus the actions the header already
   * exposes. Items only call handlers that exist on this screen; department
   * rows come from the live registry, never a hard-coded team list.
   */
  const commands: CommandItem[] = useMemo(() => {
    const items: CommandItem[] = MODULES.map((m) => ({
      id: `module:${m.id}`,
      label: m.label,
      group: "Modüller",
      meta: "git",
      keywords: [m.id, "modül", "module"],
      onSelect: () => onSelect(m.id),
    }));

    items.push(
      {
        id: "action:connect",
        label: connected ? "Bağlantıyı kes" : "Bridge'e bağlan",
        group: "Eylemler",
        meta: connected ? "disconnect" : "connect",
        keywords: ["bağlan", "kes", "ws", "bridge", "köprü"],
        onSelect: () => (connected ? disconnect() : connect(url)),
      },
      {
        id: "action:teams",
        label: "Takım seçiciyi aç",
        group: "Eylemler",
        meta: "takım",
        keywords: ["takım", "team", "seç", "departman"],
        onSelect: () => setTeamOpen(true),
      },
      {
        id: "action:settings",
        label: "Ayarları aç",
        group: "Eylemler",
        meta: "settings",
        keywords: ["ayar", "token", "bridge"],
        onSelect: () => onSelect("settings"),
      },
      {
        id: "action:lead",
        label: "Ana komut penceresine git (lead Claude)",
        group: "Eylemler",
        meta: "⌘K",
        keywords: ["lead", "claude", "komut", "prompt", "terminal", "ana"],
        onSelect: () => {
          onSelect("agentspace");
          dispatchCommandTarget(undefined, undefined);
        },
      },
      {
        id: "action:help",
        label: "Klavye kısayollarını aç / kapat",
        group: "Eylemler",
        meta: "?",
        keywords: ["yardım", "help", "kısayol", "shortcut"],
        onSelect: toggleHelp,
      },
    );

    if (pending > 0) {
      items.push({
        id: "action:pending",
        label: `${pending} karar bekliyor — Görevler`,
        group: "Eylemler",
        meta: "onay",
        keywords: ["karar", "onay", "bekliyor", "tasks"],
        onSelect: () => onSelect("tasks"),
      });
    }

    for (const team of teams) {
      if (!team.id) continue;
      items.push({
        id: `team:${team.id}`,
        label: `${team.callsign} — ${team.name}`,
        group: "Takımlar",
        meta: `${team.roles} rol`,
        keywords: [team.name, team.role, team.callsign, team.id],
        onSelect: () => {
          setSelectedDept(team.id);
          window.dispatchEvent(new CustomEvent("yuppy:focus-team", { detail: team.id }));
        },
      });
    }
    return items;
    // `toggleHelp` only replays the existing shortcut and closes over no
    // changing state, so it does not need to invalidate the vocabulary.
  }, [connected, connect, disconnect, url, onSelect, setSelectedDept, teams, pending]);

  const contextChips = [
    { label: "ws", value: engine?.workspace?.split("/").filter(Boolean).pop() ?? "—" },
    { label: "dal", value: engine?.git_branch ?? "—" },
    { label: "model", value: engine?.model || "varsayılan" },
  ];

  return (
    <header className="relative z-40 flex shrink-0 flex-col border-b border-line bg-bg-1/95 backdrop-blur-[2px]">
      {/* ── row 1 · command bar (44px) ───────────────────────────────── */}
      {/* `relative z-30`: the team menu hangs below this row and must paint
          above the module dock, which is a sibling that comes later in the
          DOM and would otherwise cover it. */}
      <div className="relative z-30 flex h-11 items-stretch">
        {/* brand lockup: wordmark + live bridge glyph */}
        <div className="flex w-[188px] shrink-0 items-center gap-2.5 border-r border-line bg-bg-0 px-3">
          <svg
            viewBox="0 0 16 16"
            width="20"
            height="20"
            shapeRendering="crispEdges"
            aria-hidden
            className="shrink-0 text-accent"
          >
            <rect x="2" y="12" width="12" height="2" fill="currentColor" />
            <rect x="3" y="9" width="10" height="2" fill="currentColor" opacity="0.85" />
            <rect x="5" y="6" width="6" height="2" fill="currentColor" opacity="0.7" />
            <rect x="6" y="3" width="4" height="2" fill="currentColor" opacity="0.55" />
            <rect x="7" y="0" width="2" height="2" fill="currentColor" opacity="0.95" />
          </svg>
          <span className="flex min-w-0 flex-col leading-none">
            <span className="flex items-center gap-1.5">
              <span className="truncate text-[12.5px] font-semibold tracking-[-0.01em] text-text-hi">
                YuppyCode
              </span>
              <StatusMorph state={state} size={9} title={`Köprü: ${STATUS_LABEL[status] ?? status}`} />
            </span>
            <span className="mt-1 font-mono text-[7px] uppercase tracking-[0.18em] text-text-lo">
              AgentSpace v1
            </span>
          </span>
        </div>

        {/* executor strip — real inventory only, quiet when absent */}
        <div className="hidden min-w-0 flex-1 items-center overflow-hidden pl-2 lg:flex">
          <AgentControls />
        </div>

        {/* right cluster: context, connection, decisions, palette, team, settings */}
        <div className="ml-auto flex shrink-0 items-center gap-1.5 px-2">
          <div className="hidden min-w-0 items-center gap-2.5 pr-1 xl:flex">
            {contextChips.map((c) => (
              <span
                key={c.label}
                className="flex min-w-0 max-w-[118px] items-baseline gap-1 font-mono text-[8px] uppercase tracking-[0.12em]"
                title={`${c.label}: ${c.value}`}
              >
                <span className="shrink-0 text-text-lo/80">{c.label}</span>
                <span className="truncate text-[8px] normal-case tracking-normal text-text-lo">
                  {c.value}
                </span>
              </span>
            ))}
          </div>

          <span
            className="hidden items-center gap-1.5 rounded-[4px] border border-line px-2 py-1 font-mono text-[8px] uppercase tracking-[0.12em] text-text-mid sm:flex"
            title={url}
            aria-label={`Köprü ${STATUS_LABEL[status] ?? status}`}
          >
            <StatusMorph state={state} size={10} />
            <span>{STATUS_LABEL[status] ?? status}</span>
          </span>

          <Tooltip content={connected ? "Bağlantıyı kes" : "Bridge'e bağlan"}>
            <button
              type="button"
              onClick={() => {
                if (connected) {
                  if (desktopShell) disconnect();
                  else onSelect("settings");
                } else if (desktopShell) {
                  connect();
                } else {
                  onSelect("settings");
                }
              }}
              className={`h-6 rounded-[4px] border px-2 font-mono text-[8px] uppercase tracking-[0.1em] transition-colors duration-[120ms] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/50 motion-reduce:transition-none ${
                connected
                  ? "border-line text-text-lo hover:border-danger/40 hover:text-danger"
                  : "border-accent/35 bg-accent/[0.08] text-accent hover:bg-accent/[0.13]"
              }`}
            >
              {connected ? (desktopShell ? "kes" : "bağlantı") : "bağlan"}
            </button>
          </Tooltip>

          <Tooltip content={pending > 0 ? `${pending} karar bekliyor` : "Bekleyen karar yok"}>
            <button
              type="button"
              onClick={() => onSelect("tasks")}
              aria-label={pending > 0 ? `${pending} karar bekliyor` : "Bekleyen karar yok"}
              className={`flex h-6 items-center gap-1.5 rounded-[4px] border px-1.5 font-mono text-[9px] tabular-nums transition-colors duration-[120ms] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/50 motion-reduce:transition-none ${
                pending > 0
                  ? "border-warn/35 bg-warn/[0.07] text-warn"
                  : "border-line text-text-lo hover:border-line-strong hover:text-text-mid"
              }`}
            >
              <Bell size={11} aria-hidden />
              <NumberTicker value={pending} duration={420} />
            </button>
          </Tooltip>

          <Tooltip content="Komut paleti · ⌘⇧K">
            <button
              type="button"
              onClick={() => setPaletteOpen(true)}
              aria-label="Komut paleti"
              aria-haspopup="dialog"
              aria-expanded={paletteOpen}
              className="flex h-6 items-center gap-1.5 rounded-[4px] border border-line px-1.5 font-mono text-[8px] uppercase tracking-[0.12em] text-text-mid transition-colors duration-[120ms] hover:border-line-strong hover:text-text-hi focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/50 motion-reduce:transition-none"
            >
              <Search size={11} aria-hidden />
              <span className="hidden 2xl:inline">komut</span>
              <kbd className="rounded-[3px] border border-line bg-bg-2 px-1 font-mono text-[8px] tracking-normal text-text-lo">
                ⌘⇧K
              </kbd>
            </button>
          </Tooltip>

          <div ref={teamRef} className="relative">
            <button
              type="button"
              onClick={() => setTeamOpen((open) => !open)}
              aria-haspopup="menu"
              aria-expanded={teamOpen}
              aria-label="Takım seç"
              className="flex h-6 items-center gap-1.5 rounded-[4px] border border-line px-1.5 font-mono text-[8px] uppercase tracking-[0.1em] text-text-mid transition-colors duration-[120ms] hover:border-line-strong hover:text-text-hi focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/50 motion-reduce:transition-none"
            >
              <Users size={11} aria-hidden />
              <span className="max-w-[72px] truncate">{selectedSquad?.callsign ?? "Takım"}</span>
              <span className="hidden text-[8px] tabular-nums text-text-lo lg:inline">
                {selectedSquad?.live ?? 0}/{selectedSquad?.roles ?? 0}
              </span>
              <ChevronDown size={9} className="text-text-lo" aria-hidden />
            </button>

            {teamOpen && (
              <div
                role="menu"
                aria-label="Takım seç"
                className="absolute right-0 top-[calc(100%+5px)] z-50 w-[292px] overflow-hidden rounded-[6px] border border-line-mid bg-bg-1/95 p-1 shadow-[0_12px_32px_-18px_rgba(0,0,0,0.8)] backdrop-blur-[2px]"
              >
                <div className="flex items-baseline gap-1 px-1.5 pb-1.5 pt-1">
                  <span className="font-mono text-[8px] uppercase tracking-[0.16em] text-text-lo">
                    Takım seç
                  </span>
                  <span className="ml-auto font-mono text-[8px] tabular-nums text-text-lo/70">
                    {departments.length} takım
                  </span>
                </div>
                <div className="grid gap-0.5">
                  {teams.map((team) => {
                    const isActive = selectedDept === team.id;
                    return (
                      <button
                        key={team.id || "all"}
                        type="button"
                        role="menuitemradio"
                        aria-checked={isActive}
                        onClick={() => {
                          setSelectedDept(team.id);
                          window.dispatchEvent(
                            new CustomEvent("yuppy:focus-team", { detail: team.id }),
                          );
                          setTeamOpen(false);
                        }}
                        className={`flex items-center gap-2 rounded-[4px] px-1.5 py-1.5 text-left transition-colors duration-[120ms] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/50 motion-reduce:transition-none ${
                          isActive ? "bg-accent/[0.09] text-text-hi" : "text-text-mid hover:bg-bg-2"
                        }`}
                      >
                        <span
                          className="grid size-5 shrink-0 place-items-center rounded-[3px] border"
                          style={{
                            borderColor: isActive ? `${team.accent}66` : "var(--line)",
                            backgroundColor: isActive ? `${team.accent}1f` : "transparent",
                            color: isActive ? team.accent : "var(--text-lo)",
                          }}
                        >
                          <SquadGlyph icon={team.icon} size={11} />
                        </span>
                        <span className="flex min-w-0 flex-col leading-none">
                          <span
                            className="font-mono text-[8px] uppercase tracking-[0.14em]"
                            style={{ color: isActive ? team.accent : undefined }}
                          >
                            {team.callsign}
                          </span>
                          <span className="mt-1 truncate text-[9.5px] text-text-mid">{team.name}</span>
                        </span>
                        <span className="ml-auto shrink-0 font-mono text-[8px] tabular-nums text-text-lo">
                          {team.live}/{team.roles}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </div>

          <Tooltip content="Ayarlar">
            <button
              type="button"
              onClick={() => onSelect("settings")}
              aria-label="Ayarlar"
              className={`grid size-6 place-items-center rounded-[4px] border transition-colors duration-[120ms] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/50 motion-reduce:transition-none ${
                active === "settings"
                  ? "border-accent/40 bg-accent/[0.08] text-accent"
                  : "border-line text-text-lo hover:border-line-strong hover:text-text-hi"
              }`}
            >
              <Settings2 size={11} aria-hidden />
            </button>
          </Tooltip>
        </div>
      </div>

      {/* ── row 2 · module dock (34px) ──────────────────────────────── */}
      <div className="relative z-10 flex h-[34px] items-stretch border-t border-line/60 bg-bg-0">
        <div
          role="tablist"
          aria-label="Modüller"
          aria-orientation="horizontal"
          className="flex min-w-0 flex-1 items-stretch overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          onKeyDown={(e) => {
            if (e.key === "ArrowRight" || e.key === "ArrowDown") {
              e.preventDefault();
              moveModule(1);
            } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
              e.preventDefault();
              moveModule(-1);
            } else if (e.key === "Home") {
              e.preventDefault();
              moveModule("home");
            } else if (e.key === "End") {
              e.preventDefault();
              moveModule("end");
            }
          }}
        >
          {MODULES.map((m) => {
            const isActive = m.id === active;
            const Icon = m.icon;
            return (
              <button
                key={m.id}
                type="button"
                role="tab"
                data-module={m.id}
                aria-selected={isActive}
                aria-label={`${m.label} modülü`}
                title={m.label}
                tabIndex={isActive ? 0 : -1}
                onClick={() => onSelect(m.id)}
                className={`relative flex shrink-0 items-center gap-1.5 px-3 text-[10px] tracking-[0.01em] transition-[background-color,color,transform] duration-[120ms] ease-out hover:-translate-y-px focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent/60 motion-reduce:transition-none motion-reduce:hover:translate-y-0 ${
                  isActive ? "text-text-hi" : "text-text-mid hover:text-text-hi"
                }`}
              >
                {isActive && (
                  <>
                    <span className="absolute inset-0 bg-accent/[0.07]" aria-hidden />
                    <span className="absolute inset-x-3 top-0 h-px bg-accent" aria-hidden />
                    <span className="absolute inset-x-3 bottom-0 h-px bg-accent/55" aria-hidden />
                  </>
                )}
                <Icon
                  size={11}
                  className={`relative shrink-0 ${isActive ? "text-accent" : "text-text-lo"}`}
                  aria-hidden
                />
                <span className="relative whitespace-nowrap">{m.label}</span>
              </button>
            );
          })}
        </div>

        <div className="flex shrink-0 items-center gap-2 border-l border-line px-2.5">
          <span className="hidden font-mono text-[8px] uppercase tracking-[0.14em] text-text-lo lg:inline">
            {departments.length} takım
          </span>
          <span className="hidden h-2.5 w-px bg-line lg:inline" aria-hidden />
          <span className="hidden font-mono text-[8px] uppercase tracking-[0.14em] text-text-lo lg:inline">
            {departments.reduce((n, d) => n + (d.roles?.length ?? 0), 0)} rol
          </span>
        </div>
      </div>

      <CommandMenu
        open={paletteOpen}
        onOpenChange={setPaletteOpen}
        onSelect={() => closePalette()}
        items={commands}
        label="Komut paleti"
        placeholder="Modül, eylem veya takım ara…"
        emptyMessage="Eşleşen komut yok"
        icon={(item) => {
          if (item.id.startsWith("module:")) {
            const mod = MODULES.find((m) => `module:${m.id}` === item.id);
            const Icon = mod?.icon;
            return Icon ? <Icon size={12} aria-hidden /> : null;
          }
          if (item.id.startsWith("team:")) return <Users size={12} aria-hidden />;
          if (item.id === "action:connect") return <Power size={12} aria-hidden />;
          if (item.id === "action:help") return <HelpCircle size={12} aria-hidden />;
          return <Settings2 size={12} aria-hidden />;
        }}
      />
    </header>
  );
}
