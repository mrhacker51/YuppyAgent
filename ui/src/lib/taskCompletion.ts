/**
 * Completion detection for the task banner.
 *
 * The banner is only allowed to fire on a real transition: a task the store
 * already knew about moving from a non-terminal state into "completed". A task
 * that is already completed the first time we see it (page reload, reconnect,
 * a fresh snapshot) must never be celebrated — that would be fake history.
 */
import type { Task } from "./store";

export interface CompletedTask {
  id: string;
  title: string;
}

export function newlyCompleted(
  previous: Record<string, Task> | undefined,
  next: Record<string, Task>,
): CompletedTask[] {
  if (!previous) return [];
  const out: CompletedTask[] = [];
  for (const [id, task] of Object.entries(next)) {
    if (task.state !== "completed") continue;
    const before = previous[id];
    // Unknown before → we did not witness the transition.
    if (!before || before.state === "completed") continue;
    out.push({ id, title: task.title?.trim() || id });
  }
  return out;
}
