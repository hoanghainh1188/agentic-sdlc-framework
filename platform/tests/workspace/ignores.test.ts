// ADR-M16: formatting and linting never touch the handbook, design docs or other documents.
import fs from 'node:fs';
import path from 'node:path';
import { ESLint } from 'eslint';
import * as prettier from 'prettier';
import { describe, expect, it } from 'vitest';

import { repoRoot } from './helpers';

const root = repoRoot();
const PROTECTED_FOLDERS = ['handbook', 'design', '_review', 'diagrams'];

function filesUnder(folder: string): string[] {
  return fs
    .readdirSync(path.join(root, folder), { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(root, path.join(entry.parentPath, entry.name)));
}

const protectedFiles = [
  ...PROTECTED_FOLDERS.flatMap(filesUnder),
  ...fs.readdirSync(root).filter((name) => name.endsWith('.md')),
];

async function prettierIgnores(file: string): Promise<boolean> {
  const info = await prettier.getFileInfo(path.join(root, file), {
    ignorePath: path.join(root, '.prettierignore'),
  });
  return info.ignored;
}

describe('documents are excluded from formatting and linting', () => {
  it('finds files to check in every protected folder', () => {
    for (const folder of PROTECTED_FOLDERS) {
      expect(protectedFiles.some((f) => f.startsWith(folder + path.sep))).toBe(true);
    }
    expect(protectedFiles).toContain('README.md');
  });

  it('Prettier ignores every file under handbook/, design/, _review/, diagrams/ and root Markdown', async () => {
    const notIgnored: string[] = [];
    for (const file of protectedFiles) {
      if (!(await prettierIgnores(file))) notIgnored.push(file);
    }
    expect(notIgnored).toEqual([]);
  });

  it('ESLint ignores the same files', async () => {
    const eslint = new ESLint({ cwd: root });
    const notIgnored: string[] = [];
    for (const file of protectedFiles) {
      if (!(await eslint.isPathIgnored(path.join(root, file)))) notIgnored.push(file);
    }
    expect(notIgnored).toEqual([]);
  });

  it('control: platform code is still formatted and linted', async () => {
    const file = 'platform/packages/core/src/index.ts';
    expect(await prettierIgnores(file)).toBe(false);
    expect(await new ESLint({ cwd: root }).isPathIgnored(path.join(root, file))).toBe(false);
  });
});
