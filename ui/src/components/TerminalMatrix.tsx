"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { SquareTerminal, ChevronLeft, ChevronRight, ChevronUp, ChevronDown } from "lucide-react";
import { NumberTicker, Skeleton, Tabs, TabsList, TabsTrigger } from "fancy-ui-react";
import {
  useHudStore,
  SEAT_SIZE_CHOICES,
  type MatrixColumns,
  type SeatSize,
  type Session,
  type Task,
} from "@/lib/store";
import { planSeats, type SeatSpec } from "@/lib/autoTerminals";
import { agentShortName, seatSummaryFor } from "@/lib/agents";
import TerminalCard from "./TerminalCard";
import SplitSash from "./SplitSash";
import {
  MATRIX_KEYBOARD_STEP_PX,
  MATRIX_MIN_COL_PX,
  MATRIX_MIN_ROW_PX,
  autoColumnCount,
  dragColumn,
  dragRow,
  gridTemplate,
  loadMatrixRowWeights,
  loadMatrixWeights,
  persistMatrixRowWeights,
  persistMatrixWeights,
  rowsTemplate,
  weightsAreCustom,
  weightsFor,
} from "@/lib/panelResize";

const COLUMN_OPTIONS = ["auto", 3, 4, 5, 6] as const;

/** Visual gap and the gap the fractional-weight math uses. They must agree so
 * a sash drag moves the same pixels the operator sees. */
const GRID_GAP = 8;

/** Startup policy: how many PTYs the app may spawn on its own. `1/cli` is the
 * default — every additional seat is a real TUI process and real memory. */
const STARTUP_OPTIONS = [
  {
    value: "primary",
    label: "1/cli",
    title: "Her CLI'dan tek koltuk açılır (Claude + Codex) — varsayılan, en az bellek",
  },
  {
    value: "all",
    label: "tümü",
    title: "Her departman rolü için ayrı PTY açılır — çok bellek kullanır",
  },
  {
    value: "off",
    label: "kapalı",
    title: "Hiçbir koltuk kendiliğinden açılmaz — elle açarsın",
  },
] as const;

function latestTaskByCli(tasks: Record<string, Task>): Record<string, Task> {
  const latest: Record<string, Task> = {};
  for (const task of Object.values(tasks)) {
    if (task.cli) latest[task.cli] = task;
  }
  return latest;
}

/**
 * Terminal matrix. One permanent seat per detected CLI, in inventory order:
 * a running PTY docks into its own box and never displaces the others. The
 * grid never fabricates a session; the column count is a local, persisted
 * presentation choice.
 */
