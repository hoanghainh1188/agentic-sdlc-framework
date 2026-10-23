// D-08 X04 PR 3a (design/ADR-M89 §2.3): the index of a project's documents, without a database.
// - `chunkMarkdown`: headings, then paragraphs, at most `chunk_chars`; keys by model and text.
// - `LiteLLMEmbedder`: `POST /v1/embeddings` with the run's key; rows checked (order, holes,
//   duplicates, sizes); no key or text in an error.
// - `buildProjectIndex` with fakes: reuse of a ready index, only missing chunks embedded in
//   batches, every limit, a truncated tree, an unreadable file, a failed model call (never a
//   partial index), the race with another run of the same commit, an index purged meanwhile.
// The tables and the store: tests/integration/db/knowledge-index.test.ts and
// tests/integration/knowledge/pgvector-store.test.ts.
import { GatewayError, LiteLLMEmbedder } from '@sdlc/adapter-model-litellm';
import {
  GitHostError,
  KnowledgeError,
  type KnowledgeIndexInput,
  type KnowledgeStore,
  type ProjectConfig,
} from '@sdlc/contracts';
import { Redacted } from '@sdlc/secrets';
import { describe, expect, it } from 'vitest';

import { DbError } from '../../packages/core/src/db/errors.js';
import type { TenantScope } from '../../packages/core/src/db/tenant-scope.js';
import {
  chunkKey,
  chunkMarkdown,
  isMarkdownPath,
} from '../../packages/core/src/knowledge/chunk.js';
import {
  buildProjectIndex,
  type BuildIndexInput,
} from '../../packages/core/src/knowledge/indexer.js';

const KEY = new Redacted('sk-run-key-canary');
const PROJECT = '22222222-2222-4222-8222-222222222222';
const SHA = 'a'.repeat(40);
const LIMITS: ProjectConfig['knowledge'] = {
  max_files: 10,
  max_file_bytes: 10_000,
  max_total_bytes: 20_000,
  max_chunks: 50,
  chunk_chars: 200,
  embed_batch: 2,
};

describe('chunkMarkdown', () => {
  it('splits at headings, then paragraphs, to at most the size', () => {
    const text = '# One\n\nfirst para\n\nsecond para\n## Two\nthird\r\n\r\nfourth';
    expect(chunkMarkdown(text, 200)).toEqual([
      '# One\n\nfirst para\n\nsecond para',
      '## Two\nthird\n\nfourth',
    ]);
    expect(chunkMarkdown(text, 15)).toEqual([
      '# One',
      'first para',
      'second para',
      '## Two\nthird',
      'fourth',
    ]);
  });

  it('cuts a paragraph longer than the size, and drops empty text', () => {
    expect(chunkMarkdown('x'.repeat(25), 10)).toEqual([
      'x'.repeat(10),
      'x'.repeat(10),
      'x'.repeat(5),
    ]);
    expect(chunkMarkdown('\n\n  \n', 10)).toEqual([]);
    for (const chunk of chunkMarkdown('a b c\n\n'.repeat(100), 30)) {
      expect(chunk.length).toBeLessThanOrEqual(30);
    }
  });

  it('keys a chunk by model and text; reads Markdown files only', () => {
    expect(chunkKey('bge-m3', 'a')).toMatch(/^[0-9a-f]{64}$/);
    expect(chunkKey('bge-m3', 'a')).not.toBe(chunkKey('other', 'a'));
    expect(chunkKey('bge-m3', 'a')).not.toBe(chunkKey('bge-m3', 'b'));
    expect(['a.md', 'docs/B.MARKDOWN'].every(isMarkdownPath)).toBe(true);
    expect(['a.mdx', 'md', 'a.md.txt'].some(isMarkdownPath)).toBe(false);
  });
});

function fakeFetch(answer: (body: { model: string; input: string[] }) => Response) {
  const calls: { url: string; auth: string; body: { model: string; input: string[] } }[] = [];
  const fn = ((url: URL, init: RequestInit) => {
    const body = JSON.parse(init.body as string) as { model: string; input: string[] };
    calls.push({
      url: String(url),
      auth: (init.headers as Record<string, string>).authorization ?? '',
      body,
    });
    return Promise.resolve(answer(body));
  }) as unknown as typeof fetch;
  return { fn, calls };
}

