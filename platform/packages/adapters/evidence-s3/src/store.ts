// Evidence store on the S3 API of SeaweedFS (design/D-03 section 7.5, task C06 session 2b,
// design/ADR-M33 §2.9). `@aws-sdk/client-s3` 3.1141.0, pinned exactly (no install scripts).
//
// - Keys: `<keyPrefix><tenant>/<path>`. The runner's identity may write only under its prefix
//   (`proposals/`, `diffs/`; SeaweedFS actions `Write:evidence/proposals/*`,
//   `Write:evidence/diffs/*`), and may not read or list.
// - Never overwritten: every put sends `If-None-Match: *`; SeaweedFS answers 412 when the key
//   exists, which becomes `EvidenceError('exists')`.
// - Errors are codes; no text from the service leaves this module.
import { createHash } from 'node:crypto';

import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
} from '@aws-sdk/client-s3';
import {
  EvidenceError,
  type EvidenceGetOptions,
  type EvidenceStore,
  type RedactedSecret,
  type StoredEvidence,
} from '@sdlc/contracts';

export interface S3EvidenceStoreOptions {
  /** For example `http://seaweedfs:8333` (Compose network). No path, no credentials. */
  readonly endpoint: string;
  readonly bucket: string;
  /** Prefix of every key this store writes, for example `proposals/` (ends with `/`). */
  readonly keyPrefix: string;
  readonly accessKeyId: RedactedSecret;
  readonly secretAccessKey: RedactedSecret;
  /** Per request; default 30 000 ms. */
  readonly timeoutMs?: number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const BUCKET = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
const PREFIX = /^([a-z0-9][a-z0-9_-]{0,62}\/)*$/;
const CONTENT_TYPE = /^[a-z]+\/[a-z0-9.+-]+$/;

/** Relative, `/`-separated, each segment a plain name (no `.`, `..`, empty or odd characters). */
function checkPath(path: string): string {
  const parts = path.split('/');
  if (path.length > 512 || !parts.every((part) => SEGMENT.test(part) && part !== '..')) {
    throw new EvidenceError('invalid_input');
  }
  return path;
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

export class S3EvidenceStore implements EvidenceStore {
  readonly #client: S3Client;
  readonly #bucket: string;
  readonly #prefix: string;

  constructor(options: S3EvidenceStoreOptions) {
    const endpoint = new URL(options.endpoint);
    if (
      !['http:', 'https:'].includes(endpoint.protocol) ||
      endpoint.username ||
      endpoint.password ||
      endpoint.pathname !== '/' ||
      endpoint.search
    ) {
      throw new EvidenceError('invalid_input');
    }
    if (!BUCKET.test(options.bucket) || !PREFIX.test(options.keyPrefix)) {
      throw new EvidenceError('invalid_input');
    }
    this.#bucket = options.bucket;
    this.#prefix = options.keyPrefix;
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
    tenantId: string,
    path: string,
    content: Buffer,
    contentType: string,
  ): Promise<StoredEvidence> {
    if (!UUID.test(tenantId) || !CONTENT_TYPE.test(contentType)) {
      throw new EvidenceError('invalid_input');
    }
    const key = `${this.#prefix}${tenantId}/${checkPath(path)}`;
    const sha256 = createHash('sha256').update(content).digest('hex');
    try {
      await this.#client.send(
        new PutObjectCommand({
          Bucket: this.#bucket,
          Key: key,
          Body: content,
          ContentType: contentType,
          ContentLength: content.length,
          IfNoneMatch: '*',
        }),
      );
    } catch (error) {
      throw codeOf(error);
    }
    return { uri: `s3://${this.#bucket}/${key}`, sha256, sizeBytes: content.length };
  }

  /**
   * Reads a file. With `maxBytes` (E02, ADR-M48), a file whose `Content-Length` is larger, or
   * missing, is refused before its body is read, and the body is checked again after reading.
   */
  async get(uri: string, options: EvidenceGetOptions = {}): Promise<Buffer> {
    const prefix = `s3://${this.#bucket}/`;
    if (!uri.startsWith(prefix)) throw new EvidenceError('invalid_input');
    const key = checkPath(uri.slice(prefix.length));
    const { maxBytes } = options;
    if (maxBytes !== undefined && (!Number.isSafeInteger(maxBytes) || maxBytes < 0)) {
      throw new EvidenceError('invalid_input');
    }
    try {
      const answer = await this.#client.send(
        new GetObjectCommand({ Bucket: this.#bucket, Key: key }),
      );
      if (!answer.Body) throw new EvidenceError('not_found');
      if (
        maxBytes !== undefined &&
        (answer.ContentLength === undefined || answer.ContentLength > maxBytes)
      ) {
        // Close the connection without reading the body (a Node.js stream in this SDK).
        (answer.Body as unknown as { destroy?: () => void }).destroy?.();
        throw new EvidenceError('too_large');
      }
      const body = Buffer.from(await answer.Body.transformToByteArray());
      if (maxBytes !== undefined && body.length > maxBytes) throw new EvidenceError('too_large');
      return body;
    } catch (error) {
      throw codeOf(error);
    }
  }

  /** Closes the HTTP connections. */
  destroy(): void {
    this.#client.destroy();
  }
}
