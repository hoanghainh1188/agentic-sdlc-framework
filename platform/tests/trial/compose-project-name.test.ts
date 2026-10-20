// D-08 W01 AC3 (R081c, R080c in design/RULES.md):
// - the trial's children never inherit the shell's COMPOSE_PROJECT_NAME (ADR-M76): Compose
//   would prefer it to the project of the env file;
// - `doctor` takes `--env`, never `--env-file`: Node.js reads `--env-file` itself.
import fs from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { exec } from '../../deploy/trial/src/host.js';
import { repoRoot } from '../workspace/helpers';

describe('W01: the trial does not pass on COMPOSE_PROJECT_NAME (R081c)', () => {
  const before = process.env.COMPOSE_PROJECT_NAME;
  afterEach(() => {
    if (before === undefined) delete process.env.COMPOSE_PROJECT_NAME;
    else process.env.COMPOSE_PROJECT_NAME = before;
  });

  it('runs a child without the shell value', async () => {
    process.env.COMPOSE_PROJECT_NAME = 'from-the-shell';
    const result = await exec('sh', ['-c', 'printf %s "${COMPOSE_PROJECT_NAME-unset}"']);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('unset');
  });
});

describe('W01: doctor takes --env, never --env-file (R080c)', () => {
  it('declares only --env and --json, in strict mode', () => {
    const main = fs.readFileSync(
      path.join(repoRoot(), 'platform/deploy/doctor/src/main.ts'),
      'utf8',
    );
    expect(main).toMatch(/options:\s*\{\s*env:\s*\{\s*type:\s*'string'\s*\},\s*json:/);
    expect(main).toMatch(/strict:\s*true/);
    expect(main).not.toMatch(/['"]env-file['"]\s*:/);
  });
});
