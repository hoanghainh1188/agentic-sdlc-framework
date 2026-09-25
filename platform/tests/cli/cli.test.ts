// `sdlc` command line: argument handling without a database. The audit check itself runs against
// PostgreSQL in tests/integration/db/audit-log.test.ts.
import { t } from '@sdlc/messages';
import { describe, expect, it } from 'vitest';

import { EXIT, runCli, type CliContext } from '../../apps/cli/src/index.js';

function context(env: Record<string, string> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const ctx: CliContext = {
    env,
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
    connect: () => {
      throw new Error('no database in unit tests');
    },
  };
  return { ctx, out, err };
}

describe('sdlc', () => {
  it.each([
    [[]],
    [['audit']],
    [['intent', 'create']],
    [['audit', 'verify', '--bogus']],
    [['audit', 'verify', 'extra']],
  ])('prints the usage and exits 2 for %j', async (argv) => {
    const { ctx, err } = context({ SDLC_DB_URL: 'postgres://x' });
    expect(await runCli(argv, ctx)).toBe(EXIT.usage);
    expect(err).toEqual([t('cli.usage')]);
  });

  it('audit verify needs SDLC_DB_URL', async () => {
    const { ctx, err } = context();
    expect(await runCli(['audit', 'verify'], ctx)).toBe(EXIT.usage);
    expect(err).toEqual([t('audit.verify.missing_url')]);
  });

  it('reports an unexpected error with exit code 3', async () => {
    const { ctx, err } = context({ SDLC_DB_URL: 'postgres://x' });
    expect(await runCli(['audit', 'verify'], ctx)).toBe(EXIT.error);
    expect(err).toEqual([t('cli.failed', { reason: 'no database in unit tests' })]);
  });
});
