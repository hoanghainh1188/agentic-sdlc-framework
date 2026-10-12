// D-08 V08 AC2, AC3: `pnpm trial:start` with a fake machine (`Exec`): the order of
// GETTING-STARTED Step 13 (OpenBao, unseal with the key file, migrations, the rest), the shares
// only on the unseal command's stdin and the passphrase nowhere, a wrong passphrase unseals
// nothing, already unsealed asks nothing, and every refusal (QUESTIONS #356, #419).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { encryptKeys, KEY_FILE_NAME, writeKeyFile } from '../../deploy/trial/src/keys.js';
import {
  parseStatus,
  StartError,
  startRefusal,
  trialStart,
  type StartDeps,
} from '../../deploy/trial/src/start.js';
import type { Exec } from '../../deploy/trial/src/up.js';

const PROJECT = 'sdlc-trial';
const PASSPHRASE = 'correct horse battery staple';
const SHARES = [0, 1].map((i) => Buffer.alloc(32, 70 + i).toString('base64'));
const DB_PASSWORD = 'db-owner-password-value';
const NOW = new Date('2026-10-12T00:00:00Z');

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

interface Call {
  readonly cmd: string;
  readonly args: readonly string[];
  readonly input: string;
  readonly env: Readonly<Record<string, string>>;
}

async function world(
  opts: {
    state?: 'sealed' | 'unsealed' | 'uninitialised';
    keyFile?: 'ok' | 'none' | 'mode' | 'other_project';
    containerProject?: string;
  } = {},
) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-trial-start-'));
  dirs.push(root);
  const envFile = path.join(root, '.env');
  fs.writeFileSync(
    envFile,
    `COMPOSE_PROJECT_NAME=${PROJECT}\nPLATFORM_DB_PASSWORD=${DB_PASSWORD}\nPOSTGRES_HOST_PORT=25432\nSDLC_API_HOST_PORT=28090\n`,
    { mode: 0o600 },
  );
  const keyFile = path.join(root, KEY_FILE_NAME);
  const kind = opts.keyFile ?? 'ok';
  if (kind !== 'none') {
    const project = kind === 'other_project' ? 'sdlc-trial-other' : PROJECT;
    writeKeyFile(
      keyFile,
      await encryptKeys({ project, createdAt: NOW.toISOString(), shares: SHARES }, PASSPHRASE, 10),
    );
    if (kind === 'mode') fs.chmodSync(keyFile, 0o644);
  }
  const calls: Call[] = [];
  let state = opts.state ?? 'sealed';
  const exec: Exec = (cmd, args, o = {}) => {
    calls.push({ cmd, args, input: o.input ?? '', env: o.env ?? {} });
    let stdout = '';
    if (args.includes('ps')) stdout = 'c0ffee\n';
    else if (cmd === 'docker' && args[0] === 'inspect')
      stdout = `${opts.containerProject ?? PROJECT}\n`;
    else if (cmd.endsWith('bootstrap.sh') && args[0] === 'status')
      stdout = `bootstrap: OpenBao is ${state}\n`;
    else if (cmd.endsWith('bootstrap.sh') && args[0] === 'unseal') state = 'unsealed';
    return Promise.resolve({ status: 0, stdout, stderr: '' });
  };
  const asked: string[] = [];
  const warnings: string[] = [];
  const answers = { list: [PASSPHRASE] };
  const deps: StartDeps = {
    repoRoot: root,
    envFile,
    project: PROJECT,
    keyFile,
    exec,
    progress: () => undefined,
    warn: (key) => warnings.push(key),
    passphrase: () => {
      asked.push('x');
      return Promise.resolve(answers.list.shift() ?? 'wrong passphrase value');
    },
    tries: 3,
    now: NOW,
  };
  return { deps, calls, asked, warnings, answers, keyFile };
}

const stepOf = (c: Call): string =>
  c.cmd.endsWith('bootstrap.sh')
    ? `bootstrap ${c.args[0]}`
    : c.cmd === 'node'
      ? 'migrate'
      : c.cmd.endsWith('up.sh')
        ? 'up.sh'
        : c.args.includes('up')
          ? 'compose up'
          : c.args.includes('ps')
            ? 'compose ps'
            : `${c.cmd} ${c.args[0]}`;

async function startCode(deps: StartDeps): Promise<string> {
  try {
    await trialStart(deps);
  } catch (error) {
    if (error instanceof StartError) return error.code;
    throw error;
  }
  return '(none)';
}

