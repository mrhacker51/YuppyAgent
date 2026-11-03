/**
 * Shared prompt → task-spec construction. The CommandBar and the mission
 * console send the same real bridge task shape; only the input chrome differs.
 */
import type { TaskSpecDto } from "./protocol";
import { agentShortName } from "./agents";

let taskSeq = 0;

export function makeTaskId(cli: string, index: number): string {
  taskSeq += 1;
  return `${cli.split("-")[0]}-${Date.now().toString(36)}-${taskSeq}-${index}`;
}

export interface ComposerTarget {
  id: string;
  /** Operator override chosen in the header; wins over the department role. */
  model?: string | null;
}

export interface ComposerDepartment {
  id: string;
  roles?: Array<{ cli: string; model?: string | null }> | null;
}

export interface ReceiverCandidate {
  id: string;
  available?: boolean;
}

/**
 * The default receiver set is every CLI the bridge actually detected.
 *
 * A mission prompt is a fan-out: the operator should not have to light the
 * second chip by hand before the team runs in parallel. Unavailable CLIs are
 * skipped because they cannot own a seat or a task.
 */
export function defaultReceiverIds(agents: readonly ReceiverCandidate[]): string[] {
  return agents.filter((agent) => agent.available !== false).map((agent) => agent.id);
}

/**
 * One real task per selected executor; the backend owns the queue.
 *
 * Claude Code leads when it is present (the mission lead), otherwise the
 * first selected CLI leads. The lead owns the `primary` role and every other
 * task carries `parallel`, which is what the task rows and the bridge runner
 * use to tell one operator prompt apart from N serial requests.
 */
export function buildTaskSpecs(
  text: string,
  targets: readonly ComposerTarget[],
  dept: ComposerDepartment | undefined,
  isolation: boolean,
): TaskSpecDto[] {
  const firstLine = text.split("\n")[0].slice(0, 72);
  // Keep the operator's order, except that the mission lead leads the batch.
  // Array.prototype.sort is stable, so equal ranks preserve the input order.
  const leadRank = (id: string) => (id === "claude-code" ? 0 : 1);
  const ordered = [...targets].sort((a, b) => leadRank(a.id) - leadRank(b.id));
  return ordered.map((agent, index) => {
    const role = dept?.roles?.find((r) => r.cli === agent.id);
    const model = agent.model ?? role?.model ?? null;
    return {
      id: makeTaskId(agent.id, index),
      title:
        ordered.length > 1
          ? `${firstLine} · ${agentShortName(agent.id)}`.slice(0, 96)
          : firstLine,
      prompt: text,
      cli: agent.id,
      model,
      department: dept?.id ?? null,
      role: index === 0 ? "primary" : "parallel",
      isolation: isolation ? "worktree" : "shared",
    };
  });
}
