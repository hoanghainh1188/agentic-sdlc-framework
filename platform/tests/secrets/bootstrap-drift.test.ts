// The client's default names must match what the OpenBao bootstrap creates (A03, ADR-M19):
// mounts, the Transit key, and the Ed25519 key type. A change on one side needs the other.
import fs from 'node:fs';
import path from 'node:path';

import { DEFAULT_GITHUB_APP_SECRET_PATH } from '@sdlc/adapter-git-github';
import { DEFAULT_MOUNTS, RUN_CONTRACT_KEY } from '@sdlc/secrets';
import { describe, expect, it } from 'vitest';

import { deployDir } from '../deploy/compose';

const bootstrap = path.join(deployDir, 'openbao/bootstrap');
const conf = new Map(
  fs
    .readFileSync(path.join(bootstrap, 'bootstrap.conf'), 'utf8')
    .split('\n')
    .filter((l) => /^[A-Z_]+=/.test(l))
    .map((l) => l.split('=', 2) as [string, string]),
);
const configure = fs.readFileSync(path.join(bootstrap, 'configure.sh'), 'utf8');
const policy = (name: string): string =>
  fs.readFileSync(path.join(bootstrap, `policies/${name}.hcl`), 'utf8');

describe('client defaults match the OpenBao bootstrap', () => {
  it('Transit key name and type', () => {
    expect(RUN_CONTRACT_KEY).toBe(conf.get('TRANSIT_KEY'));
    expect(conf.get('TRANSIT_KEY_TYPE')).toBe('ed25519');
  });

  it('mounts used by the policies and the configure script', () => {
    expect(policy('worker')).toContain(`path "${DEFAULT_MOUNTS.kv}/data/worker/*"`);
    expect(policy('worker')).toContain(`path "${DEFAULT_MOUNTS.transit}/sign/${RUN_CONTRACT_KEY}"`);
    expect(policy('runner')).toContain(
      `path "${DEFAULT_MOUNTS.transit}/verify/${RUN_CONTRACT_KEY}"`,
    );
    expect(policy('runner')).toContain(`path "${DEFAULT_MOUNTS.transit}/keys/${RUN_CONTRACT_KEY}"`);
    expect(configure).toContain(`auth/${DEFAULT_MOUNTS.approle}/role/`);
  });
});

describe('GitHub App key path (D-03 §8.2, B05, QUESTIONS #42)', () => {
  it('the adapter default path is readable by api and worker, and by no other role (QUESTIONS #44)', () => {
    const readable = `path "${DEFAULT_MOUNTS.kv}/data/${DEFAULT_GITHUB_APP_SECRET_PATH}"`;
    for (const role of ['api', 'worker']) expect(policy(role), role).toContain(readable);
    for (const role of ['runner', 'cost-controller']) {
      expect(policy(role), role).not.toContain(readable);
    }
  });
});
