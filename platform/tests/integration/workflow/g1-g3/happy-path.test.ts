// D-08 B10 on the whole stack (see stack.ts), run with `pnpm test:workflow`:
// - AC1: create intent → G1 → G2 → G3; Low risk: G2 and G3 pass by HOTL; Medium: HITL, decided
//   by comment commands and the CLI.
// - AC5 (N8, D-09 §7): a Low-risk plan flagged `migration` makes G3 HITL (FR-15).
// - AC6: no project AI record → the submit to G1 fails; saving the record lets the intent in
//   (FR-19, ADR-M32 §2.5).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { describeDb } from '../../db/helpers.js';
import { Stack, waitFor } from './stack.js';

const describeStack = process.env.SDLC_TEMPORAL_TEST_SERVER ? describeDb : describe.skip;

describeStack(
  'B10: G1–G3 end to end',
  () => {
    let s: Stack;

    beforeAll(async () => {
      s = new Stack();
      await s.start();
    }, 180_000);
    afterAll(async () => {
      await s?.stop();
    }, 60_000);

    it('AC1: Low risk — G2 and G3 pass by HOTL once the spec and the plan are linked', async () => {
      const intent = await s.createIntent('low');
      await s.atGate(intent, 'G1');
      s.comment(intent, '/approve G1', 'a');
      await s.poll();
      await s.atGate(intent, 'G2');

      await s.linkInputs(intent);
      await s.atGate(intent, 'G4');
      expect(await s.noticeKinds(intent)).toEqual([
        'submitted',
        'advanced',
        'hotl_passed',
        'hotl_passed',
      ]);
      expect(await s.decisions(intent, 'G2')).toEqual([['pass', null, null]]);
      expect(await s.decisions(intent, 'G3')).toEqual([['pass', null, null]]);
      // FR-22: the status comments reach the issue with the next poll.
      await s.poll();
      expect(s.posted(intent)).toHaveLength(4);
      expect(s.posted(intent).at(-1)).toContain(intent.code);
    });

    it('AC1: Medium risk — HITL at G1, G2 and G3; nothing passes by silence', async () => {
      const intent = await s.createIntent('medium');
      await s.atGate(intent, 'G1');
      s.comment(intent, '/approve G1', 'a');
      await s.poll();
      await s.atGate(intent, 'G2');

      await s.linkInputs(intent);
      // HITL: the inputs alone never pass G2.
      await s.signals.wake({ tenantId: s.target.tenantId, intentId: intent.id });
      await s.atGate(intent, 'G2');
      expect(await s.decisions(intent, 'G2')).toEqual([]);

      const g2 = await s.cli('a', ['gate', 'approve', 'G2', intent.code]);
      expect(g2.code, g2.err).toBe(0);
      await s.atGate(intent, 'G3');
      expect(await s.decisions(intent, 'G3')).toEqual([]);

      s.comment(intent, '/approve G3', 'b');
      await s.poll();
      await s.atGate(intent, 'G4');
      expect(await s.decisions(intent, 'G1')).toEqual([['approve', null, s.users.a]]);
      expect(await s.decisions(intent, 'G2')).toEqual([['approve', null, s.users.a]]);
      expect(await s.decisions(intent, 'G3')).toEqual([['approve', null, s.users.b]]);
      expect(await s.noticeKinds(intent)).toEqual([
        'submitted',
        'advanced',
        'advanced',
        'advanced',
      ]);
    });

    it('AC5 (N8): a Low-risk plan flagged migration makes G3 HITL', async () => {
      const intent = await s.createIntent('low');
      await s.atGate(intent, 'G1');
      s.comment(intent, '/approve G1', 'a');
      await s.poll();
      await s.atGate(intent, 'G2');

      await s.linkInputs(intent, { flags: ['migration'] });
      // G2 is still HOTL; G3 waits for Person B.
      await s.atGate(intent, 'G3');
      await s.signals.wake({ tenantId: s.target.tenantId, intentId: intent.id });
      await s.atGate(intent, 'G3');
      expect(await s.decisions(intent, 'G2')).toEqual([['pass', null, null]]);
      expect(await s.decisions(intent, 'G3')).toEqual([]);
      expect(await s.scope.plans.latest(intent.id)).toMatchObject({ change_flags: ['migration'] });

      const g3 = await s.cli('b', ['gate', 'approve', 'G3', intent.code]);
      expect(g3.code, g3.err).toBe(0);
      await s.atGate(intent, 'G4');
      const [approval] = await s.scope.gateDecisions.listForIntent(intent.id, 'G3');
      expect(approval).toMatchObject({ decision: 'approve', oversight_mode: 'HITL' });
    });
  },
  180_000,
);

describeStack(
  'B10: G1 without a project AI record',
  () => {
    let s: Stack;

    beforeAll(async () => {
      s = new Stack();
      await s.start({ withoutAiRecord: true });
    }, 180_000);
    afterAll(async () => {
      await s?.stop();
    }, 60_000);

    it('AC6: the intent stays a draft with a G1 fail; saving the record lets it into G1', async () => {
      const intent = await s.createIntent('medium');
      const decisions = await waitFor(
        () => s.decisions(intent, 'G1'),
        (list) => list.length > 0,
      );
      expect(decisions).toEqual([['fail', 'ai_record_missing', null]]);
      expect(await s.reload(intent)).toMatchObject({ status: 'draft', current_gate: null });
      expect(await s.noticeKinds(intent)).toEqual(['ai_record_refused']);
      await s.poll();
      expect(s.posted(intent)[0]).toContain('ai_record_missing');

      // A person with a write role saves the record through the CLI: the API wakes the draft.
      await s.saveAiRecord();
      await s.atGate(intent, 'G1');
      expect(await s.noticeKinds(intent)).toEqual(['ai_record_refused', 'submitted']);
    });
  },
  180_000,
);