export default function TerminalMatrix({ full = false }: { full?: boolean }) {
  // The lead Claude PTY is the main command window above the matrix; the
  // matrix is the team it manages. Mounting it twice would make two xterms
  // fight over one PTY's size.
  const allSessions = useHudStore((s) => s.sessions);
  const sessions = useMemo(() => allSessions.filter((x) => !x.lead), [allSessions]);
  const agents = useHudStore((s) => s.agents);
  const tasks = useHudStore((s) => s.tasks);
  const departments = useHudStore((s) => s.departments);
  const status = useHudStore((s) => s.status);
  const activeSessionId = useHudStore((s) => s.activeSessionId);
  const matrixColumns = useHudStore((s) => s.matrixColumns);
  const setMatrixColumns = useHudStore((s) => s.setMatrixColumns);
  const seatSizePreset = useHudStore((s) => s.seatSizePreset);
  const setSeatSizePreset = useHudStore((s) => s.setSeatSizePreset);
  const seatStartup = useHudStore((s) => s.seatStartup);
  const setSeatStartup = useHudStore((s) => s.setSeatStartup);
  const selectedDept = useHudStore((s) => s.selectedDept);
  const openTerminal = useHudStore((s) => s.openTerminal);

  const latestByCli = useMemo(() => latestTaskByCli(tasks), [tasks]);
  const deptNames = useMemo(
    () => Object.fromEntries(departments.map((d) => [d.id, d.name])),
    [departments],
  );
  const modelFor = useMemo(() => {
    const byId = Object.fromEntries(departments.map((d) => [d.id, d]));
    return (cli: string, departmentId: string | undefined) => {
      if (!departmentId) return null;
      return byId[departmentId]?.roles?.find((r) => r.cli === cli)?.model ?? null;
    };
  }, [departments]);

  const seats = useMemo(
    () =>
      Object.fromEntries(
        agents.map((agent) => [agent.id, seatSummaryFor(agent.id, departments)]),
      ),
    [agents, departments],
  );

  const seatPlans = useMemo(() => planSeats(departments, agents), [departments, agents]);

  /**
   * Every department role gets a permanent box, in department order; a live
   * PTY docks into its own seat (agent + department) instead of displacing
   * the others. Sessions the seats cannot absorb (opened without a
   * department, or beyond the configured roles) append after them, so a
   * real process is never hidden.
   */
  const slots = useMemo(() => {
    const pool = [...sessions];
    const take = (agentId: string, department: string) => {
      let i = pool.findIndex((s) => s.agent === agentId && s.department === department);
      if (i < 0) i = pool.findIndex((s) => s.agent === agentId && !s.department);
      return i < 0 ? undefined : pool.splice(i, 1)[0];
    };
    const out: Array<{
      key: string;
      session: Session | undefined;
      agent: (typeof agents)[number] | undefined;
      seat: SeatSpec | undefined;
    }> = seatPlans.map((seat) => ({
      key: `seat-${seat.seatKey}`,
      session: take(seat.agent, seat.department),
      agent: agents.find((a) => a.id === seat.agent),
      seat,
    }));
    for (const session of pool) {
      out.push({
        key: session.id,
        session,
        agent: agents.find((a) => a.id === session.agent),
        seat: undefined,
      });
    }
    return out;
  }, [sessions, agents, seatPlans]);

  const connected = status === "connected";
  const solo = sessions.length === 1;
  // A seat is "live" when a real PTY is attached to it.
  const liveSlots = useMemo(() => slots.filter((s) => s.session), [slots]);
  const idleSlots = useMemo(() => slots.filter((s) => !s.session), [slots]);

  // Real processes only: these counters read the session list and the task
  // map the bridge sent. Nothing is estimated or padded for the header.
  const liveByCli = useMemo(() => {
    let claude = 0;
    let codex = 0;
    let other = 0;
    for (const session of sessions) {
      if (session.agent.includes("claude")) claude += 1;
      else if (session.agent.includes("codex")) codex += 1;
      else other += 1;
    }
    return { claude, codex, other };
  }, [sessions]);
  const queuedCount = useMemo(
    () => Object.values(tasks).filter((task) => task.state === "queued").length,
    [tasks],
  );
  /**
   * Parallel seats are counted per live slot, not per raw session: a session
   * without a department is absorbed by exactly one seat, so counting the raw
   * list for every department would overstate parallelism.
   */
  const parallelBySeat = useMemo(() => {
    const counts = new Map<string, number>();
    for (const { session, seat } of liveSlots) {
      if (!session) continue;
      const key = `${session.agent}::${seat?.department ?? session.department ?? ""}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return counts;
  }, [liveSlots]);

  // ── Pointer-resizable columns ────────────────────────────────────────────
  // Widths are fractional weights, never pixels: the matrix keeps scaling with
  // the window/Tauri view, and a drag only moves weight between two neighbours
  // so the total grid never overflows. Persisted per column index.
  const gridRef = useRef<HTMLDivElement>(null);
  const [gridWidth, setGridWidth] = useState(0);
  const [gridHeight, setGridHeight] = useState(0);
  const [weights, setWeights] = useState<number[]>([]);
  const weightsRef = useRef(weights);
  // Rows are resizable too: a tall plan or a wide log often wants the Claude
  // card twice the height of the Codex one. Same fractional-weight model, so
  // the grid still scales with the window and the total never overflows.
  const [rowWeights, setRowWeights] = useState<number[]>([]);
  const rowWeightsRef = useRef(rowWeights);

  useEffect(() => {
    // Deferred so the first render (and the exported HTML) stays identical;
    // persisting happens in an effect, so read it just after paint.
    queueMicrotask(() => {
      setWeights(loadMatrixWeights());
      setRowWeights(loadMatrixRowWeights());
    });
  }, []);

  useEffect(() => {
    weightsRef.current = weights;
  }, [weights]);

  useEffect(() => {
    rowWeightsRef.current = rowWeights;
  }, [rowWeights]);

  useEffect(() => {
    const el = gridRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const read = () => {
      setGridWidth(el.clientWidth);
      setGridHeight(el.clientHeight);
    };
    read();
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // `auto` divides the grid exactly like CSS auto-fit does; a fixed column
  // count is an explicit override. Until the grid has been measured the count
  // is unknown (0) and CSS auto-placement stays in charge — pinning tracks to
  // an unmeasured width would flash a single column on first paint.
  const cols =
    matrixColumns === "auto"
      ? gridWidth > 0
        ? Math.max(
            1,
            Math.min(
              autoColumnCount(gridWidth, MATRIX_MIN_COL_PX, GRID_GAP),
              Math.max(1, liveSlots.length),
            ),
          )
        : 0
      : matrixColumns;
  const explicitPlacement = cols > 0;
  const colWeights = useMemo(() => weightsFor(Math.max(1, cols), weights), [cols, weights]);
  const availablePx = Math.max(0, gridWidth - Math.max(0, cols - 1) * GRID_GAP);
  const totalFr = colWeights.reduce((sum, w) => sum + w, 0) || 1;
  const colMinPx = Math.min(
    MATRIX_MIN_COL_PX,
    Math.max(80, Math.floor(availablePx / Math.max(1, cols))),
  );
  // The header sits inside the pane, not the window, so viewport breakpoints
  // lie: a 700px matrix at 1600px viewport still needs the compact controls.
  const headerTight = gridWidth > 0 && gridWidth < 780;
  const headerVeryTight = gridWidth > 0 && gridWidth < 640;
  const headerUltraTight = gridWidth > 0 && gridWidth < 520;

  const dragColumnAt = (index: number, deltaPx: number) =>
    setWeights((prev) =>
      dragColumn(weightsFor(Math.max(1, cols), prev), index, deltaPx, gridWidth, GRID_GAP),
    );
  const commitWeights = () => persistMatrixWeights(weightsRef.current);
  const resetWeights = () => {
    setWeights([]);
    persistMatrixWeights([]);
  };

  /** Where each live seat sits. A seat is placed explicitly so a sash knows
   * which column it belongs to. */
  const placements = useMemo(
    () =>
      liveSlots.map((slot, index) =>
        explicitPlacement
          ? { slot, row: Math.floor(index / cols), col: index % cols }
          : { slot, row: 0, col: 0 },
      ),
    [liveSlots, cols, explicitPlacement],
  );

  /** One track per row of seats. */
  const rowCount = useMemo(
    () => placements.reduce((max, p) => Math.max(max, p.row + 1), 1),
    [placements],
  );
  const rowHeights = useMemo(
    () => weightsFor(Math.max(1, rowCount), rowWeights),
    [rowCount, rowWeights],
  );
  // A row's usable floor depends on the pane: three 190px rows never fit in
  // a 420px viewport, and a conflicting floor would freeze the drag solid.
  const rowMinPx = Math.min(
    MATRIX_MIN_ROW_PX,
    Math.max(70, Math.floor(gridHeight / Math.max(1, rowCount))),
  );
  /** The last card of each row owns the horizontal edge under it. */
  const rowEndKeys = useMemo(() => {
    const last = new Map<number, string>();
    for (const p of placements) last.set(p.row, p.slot.key);
    return new Set(last.values());
  }, [placements]);
  const dragRowAt = (index: number, deltaPx: number) =>
    setRowWeights((prev) =>
      dragRow(
        weightsFor(Math.max(1, rowCount), prev),
        index,
        deltaPx,
        gridHeight,
        GRID_GAP,
        rowMinPx,
      ),
    );
  const commitRows = () => persistMatrixRowWeights(rowWeightsRef.current);
  const resetRows = () => {
    setRowWeights([]);
    persistMatrixRowWeights([]);
  };

  const sizeValue = (s: SeatSize) => (s === "auto" ? "auto" : `${s.cols}x${s.rows}`);
  const currentSize = sizeValue(seatSizePreset);
  // The 4-direction size control: left/right change width, up/down change
  // height. Starting point is the fixed preset (or the default when on auto).
  const baseSize = seatSizePreset === "auto" ? { cols: 120, rows: 36 } : seatSizePreset;
  const stepSize = (dc: number, dr: number) =>
    setSeatSizePreset({
      cols: Math.min(400, Math.max(40, baseSize.cols + dc)),
      rows: Math.min(200, Math.max(10, baseSize.rows + dr)),
    });

  return (
    <section className="deck-panel relative flex h-full min-h-0 flex-1 flex-col border border-line">
      <header className="deck-rail relative z-10 flex h-8 shrink-0 items-center gap-2 border-b border-line bg-bg-1/80 px-2">
        <SquareTerminal size={11} className="shrink-0 text-accent" aria-hidden />
        <span className="shrink-0 whitespace-nowrap font-mono text-[9px] font-semibold uppercase tracking-[0.18em] text-text-hi">
          Ekip · işçi terminalleri
        </span>

        <div className="ml-auto flex min-w-0 shrink-0 items-center gap-1.5">
          {/* Group 1 — view density. Value-controlled: the store owns it. */}
          <span className={`shrink-0 font-mono text-[8px] uppercase tracking-[0.14em] text-text-lo ${headerTight ? "hidden" : "hidden md:inline"}`}>
            yoğunluk
          </span>
          <Tabs
            value={String(matrixColumns)}
            onValueChange={(value) =>
              setMatrixColumns(
                value === "auto" ? "auto" : (Number(value) as MatrixColumns),
              )
            }
            variant="segmented"
            activation="automatic"
            className="shrink-0"
          >
            <TabsList className="!h-5 !gap-0 !rounded-[3px] !border-line !bg-bg-2 !p-0 [--ft-tabs-indicator-radius:2px]">
              {COLUMN_OPTIONS.map((n) => (
                <TabsTrigger
                  key={n}
                  value={String(n)}
                  title={n === "auto" ? "Ajan sayısına göre böl" : `${n} kolon`}
                  aria-label={n === "auto" ? "Otomatik kolon sayısı" : `${n} kolon`}
                  className="!h-5 !rounded-[2px] !px-1.5 !py-0 font-mono !text-[9px] tabular-nums uppercase tracking-wider"
                >
                  {n === "auto" ? "oto" : n}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>

          {/* Only offered when a drag actually changed something. */}
          {(weightsAreCustom(colWeights) || weightsAreCustom(rowHeights)) && (
            <button
              type="button"
              onClick={() => {
                if (weightsAreCustom(colWeights)) resetWeights();
                if (weightsAreCustom(rowHeights)) resetRows();
              }}
              title="Sürüklenen kolon/satır ölçülerini eşitle"
              className={`h-5 shrink-0 whitespace-nowrap rounded-[3px] border border-line px-1.5 font-mono text-[8px] uppercase tracking-wider text-text-lo transition-colors hover:border-line-strong hover:text-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/60 ${
                headerVeryTight ? "hidden" : ""
              }`}
            >
              eşitle
            </button>
          )}

          {/* Group 2 — PTY size: preset + the four arrows. */}
          <span className="h-3.5 w-px shrink-0 bg-line" aria-hidden />
          <div className={`${headerTight ? "hidden" : "flex"} shrink-0 items-center gap-1`}>
            <select
              value={currentSize}
              onChange={(e) => {
                const choice = SEAT_SIZE_CHOICES.find((c) => sizeValue(c.value) === e.target.value);
                if (choice) setSeatSizePreset(choice.value);
              }}
              aria-label="CLI koltuk boyutu (PTY satır×sütun)"
              title="Claude/Codex koltuklarının PTY boyutu — 'otomatik' paneli takip eder, sabit değerler terminal_resize ile CLI'ya bildirilir"
              className={`h-5 shrink-0 cursor-pointer rounded-[4px] border border-line bg-bg-2 px-1.5 font-mono text-[8px] tracking-wider text-text-mid outline-none transition-colors hover:border-line-strong focus-visible:border-accent/50 ${
                headerUltraTight ? "hidden" : "w-[148px]"
              }`}
            >
              {SEAT_SIZE_CHOICES.map((c) => (
                <option key={sizeValue(c.value)} value={sizeValue(c.value)}>
                  {c.label}
                </option>
              ))}
            </select>
            <div className="flex shrink-0 overflow-hidden rounded-[4px] border border-line" role="group" aria-label="CLI boyutu yön tuşları">
              {[
                { key: "l", icon: ChevronLeft, title: "Daralt (sütun −10)", label: "CLI genişliğini azalt", dc: -10, dr: 0 },
                { key: "r", icon: ChevronRight, title: "Genişlet (sütun +10)", label: "CLI genişliğini artır", dc: 10, dr: 0 },
                { key: "u", icon: ChevronUp, title: "Yükselt (satır +4)", label: "CLI yüksekliğini artır", dc: 0, dr: 4 },
                { key: "d", icon: ChevronDown, title: "Alçalt (satır −4)", label: "CLI yüksekliğini azalt", dc: 0, dr: -4 },
              ].map((b, i) => (
                <button
                  key={b.key}
                  type="button"
                  onClick={() => stepSize(b.dc, b.dr)}
                  title={b.title}
                  aria-label={b.label}
                  className={`grid size-5 shrink-0 place-items-center text-text-lo transition-colors hover:bg-bg-2 hover:text-text-hi focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent/60 ${
                    i < 3 ? "border-r border-line" : ""
                  }`}
                >
                  <b.icon size={12} aria-hidden />
                </button>
              ))}
            </div>
          </div>

          {/* Group 3 — startup policy. A compact select: three buttons ate
              the whole ops bar on a 700px matrix. */}
          <span className="h-3.5 w-px shrink-0 bg-line" aria-hidden />
          <select
            value={seatStartup}
            onChange={(e) => setSeatStartup(e.target.value as typeof seatStartup)}
            aria-label="Açılışta açılacak koltuklar"
            title={STARTUP_OPTIONS.find((o) => o.value === seatStartup)?.title}
            className={`h-5 shrink-0 cursor-pointer rounded-[4px] border border-line bg-bg-2 px-1.5 font-mono text-[8px] uppercase tracking-wider text-text-mid outline-none transition-colors hover:border-line-strong focus-visible:border-accent/50 ${
              headerVeryTight ? "hidden" : ""
            }`}
          >
            {STARTUP_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value} title={opt.title}>
                açılış · {opt.label}
              </option>
            ))}
          </select>

          <span
            className={`size-1.5 shrink-0 rounded-full ${
              connected ? "bg-ok deck-live" : status === "connecting" ? "bg-warn animate-pulse" : "bg-danger"
            }`}
            title={connected ? "bridge bağlı" : "bridge bağlı değil"}
            aria-label={connected ? "bridge bağlı" : "bridge bağlı değil"}
          />
        </div>
      </header>

      {/* Operations strip: what is actually live per CLI right now. The
          skeleton only covers the brief bridge handshake; it never stands in
          for a PTY or for the seat grid below. */}
      <div className="relative z-10 flex h-5 shrink-0 items-center gap-2 overflow-hidden border-b border-line/60 bg-bg-1/45 px-2 font-mono text-[8px] uppercase tracking-[0.12em] text-text-lo">
        {status === "connecting" && sessions.length === 0 ? (
          <Skeleton
            variant="rect"
            animation="shimmer"
            label="bridge bağlanıyor; canlı sayaçlar bekleniyor"
            className="h-2 w-32 rounded-sm"
          />
        ) : (
          <>
            <span className="flex items-center gap-1 text-ok" title="canlı claude-code PTY sayısı">
              <span className="size-1 rounded-full bg-ok" aria-hidden />
              claude <NumberTicker value={liveByCli.claude} className="!text-ok" />
            </span>
            <span className="flex items-center gap-1 text-struct" title="canlı codex PTY sayısı">
              <span className="size-1 rounded-full bg-struct" aria-hidden />
              codex <NumberTicker value={liveByCli.codex} className="!text-struct" />
            </span>
            {liveByCli.other > 0 && (
              <span className="flex items-center gap-1" title="diğer CLI'ların canlı PTY sayısı">
                <span className="size-1 rounded-full bg-text-lo" aria-hidden />
                diğer <NumberTicker value={liveByCli.other} className="!text-text-mid" />
              </span>
            )}
            <span className="h-2.5 w-px shrink-0 bg-line" aria-hidden />
            <span className="flex items-center gap-1" title="kuyruktaki gerçek görev sayısı">
              kuyruk <NumberTicker value={queuedCount} className="!text-warn" />
            </span>
            <span className="h-2.5 w-px shrink-0 bg-line" aria-hidden />
            <span className="flex items-center gap-1" title="toplam canlı PTY / koltuk">
              <NumberTicker value={sessions.length} className="!text-text-hi" /> canlı ·{" "}
              {slots.length} yuva
            </span>
          </>
        )}
        <span
          className={`ml-auto shrink-0 text-text-lo/60 ${headerVeryTight ? "hidden" : "hidden sm:inline"}`}
        >
          ×N paralel = aynı CLI/departman
        </span>
        <span className="ml-auto flex shrink-0 items-center gap-1 sm:ml-0">
          <span
            className={`size-1.5 rounded-full ${
              connected ? "bg-ok deck-live" : status === "connecting" ? "bg-warn animate-pulse" : "bg-danger"
            }`}
            aria-hidden
          />
          {connected ? "bağlı" : status === "connecting" ? "bağlanıyor" : "kopuk"}
        </span>
      </div>

      <div
        className={`thin-scroll grid min-h-0 flex-1 auto-rows-[minmax(190px,1fr)] gap-2 overflow-y-auto p-2 ${
          matrixColumns === "auto"
            ? "grid-cols-[repeat(auto-fit,minmax(min(100%,215px),1fr))]"
            : "grid-cols-1 lg:grid-cols-[repeat(var(--matrix-cols),minmax(0,1fr))]"
        }`}
        style={
          matrixColumns === "auto"
            ? undefined
            : ({ "--matrix-cols": matrixColumns } as React.CSSProperties)
        }
      >
        {/* Live seats own the space: full-height columns, exactly like the
            reference layout. Idle seats are honest compact placeholders. */}
        <div
          ref={gridRef}
          className={`col-span-full grid min-h-0 flex-1 auto-rows-[minmax(260px,1fr)] gap-2 ${
            matrixColumns === "auto" && !explicitPlacement
              ? "grid-cols-[repeat(auto-fit,minmax(min(100%,260px),1fr))]"
              : ""
          }`}
          style={
            explicitPlacement
              ? ({
                  gridTemplateColumns: gridTemplate(colWeights),
                  ...(rowCount > 1 ? { gridTemplateRows: rowsTemplate(rowHeights) } : null),
                } as React.CSSProperties)
              : undefined
          }
        >
        {placements.map(({ slot, row, col }, index) => {
          const { key, session, agent, seat } = slot;
          const parallelKey = `${session?.agent ?? agent?.id ?? ""}::${
            seat?.department ?? session?.department ?? ""
          }`;
          const resizable =
            explicitPlacement && colWeights.length > 1 && col < colWeights.length - 1;
          // The last card of a non-final row owns the horizontal edge below it.
          const rowResizable =
            explicitPlacement && rowCount > 1 && row < rowCount - 1 && rowEndKeys.has(key);
          return (
          <div
            key={key}
            className={`deck-enter relative flex ${
              rowCount > 1 ? "min-h-0" : "min-h-[260px]"
            }`}
            style={{
              animationDelay: `${Math.min(index, 8) * 55}ms`,
              ...(explicitPlacement ? { gridColumn: col + 1, gridRow: row + 1 } : null),
            }}
          >
            <TerminalCard
              session={session}
              agent={agent}
              seatLabel={seat?.label}
              seatDepartment={seat?.department}
              task={session ? latestByCli[session.agent] : agent ? latestByCli[agent.id] : undefined}
              departmentName={
                session?.department
                  ? deptNames[session.department]
                  : seat
                    ? deptNames[seat.department]
                    : undefined
              }
              model={
                session
                  ? modelFor(session.agent, session.department)
                  : seat
                    ? modelFor(seat.agent, seat.department)
                    : agent
                      ? modelFor(agent.id, selectedDept || undefined)
                      : null
              }
              active={session ? activeSessionId === session.id : false}
              solo={solo}
              parallelCount={session ? (parallelBySeat.get(parallelKey) ?? 0) : 0}
              beam={index < 6}
              seatSummary={agent ? seats[agent.id] : undefined}
            />
            {resizable && (
              <SplitSash
                orientation="vertical"
                label={`Terminal kolonu ${col + 1} genişliği`}
                valueNow={Math.round((availablePx * colWeights[col]) / totalFr)}
                valueMin={colMinPx}
                valueMax={Math.max(
                  colMinPx,
                  Math.round(availablePx) - colMinPx * (colWeights.length - 1),
                )}
                keyboardStepPx={MATRIX_KEYBOARD_STEP_PX}
                onDelta={(dx) => dragColumnAt(col, dx)}
                onCommit={commitWeights}
                onReset={resetWeights}
                className="absolute inset-y-0 -right-[7px] w-[10px]"
              />
            )}
            {rowResizable && (
              <SplitSash
                orientation="horizontal"
                label={`Terminal satırı ${row + 1} yüksekliği`}
                valueNow={Math.round(
                  (gridHeight * rowHeights[row]) /
                    Math.max(1, rowHeights.reduce((sum, w) => sum + w, 0)),
                )}
                valueMin={rowMinPx}
                valueMax={Math.max(
                  rowMinPx,
                  Math.round(gridHeight) - rowMinPx * Math.max(0, rowCount - 1),
                )}
                keyboardStepPx={MATRIX_KEYBOARD_STEP_PX}
                onDelta={(dy) => dragRowAt(row, dy)}
                onCommit={commitRows}
                onReset={resetRows}
                className="absolute inset-x-0 -bottom-[7px] h-[10px]"
              />
            )}
          </div>
          );
        })}
        </div>

        {/* Idle seats are not terminals — nothing is running in them. A full
            card per role made the dashboard read as fifteen live Claudes and
            cost fifteen card trees; one compact strip keeps the same real
            inventory, with a per-seat button that opens that PTY on demand. */}
        {idleSlots.length > 0 && (
          <div className="col-span-full border border-line/70 bg-bg-1/30">
            <div className="flex h-5 items-center gap-1.5 border-b border-line/50 px-1.5 font-mono text-[8px] uppercase tracking-wider text-text-lo">
              <span className="size-1 rounded-full bg-text-lo/40" aria-hidden />
              <span>boş koltuklar · {idleSlots.length}</span>
              <span className="ml-auto text-text-lo/55">aç → gerçek PTY</span>
            </div>
            <div className="flex flex-wrap gap-1 p-1">
              {idleSlots.map(({ key, session, agent, seat }) => {
                const cli = seat?.agent ?? session?.agent ?? agent?.id ?? "unknown";
                const available = agent?.available ?? true;
                const label = seat?.label ?? agent?.display_name ?? agentShortName(cli);
                const [cliName, ...rest] = label.split(" · ");
                const dept = rest.join(" · ");
                const summary = agent ? seats[agent.id] : undefined;
                return (
                  <button
                    key={key}
                    type="button"
                    disabled={!available || status !== "connected"}
                    onClick={() =>
                      openTerminal(
                        cli,
                        seat?.label ?? agent?.display_name,
                        seat?.department ?? (selectedDept || undefined),
                      )
                    }
                    title={`${label} — aç (gerçek süreç)${
                      summary ? ` · ${summary.roleCount} rol` : ""
                    }${available ? "" : " · CLI yok"}`}
                    className={`group flex max-w-full items-center gap-1 rounded-sm border px-1 py-0.5 font-mono text-[8px] transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/50 ${
                      available
                        ? "border-line/70 text-text-mid hover:border-accent/50 hover:text-accent"
                        : "border-line/40 text-text-lo/50"
                    } disabled:cursor-not-allowed disabled:opacity-50`}
                  >
                    <span
                      className={`size-1 shrink-0 rounded-full ${available ? "bg-ok/45" : "bg-danger/60"}`}
                      aria-hidden
                    />
                    <span className="shrink-0">{cliName}</span>
                    {dept && (
                      <span className="max-w-[96px] truncate text-text-lo">{dept}</span>
                    )}
                    <span className="shrink-0 text-accent/70 group-hover:text-accent">+</span>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {slots.length === 0 && (
          <div className="col-span-full flex min-h-[220px] flex-col items-center justify-center px-4 text-center">
            <div className="w-full max-w-sm rounded-[10px] border border-line bg-bg-1/60 px-5 py-6">
              <div className="flex items-center justify-center gap-2 text-text-lo">
                <SquareTerminal size={16} className="text-accent/70" aria-hidden />
                <span className="font-mono text-[9px] uppercase tracking-[0.18em] text-text-mid">
                  {status === "connecting"
                    ? "köprü bağlanıyor"
                    : connected
                      ? "koltuk bekleniyor"
                      : "köprü bağlı değil"}
                </span>
              </div>
              {status === "connecting" && (
                <Skeleton
                  variant="text"
                  lines={2}
                  animation="shimmer"
                  label="bridge bağlanıyor"
                  className="mx-auto mt-3 w-40"
                />
              )}
              <p className="mt-3 font-mono text-[9px] leading-relaxed text-text-lo">
                {status === "connecting"
                  ? "Köprü hazır olduğunda gerçek Claude Code ve Codex koltukları burada belirir."
                  : connected
                    ? "Köprü hiçbir CLI bildirmedi. PATH kurulumunu denetle; koltuk açılınca matris dolar."
                    : "Terminaller köprü bağlanınca açılır. Bağlantıyı kur; sahte terminal gösterilmez."}
              </p>
            </div>
          </div>
        )}
      </div>

      {full && slots.length > 0 && (
        <footer className="flex h-5 shrink-0 items-center gap-2 border-t border-line bg-bg-1 px-2 font-mono text-[8px] uppercase tracking-wider text-text-lo">
          <span>her CLI için tek PTY</span>
          <span className="text-line">/</span>
          <span>kart başlığı: kopyala · SIGINT · yeniden başlat · kapat</span>
          <span className="text-line">/</span>
          <span>kolon kenarı: sağa sola sürükleyerek büyüt</span>
          <span className="ml-auto flex items-center gap-1 text-ok">
            <span className="size-1 rounded-full bg-ok" aria-hidden /> canlı ekran
          </span>
        </footer>
      )}
    </section>
  );
}
