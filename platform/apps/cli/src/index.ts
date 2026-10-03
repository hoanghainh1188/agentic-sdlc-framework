// The sdlc command-line tool. See design/D-03 section 5.1.
// A07 adds `sdlc audit verify`, B03 the operator commands `sdlc admin …` (database, on the
// server). B04 adds the user commands (through the API, design/ADR-M36): login, logout, whoami,
// intent, gate, escalation, ai-record.
import { parseArgs } from 'node:util';

import { t } from '@sdlc/messages';

import { runAdmin } from './commands/admin.js';
import { runAiRecord } from './commands/ai-record.js';
import { auditVerify } from './commands/audit-verify.js';
import { runEscalation } from './commands/escalation.js';
import { runGate } from './commands/gate.js';
import { runIntent } from './commands/intent.js';
import { runLogin, runLogout, runWhoami } from './commands/login.js';
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
  if (group === 'admin') {
    try {
      return await runAdmin(argv.slice(1), ctx);
    } catch (error) {
      ctx.stderr(
        t('cli.failed', { reason: clean(error instanceof Error ? error.message : String(error)) }),
      );
      return EXIT.error;
    }
  }
  if (group === 'audit' && command === 'verify') {
    const parsed = parseOptions(rest);
    if (!parsed) {
      ctx.stderr(t('cli.usage'));
      return EXIT.usage;
    }
    try {
      return await auditVerify(parsed, ctx);
    } catch (error) {
      ctx.stderr(
        t('cli.failed', { reason: clean(error instanceof Error ? error.message : String(error)) }),
      );
      return EXIT.error;
    }
  }
  ctx.stderr(t('cli.usage'));
  return EXIT.usage;
}

function parseOptions(args: string[]): { tenant?: string; json: boolean } | undefined {
  try {
    const { values } = parseArgs({
      args,
      options: { tenant: { type: 'string' }, json: { type: 'boolean', default: false } },
      strict: true,
      allowPositionals: false,
    });
    return { json: values.json, ...(values.tenant === undefined ? {} : { tenant: values.tenant }) };
  } catch {
    return undefined;
  }
}
