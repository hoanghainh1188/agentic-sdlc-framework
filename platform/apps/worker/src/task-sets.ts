// The task sets the worker's plan loop knows (task L05, design/ADR-M82 §2.6): the copy of task set
// v1 in the worker image (`/app/eval-tasks`, without the reference solutions), or the server's own
// set (`SDLC_EVAL_TASKS_DIR`). The loop needs only the version, the commit and the task IDs; a
// folder that cannot be read is no task set (a plan that names it is refused, never guessed).
import { loadTaskSet } from '@sdlc/eval';
import type { KnownTaskSet } from '@sdlc/core';

export function taskSetReader(dir: string): (version: number) => Promise<KnownTaskSet | undefined> {
  let known: KnownTaskSet | null | undefined;
  return (version) => {
    if (known === undefined) {
      try {
        const set = loadTaskSet(dir);
        known = {
          version: set.version,
          baseSha: set.commit,
          taskIds: set.tasks.map((task) => task.id),
        };
      } catch {
        known = null;
      }
    }
    return Promise.resolve(known?.version === version ? known : undefined);
  };
}
