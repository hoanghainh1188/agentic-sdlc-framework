// D-08 X04 AC5 and PR 3b on a real knowledge-db and a real OpenBao (dev mode, in memory;
// `pnpm test:knowledge`; design/ADR-M89, QUESTIONS #535, #537, #541):
// - the issuer role as `knowledge-issuer-credentials` sets it up (bootstrap.sh): it may create and
//   drop roles and holds each project's read role with the admin option only, so it cannot read an
//   index itself;
// - OpenBao's database engine makes one login per run (`kdocs-<run_id>`) with the statements of
//   `@sdlc/secrets`; the login reads its own project's index through the tool's reader;
// - another project's index is refused; the login cannot write; after the revocation it cannot log
//   in again, and its role is gone.
import crypto from 'node:crypto';

import {
  PgVectorKnowledgeReader,
  PgVectorKnowledgeStore,
  projectRole,
  projectSchema,
} from '@sdlc/adapter-knowledge-pgvector';
import type { RunDatabaseLogin } from '@sdlc/contracts';
import { DatabaseCredentials, KNOWLEDGE_DB_CONNECTION } from '@sdlc/secrets';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const superUrl = process.env.SDLC_KNOWLEDGE_TEST_URL;
const baoUrl = process.env.SDLC_KNOWLEDGE_TEST_OPENBAO;
const baoToken = process.env.SDLC_KNOWLEDGE_TEST_OPENBAO_TOKEN;
const TENANT = '11111111-1111-4111-8111-111111111111';
const MODEL = 'bge-m3';
const sha = (text: string) => crypto.createHash('sha256').update(text).digest('hex');

/** A plain HTTP caller with the dev root token, as `OpenBaoClient` calls with its own token. */
function rootCaller() {
  return async (request: {
    method: string;
    path: string;
    body?: unknown;
    accept?: readonly number[];
  }) => {
    const res = await fetch(`${baoUrl}/v1/${request.path}`, {
      method: request.method,
      headers: { 'X-Vault-Token': baoToken!, 'content-type': 'application/json' },
      ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
    });
    const text = await res.text();
    if (!res.ok && !request.accept?.includes(res.status)) {
      throw new Error(`openbao ${request.method} ${request.path}: ${String(res.status)}`);
    }
    return { status: res.status, body: text === '' ? undefined : (JSON.parse(text) as unknown) };
  };
}

