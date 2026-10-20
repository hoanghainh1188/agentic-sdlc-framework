// D-08 W01 AC4 (ADR-M84 §2.4, R133 in design/RULES.md): the rules of CLAUDE.md live in the root
// file or in a folder's CLAUDE.md. Every rule bullet ends with its IDs (`[R043]`), and
// design/RULES.md names the file of each ID. A rule that is lost, copied or moved without the
// register fails here; the root file stays under its word budget (QUESTIONS #425).
import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { repoRoot } from './helpers';

const root = repoRoot();
const read = (file: string) => fs.readFileSync(path.join(root, file), 'utf8');

/** The root budget: about 40 % less than before the split (4,790 words). */
const ROOT_WORD_BUDGET = 3000;

function claudeFiles(dir = ''): string[] {
  return fs.readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap((entry) => {
    const rel = path.join(dir, entry.name).split(path.sep).join('/');
    if (entry.isDirectory()) {
      const skip = ['node_modules', 'dist', '.git', '_review'].includes(entry.name);
      return skip ? [] : claudeFiles(rel);
    }
    return entry.name === 'CLAUDE.md' ? [rel] : [];
  });
}

/** ID → file, from the "File" column of design/RULES.md (one file per base ID). */
function registerFiles(): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of read('design/RULES.md').split('\n')) {
    const m = /^\| (R\d{3})[a-z,–-]*\b.*\| ([^|]*CLAUDE\.md) \|$/.exec(line);
    if (!m) continue;
    const [, id, file] = m;
    const known = map.get(id!);
    if (known !== undefined && known !== file!.trim()) {
      throw new Error(`${id} is in two files in design/RULES.md`);
    }
    map.set(id!, file!.trim());
  }
  return map;
}

/** ID → the files whose bullets carry the tag. */
function tags(files: string[]): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const file of files) {
    for (const m of read(file).matchAll(/\[((?:R\d{3} ?)+)\]\s*$/gm)) {
      for (const id of m[1]!.trim().split(' ')) found.set(id, [...(found.get(id) ?? []), file]);
    }
  }
  return found;
}

describe('W01: the rules of every CLAUDE.md (R133)', () => {
  const files = claudeFiles();
  const register = registerFiles();
  const found = tags(files);

  it('finds the register and the CLAUDE.md files', () => {
    expect(register.size).toBeGreaterThan(80);
    expect(files).toContain('CLAUDE.md');
  });

  it('tags every rule of the register once, in the file the register names', () => {
    const wrong = [...register].filter(([id, file]) => {
      const where = found.get(id) ?? [];
      return where.length !== 1 || where[0] !== file;
    });
    expect(
      wrong.map(
        ([id, file]) => `${id}: register ${file}, found ${JSON.stringify(found.get(id) ?? [])}`,
      ),
    ).toEqual([]);
  });

  it('has no tag that the register does not know', () => {
    expect([...found.keys()].filter((id) => !register.has(id))).toEqual([]);
  });

  it('lists every folder CLAUDE.md in the root index, and every listed file exists', () => {
    const rootText = read('CLAUDE.md');
    const index = rootText.slice(rootText.indexOf('## Rules in other folders'));
    const listed = [...index.matchAll(/^- `([^`]+\/CLAUDE\.md)`/gm)].map((m) => m[1]!);
    expect(listed.sort()).toEqual(files.filter((f) => f !== 'CLAUDE.md').sort());
  });

  it(`keeps the root CLAUDE.md under ${ROOT_WORD_BUDGET} words`, () => {
    const words = read('CLAUDE.md').split(/\s+/).filter(Boolean).length;
    expect(words).toBeLessThanOrEqual(ROOT_WORD_BUDGET);
  });
});
