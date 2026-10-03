// The push of a run's checked changes (task C08 PR 1, D-08 C08 AC1, design/ADR-M38 §2.2,
// QUESTIONS #52, #155 A, #156; ADR-M29 §2.5: nothing the sandbox reports is used).
//
// After G5 passed a run and its block window closed, the worker issues a single-repository token
// with `contents: write` and hands it over wrapped; the runner then:
//  1. reads the run, its contract and its run events: the diff G5 checked (`diff_stored`) and the
//     SHA-256 of its sorted changed paths (`changes_checked`). A run already pushed is answered
//     `pushed` again (a repeated activity); a run refused before stays refused;
//  2. reads the stored diff back from the evidence store (the runner's identity may read
//     `evidence/diffs/*`, QUESTIONS #155) and checks its SHA-256: another file → `diff_mismatch`;
//  3. clones the repository without a working tree (`cloneForPush`); the token is only in git's
//     environment; reads the branch on the Git host (`remoteBranchHead`);
//  4. builds the commit in a private index only: `read-tree <base_sha>`, `apply --cached
//     --binary` of the diff, `write-tree`. No file of the change is written to disk, so links in
//     the change are never followed. The changed paths must hash to what G5 checked
//     (`diff_mismatch`); no change at all → `empty_diff`;
//  5. one commit on `base_sha`, author and committer `sdlc-agent
//     <agent-<agent_id>@agents.sdlc.invalid>` (QUESTIONS #80), message `sdlc: <INT-…> run <run_id>`,
//     both dates = the run's end: a repeated push makes the same commit, so it is idempotent;
//  6. the branch must be absent, at `base_sha` (the next run of the intent, QUESTIONS #134) or
//     already at the commit; anything else → `branch_moved` (someone else changed it). Push with an
//     explicit refspec, no force; read the branch again: it must show the commit;
//  7. records `branch_pushed` and sets `runs.head_sha` once (migration 0017), in one transaction;
//  8. (C11, ADR-M42 §2.4) revokes the push token, whatever the outcome (`token_revoked`). A
//     wrapping token that cannot be opened is recorded as `wrap_token_reused`.
// Final refusals are recorded as `publish_refused` (a person decides, QUESTIONS #156); causes that
// may pass (the token, the Git host, the evidence store) as `publish_failed`. Codes only: never a
// path, git's text or the token.
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import type {
  EvidenceStore,
  PublishRunInput,
  PublishRunResult,
  RedactedSecret,
  SecretUnwrapper,
} from '@sdlc/contracts';
import { parseTenantId, publishState, type PlatformDatabase, type TenantScope } from '@sdlc/core';
import { Redacted } from '@sdlc/secrets';

import { RunnerError } from '../errors.js';
import type { RunnerSettings } from '../settings.js';
import {
  isRefusedWrapToken,
  recordWrapTokenReused,
  revokeAfterUse,
  type GitTokenRevoker,
} from '../tokens.js';
import { cloneForPush, PushError, pushCommit, remoteBranchHead } from './git.js';
import { gitArgs, gitEnv } from './proposal.js';

export interface PublishDeps {
  readonly db: PlatformDatabase;
  readonly settings: Pick<RunnerSettings, 'git' | 'workDir' | 'workspaceMaxBytes'>;
  /** The diffs store (key prefix `diffs/`) with a credential that may read. */
  readonly diffEvidence?: Pick<EvidenceStore, 'get'>;
  readonly unwrapper: SecretUnwrapper;
  /** Revokes the push token right after the push (C11, ADR-M42 §2.4; ADR-M38 §2.3). */
  readonly tokenRevoker?: GitTokenRevoker;
}

/** Final causes: the runner never pushes this run (QUESTIONS #156). */
export type PublishRefusal =
  | 'not_succeeded'
  | 'contract_invalid'
  | 'changes_missing'
  | 'diff_mismatch'
  | 'empty_diff'
  | 'diff_not_applicable'
  | 'base_not_found'
  | 'branch_moved';

