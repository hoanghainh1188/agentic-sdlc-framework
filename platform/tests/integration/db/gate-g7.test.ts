// D-08 E01 AC1, AC2, AC3, AC5 on a live PostgreSQL, without Temporal (design/ADR-M41,
// QUESTIONS #175–#179; D-02 FR-11, FR-12, FR-16, FR-17; D-09 N5, N9). The test plays the
// runner's push and fakes what GitHub says about the pull request, its reviews and its commits
// (`g7-world.ts`).
// - AC1: only reviews of the pushed commit count; a dismissed review voids its approval (FR-17);
// - AC2: the intent's creator, a commit author mapped to a user, a bot and an account without the
//   gate's role never count; a refused review gets one reply with catalog codes only (#176);
// - AC3: a plan flagged `migration` needs Person B and a second approver (N9);
// - AC5: a person merges the approved commit → G8, run event `pr_merged`; a merge before the
//   approvals, or by a producer → paused, `security` escalation; `resume` lets late approvals
//   count (#177); a closed pull request or another head → paused, `technical` escalation;
// - `/approve G7` by a command is refused (#175); `/reject G7` → G3, HITL (#178); a request for
//   changes from a non-role account is ignored (PR 2: from Person B it starts a new run,
//   `g7-request-changes.test.ts`, #179);
// - the gate deadline raises the overdue escalation (FR-12); review events wake the intent.
import { describe, expect, it } from 'vitest';

import { CommandError } from '../../../packages/core/src/commands/errors.js';
import { decideGate } from '../../../packages/core/src/commands/gate-command.js';
import { handleGitEvent } from '../../../packages/core/src/commands/git-event-handler.js';
import { RegistryError } from '../../../packages/core/src/registry/errors.js';
import { HOUR, notices, waitingFor } from '../g4-harness.js';
import { PEOPLE } from '../workflow/fixture.js';
import {
  actor,
  CAROL,
  DAY,
  g7World,
  HEAD,
  MERGE,
  OLD,
  OTHER,
  SECOND,
  STRANGER,
  VIEWER,
} from './g7-world.js';
import { describeDb } from './helpers.js';

