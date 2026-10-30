// ADR-M104 §2.3: `pnpm release:prepare X.Y.Z` makes the version pull request mechanical. The
// Upgrade notes are written by each pull request under [Unreleased]; the script refuses without
// them. It sets the versions, turns [Unreleased] into the dated section, moves the release's
// version in the README, TRIAL and USER-GUIDE, marks the given tasks done, and runs the gate.
// Here on a copy of the files in a temporary folder.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { repoRoot } from './helpers';

const root = repoRoot();
const SCRIPT = path.join(root, 'platform/tools/release/prepare.mjs');
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const UNRELEASED_WITH_NOTES = `### Upgrade notes
- **On a running stack:** (1) \`pnpm install\`; (2) \`pnpm db:migrate\`: migration \`0047-x\`.
- The command: \`npm install -g @hoanghainh/governed-adlc@0.12.0\`.

### Added
- A thing.
`;

function fixture(unreleased: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-prepare-'));
  dirs.push(dir);
  const put = (file: string, text: string) => {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), text);
  };
  put('package.json', `${JSON.stringify({ name: 'x', version: '0.11.0' }, null, 2)}\n`);
  put(
    'platform/packages/api-schemas/src/version.ts',
    "// The version.\nexport const PLATFORM_VERSION = '0.11.0';\n",
  );
  put(
    'CHANGELOG.md',
    `# Changelog\n\n## [Unreleased]\n\n${unreleased}\n## [0.11.0] - 2026-10-31\n\n### Upgrade notes\n- No migration, no changed setting, no credentials command to run again.\n`,
  );
  put(
    'README.md',
    '[![Release](https://img.shields.io/badge/release-v0.11.0-blue.svg)](CHANGELOG.md)\n\n**Status (2026-10-31): v0.11.0 is released ([CHANGELOG](CHANGELOG.md)); built.**\n\n```bash\ngit checkout v0.11.0\n```\n\n| Area | Supported today (v0.11.0) |\n',
  );
  put(
    'TRIAL.md',
    '> **Status (2026-10-31):** the latest release is **v0.11.0** ([CHANGELOG](CHANGELOG.md)).\n\n1. Check out the latest release (`git checkout v0.11.0`; the CHANGELOG).\n',
  );
  put(
    'platform/USER-GUIDE.md',
    'install it: `@hoanghainh/governed-adlc@<version>`, for example `@0.11.0`.\n',
  );
  put(
    'scripts/generate-backlog.py',
    'DONE={**{t:"v0.10.0" for t in ("O03",)},\n      **{t:"v0.11.0" for t in ("O04","O05")}}\n',
  );
  return dir;
}

const run = (dir: string, ...args: string[]) =>
  spawnSync('node', [SCRIPT, ...args, '--root', dir, '--date', '2026-11-05', '--no-generate'], {
    encoding: 'utf8',
  });
const read = (dir: string, file: string) => fs.readFileSync(path.join(dir, file), 'utf8');
const versionOf = (dir: string) =>
  (JSON.parse(read(dir, 'package.json')) as { version: string }).version;

describe('pnpm release:prepare (ADR-M104 §2.3)', () => {
  it('prepares every file of the version pull request, then the gate accepts it', () => {
    const dir = fixture(UNRELEASED_WITH_NOTES);
    const r = run(
      dir,
      '0.12.0',
      '--tasks',
      'H03a,H07',
      '--summary',
      'Client data deletion, part 1.',
    );
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(versionOf(dir)).toBe('0.12.0');
    expect(read(dir, 'platform/packages/api-schemas/src/version.ts')).toContain(
      "PLATFORM_VERSION = '0.12.0'",
    );
    const changelog = read(dir, 'CHANGELOG.md');
    expect(changelog).toMatch(
      /^## \[Unreleased\]\n\n## \[0\.12\.0\] - 2026-11-05\n\n\*\*Client data deletion, part 1\.\*\*\n\n### Upgrade notes\n- \*\*On a running stack:\*\*/m,
    );
    expect(changelog).toContain('## [0.11.0] - 2026-10-31');
    const readme = read(dir, 'README.md');
    expect(readme).toContain('release-v0.12.0-blue');
    expect(readme).toContain('**Status (2026-11-05): v0.12.0 is released');
    expect(readme).toContain('git checkout v0.12.0');
    expect(readme).toContain('Supported today (v0.12.0)');
    expect(readme).not.toContain('0.11.0');
    const trial = read(dir, 'TRIAL.md');
    expect(trial).toContain('**Status (2026-11-05):** the latest release is **v0.12.0**');
    expect(trial).toContain('`git checkout v0.12.0`');
    expect(read(dir, 'platform/USER-GUIDE.md')).toContain('for example `@0.12.0`');
    expect(read(dir, 'scripts/generate-backlog.py')).toContain(
      '**{t:"v0.12.0" for t in ("H03a","H07")}}',
    );
    expect(r.stdout).toContain('release-check: v0.12.0 ok');
    expect(r.stdout).toContain('CLAUDE.md');
  });

  it('refuses without Upgrade notes under [Unreleased], and changes nothing', () => {
    const dir = fixture('### Added\n- A thing.\n');
    const before = read(dir, 'CHANGELOG.md');
    const r = run(dir, '0.12.0');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('Upgrade notes');
    expect(read(dir, 'CHANGELOG.md')).toBe(before);
    expect(versionOf(dir)).toBe('0.11.0');
  });

  it('runs the backlog generator when tasks are given, and works without an older section', () => {
    const dir = fixture(UNRELEASED_WITH_NOTES);
    const changelog = read(dir, 'CHANGELOG.md');
    fs.writeFileSync(
      path.join(dir, 'CHANGELOG.md'),
      changelog.slice(0, changelog.indexOf('## [0.11.0]')),
    );
    const r = spawnSync(
      'node',
      [SCRIPT, '0.12.0', '--tasks', 'H03a', '--root', dir, '--date', '2026-11-05'],
      { encoding: 'utf8' },
    );
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(read(dir, 'scripts/generate-backlog.py')).toContain('for t in ("H03a",)}}');
    expect(read(dir, 'CHANGELOG.md')).toMatch(/## \[0\.12\.0\] - 2026-11-05\n\n### Upgrade notes/);
  });

  it('refuses a summary of several lines or with *, and unknown task IDs', () => {
    for (const args of [
      ['--summary', 'one\ntwo'],
      ['--summary', '**bold**'],
      ['--tasks', 'not a task'],
    ]) {
      const dir = fixture(UNRELEASED_WITH_NOTES);
      expect(run(dir, '0.12.0', ...args).status, args.join(' ')).toBe(2);
      expect(versionOf(dir)).toBe('0.11.0');
    }
  });

  it('refuses a version that is not X.Y.Z or not above the current one', () => {
    for (const bad of ['0.11.0', '0.10.9', 'v0.12.0', '0.12']) {
      const dir = fixture(UNRELEASED_WITH_NOTES);
      const r = run(dir, bad);
      expect(r.status, bad).toBe(2);
    }
  });
});
