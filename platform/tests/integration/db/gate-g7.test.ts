// D-08 E01 AC1, AC2, AC3, AC5 on a live PostgreSQL, without Temporal (design/ADR-M41,
// QUESTIONS #175–#179; D-02 FR-11, FR-12, FR-16, FR-17; D-09 N5, N9). The test plays the
// runner's push and fakes what GitHub says about the pull request, its reviews and its commits.
// - AC1: only reviews of the pushed commit count; a dismissed review voids its approval (FR-17);
// - AC2: the intent's creator, a commit author mapped to a user, a bot and an account without the
//   gate's role never count; a refused review gets one reply with catalog codes only (#176);
// - AC3: a plan flagged `migration` needs Person B and a second approver (N9);
// - AC5: a person merges the approved commit → G8, run event `pr_merged`; a merge before the
//   approvals, or by a producer → paused, `security` escalation; `resume` lets late approvals
//   count (#177); a closed pull request or another head → paused, `technical` escalation;
// - `/approve G7` by a command is refused (#175); `/reject G7` → G3, HITL (#178); a request for
//   changes from a non-role account is ignored, from Person B it holds G7 (PR 1, #179);
// - the gate deadline raises the overdue escalation (FR-12); review events wake the intent.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type {
  CheckItem,
  CommitAuthors,
  GitActor,
  PullRequestInfo,
  ReviewDecision,
} from '../../../packages/contracts/src/index.js';
import { CommandError } from '../../../packages/core/src/commands/errors.js';
import { decideGate } from '../../../packages/core/src/commands/gate-command.js';
import { handleGitEvent } from '../../../packages/core/src/commands/git-event-handler.js';
import type { Intent } from '../../../packages/core/src/db/schema.js';
import {
  acknowledgeEscalation,
  decideEscalation,
} from '../../../packages/core/src/escalation/decide.js';
import { RegistryError } from '../../../packages/core/src/registry/errors.js';
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
  notices,
  Secret,
  T0,
  type Harness,
} from '../g4-harness.js';
import { PEOPLE } from '../workflow/fixture.js';
import { createTestDatabase, describeDb, tamper, type TestDatabase } from './helpers.js';

const DAY = 24 * HOUR;
const HEAD = 'e'.repeat(40);
const OTHER = 'f'.repeat(40);
const OLD = '9'.repeat(40);
const MERGE = 'a'.repeat(40);
const DIFF = 'd'.repeat(64);
const PATHS = 'b'.repeat(64);

/** Accounts besides the fixture's a (3001), b (3002) and gov (3003). */
const SECOND = { gh: 3004, login: 'sam' };
const CAROL = { gh: 3005, login: 'carol' }; // Person B too, and a commit author
const VIEWER = { gh: 3006, login: 'vic' };
const STRANGER = { gh: 9001, login: 'stranger' }; // no platform user

interface PrWorld {
  state: 'open' | 'closed';
  merged: boolean;
  head: string;
  mergedBy: GitActor | null;
  mergedAt: string | null;
  reviews: ReviewDecision[];
  authors: CommitAuthors;
}

const actor = (p: { gh: number; login: string }, type: 'user' | 'bot' = 'user'): GitActor => ({
  id: String(p.gh),
  login: p.login,
  type,
});
const ok: CheckItem = {
  source: 'check_run',
  id: 'ci-ok',
  name: 'ci-ok',
  completed: true,
  conclusion: 'success',
};

