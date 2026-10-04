// Evidence retention on the S3 API of SeaweedFS (task E05, design/ADR-M51; D-03 section 7.5).
// Used only by the worker's retention loop with the identity `worker-purge`: `Write` on the three
// evidence prefixes (write includes delete in SeaweedFS), `List` on the bucket,
// `BypassGovernanceRetention`, `PutObjectLegalHold` and `PutObjectRetention` (no read).
//
// - The bucket `evidence` is versioned with a GOVERNANCE lock (180 days by default, checked live on
//   SeaweedFS 4.48): a "deleted" key keeps its versions, so the purge deletes every version and
//   every delete marker of the key, then checks none is left.
// - The bypass header is sent only when the caller asks (`bypassLock`: an archived project, an
//   orphan pack file). A legal hold refuses even that.
// - Errors are codes; no text from the service leaves this module.
import {
  DeleteObjectCommand,
  GetObjectRetentionCommand,
  ListObjectVersionsCommand,
  PutObjectLegalHoldCommand,
  PutObjectRetentionCommand,
  S3Client,
  S3ServiceException,
  type ObjectLockRetentionMode,
} from '@aws-sdk/client-s3';
import {
  EvidenceError,
  type EvidenceKeyInfo,
  type EvidenceKeyPage,
  type EvidenceRetentionStore,
  type RedactedSecret,
} from '@sdlc/contracts';

export interface S3RetentionStoreOptions {
  /** For example `http://seaweedfs:8333` (Compose network). No path, no credentials. */
  readonly endpoint: string;
  readonly bucket: string;
  /** The prefixes the store may touch, for example `['proposals/', 'diffs/', 'packs/']`. */
  readonly prefixes: readonly string[];
  readonly accessKeyId: RedactedSecret;
  readonly secretAccessKey: RedactedSecret;
  /** Per request; default 30 000 ms. */
  readonly timeoutMs?: number;
}

/** More versions than this for one key: refused (`unavailable`) instead of a long loop. */
export const MAX_VERSIONS_PER_KEY = 1000;

const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const BUCKET = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
const PREFIX = /^([a-z0-9][a-z0-9_-]{0,62}\/)+$/;

function validKey(key: string): boolean {
  const parts = key.split('/');
  return key.length <= 700 && parts.every((part) => SEGMENT.test(part) && part !== '..');
}

function codeOf(error: unknown): EvidenceError {
  if (error instanceof EvidenceError) return error;
  if (error instanceof S3ServiceException) {
    const status = error.$metadata.httpStatusCode;
    if (status === 403 || status === 401) return new EvidenceError('forbidden');
    if (status === 404) return new EvidenceError('not_found');
  }
  return new EvidenceError('unavailable');
}

interface KeyVersion {
  readonly versionId: string;
  readonly deleteMarker: boolean;
}

export class S3RetentionStore implements EvidenceRetentionStore {
  readonly #client: S3Client;
  readonly #bucket: string;
  readonly #prefixes: readonly string[];

  constructor(options: S3RetentionStoreOptions) {
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
    if (
      !BUCKET.test(options.bucket) ||
      options.prefixes.length === 0 ||
      !options.prefixes.every((prefix) => PREFIX.test(prefix))
    ) {
      throw new EvidenceError('invalid_input');
    }
    this.#bucket = options.bucket;
    this.#prefixes = [...options.prefixes];
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

  /** The key of a URI of this store's bucket under one of its prefixes; else `invalid_input`. */
  keyOf(uri: string): string {
    const start = `s3://${this.#bucket}/`;
    if (!uri.startsWith(start)) throw new EvidenceError('invalid_input');
    const key = uri.slice(start.length);
    if (!validKey(key) || !this.#prefixes.some((prefix) => key.startsWith(prefix))) {
      throw new EvidenceError('invalid_input');
    }
    return key;
  }

  async deleteAllVersions(uri: string, options: { readonly bypassLock: boolean }): Promise<number> {
    const key = this.keyOf(uri);
    try {
      let deleted = 0;
      for (const version of await this.#versions(key)) {
        await this.#client.send(
          new DeleteObjectCommand({
            Bucket: this.#bucket,
            Key: key,
            VersionId: version.versionId,
            ...(options.bypassLock && !version.deleteMarker
              ? { BypassGovernanceRetention: true }
              : {}),
          }),
        );
        deleted += 1;
      }
      // Nothing may be left: a version written meanwhile, or one the service kept, fails.
      if ((await this.#versions(key)).length > 0) throw new EvidenceError('unavailable');
      return deleted;
    } catch (error) {
      throw codeOf(error);
    }
  }

  async setLegalHold(uri: string, on: boolean): Promise<number> {
    const key = this.keyOf(uri);
    try {
      let changed = 0;
      for (const version of await this.#versions(key)) {
        if (version.deleteMarker) continue;
        await this.#client.send(
          new PutObjectLegalHoldCommand({
            Bucket: this.#bucket,
            Key: key,
            VersionId: version.versionId,
            LegalHold: { Status: on ? 'ON' : 'OFF' },
          }),
        );
        changed += 1;
      }
      return changed;
    } catch (error) {
      throw codeOf(error);
    }
  }

  async extendLock(uri: string, until: Date): Promise<number> {
    const key = this.keyOf(uri);
    if (!Number.isFinite(until.getTime())) throw new EvidenceError('invalid_input');
    try {
      let changed = 0;
      for (const version of await this.#versions(key)) {
        if (version.deleteMarker) continue;
        const current = await this.#retention(key, version.versionId);
        if (current && current.until.getTime() >= until.getTime()) continue;
        await this.#client.send(
          new PutObjectRetentionCommand({
            Bucket: this.#bucket,
            Key: key,
            VersionId: version.versionId,
            // Keep the version's mode; a version without a lock gets the bucket's mode.
            Retention: { Mode: current?.mode ?? 'GOVERNANCE', RetainUntilDate: until },
          }),
        );
        changed += 1;
      }
      return changed;
    } catch (error) {
      throw codeOf(error);
    }
  }

