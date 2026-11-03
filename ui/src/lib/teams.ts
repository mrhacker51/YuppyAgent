/**
 * Team formation for mission fan-out.
 *
 * A "team" is one service owner: the web UI, the desktop shell, the CLI,
 * the core crates, docs — or a live department when the plan names one.
 * The point of the split is parallelism without collisions: every slice
 * owns a different service, so two agents never rewrite the same files in
 * their worktrees. Everything here is pure; the store turns an assignment
 * into a real `task_submit` and the bridge does the scheduling.
 */
import type { DepartmentDto } from "./protocol";
import type { MissionPlan, MissionSlice } from "./missionPlan";

export interface TeamRole {
  id: string;
  name: string;
  cli: string;
  enabled: boolean;
}

export interface Team {
  id: string;
  name: string;
  description?: string;
  roles: TeamRole[];
  maxConcurrency: number;
  enabled: boolean;
}

export interface ServiceDef {
  id: string;
  name: string;
  paths: string[];
}

/** Services that make up this product. Kept in sync with the conductor brief. */
export const SERVICE_CATALOG: readonly ServiceDef[] = [
  { id: "web", name: "Web UI", paths: ["ui/"] },
  { id: "desktop", name: "Desktop shell", paths: ["desktop/"] },
  { id: "cli", name: "CLI & bridge", paths: ["crates/yuppycode-cli/"] },
  { id: "core", name: "Çekirdek crate'ler", paths: ["crates/", "Cargo.toml"] },
  { id: "docs", name: "Dokümantasyon", paths: ["docs/", "README.md"] },
] as const;

export interface TeamAssignment {
  index: number;
  slice: MissionSlice;
  /** Stable key: `service:web`, `dept:research`, or `general`. */
  teamKey: string;
  teamName: string;
  /** Whether the assignment names a live department (null = general team). */
  department: string | null;
  service: string | null;
  role: string;
}

export interface TeamGroup {
  key: string;
  name: string;
  department: string | null;
  service: string | null;
  assignments: TeamAssignment[];
  maxConcurrency: number;
}

export interface PlanDistribution {
  assignments: TeamAssignment[];
  teams: TeamGroup[];
  /** How many slices can start immediately, bounded by team concurrency. */
  parallelism: number;
  warnings: string[];
}

/** Live department registry → teams. */
export function buildTeams(departments: DepartmentDto[]): Team[] {
  return departments.map((d) => ({
    id: d.id,
    name: d.name,
    description: d.description,
    roles: (d.roles ?? []).map((r) => ({
      id: r.id,
      name: r.name,
      cli: r.cli,
      enabled: r.enabled !== false,
    })),
    maxConcurrency: Math.max(1, d.max_concurrency || 1),
    enabled: d.enabled,
  }));
}

