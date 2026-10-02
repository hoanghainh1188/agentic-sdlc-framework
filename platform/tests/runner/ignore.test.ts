// C06 session 2b, Harry's review of PR #112: realistic workspaces. The archive is streamed; paths
// the ignore rules of `base_sha` ignore (read from the runner's own clone) are read past, never
// kept; a `.gitignore` or `.gitattributes` the agent adds hides nothing from the proposal.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  computeProposal,
  IgnoreChecker,
  mirrorWorkspace,
  neutraliseAttributes,
  packTar,
  untarWorkspace,
  type TarEntry,
} from '../../apps/runner/src/index.js';

const LIMITS = { maxBytes: 1024 * 1024, maxEntries: 1000 };

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-ignore-'));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], {
    cwd,
    env: { PATH: process.env.PATH, HOME: tmp, GIT_CONFIG_NOSYSTEM: '1' },
  }).toString();

/** Splits a buffer into chunks of changing sizes, as a socket delivers it. */
function* chunks(buffer: Buffer): Generator<Buffer> {
  let at = 0;
  let size = 1;
  while (at < buffer.length) {
    yield buffer.subarray(at, at + size);
    at += size;
    size = (size * 7 + 3) % 1500 || 1;
  }
}

const workspace = (entries: TarEntry[]) =>
  packTar([
    { type: 'dir', path: 'workspace' },
    ...entries.map((e) => ({ ...e, path: `workspace/${e.path}` })),
  ]);

describe('untarWorkspace streams the archive', () => {
  const archive = workspace([
    { type: 'dir', path: 'src' },
    { type: 'file', path: 'src/a.ts', content: Buffer.from('a'.repeat(3000)) },
    { type: 'dir', path: 'node_modules' },
    { type: 'dir', path: 'node_modules/big' },
    { type: 'file', path: 'node_modules/big/index.js', content: Buffer.alloc(900_000, 0x62) },
    { type: 'file', path: 'debug.log', content: Buffer.alloc(900_000, 0x63) },
  ]);

  it('reads the same entries from any chunking', async () => {
    const whole = await untarWorkspace(archive, 'workspace', { ...LIMITS, maxBytes: 4_000_000 });
    const streamed = await untarWorkspace(chunks(archive), 'workspace', {
      ...LIMITS,
      maxBytes: 4_000_000,
    });
    expect(streamed).toEqual(whole);
    expect(streamed.map((e) => e.path)).toContain('node_modules/big/index.js');
  });

  it('reads past skipped entries: they never count against the kept size', async () => {
    const entries = await untarWorkspace(
      chunks(archive),
      'workspace',
      { ...LIMITS, maxBytes: 10_000, maxStreamBytes: 4_000_000 },
      (p, type) =>
        type === 'dir' && p === 'node_modules' ? 'skip_tree' : p.endsWith('.log') ? 'skip' : 'keep',
    );
    expect(entries.map((e) => e.path)).toEqual(['src', 'src/a.ts']);
    const file = entries[1] as { content: Buffer };
    expect(file.content.toString()).toBe('a'.repeat(3000));
  });

  it('caps the bytes streamed, skipped entries included', async () => {
    await expect(
      untarWorkspace(chunks(archive), 'workspace', { ...LIMITS, maxStreamBytes: 100_000 }, () =>
        Promise.resolve('skip' as const),
      ),
    ).rejects.toMatchObject({ key: 'runner.workspace.too_large' });
  });

  it('never asks the filter about .git', async () => {
    const asked: string[] = [];
    await untarWorkspace(
      workspace([
        { type: 'dir', path: '.git' },
        { type: 'file', path: '.git/config', content: Buffer.from('x') },
        { type: 'file', path: 'a', content: Buffer.from('x') },
      ]),
      'workspace',
      LIMITS,
      (p) => {
        asked.push(p);
        return 'keep';
      },
    );
    expect(asked).toEqual(['a']);
  });
});

