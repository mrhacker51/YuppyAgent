/**
 * Seat planning for the worker terminals.
 *
 * A seat is one worker role of a team: (department, role). Every agent runs
 * Claude Code, so a seat exists only while the bridge reports Claude Code as
 * available. Seats are NOT opened by default — workers run headless and
 * stream to their cards; only the explicit "all" startup policy opens one
 * interactive PTY per seat. Pure so the rule is testable; the store stays
 * the only place that touches the socket. Nothing is ever simulated.
 */
import { AGENT_CLI } from "./agents";

export interface SeatAgent {
  id: string;
  displayName?: string;
  available: boolean;
}

export interface SeatDepartment {
  id: string;
  name?: string;
  enabled: boolean;
  roles?: Array<{
    id?: string;
    name?: string;
    callsign?: string;
    cli?: string;
    model?: string | null;
    enabled?: boolean;
    lead?: boolean;
  }> | null;
}

export interface SeatSpec {
  /** Stable key: department + role index, never depends on session ids. */
  seatKey: string;
  agent: string;
  department: string;
  /** Role id the seat belongs to (absent for legacy roles without one). */
  role?: string;
  label: string;
}

export interface SeatSession {
  agent: string;
  department?: string;
}

/**
 * All worker seats in team order: every enabled, non-lead role of an
 * enabled team, labelled `${callsign} · ${team}`. The lead is not a seat —
 * it has its own PTY per team. Without Claude Code there are no seats.
 */
export function planSeats(
  departments: readonly SeatDepartment[],
  agents: readonly SeatAgent[],
): SeatSpec[] {
  if (!agents.some((a) => a.id === AGENT_CLI && a.available)) return [];
  const seats: SeatSpec[] = [];
  for (const department of departments) {
    if (!department.enabled) continue;
    (department.roles ?? []).forEach((role, index) => {
      if (role.enabled === false || role.lead === true) return;
      const who = role.callsign?.trim() || role.name?.trim() || role.id || `#${index + 1}`;
      seats.push({
        seatKey: `${department.id}:${index}`,
        agent: AGENT_CLI,
        department: department.id,
        ...(role.id ? { role: role.id } : null),
        label: `${who} · ${department.name ?? department.id}`,
      });
    });
  }
  return seats;
}

/**
 * The worker seats to auto-open under a startup policy. Only `all` opens
 * any: `lead` (default) and `off` keep every worker headless.
 */
export function autoSeats(seats: readonly SeatSpec[], policy: "lead" | "all" | "off"): SeatSpec[] {
  return policy === "all" ? [...seats] : [];
}

/**
 * Seats that need a spawn now: live sessions fill their seats first (FIFO
 * per agent+department); a seat attempted earlier this connection stays
 * closed — an operator's close or a failed spawn is never reopened behind
 * their back.
 */
export function planSeatOpens(
  seats: readonly SeatSpec[],
  sessions: readonly SeatSession[],
  attempted: ReadonlySet<string>,
): SeatSpec[] {
  const remaining = new Map<string, number>();
  for (const s of sessions) {
    const key = `${s.agent}@${s.department ?? ""}`;
    remaining.set(key, (remaining.get(key) ?? 0) + 1);
  }
  const plan: SeatSpec[] = [];
  for (const seat of seats) {
    const key = `${seat.agent}@${seat.department}`;
    const live = remaining.get(key) ?? 0;
    if (live > 0) {
      remaining.set(key, live - 1);
      continue;
    }
    if (attempted.has(seat.seatKey)) continue;
    plan.push(seat);
  }
  return plan;
}

/**
 * Column count for `auto` density: one box per agent, but never narrower than
 * a usable terminal. Mirrors the CSS `auto-fit` rule the matrix uses so a
 * narrow dock on desktop still stacks instead of crushing the PTY.
 */
export function autoMatrixColumns(slots: number, containerWidth = 900): 1 | 2 | 3 | 4 {
  if (slots <= 1) return 1;
  const fitting = Math.floor(Math.max(0, containerWidth) / 300);
  const bounded = Math.min(4, Math.max(1, fitting));
  return Math.min(slots, bounded) as 1 | 2 | 3 | 4;
}
