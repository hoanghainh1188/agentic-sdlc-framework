// H02 (D-08 H02 AC1, AC2; ADR-M96 §2.2; QUESTIONS #606–#608):
// Dependency scanning outside the sandbox: license checks, install script detection,
// typosquatting detection, blocked package advisories, and lockfile parsing.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { checkRunEvent } from '../../packages/core/src/run-events/types.js';
import {
  isTyposquatting,
  levenshteinDistance,
  parsePackageJson,
  parsePackageLockJson,
  scanDependencies,
} from '../../apps/runner/src/index.js';

describe('Levenshtein distance & Typosquatting checks (H02 AC2)', () => {
  it('levenshteinDistance computes exact edit distance', () => {
    expect(levenshteinDistance('express', 'express')).toBe(0);
    expect(levenshteinDistance('', 'abc')).toBe(3);
    expect(levenshteinDistance('abc', '')).toBe(3);
    expect(levenshteinDistance('react', 'reactt')).toBe(1);
    expect(levenshteinDistance('lodash', 'lodas')).toBe(1);
    expect(levenshteinDistance('chalk', 'cholk')).toBe(1);
    expect(levenshteinDistance('kitten', 'sitting')).toBe(3);
  });

  it('isTyposquatting detects near matches against popular packages', () => {
    // Exact match is not a typosquat
    expect(isTyposquatting('lodash')).toBe(false);
    expect(isTyposquatting('express')).toBe(false);

    // Distance 1 variants are typosquats
    expect(isTyposquatting('lodas')).toBe(true);
    expect(isTyposquatting('expres')).toBe(true);
    expect(isTyposquatting('cholk')).toBe(true);
    expect(isTyposquatting('reactt')).toBe(true);

    // Completely distinct packages are not typosquats
    expect(isTyposquatting('my-custom-internal-lib')).toBe(false);
    expect(isTyposquatting('enterprise-auth-gateway')).toBe(false);
  });
});

describe('Manifest & Lockfile parsing (H02 AC1)', () => {
  it('parsePackageJson extracts dependencies and scripts', () => {
    const pkg = JSON.stringify({
      name: 'sample',
      version: '1.0.0',
      license: 'MIT',
      dependencies: { lodash: '^4.17.21' },
      devDependencies: { vitest: '^1.0.0' },
      scripts: {
        build: 'tsc',
        postinstall: 'echo malicious',
      },
    });

    const parsed = parsePackageJson(pkg);
    expect(parsed.license).toBe('MIT');
    expect(parsed.deps).toEqual({
      lodash: '^4.17.21',
      vitest: '^1.0.0',
    });
    expect(parsed.scripts.postinstall).toBe('echo malicious');
  });

  it('parsePackageJson handles malformed json gracefully', () => {
    const parsed = parsePackageJson('{ broken');
    expect(parsed.deps).toEqual({});
    expect(parsed.scripts).toEqual({});
  });

  it('parsePackageLockJson extracts package records and install scripts', () => {
    const lock = JSON.stringify({
      name: 'sample',
      lockfileVersion: 3,
      packages: {
        '': { name: 'sample' },
        'node_modules/safe-pkg': {
          version: '1.0.0',
          license: 'Apache-2.0',
        },
        'node_modules/evil-pkg': {
          version: '2.0.0',
          license: 'GPL-3.0',
          hasInstallScript: true,
        },
        'node_modules/script-pkg': {
          version: '1.2.3',
          license: 'MIT',
          scripts: {
            install: 'node build.js',
          },
        },
      },
    });

    const parsed = parsePackageLockJson(lock);
    expect(parsed['safe-pkg']).toEqual({
      version: '1.0.0',
      license: 'Apache-2.0',
      hasInstallScript: false,
    });
    expect(parsed['evil-pkg']).toEqual({
      version: '2.0.0',
      license: 'GPL-3.0',
      hasInstallScript: true,
    });
    expect(parsed['script-pkg']).toEqual({
      version: '1.2.3',
      license: 'MIT',
      hasInstallScript: true,
    });
  });
});

