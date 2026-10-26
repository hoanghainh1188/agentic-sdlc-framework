// H05 (D-08 H05 AC1, AC3; ADR-M95 §2.2; QUESTIONS #456, #601–#603): the size of a run's change a
// person must review, measured by the runner outside the sandbox. Files and lines (added plus
// removed) from the staged diff; lock files and the files the base commit's `.gitattributes` marks
// `linguist-generated` are counted apart; the run event holds counts only, never a path.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { checkRunEvent } from '../../packages/core/src/run-events/types.js';
import {
  countReviewSize,
  diffMeasuredPayload,
  isLockFile,
  measureReviewSize,
  parseCheckAttr,
  parseNumstat,
  type ReviewSize,
} from '../../apps/runner/src/index.js';

describe('parsing git output', () => {
  it('parseNumstat: counts per path, `-` for a binary file, null when malformed', () => {
    expect(parseNumstat('3\t1\tsrc/a.ts\0-\t-\timg/logo.png\x000\t7\twith\ttab.txt\0')).toEqual([
      { path: 'src/a.ts', added: 3, removed: 1 },
      { path: 'img/logo.png', added: null, removed: null },
      { path: 'with\ttab.txt', added: 0, removed: 7 },
    ]);
    expect(parseNumstat('')).toEqual([]);
    expect(parseNumstat('3\tsrc/a.ts\0')).toBeNull();
    expect(parseNumstat('x\t1\tsrc/a.ts\0')).toBeNull();
    expect(parseNumstat('1\t1\t\0')).toBeNull();
  });

  it('parseCheckAttr: the paths whose attribute is set or true; null when malformed', () => {
    const out =
      [
        'gen/a.ts',
        'linguist-generated',
        'set',
        'gen/b.ts',
        'linguist-generated',
        'true',
        'src/c.ts',
        'linguist-generated',
        'unspecified',
        'gen/d.ts',
        'linguist-generated',
        'unset',
        'gen/e.ts',
        'linguist-generated',
        'false',
      ].join('\0') + '\0';
    expect([...parseCheckAttr(out)!]).toEqual(['gen/a.ts', 'gen/b.ts']);
    expect(parseCheckAttr('a\0linguist-generated\0')).toBeNull();
  });

  it('lock files by file name, at any depth', () => {
    for (const file of ['pnpm-lock.yaml', 'apps/web/package-lock.json', 'go.sum', 'x/Cargo.lock']) {
      expect(isLockFile(file), file).toBe(true);
    }
    for (const file of ['src/lock.ts', 'pnpm-lock.yaml.bak', 'docs/yarn.lock.md']) {
      expect(isLockFile(file), file).toBe(false);
    }
  });
});

describe('countReviewSize', () => {
  it('counts added plus removed lines; generated and lock files apart; a binary file is one file', () => {
    const size = countReviewSize(
      [
        { path: 'src/a.ts', added: 10, removed: 5 },
        { path: 'src/logo.png', added: null, removed: null },
        { path: 'pnpm-lock.yaml', added: 900, removed: 100 },
        { path: 'gen/client.ts', added: 3000, removed: 0 },
      ],
      new Set(['gen/client.ts']),
    );
    expect(size).toEqual({
      result: 'measured',
      reviewFiles: 2,
      reviewLines: 15,
      generatedFiles: 2,
      generatedLines: 4000,
      binaryFiles: 1,
    });
  });
});

describe('the run event diff_measured (counts only)', () => {
  it('holds the counts of a measurement, the cause of a failure; never a path', () => {
    const measured: ReviewSize = {
      result: 'measured',
      reviewFiles: 41,
      reviewLines: 1500,
      generatedFiles: 1,
      generatedLines: 20,
      binaryFiles: 0,
    };
    expect(checkRunEvent('diff_measured', diffMeasuredPayload(measured))).toEqual({
      result: 'measured',
      review_files: 41,
      review_lines: 1500,
      generated_files: 1,
      generated_lines: 20,
      binary_files: 0,
    });
    const failed = diffMeasuredPayload({ ...measured, result: 'failed', cause: 'numstat_failed' });
    expect(checkRunEvent('diff_measured', failed)).toEqual({
      result: 'failed',
      cause: 'numstat_failed',
    });
    expect(() =>
      checkRunEvent('diff_measured', { result: 'measured', path: 'src/a.ts' }),
    ).toThrow();
  });
});

// A real clone and staged change, as `computeRunPatch` leaves it.
const GIT_ENV = {
  PATH: process.env.PATH,
  HOME: os.tmpdir(),
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_AUTHOR_NAME: 'Fixture',
  GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
  GIT_COMMITTER_NAME: 'Fixture',
  GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
};
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const lines = (n: number, prefix = 'line') =>
  Array.from({ length: n }, (_, i) => `${prefix} ${String(i)}`).join('\n') + '\n';