/** Causes that may pass on a new attempt. */
export type PublishFailure =
  | 'evidence_unavailable'
  | 'token_unavailable'
  | 'clone_failed'
  | 'remote_read_failed'
  | 'push_rejected'
  | 'record_failed'
  /** Anything else (local git, the file system, the database): see the runner's log. */
  | 'internal';

class Refused extends Error {
  constructor(readonly reason: PublishRefusal) {
    super(reason);
  }
}

class Failed extends Error {
  constructor(readonly reason: PublishFailure) {
    super(reason);
  }
}

const SHA = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const BRANCH = /^agent\/(INT-[0-9]{4}-[0-9]{4,9})$/;
const REPO = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

interface Facts {
  readonly runId: string;
  readonly repo: string;
  readonly branch: string;
  readonly intentCode: string;
  readonly baseSha: string;
  readonly agentId: string;
  readonly finishedAt: Date;
  readonly diffSha256: string;
  readonly diffUri: string;
  readonly pathsSha256: string;
}

/** Pushes the run's checked changes (see the header). Never throws for a known cause. */
export async function publishRun(
  deps: PublishDeps,
  input: PublishRunInput,
): Promise<PublishRunResult> {
  const scope = deps.db.forTenant(parseTenantId(input.tenantId));
  const state = await publishState(scope, input.runId);
  if (state.pushed) return { outcome: 'pushed' };
  if (state.refused) return { outcome: 'refused', reason: state.refused };
  try {
    const facts = await readFacts(scope, input.runId);
    if (!deps.diffEvidence) throw new Failed('evidence_unavailable');
    const token = await unwrapToken(deps.unwrapper, input.wrappedPushToken, () =>
      // Opened by someone else, or expired before this attempt (C11, ADR-M42 §2.5).
      recordWrapTokenReused(scope, input.runId, 'push'),
    );
    const dir = fs.mkdtempSync(path.join(deps.settings.workDir, 'publish-'));
    try {
      const patch = await readPatch(deps.diffEvidence, facts);
      const head = await pushChanges(deps, facts, patch, token, dir);
      await record(scope, input.runId, facts, head);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      // The push token ends with the push, whatever the outcome (C11).
      await revokeAfterUse(deps.tokenRevoker, scope, input.runId, token, 'push');
    }
    return { outcome: 'pushed' };
  } catch (error) {
    if (error instanceof Refused) {
      await scope.runEvents.append(input.runId, 'publish_refused', { reason: error.reason });
      return { outcome: 'refused', reason: error.reason };
    }
    const reason: PublishFailure =
      error instanceof Failed
        ? error.reason
        : error instanceof PushError
          ? error.reason
          : 'internal';
    await scope.runEvents.append(input.runId, 'publish_failed', { reason });
    return { outcome: 'failed', reason };
  }
}