const rows = (data: unknown) => new Response(JSON.stringify({ data }), { status: 200 });

describe('LiteLLMEmbedder', () => {
  it('sends the texts with the run key and returns the vectors in input order', async () => {
    const { fn, calls } = fakeFetch(() =>
      rows([
        { index: 1, embedding: [0, 1] },
        { index: 0, embedding: [1, 0] },
      ]),
    );
    const embedder = new LiteLLMEmbedder({ baseUrl: 'http://litellm:4000', fetch: fn });
    expect(await embedder.embed(KEY, 'bge-m3', ['a', 'b'])).toEqual([
      [1, 0],
      [0, 1],
    ]);
    expect(calls).toEqual([
      {
        url: 'http://litellm:4000/v1/embeddings',
        auth: 'Bearer sk-run-key-canary',
        body: { model: 'bge-m3', input: ['a', 'b'] },
      },
    ]);
    expect(await embedder.embed(KEY, 'bge-m3', [])).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  it.each([
    ['a missing row', [{ index: 0, embedding: [1] }]],
    [
      'a duplicate index',
      [
        { index: 0, embedding: [1] },
        { index: 0, embedding: [1] },
      ],
    ],
    [
      'an index out of range',
      [
        { index: 0, embedding: [1] },
        { index: 2, embedding: [1] },
      ],
    ],
    [
      'a value that is not a number',
      [
        { index: 0, embedding: [1] },
        { index: 1, embedding: ['x'] },
      ],
    ],
    [
      'vectors of mixed sizes',
      [
        { index: 0, embedding: [1] },
        { index: 1, embedding: [1, 2] },
      ],
    ],
    ['no data', undefined],
  ])('refuses %s', async (_name, data) => {
    const { fn } = fakeFetch(() => rows(data));
    const embedder = new LiteLLMEmbedder({ baseUrl: 'http://litellm:4000', fetch: fn });
    await expect(embedder.embed(KEY, 'bge-m3', ['a', 'b'])).rejects.toMatchObject({
      code: 'unexpected_response',
    });
  });

  it('never puts the key or a text into an error', async () => {
    const statuses = [
      () => new Response('sk-run-key-canary TEXTCANARY', { status: 401 }),
      () => new Response('not json TEXTCANARY', { status: 200 }),
    ];
    for (const answer of statuses) {
      const { fn } = fakeFetch(answer);
      const embedder = new LiteLLMEmbedder({ baseUrl: 'http://litellm:4000', fetch: fn });
      const error = await embedder.embed(KEY, 'bge-m3', ['TEXTCANARY']).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(GatewayError);
      expect(JSON.stringify(error) + String(error)).not.toMatch(/sk-run-key-canary|TEXTCANARY/);
    }
    const unreachable = new LiteLLMEmbedder({
      baseUrl: 'http://litellm:4000',
      fetch: () => Promise.reject(new Error('sk-run-key-canary')),
    });
    const error = await unreachable.embed(KEY, 'bge-m3', ['a']).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'unreachable' });
    expect(String(error)).not.toContain('sk-run-key-canary');
    await expect(unreachable.embed(KEY, 'bad model', ['a'])).rejects.toMatchObject({
      code: 'invalid_input',
    });
  });
});

interface Row {
  id: string;
  documents: number;
  chunks: number;
  purged: boolean;
}

