"use client";

import "fancy-ui-react/styles.css";
import { useEffect, useRef, useState } from "react";
import {
  Check,
  Copy,
  RotateCw,
  Square,
  SquareTerminal,
  TriangleAlert,
  X,
} from "lucide-react";
import { BorderBeam, StatusMorph, Tooltip, type StatusMorphState } from "fancy-ui-react";
import { useHudStore, type Session, type Task } from "@/lib/store";
import type { AgentStatusDto } from "@/lib/protocol";
import { agentShortName } from "@/lib/agents";
import { cellsToText } from "@/lib/term";
import DeckPanel from "./fancy/Panel";
import TerminalPane from "./TerminalPane";
import TerminalPreview from "./TerminalPreview";

const TASK_STATE: Record<string, string> = {
  queued: "text-text-mid",
  running: "text-ok",
  awaiting_approval: "text-warn",
  completed: "text-accent",
  failed: "text-danger",
  cancelled: "text-text-lo",
};

/** Real task states, in the deck's Turkish microcopy. */
const TASK_LABEL: Record<string, string> = {
  queued: "sırada",
  running: "çalışıyor",
  awaiting_approval: "onay bekliyor",
  completed: "bitti",
  failed: "hata",
  cancelled: "iptal",
};

/** Real session/task state -> StatusMorph's four shapes. No invented states. */
function lifecycleOf(task?: Task): StatusMorphState {
  switch (task?.state) {
    case "running":
    case "awaiting_approval":
      return "loading";
    case "completed":
      return "success";
    case "failed":
    case "cancelled":
      return "error";
    default:
      return "idle";
  }
}

function lifecycleTone(state: StatusMorphState): string {
  if (state === "loading") return "text-warn";
  if (state === "success") return "text-ok";
  if (state === "error") return "text-danger";
  return "text-text-lo";
}

function lifecycleTitle(task?: Task): string {
  switch (task?.state) {
    case "running":
      return "görev çalışıyor";
    case "awaiting_approval":
      return "onay bekliyor";
    case "completed":
      return "görev tamamlandı";
    case "failed":
      return "görev başarısız";
    case "cancelled":
      return "görev iptal edildi";
    case "queued":
      return "görev kuyrukta";
    default:
      return "canlı PTY · görev yok";
  }
}

function taskLabel(task: Task): string {
  return TASK_LABEL[task.state] ?? task.state;
}

function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`
    : `${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
}

function Elapsed({ startedAt, className }: { startedAt?: number; className?: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!startedAt) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [startedAt]);
  if (!startedAt) return <span className={`tabular-nums text-text-lo ${className ?? ""}`}>--:--</span>;
  return (
    <span
      className={`tabular-nums text-text-mid ${className ?? ""}`}
      title="Oturum açıldığından beri geçen süre"
    >
      {formatDuration((now - startedAt) / 1000)}
    </span>
  );
}

async function copyScreen(session: Session): Promise<boolean> {
  const screen = session.lastScreen;
  if (!screen || screen.type !== "terminal_screen") return false;
  const text = cellsToText(screen.cells, screen.rows, screen.cols);
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // WebKitGTK can deny the async clipboard API; the textarea fallback is
    // still a user gesture and copies exactly the same snapshot.
    try {
      const area = document.createElement("textarea");
      area.value = text;
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.appendChild(area);
      area.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(area);
      return ok;
    } catch {
      return false;
    }
  }
}

function IconButton({
  label,
  onClick,
  tone = "default",
  children,
}: {
  label: string;
  onClick: () => void;
  tone?: "default" | "warn" | "danger";
  children: React.ReactNode;
}) {
  const toneClass =
    tone === "warn"
      ? "hover:border-warn/50 hover:text-warn"
      : tone === "danger"
        ? "hover:border-danger/50 hover:text-danger"
        : "hover:border-line-strong hover:text-accent";
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      aria-label={label}
      className={`grid size-5 shrink-0 place-items-center rounded-[4px] border border-transparent text-text-lo transition-colors duration-150 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/60 ${toneClass}`}
    >
      {children}
    </button>
  );
}

/** A task chip: real state text and the real title, nothing estimated. */
function TaskChip({ task }: { task?: Task }) {
  if (!task) return null;
  return (
    <span
      className="flex min-w-0 items-center gap-1 rounded-[4px] border border-line/70 bg-bg-2/70 px-1 py-px"
      title={task.title ?? task.id}
    >
      <span
        className={`shrink-0 font-mono text-[8px] uppercase tracking-[0.12em] ${
          TASK_STATE[task.state] ?? "text-text-mid"
        }`}
      >
        {taskLabel(task)}
      </span>
      <span className="min-w-0 truncate font-mono text-[8px] text-text-lo">
        {task.title ?? task.id}
      </span>
    </span>
  );
}

/**
 * True while the card is close to the viewport. Off-screen terminals are
 * unmounted: every mounted pane is a real xterm canvas with its own scrollback
 * ring, and a board with a dozen live seats would pay for all of them at once.
 * The cheap preview keeps the last frame readable until you scroll back.
 */
