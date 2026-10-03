// D-08 B10 AC4 on the whole stack (see stack.ts), scenario N7 of D-09 §7, run with
// `pnpm test:workflow`. A G1 that nobody decides: the workflow's deadline timer raises one `time`
// escalation (ADR-M30 §2.9); nobody acknowledges it, so the worker's escalation clock loop moves it
// from the owner (Person A, route `intent`) to the backup owner (Person B), then to governance
// (FR-18, ADR-M28). From the missed acknowledgement on, the intent is frozen for protected actions,
// also after governance acknowledges. The G1 decision itself still goes through: it closes the
// escalation before the freeze check (ADR-M30 §2.9).
//
// A G1 overdue escalation has no producers (QUESTIONS #64, `workflow/overdue.ts`), so the creator
// may own it. The check here is the other half of "who may act": a person without an acting role.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Escalation } from '../../../../packages/core/src/db/schema.js';
import { checkFreeze } from '../../../../packages/core/src/escalation/freeze.js';
import { describeDb } from '../../db/helpers.js';
import { DAY_MS, Stack, waitFor } from './stack.js';

const describeStack = process.env.SDLC_TEMPORAL_TEST_SERVER ? describeDb : describe.skip;

describeStack(
  'B10: N7, an unacknowledged escalation end to end',
  () => {
    let s: Stack;

    beforeAll(async () => {
      s = new Stack();
      await s.start();
    }, 180_000);
    afterAll(async () => {
      await s?.stop();
    }, 60_000);

    it('AC4 (N7): owner → backup → governance; the work stays frozen; the G1 decision closes it', async () => {
      const intent = await s.createIntent('medium');
      await s.atGate(intent, 'G1');
      const reload = async (e: Escalation) => (await s.scope.escalations.getById(e.id))!;
      const show = (e: Escalation) =>
        s.cliJson<{ status: string; current_step: string; freezes_intent: boolean }>('a', [
          'escalation',
          'show',
          e.code,
        ]);

      // Only time passes: the workflow's timer fires at the deadline (1 working day).
      await s.advanceTo(new Date(s.now().getTime() + DAY_MS + 60_000), { temporal: true });
      const [raised] = await waitFor(
        () => s.escalations(intent),
        (rows) => rows.length > 0,
      );
      expect(raised).toMatchObject({
        trigger: 'time',
        route: 'intent',
        current_step: 'owner',
        owner_id: s.users.a,
        backup_owner_id: s.users.b,
        producer_ids: [],
        response_level: 'notify',
      });
      expect(raised!.packet).toMatchObject({ subject_kind: 'intent', gate: 'G1' });
      // `notify` freezes nothing until its acknowledgement is missed.
      expect(await show(raised!)).toMatchObject({ status: 'open', freezes_intent: false });

      // Someone without an acting role cannot acknowledge, by comment or by the CLI.
      s.comment(intent, `/ack ${raised!.code}`, 'viewer');
      await s.poll();
      expect(s.replies(intent).at(-1)).toContain('Only the owner');
      expect((await s.cli('viewer', ['escalation', 'ack', raised!.code])).code).toBe(1);
      expect((await reload(raised!)).status).toBe('open');

      // Nobody acknowledges: each tick of the clock loop at the next due time moves it on.
      const steps: string[] = [];
      for (let i = 0; i < 10; i += 1) {
        const current = await reload(raised!);
        if (current.current_step === 'governance' && current.ack_missed_at !== null) break;
        if (current.next_check_at === null) throw new Error('the clock stopped before governance');
        await s.advanceTo(current.next_check_at, { temporal: false });
        await s.escalationLoop.tick();
        const after = await reload(raised!);
        if (steps.at(-1) !== after.current_step) steps.push(after.current_step);
      }
      expect(steps).toEqual(['owner', 'backup', 'governance']);
      const missed = await reload(raised!);
      expect(missed).toMatchObject({ status: 'open', current_step: 'governance' });
      expect(missed.ack_missed_at).not.toBeNull();

      // The notices reach the issue with the next poll, to the owner, the backup, then governance.
      await s.poll();
      const notices = s.posted(intent).filter((body) => body.includes(raised!.code));
      expect(notices.some((body) => body.includes('@alice'))).toBe(true);
      expect(notices.some((body) => body.includes('@bob'))).toBe(true);
      expect(notices.some((body) => body.includes('@gina'))).toBe(true);

      // Frozen: every protected action is refused while the escalation is not closed.
      const frozen = async () => {
        for (const action of ['gate_advance', 'run_start', 'push'] as const) {
          expect(await checkFreeze(s.scope, intent.id, action, s.now())).toEqual({
            allowed: false,
            escalationCodes: [raised!.code],
          });
        }
        expect(await show(raised!)).toMatchObject({ freezes_intent: true });
      };
      await frozen();

      // Governance acknowledges by comment: the chain stops, the work stays frozen.
      s.comment(intent, `/ack ${raised!.code}`, 'gov');
      await s.poll();
      expect(await reload(raised!)).toMatchObject({
        status: 'acknowledged',
        acknowledged_by: s.users.gov,
      });
      await frozen();

      // The G1 decision is the one move this escalation never blocks: it closes it first.
      s.comment(intent, '/approve G1', 'a');
      await s.poll();
      await s.atGate(intent, 'G2');
      expect((await reload(raised!)).status).toBe('closed');
      expect(await checkFreeze(s.scope, intent.id, 'run_start', s.now())).toEqual({
        allowed: true,
        escalationCodes: [],
      });
      expect(await s.escalations(intent)).toHaveLength(1);
    });
  },
  180_000,
);
