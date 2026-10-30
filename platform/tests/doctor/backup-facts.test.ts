// `pnpm doctor`, the facts of `backup.recent` (O03, design/ADR-M101): the newest complete backup
// folder of `backup.sh` (`<UTC time>` with `MANIFEST`) and the thresholds from the env file. The
// folder is only listed, never read beyond the names and whether `MANIFEST` exists.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { backupHours, newestBackup } from '../../deploy/doctor/src/host.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function target(folders: Record<string, boolean>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-backup-'));
  dirs.push(dir);
  for (const [name, complete] of Object.entries(folders)) {
    fs.mkdirSync(path.join(dir, name));
    if (complete) fs.writeFileSync(path.join(dir, name, 'MANIFEST'), 'sha256 size name\n');
  }
  return dir;
}

describe('newestBackup', () => {
  it('the newest folder with a MANIFEST; a .partial, a folder without MANIFEST and other names do not count', () => {
    const dir = target({
      '20261010T023000Z': true,
      '20261011T023000Z': true,
      '20261012T023000Z': false,
      '20261012T023000Z.partial': true,
      notes: true,
    });
    expect(newestBackup(dir)).toEqual({ readable: true, newest: '2026-10-11T02:30:00.000Z' });
  });

  it('an empty folder has no backup; a missing folder is unreadable', () => {
    expect(newestBackup(target({}))).toEqual({ readable: true, newest: null });
    expect(newestBackup('/nonexistent/doctor-backup')).toEqual({ readable: false, newest: null });
  });
});

describe('backupHours', () => {
  it('the defaults 26 and 50 (also for an empty value), or whole numbers from the env file', () => {
    expect(backupHours({})).toEqual({ warnHours: 26, failHours: 50 });
    expect(backupHours({ SDLC_BACKUP_WARN_HOURS: '' })).toEqual({ warnHours: 26, failHours: 50 });
    expect(backupHours({ SDLC_BACKUP_WARN_HOURS: '8', SDLC_BACKUP_FAIL_HOURS: '12' })).toEqual({
      warnHours: 8,
      failHours: 12,
    });
  });

  it('a value that is not a whole number of 1 or more is NaN, so the check warns', () => {
    for (const bad of ['0', '-3', '1.5', 'abc']) {
      expect(Number.isNaN(backupHours({ SDLC_BACKUP_WARN_HOURS: bad }).warnHours), bad).toBe(true);
    }
  });
});
