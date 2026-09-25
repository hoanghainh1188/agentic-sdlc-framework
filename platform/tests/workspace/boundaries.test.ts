// D-08 A01 AC3 and ADR-M16: lint fails when a package crosses a module boundary.
//   - @sdlc/core must not import any @sdlc/adapter-*.
//   - @sdlc/adapter-* may import @sdlc/contracts only.
import path from 'node:path';
import { ESLint } from 'eslint';
import tseslint from 'typescript-eslint';
import { describe, expect, it } from 'vitest';

import { EXPECTED_PACKAGES, type PackageManifest, readJson, repoRoot } from './helpers';

const root = repoRoot();
const RULE_ID = 'sdlc-local/module-boundaries';
// The real repo config, minus type information: the probe files below do not exist on disk, so the
// TypeScript project service cannot load them. The boundary rule does not use type information.
const eslint = new ESLint({
  cwd: root,
  overrideConfig: {
    files: ['**/*.ts'],
    languageOptions: { parserOptions: { projectService: false, project: null } },
    rules: Object.fromEntries(
      Object.keys(tseslint.configs.disableTypeChecked.rules ?? {}).map((rule) => [rule, 'off']),
    ),
  },
});

/** Lints `code` with the repo config, as if it were a new file at `relativePath`. */
async function boundaryErrors(relativePath: string, code: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath: path.join(root, relativePath) });
  const messages = result?.messages ?? [];
  const fatal = messages.filter((m) => m.fatal);
  if (fatal.length > 0) throw new Error(fatal.map((m) => m.message).join('\n'));
  return messages.filter((m) => m.ruleId === RULE_ID).map((m) => m.message);
}

const CORE_FILE = 'platform/packages/core/src/boundary-probe.ts';
const DEEP_CORE_FILE = 'platform/packages/core/src/audit/deep/boundary-probe.ts';
const ADAPTER_FILE = 'platform/packages/adapters/git-github/src/boundary-probe.ts';
const APP_FILE = 'platform/apps/api/src/boundary-probe.ts';

describe('core must not import adapters (AC3)', () => {
  it.each([
    ['package import', `import '@sdlc/adapter-git-github';`],
    ['named import', `import { x } from '@sdlc/adapter-model-litellm';\nexport { x };`],
    ['sub-path import', `import '@sdlc/adapter-evidence-s3/dist/index.js';`],
    ['re-export', `export * from '@sdlc/adapter-policy-simple';`],
    ['dynamic import', `export const load = () => import('@sdlc/adapter-agent-openhands');`],
    ['type-only import', `import type { X } from '@sdlc/adapter-git-github';\nexport type Y = X;`],
    ['inline type import', `export type T = import('@sdlc/adapter-git-github').X;`],
    ['relative import', `import '../../adapters/git-github/src/index.js';`],
  ])('fails for a %s', async (_kind, code) => {
    const errors = await boundaryErrors(CORE_FILE, code);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('@sdlc/core must not import @sdlc/adapter-');
  });

  it('fails for a relative import from a nested folder', async () => {
    const errors = await boundaryErrors(
      DEEP_CORE_FILE,
      `import '../../../../adapters/model-litellm/src/index.js';`,
    );
    expect(errors).toEqual([
      expect.stringContaining('@sdlc/core must not import @sdlc/adapter-model-litellm'),
    ]);
  });

  it('fails for a relative import with different letter case (case-insensitive file systems)', async () => {
    const errors = await boundaryErrors(
      CORE_FILE,
      `import '../../Adapters/Git-Github/src/index.js';`,
    );
    expect(errors).toEqual([
      expect.stringContaining('@sdlc/core must not import @sdlc/adapter-git-github'),
    ]);
  });

  it.each([
    [
      'template literal with an expression',
      'const n = "git-github";\nexport const l = () => import(`@sdlc/adapter-${n}`);',
    ],
    ['string concatenation', `export const l = () => import('@sdlc/adapter-' + 'git-github');`],
    ['variable', `const m = '@sdlc/adapter-git-github';\nexport const l = () => import(m);`],
  ])('fails for a computed dynamic import (%s), which cannot be checked', async (_kind, code) => {
    const errors = await boundaryErrors(CORE_FILE, code);
    expect(errors).toEqual([
      expect.stringContaining('must use a static string for dynamic imports'),
    ]);
  });

  it('allows core to import contracts, config and its own files', async () => {
    const code = [
      `import '@sdlc/contracts';`,
      `import '@sdlc/config';`,
      `import './other.js';`,
      `import 'node:fs';`,
    ].join('\n');
    expect(await boundaryErrors(CORE_FILE, code)).toEqual([]);
  });

  it('control: the same adapter import is allowed in an app', async () => {
    expect(await boundaryErrors(APP_FILE, `import '@sdlc/adapter-git-github';`)).toEqual([]);
  });

  it('control: computed dynamic imports are allowed in an app (no boundary rule applies)', async () => {
    const code = `const m = 'x';\nexport const l = () => import(m);`;
    expect(await boundaryErrors(APP_FILE, code)).toEqual([]);
  });
});

describe('adapters may import @sdlc/contracts only', () => {
  it.each([
    ['core', `import '@sdlc/core';`, '@sdlc/core'],
    ['config', `import '@sdlc/config';`, '@sdlc/config'],
    ['another adapter', `import '@sdlc/adapter-model-litellm';`, '@sdlc/adapter-model-litellm'],
    ['an app', `import '@sdlc/api';`, '@sdlc/api'],
    ['core by relative path', `import '../../../core/src/index.js';`, '@sdlc/core'],
    [
      'another adapter by relative path',
      `import '../../evidence-s3/src/index.js';`,
      '@sdlc/adapter-evidence-s3',
    ],
    ['core by dynamic import', `export const l = () => import('@sdlc/core');`, '@sdlc/core'],
    ['core by require', `import m = require('@sdlc/core');\nexport { m };`, '@sdlc/core'],
  ])('fails when importing %s', async (_kind, code, target) => {
    const errors = await boundaryErrors(ADAPTER_FILE, code);
    expect(errors).toEqual([
      expect.stringContaining(
        `@sdlc/adapter-git-github may only import @sdlc/contracts; ${target}`,
      ),
    ]);
  });

  it('allows contracts, its own files and third-party packages', async () => {
    const code = [
      `import '@sdlc/contracts';`,
      `import './client.js';`,
      `import 'node:crypto';`,
    ].join('\n');
    expect(await boundaryErrors(ADAPTER_FILE, code)).toEqual([]);
  });
});

describe('package manifests respect the same boundaries', () => {
  function workspaceDeps(dir: string): string[] {
    const manifest = readJson<PackageManifest>(path.join(root, dir, 'package.json'));
    return Object.keys({
      ...manifest.dependencies,
      ...manifest.devDependencies,
      ...manifest.peerDependencies,
    }).filter((dep) => dep.startsWith('@sdlc/'));
  }

  it('core does not depend on any adapter', () => {
    expect(
      workspaceDeps('platform/packages/core').filter((d) => d.startsWith('@sdlc/adapter-')),
    ).toEqual([]);
  });

  it.each(EXPECTED_PACKAGES.filter((p) => p.name.startsWith('@sdlc/adapter-')))(
    '$name depends on no workspace package except @sdlc/contracts',
    ({ dir }) => {
      expect(workspaceDeps(dir).filter((d) => d !== '@sdlc/contracts')).toEqual([]);
    },
  );
});
