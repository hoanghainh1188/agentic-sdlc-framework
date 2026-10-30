// `pnpm alerts` (O03, design/ADR-M101): one run. Doctor's results go in, the decision is sent to
// every channel, and the state file is written only when every channel took the message, so a
// failed delivery is tried again on the next run. Dry run and test message change no state. No
// value of the env file reaches a message, stdout or the state file.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { runAlerts, type RunDeps } from '../../deploy/alerts/src/run.js';
import type { CheckResult } from '../../deploy/doctor/src/types.js';

const NOW = new Date('2026-10-30T10:00:00.000Z');
const SECRET = 'S3cr3t-value-never-sent';
const sealed: CheckResult = {
  id: 'openbao.state',
  status: 'failed',
  text: { key: 'doctor.openbao.sealed' },
  fix: { key: 'doctor.fix.unseal' },
};

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function setup(extraEnv = '') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alerts-run-'));
  dirs.push(dir);
  const urlFile = path.join(dir, 'webhook-url');
  fs.writeFileSync(urlFile, 'https://hooks.example.test/x', { mode: 0o600 });
  const envFile = path.join(dir, '.env');
  fs.writeFileSync(
    envFile,
    [
      `PLATFORM_DB_PASSWORD=${SECRET}`,
      `SDLC_ALERT_WEBHOOK_FILE=${urlFile}`,
      `SDLC_ALERT_HOST_NAME=sdlc-server-1`,
      extraEnv,
    ].join('\n'),
  );
  const out: string[] = [];
  const bodies: string[] = [];
  let status: number | null = 200;
  const deps = (results: CheckResult[], over: Partial<RunDeps> = {}): RunDeps => ({
    envFile,
    now: () => NOW,
    hostname: 'host-default',
    results: () => Promise.resolve(results),
    post: (_url, body) => {
      bodies.push(body);
      return Promise.resolve(status);
    },
    out: (line) => out.push(line),
    ...over,
  });
  const stateFile = path.join(dir, 'alerts-state.json');
  return { dir, envFile, stateFile, out, bodies, deps, fail: (s: number | null) => (status = s) };
}

describe('runAlerts', () => {
  it('sends a new problem once, writes the state file (mode 600), then stays quiet', async () => {
    const s = setup();
    expect(await runAlerts([], s.deps([sealed]))).toBe(0);
    expect(s.bodies).toHaveLength(1);
    expect(fs.statSync(s.stateFile).mode & 0o777).toBe(0o600);
    expect(JSON.parse(fs.readFileSync(s.stateFile, 'utf8'))).toEqual({
      version: 1,
      channels: { webhook: { 'openbao.state|': { status: 'failed', sentAt: NOW.toISOString() } } },
    });
    expect(await runAlerts([], s.deps([sealed]))).toBe(0);
    expect(s.bodies).toHaveLength(1);
  });

  it('a failed delivery exits 1 and keeps the old state, so the next run tries again', async () => {
    const s = setup();
    s.fail(503);
    expect(await runAlerts([], s.deps([sealed]))).toBe(1);
    expect(JSON.parse(fs.readFileSync(s.stateFile, 'utf8'))).toEqual({ version: 1, channels: {} });
    s.fail(200);
    expect(await runAlerts([], s.deps([sealed]))).toBe(0);
    expect(s.bodies).toHaveLength(2);
  });

  it('--dry-run prints the message and sends and writes nothing', async () => {
    const s = setup();
    expect(await runAlerts(['--dry-run'], s.deps([sealed]))).toBe(0);
    expect(s.bodies).toEqual([]);
    expect(fs.existsSync(s.stateFile)).toBe(false);
    expect(s.out.join('\n')).toContain('openbao.state');
  });

  it('--test sends a test message without running the checks or writing state', async () => {
    const s = setup();
    const results = () => Promise.reject(new Error('the checks must not run'));
    expect(await runAlerts(['--test'], s.deps([], { results }))).toBe(0);
    expect(s.bodies).toHaveLength(1);
    expect(fs.existsSync(s.stateFile)).toBe(false);
  });

  it('a state file that is not valid starts over (every problem sent again) and says so', async () => {
    const s = setup();
    fs.writeFileSync(s.stateFile, '{not json', { mode: 0o600 });
    expect(await runAlerts([], s.deps([sealed]))).toBe(0);
    expect(s.bodies).toHaveLength(1);
    expect(s.out.join('\n')).toMatch(/state file/i);
  });

  it('no channel or a bad setting: exit 2 with the key, nothing sent', async () => {
    const s = setup('SDLC_ALERT_REMIND_HOURS=soon');
    expect(await runAlerts([], s.deps([sealed]))).toBe(2);
    expect(s.out.join('\n')).toContain('SDLC_ALERT_REMIND_HOURS');
    expect(s.bodies).toEqual([]);
    expect(await runAlerts(['--unknown'], s.deps([sealed]))).toBe(2);
  });

  it('two channels, one down: only that one is tried again; the other does not repeat', async () => {
    const mailLog = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'alerts-mail-')), 'count');
    dirs.push(path.dirname(mailLog));
    const sendmail = path.join(path.dirname(mailLog), 'sendmail');
    fs.writeFileSync(sendmail, `#!/bin/sh\ncat >/dev/null\necho sent >> "${mailLog}"\n`, {
      mode: 0o700,
    });
    const s = setup(`SDLC_ALERT_EMAIL_TO=ops@example.test\nSDLC_ALERT_SENDMAIL=${sendmail}`);
    s.fail(null);
    expect(await runAlerts([], s.deps([sealed]))).toBe(1);
    expect(await runAlerts([], s.deps([sealed]))).toBe(1);
    expect(fs.readFileSync(mailLog, 'utf8').trim().split('\n')).toEqual(['sent']);
    // The webhook was tried on both runs (no answer), and once more when it is back.
    expect(s.bodies).toHaveLength(2);
    s.fail(200);
    expect(await runAlerts([], s.deps([sealed]))).toBe(0);
    expect(s.bodies).toHaveLength(3);
    expect(fs.readFileSync(mailLog, 'utf8').trim().split('\n')).toEqual(['sent']);
  });

  it('a state folder that cannot be written is refused before anything is sent', async () => {
    const s = setup('SDLC_ALERT_STATE_FILE=/nonexistent-folder/alerts-state.json');
    expect(await runAlerts([], s.deps([sealed]))).toBe(2);
    expect(s.out.join('\n')).toContain('SDLC_ALERT_STATE_FILE');
    expect(s.bodies).toEqual([]);
  });

  it('no value of the env file reaches a message, stdout or the state file', async () => {
    const s = setup();
    const disk: CheckResult = {
      id: 'host.disk',
      subject: '/mnt/backup',
      status: 'warning',
      text: { key: 'doctor.disk.low', params: { gib: '3.0' } },
      fix: { key: 'doctor.fix.disk' },
    };
    await runAlerts([], s.deps([sealed, disk]));
    await runAlerts(['--dry-run'], s.deps([sealed, disk]));
    const all = [...s.bodies, ...s.out, fs.readFileSync(s.stateFile, 'utf8')].join('\n');
    expect(all).not.toContain(SECRET);
    expect(all).not.toContain('hooks.example.test');
  });
});