/** A fake `knowledgeIndexes` repository and store, enough for `buildProjectIndex`. */
function fakes(files: Record<string, string>, options: { paths?: () => string[] } = {}) {
  const rowsById = new Map<string, Row>();
  const uses: { indexId: string; runId: string }[] = [];
  const stored = new Map<string, string>();
  const versions: KnowledgeIndexInput[] = [];
  const deleted: string[] = [];
  const embedded: string[][] = [];
  let conflictWith: Row | undefined;
  const repo = {
    findReady: () => Promise.resolve([...rowsById.values()].find((r) => !r.purged)),
    create: (input: { id: string; documents: number; chunks: number }) => {
      if (conflictWith) {
        rowsById.set(conflictWith.id, conflictWith);
        conflictWith = undefined;
        return Promise.reject(new DbError('conflict', 'duplicate'));
      }
      const row = { id: input.id, documents: input.documents, chunks: input.chunks, purged: false };
      rowsById.set(row.id, row);
      return Promise.resolve(row);
    },
    recordUse: (input: { indexId: string; runId: string }) => {
      if (rowsById.get(input.indexId)?.purged !== false) return Promise.resolve(false);
      uses.push({ indexId: input.indexId, runId: input.runId });
      return Promise.resolve(true);
    },
  };
  const scope = { tenantId: '11111111-1111-4111-8111-111111111111', knowledgeIndexes: repo };
  const store: KnowledgeStore = {
    ensureProject: () => Promise.resolve(),
    missingChunks: (_p, _m, keys) => Promise.resolve(keys.filter((k) => !stored.has(k))),
    putChunks: ({ chunks }) => {
      for (const c of chunks) stored.set(c.sha256, c.text);
      return Promise.resolve();
    },
    putIndexVersion: (input) => {
      versions.push(input);
      return Promise.resolve();
    },
    deleteIndexVersion: (_p, id) => {
      deleted.push(id);
      return Promise.resolve({ chunks: 0 });
    },
    listIndexVersions: () => Promise.resolve([]),
    deleteOrphanChunks: () => Promise.resolve(0),
    dropProject: () => Promise.resolve(),
    close: () => Promise.resolve(),
  };
  const deps = {
    gitHost: {
      listPaths: () => Promise.resolve(options.paths ? options.paths() : Object.keys(files)),
      getFileAtCommit: (_ref: unknown, path: string) =>
        path in files
          ? Promise.resolve(files[path]!)
          : Promise.reject(new GitHostError('not_found')),
    },
    store,
    embedder: {
      embed: (_key: unknown, _model: string, inputs: readonly string[]) => {
        embedded.push([...inputs]);
        return Promise.resolve(inputs.map(() => [0.5, 0.5]));
      },
    },
  };
  return {
    scope: scope as unknown as TenantScope,
    deps,
    rowsById,
    uses,
    stored,
    versions,
    deleted,
    embedded,
    conflictOnce: (row: Row) => {
      conflictWith = row;
    },
  };
}

const input = (over: Partial<BuildIndexInput> = {}): BuildIndexInput => ({
  ref: { owner: 'o', name: 'r' },
  projectId: PROJECT,
  baseSha: SHA,
  model: 'bge-m3',
  key: KEY,
  runId: '33333333-3333-4333-8333-333333333333',
  intentId: '44444444-4444-4444-8444-444444444444',
  limits: LIMITS,
  now: new Date('2026-10-23T00:00:00Z'),
  ...over,
});

const DOCS = {
  'README.md': '# Shop\n\nOrders and stock.',
  'docs/a.md': '# A\n\nalpha\n\n## B\n\nbeta',
  'src/main.ts': 'not read',
};

