// `sdlc ops run kill`: the kill switch on the server (task C11, D-02 FR-34 "or the platform",
// ADR-M42 §2.6). An operator command with SDLC_DB_URL (`platform_app`), audited as actor
// `system`, for when nobody with a kill role is reachable or the API is down. It records the kill
// in the database: the runner stops the run within a poll, and the worker's reconcile loop sends
// the kill signal (a run waiting in Temporal never starts). People use `sdlc run kill`.
import { parseArgs } from 'node:util';

import { KillError, requestRunKill, type KillErrorCode, type TenantScope } from '@sdlc/core';
import { t, type MessageKey } from '@sdlc/messages';

import { EXIT, type CliContext } from '../context.js';

type Values = Record<string, string | boolean | undefined>;

const SPEC = {
  tenant: { type: 'string' },
  run: { type: 'string' },
  json: { type: 'boolean', default: false },
} as const;

const ERROR_KEYS: Readonly<Record<KillErrorCode, MessageKey>> = {
  run_not_found: 'cli.ops.run.error.run_not_found',
  forbidden: 'cli.ops.run.error.forbidden',
  run_not_active: 'cli.ops.run.error.run_not_active',
  no_active_run: 'cli.ops.run.error.no_active_run',
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Parses `args` (after `ops run`). Undefined: print the usage. */
export function parseRunCommand(
  args: readonly string[],
): { command: 'kill'; values: Values } | undefined {
  const [first, ...rest] = args;
  if (first !== 'kill') return undefined;
  try {
    const { values } = parseArgs({
      args: [...rest],
      options: SPEC,
      strict: true,
      allowPositionals: false,
    });
    const found = values as Values;
    if (typeof found.tenant !== 'string' || typeof found.run !== 'string') return undefined;
    if (!UUID.test(found.run)) return undefined;
    return { command: 'kill', values: found };
  } catch {
    return undefined;
  }
}

/** Records the kill as the system. Returns the exit code. */
export async function runRunCommand(
  scope: TenantScope,
  _command: 'kill',
  values: Values,
  ctx: CliContext,
): Promise<number> {
  try {
    const result = await requestRunKill(
      scope,
      {},
      { runId: String(values.run), actor: { type: 'system' }, source: 'ops' },
    );
    if (values.json === true) {
      ctx.stdout(
        JSON.stringify({
          run: result.runId,
          status: result.status,
          already: result.already,
          escalation: result.escalationId ?? null,
        }),
      );
    } else {
      ctx.stdout(
        t(result.already ? 'cli.ops.run.already_killed' : 'cli.ops.run.killed', {
          run: result.runId,
          status: result.status,
          escalation: result.escalationId ?? '-',
        }),
      );
    }
    return EXIT.ok;
  } catch (error) {
    if (!(error instanceof KillError)) throw error;
    ctx.stderr(t(ERROR_KEYS[error.code]));
    return EXIT.failed;
  }
}
