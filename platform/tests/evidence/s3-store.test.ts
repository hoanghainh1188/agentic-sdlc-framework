// C06 session 2b (design/D-03 section 7.5, design/ADR-M33 §2.9): the S3 evidence store against an
// in-process S3 stub. Keys carry the store's prefix and the tenant; every put sends
// `If-None-Match: *`, so a taken path is refused (`exists`) and evidence is never overwritten;
// errors are codes and never carry the service's text or a secret.
import crypto from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { S3EvidenceStore } from '@sdlc/adapter-evidence-s3';
import { EvidenceError, type RedactedSecret } from '@sdlc/contracts';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const TENANT = '11111111-2222-4333-8444-555555555555';
const ACCESS = 'runner-evidence-access';
const SECRET = 'runner-evidence-secret-canary-0123456789';

const secret = (value: string): RedactedSecret =>
  ({ reveal: () => value, toString: () => '[redacted]' }) as RedactedSecret;

interface Seen {
  readonly method: string;
  readonly path: string;
  readonly ifNoneMatch: string | undefined;
  readonly authorization: string | undefined;
}

class StubS3 {
  readonly objects = new Map<string, Buffer>();
  readonly seen: Seen[] = [];
  /** Paths answered with this status instead. */
  readonly fail = new Map<string, number>();
  constructor(readonly server: http.Server) {}

  static async start(): Promise<StubS3> {
    const holder: { stub?: StubS3 } = {};
    const server = http.createServer((req, res) => holder.stub!.handle(req, res));
    holder.stub = new StubS3(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    return holder.stub;
  }

  get url(): string {
    return `http://127.0.0.1:${String((this.server.address() as AddressInfo).port)}`;
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const path = decodeURIComponent(new URL(req.url ?? '/', 'http://s3').pathname);
      const ifNoneMatch = req.headers['if-none-match'];
      this.seen.push({
        method: req.method ?? '',
        path,
        ifNoneMatch,
        authorization: req.headers.authorization,
      });
      const error = (status: number, code: string) => {
        res.writeHead(status, { 'content-type': 'application/xml' });
        res.end(`<Error><Code>${code}</Code><Message>echo ${SECRET}</Message></Error>`);
      };
      const failure = this.fail.get(path);
      if (failure) return error(failure, 'Stubbed');
      if (req.method === 'PUT') {
        if (ifNoneMatch === '*' && this.objects.has(path)) return error(412, 'PreconditionFailed');
        this.objects.set(path, Buffer.concat(chunks));
        res.writeHead(200, { etag: '"x"' });
        return res.end();
      }
      if (req.method === 'GET') {
        const body = this.objects.get(path);
        if (!body) return error(404, 'NoSuchKey');
        res.writeHead(200, { 'content-length': String(body.length) });
        return res.end(body);
      }
      error(405, 'MethodNotAllowed');
    });
  }
}

describe('S3EvidenceStore', () => {
  let s3: StubS3;
  let store: S3EvidenceStore;

  beforeAll(async () => {
    s3 = await StubS3.start();
    store = new S3EvidenceStore({
      endpoint: s3.url,
      bucket: 'evidence',
      keyPrefix: 'proposals/',
      accessKeyId: secret(ACCESS),
      secretAccessKey: secret(SECRET),
      timeoutMs: 5000,
    });
  });
  afterAll(async () => {
    store.destroy();
    await new Promise<void>((resolve) => s3.server.close(() => resolve()));
  });
  beforeEach(() => {
    s3.objects.clear();
    s3.seen.length = 0;
    s3.fail.clear();
  });

  it('puts under the prefix and the tenant, never overwriting; returns the URI, hash and size', async () => {
    const content = Buffer.from('diff --git a/x b/x\n');
    const stored = await store.put(TENANT, 'intent/run.patch', content, 'text/x-diff');
    expect(stored).toEqual({
      uri: `s3://evidence/proposals/${TENANT}/intent/run.patch`,
      sha256: crypto.createHash('sha256').update(content).digest('hex'),
      sizeBytes: content.length,
    });
    expect(s3.seen).toHaveLength(1);
    expect(s3.seen[0]).toMatchObject({
      method: 'PUT',
      path: `/evidence/proposals/${TENANT}/intent/run.patch`,
      ifNoneMatch: '*',
    });
    expect(s3.seen[0]!.authorization).toContain(`Credential=${ACCESS}/`);
    expect(s3.seen[0]!.authorization).not.toContain(SECRET);
    expect((await store.get(stored.uri)).equals(content)).toBe(true);
  });

  it('refuses a taken path (exists) and leaves the first object', async () => {
    await store.put(TENANT, 'a/b.patch', Buffer.from('first'), 'text/x-diff');
    const second = store.put(TENANT, 'a/b.patch', Buffer.from('second'), 'text/x-diff');
    await expect(second).rejects.toMatchObject({ code: 'exists' });
    expect(s3.objects.get(`/evidence/proposals/${TENANT}/a/b.patch`)?.toString()).toBe('first');
  });

  it.each([
    [403, 'forbidden'],
    [404, 'not_found'],
    [500, 'unavailable'],
  ])('maps status %i to %s, without the service text', async (status, code) => {
    s3.fail.set(`/evidence/proposals/${TENANT}/a/b.patch`, status);
    const error = await store
      .put(TENANT, 'a/b.patch', Buffer.from('x'), 'text/x-diff')
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(EvidenceError);
    expect(error).toMatchObject({ code });
    expect(String((error as Error).message)).not.toContain(SECRET);
  });

  it.each([
    ['a tenant that is not a UUID', 'tenant', 'a.patch'],
    ['a path with ..', TENANT, '../other/a.patch'],
    ['an absolute path', TENANT, '/a.patch'],
    ['an empty segment', TENANT, 'a//b.patch'],
  ])('refuses %s before any request', async (_name, tenant, path) => {
    await expect(store.put(tenant, path, Buffer.from('x'), 'text/x-diff')).rejects.toMatchObject({
      code: 'invalid_input',
    });
    expect(s3.seen).toEqual([]);
  });

  it('refuses a URI of another bucket', async () => {
    await expect(store.get('s3://other/proposals/x.patch')).rejects.toMatchObject({
      code: 'invalid_input',
    });
  });

  it('refuses options that could leak or widen the scope', () => {
    const base = {
      bucket: 'evidence',
      keyPrefix: 'proposals/',
      accessKeyId: secret(ACCESS),
      secretAccessKey: secret(SECRET),
    };
    for (const options of [
      { ...base, endpoint: 'http://user:pass@seaweedfs:8333' },
      { ...base, endpoint: 'http://seaweedfs:8333/evidence' },
      { ...base, endpoint: 'file:///tmp' },
      { ...base, endpoint: 'http://seaweedfs:8333', keyPrefix: '../' },
      { ...base, endpoint: 'http://seaweedfs:8333', bucket: 'Evidence_1' },
    ]) {
      expect(() => new S3EvidenceStore(options)).toThrow(EvidenceError);
    }
  });
});
