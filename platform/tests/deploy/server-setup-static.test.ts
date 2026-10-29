// D-08 V16 AC1, AC5, AC6: `pnpm server:setup` follows platform/deploy/README.md "Fresh deployment"
// steps 2–7 and shares its step code with `trial:up` and `test:fresh-deploy` (R081):
// - its steps come in the README's order, each with a catalog message and a README section;
// - the three use the shared module `platform/deploy/steps`;
// - nothing but the terminal module writes to the screen; children's output only through redact;
// - `configure --issue-admin-token` makes the admin token before it revokes the root token;
// - the script, the hook (R035), the README and runbook T11 use it.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { README_SECTIONS } from '../../deploy/server-setup/src/setup.js';
import { CREDENTIALS_COMMANDS } from '../../deploy/steps/dist/fresh-deployment.js';
import { repoRoot } from '../workspace/helpers.js';

const root = repoRoot();
const read = (file: string) => fs.readFileSync(path.join(root, file), 'utf8');
const readme = read('platform/deploy/README.md');
const start = readme.indexOf('## Fresh deployment (operator)');
const section = readme.slice(start, readme.indexOf('\n## ', start + 1));
const setupSource = read('platform/deploy/server-setup/src/setup.ts');
const catalog = JSON.parse(read('platform/packages/messages/src/locales/en.json')) as Record<
  string,
  string
>;
const SOURCES = ['main.ts', 'setup.ts', 'settings.ts', 'progress.ts', 'terminal.ts'].map(
  (f) => `platform/deploy/server-setup/src/${f}`,
);
const STEP_SOURCES = ['exec.ts', 'env-file.ts', 'fresh-deployment.ts', 'secrets.ts'].map(
  (f) => `platform/deploy/steps/src/${f}`,
);

/** GitHub's anchor of a Markdown heading. */
const anchor = (heading: string) =>
  `#${heading
    .toLowerCase()
    .replace(/[^a-z0-9 -]/g, '')
    .replace(/ /g, '-')}`;

