// The pieces of the C09 pilot stack that stand in for outside systems (see stack.ts): the pilot
// repository as a bare Git repository on the local Git host, an in-memory evidence bucket, and the
// model gateway the real Cost Controller uses (run keys registered at the stub model).
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  EvidenceError,
  type EvidenceGetOptions,
  type CostLabels,
  type EvidenceStore,
  type ModelGateway,
  type SpendRecord,
  type StoredEvidence,
} from '../../../packages/contracts/src/index.js';
import { Redacted } from '../../../packages/secrets/src/index.js';
import type { StubAnswer, StubRequest } from '../../git-github/stub-github.js';
import type { StubGitHost } from '../../runner/stub-git.js';
import { OWNER, REPO, type RepoBackend } from '../workflow/g1-g3/stack.js';

export const MODEL = 'stub-model-1';
export const REPO_FULL = `${OWNER}/${REPO}`;

const GIT_ENV = {
  PATH: process.env.PATH,
  HOME: os.tmpdir(),
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_AUTHOR_NAME: 'Pilot fixture',
  GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
  GIT_COMMITTER_NAME: 'Pilot fixture',
  GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
};

export const sha256 = (text: string | Buffer): string =>
  crypto.createHash('sha256').update(text).digest('hex');

// --- The repository --------------------------------------------------------------------------

/**
 * The pilot repository as a bare Git repository on the local Git host: the GitHub API stub reads
 * refs, files and trees from it; the runner clones and pushes over smart HTTP; `main` is
 * protected (a `pre-receive` hook, N6). Commits on `main` are written with plumbing, never pushed.
 */
export class BareRepo implements RepoBackend {
  readonly #host: StubGitHost;
  readonly #bare: string;
  #stub: Parameters<RepoBackend['route']>[0] | undefined;
  #repoPath = '';

  constructor(host: StubGitHost, files: Readonly<Record<string, string>>) {
    this.#host = host;
    this.#bare = path.join(host.root, `${REPO_FULL}.git`);
    const first = host.createRepo(REPO_FULL, files);
    // `createRepo` adds a second commit (CHANGELOG.md); the pilot starts at the first.
    this.#git('update-ref', 'refs/heads/main', first.first);
    host.allowPush(REPO_FULL, { protect: ['main'] });
  }

  #git(...args: string[]): string {
    return execFileSync('git', args, { cwd: this.#bare, env: GIT_ENV, encoding: 'utf8' }).trim();
  }

  head(branch = 'main'): string | null {
    return this.#host.branchHead(REPO_FULL, branch);
  }

  /** The file at a commit, or null. */
  file(ref: string, file: string): Buffer | null {
    try {
      return execFileSync('git', ['cat-file', 'blob', `${ref}:${file}`], {
        cwd: this.#bare,
        env: GIT_ENV,
      });
    } catch {
      return null;
    }
  }

  /** The changed paths of a commit against its parent. */
  changedPaths(commit: string): string[] {
    return this.#git('diff-tree', '--no-commit-id', '--name-only', '-r', commit)
      .split('\n')
      .filter((p) => p !== '');
  }

  route(stub: Parameters<RepoBackend['route']>[0], repoPath: string): void {
    this.#stub = stub;
    this.#repoPath = repoPath;
    stub.on('GET', `${repoPath}/git/ref/heads/main`, () => ({
      body: { ref: 'refs/heads/main', object: { type: 'commit', sha: this.head() } },
    }));
    for (const file of this.#git('ls-tree', '-r', '--name-only', 'main').split('\n')) {
      this.#routeFile(file);
    }
  }

  /** Answers `contents/<file>` and `git/trees/<sha>` (registered by the pilot router). */
  answer(req: StubRequest): StubAnswer | undefined {
    const tree = new RegExp(`^${this.#repoPath}/git/trees/([0-9a-f]{40})$`).exec(req.path);
    if (req.method !== 'GET' || !tree) return undefined;
    let listing: string;
    try {
      listing = this.#git('ls-tree', '-r', '--full-tree', tree[1]!);
    } catch {
      return { status: 404, body: { message: 'Not Found' } };
    }
    const entries = listing
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => {
        const [meta, file] = line.split('\t');
        const [mode, type, sha] = meta!.split(' ');
        return { path: file, mode, type, sha };
      });
    return { body: { sha: tree[1], truncated: false, tree: entries } };
  }

  #routeFile(file: string): void {
    this.#stub?.on('GET', `${this.#repoPath}/contents/${file}`, (req) => {
      const content = this.file(req.query.get('ref') ?? 'main', file);
      return content === null
        ? { status: 404, body: { message: 'Not Found' } }
        : {
            raw: content,
            headers: { 'content-type': 'application/vnd.github.raw; charset=utf-8' },
          };
    });
  }

  /**
   * E07: a person merges the agent branch into `main` on the Git host (a merge commit with the
   * branch's tree, `main` and the branch head as parents). The platform never merges.
   */
  merge(branch: string): string {
    const main = this.head()!;
    const head = this.head(branch);
    if (!head) throw new Error(`no branch ${branch}`);
    const tree = this.#git('rev-parse', `${head}^{tree}`);
    const commit = this.#git(
      'commit-tree',
      tree,
      '-p',
      main,
      '-p',
      head,
      '-m',
      `Merge ${branch} (a person, E07 test)`,
    );
    this.#git('update-ref', 'refs/heads/main', commit, main);
    for (const file of this.changedPaths(head)) this.#routeFile(file);
    return commit;
  }

  commit(changes: Readonly<Record<string, string | null>>): string {
    const index = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-c09-index-')), 'index');
    const env = { ...GIT_ENV, GIT_INDEX_FILE: index };
    const git = (args: string[], input?: string) =>
      execFileSync('git', args, {
        cwd: this.#bare,
        env,
        encoding: 'utf8',
        ...(input === undefined ? {} : { input }),
      }).trim();
    try {
      const parent = this.head()!;
      git(['read-tree', parent]);
      for (const [file, text] of Object.entries(changes)) {
        if (text === null) git(['update-index', '--force-remove', file]);
        else {
          const blob = git(['hash-object', '-w', '--stdin'], text);
          git(['update-index', '--add', '--cacheinfo', `100644,${blob},${file}`]);
          this.#routeFile(file);
        }
      }
      const tree = git(['write-tree']);
      const commit = git(['commit-tree', tree, '-p', parent, '-m', 'pilot fixture change']);
      git(['update-ref', 'refs/heads/main', commit, parent]);
      return commit;
    } finally {
      fs.rmSync(path.dirname(index), { recursive: true, force: true });
    }
  }
}

