// The worker's Langfuse purge stores (task E08, design/ADR-M53). One OpenBao entry,
// `kv/worker/langfuse`, written by `openbao:bootstrap worker-langfuse-credentials`; only the
// `worker` AppRole reads `kv/data/worker/*` (AC2):
// - `langfuse_public_key`, `langfuse_secret_key`: the worker's own Langfuse project key, made once
//   by an operator in the Langfuse UI (runbook T11 §5m; QUESTIONS #252). The collector keeps its own.
// - `clickhouse_password`: the ClickHouse user `sdlc_purge` (only `ALTER DELETE` on the two event
//   tables; QUESTIONS #251).
// - `access_key`, `secret_key`: the SeaweedFS identity `worker-langfuse` (List on the bucket
//   `langfuse`, delete under `langfuse/events/otel/*`, never read; QUESTIONS #250).
//
// `SDLC_WORKER_LANGFUSE_URL=off`: not deployed. Configured but the entry is missing or incomplete:
// `unavailable` (a warning at start): nothing is purged in Langfuse and archived projects wait.
import { S3RetentionStore } from '@sdlc/adapter-evidence-s3';
import { LangfuseTraceStore } from '@sdlc/adapter-traces-langfuse';
import type { SecretReader } from '@sdlc/contracts';
import type { LangfusePurgeDeps, LangfusePurgeState, PlatformLogger } from '@sdlc/core';
import { t } from '@sdlc/messages';
import { SecretsError } from '@sdlc/secrets';

import { EVIDENCE_ACCESS_KEY_FIELD, EVIDENCE_SECRET_KEY_FIELD } from './evidence-store.js';
import type { WorkerLangfuseSettings } from './settings.js';

export const LANGFUSE_PUBLIC_KEY_FIELD = 'langfuse_public_key';
export const LANGFUSE_SECRET_KEY_FIELD = 'langfuse_secret_key';
export const CLICKHOUSE_PASSWORD_FIELD = 'clickhouse_password';
/** The ClickHouse user `worker-langfuse-credentials` makes (ADR-M53 §2.3). */
export const CLICKHOUSE_PURGE_USER = 'sdlc_purge';
/** The prefix of Langfuse's raw OTLP files in its bucket (4.47.0, `LANGFUSE_S3_EVENT_UPLOAD_PREFIX`). */
export const LANGFUSE_RAW_PREFIX = 'events/otel/';

export interface OpenedLangfusePurge {
  readonly deps: LangfusePurgeDeps;
  /** Closes the HTTP connections of the raw file store. */
  destroy(): void;
}

export async function openLangfusePurge(
  settings: WorkerLangfuseSettings | null,
  secrets: SecretReader,
  log: PlatformLogger,
  state: LangfusePurgeState,
  /** The evidence purge guard (`SDLC_WORKER_RETENTION_GUARD_*`), also applied to Langfuse. */
  guard: { readonly percent: number; readonly floor: number },
): Promise<OpenedLangfusePurge> {
  const none = (deps: LangfusePurgeDeps): OpenedLangfusePurge => ({ deps, destroy: () => {} });
  if (!settings) {
    log.log('warn', 'worker.langfuse_off', { message: t('worker.start.langfuse_off') });
    return none({ status: 'not_deployed' });
  }
  const missing = () => {
    log.log('warn', 'worker.langfuse_missing', { message: t('worker.start.langfuse_missing') });
    return none({ status: 'unavailable' });
  };
  let entry;
  try {
    entry = await secrets.read(settings.secretPath);
  } catch (error) {
    if (!(error instanceof SecretsError) || error.key !== 'secrets.not_found') throw error;
    return missing();
  }
  const publicKey = entry.data[LANGFUSE_PUBLIC_KEY_FIELD];
  const secretKey = entry.data[LANGFUSE_SECRET_KEY_FIELD];
  const password = entry.data[CLICKHOUSE_PASSWORD_FIELD];
  const accessKeyId = entry.data[EVIDENCE_ACCESS_KEY_FIELD];
  const secretAccessKey = entry.data[EVIDENCE_SECRET_KEY_FIELD];
  // An empty value counts as missing (only its length is read, never logged).
  const fields = [publicKey, secretKey, password, accessKeyId, secretAccessKey];
  if (fields.some((field) => field === undefined || field.reveal().length === 0)) return missing();
  if (!publicKey || !secretKey || !password || !accessKeyId || !secretAccessKey) return missing();
  const store = new LangfuseTraceStore({
    url: settings.url,
    publicKey,
    secretKey,
    clickhouse: { url: settings.clickhouseUrl, user: CLICKHOUSE_PURGE_USER, password },
  });
  const rawStore = new S3RetentionStore({
    endpoint: settings.rawUrl,
    bucket: settings.rawBucket,
    prefixes: [LANGFUSE_RAW_PREFIX],
    accessKeyId,
    secretAccessKey,
  });
  return {
    deps: {
      status: 'on',
      store,
      rawStore,
      rawPrefix: LANGFUSE_RAW_PREFIX,
      settings: {
        batch: settings.batch,
        rawMaxAgeHours: settings.rawMaxAgeHours,
        rawBatch: settings.rawBatch,
        projectId: settings.projectId,
        guardPercent: guard.percent,
        guardFloor: guard.floor,
      },
      state,
    },
    destroy: () => rawStore.destroy(),
  };
}