describeDb('E01: gate G7, review and merge, on PostgreSQL', () => {
  const w = g7World();
  const { later, reload, step, review, merge, g7Decisions, receipt, checks, toG7, decideOn } = w;

  describe('AC1, AC5: approvals bound to the pushed commit; a person merges', () => {
    it('Person B approves the pushed commit; merged by Person B → G8, pr_merged', async () => {
      const intent = await toG7();
      expect(await notices(w.t, intent)).toContain('g7_review_needed');
      review(PEOPLE.b, 'approved', OLD); // an older commit never counts
      expect(await step(intent)).toMatchObject({ reason: 'g7_decision' });
      expect(await g7Decisions(intent)).toEqual([]);

      review(PEOPLE.b, 'approved');
      expect(await step(intent)).toMatchObject({ reason: 'g7_merge' });
      expect(await g7Decisions(intent)).toEqual([['approve', null, 'github_review']]);
      expect(await notices(w.t, intent)).toContain('g7_merge_ready');
      await step(intent); // nothing recorded twice
      expect(await g7Decisions(intent)).toHaveLength(1);

      merge(PEOPLE.b);
      expect(await step(intent)).toMatchObject({ outcome: 'waiting' });
      expect(await reload(intent)).toMatchObject({ status: 'in_gate', current_gate: 'G8' });
      expect(await notices(w.t, intent)).toContain('merged');
      const run = (await w.t.f.scope.runs.listForIntent(intent.id)).at(-1)!;
      const merged = (await w.t.f.scope.runEvents.list(run.id)).filter(
        (e) => e.event_type === 'pr_merged',
      );
      expect(merged.map((e) => e.payload)).toEqual([
        { pr_number: (await reload(intent)).pr_number, head_sha: HEAD, merge_commit_sha: MERGE },
      ]);
      const checked = (await w.t.f.scope.runEvents.list(run.id)).filter(
        (e) => e.event_type === 'g7_checked',
      );
      expect(JSON.stringify(checked.map((e) => e.payload))).not.toContain('bob');
      expect((await w.t.f.scope.audit.listForEntity(intent.id, ['intent.pr_merged'])).length).toBe(
        1,
      );
    });

    it('a dismissed review voids its approval (FR-17); approvals then wait again', async () => {
      const intent = await toG7();
      const approved = review(PEOPLE.b, 'approved');
      expect(await step(intent)).toMatchObject({ reason: 'g7_merge' });
      w.world.reviews = [{ ...approved, state: 'dismissed' }];
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
      w.world.state = 'closed';
      expect(await step(intent)).toMatchObject({ reason: 'g7_review' });
      w.world.state = 'open';
      await decideOn(intent, 'resume');
      expect(await step(intent)).toMatchObject({ reason: 'g7_merge' });
      merge(PEOPLE.b);
      await step(intent);
      expect(await reload(intent)).toMatchObject({ status: 'in_gate', current_gate: 'G8' });
    });

    it('another commit on the open pull request → paused, technical escalation', async () => {
      const intent = await toG7();
      w.world.head = OTHER;
      expect(await step(intent)).toMatchObject({ reason: 'g7_review' });
      expect(await reload(intent)).toMatchObject({ status: 'paused', current_gate: 'G7' });
      expect(await checks(intent)).toEqual(['head_changed']);
      const escalation = (await w.t.f.scope.escalations.listForIntent(intent.id)).at(-1)!;
      expect(escalation).toMatchObject({
        route: 'technical',
        packet: { gate: 'G7', subject_kind: 'g7_input', reason_code: 'input_mismatch' },
      });
    });

    it('closed without a merge → technical escalation; terminate → cancelled', async () => {
      const intent = await toG7();
      w.world.state = 'closed';
      expect(await step(intent)).toMatchObject({ reason: 'g7_review' });
      expect(await checks(intent)).toEqual(['pr_closed']);
      await decideOn(intent, 'terminate');
      expect(await step(intent)).toMatchObject({ outcome: 'finished', status: 'cancelled' });
    });
  });

  describe('AC2: producers, bots and accounts without the role never count (#176)', () => {
    it('refused reviews get one reply with codes only; nothing is approved', async () => {
      const intent = await toG7();
      w.world.authors = { accounts: [actor(CAROL)], withoutAccount: 0 };
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
      expect((await w.t.f.scope.escalations.listForIntent(intent.id)).at(-1)).toMatchObject({
        route: 'security',
      });
    });
  });

  describe('AC3: dual approval for a flagged plan (N9)', () => {
    it('migration: Person B alone is not enough; the second approver completes it', async () => {
      const intent = await toG7(['migration']);
      // U01 (#261): the API shows the dual approval the workflow waits for.
      expect(await waitingFor(w.t, intent)).toMatchObject({
        gate: 'G7',
        mode: 'HITL',
        approvalsNeeded: 2,
      });
      review(PEOPLE.b, 'approved');
      expect(await step(intent)).toMatchObject({ reason: 'g7_decision' });
      review(SECOND, 'approved');
      expect(await step(intent)).toMatchObject({ reason: 'g7_merge' });
      const roles = (await w.t.f.scope.gateDecisions.listForIntent(intent.id, 'G7')).map(
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
        decideGate(w.t.f.registry, w.t.f.scope, {
          intent: await reload(intent),
          gate: 'G7',
          decision: 'approve',
          actorId: w.t.f.users.b,
          source: 'cli',
        }),
      ).rejects.toEqual(expect.objectContaining({ code: 'g7_use_pr_review' }) as CommandError);
    });

    it('/reject G7 by Person B → back to G3, HITL from then on; G3 approvals voided', async () => {
      const intent = await toG7();
      await decideGate(w.t.f.registry, w.t.f.scope, {
        intent: await reload(intent),
        gate: 'G7',
        decision: 'reject',
        actorId: w.t.f.users.b,
        reasonCode: 'tests_insufficient',
        source: 'cli',
      });
      await step(intent);
      expect(await reload(intent)).toMatchObject({ status: 'in_gate', current_gate: 'G3' });
      expect(await notices(w.t, intent)).toContain('g7_returned');
      const g3 = await w.t.f.scope.gateDecisions.listForIntent(intent.id, 'G3');
      expect(g3.map((d) => d.decision)).toContain('void');
      const last = g3.at(-1)!;
      expect(last).toMatchObject({ decision: 'void' });
    });

    it('a producer cannot reject or request changes', async () => {
      const intent = await toG7();
      await expect(
        decideGate(w.t.f.registry, w.t.f.scope, {
          intent: await reload(intent),
          gate: 'G7',
          decision: 'request_changes',
          actorId: w.t.f.users.a,
          reasonCode: 'other',
          // #190: the API refuses a G7 request for changes first; a comment reaches this check.
          source: 'github_comment',
        }),
      ).rejects.toEqual(expect.objectContaining({ reason: 'producer' }) as RegistryError);
    });

    it('a request for changes from a non-role account is ignored; from Person B it is recorded', async () => {
      const intent = await toG7();
      const fromViewer = review(VIEWER, 'changes_requested');
      expect(await step(intent)).toMatchObject({ reason: 'g7_decision' });
      expect(await receipt(fromViewer)).toMatchObject({
        outcome: 'refused',
        reply_params: { gate: 'G7', reason: 'role_missing' },
      });
      expect(await g7Decisions(intent)).toEqual([]);

      const fromB = review(PEOPLE.b, 'changes_requested');
      // PR 2 (#179): the request takes the intent to G4 (`g7-request-changes.test.ts`).
      expect(await step(intent)).toEqual({ outcome: 'run_prepare' });
      const decision = (await w.t.f.scope.gateDecisions.listForIntent(intent.id, 'G7')).at(-1)!;
      expect(decision).toMatchObject({
        decision: 'request_changes',
        decided_by: w.t.f.users.b,
        reason_code: 'other',
        reason_ref: fromB.url,
      });
      expect(await receipt(fromB)).toMatchObject({
        outcome: 'decided',
        gate_decision_id: decision.id,
      });
      expect(await notices(w.t, intent)).toContain('g7_changes_requested');
    });
  });

  it('a request for changes its reviewer replaced by an approval before G7 read it never counts', async () => {
    const intent = await toG7();
    review(PEOPLE.b, 'changes_requested');
    review(PEOPLE.b, 'approved'); // replaces the request before the step reads the reviews
    expect(await step(intent)).toMatchObject({ reason: 'g7_merge' });
    expect(await g7Decisions(intent)).toEqual([['approve', null, 'github_review']]);
  });

  it('FR-12: G7 waits past its deadline → one overdue escalation', async () => {
    const intent = await toG7();
    later(5 * DAY);
    expect(await step(intent)).toMatchObject({ reason: 'g7_decision' });
    const overdue = (await w.t.f.scope.escalations.listForIntent(intent.id)).filter(
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
      occurredAt: w.clock.toISOString(),
      url: 'https://github.com/acme/shop/pull/1',
    };
    const project = { id: w.t.f.target.projectId, provider: 'github' as const };
    const deps = { registry: w.t.f.registry, now: () => w.t.f.registry.now() };
    expect(
      await handleGitEvent(w.t.f.scope, deps, project, {
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
      await handleGitEvent(w.t.f.scope, deps, project, {
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
