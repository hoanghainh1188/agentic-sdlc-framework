// D-08 X04 PR 3a on a real knowledge-db (design/ADR-M89 §2.1; `pnpm test:knowledge`): the
// pgvector adapter as the role `knowledge`, as the worker connects after
// `worker-knowledge-credentials`.
// - The init script: the database `knowledge` with pgvector; the role `knowledge` is not a
//   superuser and may create roles.
// - `ensureProject`: one schema and one read role (no login) per project, idempotent; the read role
//   reads its own project's schema only.
// - Chunks: stored once per key; `missingChunks` lists the new ones; a version and its documents;
//   a vector search works on the stored embeddings.
// - `deleteIndexVersion`: removes the version and its own chunks, keeps chunks another version or
//   a build in progress uses. `dropProject` removes the schema and the role, idempotent.
// - Errors: `store_unavailable`, never the password or a value.
import crypto from 'node:crypto';

import {
  PgVectorKnowledgeStore,
  projectRole,
  projectSchema,
} from '@sdlc/adapter-knowledge-pgvector';
import { KnowledgeError } from '@sdlc/contracts';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const superUrl = process.env.SDLC_KNOWLEDGE_TEST_URL;
const TENANT = '11111111-1111-4111-8111-111111111111';
const MODEL = 'bge-m3';
const key = (text: string) => crypto.createHash('sha256').update(`${MODEL}\n${text}`).digest('hex');
const sha = (text: string) => crypto.createHash('sha256').update(text).digest('hex');

