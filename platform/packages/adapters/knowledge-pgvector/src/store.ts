// The index of a project's documents in `knowledge-db` (task X04 PR 3a, design/ADR-M89 §2.1).
//
// - One schema per project, `kdocs_p<project ID without dashes>`, and one read role per project
//   (no login), `kdocs_p<…>_read`, that may read that schema only. A run's tool logs in as a member
//   of it (PR 3b, QUESTIONS #537, #540): OpenBao's database engine creates that login as
//   `kdocs_issuer`, which holds the read role with the admin option only. Names are built from the
//   project's UUID only, never from input text.
// - Chunks are keyed by the SHA-256 of their model and text and reused by every index version of
//   the project; never across projects or tenants.
// - The embedding column has no fixed size and no approximate index: a plain search (K01).
// - Every value is a query parameter. Errors become `KnowledgeError('store_unavailable')`, never
//   the driver's text (it can echo values).
import { randomUUID } from 'node:crypto';

import {
  KNOWLEDGE_DATABASE,
  KNOWLEDGE_ISSUER_ROLE,
  KnowledgeError,
  knowledgeReadRole,
  knowledgeSchema,
  type KnowledgeChunk,
  type KnowledgeIndexInput,
  type KnowledgeStore,
} from '@sdlc/contracts';
import pg from 'pg';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const GIT_SHA = /^[0-9a-f]{40}$/;
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$/;

function checked(value: string, pattern: RegExp): string {
  if (!pattern.test(value)) throw new KnowledgeError('store_unavailable');
  return value;
}

/** The project's schema: an identifier from its UUID only. */
export const projectSchema = knowledgeSchema;

/** The project's read role (no login): the per-run logins of PR 3b are members of it. */
export const projectRole = knowledgeReadRole;

const vectorLiteral = (embedding: readonly number[]): string => {
  if (embedding.length === 0 || embedding.some((v) => !Number.isFinite(v))) {
    throw new KnowledgeError('embedding_failed');
  }
  return `[${embedding.join(',')}]`;
};

export interface PgVectorKnowledgeStoreOptions {
  /** `postgresql://<user>:<password>@knowledge-db:5432/knowledge`; never logged. */
  readonly connectionString: string;
  readonly maxConnections?: number;
}

export class PgVectorKnowledgeStore implements KnowledgeStore {
  readonly #pool: pg.Pool;