async function readFacts(scope: TenantScope, runId: string): Promise<Facts> {
  const run = await scope.runs.getById(runId);
  if (!run || run.status !== 'succeeded' || run.finished_at === null) {
    throw new Refused('not_succeeded');
  }
  const contract = (await scope.runContracts.getByRunId(runId))?.contract_json;
  const repo = contract?.repo;
  const branch = contract?.branch;
  const baseSha = contract?.base_sha;
  const agentId = contract?.agent_id;
  const match = typeof branch === 'string' ? BRANCH.exec(branch) : null;
  // The stored contract was verified when the run started; check it again against the platform's
  // own records: the project's repository and the intent's own branch (security review).
  const project = await scope.projects.getById(String(contract?.project_id));
  const intent = await scope.intents.getById(run.intent_id);
  if (
    typeof repo !== 'string' ||
    !REPO.test(repo) ||
    repo !== project?.repo_full_name ||
    !match ||
    branch !== run.branch ||
    branch !== `agent/${intent?.code ?? ''}` ||
    typeof baseSha !== 'string' ||
    !SHA.test(baseSha) ||
    baseSha !== run.base_sha ||
    typeof agentId !== 'string' ||
    !UUID.test(agentId)
  ) {
    throw new Refused('contract_invalid');
  }
  let diffSha256: string | null = null;
  let pathsSha256: string | null = null;
  for (const event of await scope.runEvents.list(runId)) {
    const p = event.payload;
    if (event.event_type === 'diff_stored') diffSha256 = String(p.sha256);
    if (event.event_type === 'changes_checked') pathsSha256 = String(p.paths_sha256);
  }
  const item = (await scope.evidenceItems.listForIntent(run.intent_id)).find(
    (e) => e.run_id === runId && e.kind === 'diff',
  );
  if (
    diffSha256 === null ||
    pathsSha256 === null ||
    !SHA256.test(diffSha256) ||
    !SHA256.test(pathsSha256) ||
    !item ||
    item.sha256 !== diffSha256 ||
    // Only the run's own diff, at the path the runner wrote it (ADR-M34 §2.2).
    !item.storage_uri.endsWith(`/diffs/${scope.tenantId}/${run.intent_id}/${runId}.patch`)
  ) {
    throw new Refused('changes_missing');
  }
  return {
    runId,
    repo,
    branch,
    intentCode: match[1]!,
    baseSha,
    agentId,
    finishedAt: new Date(run.finished_at),
    diffSha256,
    diffUri: item.storage_uri,
    pathsSha256,
  };
}

async function unwrapToken(
  unwrapper: SecretUnwrapper,
  wrapped: string,
  onRefused: () => Promise<void>,
): Promise<RedactedSecret> {
  try {
    const token = (await unwrapper.unwrap(new Redacted(wrapped))).token;
    if (!token) throw new Error('no token field');
    return token;
  } catch (error) {
    if (isRefusedWrapToken(error)) await onRefused();
    throw new Failed('token_unavailable');
  }
}

async function readPatch(store: Pick<EvidenceStore, 'get'>, facts: Facts): Promise<Buffer> {
  let patch: Buffer;
  try {
    patch = await store.get(facts.diffUri);
  } catch {
    throw new Failed('evidence_unavailable');
  }
  const sha256 = crypto.createHash('sha256').update(patch).digest('hex');
  if (sha256 !== facts.diffSha256) throw new Refused('diff_mismatch');
  if (patch.length === 0) throw new Refused('empty_diff');
  return patch;
}

/** Builds the commit and pushes it; returns the pushed commit. */
async function pushChanges(
  deps: PublishDeps,
  facts: Facts,
  patch: Buffer,
  token: RedactedSecret,
  dir: string,
): Promise<string> {
  const git = deps.settings.git;
  const repoDir = await cloneForPush(git, { repo: facts.repo, token, dir });
  const home = path.join(dir, 'home');
  const commit = await buildCommit(deps, facts, patch, repoDir, home, dir);
  const remote = { repo: facts.repo, branch: facts.branch, token, home };
  const before = await remoteBranchHead(git, remote);
  if (before === commit) return commit;
  if (before !== null && before !== facts.baseSha) throw new Refused('branch_moved');
  try {
    await pushCommit(git, { ...remote, repoDir, commit });
  } catch (error) {
    // Someone else may have changed the branch between the read and the push.
    const now = await remoteBranchHead(git, remote).catch(() => undefined);
    if (now === commit) return commit;
    if (now !== undefined && now !== null && now !== facts.baseSha) {
      throw new Refused('branch_moved');
    }
    throw error;
  }
  const after = await remoteBranchHead(git, remote);
  if (after !== commit) throw new Refused('branch_moved');
  return commit;
}

