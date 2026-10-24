// D-08 O02 AC2: the README section "Upgrade" and the live test `pnpm test:upgrade` stay in step.
// - the README's numbered steps are the live test's `step('…')` calls, in the same order;
// - every `pnpm <script>` and `openbao:bootstrap <command>` the section names exists;
// - the commands of each step are the ones the live test runs;
// - every release's Upgrade notes can be read by the live test (upgrade-notes.ts): a first bullet
//   for every running stack, naming only bootstrap commands that exist.
import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { repoRoot } from '../workspace/helpers.js';
import {
  bootstrapCommands,
  releaseSections,
  requiredBootstrapCommands,
  sectionsBetween,
  upgradeBullets,
} from './upgrade-notes.js';

const root = repoRoot();
const read = (file: string) => fs.readFileSync(path.join(root, file), 'utf8');
const readme = read('platform/deploy/README.md');
const start = readme.indexOf('## Upgrade\n');
const section = readme.slice(start, readme.indexOf('\n## ', start + 1));
const liveTest = read('platform/tests/integration/deploy/upgrade.test.ts');
const steps = read('platform/tests/integration/deploy/deploy-steps.ts');
const changelog = read('CHANGELOG.md');
const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
const bootstrap = read('platform/deploy/openbao/bootstrap.sh');
const bootstrapNames = [...bootstrap.matchAll(/^ {2}([a-z-]+)\) cmd_/gm)].map((m) => m[1]!);

/** The README's steps: `N. **Name.** …`, in order. */
const readmeSteps = [...section.matchAll(/^(\d+)\. \*\*([^*]+?)\.\*\*/gm)].map((m) => ({
  n: Number(m[1]),
  name: m[2]!,
  text: '',
}));
for (const [i, s] of readmeSteps.entries()) {
  const from = section.search(new RegExp(`^${s.n}\\. \\*\\*`, 'm'));
  const next = readmeSteps[i + 1];
  const to = next ? section.search(new RegExp(`^${next.n}\\. \\*\\*`, 'm')) : section.length;
  s.text = section.slice(from, to);
}
const stepText = (name: string) => readmeSteps.find((s) => s.name === name)?.text ?? '';

