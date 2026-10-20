// D-08 W01 AC3 (R075b in design/RULES.md): a merged migration is never edited.
// migrations.lock.json holds the SHA-256 of every migration file. A new migration adds its line;
// a changed hash means a merged migration was edited: write a new migration instead.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const dir = path.resolve(__dirname, '../../packages/core/src/db/migrations');
const lock = JSON.parse(fs.readFileSync(path.join(dir, 'migrations.lock.json'), 'utf8')) as Record<
  string,
  string
>;
const files = fs
  .readdirSync(dir)
  .filter((f) => /^\d{4}-.*\.ts$/.test(f))
  .sort();

// Line endings are normalised, so a checkout with CRLF gives the same hash.
const sha256 = (file: string) =>
  createHash('sha256')
    .update(fs.readFileSync(path.join(dir, file), 'utf8').replace(/\r\n/g, '\n'))
    .digest('hex');

describe('W01: migrations.lock.json (R075b)', () => {
  it('lists every migration file, and no file that is gone', () => {
    const missing = files
      .filter((f) => !(f in lock))
      .map((f) => `"${f}": "${sha256(f)}"`)
      .join(', ');
    expect(Object.keys(lock).sort(), `add to migrations.lock.json: ${missing}`).toEqual(files);
  });

  it.each(files)('%s is unchanged since it was locked', (file) => {
    expect(
      sha256(file),
      `${file} changed: never edit a merged migration, write a new one (CLAUDE.md)`,
    ).toBe(lock[file]);
  });
});
