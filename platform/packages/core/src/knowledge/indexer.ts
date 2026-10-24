// Building the index of a project's documents for a run (task X04 PR 3a, design/ADR-M89 §2.3,
// QUESTIONS #538 a). Called in the run preparation after G4, with the run's own virtual key:
//
//   a ready index of the same base commit and model → reused (a new use)
//   else: the Markdown files at `base_sha` (Git host) → chunks → only new chunks embedded → the
//   index version written to `knowledge-db` → recorded in `knowledge_indexes` → a use
//
// A repository over a limit, a commit listed only in part, a file that cannot be read, a model
// call that fails: `KnowledgeError`, and no index (never a partial one). The texts and paths stay
// in memory and in `knowledge-db`; the platform's tables get IDs, hashes and counts only.
import { createHash, randomUUID } from 'node:crypto';

import {
  GitHostError,
  KnowledgeError,
  type GitHostAdapter,
  type KnowledgeDocument,
  type KnowledgeStore,
  type ProjectConfig,
  type RedactedSecret,
  type RepoRef,
  type RunKeyEmbedder,
} from '@sdlc/contracts';

import { DbError } from '../db/errors.js';
import type { TenantScope } from '../db/tenant-scope.js';
import { chunkKey, chunkMarkdown, isMarkdownPath } from './chunk.js';

export interface KnowledgeDeps {
  readonly gitHost: Pick<GitHostAdapter, 'listPaths' | 'getFileAtCommit'>;
  /** Undefined when `knowledge-db` is not set up: every index then fails (`store_unavailable`). */
  readonly store: KnowledgeStore | undefined;
  readonly embedder: RunKeyEmbedder;
}

export interface BuildIndexInput {
  readonly ref: RepoRef;
  readonly projectId: string;
  readonly baseSha: string;
  /** The tool's `model_ref`: one of the contract's `allowed_models` (the caller checks). */
  readonly model: string;
  /** The run's virtual key: the embeddings' cost counts for the run. */
  readonly key: RedactedSecret;
  readonly runId: string;
  readonly intentId: string;
  readonly limits: ProjectConfig['knowledge'];
  readonly now: Date;
}

export interface BuiltIndex {
  readonly indexId: string;
  readonly reused: boolean;
  readonly documents: number;
  readonly chunks: number;
}

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

async function readDocuments(
  deps: KnowledgeDeps,
  input: BuildIndexInput,
): Promise<{ documents: (KnowledgeDocument & { texts: string[] })[]; bytes: number }> {
  let paths: string[];
  try {
    paths = await deps.gitHost.listPaths(input.ref, input.baseSha);
  } catch (error) {
    if (error instanceof GitHostError && error.code === 'tree_truncated') {
      throw new KnowledgeError('tree_truncated');
    }
    throw new KnowledgeError('file_unreadable');
  }
  const markdown = paths.filter(isMarkdownPath).sort();
  if (markdown.length > input.limits.max_files) throw new KnowledgeError('too_many_files');
  const documents: (KnowledgeDocument & { texts: string[] })[] = [];
  let bytes = 0;
  let chunks = 0;
  for (const path of markdown) {
    let content: string;
    try {
      content = await deps.gitHost.getFileAtCommit(input.ref, path, input.baseSha);
    } catch {
      throw new KnowledgeError('file_unreadable');
    }
    const size = Buffer.byteLength(content, 'utf8');
    if (size > input.limits.max_file_bytes) throw new KnowledgeError('file_too_large');
    bytes += size;
    if (bytes > input.limits.max_total_bytes) throw new KnowledgeError('too_many_bytes');
    const texts = chunkMarkdown(content, input.limits.chunk_chars);
    chunks += texts.length;
    if (chunks > input.limits.max_chunks) throw new KnowledgeError('too_many_chunks');
    documents.push({
      path,
      contentSha256: sha256(content),
      chunks: texts.map((text) => chunkKey(input.model, text)),
      texts,
    });
  }
  return { documents, bytes };
}

