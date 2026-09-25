// Settings of the OpenBao client (ADR-M21 §2.2, §2.4): environment variables, credential files,
// plain http only with SDLC_OPENBAO_ALLOW_PLAINTEXT=1 (decision D1), messages from the catalog.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  OpenBaoClient,
  optionsFromEnv,
  SecretsError,
  type OpenBaoClientOptions,
} from '@sdlc/secrets';
import { afterAll, describe, expect, it } from 'vitest';

import { repoRoot } from '../workspace/helpers';
import { credentialFiles } from './stub-openbao';

const files = credentialFiles();
const base: OpenBaoClientOptions = {
  address: 'https://openbao:8200',
  roleIdFile: files.roleIdFile,
  secretIdFile: files.secretIdFile,
};
const env = {
  SDLC_OPENBAO_ADDR: 'https://openbao:8200',
  SDLC_OPENBAO_ROLE_ID_FILE: files.roleIdFile,
  SDLC_OPENBAO_SECRET_ID_FILE: files.secretIdFile,
};

function errorOf(fn: () => unknown): SecretsError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(SecretsError);
    return error as SecretsError;
  }
  throw new Error('expected a SecretsError');
}

afterAll(() => fs.rmSync(files.dir, { recursive: true, force: true }));

describe('settings from the environment', () => {
  it('reads the address, credential files, CA file, flag and timeout', () => {
    expect(
      optionsFromEnv({
        ...env,
        SDLC_OPENBAO_CA_CERT_FILE: '/run/ca.pem',
        SDLC_OPENBAO_TIMEOUT_MS: '2500',
      }),
    ).toEqual({ ...base, caCertFile: '/run/ca.pem', allowPlaintext: false, timeoutMs: 2500 });
  });

  it.each(['SDLC_OPENBAO_ADDR', 'SDLC_OPENBAO_ROLE_ID_FILE', 'SDLC_OPENBAO_SECRET_ID_FILE'])(
    '%s is required',
    (name) => {
      const error = errorOf(() => optionsFromEnv({ ...env, [name]: '' }));
      expect(error.key).toBe('secrets.config.missing_setting');
      expect(error.message).toBe(`${name} is not set. The OpenBao client needs it.`);
    },
  );

  it('accepts only 1, 0 or empty for SDLC_OPENBAO_ALLOW_PLAINTEXT', () => {
    expect(optionsFromEnv({ ...env, SDLC_OPENBAO_ALLOW_PLAINTEXT: '1' }).allowPlaintext).toBe(true);
    expect(optionsFromEnv({ ...env, SDLC_OPENBAO_ALLOW_PLAINTEXT: '0' }).allowPlaintext).toBe(
      false,
    );
    for (const value of ['true', 'yes', ' 1']) {
      expect(
        errorOf(() => optionsFromEnv({ ...env, SDLC_OPENBAO_ALLOW_PLAINTEXT: value })).key,
      ).toBe('secrets.config.invalid_flag');
    }
  });

  it('refuses a timeout that is not a positive whole number', () => {
    for (const value of ['0', '-1', '1.5', 'abc']) {
      expect(errorOf(() => optionsFromEnv({ ...env, SDLC_OPENBAO_TIMEOUT_MS: value })).key).toBe(
        'secrets.config.invalid_timeout',
      );
    }
  });
});

describe('address and TLS rules', () => {
  it('refuses plain http unless SDLC_OPENBAO_ALLOW_PLAINTEXT=1', () => {
    const error = errorOf(() => new OpenBaoClient({ ...base, address: 'http://openbao:8200' }));
    expect(error.key).toBe('secrets.config.plaintext_not_allowed');
    expect(error.message).toMatch(/does not use TLS/);
    expect(
      () => new OpenBaoClient({ ...base, address: 'http://openbao:8200', allowPlaintext: true }),
    ).not.toThrow();
  });

  it('refuses a CA file together with plain http', () => {
    const error = errorOf(
      () =>
        new OpenBaoClient({
          ...base,
          address: 'http://openbao:8200',
          allowPlaintext: true,
          caCertFile: '/x',
        }),
    );
    expect(error.key).toBe('secrets.config.ca_needs_https');
  });

  it.each([
    'openbao:8200',
    'ftp://openbao:8200',
    'https://user:pw@openbao:8200',
    'https://openbao:8200/v1',
    'https://openbao:8200/?x=1',
  ])('refuses the address %s', (address) => {
    expect(errorOf(() => new OpenBaoClient({ ...base, address })).key).toBe(
      'secrets.config.invalid_address',
    );
  });

  it('refuses a CA file that is missing or holds no certificate', () => {
    const missing = errorOf(
      () => new OpenBaoClient({ ...base, caCertFile: '/nonexistent/ca.pem' }),
    );
    expect(missing.key).toBe('secrets.config.unreadable_file');
    expect(missing.params).toMatchObject({ reason: 'ENOENT' });
    const bad = path.join(files.dir, 'bad.pem');
    fs.writeFileSync(bad, 'not a certificate');
    expect(errorOf(() => new OpenBaoClient({ ...base, caCertFile: bad })).key).toBe(
      'secrets.config.invalid_ca',
    );
  });

  it('has no option that turns certificate verification off', () => {
    const source = fs
      .readdirSync(srcDir)
      .map((f) => fs.readFileSync(path.join(srcDir, f), 'utf8'))
      .join('\n');
    expect(source).not.toMatch(/rejectUnauthorized:\s*false/);
    expect(source).not.toMatch(
      /NODE_TLS_REJECT_UNAUTHORIZED|checkServerIdentity|insecure|skip.?verify/i,
    );
    expect(source).toMatch(/rejectUnauthorized: true/);
  });

  it('refuses unsafe mount names', () => {
    expect(errorOf(() => new OpenBaoClient({ ...base, mounts: { kv: '../sys' } })).key).toBe(
      'secrets.config.invalid_mount',
    );
  });
});

describe('credential files', () => {
  it('refuses an empty file or a file with more than one value', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-cred-'));
    const file = path.join(dir, 'secret-id');
    for (const content of ['', '\n', 'a b\n', 'one\ntwo\n']) {
      fs.writeFileSync(file, content);
      const client = new OpenBaoClient({ ...base, secretIdFile: file });
      const error = await client.login().catch((e: unknown) => e);
      expect((error as SecretsError).key).toBe('secrets.config.invalid_credential_file');
      await client.close();
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

const srcDir = path.join(repoRoot(), 'platform/packages/secrets/src');
