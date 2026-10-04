// The sdlc command-line tool. See design/D-03 section 5.1.
// A07 adds `sdlc audit verify`, B03 the operator commands `sdlc admin …` (database, on the
// server). B04 adds the user commands (through the API, design/ADR-M36): login, logout, whoami,
// intent, gate, escalation, ai-record. B08 adds `sdlc spec`, B09 `sdlc plan`, C11 `sdlc run`, E04 `sdlc cost`, E06 `sdlc metrics`, E02 `sdlc evidence`. B13 adds the admin commands, `sdlc token` and
// `sdlc audit verify` through the API, and moves the operator commands to `sdlc ops` (ADR-M37).
import { t } from '@sdlc/messages';

import { runAdminApi } from './commands/admin-api.js';
import { runAiRecord } from './commands/ai-record.js';
import { runAuditVerify } from './commands/audit-verify-api.js';
import { runCost } from './commands/cost.js';
import { runEscalation } from './commands/escalation.js';
import { runEvidence } from './commands/evidence.js';
import { runGate } from './commands/gate.js';
import { runIntent } from './commands/intent.js';
import { runMetrics } from './commands/metrics.js';
import { runLogin, runLogout, runWhoami } from './commands/login.js';
import { runOps } from './commands/ops.js';
import { runPlan } from './commands/plan.js';
import { runRun } from './commands/run.js';
import { runSpec } from './commands/spec.js';
import { runToken } from './commands/token.js';
import { EXIT, type CliContext } from './context.js';
import { clean } from './output.js';

export { EXIT, processApiIo, processContext, type ApiIo, type CliContext } from './context.js';

/** User commands: through the API, with the login of `sdlc login` (task B04, ADR-M36). */
const USER_COMMANDS: Readonly<
  Record<string, (args: readonly string[], ctx: CliContext) => Promise<number>>
> = {
  login: runLogin,
  logout: runLogout,
  whoami: runWhoami,
  intent: runIntent,
  gate: runGate,
  escalation: runEscalation,
  'ai-record': runAiRecord,
  spec: runSpec,
  plan: runPlan,
  run: runRun,
  cost: runCost,
  metrics: runMetrics,
  evidence: runEvidence,
  token: runToken,
  admin: runAdminApi,
};

/** Runs one `sdlc` command and returns its exit code. */
export async function runCli(argv: readonly string[], ctx: CliContext): Promise<number> {
  const [group, command, ...rest] = argv;
  const user =
    group !== undefined && Object.hasOwn(USER_COMMANDS, group) ? USER_COMMANDS[group] : undefined;
  if (user) {
    try {
      return await user(argv.slice(1), ctx);
    } catch (error) {
      ctx.stderr(
        t('cli.failed', { reason: clean(error instanceof Error ? error.message : String(error)) }),
      );
      return EXIT.error;
    }
  }
  if (group === 'audit' && command === 'verify') {
    return guardedRun(() => runAuditVerify(rest, ctx), ctx);
  }
  // Operator commands on the server (B13 PR 2: renamed from `sdlc admin`, ADR-M37 §2.8).
  if (group === 'ops') return guardedRun(() => runOps(argv.slice(1), ctx), ctx);
  ctx.stderr(t('cli.usage'));
  return EXIT.usage;
}

async function guardedRun(run: () => Promise<number>, ctx: CliContext): Promise<number> {
  try {
    return await run();
  } catch (error) {
    ctx.stderr(
      t('cli.failed', { reason: clean(error instanceof Error ? error.message : String(error)) }),
    );
    return EXIT.error;
  }
}
