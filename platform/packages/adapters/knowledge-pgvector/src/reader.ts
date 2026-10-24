// The read side of the index (task X04 PR 3b, design/ADR-M89): what a run's `read_documents` tool
// asks `knowledge-db` with the run's own login, a member of the project's read role only. A plain
// cosine search over one index version (K01: no approximate index). The answer holds client text
// (paths and chunks): it goes to the agent and nowhere else; never into a log.
import pg from 'pg';

const SCHEMA = /^kdocs_p[0-9a-f]{32}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$/;

/** One chunk of the answer, best first. */
export interface KnowledgeHit {
  readonly docId: string;
  readonly contentSha256: string;
  /** Relative path in the repository (client data). */
  readonly path: string;
  readonly text: string;
  /** Cosine similarity, 1 is the same direction. */
  readonly score: number;
}

export interface KnowledgeSearch {
  readonly indexId: string;
  readonly model: string;
  readonly embedding: readonly number[];
  readonly limit: number;
}

/** Thrown for any failure; the driver's text is never kept (it can echo values). */
export class KnowledgeReadError extends Error {
  override readonly name = 'KnowledgeReadError';

  constructor() {
    super('knowledge.read_failed');
  }
}

export interface PgVectorKnowledgeReaderOptions {
  readonly host: string;
  readonly port: number;
  readonly database: string;
  readonly user: string;
  readonly password: string;
  /** The project's schema (`kdocs_p<32 hex>`), from the run's settings. */
  readonly schema: string;
}

export class PgVectorKnowledgeReader {
  readonly #pool: pg.Pool;
  readonly #schema: string;

  constructor(options: PgVectorKnowledgeReaderOptions) {
    if (!SCHEMA.test(options.schema)) throw new KnowledgeReadError();
    this.#schema = options.schema;
    this.#pool = new pg.Pool({
      host: options.host,
      port: options.port,
      database: options.database,
      user: options.user,
      password: options.password,
      // The per-run login has CONNECTION LIMIT 4 (@sdlc/secrets `creationStatements`).
      max: 2,
      statement_timeout: 30_000,
    });
    // A pool without an error listener ends the process on an idle-client error (R084).
    this.#pool.on('error', () => undefined);
  }

  async search(input: KnowledgeSearch): Promise<KnowledgeHit[]> {
    if (
      !UUID.test(input.indexId) ||
      !MODEL.test(input.model) ||
      !Number.isSafeInteger(input.limit) ||
      input.limit < 1 ||
      input.limit > 100 ||
      input.embedding.length === 0 ||
      input.embedding.some((v) => !Number.isFinite(v))
    ) {
      throw new KnowledgeReadError();
    }
    const schema = this.#schema;
    try {
      const result = await this.#pool.query<{
        doc_id: string;
        content_sha256: string;
        path: string;
        text: string;
        score: number;
      }>(
        `SELECT d.doc_id, d.content_sha256, d.path, c.text,
                1 - (c.embedding <=> $1::vector) AS score
           FROM ${schema}.document_chunks dc
           JOIN ${schema}.documents d ON d.index_id = dc.index_id AND d.doc_id = dc.doc_id
           JOIN ${schema}.chunks c ON c.sha256 = dc.chunk_sha256
          WHERE dc.index_id = $2 AND c.model = $3
          ORDER BY c.embedding <=> $1::vector, d.doc_id, dc.ord
          LIMIT $4`,
        [`[${input.embedding.join(',')}]`, input.indexId, input.model, input.limit],
      );
      return result.rows.map((row) => ({
        docId: row.doc_id,
        contentSha256: row.content_sha256.trim(),
        path: row.path,
        text: row.text,
        score: Number(row.score),
      }));
    } catch {
      throw new KnowledgeReadError();
    }
  }

  async close(): Promise<void> {
    await this.#pool.end();
  }
}
