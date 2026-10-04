// Settings of the api process (task B03, ADR-M26 section 2.6). Infrastructure settings come from
// the environment, never from project configuration. No secret is ever read from an environment
// variable: the database password comes from OpenBao, the AppRole credentials from files.
import { TEMPORAL_ADDRESS, TEMPORAL_NAMESPACE, type TemporalSettings } from '@sdlc/workflow-client';
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
  temporalAddress: 'SDLC_API_TEMPORAL_ADDRESS',
  temporalNamespace: 'SDLC_API_TEMPORAL_NAMESPACE',
  githubApiUrl: 'SDLC_API_GITHUB_API_URL',
  evidenceUrl: 'SDLC_API_EVIDENCE_URL',
  evidenceBucket: 'SDLC_API_EVIDENCE_BUCKET',
  evidenceSecretPath: 'SDLC_API_EVIDENCE_SECRET_PATH',
  evidenceMaxItemMb: 'SDLC_API_EVIDENCE_MAX_ITEM_MB',
} as const;

/** Fields of the KV entry written by `openbao:bootstrap api-evidence-credentials` (E02). */
export const EVIDENCE_ACCESS_KEY_FIELD = 'access_key';
export const EVIDENCE_SECRET_KEY_FIELD = 'secret_key';
/** The api writes Evidence Packs under this prefix only (SeaweedFS `Write:evidence/packs/*`). */
export const EVIDENCE_PACK_KEY_PREFIX = 'packs/';

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
  // The intent workflow (B07, ADR-M30); `off`: no wake signals, development mode only.
  [API_ENV.temporalAddress]: z
    .string()
    .refine((v) => v === 'off' || TEMPORAL_ADDRESS.test(v))
    .default('temporal:7233'),
  [API_ENV.temporalNamespace]: z.string().regex(TEMPORAL_NAMESPACE).default('default'),
  // The Git host the spec endpoints read (B08, ADR-M39 §2.2); the App key comes from OpenBao.
  [API_ENV.githubApiUrl]: z
    .string()
    .regex(/^https:\/\/[^\s]+$/)
    .default('https://api.github.com'),
  // The Evidence Pack store (E02, ADR-M48): SeaweedFS's S3 API on the Compose network; `off`
  // turns the pack endpoints off (they answer evidence_unavailable). An origin only.
  [API_ENV.evidenceUrl]: z
    .string()
    .refine((v) => v === 'off' || isOrigin(v))
    .default('http://seaweedfs:8333'),
  [API_ENV.evidenceBucket]: z
    .string()
    .regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/)
    .default('evidence'),
  [API_ENV.evidenceSecretPath]: z
    .string()
    .regex(/^api\/[A-Za-z0-9_.-]+$/)
    .default('api/evidence'),
  // The largest evidence file the api reads back to check its hash, one file at a time.
  [API_ENV.evidenceMaxItemMb]: z.coerce.number().int().min(1).max(4096).default(256),
  NODE_ENV: z.string().optional(),
});

function isOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      ['http:', 'https:'].includes(url.protocol) &&
      url.username === '' &&
      url.password === '' &&
      url.pathname === '/' &&
      url.search === '' &&
      url.hash === '' &&
      !value.endsWith('#') &&
      !value.endsWith('?')
    );
  } catch {
    return false;
  }
}

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
  /** Where to wake intent workflows (B07); null: no signals (development only). */
  readonly temporal: TemporalSettings | null;
  /** GitHub API base URL for the spec endpoints (B08). */
  readonly githubApiUrl: string;
  /** The Evidence Pack store (E02, ADR-M48); null: `SDLC_API_EVIDENCE_URL=off`. */
  readonly evidence: {
    readonly url: string;
    readonly bucket: string;
    readonly secretPath: string;
    readonly maxItemBytes: number;
  } | null;
}

/** A setting is missing or wrong. `key` is a message catalog key; `name` the variable. */
export class SettingsError extends Error {
  override readonly name = 'SettingsError';

  constructor(
    readonly key:
      | 'api.settings.invalid'
      | 'api.settings.dev_mode_in_production'
      | 'api.settings.dev_url_missing'
      | 'api.settings.temporal_off_in_production',
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
  const temporalOff = v[API_ENV.temporalAddress] === 'off';
  if (temporalOff && !dev) {
    throw new SettingsError('api.settings.temporal_off_in_production', API_ENV.temporalAddress);
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
    githubApiUrl: v[API_ENV.githubApiUrl],
    evidence:
      v[API_ENV.evidenceUrl] === 'off'
        ? null
        : {
            url: new URL(v[API_ENV.evidenceUrl]).origin,
            bucket: v[API_ENV.evidenceBucket],
            secretPath: v[API_ENV.evidenceSecretPath],
            maxItemBytes: v[API_ENV.evidenceMaxItemMb] * 1024 * 1024,
          },
    temporal: temporalOff
      ? null
      : { address: v[API_ENV.temporalAddress], namespace: v[API_ENV.temporalNamespace] },
  };
}
