// `sdlc --version` (task V05): the platform version, the same in a checkout and in the npm package.
import fs from 'node:fs';
import path from 'node:path';

import { t } from '@sdlc/messages';
import { describe, expect, it } from 'vitest';

import { EXIT, runCli, type CliContext } from '../../apps/cli/src/index.js';
import { PLATFORM_VERSION } from '../../apps/cli/src/version.js';
import { repoRoot } from '../workspace/helpers';

function context() {
  const out: string[] = [];
  const err: string[] = [];
  const ctx: CliContext = {
    env: {},
    stdout: (line) => out.push(line),
    stderr: (line) => err.push(line),
    connect: () => {
      throw new Error('no database in unit tests');
    },
  };
  return { ctx, out, err };
}

describe('sdlc --version', () => {
  it.each(['--version', '-V'])('%s prints the platform version and exits 0', async (flag) => {
    const { ctx, out, err } = context();
    expect(await runCli([flag], ctx)).toBe(EXIT.ok);
    expect(out).toEqual([PLATFORM_VERSION]);
    expect(err).toEqual([]);
  });

  it('refuses extra arguments with the usage text', async () => {
    const { ctx, out, err } = context();
    expect(await runCli(['--version', 'extra'], ctx)).toBe(EXIT.usage);
    expect(out).toEqual([]);
    expect(err).toEqual([t('cli.usage')]);
  });

  it('cli.usage names it', () => {
    expect(t('cli.usage')).toMatch(/^ {2}sdlc --version /m);
  });

  it('equals the version of the root package.json', () => {
    const root = JSON.parse(fs.readFileSync(path.join(repoRoot(), 'package.json'), 'utf8')) as {
      version: string;
    };
    expect(PLATFORM_VERSION).toBe(root.version);
  });
});