describe('scanDependencies (H02 AC1, AC2)', () => {
  const tmpDirs: string[] = [];

  function makeGitRepo(): { dir: string; baseSha: string } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dep-scan-test-'));
    tmpDirs.push(dir);
    execFileSync('git', ['init', '-b', 'main', dir]);
    execFileSync('git', ['-C', dir, 'config', 'user.name', 'Tester']);
    execFileSync('git', ['-C', dir, 'config', 'user.email', 'test@example.com']);
    fs.writeFileSync(path.join(dir, 'README.md'), '# initial\n');
    execFileSync('git', ['-C', dir, 'add', 'README.md']);
    execFileSync('git', ['-C', dir, 'commit', '-m', 'initial']);
    const baseSha = execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
    }).trim();
    return { dir, baseSha };
  }

  afterEach(() => {
    for (const d of tmpDirs) {
      fs.rmSync(d, { recursive: true, force: true });
    }
    tmpDirs.length = 0;
  });

  it('returns clean when no manifest files were changed', async () => {
    const { dir, baseSha } = makeGitRepo();
    const scan = await scanDependencies({
      cloneDir: dir,
      baseSha,
      changedFiles: ['src/index.ts', 'docs/readme.md'],
      gitTimeoutMs: 5000,
    });

    expect(scan).toEqual({
      result: 'clean',
      newDependencies: 0,
      changedDependencies: 0,
      licenseViolations: 0,
      installScripts: 0,
      typosquattingWarnings: 0,
      advisoryFindings: 0,
    });
  });

  it('flags typosquatting and blocked packages in package.json', async () => {
    const { dir, baseSha } = makeGitRepo();
    // Add package.json with a typosquatted package and a blocked package
    const pkg = {
      name: 'test-app',
      dependencies: {
        cholk: '^1.0.0', // typosquat of chalk
        'evil-miner': '^0.1.0', // in blocked list
      },
    };
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg, null, 2));

    const scan = await scanDependencies({
      cloneDir: dir,
      baseSha,
      changedFiles: ['package.json'],
      gitTimeoutMs: 5000,
      blockedPackages: ['evil-miner'],
    });

    expect(scan.newDependencies).toBe(2);
    expect(scan.typosquattingWarnings).toBe(1);
    expect(scan.advisoryFindings).toBe(1);
    expect(scan.result).toBe('finding'); // advisory findings escalate to 'finding'
  });

  it('flags unapproved license and install scripts in package-lock.json', async () => {
    const { dir, baseSha } = makeGitRepo();
    const lock = {
      name: 'test-app',
      lockfileVersion: 3,
      packages: {
        '': { name: 'test-app' },
        'node_modules/gpl-lib': {
          version: '1.0.0',
          license: 'GPL-3.0',
        },
        'node_modules/postinstall-lib': {
          version: '2.0.0',
          license: 'MIT',
          hasInstallScript: true,
        },
      },
    };
    fs.writeFileSync(path.join(dir, 'package-lock.json'), JSON.stringify(lock, null, 2));

    const scan = await scanDependencies({
      cloneDir: dir,
      baseSha,
      changedFiles: ['package-lock.json'],
      gitTimeoutMs: 5000,
      allowedLicenses: ['MIT', 'Apache-2.0'],
    });

    expect(scan.newDependencies).toBe(2);
    expect(scan.licenseViolations).toBe(1);
    expect(scan.installScripts).toBe(1);
    expect(scan.result).toBe('warning'); // warning triggers HITL at G6
  });

  it('flags install script in pnpm-lock.yaml (requiresBuild)', async () => {
    const { dir, baseSha } = makeGitRepo();
    const pnpmContent = `
lockfileVersion: '6.0'
dependencies:
  pkg-with-build:
    specifier: ^1.0.0
    version: 1.0.0
packages:
  /pkg-with-build@1.0.0:
    resolution: {integrity: sha512-xxx}
    requiresBuild: true
    dev: false
`;
    fs.writeFileSync(path.join(dir, 'pnpm-lock.yaml'), pnpmContent);

    const scan = await scanDependencies({
      cloneDir: dir,
      baseSha,
      changedFiles: ['pnpm-lock.yaml'],
      gitTimeoutMs: 5000,
    });

    expect(scan.installScripts).toBe(1);
    expect(scan.result).toBe('warning');
  });

  it('validates dependencies_scanned event format via checkRunEvent', () => {
    const payload = {
      result: 'warning' as const,
      new_dependencies: 2,
      changed_dependencies: 1,
      license_violations: 1,
      install_scripts: 1,
      typosquatting_warnings: 0,
      advisory_findings: 0,
    };

    expect(checkRunEvent('dependencies_scanned', payload)).toEqual(payload);
    // Undeclared fields (e.g. package names, paths) must be rejected
    expect(() =>
      checkRunEvent('dependencies_scanned', {
        ...payload,
        package_name: 'malicious-package',
      }),
    ).toThrow(/undeclared/);
  });
});
