// Workspace archive (ADR-M25 §2.3): entries owned by the sandbox user, relative paths only, and a
// valid tar that the system `tar` reads back.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { packTar } from '../../apps/runner/src/index.js';

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

  it.each(['/etc/passwd', '../x', 'a/../../x', 'a//b', '', 'x'.repeat(101), 'a\nb'])(
    'refuses the path %j',
    (bad) => {
      expect(() => packTar([{ type: 'file', path: bad, content: Buffer.alloc(0) }])).toThrow(
        TypeError,
      );
    },
  );
});