/** A clone with `base` committed, then `change` written on top and staged. */
function fixture(
  base: Record<string, string | Buffer>,
  change: Record<string, string | Buffer | null>,
) {
  const cloneDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-h05-'));
  dirs.push(cloneDir);
  const repo = path.join(cloneDir, 'repo');
  fs.mkdirSync(path.join(cloneDir, 'home'));
  fs.mkdirSync(repo);
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: repo, env: GIT_ENV, encoding: 'buffer' });
  const write = (files: Record<string, string | Buffer | null>) => {
    for (const [file, content] of Object.entries(files)) {
      const target = path.join(repo, file);
      if (content === null) fs.rmSync(target);
      else {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, content);
      }
    }
  };
  git('init', '-q', '-b', 'main');
  write({ 'README.md': 'fixture\n', ...base });
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  const baseSha = git('rev-parse', 'HEAD').toString('utf8').trim();
  write(change);
  git('add', '-A', '-f', '--', '.');
  return { cloneDir, baseSha, repo };
}

const measure = (f: { cloneDir: string; baseSha: string }) =>
  measureReviewSize({
    cloneDir: f.cloneDir,
    baseSha: f.baseSha,
    timeoutMs: 10_000,
    maxOutputBytes: 16 * 1024 * 1024,
  });

describe('measureReviewSize on a real clone (AC1, AC3)', () => {
  it('AC3: a change at the limits (40 files, 1500 lines) and one over', async () => {
    const files = (n: number, each: number) =>
      Object.fromEntries(
        Array.from({ length: n }, (_, i) => [`src/f${String(i)}.ts`, lines(each)]),
      );
    // 40 files, 1500 added lines in all.
    const at = { ...files(39, 38), 'src/last.ts': lines(1500 - 39 * 38) };
    expect(await measure(fixture({}, at))).toMatchObject({
      result: 'measured',
      reviewFiles: 40,
      reviewLines: 1500,
    });
    expect(await measure(fixture({}, { ...at, 'src/one-more.ts': 'x\n' }))).toMatchObject({
      reviewFiles: 41,
      reviewLines: 1501,
    });
  });

  it('counts removed lines and a deleted file; a binary file is one file, no lines', async () => {
    const f = fixture(
      { 'src/old.ts': lines(10), 'src/gone.ts': lines(4) },
      {
        'src/old.ts': lines(3),
        'src/gone.ts': null,
        'img/logo.png': Buffer.from([0, 1, 2, 0, 255]),
      },
    );
    expect(await measure(f)).toEqual({
      result: 'measured',
      reviewFiles: 3,
      reviewLines: 7 + 4,
      generatedFiles: 0,
      generatedLines: 0,
      binaryFiles: 1,
    });
  });

  it('lock files and the base commit’s linguist-generated files are counted apart', async () => {
    const f = fixture(
      {
        '.gitattributes': 'gen/** linguist-generated\n',
        'pkg/.gitattributes': 'api.ts linguist-generated=true\n',
      },
      {
        'src/a.ts': lines(5),
        'gen/client.ts': lines(3000),
        'pkg/api.ts': lines(200),
        'pnpm-lock.yaml': lines(800),
      },
    );
    expect(await measure(f)).toEqual({
      result: 'measured',
      reviewFiles: 1,
      reviewLines: 5,
      generatedFiles: 3,
      generatedLines: 4000,
      binaryFiles: 0,
    });
  });

  it('a .gitattributes the agent adds or changes is never read: its files still count', async () => {
    const f = fixture(
      { '.gitattributes': '*.md text\n' },
      {
        '.gitattributes': '* linguist-generated\n',
        'src/a.ts': lines(5),
        'src/b/.gitattributes': '* linguist-generated\n',
      },
    );
    // `.gitattributes` (1 line removed, 1 added), `src/b/.gitattributes` (1) and `src/a.ts` (5).
    expect(await measure(f)).toMatchObject({ reviewFiles: 3, reviewLines: 8, generatedFiles: 0 });
    // The temporary index of the base commit is removed.
    expect(fs.existsSync(path.join(f.cloneDir, 'review-size.index'))).toBe(false);
  });

  it('the index of the run is not changed: the staged change stays as it was', async () => {
    const f = fixture(
      { '.gitattributes': 'gen/** linguist-generated\n' },
      { 'src/a.ts': lines(2) },
    );
    const staged = () =>
      execFileSync('git', ['diff', '--cached', '--name-only', f.baseSha], {
        cwd: f.repo,
        env: GIT_ENV,
        encoding: 'utf8',
      });
    const before = staged();
    await measure(f);
    expect(staged()).toBe(before);
  });

  it('fails closed, never throws: an unknown base commit', async () => {
    const f = fixture({}, { 'src/a.ts': lines(2) });
    expect(await measure({ ...f, baseSha: 'f'.repeat(40) })).toMatchObject({
      result: 'failed',
      cause: 'numstat_failed',
    });
  });
});
