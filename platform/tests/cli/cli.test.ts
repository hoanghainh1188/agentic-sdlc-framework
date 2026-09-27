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

  it.each([
    [['admin']],
    [['admin', 'nothing']],
    [['admin', 'token']],
    [['admin', 'bootstrap', '--tenant', 'x']],
    [['admin', 'token', 'issue', '--tenant', 'x', '--email', 'a@b.c']],
    [['admin', 'token', 'revoke', '--tenant', 'x', '--id', 'y', '--bogus']],
    [
      [
        'admin',
        'token',
        'issue',
        '--tenant',
        'x',
        '--email',
        'a@b.c',
        '--name',
        'n',
        '--days',
        'ten',
      ],
    ],
  ])('admin: prints the admin usage and exits 2 for %j', async (argv) => {
    const { ctx, err } = context({ SDLC_DB_URL: 'postgres://x' });
    expect(await runCli(argv, ctx)).toBe(EXIT.usage);
    expect(err).toEqual([t('cli.admin.usage')]);
  });

  const REG = [
    'admin',
    'agent',
    'register',
    '--tenant',
    'x',
    '--key',
    'coder',
    '--version',
    '1',
    '--owner',
    'a@b.c',
    '--instructions',
    'AGENTS.md@v1',
    '--max-autonomy',
    'L2',
  ];

  it.each([
    [['admin', 'agent']],
    [['admin', 'agent', 'nothing']],
    [['admin', 'agent', 'activate', '--tenant', 'x']],
    [['admin', 'agent', 'suspend', '--tenant', 'x', '--key', 'coder']],
    [['admin', 'agent', 'list', '--tenant', 'x', '--bogus']],
    // register needs exactly one source of the instructions hash
    [REG],
    [[...REG, '--instructions-sha256', 'a'.repeat(64), '--instructions-file', 'AGENTS.md']],
    [
      [
        'admin',
        'agent',
        'update',
        '--tenant',
        'x',
        '--key',
        'coder',
        '--version',
        '2',
        '--instructions-sha256',
        'a'.repeat(64),
        '--instructions-file',
        'AGENTS.md',
      ],
    ],
  ])('admin agent (C10): prints the agent usage and exits 2 for %j', async (argv) => {
    const { ctx, err } = context({ SDLC_DB_URL: 'postgres://x' });
    expect(await runCli(argv, ctx)).toBe(EXIT.usage);
    expect(err).toEqual([t('cli.admin.agent.usage')]);
  });

  it('admin agent needs SDLC_DB_URL', async () => {
    const { ctx, err } = context();
    expect(await runCli(['admin', 'agent', 'list', '--tenant', 'x'], ctx)).toBe(EXIT.usage);
    expect(err).toEqual([t('cli.admin.missing_url')]);
  });

  it('admin needs SDLC_DB_URL', async () => {
    const { ctx, err } = context();
    expect(await runCli(['admin', 'token', 'list', '--tenant', 'x', '--email', 'a@b.c'], ctx)).toBe(
      EXIT.usage,
    );
    expect(err).toEqual([t('cli.admin.missing_url')]);
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
