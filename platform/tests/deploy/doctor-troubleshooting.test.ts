// `pnpm doctor` and the deployment guide (D-08 V07 AC4): every row of platform/deploy/README.md
// "Troubleshooting" has a check or a stated reason; every README section a fix names exists; the
// static lists of `pnpm doctor` follow docker-compose.yml, up.sh and the migrations.
import fs from 'node:fs';
import path from 'node:path';

import { catalogFor } from '@sdlc/messages';
import { describe, expect, it } from 'vitest';

import { APPROLE_FOLDERS } from '../../deploy/doctor/src/commands.js';
import { CORE_SERVICES, JOBS } from '../../deploy/doctor/src/checks/stack.js';
import { TROUBLESHOOTING } from '../../deploy/doctor/src/troubleshooting.js';
import { CHECK_IDS } from '../../deploy/doctor/src/types.js';
import { MIGRATIONS } from '../../packages/core/src/db/migrations/index.js';
import { loadCompose, readDeployFile, root } from './compose';

const readme = readDeployFile('README.md');

function troubleshootingRows(): string[] {
  const start = readme.indexOf('## Troubleshooting');
  const end = readme.indexOf('\n## ', start + 5);
  return readme
    .slice(start, end)
    .split('\n')
    .filter(
      (line) => line.startsWith('| ') && !line.startsWith('| You see') && !line.startsWith('|---'),
    )
    .map((line) => line.slice(2, line.indexOf(' | ')));
}

const headings = new Set([...readme.matchAll(/^#{2,3} (.+)$/gm)].map((m) => (m[1] ?? '').trim()));

function doctorSources(): string {
  const dir = path.join(root, 'platform/deploy/doctor/src');
  const files = (d: string): string[] =>
    fs
      .readdirSync(d, { withFileTypes: true })
      .flatMap((e) =>
        e.isDirectory()
          ? files(path.join(d, e.name))
          : e.name.endsWith('.ts')
            ? [path.join(d, e.name)]
            : [],
      );
  return files(dir)
    .map((f) => fs.readFileSync(f, 'utf8'))
    .join('\n');
}

describe('pnpm doctor covers the README troubleshooting table', () => {
  it('every row has an entry, and every entry a row', () => {
    const rows = troubleshootingRows();
    expect(rows.length).toBeGreaterThan(5);
    const keys = Object.keys(TROUBLESHOOTING);
    for (const row of rows) {
      expect(
        keys.filter((k) => row.startsWith(k)),
        `row without an entry: ${row}`,
      ).toHaveLength(1);
    }
    for (const key of keys) {
      expect(
        rows.filter((r) => r.startsWith(key)),
        `entry without a row: ${key}`,
      ).toHaveLength(1);
    }
  });

  it('each entry names known checks, or a reason in the catalog', () => {
    const catalog = catalogFor('en') as Readonly<Record<string, string>>;
    for (const coverage of Object.values(TROUBLESHOOTING)) {
      if ('checks' in coverage) {
        expect(coverage.checks.length).toBeGreaterThan(0);
        for (const id of coverage.checks) expect(CHECK_IDS).toContain(id);
      } else {
        expect(Object.hasOwn(catalog, coverage.reason)).toBe(true);
      }
    }
  });

  it('the README tells the operator to run pnpm doctor first', () => {
    const section = readme.slice(readme.indexOf('## Troubleshooting'));
    expect(section.slice(0, 400)).toMatch(/pnpm doctor/);
    expect(headings.has('Doctor (`pnpm doctor`)')).toBe(true);
  });

  it('every README section a fix names exists', () => {
    const sections = [...doctorSources().matchAll(/section: '([^']+)'/g)]
      .map((m) => m[1] ?? '')
      .filter((s) => !s.startsWith('T11') && !s.startsWith('§'));
    const readmeSections = [...doctorSources().matchAll(/readme\('([^']+)'\)/g)].map(
      (m) => m[1] ?? '',
    );
    for (const section of [...sections, ...readmeSections]) {
      expect(headings.has(section), `no README heading "${section}"`).toBe(true);
    }
  });
});

describe('the static lists of pnpm doctor', () => {
  const compose = loadCompose();
  const services = Object.entries(compose.services) as [
    string,
    { profiles?: string[]; restart?: string; volumes?: string[] },
  ][];

  it('CORE_SERVICES: the long-running services of the profile core', () => {
    const core = services
      .filter(([, s]) => s.profiles?.includes('core') && s.restart !== 'no')
      .map(([name]) => name)
      .sort();
    expect([...CORE_SERVICES].sort()).toEqual(core);
  });

  it('JOBS: the one-shot jobs, as up.sh lists them', () => {
    const jobs = services
      .filter(([, s]) => s.restart === 'no')
      .map(([name]) => name)
      .sort();
    expect([...JOBS].sort()).toEqual(jobs);
    const upJobs = /^JOBS="([^"]+)"/m.exec(readDeployFile('scripts/up.sh'))?.[1]?.split(' ').sort();
    expect([...JOBS].sort()).toEqual(upJobs);
  });

  it('APPROLE_FOLDERS: each folder is an AppRole volume of that service', () => {
    for (const f of APPROLE_FOLDERS) {
      const volumes = compose.services[f.service]?.volumes ?? [];
      expect(
        volumes.some((v) => /approle:/.test(v) && v.endsWith(`:${f.folder}`)),
        `${f.service} ${f.folder}`,
      ).toBe(true);
    }
  });

  it('the migration file names are the migrator names doctor compares', () => {
    const names = fs
      .readdirSync(path.join(root, 'platform/packages/core/src/db/migrations'))
      .map((f) => /^(\d{4}-[a-z0-9-]+)\.ts$/.exec(f)?.[1])
      .filter((n): n is string => n !== undefined)
      .sort();
    expect(names).toEqual(Object.keys(MIGRATIONS).sort());
  });
});
