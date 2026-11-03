/**
 * Team roster — departments as teams of named Claude Code agents.
 *
 * A team (= department) has one lead and named workers with job titles:
 * "Transformers": lead "Optimus", "Ratchet — Backend Developer", … The bridge
 * owns the roster (`DepartmentRoleDto.callsign` / `.lead`); this module only
 * reads it. Pure on purpose: the store and the cards share these rules, and
 * the tests pin them without rendering anything.
 */
import type { DepartmentDto, DepartmentRoleDto, PermissionModeDto } from "./protocol";

/** Label of the lead PTY when the bridge has no teams at all. */
export const LEAD_LABEL = "Lead · Claude Code";

/** Lines a worker card keeps per task (ring buffer). */
export const TASK_OUTPUT_CAP = 200;

/** Tasks whose streamed output is retained at once (oldest dropped). */
export const TASK_OUTPUT_TASKS_CAP = 64;

export const PERMISSION_MODES: ReadonlyArray<{ value: PermissionModeDto; label: string; note: string }> = [
  { value: "default", label: "varsayılan", note: "Claude her riskli adımda izin ister." },
  { value: "acceptEdits", label: "düzenlemeleri kabul et", note: "Dosya düzenlemeleri sorulmadan uygulanır; komutlar için izin istenir." },
  {
    value: "bypassPermissions",
    label: "izinleri atla",
    note: "DİKKAT: ajanlar hiçbir izin sormadan dosya yazar ve komut çalıştırır. Yalnızca yalıtılmış (worktree/sandbox) çalışma alanında kullan.",
  },
];

/** Persona name, falling back to the job title, then the id. */
export function roleCallsign(role: Pick<DepartmentRoleDto, "id" | "name" | "callsign">): string {
  return role.callsign?.trim() || role.name?.trim() || role.id;
}

/** Enabled roles in roster order. */
export function teamRoles(team: DepartmentDto | undefined): DepartmentRoleDto[] {
  return (team?.roles ?? []).filter((r) => r.enabled !== false);
}

/** The team's lead role (first enabled role flagged `lead`). */
export function leadRole(team: DepartmentDto | undefined): DepartmentRoleDto | undefined {
  return teamRoles(team).find((r) => r.lead === true);
}

/** Enabled roles that are not the lead — one card each. */
export function workerRoles(team: DepartmentDto | undefined): DepartmentRoleDto[] {
  const lead = leadRole(team);
  return teamRoles(team).filter((r) => r !== lead);
}

/** Label the lead PTY is opened with: `${callsign||"Lead"} · ${team.name}`. */
export function leadLabelFor(team: DepartmentDto | undefined): string {
  if (!team) return LEAD_LABEL;
  const lead = leadRole(team);
  const callsign = lead?.callsign?.trim() || "Lead";
  return `${callsign} · ${team.name}`;
}

export function permissionModeOf(team: DepartmentDto | undefined): PermissionModeDto {
  const mode = team?.permission_mode;
  return mode === "acceptEdits" || mode === "bypassPermissions" ? mode : "default";
}

/** Header tab data: every team with its enabled agent count. */
export function teamTabs(departments: readonly DepartmentDto[]): Array<{ id: string; name: string; count: number; enabled: boolean }> {
  return departments.map((d) => ({
    id: d.id,
    name: d.name,
    count: teamRoles(d).length,
    enabled: d.enabled,
  }));
}

/** The team to show: the preferred one if it still exists, else the first
 * enabled team, else the first team, else "" (no teams). */
export function pickTeam(departments: readonly DepartmentDto[], preferred: string | null | undefined): string {
  if (preferred && departments.some((d) => d.id === preferred)) return preferred;
  return departments.find((d) => d.enabled)?.id ?? departments[0]?.id ?? "";
}

/** Minimal task shape the card mapping needs (store `Task` satisfies it). */
export interface RosterTask {
  id: string;
  state: string;
  department?: string | null;
  role?: string | null;
}

const LIVE = new Set(["queued", "running", "awaiting_approval"]);

export function isLiveState(state: string): boolean {
  return LIVE.has(state);
}

function roleMatches(role: DepartmentRoleDto, value: string): boolean {
  const v = value.trim().toLowerCase();
  return role.id.toLowerCase() === v || role.name.trim().toLowerCase() === v;
}

/** Resolve a task's role id inside a team, or undefined when it has none. */
export function roleForTask(team: DepartmentDto | undefined, task: RosterTask): DepartmentRoleDto | undefined {
  if (!team || task.department !== team.id || !task.role) return undefined;
  return (team.roles ?? []).find((r) => roleMatches(r, task.role as string));
}

/**
 * Tasks → cards for the selected team. A task belongs to a role card when
 * its `department` is this team and its `role` names one of the team's
 * roles. Tasks of this team with an unknown role, and tasks scoped to no
 * known team, go to the "ekip dışı" group. Other teams' tasks are not shown.
 * Lists keep the order the tasks were given in (oldest first).
 */
export function assignTasksToCards<T extends RosterTask>(
  team: DepartmentDto | undefined,
  departments: readonly DepartmentDto[],
  tasks: readonly T[],
): { byRole: Map<string, T[]>; outsiders: T[] } {
  const byRole = new Map<string, T[]>();
  const outsiders: T[] = [];
  const known = new Set(departments.map((d) => d.id));
  for (const task of tasks) {
    const dept = task.department ?? "";
    if (team && dept === team.id) {
      const role = roleForTask(team, task);
      if (role) {
        const list = byRole.get(role.id) ?? [];
        list.push(task);
        byRole.set(role.id, list);
      } else {
        outsiders.push(task);
      }
    } else if (!dept || !known.has(dept)) {
      outsiders.push(task);
    }
  }
  return { byRole, outsiders };
}

/** The task a card headlines: the newest live one, else the newest. */
export function currentTask<T extends RosterTask>(list: readonly T[] | undefined): T | undefined {
  if (!list || list.length === 0) return undefined;
  for (let i = list.length - 1; i >= 0; i--) if (isLiveState(list[i].state)) return list[i];
  return list[list.length - 1];
}

/** Append lines to a capped ring buffer (returns a new array). */
export function pushLines(prev: readonly string[] | undefined, lines: readonly string[], cap = TASK_OUTPUT_CAP): string[] {
  const next = prev ? [...prev, ...lines] : [...lines];
  return next.length > cap ? next.slice(next.length - cap) : next;
}

/** Who a task is, in the operator's words: the role's callsign when the task
 * maps to a role of a known team, else the task title/id. */
export function taskAgentName<T extends RosterTask & { title?: string }>(
  departments: readonly DepartmentDto[],
  task: T,
): string {
  const team = departments.find((d) => d.id === task.department);
  const role = roleForTask(team, task);
  if (role) return roleCallsign(role);
  return "ekip dışı";
}
