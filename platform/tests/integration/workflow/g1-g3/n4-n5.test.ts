// D-08 B10 on the whole stack (see stack.ts), run with `pnpm test:workflow`:
// - AC2 (N4, D-09 §7): the spec is edited on the default branch after G2 → back to G2, the G2
//   approval is void (FR-02, ADR-M39 §2.4); an approval that expired → `void` and the gate is
//   evaluated again (FR-17), reached through a lost wake signal and the worker's reconcile loop.
// - AC3 (N5): a producer's approval is never counted (FR-11): Person B submitted the plan, so
//   Person B's G3 approval is refused, by comment and by the CLI; a wrong role cannot approve; a
//   bot never decides.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { describeDb } from '../../db/helpers.js';
import { DAY_MS, SPEC_PATH, SPEC_TEXT, sha256, Stack, waitFor } from './stack.js';

const describeStack = process.env.SDLC_TEMPORAL_TEST_SERVER ? describeDb : describe.skip;

describeStack(
  'B10: N4, approval expiry and N5 end to end',
  () => {
    let s: Stack;

    beforeAll(async () => {
      s = new Stack();
      await s.start();
    }, 180_000);
    afterAll(async () => {
      await s?.stop();
    }, 60_000);

    it('AC2 (N4): the spec edited after G2 takes the intent back to G2 and voids the approval', async () => {
      const intent = await s.createIntent('medium');
      await s.atGate(intent, 'G1');
      s.comment(intent, '/approve G1', 'a');
      await s.poll();
      await s.atGate(intent, 'G2');
      await s.linkInputs(intent);
      expect((await s.cli('a', ['gate', 'approve', 'G2', intent.code])).code).toBe(0);
      await s.atGate(intent, 'G3');

      // Someone edits the spec on the default branch; the next wake (here the worker's reconcile
      // loop) reads the head again.
      const edited = `${SPEC_TEXT}AC2: the refund is made within 3 days.\n`;
      s.commit({ [SPEC_PATH]: edited });
      await s.reconcileLoop.pass();
      await s.atGate(intent, 'G2');
      expect(await s.decisions(intent, 'G2')).toEqual([
        ['approve', null, s.users.a],
        ['void', 'input_mismatch', null],
      ]);
      expect((await s.noticeKinds(intent)).at(-1)).toBe('spec_changed');
      const spec = await s.cliJson<{ items: { version: number; content_sha256: string }[] }>('a', [
        'spec',
        'list',
        intent.code,
      ]);
      expect(spec.items.map((i) => [i.version, i.content_sha256])).toEqual([
        [1, sha256(SPEC_TEXT)],
        [2, sha256(edited)],
      ]);

      // G2 is decided again on the new spec, then G3.
      s.comment(intent, '/approve G2', 'a');
      await s.poll();
      await s.atGate(intent, 'G3');
      s.comment(intent, '/approve G3', 'b');
      await s.poll();
      await s.atGate(intent, 'G4');
    });

    it('AC2: an approval that expired before the workflow saw it is void; the gate waits again', async () => {
      const intent = await s.createIntent('medium');
      await s.atGate(intent, 'G1');
      // The approval is recorded, but the wake signal is lost (no signals on this poll).
      s.comment(intent, '/approve G1', 'a');
      await s.poll({ signals: false });
      expect(await s.decisions(intent, 'G1')).toEqual([['approve', null, s.users.a]]);
      expect(await s.reload(intent)).toMatchObject({ current_gate: 'G1' });

      // `approval_expiry` (7 days) passes before the reconcile loop wakes the intent.
      await s.advanceTo(new Date(s.now().getTime() + 7 * DAY_MS), { temporal: false });
      await s.reconcileLoop.pass();
      await waitFor(
        () => s.decisions(intent, 'G1'),
        (list) => list.length === 2,
      );
      expect(await s.decisions(intent, 'G1')).toEqual([
        ['approve', null, s.users.a],
        ['void', 'expired', null],
      ]);
      expect(await s.reload(intent)).toMatchObject({ status: 'in_gate', current_gate: 'G1' });

      // A new approval counts.
      s.comment(intent, '/approve G1', 'a');
      await s.poll();
      await s.atGate(intent, 'G2');
    });

    it('AC3 (N5): the plan submitter cannot approve G3; a wrong role cannot; a bot never decides', async () => {
      const intent = await s.createIntent('medium');
      await s.atGate(intent, 'G1');
      s.comment(intent, '/approve G1', 'a');
      await s.poll();
      await s.atGate(intent, 'G2');
      // Person B submits the plan (config access.plan_submit_roles), so Person B produced it.
      await s.linkInputs(intent, { submitter: 'b' });
      expect(await s.scope.plans.latest(intent.id)).toMatchObject({ submitted_by: s.users.b });
      s.comment(intent, '/approve G2', 'a');
      await s.poll();
      await s.atGate(intent, 'G3');
      const repliesBefore = s.replies(intent).length;

      // The producer, by comment and by the CLI.
      s.comment(intent, '/approve G3', 'b');
      // A wrong role (Person A, the viewer) and a bot account.
      s.comment(intent, '/approve G3', 'a');
      s.comment(intent, '/approve G3', 'viewer');
      s.comment(intent, '/approve G3', 'gov', true);
      await s.poll();
      const cli = await s.cli('b', ['gate', 'approve', 'G3', intent.code]);
      expect(cli.code).toBe(1);
      expect(cli.err).toContain('Reason (producer)');
      const viewerCli = await s.cli('viewer', ['gate', 'approve', 'G3', intent.code]);
      expect(viewerCli.code).toBe(1);

      // Three replies (B, A, viewer), none for the bot; nothing recorded; G3 still waits.
      await s.signals.wake({ tenantId: s.target.tenantId, intentId: intent.id });
      await s.atGate(intent, 'G3');
      expect(await s.decisions(intent, 'G3')).toEqual([]);
      const replies = s.replies(intent).slice(repliesBefore);
      expect(replies).toHaveLength(3);
      expect(replies[0]).toContain('You produced this change');
      expect(replies[1]).toContain('You do not hold a role');
      expect(replies[2]).toContain('You do not hold a role');
    });
  },
  180_000,
);