function useNearViewport<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  // Start false so a fresh paint does not mount every seat before the
  // observer has had a chance to speak. Visible cards turn on next frame.
  const [near, setNear] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") {
      setNear(true);
      return;
    }
    const io = new IntersectionObserver(
      (entries) => setNear(entries.some((e) => e.isIntersecting)),
      { rootMargin: "180px 0px" },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return { ref, near };
}

export interface TerminalCardProps {
  session?: Session;
  agent?: AgentStatusDto;
  task?: Task;
  departmentName?: string;
  model?: string | null;
  active?: boolean;
  solo?: boolean;
  /** Real department/role config that targets this executor. */
  seatSummary?: { roleCount: number; departments: string[]; models: string[] };
  /** Department seat this box belongs to ("Claude Code · Ar-Ge #2"). */
  seatLabel?: string;
  seatDepartment?: string;
  /** How many live PTYs share this seat's CLI + department (real sessions). */
  parallelCount?: number;
  /**
   * Whether the border comet may run. The matrix caps visible comets so a
   * screen full of terminals never becomes a screen full of light.
   */
  beam?: boolean;
}

/**
 * One matrix cell. A live cell is a real xterm attached to the bridge PTY; an
 * idle cell is an honest executor slot with no fake terminal output.
 */
export default function TerminalCard({
  session,
  agent,
  task,
  departmentName,
  model,
  active = false,
  solo = false,
  seatSummary,
  seatLabel,
  seatDepartment,
  parallelCount = 0,
  beam,
}: TerminalCardProps) {
  const focusSession = useHudStore((s) => s.focusSession);
  const openTerminal = useHudStore((s) => s.openTerminal);
  const closeTerminal = useHudStore((s) => s.closeTerminal);
  const restartSession = useHudStore((s) => s.restartSession);
  const send = useHudStore((s) => s.send);
  const status = useHudStore((s) => s.status);
  const selectedDept = useHudStore((s) => s.selectedDept);
  const [copied, setCopied] = useState(false);
  const { ref: nearRef, near } = useNearViewport<HTMLDivElement>();

  const cli = session?.agent ?? agent?.id ?? "unknown";
  const available = agent?.available ?? true;
  const display = session?.label || agent?.display_name || agentShortName(cli);

  if (!session) {
    const targets = seatSummary?.departments ?? [];
    const idleState: StatusMorphState = available ? "idle" : "error";
    return (
      <DeckPanel
        label={seatLabel ?? `${agentShortName(cli)} · boş koltuk`}
        icon={
          <StatusMorph
            state={idleState}
            resetAfter={0}
            tone="current"
            className={`text-[10px] ${lifecycleTone(idleState)}`}
            title={available ? "boş koltuk" : "CLI yok"}
            aria-label={available ? "boş koltuk" : "CLI yok"}
            idle={
              <span
                className={`size-1.5 rounded-full ${
                  available ? "bg-text-lo/50" : "bg-danger/60"
                }`}
                aria-hidden
              />
            }
          />
        }
        meta={available ? "boşta" : "cli yok"}
        tone={available ? "neutral" : "danger"}
        flush
        className="h-full min-h-0 min-w-0 flex-1 rounded-[10px]"
        bodyClassName="min-h-0"
        actions={
          <span className="rounded-[4px] border border-line/70 px-1 py-px font-mono text-[8px] uppercase tracking-[0.12em] text-text-lo">
            {available ? "boş" : "yok"}
          </span>
        }
      >
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-1.5 p-2 text-center">
          <SquareTerminal size={14} className="text-text-lo/40" aria-hidden />
          <p className="font-mono text-[9px] uppercase tracking-[0.14em] text-text-lo">
            {available ? "boşta" : "cli yok"}
          </p>
          {task ? (
            <div className="max-w-full">
              <TaskChip task={task} />
            </div>
          ) : (
            <p className="max-w-[95%] truncate font-mono text-[8px] text-text-lo/60">
              {available
                ? `${seatSummary?.roleCount ?? 0} rol · ${targets.length} takım`
                : agent?.install_hint || "PATH'te yok"}
            </p>
          )}
          <button
            type="button"
            disabled={!available || status !== "connected"}
            onClick={() =>
              openTerminal(cli, seatLabel ?? agent?.display_name, seatDepartment ?? (selectedDept || undefined))
            }
            className="pixel-btn pixel-btn-primary !px-2 !py-0.5 !text-[7px] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/60 disabled:cursor-not-allowed disabled:opacity-40"
          >
            aç
          </button>
          {task && available && status === "connected" && (
            <p className="flex items-center gap-1 font-mono text-[8px] text-text-lo/70">
              <TriangleAlert size={8} aria-hidden />
              görev CLI üzerinde çalışır; terminal ayrı açılır
            </p>
          )}
        </div>
      </DeckPanel>
    );
  }

  const state = lifecycleOf(task);
  const running = task?.state === "running" || task?.state === "awaiting_approval";
  const parallel = Math.max(1, parallelCount);
  const showBeam = running && (beam ?? true);

  return (
    <div
      data-session-id={session.id}
      onMouseDown={() => focusSession(session.id)}
      className="relative flex min-h-0 min-w-0 flex-1 flex-col rounded-[10px]"
    >
      <DeckPanel
        label={display}
        icon={
          <span className="flex items-center gap-1">
            <StatusMorph
              state={state}
              resetAfter={0}
              tone="current"
              labels={{ loading: "çalışıyor", success: "tamamlandı", error: "başarısız" }}
              className={`text-[10px] ${lifecycleTone(state)}`}
              title={lifecycleTitle(task)}
              aria-label={lifecycleTitle(task)}
              idle={
                <span
                  className="deck-live size-1.5 rounded-full bg-ok"
                  title="canlı PTY"
                  aria-hidden
                />
              }
            />
            <span
              key={`${session.id}:${session.generation ?? 0}`}
              className="term-activity size-1 shrink-0 rounded-full bg-ok/70"
              title="son ekran güncellemesi"
              aria-hidden
            />
          </span>
        }
        meta={
          <span className="flex min-w-0 items-center gap-1.5">
            {seatLabel && seatLabel !== display && (
              <span className="hidden max-w-[110px] truncate text-text-lo/80 lg:inline" title={seatLabel}>
                {seatLabel}
              </span>
            )}
            {departmentName && (
              <span className="hidden max-w-[84px] truncate text-text-lo md:inline">
                {departmentName}
              </span>
            )}
            <span className="hidden shrink-0 text-text-lo/70 lg:inline">
              #{session.id.slice(-5)}
            </span>
            <Elapsed startedAt={session.openedAt} />
            <span
              className={`shrink-0 rounded-[4px] border px-1 tabular-nums ${
                parallel > 1
                  ? "border-accent/30 bg-accent/[0.08] text-accent"
                  : "border-line/70 text-text-lo"
              }`}
              title={`${parallel} canlı PTY bu CLI/departman için eşzamanlı çalışıyor`}
            >
              ×{parallel}
            </span>
            {model && (
              <span
                className="hidden max-w-[92px] truncate text-text-lo/80 xl:inline"
                title={`model: ${model}`}
              >
                {model.split("/").pop()}
              </span>
            )}
          </span>
        }
        tone={active ? "accent" : "neutral"}
        live={running}
        flush
        className={`h-full min-h-0 min-w-0 flex-1 rounded-[10px] transition-all duration-150 ${
          active
            ? "border-line ring-1 ring-accent/60"
            : "border-line hover:border-line-strong"
        }`}
        bodyClassName="min-h-0"
        actions={
          <span className="flex shrink-0 items-center gap-px">
            <Tooltip content={copied ? "kopyalandı" : "ekranı kopyala"} side="bottom" align="end">
              <IconButton
                label={copied ? "kopyalandı" : "ekranı kopyala"}
                onClick={() => {
                  void copyScreen(session).then((ok) => {
                    if (!ok) return;
                    setCopied(true);
                    setTimeout(() => setCopied(false), 1200);
                  });
                }}
              >
                {copied ? <Check size={10} className="text-ok" /> : <Copy size={10} />}
              </IconButton>
            </Tooltip>
            <Tooltip content="SIGINT gönder (Ctrl-C)" side="bottom" align="end">
              <IconButton
                label="SIGINT gönder (Ctrl-C)"
                tone="warn"
                onClick={() => send({ type: "terminal_interrupt", session_id: session.id })}
              >
                <Square size={9} />
              </IconButton>
            </Tooltip>
            <Tooltip content="Yeniden başlat" side="bottom" align="end">
              <IconButton label="Yeniden başlat" onClick={() => restartSession(session.id)}>
                <RotateCw size={10} />
              </IconButton>
            </Tooltip>
            <Tooltip content="Terminali kapat" side="bottom" align="end">
              <IconButton
                label="Terminali kapat"
                tone="danger"
                onClick={() => closeTerminal(session.id)}
              >
                <X size={10} />
              </IconButton>
            </Tooltip>
          </span>
        }
      >
        {task && (
          <div className="flex h-6 shrink-0 items-center gap-1.5 border-b border-line/60 bg-bg-1/40 px-1.5">
            <TaskChip task={task} />
            <span className="ml-auto flex shrink-0 items-center gap-1 font-mono text-[8px] uppercase tracking-[0.12em] text-text-lo/70">
              <span className="hidden sm:inline">{agentShortName(cli)}</span>
              <span className="text-text-lo/50">{lifecycleTitle(task)}</span>
            </span>
          </div>
        )}
        <div ref={nearRef} className="term-surface min-h-0 flex-1 overflow-hidden bg-[#080b0f]">
          {near || active ? (
            <TerminalPane key={session.id} session={session} autoFocus={solo || active} />
          ) : (
            <TerminalPreview sessionId={session.id} label={display} />
          )}
        </div>
      </DeckPanel>

      {showBeam && (
        <BorderBeam
          size={active ? 112 : 96}
          duration={active ? 8 : 10}
          borderWidth={1}
          colorFrom="#5eead4"
          colorTo="#8b9cf7"
          glow={0.35}
          tail={0.16}
          className="z-20 pointer-events-none"
        />
      )}
    </div>
  );
}
