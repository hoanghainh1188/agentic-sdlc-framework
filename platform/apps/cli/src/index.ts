// The sdlc command-line tool. See design/D-03 section 5.1.
// A07 adds the first command, `sdlc audit verify`. Task B04 adds login, intents and gates.
import { parseArgs } from 'node:util';

import { t } from '@sdlc/messages';

import { auditVerify } from './commands/audit-verify.js';
import { EXIT, type CliContext } from './context.js';

export { EXIT, processContext, type CliContext } from './context.js';

/** Runs one `sdlc` command and returns its exit code. */
export async function runCli(argv: readonly string[], ctx: CliContext): Promise<number> {
  const [group, command, ...rest] = argv;
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