describe.skipIf(!superUrl)('X04 PR 3a live: the pgvector index store', () => {
  let admin: pg.Client;
  let store: PgVectorKnowledgeStore;
  let knowledgeUrl: string;
  const password = crypto.randomBytes(24).toString('hex');
  const projectA = crypto.randomUUID();
  const projectB = crypto.randomUUID();

  beforeAll(async () => {
    admin = new pg.Client({ connectionString: superUrl });
    await admin.connect();
    // As `worker-knowledge-credentials` does (bootstrap.sh).
    await admin.query(`ALTER ROLE knowledge LOGIN NOSUPERUSER CREATEROLE PASSWORD '${password}'`);
    const url = new URL(superUrl!);
    url.username = 'knowledge';
    url.password = password;
    knowledgeUrl = url.toString();
    store = new PgVectorKnowledgeStore({ connectionString: knowledgeUrl });
  });
  afterAll(async () => {
    await store?.close();
    await admin?.end();
  });

  const vector = (x: number) => [x, 1 - x, 0.5];

  it('the init script: pgvector in the database knowledge; knowledge is no superuser', async () => {
    const ext = await admin.query("SELECT 1 FROM pg_extension WHERE extname = 'vector'");
    expect(ext.rowCount).toBe(1);
    const role = await admin.query<{ rolsuper: boolean; rolcreaterole: boolean }>(
      "SELECT rolsuper, rolcreaterole FROM pg_roles WHERE rolname = 'knowledge'",
    );
    expect(role.rows).toEqual([{ rolsuper: false, rolcreaterole: true }]);
  });

  it('creates one schema and one read role per project, idempotent', async () => {
    await store.ensureProject({ tenantId: TENANT, projectId: projectA });
    await store.ensureProject({ tenantId: TENANT, projectId: projectA });
    await store.ensureProject({ tenantId: TENANT, projectId: projectB });
    expect(projectSchema(projectA)).toBe(`kdocs_p${projectA.replaceAll('-', '')}`);
    const roles = await admin.query<{ rolcanlogin: boolean }>(
      'SELECT rolcanlogin FROM pg_roles WHERE rolname = $1',
      [projectRole(projectA)],
    );
    expect(roles.rows).toEqual([{ rolcanlogin: false }]);
  });

  it('stores chunks once, a version and its documents; a vector search finds the nearest', async () => {
    const texts = ['# Orders', 'stock moves', 'returns'];
    expect(await store.missingChunks(projectA, MODEL, texts.map(key))).toEqual(texts.map(key));
    await store.putChunks({
      tenantId: TENANT,
      projectId: projectA,
      model: MODEL,
      chunks: texts.map((text, i) => ({ sha256: key(text), text, embedding: vector(i / 2) })),
    });
    // Again: kept as it is.
    await store.putChunks({
      tenantId: TENANT,
      projectId: projectA,
      model: MODEL,
      chunks: [{ sha256: key('# Orders'), text: '# Orders', embedding: vector(0.9) }],
    });
    expect(await store.missingChunks(projectA, MODEL, [...texts.map(key), key('new')])).toEqual([
      key('new'),
    ]);
    expect(await store.missingChunks(projectB, MODEL, [key('# Orders')])).toEqual([
      key('# Orders'),
    ]);

    const v1 = crypto.randomUUID();
    await store.putIndexVersion({
      tenantId: TENANT,
      projectId: projectA,
      indexId: v1,
      baseSha: 'a'.repeat(40),
      model: MODEL,
      documents: [
        {
          path: 'README.md',
          contentSha256: sha('r'),
          chunks: [key('# Orders'), key('stock moves')],
        },
        { path: 'docs/returns.md', contentSha256: sha('d'), chunks: [key('returns')] },
      ],
    });
    const schema = projectSchema(projectA);
    const nearest = await admin.query<{ text: string }>(
      `SELECT c.text FROM ${schema}.document_chunks dc JOIN ${schema}.chunks c
         ON c.sha256 = dc.chunk_sha256 WHERE dc.index_id = $1
        ORDER BY c.embedding <=> $2::vector LIMIT 1`,
      [v1, `[${vector(1).join(',')}]`],
    );
    expect(nearest.rows).toEqual([{ text: 'returns' }]);
    const docs = await admin.query(`SELECT path FROM ${schema}.documents WHERE index_id = $1`, [
      v1,
    ]);
    expect(docs.rows.map((r: { path: string }) => r.path).sort()).toEqual([
      'README.md',
      'docs/returns.md',
    ]);
  });

  it("the read role reads its own project's schema only", async () => {
    const asRead = async (sql: string) => {
      await admin.query('BEGIN');
      try {
        await admin.query(`SET LOCAL ROLE ${projectRole(projectA)}`);
        return await admin.query(sql);
      } finally {
        await admin.query('ROLLBACK');
      }
    };
    expect((await asRead(`SELECT count(*) FROM ${projectSchema(projectA)}.chunks`)).rowCount).toBe(
      1,
    );
    await expect(asRead(`SELECT count(*) FROM ${projectSchema(projectB)}.chunks`)).rejects.toThrow(
      /permission denied/,
    );
    await expect(
      asRead(`INSERT INTO ${projectSchema(projectA)}.index_versions VALUES (gen_random_uuid(),
        '${TENANT}', '${'b'.repeat(40)}', 'm', now())`),
    ).rejects.toThrow(/permission denied/);
  });

  it('deletes a version and only its own chunks; keeps shared chunks and a build in progress', async () => {
    const v2 = crypto.randomUUID();
    await store.putIndexVersion({
      tenantId: TENANT,
      projectId: projectA,
      indexId: v2,
      baseSha: 'b'.repeat(40),
      model: MODEL,
      documents: [{ path: 'README.md', contentSha256: sha('r2'), chunks: [key('# Orders')] }],
    });
    // A chunk stored by a build that has not written its version yet.
    await store.putChunks({
      tenantId: TENANT,
      projectId: projectA,
      model: MODEL,
      chunks: [{ sha256: key('in progress'), text: 'in progress', embedding: vector(0.3) }],
    });
    const versions = await admin.query<{ id: string }>(
      `SELECT id FROM ${projectSchema(projectA)}.index_versions WHERE base_sha = $1`,
      ['a'.repeat(40)],
    );
    const v1 = versions.rows[0]!.id;
    // v1 owns '# Orders' (shared with v2), 'stock moves' and 'returns'.
    expect(await store.deleteIndexVersion(projectA, v1)).toEqual({ chunks: 2 });
    expect(
      await store.missingChunks(projectA, MODEL, [key('# Orders'), key('in progress')]),
    ).toEqual([]);
    expect(await store.missingChunks(projectA, MODEL, [key('returns')])).toEqual([key('returns')]);
    expect(await store.deleteIndexVersion(projectA, v1)).toEqual({ chunks: 0 });
    // The sweep: the versions left, and chunks no version uses, only when older than the cut-off.
    expect((await store.listIndexVersions(projectA)).map((v) => v.id)).toEqual([v2]);
    expect(await store.deleteOrphanChunks(projectA, new Date(Date.now() - 3_600_000))).toBe(0);
    expect(await store.deleteOrphanChunks(projectA, new Date(Date.now() + 60_000))).toBe(1);
    expect(
      await store.missingChunks(projectA, MODEL, [key('in progress'), key('# Orders')]),
    ).toEqual([key('in progress')]);
    expect(await store.listIndexVersions(crypto.randomUUID())).toEqual([]);
    expect(await store.deleteOrphanChunks(crypto.randomUUID(), new Date())).toBe(0);
  });

  it('drops a project’s schema and role, idempotent; another project stays', async () => {
    await store.dropProject(projectA);
    await store.dropProject(projectA);
    const schemas = await admin.query('SELECT nspname FROM pg_namespace WHERE nspname = ANY($1)', [
      [projectSchema(projectA), projectSchema(projectB)],
    ]);
    expect(schemas.rows).toEqual([{ nspname: projectSchema(projectB) }]);
    const roles = await admin.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [
      projectRole(projectA),
    ]);
    expect(roles.rowCount).toBe(0);
    expect(await store.deleteIndexVersion(projectA, crypto.randomUUID())).toEqual({ chunks: 0 });
  });

  it('errors are store_unavailable, without the password or a value', async () => {
    const wrong = new URL(knowledgeUrl);
    wrong.password = `${password}x`;
    const bad = new PgVectorKnowledgeStore({ connectionString: wrong.toString() });
    const error = await bad
      .ensureProject({ tenantId: TENANT, projectId: projectB })
      .catch((e: unknown) => e);
    await bad.close();
    expect(error).toEqual(new KnowledgeError('store_unavailable'));
    expect(JSON.stringify(error) + String(error)).not.toContain(password);
    await expect(store.missingChunks('not-a-uuid', MODEL, [])).rejects.toMatchObject({
      code: 'store_unavailable',
    });
    await expect(
      store.putChunks({
        tenantId: TENANT,
        projectId: projectB,
        model: MODEL,
        chunks: [{ sha256: key('x'), text: 'x', embedding: [Number.NaN] }],
      }),
    ).rejects.toMatchObject({ code: 'embedding_failed' });
  });
});
