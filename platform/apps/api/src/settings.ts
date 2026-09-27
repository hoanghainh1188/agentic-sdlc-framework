// Settings of the api process (task B03, ADR-M26 section 2.6). Infrastructure settings come from
// the environment, never from project configuration. No secret is ever read from an environment
// variable: the database password comes from OpenBao, the AppRole credentials from files.
import { z } from 'zod';

export const API_ENV = {
  host: 'SDLC_API_HOST',
  port: 'SDLC_API_PORT',
  dbHost: 'SDLC_API_DB_HOST',
  dbPort: 'SDLC_API_DB_PORT',
  dbName: 'SDLC_API_DB_NAME',
  dbSecretPath: 'SDLC_API_DB_SECRET_PATH',
  rateLimitPerMinute: 'SDLC_API_RATE_LIMIT_PER_MINUTE',
  authFailuresPerMinute: 'SDLC_API_AUTH_FAILURES_PER_MINUTE',
  devMode: 'SDLC_API_DEV_MODE',
  devDbUrl: 'SDLC_API_DEV_DB_URL',
} as const;

/** The database role of every platform process (ADR-M09 section 2.3). */
export const DB_USER = 'platform_app';

const port = z.coerce.number().int().min(1).max(65_535);
const perMinute = z.coerce.number().int().min(1).max(100_000);

const schema = z.object({
  [API_ENV.host]: z.string().min(1).default('127.0.0.1'),
  [API_ENV.port]: port.default(8080),
  [API_ENV.dbHost]: z.string().min(1).default('postgres'),
  [API_ENV.dbPort]: port.default(5432),
  [API_ENV.dbName]: z
    .string()
    .regex(/^[a-z_][a-z0-9_]{0,62}$/)
    .default('platform'),
  // Path in the KV engine; the `api` AppRole may read `kv/data/api/*` only (ADR-M19 section 2.4).
  [API_ENV.dbSecretPath]: z
    .string()
    .regex(/^api\/[A-Za-z0-9_.-]+$/)
    .default('api/database'),
  [API_ENV.rateLimitPerMinute]: perMinute.default(120),
  [API_ENV.authFailuresPerMinute]: perMinute.default(10),
  [API_ENV.devMode]: z.enum(['', '0', '1']).default(''),
  [API_ENV.devDbUrl]: z.string().optional(),
  NODE_ENV: z.string().optional(),
});

export type Database =
  | {
      readonly kind: 'openbao';
      readonly host: string;
      readonly port: number;
      readonly name: string;
      readonly secretPath: string;
    }
  | { readonly kind: 'dev_url'; readonly url: string };

export interface ApiSettings {
  readonly host: string;
  readonly port: number;
  readonly database: Database;
  readonly rateLimitPerMinute: number;
  readonly authFailuresPerMinute: number;
}

/** A setting is missing or wrong. `key` is a message catalog key; `name` the variable. */
export class SettingsError extends Error {
  override readonly name = 'SettingsError';

  constructor(
    readonly key:
      | 'api.settings.invalid'
      | 'api.settings.dev_mode_in_production'
      | 'api.settings.dev_url_missing',
    readonly setting: string,
  ) {
    super(`${key}: ${setting}`);
  }
}

export function loadSettings(env: Readonly<Record<string, string | undefined>>): ApiSettings {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    throw new SettingsError('api.settings.invalid', String(parsed.error.issues[0]?.path[0] ?? ''));
  }
  const v = parsed.data;
  const dev = v[API_ENV.devMode] === '1';
  if (dev && v.NODE_ENV === 'production') {
    throw new SettingsError('api.settings.dev_mode_in_production', API_ENV.devMode);
  }
  let database: Database;
  if (dev) {
    const url = v[API_ENV.devDbUrl];
    if (!url) throw new SettingsError('api.settings.dev_url_missing', API_ENV.devDbUrl);
    database = { kind: 'dev_url', url };
  } else {
    database = {
      kind: 'openbao',
      host: v[API_ENV.dbHost],
      port: v[API_ENV.dbPort],
      name: v[API_ENV.dbName],
      secretPath: v[API_ENV.dbSecretPath],
    };
  }
  return {
    host: v[API_ENV.host],
    port: v[API_ENV.port],
    database,
    rateLimitPerMinute: v[API_ENV.rateLimitPerMinute],
    authFailuresPerMinute: v[API_ENV.authFailuresPerMinute],
  };
}
