// Scan a run's diff for added or changed dependencies (task H02, D-08 H02 AC1, AC2,
// design/ADR-M96, ADR-M80 gaps G-1, G-5, QUESTIONS #606–#608).
//
// The changes step (`changes.ts`) calls `scanDependencies` with the staged patch outside the sandbox:
// 1. Checks if manifest or lockfiles were modified (`package.json`, `package-lock.json`,
//    `pnpm-lock.yaml`, `yarn.lock`). If none, returns clean with 0 counts.
// 2. Extracts added and modified packages by comparing HEAD vs base_sha.
// 3. Verifies each package:
//    - Allowed license (e.g. MIT, Apache-2.0, BSD-3-Clause, ISC).
//    - Install scripts (preinstall, install, postinstall or hasInstallScript) -> G-1 mitigation.
//    - Typosquatting against popular packages using Levenshtein distance.
//    - Blocked package list (advisory findings).
// 4. Returns counts and codes only (never package text, secrets or commands).
import fs from 'node:fs';
import path from 'node:path';

import { gitIn } from './proposal.js';

export const DEPENDENCY_MANIFEST_NAMES: readonly string[] = [
  'package.json',
  'package-lock.json',
  'npm-shrinkwrap.json',
  'pnpm-lock.yaml',
  'yarn.lock',
];

export const DEFAULT_ALLOWED_LICENSES = new Set([
  'MIT',
  'APACHE-2.0',
  'BSD-2-CLAUSE',
  'BSD-3-CLAUSE',
  'ISC',
  '0BSD',
  'CC0-1.0',
  'UNLICENSE',
]);

/** Curated popular packages for typosquatting checks (distance 1, or 2 for longer names). */
export const POPULAR_PACKAGES: readonly string[] = [
  'axios',
  'chalk',
  'commander',
  'cors',
  'cross-env',
  'debug',
  'dotenv',
  'eslint',
  'express',
  'fs-extra',
  'glob',
  'inquirer',
  'jest',
  'jsonwebtoken',
  'lodash',
  'minimist',
  'mkdirp',
  'mocha',
  'moment',
  'mongoose',
  'nanoid',
  'next',
  'nodemon',
  'prettier',
  'react',
  'react-dom',
  'rimraf',
  'rxjs',
  'semver',
  'supertest',
  'tailwindcss',
  'tslib',
  'typescript',
  'uuid',
  'vite',
  'vitest',
  'vue',
  'webpack',
  'winston',
  'yargs',
];

export type DependencyScanResult = 'clean' | 'warning' | 'finding' | 'failed';

export interface DependencyScan {
  readonly result: DependencyScanResult;
  readonly newDependencies: number;
  readonly changedDependencies: number;
  readonly licenseViolations: number;
  readonly installScripts: number;
  readonly typosquattingWarnings: number;
  readonly advisoryFindings: number;
  readonly cause?: string;
}

export interface DependencyScanInput {
  readonly cloneDir: string;
  readonly baseSha: string;
  readonly changedFiles: readonly string[];
  readonly gitTimeoutMs: number;
  readonly allowedLicenses?: readonly string[];
  readonly blockedPackages?: readonly string[];
}

/** Compute Levenshtein distance between two strings. */
export function levenshteinDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  let prev = new Array<number>(a.length + 1);
  let curr = new Array<number>(a.length + 1);

  for (let j = 0; j <= a.length; j++) {
    prev[j] = j;
  }

  for (let i = 1; i <= b.length; i++) {
    curr[0] = i;
    const bChar = b.charAt(i - 1);
    for (let j = 1; j <= a.length; j++) {
      const aChar = a.charAt(j - 1);
      const cost = aChar === bChar ? 0 : 1;
      const prevJ = prev[j]!;
      const currPrev = curr[j - 1]!;
      const prevPrev = prev[j - 1]!;
      curr[j] = Math.min(prevJ + 1, currPrev + 1, prevPrev + cost);
    }
    const temp = prev;
    prev = curr;
    curr = temp;
  }

  return prev[a.length]!;
}