  async listKeys(prefix: string, after: string | null, limit: number): Promise<EvidenceKeyPage> {
    if (!this.#prefixes.includes(prefix) || !Number.isSafeInteger(limit) || limit < 1) {
      throw new EvidenceError('invalid_input');
    }
    if (after !== null && (!validKey(after) || !after.startsWith(prefix))) {
      throw new EvidenceError('invalid_input');
    }
    try {
      const answer = await this.#client.send(
        new ListObjectVersionsCommand({
          Bucket: this.#bucket,
          Prefix: prefix,
          ...(after !== null ? { KeyMarker: after } : {}),
          MaxKeys: limit,
        }),
      );
      // Versions come newest first within a key: the first time seen is the newest.
      const newest = new Map<string, Date>();
      const entries = [...(answer.Versions ?? []), ...(answer.DeleteMarkers ?? [])];
      for (const entry of entries) {
        const key = entry.Key;
        if (!key || !validKey(key) || !key.startsWith(prefix)) continue;
        const time = entry.LastModified ?? new Date(0);
        const seen = newest.get(key);
        if (!seen || seen < time) newest.set(key, time);
      }
      const keys: EvidenceKeyInfo[] = [...newest.keys()]
        .sort()
        .map((key) => ({ uri: `s3://${this.#bucket}/${key}`, lastModified: newest.get(key)! }));
      const last =
        keys.length > 0 ? keys[keys.length - 1]!.uri.slice(`s3://${this.#bucket}/`.length) : null;
      return { keys, next: answer.IsTruncated === true && last !== null ? last : null };
    } catch (error) {
      throw codeOf(error);
    }
  }

  /** Closes the HTTP connections. */
  destroy(): void {
    this.#client.destroy();
  }

  /** Every version and delete marker of exactly `key`. */
  async #versions(key: string): Promise<KeyVersion[]> {
    const found: KeyVersion[] = [];
    let keyMarker: string | undefined;
    let versionMarker: string | undefined;
    for (;;) {
      const answer = await this.#client.send(
        new ListObjectVersionsCommand({
          Bucket: this.#bucket,
          Prefix: key,
          ...(keyMarker !== undefined ? { KeyMarker: keyMarker } : {}),
          ...(versionMarker !== undefined ? { VersionIdMarker: versionMarker } : {}),
        }),
      );
      for (const v of answer.Versions ?? []) {
        if (v.Key === key && v.VersionId)
          found.push({ versionId: v.VersionId, deleteMarker: false });
      }
      for (const m of answer.DeleteMarkers ?? []) {
        if (m.Key === key && m.VersionId)
          found.push({ versionId: m.VersionId, deleteMarker: true });
      }
      if (found.length > MAX_VERSIONS_PER_KEY) throw new EvidenceError('unavailable');
      if (answer.IsTruncated !== true) return found;
      keyMarker = answer.NextKeyMarker;
      versionMarker = answer.NextVersionIdMarker;
      // Past this key: no more of its versions.
      if (keyMarker === undefined || keyMarker > key) return found;
    }
  }

  /** The version's lock, or null when it has none. */
  async #retention(
    key: string,
    versionId: string,
  ): Promise<{ readonly mode: ObjectLockRetentionMode; readonly until: Date } | null> {
    try {
      const answer = await this.#client.send(
        new GetObjectRetentionCommand({ Bucket: this.#bucket, Key: key, VersionId: versionId }),
      );
      const mode = answer.Retention?.Mode;
      const until = answer.Retention?.RetainUntilDate;
      return mode && until ? { mode, until } : null;
    } catch (error) {
      // No lock on this version (written before the bucket's lock), or none configured.
      if (error instanceof S3ServiceException && error.$metadata.httpStatusCode === 404) {
        return null;
      }
      throw error;
    }
  }
}
