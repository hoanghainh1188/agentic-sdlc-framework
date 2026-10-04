// D-08 C09 AC4 on a live run (see stack.ts), run with `pnpm test:pilot`: the real Agent Server in a
// node24 sandbox, driven by the real runner through the workflow.
// - The kill switch (FR-34, D-02 §10 item 5d): Person B runs `sdlc run kill <INT>` while the agent
//   waits for a slow model reply; the run ends `stopped_killed`, the sandbox, its network and volume
//   are gone, the run's key is revoked, the escalation is raised, the intent is paused at G4. The
//   time from the command to the clean-up is measured (target: under 5 minutes).
// - Loop detection (FR-35): the model asks for the same tool call again and again; the runner stops
//   the agent (`stopped_stalled`, `loop_detected`); G5 pauses the intent with an escalation.
//   No progress (`[stub:silent]`) is proven on the real Agent Server by `pnpm test:agent`.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { describeDb } from '../db/helpers.js';
import { PilotStack, SPECS, T01_PATHS, waitLong } from './stack.js';

const enabled = process.env.SDLC_PILOT_TEST === '1' && !!process.env.SDLC_TEMPORAL_TEST_SERVER;
const describePilot = enabled ? describeDb : describe.skip;
const FIVE_MINUTES = 5 * 60_000;

describePilot(
  'C09: the kill switch and loop detection on a live run',
  () => {
    let s: PilotStack;

    beforeAll(async () => {
      s = new PilotStack();
      await s.startPilot();
    }, 1_200_000);
    afterAll(async () => {
      await s?.stopPilot();
    }, 120_000);

    it('AC4: `sdlc run kill` stops a running agent; sandbox, network, volume and key gone in under 5 minutes', async () => {
      const intent = await s.throughG3('medium', {
        specPath: SPECS.T01,
        paths: T01_PATHS,
        summary: 'Japanese labels. [stub:slow]', // every model reply waits 120 s
      });
      const [running] = await waitLong(
        () => s.runs(intent),
        (list) => list[0]?.status === 'running',
      );
      await waitLong(
        () => s.runEvents(running!),
        (events) => events.includes('agent_started'),
      );
      const runId = running!.id;

      const started = Date.now();
      const killed = await s.cli('b', ['run', 'kill', intent.code]);
      expect(killed.code, killed.err).toBe(0);
      const run = await s.runEnded(intent);
      await waitLong(
        () => Promise.resolve(s.leftovers(runId)),
        (left) => left.length === 0,
      );
      const elapsed = Date.now() - started;
      expect(elapsed).toBeLessThan(FIVE_MINUTES);
      expect(run).toMatchObject({ status: 'stopped_killed', stop_reason: 'killed' });
      expect(run.killed_by).toBe(s.users.b);
      expect(s.gateway.revokedRuns).toContain(runId);
      expect(await s.runEvents(run)).toEqual(
        expect.arrayContaining(['kill_requested', 'agent_stopped', 'token_revoked']),
      );

      const paused = await s.until(intent, 'paused', 'G4');
      expect(paused.current_gate).toBe('G4');
      const [escalation] = await s.escalations(intent);
      // Config `run.kill_escalation` (default high, contain; rule M26: pause or higher).
      expect(escalation).toMatchObject({ route: 'technical', response_level: 'contain' });
      expect(await s.noticeKinds(intent)).toContain('run_killed');
      expect(s.repo.head(`agent/${intent.code}`)).toBeNull();
      // The measured time, for the PR (D-02 §10 item 5d).
      process.stdout.write(`c09:kill_to_clean_up_ms:${String(elapsed)}\n`);
    });

    it('AC4: the same tool call again and again → stopped_stalled (loop_detected) → paused at G5', async () => {
      // Threshold 2: the runner stops at the 3rd identical call, before OpenHands' own stuck
      // detector (fixed at 4, ADR-M10 §4.1 item 2). With the default 3 both fire at the 4th call
      // and either may win (both end `stopped_stalled`), as `pnpm test:agent` notes too.
      await s.setConfig('', { run: ['loop_detection: { identical_tool_calls_max: 2 }'] });
      const intent = await s.throughG3('medium', {
        specPath: SPECS.T01,
        paths: T01_PATHS,
        summary: 'Japanese labels. [stub:repeat]',
      });
      const run = await s.runEnded(intent);
      expect(run).toMatchObject({ status: 'stopped_stalled', stop_reason: 'loop_detected' });
      const loop = (await s.scope.runEvents.list(run.id)).find(
        (e) => e.event_type === 'loop_detected',
      );
      expect(loop?.payload).toMatchObject({ threshold: 2 });
      expect(
        Number((loop?.payload as { identical_calls: number }).identical_calls),
      ).toBeGreaterThan(2);

      await s.until(intent, 'paused', 'G5');
      expect(await s.decisions(intent, 'G5')).toEqual([['fail', 'run_cap_reached', null]]);
      const [escalation] = await s.escalations(intent);
      expect(escalation).toMatchObject({ route: 'intent', response_level: 'pause' });
      expect(s.gateway.revokedRuns).toContain(run.id);
      expect(s.leftovers(run.id)).toEqual([]);
    });
  },
  1_800_000,
);
