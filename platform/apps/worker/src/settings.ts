// Settings of the worker process (task B06, design/ADR-M27 section 2.5). Infrastructure settings
// come from the environment, never from project configuration: the polling interval of each
// project is project configuration (`github.poll_interval_seconds`). No secret is ever read from an
// environment variable: the database password and the GitHub App key come from OpenBao, the
// AppRole credentials from files (ADR-M21).
import { z } from 'zod';

export const WORKER_ENV = {
  dbHost: 'SDLC_WORKER_DB_HOST',
  dbPort: 'SDLC_WORKER_DB_PORT',
  dbName: 'SDLC_WORKER_DB_NAME',
  dbSecretPath: 'SDLC_WORKER_DB_SECRET_PATH',
  githubApiUrl: 'SDLC_WORKER_GITHUB_API_URL',
  tickMs: 'SDLC_WORKER_TICK_MS',
  maxConcurrentPolls: 'SDLC_WORKER_MAX_CONCURRENT_POLLS',
  maxReplyAttempts: 'SDLC_WORKER_MAX_REPLY_ATTEMPTS',
  heartbeatFile: 'SDLC_WORKER_HEARTBEAT_FILE',
  devMode: 'SDLC_WORKER_DEV_MODE',
  devDbUrl: 'SDLC_WORKER_DEV_DB_URL',
} as const;

/** The database role of every platform process (ADR-M09 section 2.3). */
export const DB_USER = 'platform_app';

const port = z.coerce.number().int().min(1).max(65_535);

const schema = z.object({
  [WORKER_ENV.dbHost]: z.string().min(1).default('postgres'),
  [WORKER_ENV.dbPort]: port.default(5432),
  [WORKER_ENV.dbName]: z
    .string()
    .regex(/^[a-z_][a-z0-9_]{0,62}$/)
    .default('platform'),
  // Path in the KV engine; the `worker` AppRole may read `kv/data/worker/*` only (ADR-M19 §2.4).
  [WORKER_ENV.dbSecretPath]: z
    .string()
    .regex(/^worker\/[A-Za-z0-9_.-]+$/)
    .default('worker/database'),
  [WORKER_ENV.githubApiUrl]: z
    .string()
    .regex(/^https:\/\/[^\s]+$/)
    .default('https://api.github.com'),
  [WORKER_ENV.tickMs]: z.coerce.number().int().min(100).max(60_000).default(1000),
  [WORKER_ENV.maxConcurrentPolls]: z.coerce.number().int().min(1).max(32).default(4),
  [WORKER_ENV.maxReplyAttempts]: z.coerce.number().int().min(1).max(100).default(5),
  [WORKER_ENV.heartbeatFile]: z.string().min(1).default('/tmp/sdlc-worker.heartbeat'),
  [WORKER_ENV.devMode]: z.enum(['', '0', '1']).default(''),
  [WORKER_ENV.devDbUrl]: z.string().optional(),
  NODE_ENV: z.string().optional(),
});

export type WorkerDatabase =
  | {
      readonly kind: 'openbao';
      readonly host: string;
      readonly port: number;
      readonly name: string;
      readonly secretPath: string;
    }
  | { readonly kind: 'dev_url'; readonly url: string };

export interface WorkerSettings {
  readonly database: WorkerDatabase;
  readonly githubApiUrl: string;
  /** How often the loop checks which projects are due (not the polling interval). */
  readonly tickMs: number;
  readonly maxConcurrentPolls: number;
  readonly maxReplyAttempts: number;
  readonly heartbeatFile: string;
}

export type WorkerSettingsKey =
  | 'worker.settings.invalid'
  | 'worker.settings.dev_mode_in_production'
  | 'worker.settings.dev_url_missing';

/** A setting is missing or wrong. `key` is a message catalog key; `setting` the variable. */
export class SettingsError extends Error {
  override readonly name = 'SettingsError';

  constructor(
    readonly key: WorkerSettingsKey,
    readonly setting: string,
  ) {
    super(`${key}: ${setting}`);
  }
}

export function loadSettings(env: Readonly<Record<string, string | undefined>>): WorkerSettings {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    throw new SettingsError(
      'worker.settings.invalid',
      String(parsed.error.issues[0]?.path[0] ?? ''),
    );
  }
  const v = parsed.data;
  const dev = v[WORKER_ENV.devMode] === '1';
  if (dev && v.NODE_ENV === 'production') {
    throw new SettingsError('worker.settings.dev_mode_in_production', WORKER_ENV.devMode);
  }
  let database: WorkerDatabase;
  if (dev) {
    const url = v[WORKER_ENV.devDbUrl];
    if (!url) throw new SettingsError('worker.settings.dev_url_missing', WORKER_ENV.devDbUrl);
    database = { kind: 'dev_url', url };
  } else {
    database = {
      kind: 'openbao',
      host: v[WORKER_ENV.dbHost],
      port: v[WORKER_ENV.dbPort],
      name: v[WORKER_ENV.dbName],
      secretPath: v[WORKER_ENV.dbSecretPath],
    };
  }
  return {
    database,
    githubApiUrl: v[WORKER_ENV.githubApiUrl],
    tickMs: v[WORKER_ENV.tickMs],
    maxConcurrentPolls: v[WORKER_ENV.maxConcurrentPolls],
    maxReplyAttempts: v[WORKER_ENV.maxReplyAttempts],
    heartbeatFile: v[WORKER_ENV.heartbeatFile],
  };
}
