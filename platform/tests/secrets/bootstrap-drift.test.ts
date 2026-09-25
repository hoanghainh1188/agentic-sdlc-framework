// The client's default names must match what the OpenBao bootstrap creates (A03, ADR-M19):
// mounts, the Transit key, and the Ed25519 key type. A change on one side needs the other.
import fs from 'node:fs';
import path from 'node:path';

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