/** Local git in the push clone: hardened (`gitArgs`), with a private index and fixed identity. */
function localGit(
  repoDir: string,
  home: string,
  env: Readonly<Record<string, string>>,
  args: string[],
  options: { readonly timeoutMs: number; readonly maxBytes: number },
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      gitArgs(repoDir, ['-c', 'commit.gpgSign=false', '-c', 'apply.whitespace=nowarn', ...args]),
      {
        env: { ...gitEnv(home), ...env },
        timeout: options.timeoutMs,
        maxBuffer: options.maxBytes,
        encoding: 'buffer',
      },
      (error, stdout) => {
        // Git's own text is never passed on.
        if (error) reject(new RunnerError('runner.workspace.proposal_failed'));
        else resolve(stdout);
      },
    );
  });
}

async function buildCommit(
  deps: PublishDeps,
  facts: Facts,
  patch: Buffer,
  repoDir: string,
  home: string,
  dir: string,
): Promise<string> {
  const options = {
    timeoutMs: deps.settings.git.timeoutMs,
    maxBytes: Math.max(deps.settings.workspaceMaxBytes, 1024 * 1024),
  };
  const date = `@${String(Math.floor(facts.finishedAt.getTime() / 1000))} +0000`;
  const email = `agent-${facts.agentId}@agents.sdlc.invalid`;
  const env = {
    GIT_INDEX_FILE: path.join(dir, 'index'),
    GIT_AUTHOR_NAME: 'sdlc-agent',
    GIT_AUTHOR_EMAIL: email,
    GIT_AUTHOR_DATE: date,
    GIT_COMMITTER_NAME: 'sdlc-agent',
    GIT_COMMITTER_EMAIL: email,
    GIT_COMMITTER_DATE: date,
  };
  const run = (args: string[]) => localGit(repoDir, home, env, args, options);
  try {
    await run(['rev-parse', '--verify', '--quiet', `${facts.baseSha}^{commit}`]);
    await run(['read-tree', facts.baseSha]);
  } catch {
    throw new Refused('base_not_found');
  }
  const patchFile = path.join(dir, 'change.patch');
  fs.writeFileSync(patchFile, patch, { mode: 0o600 });
  try {
    await run(['apply', '--cached', '--binary', '--', patchFile]);
  } catch {
    throw new Refused('diff_not_applicable');
  }
  const names = await run(['diff', '--cached', '--no-renames', '--name-only', '-z', facts.baseSha]);
  const sorted = names
    .toString('utf8')
    .split('\0')
    .filter((name) => name.length > 0)
    .sort();
  if (sorted.length === 0) throw new Refused('empty_diff');
  // Same hash as the runner's check at the end of the run (`checkChangedPaths`).
  const pathsSha256 = crypto
    .createHash('sha256')
    .update(JSON.stringify(sorted), 'utf8')
    .digest('hex');
  if (pathsSha256 !== facts.pathsSha256) throw new Refused('diff_mismatch');
  const tree = (await run(['write-tree'])).toString('utf8').trim();
  const message = `sdlc: ${facts.intentCode} run ${facts.runId}`;
  const commit = (await run(['commit-tree', tree, '-p', facts.baseSha, '-m', message]))
    .toString('utf8')
    .trim();
  if (!SHA.test(commit)) throw new RunnerError('runner.workspace.proposal_failed');
  return commit;
}

async function record(
  scope: TenantScope,
  runId: string,
  facts: Facts,
  head: string,
): Promise<void> {
  await scope.transaction(async (tx) => {
    // A concurrent attempt pushed the same commit and recorded it first: nothing to add.
    if ((await tx.runs.getById(runId))?.head_sha === head) return;
    await tx.runEvents.append(runId, 'branch_pushed', {
      head_sha: head,
      parent_sha: facts.baseSha,
      diff_sha256: facts.diffSha256,
      paths_sha256: facts.pathsSha256,
    });
    if (!(await tx.runs.recordPushedHead(runId, head, new Date()))) {
      throw new Failed('record_failed');
    }
  });
}