describe.skipIf(!superUrl || !baoUrl || !baoToken)(
  'X04 PR 3b live: the per-run login of a read_documents tool',
  () => {
    let admin: pg.Client;
    let store: PgVectorKnowledgeStore;
    let creds: DatabaseCredentials;
    const call = rootCaller();
    const port = Number(new URL(superUrl ?? 'postgres://x:1').port);
    const projectA = crypto.randomUUID();
    const projectB = crypto.randomUUID();
    const indexA = crypto.randomUUID();
    const indexB = crypto.randomUUID();
    const runId = crypto.randomUUID();
    const docA = crypto.randomUUID();
    let login: RunDatabaseLogin;

    const loginClient = (who: RunDatabaseLogin) =>
      new pg.Client({
        host: '127.0.0.1',
        port,
        database: 'knowledge',
        user: who.username.reveal(),
        password: who.password.reveal(),
      });

    beforeAll(async () => {
      admin = new pg.Client({ connectionString: superUrl });
      await admin.connect();
      const knowledgePassword = crypto.randomBytes(24).toString('hex');
      const issuerPassword = crypto.randomBytes(24).toString('hex');
      await admin.query(
        `ALTER ROLE knowledge LOGIN NOSUPERUSER CREATEROLE PASSWORD '${knowledgePassword}'`,
      );
      // As `knowledge-issuer-credentials` does (bootstrap.sh), before any project exists.
      await admin.query(
        `DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kdocs_issuer') THEN CREATE ROLE kdocs_issuer; END IF; END $$`,
      );
      await admin.query(
        `ALTER ROLE kdocs_issuer LOGIN NOSUPERUSER NOCREATEDB CREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '${issuerPassword}'`,
      );
      await admin.query('GRANT CONNECT ON DATABASE knowledge TO kdocs_issuer');
      await admin.query('GRANT pg_signal_backend TO kdocs_issuer');
      const url = new URL(superUrl!);
      url.username = 'knowledge';
      url.password = knowledgePassword;
      store = new PgVectorKnowledgeStore({ connectionString: url.toString() });

      // Two projects, one index version each (the worker's side, PR 3a).
      for (const [project, index, text] of [
        [projectA, indexA, 'orders are cancelled by the owner'],
        [projectB, indexB, 'PROJECT-B-SECRET'],
      ] as const) {
        await store.ensureProject({ tenantId: TENANT, projectId: project });
        await store.putChunks({
          tenantId: TENANT,
          projectId: project,
          model: MODEL,
          chunks: [{ sha256: sha(`${project}${text}`), text, embedding: [1, 0, 0] }],
        });
        await store.putIndexVersion({
          tenantId: TENANT,
          projectId: project,
          indexId: index,
          baseSha: 'a'.repeat(40),
          model: MODEL,
          documents: [
            {
              path: 'docs/a.md',
              contentSha256: sha(text),
              chunks: [sha(`${project}${text}`)],
            },
          ],
        });
      }
      const docs = await admin.query<{ doc_id: string }>(
        `SELECT doc_id FROM ${projectSchema(projectA)}.documents WHERE index_id = $1`,
        [indexA],
      );
      expect(docs.rows[0]!.doc_id).toBeTruthy();

      // The database engine, as `configure` and `knowledge-issuer-credentials` set it up.
      await call({ method: 'POST', path: 'sys/mounts/database', body: { type: 'database' } });
      await call({
        method: 'POST',
        path: `database/config/${KNOWLEDGE_DB_CONNECTION}`,
        body: {
          plugin_name: 'postgresql-database-plugin',
          connection_url:
            'postgresql://{{username}}:{{password}}@knowledge-db:5432/knowledge?sslmode=disable',
          username: 'kdocs_issuer',
          password: issuerPassword,
          allowed_roles: 'kdocs-*',
          password_authentication: 'scram-sha-256',
        },
      });
      await call({ method: 'POST', path: `database/rotate-root/${KNOWLEDGE_DB_CONNECTION}` });
      creds = new DatabaseCredentials('database', call);
      login = await creds.issueRunLogin({
        runId,
        grantRole: projectRole(projectA),
        ttlSeconds: 600,
      });
      void docA;
    });

    afterAll(async () => {
      await store?.close();
      await admin?.end();
    });

    it('the issuer holds the read roles with the admin option only, not their rights', async () => {
      const rows = await admin.query<{ inherit_option: boolean; admin_option: boolean }>(
        `SELECT m.inherit_option, m.admin_option FROM pg_auth_members m
           JOIN pg_roles r ON r.oid = m.roleid JOIN pg_roles u ON u.oid = m.member
          WHERE u.rolname = 'kdocs_issuer' AND r.rolname = $1`,
        [projectRole(projectA)],
      );
      expect(rows.rows).toEqual([{ inherit_option: false, admin_option: true }]);
    });

    it("reads its own project's index version through the tool's reader", async () => {
      const reader = new PgVectorKnowledgeReader({
        host: '127.0.0.1',
        port,
        database: 'knowledge',
        user: login.username.reveal(),
        password: login.password.reveal(),
        schema: projectSchema(projectA),
      });
      try {
        const hits = await reader.search({
          indexId: indexA,
          model: MODEL,
          embedding: [1, 0, 0],
          limit: 5,
        });
        expect(hits.map((h) => h.text)).toEqual(['orders are cancelled by the owner']);
        expect(hits[0]!.contentSha256).toBe(sha('orders are cancelled by the owner'));
        expect(hits[0]!.score).toBeCloseTo(1);
      } finally {
        await reader.close();
      }
    });

    it("another project's index is refused; the login cannot write (AC5)", async () => {
      const client = loginClient(login);
      await client.connect();
      try {
        await expect(
          client.query(`SELECT text FROM ${projectSchema(projectB)}.chunks`),
        ).rejects.toMatchObject({ code: '42501' });
        await expect(
          client.query(`DELETE FROM ${projectSchema(projectA)}.chunks`),
        ).rejects.toMatchObject({ code: '42501' });
        await expect(client.query('CREATE TABLE public.x (a int)')).rejects.toMatchObject({
          code: '42501',
        });
      } finally {
        await client.end();
      }
      const reader = new PgVectorKnowledgeReader({
        host: '127.0.0.1',
        port,
        database: 'knowledge',
        user: login.username.reveal(),
        password: login.password.reveal(),
        schema: projectSchema(projectB),
      });
      try {
        await expect(
          reader.search({ indexId: indexB, model: MODEL, embedding: [1, 0, 0], limit: 5 }),
        ).rejects.toThrow('knowledge.read_failed');
      } finally {
        await reader.close();
      }
    });

    it('the revocation ends the login and deletes the run role; twice is harmless', async () => {
      await creds.revokeRunLogins(runId);
      await creds.revokeRunLogins(runId);
      const client = loginClient(login);
      await expect(client.connect()).rejects.toMatchObject({ code: '28P01' });
      await client.end().catch(() => undefined);
      const role = await call({
        method: 'GET',
        path: `database/roles/kdocs-${runId}`,
        accept: [404],
      });
      expect(role.status).toBe(404);
      const left = await admin.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [
        login.username.reveal(),
      ]);
      expect(left.rowCount).toBe(0);
    });
  },
);