  constructor(options: PgVectorKnowledgeStoreOptions) {
    this.#pool = new pg.Pool({
      connectionString: options.connectionString,
      max: options.maxConnections ?? 4,
    });
    // A pool without an error listener ends the process on an idle-client error (R084).
    this.#pool.on('error', () => undefined);
  }

  async #run<T>(work: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    let client: pg.PoolClient;
    try {
      client = await this.#pool.connect();
    } catch {
      throw new KnowledgeError('store_unavailable');
    }
    try {
      return await work(client);
    } catch (error) {
      if (error instanceof KnowledgeError) throw error;
      throw new KnowledgeError('store_unavailable');
    } finally {
      client.release();
    }
  }

  async #transaction<T>(work: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    return this.#run(async (client) => {
      await client.query('BEGIN');
      try {
        const result = await work(client);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      }
    });
  }

  async ensureProject(input: { readonly tenantId: string; readonly projectId: string }) {
    checked(input.tenantId, UUID);
    const schema = projectSchema(input.projectId);
    const role = projectRole(input.projectId);
    await this.#transaction(async (client) => {
      // One project at a time: two runs of a project never create its schema at once.
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [schema]);
      await client.query('CREATE EXTENSION IF NOT EXISTS vector');
      await client.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
      await client.query(
        `CREATE TABLE IF NOT EXISTS ${schema}.chunks (
           sha256    char(64) PRIMARY KEY CHECK (sha256 ~ '^[0-9a-f]{64}$'),
           tenant_id uuid NOT NULL,
           model     text NOT NULL,
           text      text NOT NULL,
           embedding vector NOT NULL,
           created_at timestamptz NOT NULL DEFAULT now()
         )`,
      );
      await client.query(
        `CREATE TABLE IF NOT EXISTS ${schema}.index_versions (
           id         uuid PRIMARY KEY,
           tenant_id  uuid NOT NULL,
           base_sha   char(40) NOT NULL,
           model      text NOT NULL,
           created_at timestamptz NOT NULL DEFAULT now()
         )`,
      );
      await client.query(
        `CREATE TABLE IF NOT EXISTS ${schema}.documents (
           index_id       uuid NOT NULL REFERENCES ${schema}.index_versions (id) ON DELETE CASCADE,
           doc_id         uuid NOT NULL,
           path           text NOT NULL,
           content_sha256 char(64) NOT NULL,
           PRIMARY KEY (index_id, doc_id)
         )`,
      );
      await client.query(
        `CREATE TABLE IF NOT EXISTS ${schema}.document_chunks (
           index_id     uuid NOT NULL,
           doc_id       uuid NOT NULL,
           ord          integer NOT NULL,
           chunk_sha256 char(64) NOT NULL REFERENCES ${schema}.chunks (sha256),
           PRIMARY KEY (index_id, doc_id, ord),
           FOREIGN KEY (index_id, doc_id) REFERENCES ${schema}.documents (index_id, doc_id)
             ON DELETE CASCADE
         )`,
      );
      const exists = await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role]);
      if (exists.rowCount === 0) await client.query(`CREATE ROLE ${role} NOLOGIN`);
      await client.query(`REVOKE ALL ON SCHEMA ${schema} FROM PUBLIC`);
      await client.query(`GRANT USAGE ON SCHEMA ${schema} TO ${role}`);
      await client.query(`GRANT SELECT ON ALL TABLES IN SCHEMA ${schema} TO ${role}`);
      // X04 PR 3b: the database is closed to PUBLIC; the read role opens it to its logins. The
      // issuer (OpenBao) may grant the read role to a run's login, and may not use it itself.
      await client.query(`GRANT CONNECT ON DATABASE ${KNOWLEDGE_DATABASE} TO ${role}`);
      // pgvector's type and operators live in `public`, which holds nothing else (init script).
      await client.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
      const issuer = await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [
        KNOWLEDGE_ISSUER_ROLE,
      ]);
      if ((issuer.rowCount ?? 0) > 0) {
        await client.query(
          `GRANT ${role} TO ${KNOWLEDGE_ISSUER_ROLE} WITH ADMIN OPTION, INHERIT FALSE, SET FALSE`,
        );
      }
    });
  }

  async missingChunks(projectId: string, model: string, sha256s: readonly string[]) {
    const schema = projectSchema(projectId);
    checked(model, MODEL);
    if (sha256s.length === 0) return [];
    const keys = sha256s.map((s) => checked(s, SHA256));
    const present = await this.#run((client) =>
      client.query<{ sha256: string }>(
        `SELECT sha256 FROM ${schema}.chunks WHERE model = $1 AND sha256 = ANY($2::char(64)[])`,
        [model, keys],
      ),
    );
    const found = new Set(present.rows.map((row) => row.sha256));
    return [...new Set(keys)].filter((key) => !found.has(key));
  }

  async putChunks(input: {
    readonly tenantId: string;
    readonly projectId: string;
    readonly model: string;
    readonly chunks: readonly (KnowledgeChunk & { readonly embedding: readonly number[] })[];
  }) {
    const schema = projectSchema(input.projectId);
    const tenantId = checked(input.tenantId, UUID);
    const model = checked(input.model, MODEL);
    await this.#transaction(async (client) => {
      for (const chunk of input.chunks) {
        await client.query(
          `INSERT INTO ${schema}.chunks (sha256, tenant_id, model, text, embedding)
           VALUES ($1, $2, $3, $4, $5::vector) ON CONFLICT (sha256) DO NOTHING`,
          [
            checked(chunk.sha256, SHA256),
            tenantId,
            model,
            chunk.text,
            vectorLiteral(chunk.embedding),
          ],
        );
      }
    });
  }

  async putIndexVersion(input: KnowledgeIndexInput) {
    const schema = projectSchema(input.projectId);
    checked(input.tenantId, UUID);
    checked(input.indexId, UUID);
    checked(input.baseSha, GIT_SHA);
    checked(input.model, MODEL);
    await this.#transaction(async (client) => {
      await client.query(
        `INSERT INTO ${schema}.index_versions (id, tenant_id, base_sha, model)
         VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO NOTHING`,
        [input.indexId, input.tenantId, input.baseSha, input.model],
      );
      await client.query(`DELETE FROM ${schema}.documents WHERE index_id = $1`, [input.indexId]);
      for (const document of input.documents) {
        const docId = randomUUID();
        await client.query(
          `INSERT INTO ${schema}.documents (index_id, doc_id, path, content_sha256)
           VALUES ($1, $2, $3, $4)`,
          [input.indexId, docId, document.path, checked(document.contentSha256, SHA256)],
        );
        let ord = 0;
        for (const chunk of document.chunks) {
          await client.query(
            `INSERT INTO ${schema}.document_chunks (index_id, doc_id, ord, chunk_sha256)
             VALUES ($1, $2, $3, $4)`,
            [input.indexId, docId, ord++, checked(chunk, SHA256)],
          );
        }
      }
    });
  }

  async deleteIndexVersion(projectId: string, indexId: string) {
    const schema = projectSchema(projectId);
    checked(indexId, UUID);
    return this.#transaction(async (client) => {
      const exists = await client.query('SELECT 1 FROM pg_namespace WHERE nspname = $1', [schema]);
      if (exists.rowCount === 0) return { chunks: 0 };
      // Only this version's chunks that no other version uses: a chunk stored for an index being
      // built (not yet in a version) is never deleted here.
      const own = await client.query<{ sha256: string }>(
        `SELECT DISTINCT chunk_sha256 AS sha256 FROM ${schema}.document_chunks WHERE index_id = $1`,
        [indexId],
      );
      await client.query(`DELETE FROM ${schema}.index_versions WHERE id = $1`, [indexId]);
      if (own.rows.length === 0) return { chunks: 0 };
      const removed = await client.query(
        `DELETE FROM ${schema}.chunks c
          WHERE c.sha256 = ANY($1::char(64)[])
            AND NOT EXISTS (SELECT 1 FROM ${schema}.document_chunks dc
                             WHERE dc.chunk_sha256 = c.sha256)`,
        [own.rows.map((row) => row.sha256)],
      );
      return { chunks: removed.rowCount ?? 0 };
    });
  }

  async listIndexVersions(projectId: string) {
    const schema = projectSchema(projectId);
    return this.#run(async (client) => {
      const exists = await client.query('SELECT 1 FROM pg_namespace WHERE nspname = $1', [schema]);
      if (exists.rowCount === 0) return [];
      const rows = await client.query<{ id: string; created_at: Date }>(
        `SELECT id, created_at FROM ${schema}.index_versions ORDER BY created_at, id`,
      );
      return rows.rows.map((row) => ({ id: row.id, createdAt: new Date(row.created_at) }));
    });
  }

  async deleteOrphanChunks(projectId: string, before: Date) {
    const schema = projectSchema(projectId);
    return this.#run(async (client) => {
      const exists = await client.query('SELECT 1 FROM pg_namespace WHERE nspname = $1', [schema]);
      if (exists.rowCount === 0) return 0;
      const removed = await client.query(
        `DELETE FROM ${schema}.chunks c
          WHERE c.created_at < $1
            AND NOT EXISTS (SELECT 1 FROM ${schema}.document_chunks dc
                             WHERE dc.chunk_sha256 = c.sha256)`,
        [before],
      );
      return removed.rowCount ?? 0;
    });
  }

  async dropProject(projectId: string) {
    const schema = projectSchema(projectId);
    const role = projectRole(projectId);
    await this.#transaction(async (client) => {
      await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      const exists = await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role]);
      if ((exists.rowCount ?? 0) > 0) {
        // X04 PR 3b: its grants outside the schema go first, or the role cannot be dropped.
        await client.query(`REVOKE ALL ON DATABASE ${KNOWLEDGE_DATABASE} FROM ${role}`);
        await client.query(`REVOKE ALL ON SCHEMA public FROM ${role}`);
        await client.query(`DROP ROLE ${role}`);
      }
    });
  }

  async close() {
    await this.#pool.end();
  }
}
