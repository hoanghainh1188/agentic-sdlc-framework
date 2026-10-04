// The worker's retention store (task E05, design/ADR-M51). The SeaweedFS identity `worker-purge`
// comes from OpenBao (`kv/worker/purge`, written by `openbao:bootstrap worker-purge-credentials`):
// it may delete under `evidence/proposals/*`, `evidence/diffs/*` and `evidence/packs/*` (SeaweedFS
// `Write`), list the bucket, bypass the GOVERNANCE lock, and set legal holds and locks; it never
// reads a file. A missing credential is a warning at start, not a failure: no retention loop.
import { S3RetentionStore } from '@sdlc/adapter-evidence-s3';
import type { SecretReader } from '@sdlc/contracts';
import type { PlatformLogger } from '@sdlc/core';
import { t } from '@sdlc/messages';
import { SecretsError } from '@sdlc/secrets';

import { EVIDENCE_ACCESS_KEY_FIELD, EVIDENCE_SECRET_KEY_FIELD } from './evidence-store.js';
import type { WorkerSettings } from './settings.js';

/** The prefixes the purge identity works under (ADR-M51 §2.3). */
export const RETENTION_PREFIXES = ['proposals/', 'diffs/', 'packs/'] as const;

export async function openRetentionStore(
  settings: WorkerSettings['retention'],
  secrets: SecretReader,
  log: PlatformLogger,
): Promise<S3RetentionStore | undefined> {
  if (!settings) {
    log.log('warn', 'worker.retention_off', { message: t('worker.start.retention_off') });
    return undefined;
  }
  const missing = () => {
    log.log('warn', 'worker.retention_missing', {
      message: t('worker.start.retention_missing'),
    });
    return undefined;
  };
  let entry;
  try {
    entry = await secrets.read(settings.secretPath);
  } catch (error) {
    if (!(error instanceof SecretsError) || error.key !== 'secrets.not_found') throw error;
    return missing();
  }
  const accessKeyId = entry.data[EVIDENCE_ACCESS_KEY_FIELD];
  const secretAccessKey = entry.data[EVIDENCE_SECRET_KEY_FIELD];
  if (!accessKeyId || !secretAccessKey) return missing();
  return new S3RetentionStore({
    endpoint: settings.url,
    bucket: settings.bucket,
    prefixes: RETENTION_PREFIXES,
    accessKeyId,
    secretAccessKey,
  });
}
