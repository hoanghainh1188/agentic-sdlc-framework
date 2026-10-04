// The audit anchor store on the S3 API of SeaweedFS (task E05 PR 2, design/ADR-M51 §2.9; D-05
// §7.4). Used only by the worker with the identity `worker-anchor`: `Write`, `Read`, `List` and
// `GetObjectRetention` on the bucket `audit-anchors`, nothing else.
//
// - The bucket is versioned with an object lock COMPLIANCE (731 days by default): no version can be
//   deleted or its lock shortened, the admin included (checked live on SeaweedFS 4.48).
// - Every put sends `If-None-Match: *`: a second write of the same key gets 412 (`exists`).
// - Keys are `<tenant id>/<YYYY-MM-DD>.json` only. Errors are codes; no service text leaves here.
import {
  GetObjectCommand,
  GetObjectRetentionCommand,
  ListObjectVersionsCommand,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
} from '@aws-sdk/client-s3';
import {
  EvidenceError,
  type AuditAnchorRetention,
  type AuditAnchorStore,
  type AuditAnchorVersion,
  type RedactedSecret,
} from '@sdlc/contracts';

export interface S3AuditAnchorStoreOptions {
  /** For example `http://seaweedfs:8333` (Compose network). No path, no credentials. */
  readonly endpoint: string;
  /** `audit-anchors`. */
  readonly bucket: string;
  readonly accessKeyId: RedactedSecret;
  readonly secretAccessKey: RedactedSecret;
  /** Per request; default 30 000 ms. */
  readonly timeoutMs?: number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** `<tenant id>/<YYYY-MM-DD>.json`. The date is checked as a real date by the caller. */
export const AUDIT_ANCHOR_KEY =
  /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/(\d{4}-\d{2}-\d{2})\.json$/;
const BUCKET = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
/** More versions than this under one tenant: refused (`unavailable`) instead of a long loop. */
export const MAX_ANCHOR_VERSIONS = 10_000;

function checkKey(key: string): string {
  if (!AUDIT_ANCHOR_KEY.test(key)) throw new EvidenceError('invalid_input');
  return key;
}

function codeOf(error: unknown): EvidenceError {
  if (error instanceof EvidenceError) return error;
  if (error instanceof S3ServiceException) {
    const status = error.$metadata.httpStatusCode;
    if (status === 412) return new EvidenceError('exists');
    if (status === 403 || status === 401) return new EvidenceError('forbidden');
    if (status === 404) return new EvidenceError('not_found');
  }
  return new EvidenceError('unavailable');
}

export class S3AuditAnchorStore implements AuditAnchorStore {
  readonly #client: S3Client;
  readonly #bucket: string;

  constructor(options: S3AuditAnchorStoreOptions) {
    const endpoint = new URL(options.endpoint);
    if (
      !['http:', 'https:'].includes(endpoint.protocol) ||
      endpoint.username ||
      endpoint.password ||
      endpoint.pathname !== '/' ||
      endpoint.search ||
      !BUCKET.test(options.bucket)
    ) {
      throw new EvidenceError('invalid_input');
    }
    this.#bucket = options.bucket;
    this.#client = new S3Client({
      endpoint: endpoint.origin,
      region: 'us-east-1',
      forcePathStyle: true,
      maxAttempts: 2,
      requestHandler: { requestTimeout: options.timeoutMs ?? 30_000 },
      credentials: {
        accessKeyId: options.accessKeyId.reveal(),
        secretAccessKey: options.secretAccessKey.reveal(),
      },
    });
  }

  async put(
    key: string,
    content: Buffer,
  ): Promise<
    { readonly outcome: 'written'; readonly versionId: string } | { readonly outcome: 'exists' }
  > {
    checkKey(key);
    try {
      const answer = await this.#client.send(
        new PutObjectCommand({
          Bucket: this.#bucket,
          Key: key,
          Body: content,
          ContentType: 'application/json',
          ContentLength: content.length,
          IfNoneMatch: '*',
        }),
      );
      // A versioned bucket always names the version; without one the lock cannot be checked.
      if (!answer.VersionId) throw new EvidenceError('unavailable');
      return { outcome: 'written', versionId: answer.VersionId };
    } catch (error) {
      const code = codeOf(error);
      if (code.code === 'exists') return { outcome: 'exists' };
      throw code;
    }
  }

  async listVersions(tenantId: string): Promise<readonly AuditAnchorVersion[]> {
    if (!UUID.test(tenantId)) throw new EvidenceError('invalid_input');
    const prefix = `${tenantId}/`;
    const found: AuditAnchorVersion[] = [];
    let keyMarker: string | undefined;
    let versionMarker: string | undefined;
    try {
      for (;;) {
        const answer = await this.#client.send(
          new ListObjectVersionsCommand({
            Bucket: this.#bucket,
            Prefix: prefix,
            ...(keyMarker !== undefined ? { KeyMarker: keyMarker } : {}),
            ...(versionMarker !== undefined ? { VersionIdMarker: versionMarker } : {}),
          }),
        );
        const entries = [
          ...(answer.Versions ?? []).map((v) => ({ ...v, marker: false })),
          ...(answer.DeleteMarkers ?? []).map((m) => ({ ...m, marker: true })),
        ];
        for (const entry of entries) {
          // Any key under the tenant's folder is kept, also a malformed one: the caller reports it.
          if (!entry.Key?.startsWith(prefix) || !entry.VersionId) continue;
          found.push({ key: entry.Key, versionId: entry.VersionId, deleteMarker: entry.marker });
        }
        if (found.length > MAX_ANCHOR_VERSIONS) throw new EvidenceError('unavailable');
        if (answer.IsTruncated !== true) break;
        if (answer.NextKeyMarker === undefined) throw new EvidenceError('unavailable');
        keyMarker = answer.NextKeyMarker;
        versionMarker = answer.NextVersionIdMarker;
      }
    } catch (error) {
      throw codeOf(error);
    }
    return found.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  }

  async get(key: string, versionId: string, maxBytes: number): Promise<Buffer> {
    checkKey(key);
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new EvidenceError('invalid_input');
    try {
      const answer = await this.#client.send(
        new GetObjectCommand({ Bucket: this.#bucket, Key: key, VersionId: versionId }),
      );
      if (!answer.Body) throw new EvidenceError('not_found');
      if (answer.ContentLength === undefined || answer.ContentLength > maxBytes) {
        (answer.Body as unknown as { destroy?: () => void }).destroy?.();
        throw new EvidenceError('too_large');
      }
      const body = Buffer.from(await answer.Body.transformToByteArray());
      if (body.length > maxBytes) throw new EvidenceError('too_large');
      return body;
    } catch (error) {
      throw codeOf(error);
    }
  }

  async retention(key: string, versionId: string): Promise<AuditAnchorRetention | null> {
    checkKey(key);
    try {
      const answer = await this.#client.send(
        new GetObjectRetentionCommand({ Bucket: this.#bucket, Key: key, VersionId: versionId }),
      );
      const mode = answer.Retention?.Mode;
      const until = answer.Retention?.RetainUntilDate;
      if ((mode !== 'COMPLIANCE' && mode !== 'GOVERNANCE') || !until) return null;
      return { mode, until };
    } catch (error) {
      if (error instanceof S3ServiceException && error.$metadata.httpStatusCode === 404) {
        return null;
      }
      throw codeOf(error);
    }
  }

  /** Closes the HTTP connections. */
  destroy(): void {
    this.#client.destroy();
  }
}
