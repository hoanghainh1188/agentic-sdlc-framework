// D-08 E02 on a live PostgreSQL, through the Nest app and Fastify `inject()` (no port), with an
// intent taken to G8 by the G7 world (`g7-world.ts`) and an in-memory evidence store
// (design/ADR-M48, QUESTIONS #215–#219; D-02 FR-40, FR-42, FR-43).
// - AC1: the manifest holds the spec and its hash, the plan, the run's diff (re-checked), CI and
//   review records, every gate decision with its oversight mode, the escalations and the cost;
// - AC2: the client AI disclosure note in the project's disclosure format;
// - AC3: the files are stored under `packs/<tenant>/<intent>/<pack id>/`, the manifest with a hash
//   per item; one pack per build, never changed; the same content returns the same version;
// - AC4: one readable Markdown file from the catalog, its hash re-checked when it is read;
// - fail closed: a changed or missing evidence file stops the build and is audited;
// - who: `access.evidence_build_roles`, `access.evidence_read_roles`, tenant admins; viewer 403,
//   no role 404 (rule M30, #218); tenant isolation; the trigger of `evidence_packs`.
import crypto from 'node:crypto';

import {
  EvidenceError,
  type EvidenceGetOptions,
  type EvidenceStore,
  type StoredEvidence,
} from '@sdlc/contracts';
import { sql } from 'kysely';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { createApp, type ApiDeps } from '../../../apps/api/src/app.js';
import { issueApiToken } from '../../../packages/core/src/admin/tokens.js';
import { parseTenantId } from '../../../packages/core/src/db/tenant-id.js';
import type { Intent } from '../../../packages/core/src/db/schema.js';
import { CAROL, g7World } from './g7-world.js';
import { describeDb, tamper } from './helpers.js';

type App = Awaited<ReturnType<typeof createApp>>;
interface PackFileJson {
  readonly uri: string;
  readonly sha256: string;
  readonly size_bytes: number;
}
interface PackJson {
  readonly intent: string;
  readonly id: string;
  readonly version: number;
  readonly manifest: PackFileJson;
  readonly markdown: PackFileJson;
}
/** The API's answers; each endpoint fills some of these. */
interface Body {
  readonly pack: PackJson;
  readonly packs: readonly PackJson[];
  readonly created: boolean;
  readonly file: { readonly content: string; readonly sha256: string };
  readonly error: { readonly code: string };
}
interface Manifest {
  readonly build: { readonly pack_id: string; readonly version: number };
  readonly specs: readonly { readonly content_sha256: string }[];
  readonly plans: readonly unknown[];
  readonly evidence_items: readonly unknown[];
  readonly gate_decisions: readonly { readonly gate: string; readonly oversight_mode: string }[];
  readonly runs: readonly { readonly events: Record<string, unknown> }[];
  readonly escalations: readonly unknown[];
  readonly cost: Record<string, unknown>;
  readonly disclosure: Record<string, unknown>;
}
const manifestOf = (text: string): Manifest => JSON.parse(text) as Manifest;

const sha256 = (bytes: Buffer) => crypto.createHash('sha256').update(bytes).digest('hex');

/** Keys as SeaweedFS holds them: `<prefix><tenant>/<path>`; the store's own prefix is `packs/`. */
class MemoryStore implements EvidenceStore {
  readonly objects = new Map<string, Buffer>();
  puts = 0;

  put(tenantId: string, path: string, content: Buffer): Promise<StoredEvidence> {
    const key = `packs/${tenantId}/${path}`;
    if (this.objects.has(key)) return Promise.reject(new EvidenceError('exists'));
    this.objects.set(key, Buffer.from(content));
    this.puts += 1;
    return Promise.resolve({
      uri: `s3://evidence/${key}`,
      sha256: sha256(content),
      sizeBytes: content.length,
    });
  }

