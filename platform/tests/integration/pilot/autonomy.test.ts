// D-08 C09 AC3 and AC5 on the sample repository's shape (see stack.ts), run with `pnpm test:pilot`:
// - T09 (D-09 §7, High → L1): G4 is HITL; Person A approves; the real run ends with a proposal
//   only (`succeeded_proposal_only`), stored as evidence; nothing is pushed; the intent is paused
//   at G4 (FR-03).
// - T10 (Critical → L0): G4 blocks the intent; no run, no sandbox.
// - AC5 (FR-36): a suspended agent, then an agent key that is not registered: G4 fails and the
//   intent waits at G4; no run starts.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { describeDb } from '../db/helpers.js';
import { AGENT_KEY, PilotStack, SPECS, T01_PATHS, waitFor, waitLong } from './stack.js';

const enabled = process.env.SDLC_PILOT_TEST === '1' && !!process.env.SDLC_TEMPORAL_TEST_SERVER;
const describePilot = enabled ? describeDb : describe.skip;

describePilot(
  'C09: autonomy by risk (T09, T10) and registered agents only (AC5)',
  () => {
    let s: PilotStack;

    beforeAll(async () => {
      s = new PilotStack();
      await s.startPilot();
    }, 1_200_000);
    afterAll(async () => {
      await s?.stopPilot();
    }, 120_000);

    it('AC3 T09: High → G4 HITL → an L1 run that only stores a proposal; nothing pushed', async () => {
      const intent = await s.throughG3('high', {
        specPath: SPECS.T09,
        paths: T01_PATHS,
        summary: 'Multiple warehouses: propose a design. [stub:append]',
      });
      // HITL: G4 waits for Person A (the run proposal).
      await waitFor(
        () => s.noticeKinds(intent),
        (kinds) => kinds.includes('run_proposed'),
      );
      expect(await s.runs(intent)).toEqual([]);
      await s.approve('a', 'G4', intent);

      const run = await s.runEnded(intent);
      expect(run).toMatchObject({ status: 'succeeded_proposal_only', head_sha: null });
      const contract = await s.scope.runContracts.getByRunId(run.id);
      expect(contract?.contract_json).toMatchObject({ autonomy_level: 'L1' });
      const [g4] = await s.scope.gateDecisions.listForIntent(intent.id, 'G4');
      expect(g4).toMatchObject({
        decision: 'approve',
        oversight_mode: 'HITL',
        decided_by: s.users.a,
      });
      // The proposal is evidence; the patch holds the agent's change.
      const stored = (await s.scope.runEvents.list(run.id)).find(
        (e) => e.event_type === 'proposal_stored',
      );
      expect(stored?.payload).toMatchObject({ changed_files: 1 });
      const [proposal] = s.bucket.keys('proposals/');
      expect(proposal).toContain(run.id);
      expect(s.bucket.objects.get(proposal!)?.toString()).toContain('C09 stub note.');
      // Paused at G4 for Person A; no branch, no pull request.
      await s.until(intent, 'paused', 'G4');
      expect(await s.noticeKinds(intent)).toContain('proposal_ready');
      expect(s.repo.head(`agent/${intent.code}`)).toBeNull();
      expect(s.openedPulls()).toEqual([]);
    });

    it('AC3 T10: Critical → G4 blocks the intent; the agent never runs', async () => {
      const intent = await s.throughG3('critical', {
        specPath: SPECS.T10,
        paths: ['apps/api/src/orders/**'],
        summary: 'Delete old orders. [stub:append]',
      });
      const blocked = await s.until(intent, 'blocked');
      expect(blocked.current_gate).toBe('G4');
      const decisions = await s.decisions(intent, 'G4');
      expect(decisions.map(([decision]) => decision)).toEqual(['block']);
      expect(await s.noticeKinds(intent)).toContain('blocked');
      expect(await s.runs(intent)).toEqual([]);
    });

    it('AC5: a suspended agent, then an unregistered agent key → G4 fails, no run', async () => {
      const suspended = await s.cli('b', [
        'admin',
        'agent',
        'suspend',
        '--key',
        AGENT_KEY,
        '--reason',
        'quality',
      ]);
      expect(suspended.code, suspended.err).toBe(0);
      const intent = await s.throughG3('medium', {
        specPath: SPECS.T01,
        paths: T01_PATHS,
        summary: 'Japanese labels. [stub:append]',
      });
      const first = await waitLong(
        () => s.g4Checks(intent),
        (checks) => checks.length > 0,
      );
      expect(await s.decisions(intent, 'G4')).toEqual([['fail', 'agent_not_runnable', null]]);
      expect(await s.reload(intent)).toMatchObject({ status: 'in_gate', current_gate: 'G4' });

      // The tenant admin points the project at an agent key nobody registered.
      await s.setConfig('', { agentKey: 'ghost-agent' });
      await s.signals.wake({ tenantId: s.target.tenantId, intentId: intent.id });
      const checks = await waitLong(
        () => s.g4Checks(intent),
        (list) => list.length > first.length,
      );
      expect(checks).toEqual([first[0], 'agent_not_found']);
      expect(await s.reload(intent)).toMatchObject({ status: 'in_gate', current_gate: 'G4' });
      expect(await s.runs(intent)).toEqual([]);
    });
  },
  1_800_000,
);
