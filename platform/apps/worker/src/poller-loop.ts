// The GitHub poller loop (D-08 B06 AC1, design/ADR-M27 section 2.1): a plain loop in the worker
// process, no Temporal (decision D1).
//
// - Every tick, it reads the list of pollable projects and starts the polls that are due.
// - Each project has its own interval, read from its configuration before every poll
//   (`github.poll_interval_seconds`), so a configuration change applies without a restart.
// - One project never has two polls running at once in this process. Across processes, the
//   cursor compare-and-set in `pollProject` rolls a second poll back.
// - All state (cursor, receipts) is in PostgreSQL: after a restart, every project is polled once
//   right away and continues from its stored cursor.
import { GitHostError } from '@sdlc/contracts';
import type { PollableProject } from '@sdlc/core';

import type { WorkerLogger } from './logger.js';

/** After a configuration that cannot be read, the project is tried again this much later. */
export const INVALID_CONFIG_RETRY_MS = 60_000;

export interface PollerLoopDeps {
  listProjects(): Promise<readonly PollableProject[]>;
  /** The project's `github.poll_interval_seconds`; throws when the configuration is invalid. */
  intervalSeconds(project: PollableProject): Promise<number>;
  poll(project: PollableProject): Promise<unknown>;
  /** Milliseconds since the epoch. */
  now(): number;
  readonly logger: WorkerLogger;
  readonly maxConcurrentPolls: number;
  /** Called after every tick (the container health check reads it). */
  heartbeat?(): void;
}

/** A code for logs, never an error message: Git host codes, catalog keys, error codes. */
function errorCode(error: unknown): string {
  if (error instanceof GitHostError) return error.code;
  // `SecretsError` (OpenBao) carries its catalog key, for example `secrets.not_found`.
  if (error instanceof Error && 'key' in error && typeof error.key === 'string') return error.key;
  if (error instanceof Error && 'code' in error && typeof error.code === 'string') {
    return error.code;
  }
  return 'unexpected';
}

export class PollerLoop {
  readonly #deps: PollerLoopDeps;
  readonly #nextDue = new Map<string, number>();
  readonly #running = new Map<string, Promise<void>>();
  #timer: NodeJS.Timeout | undefined;
  #ticking: Promise<void> | undefined;
  #stopped = false;

  constructor(deps: PollerLoopDeps) {
    this.#deps = deps;
  }

  /** One scheduling pass: starts the due polls and returns without waiting for them. */
  async tick(): Promise<void> {
    const projects = await this.#deps.listProjects();
    const listed = new Set(projects.map(key));
    for (const known of [...this.#nextDue.keys()]) {
      if (!listed.has(known)) this.#nextDue.delete(known);
    }
    // Longest-waiting first, so a project late in the list is never starved when more projects
    // are due than `maxConcurrentPolls`.
    const now = this.#deps.now();
    const due = projects
      .filter((p) => !this.#running.has(key(p)) && now >= (this.#nextDue.get(key(p)) ?? 0))
      .sort((a, b) => (this.#nextDue.get(key(a)) ?? 0) - (this.#nextDue.get(key(b)) ?? 0));
    for (const project of due) {
      if (this.#stopped || this.#running.size >= this.#deps.maxConcurrentPolls) break;
      const id = key(project);
      const run = this.#run(project).finally(() => this.#running.delete(id));
      this.#running.set(id, run);
    }
    this.#deps.heartbeat?.();
  }

  /** Waits for the polls in progress (tests, shutdown). */
  async idle(): Promise<void> {
    await Promise.all(this.#running.values());
  }

  start(tickMs: number): void {
    const loop = (): void => {
      if (this.#stopped) return;
      this.#ticking = this.tick()
        .catch((error: unknown) => {
          this.#deps.logger.log('error', 'worker.tick_failed', { error: errorCode(error) });
        })
        .finally(() => {
          if (!this.#stopped) this.#timer = setTimeout(loop, tickMs);
        });
    };
    loop();
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    clearTimeout(this.#timer);
    await this.#ticking;
    await this.idle();
  }

  async #run(project: PollableProject): Promise<void> {
    const id = key(project);
    const fields = { tenant_id: project.tenantId, project_id: project.projectId };
    let intervalMs: number;
    try {
      intervalMs = (await this.#deps.intervalSeconds(project)) * 1000;
    } catch (error) {
      this.#nextDue.set(id, this.#deps.now() + INVALID_CONFIG_RETRY_MS);
      this.#deps.logger.log('error', 'worker.poll_config_invalid', {
        ...fields,
        error: errorCode(error),
      });
      return;
    }
    try {
      await this.#deps.poll(project);
      this.#nextDue.set(id, this.#deps.now() + intervalMs);
    } catch (error) {
      let due = this.#deps.now() + intervalMs;
      if (error instanceof GitHostError && error.code === 'rate_limited') {
        const retryAt = Date.parse(String(error.params.retry_at ?? ''));
        if (Number.isFinite(retryAt)) due = Math.max(due, retryAt);
      }
      this.#nextDue.set(id, due);
      this.#deps.logger.log('error', 'worker.poll_failed', { ...fields, error: errorCode(error) });
    }
  }
}

function key(project: PollableProject): string {
  return `${project.tenantId}/${project.projectId}`;
}