describe('V16 AC1: pnpm server:setup follows the README "Fresh deployment" steps 2–7', () => {
  it('takes the steps 2 to 7 in order, each with a catalog message', () => {
    const steps = [...setupSource.matchAll(/begin\('(\d)'\)/g)].map((m) => Number(m[1]));
    expect(steps).toEqual([2, 3, 4, 5, 6, 7]);
    for (const n of steps) expect(catalog[`server_setup.step.${n}`], `step ${n}`).toBeTruthy();
  });

  it('names the README section of each step, and each section exists', () => {
    const headings = [...section.matchAll(/^### (\d+\. .+)$/gm)].map((m) => anchor(m[1]!));
    for (const [n, a] of Object.entries(README_SECTIONS)) {
      expect(headings, `step ${n}`).toContain(a);
      expect(a.startsWith(`#${n}-`)).toBe(true);
    }
  });

  it('the README commands of each step come in the README order', () => {
    const markers = [
      'scripts/init-env.sh',
      'd.startStores()',
      'd.initOpenBao(',
      'd.unseal(',
      'configureWith(rootToken)',
      'd.storeGithubApp(',
      'd.storeLitellmKeys(',
      'CREDENTIALS_COMMANDS)',
      'd.migrate(',
      'd.up(profiles)',
      'doctor/dist/main.js',
    ];
    const at = markers.map((m) => setupSource.indexOf(m));
    for (const [i, m] of markers.entries()) expect(at[i], m).toBeGreaterThan(0);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
  });

  it('step 5 is the README list; step 7 runs the optional credentials commands of the README', () => {
    const from = section.indexOf('### 5. ');
    const five = section.slice(from, section.indexOf('### 6. ', from));
    expect([...CREDENTIALS_COMMANDS]).toEqual(
      [...five.matchAll(/pnpm openbao:bootstrap ([a-z-]+-credentials)/g)].map((m) => m[1]),
    );
    const seven = section.slice(section.indexOf('### 7. '), section.indexOf('### 8. '));
    for (const m of seven.matchAll(/pnpm openbao:bootstrap ([a-z-]+-credentials)/g))
      expect(setupSource, m[1]).toContain(`'${m[1]}'`);
  });

  it('server:setup, trial:up and test:fresh-deploy share the step module (R081)', () => {
    expect(setupSource).toContain("from '../../steps/dist/fresh-deployment.js'");
    expect(read('platform/deploy/trial/src/up.ts')).toContain(
      "from '../../steps/dist/fresh-deployment.js'",
    );
    const live = read('platform/tests/integration/deploy/fresh-deploy.test.ts');
    expect(live).toContain('deploy/server-setup/src/setup');
    expect(live).toContain('serverSetup(');
  });
});

describe('V16 AC2, AC3: nothing secret reaches the screen, a file or a command line', () => {
  it('only the terminal module writes to the screen; no child output is inherited', () => {
    for (const file of [...SOURCES, ...STEP_SOURCES]) {
      const src = read(file);
      expect(src, file).not.toMatch(/console\./);
      expect(src, file).not.toMatch(/stdio:\s*'inherit'|'inherit'/);
      if (!file.endsWith('terminal.ts') && !file.endsWith('main.ts'))
        expect(src, file).not.toMatch(/process\.std(out|err)\.write/);
    }
    expect(setupSource).toContain('bag.redact(');
  });

  it('never reads a secret from the environment or the arguments', () => {
    for (const file of SOURCES) {
      const src = read(file);
      expect(src, file).not.toMatch(/process\.env\.[A-Z_]*(TOKEN|SHARE|KEY|SECRET|PASS)/);
    }
    // One option only: the settings file.
    expect(read('platform/deploy/server-setup/src/main.ts')).toMatch(
      /options: \{ settings: \{ type: 'string' \} \}/,
    );
  });

  it('every message key it uses is in the catalog', () => {
    for (const file of SOURCES) {
      for (const m of read(file).matchAll(/'(server_setup\.[a-z0-9_.]+)'/g))
        expect(catalog[m[1]!], `${file}: ${m[1]}`).toBeTruthy();
    }
  });

  it('configure makes the admin token before it revokes the root token', () => {
    const configure = read('platform/deploy/openbao/bootstrap/configure.sh');
    const create = configure.indexOf('bao token create -role=platform-admin -field=token');
    const revoke = configure.lastIndexOf('bao token revoke -self');
    expect(create).toBeGreaterThan(0);
    expect(revoke).toBeGreaterThan(create);
    expect(configure).toContain('--keep-token and --issue-admin-token exclude each other');
  });

  it('bootstrap.sh refuses --issue-admin-token on a terminal and for any other command', () => {
    const bootstrap = read('platform/deploy/openbao/bootstrap.sh');
    expect(bootstrap).toMatch(/\[ ! -t 1 \] \|\|\s*fail "--issue-admin-token prints a token/);
    const missing = path.join(os.tmpdir(), `sdlc-no-env-${process.pid}`);
    const r = spawnSync(
      path.join(root, 'platform/deploy/openbao/bootstrap.sh'),
      ['init', '--issue-admin-token'],
      {
        encoding: 'utf8',
        env: { PATH: process.env.PATH ?? '', SDLC_ENV_FILE: missing },
      },
    );
    expect(r.stderr).toContain('unknown option');
  });

  it('migrate-cli takes the URL on stdin, so no child environment holds it', () => {
    expect(read('platform/packages/core/src/db/migrate-cli.ts')).toContain("'--url-stdin'");
    expect(read('platform/deploy/steps/src/fresh-deployment.ts')).toContain("'--url-stdin'");
  });
});

describe('V16: the script, the hook and the documents', () => {
  const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };

  it('pnpm server:setup exists', () => {
    expect(pkg.scripts['server:setup']).toContain('platform/deploy/server-setup/dist/main.js');
  });

  it('the README, runbook T11, the deploy CLAUDE.md and the ignore file name it', () => {
    expect(section).toContain('pnpm server:setup --settings');
    const t11 = read('handbook/03-templates/T11-openbao-runbook.md');
    expect(t11).toContain('pnpm server:setup');
    expect(read('platform/deploy/CLAUDE.md')).toContain('server:setup');
    expect(read('.gitignore')).toContain('server-setup-progress.json');
  });
});