// --- Evidence ----------------------------------------------------------------------------------

/** One in-memory bucket `evidence`; each store writes under its own key prefix, never twice. */
export class MemoryBucket {
  readonly objects = new Map<string, Buffer>();

  store(prefix: string): EvidenceStore {
    return {
      put: (tenantId, file, content): Promise<StoredEvidence> => {
        const key = `${prefix}${tenantId}/${file}`;
        if (this.objects.has(key)) return Promise.reject(new EvidenceError('exists'));
        this.objects.set(key, Buffer.from(content));
        return Promise.resolve({
          uri: `s3://evidence/${key}`,
          sha256: sha256(content),
          sizeBytes: content.length,
        });
      },
      get: (uri: string, options: EvidenceGetOptions = {}): Promise<Buffer> => {
        const body = this.objects.get(uri.slice('s3://evidence/'.length));
        if (!body) return Promise.reject(new EvidenceError('not_found'));
        if (options.maxBytes !== undefined && body.length > options.maxBytes) {
          return Promise.reject(new EvidenceError('too_large'));
        }
        return Promise.resolve(body);
      },
    };
  }

  keys(prefix: string): string[] {
    return [...this.objects.keys()].filter((key) => key.startsWith(prefix));
  }
}

// --- The model gateway -------------------------------------------------------------------------

/** One counted call of a run key at the stub model (`GET /test/calls`). */
export interface StubCall {
  readonly key: string;
  readonly n: number;
  readonly at: string;
}

/** The stub model's price per call (`STUB_PRICE_USD`, default of stub-model.mjs). */
export const STUB_PRICE_USD = '0.010000';

/**
 * The gateway the real Cost Controller uses: each run key is registered at the stub model with
 * its cap (as LiteLLM keeps it) and revoked there. E07: `listSpend` returns one record per call
 * the stub model counted, with the labels of the key the call used (as LiteLLM's spend log does
 * with the key's metadata), so the run-end sync (C12) writes `cost_records` like in production.
 */
export class StubGateway implements ModelGateway {
  readonly revokedRuns: string[] = [];
  readonly #keys = new Map<string, string>(); // run ID → key
  readonly #labels = new Map<string, CostLabels>(); // key → labels
  readonly #admin: (method: 'POST' | 'DELETE', body: object) => Promise<void>;
  readonly #calls: () => Promise<readonly StubCall[]>;

  constructor(
    admin: (method: 'POST' | 'DELETE', body: object) => Promise<void>,
    calls: () => Promise<readonly StubCall[]> = () => Promise.resolve([]),
  ) {
    this.#admin = admin;
    this.#calls = calls;
  }

  ensureTenantBudget(): ReturnType<ModelGateway['ensureTenantBudget']> {
    return Promise.resolve({ tenantGroupId: 'c09-tenant' });
  }

  async createRunKey(
    input: Parameters<ModelGateway['createRunKey']>[0],
  ): ReturnType<ModelGateway['createRunKey']> {
    const key = `sk-c09-${crypto.randomBytes(16).toString('hex')}`;
    await this.#admin('POST', { key, max_budget: Number(input.maxBudgetUsd) });
    this.#keys.set(input.runId, key);
    this.#labels.set(key, input.labels);
    return {
      keyId: `key-${input.runId}`,
      key: new Redacted(key),
      expiresAt: new Date(Date.now() + input.durationMinutes * 60_000),
    };
  }

  revokeKey(keyId: string): Promise<void> {
    return this.revokeRunKey(keyId.replace(/^key-/, ''));
  }

  async revokeRunKey(runId: string): Promise<void> {
    this.revokedRuns.push(runId);
    const key = this.#keys.get(runId);
    if (key) await this.#admin('DELETE', { key });
  }

  getSpend(): ReturnType<ModelGateway['getSpend']> {
    return Promise.resolve({ spendUsd: '0', maxBudgetUsd: null });
  }

  listModels(): ReturnType<ModelGateway['listModels']> {
    return Promise.resolve([{ model: MODEL, providerType: 'api' }]);
  }

  async listSpend(range: {
    readonly from: Date;
    readonly to: Date;
  }): ReturnType<ModelGateway['listSpend']> {
    const records: SpendRecord[] = [];
    for (const call of await this.#calls()) {
      const at = new Date(call.at);
      const labels = this.#labels.get(call.key);
      if (!labels || at < range.from || at >= range.to) continue;
      records.push({
        sourceRef: `stub-${sha256(call.key).slice(0, 16)}-${String(call.n)}`,
        model: MODEL,
        status: 'success',
        inputTokens: 1000,
        outputTokens: 100,
        cachedInputTokens: 0,
        costUsd: STUB_PRICE_USD,
        occurredAt: at,
        labels,
      });
    }
    return { records, unreadable: 0 };
  }
}