describe('buildProjectIndex', () => {
  it('reads the Markdown files only, embeds each chunk once in batches, records the use', async () => {
    const f = fakes({ ...DOCS, 'docs/copy.md': '# Shop\n\nOrders and stock.' });
    const built = await buildProjectIndex(f.scope, f.deps, input());
    expect(built).toMatchObject({ reused: false, documents: 3, chunks: 3 });
    expect(f.versions).toHaveLength(1);
    expect(f.versions[0]!.documents.map((d) => d.path)).toEqual([
      'README.md',
      'docs/a.md',
      'docs/copy.md',
    ]);
    // The copy's chunk equals README's: three distinct chunks, two batches of at most 2.
    expect(f.embedded.map((b) => b.length)).toEqual([2, 1]);
    expect(f.uses).toEqual([{ indexId: built.indexId, runId: input().runId }]);
  });

  it('reuses a ready index of the same commit, and embeds only new chunks of a new commit', async () => {
    const f = fakes(DOCS);
    const first = await buildProjectIndex(f.scope, f.deps, input());
    const again = await buildProjectIndex(f.scope, f.deps, input({ runId: 'r2' }));
    expect(again).toEqual({ ...first, reused: true });
    expect(f.embedded.flat()).toHaveLength(3);
    // A new commit with one changed document: one new chunk only.
    const changed = fakes({ ...DOCS, 'docs/a.md': '# A\n\nalpha\n\n## B\n\ngamma' });
    for (const [k, v] of f.stored) changed.stored.set(k, v);
    await buildProjectIndex(changed.scope, changed.deps, input({ baseSha: 'b'.repeat(40) }));
    expect(changed.embedded).toEqual([['## B\n\ngamma']]);
  });

  it('builds again when the ready index is purged before the use is recorded', async () => {
    const f = fakes(DOCS);
    const first = await buildProjectIndex(f.scope, f.deps, input());
    const repo = (f.scope as unknown as { knowledgeIndexes: { recordUse: unknown } })
      .knowledgeIndexes as { recordUse: (i: { indexId: string }) => Promise<boolean> };
    const original = repo.recordUse;
    repo.recordUse = (i) => {
      if (i.indexId === first.indexId) {
        f.rowsById.get(first.indexId)!.purged = true;
        return Promise.resolve(false);
      }
      return original(i);
    };
    const second = await buildProjectIndex(f.scope, f.deps, input({ runId: 'r2' }));
    expect(second.reused).toBe(false);
    expect(second.indexId).not.toBe(first.indexId);
  });

  it('uses the other run’s index when it recorded the same commit first, and drops its own copy', async () => {
    const f = fakes(DOCS);
    const other = {
      id: '55555555-5555-4555-8555-555555555555',
      documents: 2,
      chunks: 3,
      purged: false,
    };
    f.conflictOnce(other);
    const built = await buildProjectIndex(f.scope, f.deps, input());
    expect(built).toEqual({ indexId: other.id, reused: true, documents: 2, chunks: 3 });
    expect(f.deleted).toEqual([f.versions[0]!.indexId]);
  });

  it.each<[string, Partial<ProjectConfig['knowledge']>, Record<string, string>, string]>([
    ['too_many_files', { max_files: 1 }, DOCS, 'too_many_files'],
    ['file_too_large', { max_file_bytes: 10 }, DOCS, 'file_too_large'],
    ['too_many_bytes', { max_total_bytes: 30 }, DOCS, 'too_many_bytes'],
    ['too_many_chunks', { max_chunks: 1 }, DOCS, 'too_many_chunks'],
  ])('refuses a repository over a limit: %s, with no index', async (_n, limits, files, code) => {
    const f = fakes(files);
    await expect(
      buildProjectIndex(f.scope, f.deps, input({ limits: { ...LIMITS, ...limits } })),
    ).rejects.toMatchObject({ code });
    expect(f.versions).toEqual([]);
    expect(f.embedded).toEqual([]);
    expect(f.uses).toEqual([]);
  });

  it('refuses a truncated tree, an unreadable file, a failed model call and a missing store', async () => {
    const truncated = fakes(DOCS, {
      paths: () => {
        throw new GitHostError('tree_truncated');
      },
    });
    await expect(buildProjectIndex(truncated.scope, truncated.deps, input())).rejects.toMatchObject(
      { code: 'tree_truncated' },
    );
    const unreadable = fakes(DOCS, { paths: () => ['README.md', 'gone.md'] });
    await expect(
      buildProjectIndex(unreadable.scope, unreadable.deps, input()),
    ).rejects.toMatchObject({ code: 'file_unreadable' });
    const failing = fakes(DOCS);
    failing.deps.embedder.embed = () => Promise.reject(new Error('sk-run-key-canary'));
    const error = await buildProjectIndex(failing.scope, failing.deps, input()).catch(
      (e: unknown) => e,
    );
    expect(error).toEqual(new KnowledgeError('embedding_failed'));
    expect(failing.versions).toEqual([]);
    const off = fakes(DOCS);
    await expect(
      buildProjectIndex(off.scope, { ...off.deps, store: undefined }, input()),
    ).rejects.toMatchObject({ code: 'store_unavailable' });
  });
});