  get(uri: string, options: EvidenceGetOptions = {}): Promise<Buffer> {
    const body = this.objects.get(uri.slice('s3://evidence/'.length));
    if (!body) return Promise.reject(new EvidenceError('not_found'));
    if (options.maxBytes !== undefined && body.length > options.maxBytes) {
      return Promise.reject(new EvidenceError('too_large'));
    }
    return Promise.resolve(body);
  }
}

type Who = 'a' | 'b' | 'second' | 'viewer' | 'admin' | 'outsider' | 'other';

describeDb('E02: Evidence Packs on PostgreSQL', () => {
  const w = g7World();
  let app: App;
  let bare: App;
  let store: MemoryStore;
  let intent: Intent;
  let diffKey: string;
  let diffBytes: Buffer;
  const tokens = {} as Record<Who, string>;

  const asApiDb = (): ApiDeps['db'] => w.db.app as unknown as ApiDeps['db'];
  const settings = { rateLimitPerMinute: 10_000, authFailuresPerMinute: 10_000 };
  const call = async (
    method: 'GET' | 'POST',
    url: string,
    who: Who,
    on: App = app,
  ): Promise<{ status: number; body: Body }> => {
    const reply = await on
      .getHttpAdapter()
      .getInstance()
      .inject({ method, url, headers: { authorization: `Bearer ${tokens[who]}` } });
    return { status: reply.statusCode, body: reply.json<Body>() };
  };
  const packs = () => `/v1/intents/${intent.code}/evidence-packs`;
  const rowCount = async () => (await w.t.f.scope.evidencePacks.listForIntent(intent.id)).length;

  // The G7 world sets its fakes up in its own `beforeEach`, so the intent is built once, there.
  let ready = false;
  beforeEach(async () => {
    if (ready) return;
    ready = true;
    const scope = w.t.f.scope;
    // An intent through G7: Carol (Person B) approves and merges → G8.
    intent = await w.toG7();
    w.review(CAROL, 'approved');
    await w.step(intent);
    w.merge(CAROL);
    await w.step(intent);
    intent = await w.reload(intent);
    expect(intent).toMatchObject({ status: 'in_gate', current_gate: 'G8' });

    // The run's diff, stored as the runner stores it.
    store = new MemoryStore();
    const [run] = await scope.runs.listForIntent(intent.id);
    diffBytes = Buffer.from('diff --git a/src/a.ts b/src/a.ts\n+export const a = 1;\n');
    diffKey = `diffs/${scope.tenantId}/${intent.id}/${run!.id}.patch`;
    store.objects.set(diffKey, diffBytes);
    await scope.evidenceItems.record({
      intentId: intent.id,
      runId: run!.id,
      kind: 'diff',
      storageUri: `s3://evidence/${diffKey}`,
      sha256: sha256(diffBytes),
      sizeBytes: diffBytes.length,
    });

    const project = (await scope.projects.getById(intent.project_id))!;
    const now = new Date();
    const person = async (name: string, role?: 'viewer') => {
      const user = await scope.users.create({
        display_name: name,
        email: `${name}@ev.example.com`,
      });
      if (role) await scope.roleBindings.grant({ user_id: user.id, project_id: project.id, role });
      return user.id;
    };
    const ids: Record<Exclude<Who, 'other'>, string> = {
      a: w.t.f.users.a,
      b: w.t.f.users.b,
      second: w.users.second,
      viewer: await person('viewer2', 'viewer'),
      admin: await person('admin'),
      outsider: await person('outsider'),
    };
    await scope.tenantRoles.grant({ user_id: ids.admin, role: 'tenant_admin' });
    for (const [who, id] of Object.entries(ids) as [Exclude<Who, 'other'>, string][]) {
      tokens[who] = (await issueApiToken(scope, { userId: id, name: who, now })).token;
    }
    // A tenant admin of another tenant.
    const other = await w.db.app.system.createTenant({ slug: 'other', name: 'Other' });
    const otherScope = w.db.app.forTenant(parseTenantId(other.id));
    const otherAdmin = await otherScope.users.create({
      display_name: 'other',
      email: 'other@other.example.com',
    });
    await otherScope.tenantRoles.grant({ user_id: otherAdmin.id, role: 'tenant_admin' });
    tokens.other = (
      await issueApiToken(otherScope, { userId: otherAdmin.id, name: 'o', now })
    ).token;

    app = await createApp({
      db: asApiDb(),
      settings,
      evidence: { store, maxItemBytes: 1024 * 1024 },
    });
    bare = await createApp({ db: asApiDb(), settings });
  }, 120_000);
  afterAll(async () => {
    await app?.close();
    await bare?.close();
  });

  describe('AC1–AC4: build, list, show, export', () => {
    it('Person A builds version 1: the manifest and the Markdown under packs/<tenant>/<intent>/', async () => {
      const built = await call('POST', packs(), 'a');
      expect(built.status, JSON.stringify(built.body)).toBe(201);
      const pack = built.body.pack;
      expect(pack).toMatchObject({
        intent: intent.code,
        version: 1,
        disclosure_format: 'standard_note',
        item_count: 1,
        built_by: w.t.f.users.a,
        sealed_at: null,
      });
      const prefix = `s3://evidence/packs/${w.t.f.scope.tenantId}/${intent.id}/${pack.id}/`;
      expect(pack.manifest.uri).toBe(`${prefix}manifest.json`);
      expect(pack.markdown.uri).toBe(`${prefix}pack.md`);

      const manifest = manifestOf(
        store.objects.get(pack.manifest.uri.slice('s3://evidence/'.length))!.toString(),
      );
      expect(sha256(store.objects.get(pack.manifest.uri.slice('s3://evidence/'.length))!)).toBe(
        pack.manifest.sha256,
      );
      expect(manifest.build).toMatchObject({ pack_id: pack.id, version: 1 });
      expect(manifest.specs).toHaveLength(1);
      expect(manifest.specs[0]!.content_sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(manifest.plans).toHaveLength(1);
      expect(manifest.evidence_items).toEqual([
        expect.objectContaining({ kind: 'diff', sha256: sha256(diffBytes), check: 'verified' }),
      ]);
      const gates = new Set(manifest.gate_decisions.map((d) => d.gate));
      for (const gate of ['G1', 'G2', 'G3', 'G4', 'G5', 'G6', 'G7']) expect(gates).toContain(gate);
      for (const d of manifest.gate_decisions) {
        expect(['HITL', 'HOTL', 'AUDIT', 'POLICY']).toContain(d.oversight_mode);
      }
      expect(manifest.runs[0]!.events).toHaveProperty('ci_checked');
      expect(manifest.runs[0]!.events).toHaveProperty('pr_merged');
      expect(Array.isArray(manifest.escalations)).toBe(true);
      expect(manifest.cost).toHaveProperty('cost_usd');
      expect(manifest.disclosure).toMatchObject({
        format: 'standard_note',
        client_text_required: false,
        g7_approvals: 1,
      });
      // The diff text never enters the pack.
      expect(JSON.stringify(manifest)).not.toContain('export const a');
      const built1 = await w.t.f.scope.audit.listForEntity(pack.id, ['evidence.pack_built']);
      expect(built1[0]?.payload).toMatchObject({ intent_id: intent.id, version: 1 });
    });

    it('the same content returns the same version (200), nothing stored', async () => {
      const puts = store.puts;
      const again = await call('POST', packs(), 'b');
      expect(again.status).toBe(200);
      expect(again.body).toMatchObject({ created: false, pack: { version: 1 } });
      expect(store.puts).toBe(puts);
      expect(await rowCount()).toBe(1);
    });

    it('the second approver reads the list, a version and the Markdown (hash re-checked)', async () => {
      const list = await call('GET', packs(), 'second');
      expect(list.status).toBe(200);
      expect(list.body.packs.map((p) => p.version)).toEqual([1]);
      const show = await call('GET', `${packs()}/1`, 'second');
      expect(show.body.pack.version).toBe(1);
      const md = await call('GET', `${packs()}/1/markdown`, 'second');
      expect(md.status).toBe(200);
      const text = md.body.file.content;
      expect(sha256(Buffer.from(text))).toBe(md.body.file.sha256);
      expect(text).toContain('# Evidence Pack');
      expect(text).toContain('## Client AI disclosure');
      expect(text).toContain('## Gate decisions');
      // The approver's display name next to the role, read at build time.
      expect(text).toMatch(/`person_b` \| carol \(`[0-9a-f-]{36}`\)/);
      const manifest = await call('GET', `${packs()}/1/manifest`, 'second');
      expect(manifestOf(manifest.body.file.content).build.version).toBe(1);
    });

    it('a change of content builds version 2; concurrent builds make one version', async () => {
      await w.t.f.scope.projectAiRecords.save(intent.project_id, {
        aiAllowed: 'yes',
        allowedDataClasses: ['public', 'internal', 'client_restricted'],
        prodLogsAllowed: 'no',
        disclosureFormat: 'client_format',
        confirmedAt: '2026-09-01',
        recordRef: 'https://docs.example.test/project/ai-record',
        updatedBy: w.t.f.users.a,
        actorType: 'human',
        expectedVersion: 1,
      });
      const [one, two] = await Promise.all([
        call('POST', packs(), 'a'),
        call('POST', packs(), 'admin'),
      ]);
      expect([one.status, two.status].sort()).toEqual([200, 201]);
      expect(one.body.pack.version).toBe(2);
      expect(two.body.pack.version).toBe(2);
      expect(await rowCount()).toBe(2);
      const md = await call('GET', `${packs()}/2/markdown`, 'a');
      expect(md.body.file.content).toContain('`https://docs.example.test/project/ai-record`');
      const manifest = manifestOf(
        (await call('GET', `${packs()}/2/manifest`, 'a')).body.file.content,
      );
      expect(manifest.disclosure).toMatchObject({
        format: 'client_format',
        client_text_required: true,
        record_ref: 'https://docs.example.test/project/ai-record',
      });
    });
  });

  describe('fail closed: the stored evidence is re-checked (ADR-M33 §2.9 gap 2)', () => {
    it('a changed diff stops the build: nothing stored, audited as evidence.check_failed', async () => {
      const item = (await w.t.f.scope.evidenceItems.listForIntent(intent.id))[0]!;
      // Same size, one byte changed: only the SHA-256 tells.
      const changed = Buffer.from(diffBytes);
      changed[changed.length - 2] = 0x32;
      store.objects.set(diffKey, changed);
      // Change the intent's content too, so the build would otherwise make a new version.
      await tamper(w.db.name, `UPDATE intents SET pr_number = pr_number + 1 WHERE id = $1`, [
        intent.id,
      ]);
      const puts = store.puts;
      const refused = await call('POST', packs(), 'a');
      expect(refused.status).toBe(409);
      expect(refused.body.error.code).toBe('evidence_hash_mismatch');
      expect(store.puts).toBe(puts);
      expect(await rowCount()).toBe(2);
      const failed = await w.t.f.scope.audit.listForEntity(item.id, ['evidence.check_failed']);
      expect(failed.at(-1)?.payload).toMatchObject({ kind: 'diff', reason: 'hash_mismatch' });
      // The same failure again adds no audit row (the log is kept for years).
      expect((await call('POST', packs(), 'a')).body.error.code).toBe('evidence_hash_mismatch');
      expect(
        await w.t.f.scope.audit.listForEntity(item.id, ['evidence.check_failed']),
      ).toHaveLength(failed.length);

      store.objects.delete(diffKey);
      const missing = await call('POST', packs(), 'a');
      expect(missing.body.error.code).toBe('evidence_missing');
      const audited = await w.t.f.scope.audit.listForEntity(item.id, ['evidence.check_failed']);
      expect(audited.at(-1)?.payload).toMatchObject({ reason: 'missing' });

      store.objects.set(diffKey, diffBytes);
      expect((await call('POST', packs(), 'a')).body.pack.version).toBe(3);
    });

    it('a changed pack file is refused when read, and audited', async () => {
      const pack = (await w.t.f.scope.evidencePacks.getVersion(intent.id, 1))!;
      const key = pack.markdown_uri.slice('s3://evidence/'.length);
      const original = store.objects.get(key)!;
      store.objects.set(key, Buffer.from(original.toString().replace('Evidence', 'Evidenze')));
      const refused = await call('GET', `${packs()}/1/markdown`, 'a');
      expect(refused.status).toBe(409);
      expect(refused.body.error.code).toBe('evidence_hash_mismatch');
      const audited = await w.t.f.scope.audit.listForEntity(pack.id, [
        'evidence.pack_check_failed',
      ]);
      expect(audited.at(-1)?.payload).toMatchObject({ file: 'markdown', reason: 'hash_mismatch' });
      store.objects.set(key, original);
    });
  });

  describe('who may build and read (QUESTIONS #218, rule M30)', () => {
    it('second approver reads but never builds; viewer neither (403); no role 404', async () => {
      expect((await call('POST', packs(), 'second')).body.error.code).toBe('forbidden');
      for (const [method, url] of [
        ['POST', packs()],
        ['GET', packs()],
        ['GET', `${packs()}/1`],
        ['GET', `${packs()}/1/markdown`],
      ] as const) {
        const viewer = await call(method, url, 'viewer');
        expect(viewer.status, `${method} ${url}`).toBe(403);
        const outsider = await call(method, url, 'outsider');
        expect(outsider.status, `${method} ${url}`).toBe(404);
        expect(outsider.body.error.code).toBe('intent_not_found');
      }
    });

    it("another tenant's admin never sees the intent", async () => {
      expect((await call('GET', packs(), 'other')).status).toBe(404);
      expect((await call('POST', packs(), 'other')).status).toBe(404);
    });

    it('an unknown version is 404; without an evidence store: access first, then 503', async () => {
      expect((await call('GET', `${packs()}/99`, 'a')).body.error.code).toBe(
        'evidence_pack_not_found',
      );
      expect((await call('POST', packs(), 'outsider', bare)).status).toBe(404);
      const unavailable = await call('POST', packs(), 'a', bare);
      expect(unavailable.status).toBe(503);
      expect(unavailable.body.error.code).toBe('evidence_unavailable');
      // Listing needs no store.
      expect((await call('GET', packs(), 'a', bare)).status).toBe(200);
    });
  });

  describe('the evidence_packs table (migration 0021)', () => {
    it('only sealed_at, retention_hold and purged_at change; sealed and purged once; no delete', async () => {
      const owner = w.db.owner;
      const pack = (await w.t.f.scope.evidencePacks.getVersion(intent.id, 1))!;
      await expect(
        sql`UPDATE evidence_packs SET content_sha256 = ${'0'.repeat(64)} WHERE id = ${pack.id}`.execute(
          owner,
        ),
      ).rejects.toMatchObject({ code: 'SDA14' });
      await expect(
        sql`DELETE FROM evidence_packs WHERE id = ${pack.id}`.execute(owner),
      ).rejects.toThrow(/append-only/);
      await sql`UPDATE evidence_packs SET retention_hold = true WHERE id = ${pack.id}`.execute(
        owner,
      );
      await sql`UPDATE evidence_packs SET sealed_at = now() WHERE id = ${pack.id}`.execute(owner);
      await expect(
        sql`UPDATE evidence_packs SET sealed_at = now() + interval '1 hour' WHERE id = ${pack.id}`.execute(
          owner,
        ),
      ).rejects.toMatchObject({ code: 'SDA14' });
      // One sealed version per intent.
      const v2 = (await w.t.f.scope.evidencePacks.getVersion(intent.id, 2))!;
      await expect(
        sql`UPDATE evidence_packs SET sealed_at = now() WHERE id = ${v2.id}`.execute(owner),
      ).rejects.toMatchObject({ code: '23505' });
      // A sealed version: no new build (E03 seals at G8).
      const sealed = await call('POST', packs(), 'a');
      expect(sealed.status).toBe(409);
      expect(sealed.body.error.code).toBe('evidence_pack_sealed');
    });
  });
});