describe('O02 AC2: README "Upgrade" and the live test', () => {
  it('has ten numbered steps, the live test takes the same ones in the same order', () => {
    expect(start).toBeGreaterThan(0);
    expect(readmeSteps.map((s) => s.n)).toEqual(Array.from({ length: 10 }, (_, i) => i + 1));
    const live = [...liveTest.matchAll(/\bstep\('([^']+)'\)/g)].map((m) => m[1]);
    expect(live).toEqual(readmeSteps.map((s) => s.name));
  });

  it('names only pnpm scripts and bootstrap commands that exist', () => {
    const scripts = [...section.matchAll(/\bpnpm ([a-z][\w:-]*)/g)]
      .map((m) => m[1]!)
      .filter((name) => !['install', 'build'].includes(name));
    expect(scripts.length).toBeGreaterThan(8);
    for (const name of scripts) expect(Object.keys(pkg.scripts), name).toContain(name);
    const named = [...section.matchAll(/pnpm openbao:bootstrap ([a-z][a-z-]*)/g)].map((m) => m[1]!);
    expect(named).toContain('root-token');
    for (const name of named) expect(bootstrapNames, name).toContain(name);
  });

  it('each step names the commands the live test runs', () => {
    const pairs: [step: string, readme: string, live: string][] = [
      ['Backup', 'pnpm backup', 'backup/backup.sh'],
      ['The new release', 'pnpm install && pnpm build', "['install', '--frozen-lockfile']"],
      ['New settings', 'pnpm compose:env --add-missing', "'--add-missing'"],
      ['The images', 'pnpm images get SANDBOX_NODE24', 'imagesMode()'],
      ['The images', '--profile sandbox pull', "['pull', 'build']"],
      ['The images', '--profile sandbox build', "['pull', 'build']"],
      ['Stop', 'pnpm compose:down', "'compose:down'"],
      ['Unseal', 'Restart after a reboot', 'current.unseal()'],
      ['Migrations', 'pnpm db:migrate', 'current.migrate()'],
      ['Credentials', 'pnpm openbao:bootstrap root-token', 'current.newRootToken()'],
      ['Credentials', 'first bullet of the Upgrade notes', 'requiredBootstrapCommands('],
      ['Start', 'up.sh core models platform sandbox', 'current.up()'],
      ['Check', '/health/ready', '/health/ready'],
      ['Check', '_missing', "endsWith('_missing')"],
      ['Check', 'pnpm sdlc ops audit verify', "['ops', 'audit', 'verify']"],
      ['Check', 'pnpm sdlc intent show', "'gate', 'approve', 'G1'"],
    ];
    for (const [name, inReadme, inLive] of pairs) {
      expect(stepText(name), `${name}: ${inReadme}`).toContain(inReadme);
      expect(liveTest, `${name}: ${inLive}`).toContain(inLive);
    }
    // `up.sh` and the stores of step 6 are the fresh deployment's (deploy-steps.ts).
    expect(steps).toContain("'scripts/up.sh'");
    expect(steps.replace(/\s+/g, '')).toContain("'openbao','postgres','seaweedfs'");
  });

  it('step 5 stops the profiles of `pnpm compose:down`, which keeps the volumes', () => {
    const down = pkg.scripts['compose:down']!;
    expect(down).not.toMatch(/\s-v\b|--volumes/);
    const profiles = [...down.matchAll(/--profile (\S+)/g)].map((m) => m[1]!);
    const live = /const DOWN_PROFILES = \[([\s\S]*?)\] as const/.exec(liveTest)?.[1] ?? '';
    const named = [...live.matchAll(/'([a-z-]+)'/g)].map((m) => m[1]!);
    expect(['core', 'models', 'platform', 'sandbox', ...named].sort()).toEqual(
      [...profiles].sort(),
    );
  });

  it('`pnpm compose:env --add-missing` and `pnpm test:upgrade` exist (the CI job: ci-workflow.test.ts)', () => {
    expect(pkg.scripts['compose:env']).toBe('platform/deploy/scripts/init-env.sh');
    expect(read('platform/deploy/scripts/init-env.sh')).toContain('--add-missing');
    expect(pkg.scripts['test:upgrade']).toContain('SDLC_UPGRADE_TEST=1');
    expect(pkg.scripts['test:upgrade']).toContain(
      'platform/tests/integration/deploy/upgrade.test.ts',
    );
  });
});

describe('O02: the CHANGELOG Upgrade notes the live test reads', () => {
  const sections = releaseSections(changelog);

  it('every release from 0.1.1 on has a first bullet for every running stack', () => {
    const released = sections.filter((s) => s.version !== 'Unreleased' && s.version !== '0.1.0');
    expect(released.length).toBeGreaterThan(5);
    for (const s of released) {
      const first = upgradeBullets(s.body)[0] ?? '';
      expect(first, s.version).toMatch(/on a running stack|^No migration|nothing to do/i);
    }
  });

  it('a first bullet names only bootstrap commands that exist', () => {
    for (const s of sections) {
      for (const name of bootstrapCommands(upgradeBullets(s.body)[0] ?? '')) {
        expect(bootstrapNames, `${s.version}: ${name}`).toContain(name);
      }
    }
  });

  it('v0.5.0 → v0.6.0 runs `configure` again, and only it; HEAD adds [Unreleased] last', () => {
    expect(sectionsBetween(changelog, 'v0.5.0', 'v0.6.0').map((s) => s.version)).toEqual(['0.6.0']);
    expect(requiredBootstrapCommands(sectionsBetween(changelog, 'v0.5.0', 'v0.6.0'))).toEqual([
      'configure',
    ]);
    const head = sectionsBetween(changelog, 'v0.4.0', 'HEAD').map((s) => s.version);
    expect(head.slice(0, 2)).toEqual(['0.5.0', '0.6.0']);
    expect(head.at(-1)).toBe('Unreleased');
  });
});