describe('IgnoreChecker and the proposal on a real repository', () => {
  /** base_sha: rules for node_modules, logs (keep.log re-included), vendor/ with a tracked file. */
  function baseRepo(): { repo: string; home: string; base: string } {
    const repo = path.join(tmp, 'repo');
    const home = path.join(tmp, 'home');
    fs.mkdirSync(path.join(repo, 'vendor'), { recursive: true });
    fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
    fs.mkdirSync(home);
    fs.writeFileSync(path.join(repo, '.gitignore'), 'node_modules/\n*.log\n!keep.log\nvendor/\n');
    fs.writeFileSync(path.join(repo, 'vendor', 't.txt'), 'tracked\n');
    fs.writeFileSync(path.join(repo, 'src', 'a.ts'), 'export const a = 1;\n');
    fs.mkdirSync(path.join(repo, 'real'));
    fs.writeFileSync(path.join(repo, 'real', 'r.txt'), 'r\n');
    fs.symlinkSync('real', path.join(repo, 'lnk'));
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'add', '-A');
    git(repo, 'add', '-f', 'vendor/t.txt');
    git(repo, 'commit', '-q', '-m', 'base');
    return { repo, home, base: git(repo, 'rev-parse', 'HEAD').trim() };
  }

  it('answers as git does at base_sha: tracked paths and negated patterns are kept', async () => {
    const { repo, home } = baseRepo();
    const checker = await IgnoreChecker.start(repo, home, 30_000);
    try {
      const decide = (p: string, type: 'dir' | 'file') => checker.filter(p, type);
      expect(await decide('node_modules', 'dir')).toBe('skip_tree');
      expect(await decide('apps/web/node_modules', 'dir')).toBe('skip_tree');
      expect(await decide('src', 'dir')).toBe('keep');
      expect(await decide('debug.log', 'file')).toBe('skip');
      expect(await decide('keep.log', 'file')).toBe('keep');
      // vendor/ is ignored, but holds a tracked file: never skipped as a whole.
      expect(await decide('vendor', 'dir')).toBe('keep');
      expect(await decide('vendor/t.txt', 'file')).toBe('keep');
      expect(await decide('vendor/new.txt', 'file')).toBe('skip');
      // Beyond a tracked link: kept without asking (git refuses such paths).
      expect(await decide('lnk/x.txt', 'file')).toBe('keep');
      expect(await decide(':(glob)*', 'file')).toBe('keep');
    } finally {
      checker.close();
    }
  });

  it('a .gitignore or .gitattributes from the agent hides nothing; ignored paths stay out', async () => {
    const { repo, home, base } = baseRepo();
    // The sandbox after `pnpm install` and the agent's work.
    const archive = workspace([
      { type: 'file', path: '.gitignore', content: Buffer.from('secret.txt\n*.ts\n') },
      { type: 'file', path: '.gitattributes', content: Buffer.from('*.ts -diff\n') },
      { type: 'file', path: 'secret.txt', content: Buffer.from('hidden?\n') },
      { type: 'dir', path: 'src' },
      { type: 'file', path: 'src/a.ts', content: Buffer.from('export const a = 2;\n') },
      { type: 'dir', path: 'node_modules' },
      { type: 'file', path: 'node_modules/x.js', content: Buffer.alloc(50_000, 0x78) },
      { type: 'file', path: 'build.log', content: Buffer.from('log\n') },
      { type: 'dir', path: 'vendor' },
      { type: 'file', path: 'vendor/t.txt', content: Buffer.from('changed\n') },
      { type: 'file', path: 'vendor/new.txt', content: Buffer.from('ignored\n') },
      { type: 'symlink', path: 'lnk', target: 'real' },
      { type: 'dir', path: 'real' },
      { type: 'file', path: 'real/r.txt', content: Buffer.from('r\n') },
    ]);
    neutraliseAttributes(repo);
    const checker = await IgnoreChecker.start(repo, home, 30_000);
    let entries;
    try {
      entries = await untarWorkspace(chunks(archive), 'workspace', LIMITS, checker.filter);
    } finally {
      checker.close();
    }
    expect(entries.map((e) => e.path)).not.toContain('node_modules/x.js');
    mirrorWorkspace(repo, entries);
    const proposal = await computeProposal(repo, home, base, {
      timeoutMs: 30_000,
      maxPatchBytes: 1024 * 1024,
    });
    expect([...proposal.changedFiles].sort()).toEqual([
      '.gitattributes',
      '.gitignore',
      'secret.txt',
      'src/a.ts',
      'vendor/t.txt',
    ]);
    const patch = proposal.patch.toString();
    expect(patch).toContain('+export const a = 2;'); // text, not a binary patch
    expect(patch).not.toContain('diff --git a/node_modules');
    expect(patch).not.toContain('diff --git a/build.log');
  });
});
