// Process settings of the runner that are not about sandboxes (ADR-M25 §2.6): where the database
// is, and where the heartbeat file lives. No secret comes from the environment: the database
// password is read from OpenBao (`kv/runner/database`, AppRole `runner`), the AppRole credentials
// from files (`SDLC_OPENBAO_*`, ADR-M21).
import os from 'node:os';
import path from 'node:path';

import { RunnerError } from './errors.js';

export const PROCESS_ENV = {
  dbHost: 'SDLC_RUNNER_DB_HOST',
  dbPort: 'SDLC_RUNNER_DB_PORT',
  dbName: 'SDLC_RUNNER_DB_NAME',
  dbSecretPath: 'SDLC_RUNNER_DB_SECRET_PATH',
  heartbeatFile: 'SDLC_RUNNER_HEARTBEAT_FILE',
  temporalAddress: 'SDLC_RUNNER_TEMPORAL_ADDRESS',
  temporalNamespace: 'SDLC_RUNNER_TEMPORAL_NAMESPACE',
  evidenceUrl: 'SDLC_RUNNER_EVIDENCE_URL',
  evidenceBucket: 'SDLC_RUNNER_EVIDENCE_BUCKET',
  evidenceSecretPath: 'SDLC_RUNNER_EVIDENCE_SECRET_PATH',
  githubApiUrl: 'SDLC_RUNNER_GITHUB_API_URL',
} as const;

/** The database role of every platform process (ADR-M09 section 2.3). */
export const DB_USER = 'platform_app';
/** Field of the KV entry written by `openbao:bootstrap runner-credentials`. */
export const DB_PASSWORD_FIELD = 'password';
/** Fields of the KV entry written by `openbao:bootstrap runner-evidence-credentials`. */
export const EVIDENCE_ACCESS_KEY_FIELD = 'access_key';
export const EVIDENCE_SECRET_KEY_FIELD = 'secret_key';
/** L1 proposals start with this prefix (SeaweedFS `Write:evidence/proposals/*`, C06 2b). */
export const EVIDENCE_KEY_PREFIX = 'proposals/';
/** Run diffs start with this prefix (SeaweedFS `Write:evidence/diffs/*`, C07, ADR-M34 §2.2). */
export const EVIDENCE_DIFF_KEY_PREFIX = 'diffs/';

export interface ProcessSettings {
  readonly db: {
    readonly host: string;
    readonly port: number;
    readonly name: string;
    /** KV path; the `runner` AppRole reads `kv/data/runner/*` only (runner.hcl). */
    readonly secretPath: string;
  };
  /** Written after each clean-up; the container health check reads its age (healthcheck.ts). */
  readonly heartbeatFile: string;
  /**
   * The Temporal frontend of the task queue `sdlc-runner` (C06 session 2, ADR-M33 §2.6); null
   * (`off`): the runner takes no runs (tests of the process without Temporal).
   */
  readonly temporal: { readonly address: string; readonly namespace: string } | null;
  /**
   * Where L1 proposals go (C06 session 2b, ADR-M33 §2.9): the S3 API of SeaweedFS and the KV path
   * of the runner's write-only credential. Null (`SDLC_RUNNER_EVIDENCE_URL=off`): no proposals.
   */
  readonly evidence: {
    readonly url: string;
    readonly bucket: string;
    readonly secretPath: string;
  } | null;
  /**
   * The GitHub REST API where the runner revokes the run's clone and push tokens right after their
   * use (C11, ADR-M42 §2.4). Null (`SDLC_RUNNER_GITHUB_API_URL=off`): the tokens expire by
   * themselves (development without GitHub, tests).
   */
  readonly githubApiUrl: string | null;
}

const HOST = /^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$/;
const DB_NAME = /^[a-z_][a-z0-9_]{0,62}$/;
const SECRET_PATH = /^runner\/[A-Za-z0-9_.-]+$/;
const TEMPORAL_ADDRESS = /^[A-Za-z0-9][A-Za-z0-9.-]{0,252}:[0-9]{1,5}$/;
const TEMPORAL_NAMESPACE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const BUCKET = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;

function evidenceSettings(env: NodeJS.ProcessEnv): ProcessSettings['evidence'] {
  const raw = env[PROCESS_ENV.evidenceUrl] || 'http://seaweedfs:8333';
  if (raw === 'off') return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw invalid(PROCESS_ENV.evidenceUrl);
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username !== '' ||
    url.password !== '' ||
    url.pathname !== '/' ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    throw invalid(PROCESS_ENV.evidenceUrl);
  }
  const bucket = env[PROCESS_ENV.evidenceBucket] || 'evidence';
  const secretPath = env[PROCESS_ENV.evidenceSecretPath] || 'runner/evidence';
  if (!BUCKET.test(bucket)) throw invalid(PROCESS_ENV.evidenceBucket);
  if (!SECRET_PATH.test(secretPath)) throw invalid(PROCESS_ENV.evidenceSecretPath);
  return { url: url.origin, bucket, secretPath };
}

function githubApiUrl(env: NodeJS.ProcessEnv): string | null {
  const raw = env[PROCESS_ENV.githubApiUrl] || 'https://api.github.com';
  if (raw === 'off') return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw invalid(PROCESS_ENV.githubApiUrl);
  }
  // HTTPS only: the run's tokens go there (security review). Tests use `off`.
  if (
    url.protocol !== 'https:' ||
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    throw invalid(PROCESS_ENV.githubApiUrl);
  }
  return url.toString();
}

function invalid(name: string): RunnerError {
  return new RunnerError('runner.config.invalid_setting', { name });
}

export function processSettingsFromEnv(env: NodeJS.ProcessEnv = process.env): ProcessSettings {
  const host = env[PROCESS_ENV.dbHost] || 'postgres';
  const rawPort = env[PROCESS_ENV.dbPort] || '5432';
  const name = env[PROCESS_ENV.dbName] || 'platform';
  const secretPath = env[PROCESS_ENV.dbSecretPath] || 'runner/database';
  const heartbeatFile =
    env[PROCESS_ENV.heartbeatFile] || path.join(os.tmpdir(), 'sdlc-runner-heartbeat');
  const port = Number(rawPort);
  if (!HOST.test(host)) throw invalid(PROCESS_ENV.dbHost);
  if (!/^[0-9]{1,5}$/.test(rawPort) || port < 1 || port > 65535) throw invalid(PROCESS_ENV.dbPort);
  if (!DB_NAME.test(name)) throw invalid(PROCESS_ENV.dbName);
  if (!SECRET_PATH.test(secretPath)) throw invalid(PROCESS_ENV.dbSecretPath);
  if (!path.isAbsolute(heartbeatFile)) throw invalid(PROCESS_ENV.heartbeatFile);
  const address = env[PROCESS_ENV.temporalAddress] || 'temporal:7233';
  const namespace = env[PROCESS_ENV.temporalNamespace] || 'default';
  if (address !== 'off' && !TEMPORAL_ADDRESS.test(address)) {
    throw invalid(PROCESS_ENV.temporalAddress);
  }
  if (!TEMPORAL_NAMESPACE.test(namespace)) throw invalid(PROCESS_ENV.temporalNamespace);
  return {
    db: { host, port, name, secretPath },
    heartbeatFile,
    temporal: address === 'off' ? null : { address, namespace },
    evidence: evidenceSettings(env),
    githubApiUrl: githubApiUrl(env),
  };
}
