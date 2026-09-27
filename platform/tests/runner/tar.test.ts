// Workspace archive (ADR-M25 §2.3): entries owned by the sandbox user, relative paths only, and a
// valid tar that the system `tar` reads back.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { packDirectory, packTar, RunnerError } from '../../apps/runner/src/index.js';

describe('packTar', () => {
  const archive = packTar([
    { type: 'dir', path: '.' },
    { type: 'dir', path: 'src' },
    { type: 'file', path: 'src/a.txt', content: Buffer.from('hello\n') },
    { type: 'file', path: 'run.sh', content: Buffer.alloc(513, 0x61), executable: true },
  ]);

  it('writes 512-byte blocks and is deterministic', () => {
    expect(archive.length % 512).toBe(0);
    expect(
      packTar([{ type: 'file', path: 'x', content: Buffer.from('1') }]).equals(
        packTar([{ type: 'file', path: 'x', content: Buffer.from('1') }]),
      ),
    ).toBe(true);
  });

  it('is read back by the system tar, owned by 10001, with the right modes and content', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-tar-'));
    try {
      const file = path.join(dir, 'a.tar');
      fs.writeFileSync(file, archive);
      const listing = execFileSync('tar', ['-tvnf', file], { encoding: 'utf8' });
      // GNU tar prints `10001/10001`, bsdtar (macOS) prints `10001  10001`.
      expect(listing).toMatch(/^drwxr-xr-x(?:\s+\d+)?\s+10001[ /]+10001\s.* \.\/$/m);
      expect(listing).toMatch(/^-rw-r--r--(?:\s+\d+)?\s+10001[ /]+10001\s+6 .* src\/a\.txt$/m);
      expect(listing).toMatch(/^-rwxr-xr-x(?:\s+\d+)?\s+10001[ /]+10001\s+513 .* run\.sh$/m);
      execFileSync('tar', ['-xf', file, '-C', dir]);
      expect(fs.readFileSync(path.join(dir, 'src/a.txt'), 'utf8')).toBe('hello\n');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each(['/etc/passwd', '../x', 'a/../../x', 'a//b', '', 'a\nb'])(
    'refuses the path %j',
    (bad) => {
      expect(() => packTar([{ type: 'file', path: bad, content: Buffer.alloc(0) }])).toThrow(
        TypeError,
      );
    },
  );

  it('writes long names and link targets with PAX headers', () => {
    const long = `${'d'.repeat(80)}/${'f'.repeat(80)}.txt`;
    const target = `../${'t'.repeat(120)}`;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-tar-'));
    try {
      const file = path.join(dir, 'a.tar');
      fs.writeFileSync(
        file,
        packTar([
          { type: 'dir', path: 'd'.repeat(80) },
          { type: 'file', path: long, content: Buffer.from('x') },
          { type: 'symlink', path: 'link', target },
        ]),
      );
      execFileSync('tar', ['-xf', file, '-C', dir]);
      expect(fs.readFileSync(path.join(dir, long), 'utf8')).toBe('x');
      expect(fs.readlinkSync(path.join(dir, 'link'))).toBe(target);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('packDirectory', () => {
  const tree = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-pack-'));
    fs.mkdirSync(path.join(dir, 'src'));
    fs.writeFileSync(path.join(dir, 'src', 'a.ts'), 'export {};\n');
    fs.writeFileSync(path.join(dir, 'run.sh'), '#!/bin/sh\n', { mode: 0o755 });
    fs.symlinkSync('src/a.ts', path.join(dir, 'link.ts'));
    return dir;
  };

  it('packs files, directories, symbolic links and the executable bit, owned by 10001', () => {
    const dir = tree();
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-unpack-'));
    try {
      const file = path.join(out, 'w.tar');
      fs.writeFileSync(file, packDirectory(dir, 1024 * 1024));
      const listing = execFileSync('tar', ['-tvnf', file], { encoding: 'utf8' });
      expect(listing).toMatch(/^drwxr-xr-x(?:\s+\d+)?\s+10001[ /]+10001\s.* \.\/$/m);
      expect(listing).toMatch(/^l.* link\.ts -> src\/a\.ts$/m);
      execFileSync('tar', ['-xf', file, '-C', out]);
      expect(fs.readFileSync(path.join(out, 'src', 'a.ts'), 'utf8')).toBe('export {};\n');
      expect(fs.statSync(path.join(out, 'run.sh')).mode & 0o111).not.toBe(0);
      expect(fs.statSync(path.join(out, 'src', 'a.ts')).mode & 0o111).toBe(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(out, { recursive: true, force: true });
    }
  });

  it('refuses a workspace above the size limit', () => {
    const dir = tree();
    try {
      expect(() => packDirectory(dir, 10)).toThrow(RunnerError);
      expect(() => packDirectory(dir, 10)).toThrow(/SDLC_RUNNER_WORKSPACE_MAX_MB/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses special files (a FIFO)', () => {
    const dir = tree();
    try {
      execFileSync('mkfifo', [path.join(dir, 'pipe')]);
      expect(() => packDirectory(dir, 1024 * 1024)).toThrow(/special file/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