function titleFromId(id: string): string {
  return id
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function norm(value: string | undefined | null): string {
  return (value ?? "").trim().toLowerCase();
}

/** First service whose id/name matches, so `Web` and `web` are one team. */
export function resolveService(value: string | undefined | null): ServiceDef | null {
  const key = norm(value);
  if (!key) return null;
  return (
    SERVICE_CATALOG.find((s) => s.id === key || norm(s.name) === key) ??
    SERVICE_CATALOG.find((s) => norm(s.name).includes(key) || key.includes(s.id)) ??
    null
  );
}

function teamNameFor(service: string | null, department: string | null, teams: Team[]): string {
  if (service) {
    const known = resolveService(service);
    return known?.name ?? titleFromId(service);
  }
  if (department) {
    const team = teams.find((t) => t.id === department);
    return team?.name ?? titleFromId(department);
  }
  return "Genel Ekip";
}

/** Find the department that owns a role (used when the lead omitted both
 * `service` and `department`). Role ids are unique enough in practice. */
export function teamForRole(role: string, teams: Team[]): Team | null {
  const key = norm(role);
  if (!key) return null;
  for (const team of teams) {
    if (!team.enabled) continue;
    const hit = team.roles.find(
      (r) => norm(r.id) === key || norm(r.name) === key || norm(r.name).includes(key),
    );
    if (hit) return team;
  }
  return null;
}

function serviceForDepartment(department: string | null, teams: Team[]): string | null {
  if (!department) return null;
  const team = teams.find((t) => t.id === department);
  if (!team) return null;
  // Department ids already read like services for the built-in registry.
  return resolveService(team.id)?.id ?? null;
}

/**
 * Distribute a mission plan into service teams.
 *
 * Resolution order per slice:
 *   1. an explicit `service` (canonicalised against the catalog),
 *   2. an explicit, known `department`,
 *   3. the department that owns the slice's role,
 *   4. the operator's selected department,
 *   5. the general team.
 *
 * Two slices that resolve to the same team are allowed but warned about:
 * the requirement is one team per service, and a duplicate means those two
 * slices serialize on the same checkout instead of running in parallel.
 */
export function planTeams(
  plan: MissionPlan,
  departments: DepartmentDto[],
  fallbackDepartment?: string | null,
): PlanDistribution {
  const teams = buildTeams(departments);
  const byId = new Map(teams.map((t) => [t.id, t]));
  const warnings: string[] = [];
  const assignments: TeamAssignment[] = [];

  plan.slices.forEach((slice, index) => {
    const rawService = norm(slice.service);
    const explicitService = resolveService(slice.service)?.id ?? (rawService || null);
    const requestedDept =
      slice.department && byId.has(slice.department) ? slice.department : null;
    if (slice.department && !requestedDept && slice.department.trim()) {
      warnings.push(
        `dilim ${index + 1}: bilinmeyen takım "${slice.department}" — canlı departmana bağlanmadı`,
      );
    }
    const roleTeam = teamForRole(slice.role, teams);
    const department =
      requestedDept ??
      roleTeam?.id ??
      (fallbackDepartment && byId.has(fallbackDepartment) ? fallbackDepartment : null);
    if (slice.department && !requestedDept && !department) {
      warnings.push(`dilim ${index + 1}: takım bulunamadı, genel ekipte çalışacak`);
    }
    const service =
      explicitService ?? serviceForDepartment(department, teams) ?? null;
    const teamKey = service ? `service:${service}` : department ? `dept:${department}` : "general";
    assignments.push({
      index,
      slice,
      teamKey,
      teamName: teamNameFor(service, department, teams),
      department,
      service,
      role: slice.role,
    });
  });

  const order: string[] = [];
  const grouped = new Map<string, TeamAssignment[]>();
  for (const assignment of assignments) {
    if (!grouped.has(assignment.teamKey)) {
      grouped.set(assignment.teamKey, []);
      order.push(assignment.teamKey);
    }
    grouped.get(assignment.teamKey)!.push(assignment);
  }

  const teamGroups: TeamGroup[] = order.map((key) => {
    const list = grouped.get(key) ?? [];
    const first = list[0];
    const team = first.department ? byId.get(first.department) : undefined;
    const maxConcurrency = team?.maxConcurrency ?? list.length;
    return {
      key,
      name: first.teamName,
      department: first.department,
      service: first.service,
      assignments: list,
      maxConcurrency,
    };
  });

  let parallelism = 0;
  for (const group of teamGroups) {
    parallelism += Math.min(group.assignments.length, Math.max(1, group.maxConcurrency));
    if (group.assignments.length > group.maxConcurrency) {
      warnings.push(
        `${group.name}: ${group.assignments.length} dilim, eşzamanlılık sınırı ${group.maxConcurrency} — fazlası sıraya girer`,
      );
    }
  }

  const duplicateServices = teamGroups.filter((g) => g.assignments.length > 1);
  for (const group of duplicateServices) {
    warnings.push(
      `${group.name} aynı hizmette ${group.assignments.length} dilim aldı — aynı dosyalara dokunuyorlarsa çakışabilirler`,
    );
  }

  return {
    assignments,
    teams: teamGroups,
    parallelism: Math.max(0, Math.min(parallelism, assignments.length)),
    warnings,
  };
}
