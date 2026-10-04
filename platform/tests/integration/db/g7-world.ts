// The world of the G7 tests on PostgreSQL (task E01, design/ADR-M41): an intent taken to G7 on a
// faked pull request (its reviews, its commits, its merge), shared by `gate-g7.test.ts` (PR 1) and
// `g7-request-changes.test.ts` (PR 2). `g7World()` registers the hooks of the calling `describe`.
import { afterAll, beforeAll, beforeEach, expect } from 'vitest';

import type {
  CheckItem,
  CommitAuthors,
  GitActor,
  PullRequestInfo,
  ReviewDecision,
} from '../../../packages/contracts/src/index.js';
import type { Intent } from '../../../packages/core/src/db/schema.js';
import {
  acknowledgeEscalation,
  decideEscalation,
} from '../../../packages/core/src/escalation/decide.js';
import type { G6Deps } from '../../../packages/core/src/workflow/g6-ci.js';
import type { G7Deps } from '../../../packages/core/src/workflow/g7-facts.js';
import { finishPublish, type PublishDeps } from '../../../packages/core/src/workflow/publish.js';
import { finishRun, startRun } from '../../../packages/core/src/workflow/run-lifecycle.js';
import { stepIntent } from '../../../packages/core/src/workflow/step.js';
import {
  approve,
  BASE_1,
  decideAt,
  HOUR,
  harness,
  MODEL,
  Secret,
  T0,
  type Harness,
} from '../g4-harness.js';
import { createTestDatabase, tamper, type TestDatabase } from './helpers.js';

export const DAY = 24 * HOUR;
export const HEAD = 'e'.repeat(40);
export const OTHER = 'f'.repeat(40);
export const OLD = '9'.repeat(40);
export const MERGE = 'a'.repeat(40);
export const DIFF = 'd'.repeat(64);
export const PATHS = 'b'.repeat(64);

/** Accounts besides the fixture's a (3001), b (3002) and gov (3003). */
export const SECOND = { gh: 3004, login: 'sam' };
export const CAROL = { gh: 3005, login: 'carol' }; // Person B too, and a commit author
export const VIEWER = { gh: 3006, login: 'vic' };
export const STRANGER = { gh: 9001, login: 'stranger' }; // no platform user

export interface PrWorld {
  state: 'open' | 'closed';
  merged: boolean;
  head: string;
  mergedBy: GitActor | null;
  mergedAt: string | null;
  reviews: ReviewDecision[];
  authors: CommitAuthors;
}

export const actor = (
  p: { gh: number; login: string },
  type: 'user' | 'bot' = 'user',
): GitActor => ({
  id: String(p.gh),
  login: p.login,
  type,
});
export const ok: CheckItem = {
  source: 'check_run',
  id: 'ci-ok',
  name: 'ci-ok',
  completed: true,
  conclusion: 'success',
};

