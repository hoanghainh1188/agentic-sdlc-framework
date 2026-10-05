// The worker's audit anchor store (task E05 PR 2, design/ADR-M51 §2.9; D-05 §7.4). The SeaweedFS
// identity `worker-anchor` comes from OpenBao (`kv/worker/anchor`, written by
// `openbao:bootstrap worker-anchor-credentials`): `Write`, `Read`, `List` and
// `GetObjectRetention` on the bucket `audit-anchors` only (object lock COMPLIANCE: its write can
// never delete a version). A missing credential is a warning at start, not a failure: no anchors.
import { S3AuditAnchorStore } from '@sdlc/adapter-evidence-s3';
import type { SecretReader } from '@sdlc/contracts';
import type { PlatformLogger } from '@sdlc/core';
import { t } from '@sdlc/messages';
import { SecretsError } from '@sdlc/secrets';

import { EVIDENCE_ACCESS_KEY_FIELD, EVIDENCE_SECRET_KEY_FIELD } from './evidence-store.js';
import type { WorkerSettings } from './settings.js';

export async function openAnchorStore(
  settings: WorkerSettings['anchor'],
  secrets: SecretReader,
  log: PlatformLogger,
): Promise<S3AuditAnchorStore | undefined> {
  if (!settings) {
    log.log('warn', 'worker.anchor_off', { message: t('worker.start.anchor_off') });
    return undefined;
  }
  const missing = () => {
    log.log('warn', 'worker.anchor_missing', { message: t('worker.start.anchor_missing') });
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
  return new S3AuditAnchorStore({
    endpoint: settings.url,
    bucket: settings.bucket,
    accessKeyId,
    secretAccessKey,
  });
}