/** The ready index of the run's commit, or a new one. Records the run's use either way. */
export async function buildProjectIndex(
  scope: TenantScope,
  deps: KnowledgeDeps,
  input: BuildIndexInput,
): Promise<BuiltIndex> {
  const { store } = deps;
  if (!store) throw new KnowledgeError('store_unavailable');
  const use = async (indexId: string) =>
    scope.knowledgeIndexes.recordUse({
      indexId,
      runId: input.runId,
      intentId: input.intentId,
      at: input.now,
    });
  // X04 PR 3b: also for a reused index, so a project indexed before the issuer role existed gets
  // the grants a run's login needs (idempotent).
  await store.ensureProject({ tenantId: scope.tenantId, projectId: input.projectId });
  const ready = await scope.knowledgeIndexes.findReady(input.projectId, input.baseSha, input.model);
  // A ready index the retention pass purges meanwhile is built again.
  if (ready && (await use(ready.id))) {
    return { indexId: ready.id, reused: true, documents: ready.documents, chunks: ready.chunks };
  }

  const { documents, bytes } = await readDocuments(deps, input);
  const texts = new Map<string, string>();
  for (const document of documents) {
    document.chunks.forEach((key, i) => texts.set(key, document.texts[i]!));
  }
  const indexId = randomUUID();
  try {
    await storeVersion(scope, deps, store, input, texts, documents, indexId);
  } catch (error) {
    // Once more: the retention pass may have deleted a shared chunk between the check and the
    // version's write (the version then refers to a chunk that is gone). The check runs again.
    if (!(error instanceof KnowledgeError && error.code === 'store_unavailable')) throw error;
    await storeVersion(scope, deps, store, input, texts, documents, indexId);
  }
  try {
    await scope.knowledgeIndexes.create({
      id: indexId,
      projectId: input.projectId,
      baseSha: input.baseSha,
      model: input.model,
      documents: documents.length,
      chunks: texts.size,
      bytes,
    });
  } catch (error) {
    if (!(error instanceof DbError && error.code === 'conflict')) throw error;
    // Another run of the same commit recorded its index first: use that one, drop this copy.
    await store.deleteIndexVersion(input.projectId, indexId);
    const other = await scope.knowledgeIndexes.findReady(
      input.projectId,
      input.baseSha,
      input.model,
    );
    if (!other || !(await use(other.id))) throw new KnowledgeError('store_unavailable');
    return { indexId: other.id, reused: true, documents: other.documents, chunks: other.chunks };
  }
  if (!(await use(indexId))) throw new KnowledgeError('store_unavailable');
  return { indexId, reused: false, documents: documents.length, chunks: texts.size };
}

/** Embeds the chunks the project does not hold yet, in batches, then writes the version. */
async function storeVersion(
  scope: TenantScope,
  deps: KnowledgeDeps,
  store: KnowledgeStore,
  input: BuildIndexInput,
  texts: ReadonlyMap<string, string>,
  documents: readonly KnowledgeDocument[],
  indexId: string,
): Promise<void> {
  const missing = await store.missingChunks(input.projectId, input.model, [...texts.keys()]);
  for (let i = 0; i < missing.length; i += input.limits.embed_batch) {
    const batch = missing.slice(i, i + input.limits.embed_batch);
    let vectors: number[][];
    try {
      vectors = await deps.embedder.embed(
        input.key,
        input.model,
        batch.map((key) => texts.get(key)!),
      );
    } catch {
      throw new KnowledgeError('embedding_failed');
    }
    await store.putChunks({
      tenantId: scope.tenantId,
      projectId: input.projectId,
      model: input.model,
      chunks: batch.map((key, j) => ({
        sha256: key,
        text: texts.get(key)!,
        embedding: vectors[j]!,
      })),
    });
  }

  await store.putIndexVersion({
    tenantId: scope.tenantId,
    projectId: input.projectId,
    indexId,
    baseSha: input.baseSha,
    model: input.model,
    documents: documents.map(({ path, contentSha256, chunks }) => ({
      path,
      contentSha256,
      chunks,
    })),
  });
}