/** Registers the hooks and returns the world and its helpers (getters for what changes). */
export function g7World() {
  let db: TestDatabase;
  let t: Harness;
  let world: PrWorld;
  let publish: PublishDeps;
  let g6: G6Deps;
  let g7: G7Deps;
  let clock = T0;
  let prNumber = 300;
  let reviewId = 500;
  const users: Record<'second' | 'carol' | 'viewer', string> = {
    second: '',
    carol: '',
    viewer: '',
  };

  beforeAll(async () => {
    db = await createTestDatabase();
    t = await harness(db);
    const project = (await t.f.scope.projects.getById(t.f.target.projectId))!;
    const grants: [
      keyof typeof users,
      { gh: number; login: string },
      'second_approver' | 'person_b' | 'viewer',
    ][] = [
      ['second', SECOND, 'second_approver'],
      ['carol', CAROL, 'person_b'],
      ['viewer', VIEWER, 'viewer'],
    ];
    for (const [key, p, role] of grants) {
      const user = await t.f.scope.users.create({ display_name: key, email: `${key}@example.com` });
      users[key] = user.id;
      await t.f.scope.roleBindings.grant({ user_id: user.id, project_id: project.id, role });
      await t.f.scope.userIdentities.link({
        user_id: user.id,
        provider: 'github',
        external_id: String(p.gh),
        external_login: p.login,
      });
    }
    // The intent's creator (Person A) also holds Person B here, so only the producer rule
    // refuses her review (AC2, QUESTIONS #16).
    await t.f.scope.roleBindings.grant({
      user_id: t.f.users.a,
      project_id: project.id,
      role: 'person_b',
    });
  }, 60_000);

  afterAll(async () => {
    await t?.f.close();
    await db?.drop();
  });

  beforeEach(async () => {
    clock = T0;
    t.setClock(T0);
    Object.assign(t.world, { base: BASE_1, models: [MODEL], gitDown: false, tenantBudget: null });
    await t.setConfig(`run:\n  agent_key: ${t.agent.key}\n`);
    world = {
      state: 'open',
      merged: false,
      head: HEAD,
      mergedBy: null,
      mergedAt: null,
      reviews: [],
      authors: { accounts: [actor({ gh: 2002, login: 'sdlc[bot]' }, 'bot')], withoutAccount: 1 },
    };
    const pr = (number: number): PullRequestInfo => ({
      number,
      state: world.state,
      draft: false,
      merged: world.merged,
      mergedAt: world.mergedAt,
      mergeCommitSha: world.merged ? MERGE : null,
      headSha: world.head,
      headRef: 'agent/INT-x',
      baseRef: 'main',
      author: { id: '1', login: 'sdlc[bot]', type: 'bot' },
      mergedBy: world.mergedBy,
      changedFiles: 1,
      url: `https://github.com/acme/shop/pull/${String(number)}`,
    });
    publish = {
      registry: t.f.registry,
      gitHost: {
        issueShortLivedToken: (repo, scope) =>
          Promise.resolve({
            token: new Secret('ghs_x'),
            expiresAt: T0.toISOString(),
            repo,
            permissions: scope.permissions,
          }),
        findOpenPullRequest: () => Promise.resolve(null),
        openPullRequest: () => {
          prNumber += 1;
          return Promise.resolve(pr(prNumber));
        },
      },
      wrapper: { wrap: () => Promise.resolve(new Secret('wrap')) },
    };
    g6 = {
      gitHost: {
        getPullRequest: (_ref, number) => Promise.resolve(pr(number)),
        getCheckStatus: (_ref, sha) => Promise.resolve({ sha, state: 'success', checks: [ok] }),
        getSecurityFindings: () =>
          Promise.resolve({ known: true, counts: { critical: 0, high: 0, medium: 0, low: 0 } }),
      },
    };
    g7 = {
      gitHost: {
        getPullRequest: (_ref, number) => Promise.resolve(pr(number)),
        getReviews: () => Promise.resolve([...world.reviews]),
        getCommitAuthors: () => Promise.resolve(world.authors),
      },
    };
  });

  const at = (ms: number) => {
    clock = new Date(T0.getTime() + ms);
    t.setClock(clock);
  };
  const later = (ms: number) => at(clock.getTime() - T0.getTime() + ms);
  const reload = (intent: Intent) => t.reload(intent);
  const step = async (intent: Intent) => {
    for (let i = 0; i < 12; i += 1) {
      const result = await stepIntent(
        t.f.scope,
        { registry: t.f.registry, g4: t.g4, startRuns: true, publish: true, g6, g7 },
        intent.id,
      );
      if (result.outcome !== 'moved') return result;
    }
    throw new Error('the step never settled');
  };
  /** A review decision of `who` (the latest of that reviewer replaces an earlier one). */
  const review = (
    who: { gh: number; login: string },
    state: ReviewDecision['state'],
    commitSha = HEAD,
    type: 'user' | 'bot' = 'user',
  ): ReviewDecision => {
    reviewId += 1;
    const r: ReviewDecision = {
      eventId: `github:review:${String(reviewId)}`,
      reviewId: String(reviewId),
      reviewer: actor(who, type),
      state,
      commitSha,
      submittedAt: clock.toISOString(),
      url: `https://github.com/acme/shop/pull/1#pullrequestreview-${String(reviewId)}`,
    };
    world.reviews = [...world.reviews.filter((x) => x.reviewer.id !== r.reviewer.id), r];
    return r;
  };
  const merge = (by: { gh: number; login: string }) => {
    world.state = 'closed';
    world.merged = true;
    world.mergedBy = actor(by);
    world.mergedAt = clock.toISOString();
  };
  const g7Decisions = async (intent: Intent) =>
    (await t.f.scope.gateDecisions.listForIntent(intent.id, 'G7')).map((d) => [
      d.decision,
      d.reason_code,
      d.source,
    ]);
  const receipt = (r: ReviewDecision) =>
    t.f.scope.gitEventReceipts.find(t.f.target.projectId, r.eventId);
  const checks = async (intent: Intent) =>
    (await t.f.scope.audit.listForEntity(intent.id, ['gate.g7_check_failed'])).map(
      (e) => (e.payload as { check: string }).check,
    );

  /** A new intent to G4: G1, G2 by Person A (Medium), G3 by Person B; plan flags optional. */
  async function toG4(flags: readonly 'migration'[] = []): Promise<Intent> {
    const intent = await t.f.newIntent({ riskTier: 'medium' });
    await t.settle(intent);
    await decideAt(t, intent, 'G1', 'a');
    await t.f.addInputs(intent, { changeFlags: flags });
    await t.settle(intent);
    await decideAt(t, intent, 'G2', 'a');
    await approve(t, intent, 'G3', 'b');
    return intent;
  }

  /** G4 → run → G5 → push → pull request → CI passes (G6 HOTL) → G7, past the block windows. */
  async function toG7(flags: readonly 'migration'[] = []): Promise<Intent> {
    const intent = await toG4(flags);
    expect(await step(intent)).toEqual({ outcome: 'run_prepare' });
    const started = await startRun(t.f.scope, t.runDeps, intent.id);
    if (!started.ok) throw new Error(`not started: ${started.reason}`);
    const runId = started.run.runId;
    const now = new Date();
    await t.f.scope.runs.claimForProvisioning(runId, now);
    await t.f.scope.runs.transition(runId, { from: ['provisioning'], to: 'running', now });
    await t.f.scope.runEvents.append(runId, 'diff_stored', {
      sha256: DIFF,
      size_bytes: 120,
      changed_files: 1,
    });
    await t.f.scope.runEvents.append(runId, 'changes_checked', {
      changed_files: 1,
      out_of_scope: 0,
      instruction_files: 0,
      paths_sha256: PATHS,
    });
    await t.f.scope.runs.transition(runId, {
      from: ['running'],
      to: 'succeeded',
      now,
      finishedAt: now,
    });
    expect(await step(intent)).toEqual({ outcome: 'run_ended', runId });
    await finishRun(t.f.scope, t.runDeps, intent.id, runId);
    expect(await step(intent)).toMatchObject({ outcome: 'waiting', reason: 'later_gate' });
    later(3 * DAY);
    expect(await step(intent)).toEqual({ outcome: 'publish', runId, step: 'push' });
    await t.f.scope.transaction(async (tx) => {
      await tx.runEvents.append(runId, 'branch_pushed', {
        head_sha: HEAD,
        parent_sha: BASE_1,
        diff_sha256: DIFF,
        paths_sha256: PATHS,
      });
      await tx.runs.recordPushedHead(runId, HEAD, new Date());
    });
    await tamper(
      db.name,
      `UPDATE run_events SET created_at = $1 WHERE run_id = $2 AND event_type = 'branch_pushed'`,
      [clock, runId],
    );
    expect(await finishPublish(t.f.scope, publish, intent.id, runId)).toMatchObject({ ok: true });
    // CI passed; Medium: G6 HOTL passes, then G7 waits for reviews.
    expect(await step(intent)).toMatchObject({ outcome: 'waiting', reason: 'g7_decision' });
    expect(await reload(intent)).toMatchObject({ status: 'in_gate', current_gate: 'G7' });
    later(3 * DAY); // past the G6 block window
    return intent;
  }

  async function decideOn(intent: Intent, decision: 'resume' | 'terminate' | 'roll_back') {
    const escalation = (await t.f.scope.escalations.listForIntent(intent.id))
      .filter((e) => e.trigger !== 'time')
      .at(-1)!;
    const deps = { now: () => t.f.registry.now() };
    await acknowledgeEscalation(
      t.f.scope,
      { escalationId: escalation.id, actorId: t.f.users.gov },
      deps,
    );
    await decideEscalation(
      t.f.scope,
      { escalationId: escalation.id, actorId: t.f.users.gov, decision },
      deps,
    );
    return escalation;
  }

  return {
    get db() {
      return db;
    },
    get t() {
      return t;
    },
    get world() {
      return world;
    },
    get clock() {
      return clock;
    },
    get publish() {
      return publish;
    },
    get g6() {
      return g6;
    },
    get g7() {
      return g7;
    },
    users,
    at,
    later,
    reload,
    step,
    review,
    merge,
    g7Decisions,
    receipt,
    checks,
    toG4,
    toG7,
    decideOn,
  };
}