/** Determines if `name` looks like a typosquatted version of a known popular package. */
export function isTyposquatting(
  name: string,
  popularList: readonly string[] = POPULAR_PACKAGES,
): boolean {
  const normalized = name.toLowerCase();
  for (const popular of popularList) {
    if (normalized === popular) continue;
    const dist = levenshteinDistance(normalized, popular);
    if (dist === 1) return true;
    if (dist === 2 && popular.length >= 7) return true;
  }
  return false;
}

export interface PackageEntry {
  readonly version?: string;
  readonly license?: string;
  readonly hasInstallScript?: boolean;
}

/** Reads a file from baseSha using hardened git. Returns null if file didn't exist. */
async function readBaseFile(
  cloneDir: string,
  baseSha: string,
  relPath: string,
  timeoutMs: number,
): Promise<string | null> {
  const home = path.join(cloneDir, 'home');
  try {
    const output = await gitIn(cloneDir, home, ['cat-file', 'blob', `${baseSha}:${relPath}`], {
      timeoutMs,
      maxPatchBytes: 4 * 1024 * 1024,
    });
    return output.toString('utf8');
  } catch {
    return null;
  }
}

/** Extracts package records from package.json text. */
export function parsePackageJson(content: string): {
  deps: Record<string, string>;
  scripts: Record<string, string>;
  license?: string;
} {
  try {
    const parsed = JSON.parse(content) as Record<string, unknown>;
    const deps: Record<string, string> = {};
    for (const key of [
      'dependencies',
      'devDependencies',
      'optionalDependencies',
      'peerDependencies',
    ]) {
      const section = parsed[key];
      if (typeof section === 'object' && section !== null) {
        for (const [k, v] of Object.entries(section)) {
          if (typeof v === 'string') deps[k] = v;
        }
      }
    }
    const scripts: Record<string, string> = {};
    if (typeof parsed.scripts === 'object' && parsed.scripts !== null) {
      for (const [k, v] of Object.entries(parsed.scripts)) {
        if (typeof v === 'string') scripts[k] = v;
      }
    }
    const license = typeof parsed.license === 'string' ? parsed.license : undefined;
    return { deps, scripts, license };
  } catch {
    return { deps: {}, scripts: {} };
  }
}

