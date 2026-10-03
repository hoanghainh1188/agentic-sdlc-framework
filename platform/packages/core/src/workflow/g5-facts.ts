// What G5 reads about the intent's last run (task C07 PR 2, design/ADR-M34 §2.8): the run's final
// status and stop reason, the runner's records of its changes (`diff_stored`, `changes_checked`,
// PR 1), the key's cap (`key_issued`), the budget warning, and the run's synced spend
// (`cost_records`). The G5 input hash binds every G5 decision and the G5 escalation to exactly this
// result of exactly this run (FR-17). Codes, counts and hashes only: never a path.
import { createHash } from 'node:crypto';

import { canonicalJson } from '@sdlc/config';
import type { RunStatus } from '@sdlc/contracts';

import { fromMicros, toMicros } from '../cost/money.js';
import type { Run } from '../db/schema.js';
import type { TenantScope } from '../db/tenant-scope.js';

/** Run statuses that go to G5 (`finishRun`, the runner's changes step). */
export const G5_RUN_STATUSES: readonly RunStatus[] = [
  'succeeded',
  'stopped_budget',
  'stopped_scope',
  'stopped_timeout',
  'stopped_stalled',
];

export interface G5Changes {
  readonly changedFiles: number;
  readonly outOfScope: number;
  readonly instructionFiles: number;
  readonly pathsSha256: string;
}

export interface G5Facts {
  readonly run: Run;
  /** SHA-256 of the stored diff (`diff_stored`); null when the runner recorded none. */
  readonly diffSha256: string | null;
  /** The runner's check of the changed paths (`changes_checked`); null when missing. */
  readonly changes: G5Changes | null;
  /** The cap of the run's key (`key_issued`); null when unknown. */
  readonly keyCapUsd: string | null;
  /** The runner recorded `budget_warning` during the run. */
  readonly warned: boolean;
  /** The run's synced spend (`cost_records`), as a decimal string. */
  readonly spentUsd: string;
  /** The G5 input hash: the decisions and the escalation are bound to it. */
  readonly inputSha256: string;
}

function sha256(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function num(value: unknown): number {
  return typeof value === 'number' ? value : 0;
}

/** The facts of the intent's last run, or null when it has no run that goes to G5. */
export async function gatherG5Facts(scope: TenantScope, intentId: string): Promise<G5Facts | null> {
  const run = (await scope.runs.listForIntent(intentId)).at(-1);
  if (!run || !G5_RUN_STATUSES.includes(run.status)) return null;
  const events = await scope.runEvents.list(run.id);
  const last = (type: string) => events.filter((e) => e.event_type === type).at(-1)?.payload;
  const diff = last('diff_stored');
  const checked = last('changes_checked');
  const key = last('key_issued');
  const changes: G5Changes | null =
    checked && typeof checked.paths_sha256 === 'string'
      ? {
          changedFiles: num(checked.changed_files),
          outOfScope: num(checked.out_of_scope),
          instructionFiles: num(checked.instruction_files),
          pathsSha256: checked.paths_sha256,
        }
      : null;
  const records = await scope.costRecords.listForRun(run.id);
  const spent = records.reduce((sum, r) => sum + toMicros(String(r.cost_usd)), 0n);
  const diffSha256 = str(diff?.sha256);
  return {
    run,
    diffSha256,
    changes,
    keyCapUsd: str(key?.max_budget_usd),
    warned: events.some((e) => e.event_type === 'budget_warning'),
    spentUsd: fromMicros(spent),
    inputSha256: sha256({
      v: 1,
      run_id: run.id,
      status: run.status,
      stop_reason: run.stop_reason,
      diff_sha256: diffSha256,
      paths_sha256: changes?.pathsSha256 ?? null,
    }),
  };
}

/** The share of the key's cap the run spent, in whole percent; null when the cap is unknown. */
export function spentPercent(facts: Pick<G5Facts, 'keyCapUsd' | 'spentUsd'>): number | null {
  if (facts.keyCapUsd === null) return null;
  const cap = toMicros(facts.keyCapUsd);
  if (cap <= 0n) return null;
  return Number((toMicros(facts.spentUsd) * 100n) / cap);
}
