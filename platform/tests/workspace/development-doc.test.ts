// QUESTIONS #424, #425: platform/DEVELOPMENT.md holds the test map that CLAUDE.md used to hold.
// - every `test` and `test:*` script of the root package.json has an entry there;
// - the document names no `pnpm test:*` script that does not exist (a renamed or removed script).
import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { repoRoot } from './helpers';

const root = repoRoot();
const doc = fs.readFileSync(path.join(root, 'platform/DEVELOPMENT.md'), 'utf8');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as {
  scripts: Record<string, string>;
};
const testScripts = Object.keys(pkg.scripts).filter(
  (name) => name === 'test' || name.startsWith('test:'),
);

describe('platform/DEVELOPMENT.md', () => {
  it('has test scripts to check', () => {
    expect(testScripts.length).toBeGreaterThan(10);
  });

  it.each(testScripts)('has an entry for `pnpm %s`', (name) => {
    expect(doc).toContain(`\`pnpm ${name}\``);
  });

  it('names only test scripts that exist', () => {
    const named = new Set([...doc.matchAll(/pnpm (test:[a-z0-9-]+)/g)].map((m) => m[1] ?? ''));
    const missing = [...named].filter((name) => !(name in pkg.scripts));
    expect(missing).toEqual([]);
  });
});
