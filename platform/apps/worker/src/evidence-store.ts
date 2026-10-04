// The worker's evidence store (task E03, design/ADR-M49 §2.2). The SeaweedFS identity
// `worker-evidence` comes from OpenBao (`kv/worker/evidence`, written by `openbao:bootstrap
// worker-evidence-credentials`): it may read `evidence/proposals/*` and `evidence/diffs/*` (to
// re-check their hashes) and read and write `evidence/packs/*`, like the api's `api-evidence`. A
// missing credential is a warning at start, not a failure: intents then wait at G8.
import { S3EvidenceStore } from '@sdlc/adapter-evidence-s3';
import type { SecretReader } from '@sdlc/contracts';
import type { PlatformLogger } from '@sdlc/core';
import { t } from '@sdlc/messages';
import { SecretsError } from '@sdlc/secrets';

import type { ReleaseDeps } from './activities/intent-activities.js';
import type { WorkerSettings } from './settings.js';

/** Fields of the KV entry (the same as the api's, E02). */
export const EVIDENCE_ACCESS_KEY_FIELD = 'access_key';
export const EVIDENCE_SECRET_KEY_FIELD = 'secret_key';
/** Evidence Packs are written under this prefix only (SeaweedFS `Write:evidence/packs/*`). */
export const EVIDENCE_PACK_KEY_PREFIX = 'packs/';

export async function openWorkerEvidence(
  settings: WorkerSettings['evidence'],
  secrets: SecretReader,
  log: PlatformLogger,
): Promise<ReleaseDeps | undefined> {
  if (!settings) {
    log.log('warn', 'worker.evidence_off', { message: t('worker.start.evidence_off') });
    return undefined;
  }
  const missing = () => {
    log.log('warn', 'worker.evidence_missing', { message: t('worker.start.evidence_missing') });
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
  return {
    store: new S3EvidenceStore({
      endpoint: settings.url,
      bucket: settings.bucket,
      keyPrefix: EVIDENCE_PACK_KEY_PREFIX,
      accessKeyId,
      secretAccessKey,
    }),
    maxItemBytes: settings.maxItemBytes,
  };
}
