/** The only executor the HUD drives: every agent (lead and workers) runs
 * Claude Code. Other CLIs a bridge may still report are ignored. */
export const AGENT_CLI = "claude-code";

/** Human label for a bridge agent id (claude-code → Claude Code). */
export function agentShortName(agent: string): string {
  if (agent.includes("claude")) return "Claude Code";
  return agent;
}

/** True for the executors this HUD supports (Claude Code only). */
export function isSupportedAgent(id: string): boolean {
  return id === AGENT_CLI || id.startsWith("claude");
}

/** Bridge inventory without the CLIs the HUD no longer drives. */
export function supportedAgents<T extends { id: string }>(agents: readonly T[]): T[] {
  return agents.filter((a) => isSupportedAgent(a.id));
}

/**
 * Bridge inventory versions can carry a package banner, e.g.
 * `2.1.317 (Claude Code)`. The matrix and the
 * selected-agent rail only have room for the semantic version.
 */
export function agentVersion(version?: string | null): string | null {
  if (!version) return null;
  const match = version.match(/\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?/);
  return match ? match[0] : version;
}

/** Departments whose configured roles target this executor. */
export function seatSummaryFor(
  agentId: string,
  departments: Array<{
    name: string;
    roles?: Array<{ cli: string; model?: string | null }> | null;
  }>,
): { roleCount: number; departments: string[]; models: string[] } {
  const departmentNames: string[] = [];
  const models: string[] = [];
  let roleCount = 0;
  for (const department of departments) {
    let targets = false;
    for (const role of department.roles ?? []) {
      if (role.cli !== agentId) continue;
      targets = true;
      roleCount += 1;
      if (role.model && !models.includes(role.model)) models.push(role.model);
    }
    if (targets && !departmentNames.includes(department.name)) {
      departmentNames.push(department.name);
    }
  }
  return { roleCount, departments: departmentNames, models };
}
