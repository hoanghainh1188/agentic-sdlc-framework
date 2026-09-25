// Settings of the OpenBao client (design/ADR-M21 §2.2). Infrastructure settings come from the
// environment, not from @sdlc/config (per-project gate configuration, ADR-M19 §2.3).
//
// The role ID and the secret ID are read from FILES (mode 600, tmpfs mount), never from
// environment variables: `docker inspect` shows environment values (ADR-M17 §2.3).
import fs from 'node:fs';

import { SecretsError } from './errors.js';
import type { SecretsLogger } from './logger.js';

export const ENV = {
  address: 'SDLC_OPENBAO_ADDR',
  caCertFile: 'SDLC_OPENBAO_CA_CERT_FILE',
  allowPlaintext: 'SDLC_OPENBAO_ALLOW_PLAINTEXT',
  roleIdFile: 'SDLC_OPENBAO_ROLE_ID_FILE',
  secretIdFile: 'SDLC_OPENBAO_SECRET_ID_FILE',
  timeoutMs: 'SDLC_OPENBAO_TIMEOUT_MS',
} as const;

/** Mount paths and the Transit key name set by the bootstrap (A03, bootstrap.conf, ADR-M19). */
export const DEFAULT_MOUNTS = { kv: 'kv', transit: 'transit', approle: 'approle' } as const;
export const RUN_CONTRACT_KEY = 'run-contract';
export const DEFAULT_TIMEOUT_MS = 10_000;

export interface OpenBaoClientOptions {
  /** `https://host:8200`, or `http://…` only with `allowPlaintext` (development and CI). */
  readonly address: string;
  /** PEM file with the company internal CA (QUESTIONS #20). When set, only this CA is trusted. */
  readonly caCertFile?: string;
  /** Allows `http://`. Never set it in production (ADR-M21 §2.4). */
  readonly allowPlaintext?: boolean;
  readonly roleIdFile: string;
  /** Read again at every login, so a rotated secret ID needs no restart. */
  readonly secretIdFile: string;
  readonly timeoutMs?: number;
  readonly mounts?: Partial<Record<keyof typeof DEFAULT_MOUNTS, string>>;
  readonly logger?: SecretsLogger;
}

/** Validated settings, with the CA certificate loaded. */
export interface ResolvedOptions {
  readonly origin: URL;
  readonly ca: Buffer | undefined;
  readonly plaintext: boolean;
  readonly roleIdFile: string;
  readonly secretIdFile: string;
  readonly timeoutMs: number;
  readonly mounts: Readonly<Record<keyof typeof DEFAULT_MOUNTS, string>>;
}

const MOUNT = /^[a-z0-9][a-z0-9_-]*$/;
const PEM_CERT = /-----BEGIN CERTIFICATE-----/;

/** Reads the settings from environment variables. */
export function optionsFromEnv(env: NodeJS.ProcessEnv = process.env): OpenBaoClientOptions {
  const allow = env[ENV.allowPlaintext] ?? '';
  if (!['', '0', '1'].includes(allow)) {
    throw new SecretsError('secrets.config.invalid_flag', { name: ENV.allowPlaintext });
  }
  const timeout = env[ENV.timeoutMs];
  if (timeout !== undefined && !/^[1-9][0-9]{0,6}$/.test(timeout)) {
    throw new SecretsError('secrets.config.invalid_timeout', { name: ENV.timeoutMs });
  }
  return {
    address: required(env, ENV.address),
    ...(env[ENV.caCertFile] ? { caCertFile: env[ENV.caCertFile] } : {}),
    allowPlaintext: allow === '1',
    roleIdFile: required(env, ENV.roleIdFile),
    secretIdFile: required(env, ENV.secretIdFile),
    ...(timeout ? { timeoutMs: Number(timeout) } : {}),
  };
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) throw new SecretsError('secrets.config.missing_setting', { name });
  return value;
}

export function resolveOptions(options: OpenBaoClientOptions): ResolvedOptions {
  const origin = parseAddress(options.address);
  const plaintext = origin.protocol === 'http:';
  if (plaintext && options.allowPlaintext !== true) {
    throw new SecretsError('secrets.config.plaintext_not_allowed', {
      address: origin.origin,
      name: ENV.allowPlaintext,
    });
  }
  if (plaintext && options.caCertFile) {
    throw new SecretsError('secrets.config.ca_needs_https', { name: ENV.caCertFile });
  }
  const mounts = { ...DEFAULT_MOUNTS, ...options.mounts };
  for (const mount of Object.values(mounts)) {
    if (!MOUNT.test(mount)) throw new SecretsError('secrets.config.invalid_mount', { mount });
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new SecretsError('secrets.config.invalid_timeout', { name: ENV.timeoutMs });
  }
  return {
    origin,
    ca: options.caCertFile ? readCa(options.caCertFile) : undefined,
    plaintext,
    roleIdFile: options.roleIdFile,
    secretIdFile: options.secretIdFile,
    timeoutMs,
    mounts,
  };
}

function parseAddress(address: string): URL {
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    throw new SecretsError('secrets.config.invalid_address', { name: ENV.address });
  }
  const bare = !url.username && !url.password && !url.search && !url.hash && url.pathname === '/';
  if (!['http:', 'https:'].includes(url.protocol) || !bare) {
    throw new SecretsError('secrets.config.invalid_address', { name: ENV.address });
  }
  return url;
}

function readCa(file: string): Buffer {
  const pem = readFileOrThrow(file, ENV.caCertFile);
  if (!PEM_CERT.test(pem.toString('utf8'))) {
    throw new SecretsError('secrets.config.invalid_ca', { file });
  }
  return pem;
}

/** Reads a settings file. The error names the file and the Node error code, never the content. */
export function readFileOrThrow(file: string, name: string): Buffer {
  try {
    return fs.readFileSync(file);
  } catch (error) {
    const reason = (error as NodeJS.ErrnoException).code ?? 'unknown';
    throw new SecretsError('secrets.config.unreadable_file', { name, file, reason });
  }
}

/** Reads a one-line credential file (role ID, secret ID). Trailing whitespace is ignored. */
export function readCredentialFile(file: string, name: string): string {
  const value = readFileOrThrow(file, name).toString('utf8').trim();
  if (!value || /\s/.test(value)) {
    throw new SecretsError('secrets.config.invalid_credential_file', { name, file });
  }
  return value;
}
