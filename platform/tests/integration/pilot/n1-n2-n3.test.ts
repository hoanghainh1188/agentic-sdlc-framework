// D-08 C09 AC2 on the sample repository's shape (see stack.ts), run with `pnpm test:pilot`. Each
// case is a Medium intent decided by people on the CLI through G1–G3 (no HOTL block window), then
// a real run in a node24 sandbox with the stub model:
// - N1 (D-09 §7): the agent writes a file outside the plan → G5 fails `out_of_scope` → back to
//   G3, HITL; nothing is pushed.
// - N2: CI fails, again after the one retry (`run.g6_ci_retries: 1`): the retry run starts from the
//   pushed commit and pushes on top; then G6 sends the intent back to G3, HITL (FR-13).
// - N3: a tiny intent budget: the runner records the budget warning while the agent works (the
//   poller posts it on the issue), stops the run at the stop share, and G5 pauses the intent with an
//   escalation (FR-32, FR-52).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { describeDb } from '../db/helpers.js';
import { NOTES_FILE, PilotStack, SPECS, T01_PATHS, waitLong } from './stack.js';

const enabled = process.env.SDLC_PILOT_TEST === '1' && !!process.env.SDLC_TEMPORAL_TEST_SERVER;
const describePilot = enabled ? describeDb : describe.skip;

describePilot(
  'C09: N1, N2, N3 on the pilot shape',
  () => {
    let s: PilotStack;

    beforeAll(async () => {
      s = new PilotStack();
      await s.startPilot();
    }, 1_200_000);
    afterAll(async () => {
      await s?.stopPilot();
    }, 120_000);

    it('N1: a change outside the plan → G5 out_of_scope → back to G3 (HITL), nothing pushed', async () => {
      const intent = await s.throughG3('medium', {
        specPath: SPECS.T01,
        paths: T01_PATHS,
        summary: 'Japanese labels. [stub:edit]', // the stub writes hello.txt at the root
      });
      const run = await s.runEnded(intent);
      await s.until(intent, 'in_gate', 'G3');
      expect(run.status).toBe('succeeded');
      const checked = (await s.scope.runEvents.list(run.id)).find(
        (e) => e.event_type === 'changes_checked',
      );
      expect(checked?.payload).toMatchObject({ changed_files: 1, out_of_scope: 1 });
      expect(await s.decisions(intent, 'G5')).toEqual([['fail', 'out_of_scope', null]]);
      expect(await s.noticeKinds(intent)).toContain('scope_returned');
      expect(s.repo.head(`agent/${intent.code}`)).toBeNull();
      expect(await s.escalations(intent)).toEqual([]);
    });

    it('N2: CI fails after the retry → back to G3 (HITL); the retry ran from the pushed commit', async () => {
      const intent = await s.throughG3('medium', {
        specPath: SPECS.T01,
        paths: T01_PATHS,
        summary: 'Japanese labels. [stub:append]',
      });
      const branch = `agent/${intent.code}`;
      // Run 1 → G5 (HOTL) → its block window → push and pull request.
      await waitLong(
        () => s.reload(intent),
        (i) => i.pr_number !== null,
      );
      const first = (await s.runs(intent))[0]!;
      expect(s.repo.head(branch)).toBe(first.head_sha);
      await s.setCi(intent, 'failure');
      // G6 fails `ci_failed` → G4 → run 2 from the pushed commit → G5 → its window → push.
      const runs = await waitLong(
        () => s.runs(intent),
        (list) => list.length === 2 && list[1]!.head_sha !== null,
      );
      const second = runs[1]!;
      expect(second.base_sha).toBe(first.head_sha);
      expect(s.repo.head(branch)).toBe(second.head_sha);
      expect(s.repo.file(second.head_sha!, NOTES_FILE)?.toString()).toBe(
        'C09 stub note.\nC09 stub note.\n',
      );
      await s.setCi(intent, 'failure');
      // No retry left: back to G3, which is HITL from now on.
      await s.until(intent, 'in_gate', 'G3');
      expect(await s.decisions(intent, 'G6')).toEqual([
        ['fail', 'ci_failed', null],
        ['fail', 'ci_failed', null],
      ]);
      const kinds = await s.noticeKinds(intent);
      expect(kinds).toEqual(expect.arrayContaining(['ci_retry', 'ci_returned']));
      expect((await s.runs(intent)).length).toBe(2);
      // One pull request for the intent, kept open.
      expect(s.openedPulls()).toHaveLength(1);
    });

    it('N3: a tiny budget → the warning during the run, the stop at the cap, paused at G5 with an escalation', async () => {
      const intent = await s.throughG3(
        'medium',
        { specPath: SPECS.T01, paths: T01_PATHS, summary: 'Japanese labels. [stub:count]' },
        ['--budget', '0.05'],
      );
      const run = await s.runEnded(intent);
      expect(run).toMatchObject({ status: 'stopped_budget', stop_reason: 'max_budget' });
      const events = await s.scope.runEvents.list(run.id);
      const warning = events.find((e) => e.event_type === 'budget_warning');
      expect(warning?.payload).toMatchObject({ max_budget_usd: '0.05' });
      expect(Number((warning?.payload as { percent: number }).percent)).toBeGreaterThanOrEqual(80);
      // The warning comment reaches the issue with a poll (FR-52).
      await s.poll();
      expect(s.posted(intent).some((body) => body.includes('% of its budget limit'))).toBe(true);

      const paused = await s.until(intent, 'paused', 'G5');
      expect(paused.current_gate).toBe('G5');
      expect(await s.decisions(intent, 'G5')).toEqual([['fail', 'budget_exceeded', null]]);
      const [escalation] = await s.escalations(intent);
      expect(escalation).toMatchObject({ route: 'intent', response_level: 'pause' });
      // The run's key was revoked at its end; nothing was pushed.
      expect(s.gateway.revokedRuns).toContain(run.id);
      expect(s.repo.head(`agent/${intent.code}`)).toBeNull();
    });
  },
  1_800_000,
);