describeDb('E01: gate G7, review and merge, on PostgreSQL', () => {
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

  describe('AC1, AC5: approvals bound to the pushed commit; a person merges', () => {
    it('Person B approves the pushed commit; merged by Person B → G8, pr_merged', async () => {
      const intent = await toG7();
      expect(await notices(t, intent)).toContain('g7_review_needed');
      review(PEOPLE.b, 'approved', OLD); // an older commit never counts
      expect(await step(intent)).toMatchObject({ reason: 'g7_decision' });
      expect(await g7Decisions(intent)).toEqual([]);

      review(PEOPLE.b, 'approved');
      expect(await step(intent)).toMatchObject({ reason: 'g7_merge' });
      expect(await g7Decisions(intent)).toEqual([['approve', null, 'github_review']]);
      expect(await notices(t, intent)).toContain('g7_merge_ready');
      await step(intent); // nothing recorded twice
      expect(await g7Decisions(intent)).toHaveLength(1);

      merge(PEOPLE.b);
      expect(await step(intent)).toMatchObject({ outcome: 'waiting' });
      expect(await reload(intent)).toMatchObject({ status: 'in_gate', current_gate: 'G8' });
      expect(await notices(t, intent)).toContain('merged');
      const run = (await t.f.scope.runs.listForIntent(intent.id)).at(-1)!;
      const merged = (await t.f.scope.runEvents.list(run.id)).filter(
        (e) => e.event_type === 'pr_merged',
      );
      expect(merged.map((e) => e.payload)).toEqual([
        { pr_number: (await reload(intent)).pr_number, head_sha: HEAD, merge_commit_sha: MERGE },
      ]);
      const checked = (await t.f.scope.runEvents.list(run.id)).filter(
        (e) => e.event_type === 'g7_checked',
      );
      expect(JSON.stringify(checked.map((e) => e.payload))).not.toContain('bob');
      expect((await t.f.scope.audit.listForEntity(intent.id, ['intent.pr_merged'])).length).toBe(1);
    });

    it('a dismissed review voids its approval (FR-17); approvals then wait again', async () => {
      const intent = await toG7();
      const approved = review(PEOPLE.b, 'approved');
      expect(await step(intent)).toMatchObject({ reason: 'g7_merge' });
      world.reviews = [{ ...approved, state: 'dismissed' }];
      expect(await step(intent)).toMatchObject({ reason: 'g7_decision' });
      expect(await g7Decisions(intent)).toEqual([
        ['approve', null, 'github_review'],
        ['void', 'input_mismatch', 'workflow'],
      ]);
    });

    it('an approval still counts after a stay at paused G7 (closed, reopened, resume)', async () => {
      const intent = await toG7();
      review(PEOPLE.b, 'approved');
      expect(await step(intent)).toMatchObject({ reason: 'g7_merge' });
      world.state = 'closed';
      expect(await step(intent)).toMatchObject({ reason: 'g7_review' });
      world.state = 'open';
      await decideOn(intent, 'resume');
      expect(await step(intent)).toMatchObject({ reason: 'g7_merge' });
      merge(PEOPLE.b);
      await step(intent);
      expect(await reload(intent)).toMatchObject({ status: 'in_gate', current_gate: 'G8' });
    });

    it('another commit on the open pull request → paused, technical escalation', async () => {
      const intent = await toG7();
      world.head = OTHER;
      expect(await step(intent)).toMatchObject({ reason: 'g7_review' });
      expect(await reload(intent)).toMatchObject({ status: 'paused', current_gate: 'G7' });
      expect(await checks(intent)).toEqual(['head_changed']);
      const escalation = (await t.f.scope.escalations.listForIntent(intent.id)).at(-1)!;
      expect(escalation).toMatchObject({
        route: 'technical',
        packet: { gate: 'G7', subject_kind: 'g7_input', reason_code: 'input_mismatch' },
      });
    });

    it('closed without a merge → technical escalation; terminate → cancelled', async () => {
      const intent = await toG7();
      world.state = 'closed';
      expect(await step(intent)).toMatchObject({ reason: 'g7_review' });
      expect(await checks(intent)).toEqual(['pr_closed']);
      await decideOn(intent, 'terminate');
      expect(await step(intent)).toMatchObject({ outcome: 'finished', status: 'cancelled' });
    });
  });

  describe('AC2: producers, bots and accounts without the role never count (#176)', () => {
    it('refused reviews get one reply with codes only; nothing is approved', async () => {
      const intent = await toG7();
      world.authors = { accounts: [actor(CAROL)], withoutAccount: 0 };
      const byCreator = review(PEOPLE.a, 'approved');
      const byAuthor = review(CAROL, 'approved');
      const byBot = review({ gh: 7777, login: 'helper[bot]' }, 'approved', HEAD, 'bot');
      const byViewer = review(VIEWER, 'approved');
      const byStranger = review(STRANGER, 'approved');
      expect(await step(intent)).toMatchObject({ reason: 'g7_decision' });
      expect(await g7Decisions(intent)).toEqual([]);
      expect(await receipt(byCreator)).toMatchObject({
        outcome: 'refused',
        reply_code: 'approval_refused',
        reply_params: { gate: 'G7', reason: 'producer' },
      });
      expect(await receipt(byAuthor)).toMatchObject({
        outcome: 'refused',
        reply_params: { gate: 'G7', reason: 'producer' },
      });
      expect(await receipt(byBot)).toMatchObject({ outcome: 'ignored_bot', reply_code: null });
      expect(await receipt(byViewer)).toMatchObject({
        outcome: 'refused',
        reply_params: { gate: 'G7', reason: 'role_missing' },
      });
      expect(await receipt(byStranger)).toMatchObject({
        outcome: 'user_not_linked',
        reply_code: null, // no reply: anyone can review a public repository
        issue_number: (await reload(intent)).pr_number,
      });
      await step(intent); // once per review: no second decision, no second receipt
      expect(await g7Decisions(intent)).toEqual([]);
    });

    it('a merge by a producer → paused, security escalation, even with valid approvals', async () => {
      const intent = await toG7();
      review(PEOPLE.b, 'approved');
      await step(intent);
      merge(PEOPLE.a);
      expect(await step(intent)).toMatchObject({ reason: 'g7_review' });
      expect(await checks(intent)).toEqual(['merged_by_producer']);
      expect(await g7Decisions(intent)).toContainEqual([
        'fail',
        'merged_before_approval',
        'workflow',
      ]);
      expect((await t.f.scope.escalations.listForIntent(intent.id)).at(-1)).toMatchObject({
        route: 'security',
      });
    });
  });

  describe('AC3: dual approval for a flagged plan (N9)', () => {
    it('migration: Person B alone is not enough; the second approver completes it', async () => {
      const intent = await toG7(['migration']);
      review(PEOPLE.b, 'approved');
      expect(await step(intent)).toMatchObject({ reason: 'g7_decision' });
      review(SECOND, 'approved');
      expect(await step(intent)).toMatchObject({ reason: 'g7_merge' });
      const roles = (await t.f.scope.gateDecisions.listForIntent(intent.id, 'G7')).map(
        (d) => d.approver_role,
      );
      expect(roles.sort()).toEqual(['person_b', 'second_approver']);
    });
  });

  describe('AC5: a merge before G7 passed (#177)', () => {
    it('fail merged_before_approval, security escalation; resume → a late approval counts → G8', async () => {
      const intent = await toG7();
      merge(PEOPLE.b);
      expect(await step(intent)).toMatchObject({ reason: 'g7_review' });
      expect(await g7Decisions(intent)).toEqual([['fail', 'merged_before_approval', 'workflow']]);
      expect(await checks(intent)).toEqual(['merged_before_approval']);
      later(HOUR);
      review(PEOPLE.b, 'approved'); // after the merge: late
      await decideOn(intent, 'resume');
      expect(await step(intent)).toMatchObject({ outcome: 'waiting' });
      expect(await reload(intent)).toMatchObject({ status: 'in_gate', current_gate: 'G8' });
    });

    it('a late approval does not count without the resume', async () => {
      const intent = await toG7();
      merge(PEOPLE.b);
      later(HOUR);
      review(PEOPLE.b, 'approved');
      expect(await step(intent)).toMatchObject({ reason: 'g7_review' });
      expect((await g7Decisions(intent)).filter((d) => d[0] === 'approve')).toEqual([]);
    });
  });

  describe('commands at G7 (#175, #178, #179)', () => {
    it('/approve G7 is refused; approvals are reviews', async () => {
      const intent = await toG7();
      await expect(
        decideGate(t.f.registry, t.f.scope, {
          intent: await reload(intent),
          gate: 'G7',
          decision: 'approve',
          actorId: t.f.users.b,
          source: 'cli',
        }),
      ).rejects.toEqual(expect.objectContaining({ code: 'g7_use_pr_review' }) as CommandError);
    });

    it('/reject G7 by Person B → back to G3, HITL from then on; G3 approvals voided', async () => {
      const intent = await toG7();
      await decideGate(t.f.registry, t.f.scope, {
        intent: await reload(intent),
        gate: 'G7',
        decision: 'reject',
        actorId: t.f.users.b,
        reasonCode: 'tests_insufficient',
        source: 'cli',
      });
      await step(intent);
      expect(await reload(intent)).toMatchObject({ status: 'in_gate', current_gate: 'G3' });
      expect(await notices(t, intent)).toContain('g7_returned');
      const g3 = await t.f.scope.gateDecisions.listForIntent(intent.id, 'G3');
      expect(g3.map((d) => d.decision)).toContain('void');
      const last = g3.at(-1)!;
      expect(last).toMatchObject({ decision: 'void' });
    });

    it('a producer cannot reject or request changes', async () => {
      const intent = await toG7();
      await expect(
        decideGate(t.f.registry, t.f.scope, {
          intent: await reload(intent),
          gate: 'G7',
          decision: 'request_changes',
          actorId: t.f.users.a,
          reasonCode: 'other',
          source: 'cli',
        }),
      ).rejects.toEqual(expect.objectContaining({ reason: 'producer' }) as RegistryError);
    });

    it('a request for changes from a non-role account is ignored; from Person B it holds G7', async () => {
      const intent = await toG7();
      const fromViewer = review(VIEWER, 'changes_requested');
      expect(await step(intent)).toMatchObject({ reason: 'g7_decision' });
      expect(await receipt(fromViewer)).toMatchObject({
        outcome: 'refused',
        reply_params: { gate: 'G7', reason: 'role_missing' },
      });
      expect(await g7Decisions(intent)).toEqual([]);

      const fromB = review(PEOPLE.b, 'changes_requested');
      expect(await step(intent)).toMatchObject({ reason: 'g7_changes_requested' });
      const decision = (await t.f.scope.gateDecisions.listForIntent(intent.id, 'G7')).at(-1)!;
      expect(decision).toMatchObject({
        decision: 'request_changes',
        decided_by: t.f.users.b,
        reason_code: 'other',
        reason_ref: fromB.url,
      });
      expect(await receipt(fromB)).toMatchObject({
        outcome: 'decided',
        gate_decision_id: decision.id,
      });
      expect(await notices(t, intent)).toContain('g7_changes_requested');
    });
  });

  it('a request for changes no longer holds G7 once its reviewer approves', async () => {
    const intent = await toG7();
    review(PEOPLE.b, 'changes_requested');
    expect(await step(intent)).toMatchObject({ reason: 'g7_changes_requested' });
    review(PEOPLE.b, 'approved'); // replaces the request
    expect(await step(intent)).toMatchObject({ reason: 'g7_merge' });
  });

  it('FR-12: G7 waits past its deadline → one overdue escalation', async () => {
    const intent = await toG7();
    later(5 * DAY);
    expect(await step(intent)).toMatchObject({ reason: 'g7_decision' });
    const overdue = (await t.f.scope.escalations.listForIntent(intent.id)).filter(
      (e) => e.trigger === 'time' && e.packet.gate === 'G7',
    );
    expect(overdue).toHaveLength(1);
    expect(overdue[0]?.packet).toMatchObject({ subject_kind: 'g7_input' });
  });

  it('a review event and a closed pull request wake the intent of the pull request', async () => {
    const intent = await toG7();
    const pr = (await reload(intent)).pr_number!;
    const base = {
      source: 'polling' as const,
      repo: { owner: 'acme', name: 'shop' },
      occurredAt: clock.toISOString(),
      url: 'https://github.com/acme/shop/pull/1',
    };
    const project = { id: t.f.target.projectId, provider: 'github' as const };
    const deps = { registry: t.f.registry };
    expect(
      await handleGitEvent(t.f.scope, deps, project, {
        ...base,
        kind: 'review_submitted',
        id: 'github:review:1',
        prNumber: pr,
        reviewId: '1',
        reviewer: actor(PEOPLE.b),
        state: 'approved',
        commitSha: HEAD,
      }),
    ).toEqual({ outcome: 'not_handled', intentId: intent.id });
    expect(
      await handleGitEvent(t.f.scope, deps, project, {
        ...base,
        kind: 'pull_request_closed',
        id: `github:pull_closed:${String(pr)}`,
        prNumber: pr,
        merged: true,
        headSha: HEAD,
      }),
    ).toEqual({ outcome: 'not_handled', intentId: intent.id });
  });
});
