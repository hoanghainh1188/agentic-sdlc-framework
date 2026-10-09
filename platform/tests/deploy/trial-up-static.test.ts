// D-08 V02 AC5: `pnpm trial:up` follows platform/deploy/README.md "Fresh deployment (operator)"
// and cannot drift from it, nor from the live test `fresh-deploy.test.ts` that runs the same steps:
// - it runs every credentials command of README step 5, in that order;
// - its steps come in the README's order, each with a catalog message;
// - the bootstrap's switch for throw-away keys is refused with NODE_ENV=production;
// - the scripts, the CI job and TRIAL.md use it.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { CREDENTIALS_COMMANDS, PROFILES } from '../../deploy/trial/src/up.js';
import { repoRoot } from '../workspace/helpers.js';

const root = repoRoot();
const read = (file: string) => fs.readFileSync(path.join(root, file), 'utf8');
const readme = read('platform/deploy/README.md');
const start = readme.indexOf('## Fresh deployment (operator)');
const section = readme.slice(start, readme.indexOf('\n## ', start + 1));
const upSource = read('platform/deploy/trial/src/up.ts');
const catalog = JSON.parse(read('platform/packages/messages/src/locales/en.json')) as Record<
  string,
  string
>;

/** The `pnpm openbao:bootstrap <x>-credentials` lines of one README step, in order. */
function credentialsOfStep(n: number): string[] {
  const from = section.indexOf(`### ${n}. `);
  const to = section.indexOf(`### ${n + 1}. `, from);
  return [...section.slice(from, to).matchAll(/pnpm openbao:bootstrap ([a-z-]+-credentials)/g)].map(
    (m) => m[1]!,
  );
}

describe('V02: pnpm trial:up follows the README "Fresh deployment"', () => {
  it('runs every credentials command of step 5, in the README order', () => {
    expect([...CREDENTIALS_COMMANDS]).toEqual(credentialsOfStep(5));
    // The live test of the README runs the same list.
    const live = read('platform/tests/integration/deploy/fresh-deploy.test.ts');
    for (const c of CREDENTIALS_COMMANDS) expect(live).toContain(`'${c}'`);
  });

  it('starts every profile of step 7 except observability (optional on a small machine)', () => {
    expect([...PROFILES]).toEqual(['core', 'models', 'platform', 'sandbox']);
    // The only credentials command it leaves out needs the profile observability.
    expect(credentialsOfStep(7)).toEqual(['worker-langfuse-credentials']);
  });

  it('takes the steps 2 to 13 in order, each with a catalog message', () => {
    const steps = [...upSource.matchAll(/step\('(\d+)'\)/g)].map((m) => Number(m[1]));
    expect(steps).toEqual(Array.from({ length: 12 }, (_, i) => i + 2));
    for (const n of steps) expect(catalog[`trial.step.${n}`], `trial.step.${n}`).toBeTruthy();
    // The README's commands of each step, in the README's order.
    const markers = [
      'scripts/init-env.sh',
      "'init', '--stdout-not-tty'",
      "['unseal']",
      "['configure', '--keep-token']",
      'shared/github-app',
      'CREDENTIALS_COMMANDS)',
      'migrate-cli.js',
      'scripts/up.sh',
      "'--tenant-name'",
      'settings.forkRepo',
      "'person_b'",
      'sandbox-images/build.sh',
      "'--instructions-file'",
      'trialProjectConfig(image)',
      "'--disclosure'",
    ];
    const at = markers.map((m) => upSource.indexOf(m));
    for (const [i, m] of markers.entries()) expect(at[i], m).toBeGreaterThan(0);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
  });

  it('never prints a secret: no console call, child output only through redact', () => {
    for (const file of ['up.ts', 'host.ts', 'main.ts', 'down.ts']) {
      const src = read(`platform/deploy/trial/src/${file}`);
      expect(src, file).not.toMatch(/console\./);
      expect(src, file).not.toMatch(/stdio:\s*'inherit'|inherit'\]/);
    }
    // A step's output reaches the terminal only through the bag's redaction.
    expect(upSource).toContain('bag.redact(');
    expect(upSource).toMatch(/bag\.drop\(rootToken\)/);
  });
});

describe('V02: the bootstrap switch for throw-away keys', () => {
  const bootstrap = path.join(root, 'platform/deploy/openbao/bootstrap.sh');
  const missingEnv = path.join(os.tmpdir(), `sdlc-no-env-${process.pid}`);
  const run = (env: Record<string, string>) =>
    spawnSync(bootstrap, ['init', '--stdout-not-tty'], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '', SDLC_ENV_FILE: missingEnv, ...env },
    });

  it('is an unknown option without a switch, and with NODE_ENV=production', () => {
    expect(run({}).stderr).toContain('unknown option');
    expect(run({ SDLC_OPENBAO_THROWAWAY: '1', NODE_ENV: 'production' }).stderr).toContain(
      'unknown option',
    );
  });

  it('is refused on an env file that is not a trial stack, and for other commands', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-bootstrap-'));
    try {
      const dev = path.join(dir, 'dev.env');
      fs.writeFileSync(dev, 'COMPOSE_PROJECT_NAME=sdlc\n');
      expect(run({ SDLC_OPENBAO_THROWAWAY: '1', SDLC_ENV_FILE: dev }).stderr).toContain(
        'trial stack only',
      );
      const trial = path.join(dir, 'trial.env');
      fs.writeFileSync(trial, 'COMPOSE_PROJECT_NAME=sdlc-trial\n');
      const other = spawnSync(bootstrap, ['root-token', '--stdout-not-tty'], {
        encoding: 'utf8',
        env: { PATH: process.env.PATH ?? '', SDLC_ENV_FILE: trial, SDLC_OPENBAO_THROWAWAY: '1' },
      });
      expect(other.stderr).toContain('unknown option');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('is accepted for the trial (the run then stops at the missing env file)', () => {
    const r = run({ SDLC_OPENBAO_THROWAWAY: '1' });
    expect(r.stderr).not.toContain('unknown option');
    expect(r.stderr).toContain('not found');
  });
});

describe('V02: scripts, CI and the trial guide', () => {
  const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };

  it('pnpm trial:up, trial:down and test:trial-up exist', () => {
    expect(pkg.scripts['trial:up']).toContain('platform/deploy/trial/dist/main.js up');
    expect(pkg.scripts['trial:down']).toContain('platform/deploy/trial/dist/main.js down');
    expect(pkg.scripts['test:trial-up']).toContain('trial-up.test.ts');
  });

  it('the CI job trial-up runs the live test, with the trigger of fresh-deploy', () => {
    const ci = read('.github/workflows/ci.yml');
    const from = ci.indexOf('\n  trial-up:');
    const job = ci.slice(from, ci.indexOf('\n  db:', from));
    expect(job).toContain('- run: pnpm test:trial-up');
    expect(job).toContain("if: needs.scan.outputs.run_fresh_deploy == 'true'");
  });

  it('TRIAL.md section 3.2 uses it', () => {
    const trial = read('TRIAL.md');
    const s32 = trial.slice(trial.indexOf('### 3.2.'), trial.indexOf('## 4.'));
    expect(s32).toContain('pnpm trial:up --settings');
    expect(s32).toContain('trial-settings.example.yaml');
  });
});
