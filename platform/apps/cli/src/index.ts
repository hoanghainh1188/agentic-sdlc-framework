// The sdlc command-line tool. See design/D-03 section 5.1.
// A07 adds `sdlc audit verify`, B03 the operator commands `sdlc admin …`. Task B04 adds login,
// intents and gates (through the API).
import { parseArgs } from 'node:util';

import { t } from '@sdlc/messages';

import { runAdmin } from './commands/admin.js';
import { auditVerify } from './commands/audit-verify.js';
import { EXIT, type CliContext } from './context.js';

export { EXIT, processContext, type CliContext } from './context.js';

/** Runs one `sdlc` command and returns its exit code. */
export async function runCli(argv: readonly string[], ctx: CliContext): Promise<number> {
  const [group, command, ...rest] = argv;
  if (group === 'admin') {
    try {
      return await runAdmin(argv.slice(1), ctx);
    } catch (error) {
      ctx.stderr(
        t('cli.failed', { reason: error instanceof Error ? error.message : String(error) }),
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
        t('cli.failed', { reason: error instanceof Error ? error.message : String(error) }),
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
