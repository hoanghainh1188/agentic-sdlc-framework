// D-08 E07 AC3: the README section "Fresh deployment (operator)" cannot drift from the code.
// - every `pnpm <script>` it names exists in package.json;
// - every `openbao:bootstrap <command>` it names exists in bootstrap.sh, and it names every
//   credentials command of bootstrap.sh;
// - every `sdlc …` command and option it names is in the CLI's usage texts (message catalog);
// - the live test `pnpm test:fresh-deploy` runs every credentials command the README names.
import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { repoRoot } from '../workspace/helpers.js';

const root = repoRoot();
const readme = fs.readFileSync(path.join(root, 'platform/deploy/README.md'), 'utf8');
const start = readme.indexOf('## Fresh deployment (operator)');
const section = readme.slice(start, readme.indexOf('\n## ', start + 1));
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as {
  scripts: Record<string, string>;
};
const bootstrap = fs.readFileSync(path.join(root, 'platform/deploy/openbao/bootstrap.sh'), 'utf8');
const catalog = fs.readFileSync(
  path.join(root, 'platform/packages/messages/src/locales/en.json'),
  'utf8',
);
const liveTest = fs.readFileSync(
  path.join(root, 'platform/tests/integration/deploy/fresh-deploy.test.ts'),
  'utf8',
);

/** The command lines of the code blocks of `text` (default: the section), `\` lines joined. */
function commandLines(text = section): string[] {
  const blocks = [...text.matchAll(/```bash\n([\s\S]*?)```/g)].map((m) => m[1]!);
  return blocks
    .join('\n')
    .replace(/\\\n\s*/g, ' ')
    .split('\n')
    .map((line) => line.replace(/\s+#.*$/, '').trim())
    .filter((line) => line !== '');
}

const bootstrapCommands = [...bootstrap.matchAll(/^ {2}([a-z-]+)\) cmd_/gm)].map((m) => m[1]!);

describe('E07: README "Fresh deployment (operator)"', () => {
  it('exists, with the fourteen steps in order', () => {
    expect(start).toBeGreaterThan(0);
    const steps = [...section.matchAll(/^### (\d+)\. /gm)].map((m) => Number(m[1]));
    expect(steps).toEqual(Array.from({ length: 14 }, (_, i) => i + 1));
  });

  it('names only pnpm scripts that exist', () => {
    const scripts = commandLines()
      .flatMap((line) => [...line.matchAll(/\bpnpm ([a-z][\w:-]*)/g)].map((m) => m[1]!))
      .filter((name) => !['install', 'build', 'exec'].includes(name));
    expect(scripts.length).toBeGreaterThan(10);
    for (const name of scripts) expect(Object.keys(pkg.scripts), name).toContain(name);
  });

  it('names only bootstrap commands that exist, and every credentials command', () => {
    const named = commandLines()
      .map((line) => /pnpm openbao:bootstrap ([a-z-]+)/.exec(line)?.[1])
      .filter((name): name is string => name !== undefined);
    for (const name of named) expect(bootstrapCommands, name).toContain(name);
    const credentials = bootstrapCommands.filter((c) => c.endsWith('-credentials'));
    expect(credentials.length).toBeGreaterThanOrEqual(9);
    expect(named.filter((n) => n.endsWith('-credentials')).sort()).toEqual([...credentials].sort());
  });

  it('names only sdlc commands and options that the CLI documents', () => {
    const lines = commandLines().filter((line) => /\bpnpm sdlc /.test(line));
    expect(lines.length).toBeGreaterThan(10);
    for (const line of lines) {
      const words = line.replace(/^.*?\bpnpm sdlc /, '').split(/\s+/);
      const command = words.filter((w) => /^[a-z][a-z-]*$/.test(w)).slice(0, 3);
      // The longest documented prefix ("sdlc admin agent approve", "sdlc intent show", …).
      const documented = [3, 2, 1].some((n) =>
        catalog.includes(`sdlc ${command.slice(0, n).join(' ')}`),
      );
      expect(documented, line).toBe(true);
      for (const option of words.filter((w) => w.startsWith('--'))) {
        expect(catalog, `${line}: ${option}`).toContain(option);
      }
    }
  });

  it('step 3 starts only OpenBao, PostgreSQL and SeaweedFS, like the live test (the whole core needs step 7)', () => {
    const step3 = section.slice(section.indexOf('### 3.'), section.indexOf('### 4.'));
    expect(step3).toContain('--profile core up -d --wait openbao postgres seaweedfs');
    expect(step3).not.toContain('pnpm compose:core');
    expect(liveTest).toContain("'up', '-d', '--wait', 'openbao', 'postgres', 'seaweedfs'");
  });

  it('the live test runs every credentials command of step 5 (step 7 adds the optional Langfuse one)', () => {
    const named = commandLines(section.slice(section.indexOf('### 5.'), section.indexOf('### 6.')))
      .map((line) => /pnpm openbao:bootstrap ([a-z-]+-credentials)/.exec(line)?.[1])
      .filter((name): name is string => name !== undefined);
    for (const name of named) expect(liveTest, name).toContain(`'${name}'`);
    expect(pkg.scripts['test:fresh-deploy']).toContain('SDLC_FRESH_DEPLOY_TEST=1');
  });
});