describe('V08 AC2: trial:start unseals with the key file and starts the stack', () => {
  it('follows Step 13: OpenBao and the database, unseal, migrations, the rest', async () => {
    const w = await world();
    const r = await trialStart(w.deps);
    expect(r).toEqual({ unsealed: 'now', apiUrl: 'http://127.0.0.1:28090' });
    expect(w.calls.map(stepOf)).toEqual([
      'compose up',
      'compose ps',
      'docker inspect',
      'bootstrap status',
      'bootstrap unseal',
      'migrate',
      'up.sh',
    ]);
    const up = w.calls[0]!;
    expect(up.args.slice(0, 3)).toEqual(['compose', '-p', PROJECT]);
    expect(up.args).toEqual(expect.arrayContaining(['openbao', 'postgres', 'seaweedfs']));
    expect(w.calls.at(-1)!.args).toEqual(['core', 'models', 'platform', 'sandbox']);
    expect(w.asked).toHaveLength(1);
  });

  it('the shares go only to the unseal command on stdin; the passphrase goes nowhere', async () => {
    const w = await world();
    await trialStart(w.deps);
    const unseal = w.calls.find((c) => stepOf(c) === 'bootstrap unseal')!;
    expect(unseal.input).toBe(`${SHARES.join('\n')}\n`);
    for (const c of w.calls) {
      const visible = [c.cmd, ...c.args, ...Object.values(c.env)].join(' ');
      expect(visible).not.toContain(PASSPHRASE);
      for (const share of SHARES) expect(visible).not.toContain(share);
      if (c !== unseal) {
        expect(c.input).not.toContain(PASSPHRASE);
        for (const share of SHARES) expect(c.input).not.toContain(share);
      }
    }
    // The key file is unchanged and still encrypted.
    expect(fs.readFileSync(w.keyFile).toString('latin1')).not.toContain(SHARES[0]!);
  });

  it('already unsealed (idempotent): no passphrase is asked, nothing is unsealed', async () => {
    const w = await world({ state: 'unsealed' });
    expect((await trialStart(w.deps)).unsealed).toBe('already');
    expect(w.asked).toEqual([]);
    expect(w.calls.map(stepOf)).not.toContain('bootstrap unseal');
    expect(w.calls.map(stepOf)).toContain('up.sh');
  });

  it('already unsealed without a key file warns that the next reboot loses it', async () => {
    const w = await world({ state: 'unsealed', keyFile: 'none' });
    await trialStart(w.deps);
    expect(w.warnings).toContain('trial.start.no_key_file_warning');
  });

  it('a wrong passphrase unseals nothing: three tries on a terminal, then a stop', async () => {
    const w = await world();
    w.answers.list = [];
    expect(await startCode(w.deps)).toBe('wrong_passphrase');
    expect(w.asked).toHaveLength(3);
    expect(w.warnings.filter((k) => k === 'trial.start.try_again')).toHaveLength(2);
    expect(w.calls.map(stepOf)).not.toContain('bootstrap unseal');
    expect(w.calls.map(stepOf)).not.toContain('up.sh');
  });

  it('one wrong try, then the right one, unseals', async () => {
    const w = await world();
    w.answers.list = ['wrong passphrase value', PASSPHRASE];
    expect((await trialStart(w.deps)).unsealed).toBe('now');
    expect(w.asked).toHaveLength(2);
  });

  it('warns from day 80 and says to set up again after day 90 (QUESTIONS #417)', async () => {
    const w = await world({ state: 'unsealed' });
    const old = new Date(NOW.getTime() - 85 * 86_400_000);
    fs.utimesSync(w.keyFile, old, old);
    await trialStart(w.deps);
    expect(w.warnings).toContain('trial.start.ageing');
    const older = new Date(NOW.getTime() - 91 * 86_400_000);
    fs.utimesSync(w.keyFile, older, older);
    await trialStart(w.deps);
    expect(w.warnings).toContain('trial.start.expired');
  });
});

describe('V08 AC3: trial:start refuses what is not its own trial stack', () => {
  it('NODE_ENV=production, no env file, another Compose project', () => {
    const env = `COMPOSE_PROJECT_NAME=${PROJECT}\n`;
    expect(startRefusal('production', env, PROJECT)).toBe('production');
    expect(startRefusal(undefined, undefined, PROJECT)).toBe('no_env');
    expect(startRefusal(undefined, 'COMPOSE_PROJECT_NAME=sdlc\n', PROJECT)).toBe('not_trial');
    expect(startRefusal(undefined, env, PROJECT)).toBeUndefined();
  });

  it('a sealed stack without a key file (set up before V08) is not unsealed (AC5 upgrade)', async () => {
    const w = await world({ keyFile: 'none' });
    expect(await startCode(w.deps)).toBe('no_key_file');
    expect(w.asked).toEqual([]);
    expect(w.calls.map(stepOf)).not.toContain('bootstrap unseal');
  });

  it('a key file others can read, or of another project, is refused', async () => {
    expect(await startCode((await world({ keyFile: 'mode' })).deps)).toBe('key_file_mode');
    expect(await startCode((await world({ keyFile: 'other_project' })).deps)).toBe(
      'key_file_project',
    );
  });

  it('an openbao container of another project is refused before anything is read', async () => {
    const w = await world({ containerProject: 'sdlc' });
    expect(await startCode(w.deps)).toBe('not_trial_container');
    expect(w.asked).toEqual([]);
  });

  it('an uninitialised OpenBao is a broken stack', async () => {
    expect(await startCode((await world({ state: 'uninitialised' })).deps)).toBe('not_initialised');
  });

  it('parses the bootstrap status line', () => {
    expect(parseStatus('bootstrap: OpenBao is sealed\n')).toBe('sealed');
    expect(parseStatus('bootstrap: OpenBao is unsealed\n')).toBe('unsealed');
    expect(parseStatus('nothing')).toBeUndefined();
  });
});