/** Extracts dependencies and attributes from package-lock.json (v2/v3 and v1). */
export function parsePackageLockJson(content: string): Record<string, PackageEntry> {
  const result: Record<string, PackageEntry> = {};
  try {
    const parsed = JSON.parse(content) as Record<string, unknown>;
    // v2/v3 packages map
    if (typeof parsed.packages === 'object' && parsed.packages !== null) {
      for (const [key, val] of Object.entries(parsed.packages)) {
        if (!key.startsWith('node_modules/') || typeof val !== 'object' || val === null) continue;
        const pkgName = key.replace(/^node_modules\//, '');
        const entry = val as Record<string, unknown>;
        const hasScripts =
          Boolean(entry.hasInstallScript) ||
          (typeof entry.scripts === 'object' &&
            entry.scripts !== null &&
            Boolean(
              (entry.scripts as Record<string, string>).preinstall ||
              (entry.scripts as Record<string, string>).install ||
              (entry.scripts as Record<string, string>).postinstall,
            ));
        result[pkgName] = {
          version: typeof entry.version === 'string' ? entry.version : undefined,
          license: typeof entry.license === 'string' ? entry.license : undefined,
          hasInstallScript: hasScripts,
        };
      }
    } else if (typeof parsed.dependencies === 'object' && parsed.dependencies !== null) {
      // v1 fallback
      for (const [pkgName, val] of Object.entries(parsed.dependencies)) {
        if (typeof val !== 'object' || val === null) continue;
        const entry = val as Record<string, unknown>;
        result[pkgName] = {
          version: typeof entry.version === 'string' ? entry.version : undefined,
        };
      }
    }
  } catch {
    // Return partial or empty on parse error
  }
  return result;
}

/** Scans the staged clone for dependency changes outside the sandbox (ADR-M96). */
export async function scanDependencies(input: DependencyScanInput): Promise<DependencyScan> {
  const manifestFiles = input.changedFiles.filter((file) =>
    DEPENDENCY_MANIFEST_NAMES.some((name) => file === name || file.endsWith(`/${name}`)),
  );

  // If no package manifest or lock file changed, return clean immediately.
  if (manifestFiles.length === 0) {
    return {
      result: 'clean',
      newDependencies: 0,
      changedDependencies: 0,
      licenseViolations: 0,
      installScripts: 0,
      typosquattingWarnings: 0,
      advisoryFindings: 0,
    };
  }

  const allowedLicenses = new Set(
    (input.allowedLicenses && input.allowedLicenses.length > 0
      ? input.allowedLicenses
      : Array.from(DEFAULT_ALLOWED_LICENSES)
    ).map((l) => l.toUpperCase()),
  );
  const blockedPackages = new Set((input.blockedPackages ?? []).map((p) => p.toLowerCase()));

  let newDepsCount = 0;
  let changedDepsCount = 0;
  let licenseViolationsCount = 0;
  let installScriptsCount = 0;
  let typosquattingCount = 0;
  let advisoryCount = 0;

  try {
    for (const relPath of manifestFiles) {
      const fileName = path.basename(relPath);
      const fullPath = path.join(input.cloneDir, relPath);
      let headContent: string;
      try {
        headContent = fs.readFileSync(fullPath, 'utf8');
      } catch {
        // Deleted file or read failure
        continue;
      }
      const baseContent = await readBaseFile(
        input.cloneDir,
        input.baseSha,
        relPath,
        input.gitTimeoutMs,
      );

      if (fileName === 'package.json') {
        const headPkg = parsePackageJson(headContent);
        const basePkg = baseContent ? parsePackageJson(baseContent) : { deps: {}, scripts: {} };

        for (const [pkgName, version] of Object.entries(headPkg.deps)) {
          const baseVersion = basePkg.deps[pkgName];
          if (baseVersion === undefined) {
            newDepsCount++;
            if (isTyposquatting(pkgName)) typosquattingCount++;
            if (blockedPackages.has(pkgName.toLowerCase())) advisoryCount++;
          } else if (baseVersion !== version) {
            changedDepsCount++;
          }
        }
      } else if (fileName === 'package-lock.json' || fileName === 'npm-shrinkwrap.json') {
        const headLock = parsePackageLockJson(headContent);
        const baseLock = baseContent ? parsePackageLockJson(baseContent) : {};

        for (const [pkgName, entry] of Object.entries(headLock)) {
          const baseEntry = baseLock[pkgName];
          const isNew = baseEntry === undefined;
          if (isNew) {
            newDepsCount++;
            if (isTyposquatting(pkgName)) typosquattingCount++;
            if (blockedPackages.has(pkgName.toLowerCase())) advisoryCount++;
            if (entry.hasInstallScript) installScriptsCount++;
            if (entry.license && !allowedLicenses.has(entry.license.toUpperCase())) {
              licenseViolationsCount++;
            }
          } else if (baseEntry.version !== entry.version) {
            changedDepsCount++;
            if (entry.hasInstallScript && !baseEntry.hasInstallScript) installScriptsCount++;
            if (entry.license && !allowedLicenses.has(entry.license.toUpperCase())) {
              licenseViolationsCount++;
            }
          }
        }
      } else if (fileName === 'pnpm-lock.yaml') {
        // Check for pnpm requiresBuild: true lines added in diff
        const lines = headContent.split('\n');
        for (const line of lines) {
          if (line.includes('requiresBuild: true')) {
            installScriptsCount++;
          }
        }
      }
    }

    let result: DependencyScanResult = 'clean';
    if (advisoryCount > 0) {
      result = 'finding';
    } else if (licenseViolationsCount > 0 || installScriptsCount > 0 || typosquattingCount > 0) {
      result = 'warning';
    }

    return {
      result,
      newDependencies: newDepsCount,
      changedDependencies: changedDepsCount,
      licenseViolations: licenseViolationsCount,
      installScripts: installScriptsCount,
      typosquattingWarnings: typosquattingCount,
      advisoryFindings: advisoryCount,
    };
  } catch {
    return {
      result: 'failed',
      newDependencies: 0,
      changedDependencies: 0,
      licenseViolations: 0,
      installScripts: 0,
      typosquattingWarnings: 0,
      advisoryFindings: 0,
      cause: 'parse_failed',
    };
  }
}
