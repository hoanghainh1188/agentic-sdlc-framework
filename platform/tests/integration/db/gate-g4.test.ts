// D-08 C06 (session 1) on a live PostgreSQL, without Temporal (design/ADR-M33):
// - AC1: the G4 check list, in order: block window, freeze, approved spec and plan, AI record,
//   agent register (active, model, instructions, autonomy), intent budget; a failed check records
//   one system `fail` per cause and the intent waits at G4 until the cause is fixed (QUESTIONS
//   #110); the stricter of the stored and current autonomy (QUESTIONS #22).
// - AC2: Critical risk, or an effective autonomy of L0 → `block`, intent `blocked`, workflow ends.
// - AC3: High risk → HITL: Person A approves the run proposal (`/approve G4`); a new commit on the
//   default branch voids the approval (FR-17); a rejection ends the intent.
// - `prepareRun`: contract, capped key, wrapped secrets; the recertification warning (FR-36).
// - C07 (QUESTIONS #126): an unpinned agent instruction file at the base commit, or a commit the
//   Git host lists only in part, fails G4 (`instructions_unpinned`); the run event `key_issued`.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { changeAgentStatus } from '../../../packages/core/src/agents/register.js';
import { CostError } from '../../../packages/core/src/cost/errors.js';
import { raiseEscalation } from '../../../packages/core/src/escalation/raise.js';
import {
  prepareRun,
  type PrepareRunDeps,
} from '../../../packages/core/src/workflow/prepare-run.js';
import { seedAgent } from '../agent-seed.js';
import {
  AGENTS_MD,
  atG4,
  BASE_1,
  BASE_2,
  checksFailed,
  decideAt,
  flush,
  harness,
  HOUR,
  MODEL,
  notices,
  Secret,
  sha256,
  T0,
  type Harness,
  type World,
} from '../g4-harness.js';
import { FakeTransit } from '../../run-contract/helpers.js';
import { createTestDatabase, describeDb, type TestDatabase } from './helpers.js';

describeDb('C06 session 1: gate G4 on PostgreSQL', () => {
  let db: TestDatabase;
  let t: Harness;

  beforeAll(async () => {
    db = await createTestDatabase();
    t = await harness(db);
  }, 60_000);

  afterAll(async () => {
    await t?.f.close();
    await db?.drop();
  });

  beforeEach(async () => {
    t.setClock(T0);
    Object.assign(t.world, {
      base: BASE_1,
      instructions: AGENTS_MD,
      models: [MODEL],
      tenantBudget: null,
      paths: ['AGENTS.md', 'src/main.ts'],
    });
    t.world.gitDown = false;
    await t.setConfig(`run:\n  agent_key: ${t.agent.key}\n`);
  });

  describe('AC1: POLICY at Medium risk', () => {
    it('passes when every check holds, bound to the run proposal, once', async () => {
      const intent = await atG4(t, 'medium');
      expect(await t.settle(intent)).toEqual({ outcome: 'waiting', reason: 'run_pending' });
      expect(await t.reload(intent)).toMatchObject({ status: 'in_gate', current_gate: 'G4' });
      expect(await t.g4Decisions(intent)).toEqual([['pass', null, 'POLICY']]);

      const [proposed] = await t.f.scope.audit.listForEntity(intent.id, ['run.proposed']);
      const [pass] = await t.f.scope.gateDecisions.listForIntent(intent.id, 'G4');
      expect(proposed?.payload).toMatchObject({
        input_sha256: pass!.input_sha256,
        base_sha: BASE_1,
        agent_id: t.agent.id,
        autonomy_level: 'L2',
      });
      // Waking again changes nothing.
      expect(await t.settle(intent)).toEqual({ outcome: 'waiting', reason: 'run_pending' });
      expect(await t.g4Decisions(intent)).toHaveLength(1);
      expect(await checksFailed(t, intent)).toEqual([]);
    });

    it('a new commit on the default branch is a new proposal with its own pass', async () => {
      const intent = await atG4(t, 'medium');
      await t.settle(intent);
      t.world.base = BASE_2;
      t.world.instructions = AGENTS_MD;
      await t.settle(intent);
      expect(await t.g4Decisions(intent)).toEqual([
        ['pass', null, 'POLICY'],
        ['pass', null, 'POLICY'],
      ]);
      const proposals = await t.f.scope.audit.listForEntity(intent.id, ['run.proposed']);
      expect(proposals.map((e) => (e.payload as { base_sha: string }).base_sha)).toEqual([
        BASE_1,
        BASE_2,
      ]);
    });

    it('no agent configured → agent_not_runnable, once; the next wake after the fix passes', async () => {
      await t.setConfig('run:\n  agent_key: null\n');
      const intent = await atG4(t, 'medium');
      expect(await t.settle(intent)).toEqual({ outcome: 'waiting', reason: 'g4_check' });
      await t.settle(intent);
      expect(await t.g4Decisions(intent)).toEqual([['fail', 'agent_not_runnable', 'POLICY']]);
      expect(await checksFailed(t, intent)).toEqual(['agent_not_configured']);
      // An unrelated commit on the default branch records nothing new (review of C06 session 1).
      t.world.base = BASE_2;
      await t.settle(intent);
      expect(await t.g4Decisions(intent)).toHaveLength(1);
      expect((await notices(t, intent)).filter((k) => k === 'g4_refused')).toHaveLength(1);

      await t.setConfig(`run:\n  agent_key: ${t.agent.key}\n`);
      expect(await t.settle(intent)).toEqual({ outcome: 'waiting', reason: 'run_pending' });
      expect((await t.g4Decisions(intent)).map(([d]) => d)).toEqual(['fail', 'pass']);

      // The status comment names the reason and mentions Person A.
      await flush(t);
      const posted = t.f.posted(intent).filter((b) => b.includes('cannot start its run at **G4**'));
      expect(posted).toHaveLength(1);
      expect(posted[0]).toContain('`agent_not_runnable`');
      expect(posted[0]).toContain('@alice');
    });

    const changes: Record<string, (world: World) => void> = {
      edited: (world) => {
        world.instructions = `${AGENTS_MD}more\n`;
      },
      missing: (world) => {
        world.instructions = null;
      },
      no_model: (world) => {
        world.models = [];
      },
    };
    it.each([
      ['edited', 'instructions_mismatch', 'instructions_mismatch'],
      ['missing', 'instructions_mismatch', 'instructions_missing'],
      ['no_model', 'agent_not_runnable', 'model_not_allowed'],
    ] as const)('instructions or model: %s → %s', async (change, reason, check) => {
      const intent = await atG4(t, 'medium');
      changes[change]!(t.world);
      expect(await t.settle(intent)).toEqual({ outcome: 'waiting', reason: 'g4_check' });
      expect(await t.g4Decisions(intent)).toEqual([['fail', reason, 'POLICY']]);
      expect(await checksFailed(t, intent)).toEqual([check]);
    });

    it('C07 #126: another instruction file at the base commit → instructions_unpinned, once per set of files', async () => {
      const intent = await atG4(t, 'medium');
      t.world.paths = ['AGENTS.md', 'CLAUDE.md', 'src/main.ts'];
      expect(await t.settle(intent)).toEqual({ outcome: 'waiting', reason: 'g4_check' });
      await t.settle(intent);
      expect(await t.g4Decisions(intent)).toEqual([['fail', 'instructions_unpinned', 'POLICY']]);
      expect(await checksFailed(t, intent)).toEqual(['instructions_unpinned']);
      // A second spelling of the pinned file is another file in Git: a new failure.
      t.world.paths = ['AGENTS.md', 'CLAUDE.md', 'agents.md', 'src/main.ts'];
      await t.settle(intent);
      expect(await checksFailed(t, intent)).toEqual([
        'instructions_unpinned',
        'instructions_unpinned',
      ]);
      // Nothing about the paths is stored: the audit event holds the cause and the decision only.
      const events = await t.f.scope.audit.listForEntity(intent.id, ['gate.g4_check_failed']);
      expect(JSON.stringify(events.map((e) => e.payload))).not.toMatch(/CLAUDE|agents\.md/i);
      // The files are removed: the run may start.
      t.world.paths = ['AGENTS.md', 'src/main.ts'];
      expect(await t.settle(intent)).toEqual({ outcome: 'waiting', reason: 'run_pending' });
    });

    it('C07 #126: a commit the Git host lists only in part → instructions_unpinned (tree_truncated)', async () => {
      const intent = await atG4(t, 'medium');
      t.world.paths = 'truncated';
      expect(await t.settle(intent)).toEqual({ outcome: 'waiting', reason: 'g4_check' });
      await t.settle(intent);
      expect(await t.g4Decisions(intent)).toEqual([['fail', 'instructions_unpinned', 'POLICY']]);
      expect(await checksFailed(t, intent)).toEqual(['tree_truncated']);
    });

    it('a suspended agent → agent_not_runnable (agent_not_active)', async () => {
      const other = await seedAgent(t.f.scope, t.f.users.a, {
        model: MODEL,
        instructionsSha256: sha256(AGENTS_MD),
      });
      await t.setConfig(`run:\n  agent_key: ${other.key}\n`);
      await changeAgentStatus(t.f.scope, other.key, { to: 'suspended', reason: 'quality' });
      const intent = await atG4(t, 'medium');
      await t.settle(intent);
      expect(await t.g4Decisions(intent)).toEqual([['fail', 'agent_not_runnable', 'POLICY']]);
      expect(await checksFailed(t, intent)).toEqual(['agent_not_active']);
    });

    it('the spec changed after G2 → input_mismatch (spec_changed)', async () => {
      const intent = await atG4(t, 'medium');
      await t.f.registry.linkSpec(t.f.scope, intent.id, {
        path: 'docs/specs/t07.md',
        commitSha: 'e'.repeat(40),
        contentSha256: '9'.repeat(64),
        actorType: 'human',
        actorId: t.f.users.a,
      });
      await t.settle(intent);
      expect(await t.g4Decisions(intent)).toEqual([['fail', 'input_mismatch', 'POLICY']]);
      expect(await checksFailed(t, intent)).toEqual(['spec_changed']);
    });

    it('the AI record no longer allows the data class → data_class_not_allowed', async () => {
      const intent = await atG4(t, 'medium');
      const record = (await t.f.scope.projectAiRecords.get(t.f.target.projectId))!;
      await t.f.scope.projectAiRecords.save(t.f.target.projectId, {
        aiAllowed: 'yes',
        allowedDataClasses: ['public'],
        prodLogsAllowed: 'no',
        disclosureFormat: 'standard_note',
        confirmedAt: null,
        recordRef: null,
        updatedBy: t.f.users.a,
        actorType: 'human',
        expectedVersion: record.version,
      });
      try {
        await t.settle(intent);
        expect(await t.g4Decisions(intent)).toEqual([['fail', 'data_class_not_allowed', 'POLICY']]);
      } finally {
        await t.f.scope.projectAiRecords.save(t.f.target.projectId, {
          aiAllowed: 'yes',
          allowedDataClasses: ['public', 'internal', 'client_restricted'],
          prodLogsAllowed: 'no',
          disclosureFormat: 'standard_note',
          confirmedAt: null,
          recordRef: null,
          updatedBy: t.f.users.a,
          actorType: 'human',
          expectedVersion: record.version + 1,
        });
      }
    });

    it('the intent budget is used up → budget_exceeded', async () => {
      const intent = await atG4(t, 'medium');
      await t.f.scope.costRecords.insertIfNew({
        projectId: t.f.target.projectId,
        intentId: intent.id,
        runId: null,
        gate: 'G1',
        agent: null,
        model: MODEL,
        providerType: 'self_hosted',
        inputTokens: 1,
        outputTokens: 1,
        cachedInputTokens: 0,
        costUsd: intent.budget_usd,
        sourceRef: `req-${intent.id}`,
        occurredAt: T0,
      });
      await t.settle(intent);
      expect(await t.g4Decisions(intent)).toEqual([['fail', 'budget_exceeded', 'POLICY']]);
      expect(await checksFailed(t, intent)).toEqual(['intent_budget_exhausted']);
    });

    it('the tenant budget of this month is used up → budget_exceeded (tenant_budget_exhausted), once', async () => {
      const intent = await atG4(t, 'medium');
      t.world.tenantBudget = '0.5';
      await t.f.scope.costRecords.insertIfNew({
        projectId: t.f.target.projectId,
        intentId: null,
        runId: null,
        gate: null,
        agent: null,
        model: MODEL,
        providerType: 'self_hosted',
        inputTokens: 1,
        outputTokens: 1,
        cachedInputTokens: 0,
        costUsd: '0.5',
        sourceRef: `tenant-month-${intent.id}`,
        occurredAt: T0,
      });
      await t.settle(intent);
      await t.settle(intent);
      expect(await t.g4Decisions(intent)).toEqual([['fail', 'budget_exceeded', 'POLICY']]);
      expect(await checksFailed(t, intent)).toEqual(['tenant_budget_exhausted']);
    });

    it('a frozen intent waits; no decision is recorded', async () => {
      const intent = await atG4(t, 'medium');
      // Enter G4 without evaluating it (the Git host is down), then freeze the intent.
      t.world.gitDown = true;
      await t.settle(intent);
      t.world.gitDown = false;
      await raiseEscalation(
        t.f.scope,
        {
          intentId: intent.id,
          trigger: 'uncertainty',
          route: 'technical',
          severity: 'high',
          responseLevel: 'pause',
          packet: { subject_kind: 'intent', subject_sha256: 'a'.repeat(64) },
          producers: [],
          raisedBy: { type: 'system' },
        },
        { now: () => T0 },
      );
      expect(await t.settle(intent)).toEqual({ outcome: 'waiting', reason: 'frozen' });
      expect(await t.g4Decisions(intent)).toEqual([]);
    });

    it('the Git host cannot be read → wait and try again', async () => {
      const intent = await atG4(t, 'medium');
      t.world.gitDown = true;
      expect(await t.settle(intent)).toEqual({
        outcome: 'waiting',
        reason: 'git_host_unavailable',
        wakeInMs: 60_000,
      });
      expect(await t.g4Decisions(intent)).toEqual([]);
    });

    it('QUESTIONS #22: the stricter autonomy of stored and current configuration applies', async () => {
      const intent = await atG4(t, 'medium');
      expect(intent.max_autonomy).toBe('L2');
      await t.setConfig(
        `run:\n  agent_key: ${t.agent.key}\nautonomy:\n  max_by_risk: { low: L2, medium: L1, high: L1, critical: L0 }\n`,
      );
      await t.settle(intent);
      const [proposed] = await t.f.scope.audit.listForEntity(intent.id, ['run.proposed']);
      expect(proposed?.payload).toMatchObject({ autonomy_level: 'L1' });
    });
  });

  describe('the HOTL block window (Low risk)', () => {
    it('G4 waits until the last block window closes, then passes', async () => {
      const intent = await t.f.newIntent({ riskTier: 'low' });
      await t.settle(intent);
      await decideAt(t, intent, 'G1', 'a');
      await t.f.addInputs(intent);
      const waiting = await t.settle(intent);
      expect(waiting).toMatchObject({ outcome: 'waiting', reason: 'later_gate' });
      expect(await t.g4Decisions(intent)).toEqual([]);

      t.setClock(new Date(T0.getTime() + 6 * HOUR));
      expect(await t.settle(intent)).toEqual({ outcome: 'waiting', reason: 'run_pending' });
      expect(await t.g4Decisions(intent)).toEqual([['pass', null, 'POLICY']]);
    });
  });

  describe('AC2: Critical risk, or no autonomy → blocked', () => {
    it('Critical: a system block, the intent is blocked and finished; no proposal', async () => {
      const intent = await atG4(t, 'critical');
      expect(await t.settle(intent)).toEqual({ outcome: 'finished', status: 'blocked' });
      expect(await t.reload(intent)).toMatchObject({ status: 'blocked', current_gate: 'G4' });
      expect(await t.g4Decisions(intent)).toEqual([['block', 'policy_denied', 'HITL']]);
      expect(await t.f.scope.audit.listForEntity(intent.id, ['run.proposed'])).toEqual([]);
      expect(await notices(t, intent)).toContain('blocked');
      await flush(t);
      expect(t.f.posted(intent).some((b) => b.includes('was blocked at **G4**'))).toBe(true);
      // A blocked intent frees its issue for a new intent (migration 0011).
      const open = await t.f.scope.intents.findOpenByGitNumber(t.f.target.projectId, {
        kind: 'issue',
        number: intent.issue_number!,
      });
      expect(open).toEqual([]);
    });

    it('an effective autonomy of L0 from the current configuration blocks too', async () => {
      const intent = await atG4(t, 'medium');
      await t.setConfig(
        `run:\n  agent_key: ${t.agent.key}\nautonomy:\n  max_by_risk: { low: L0, medium: L0, high: L0, critical: L0 }\n`,
      );
      expect(await t.settle(intent)).toEqual({ outcome: 'finished', status: 'blocked' });
    });
  });

  describe('AC3: HITL at High risk (Person A)', () => {
    it('waits for Person A, who approves this proposal; a new commit voids the approval', async () => {
      const intent = await atG4(t, 'high');
      const waiting = await t.settle(intent);
      expect(waiting).toMatchObject({ outcome: 'waiting', reason: 'decision' });
      const [proposed] = await t.f.scope.audit.listForEntity(intent.id, ['run.proposed']);
      expect(proposed?.payload).toMatchObject({ autonomy_level: 'L1' });
      expect(await notices(t, intent)).toContain('run_proposed');

      // Person B holds no G4 role; Person A approves.
      await expect(t.decide(await t.reload(intent), 'approve', 'b')).rejects.toMatchObject({
        code: 'approval_refused',
      });
      await t.decide(await t.reload(intent), 'approve', 'a');
      expect(await t.settle(intent)).toEqual({ outcome: 'waiting', reason: 'run_pending' });

      // A new commit on the default branch: a new proposal; the approval is voided (FR-17).
      t.world.base = BASE_2;
      expect(await t.settle(intent)).toMatchObject({ outcome: 'waiting', reason: 'decision' });
      expect(await t.g4Decisions(intent)).toEqual([
        ['approve', null, 'HITL'],
        ['void', 'input_mismatch', 'HITL'],
      ]);
      expect((await notices(t, intent)).filter((k) => k === 'run_proposed')).toHaveLength(2);

      await flush(t);
      const posted = t.f.posted(intent).filter((b) => b.includes('for approval of its run'));
      expect(posted.at(-1)).toContain(`\`${t.agent.key}\``);
      expect(posted.at(-1)).toContain(`\`${BASE_2.slice(0, 12)}\``);
      expect(posted.at(-1)).toContain('`/approve G4`');
    });

    it('a rejection at G4 ends the intent', async () => {
      const intent = await atG4(t, 'high');
      await t.settle(intent);
      await t.decide(await t.reload(intent), 'reject', 'a');
      expect(await t.settle(intent)).toEqual({ outcome: 'finished', status: 'rejected' });
    });

    it('a decision before the first proposal is refused (gate_input_missing)', async () => {
      const intent = await atG4(t, 'high');
      t.world.gitDown = true;
      await t.settle(intent);
      expect(await t.reload(intent)).toMatchObject({ current_gate: 'G4' });
      await expect(t.decide(await t.reload(intent), 'approve', 'a')).rejects.toMatchObject({
        code: 'gate_input_missing',
      });
    });
  });

  describe('prepareRun: contract, capped key, wrapped secrets', () => {
    const transit = new FakeTransit();
    const calls: { keys: string[]; revoked: string[]; wrapped: string[][] } = {
      keys: [],
      revoked: [],
      wrapped: [],
    };
    let refuseKey: CostError | undefined;

    function deps(): PrepareRunDeps {
      return {
        registry: t.f.registry,
        g4: t.g4,
        signer: transit,
        costController: {
          issueRunKey: (input) => {
            if (refuseKey) return Promise.reject(refuseKey);
            calls.keys.push(input.runId);
            return Promise.resolve({
              key: { keyId: `key-${input.runId}`, key: new Secret('sk-virtual'), expiresAt: T0 },
              labels: {} as never,
              maxBudgetUsd: '2',
              limitedBy: 'run' as const,
            });
          },
          endRun: (input) => {
            calls.revoked.push(input.keyId);
            return Promise.resolve({} as never);
          },
        },
        gitHost: {
          issueShortLivedToken: (repo, scope) =>
            Promise.resolve({
              token: new Secret('ghs_token'),
              expiresAt: T0.toISOString(),
              repo,
              permissions: scope.permissions,
            }),
        },
        wrapper: {
          wrap: (fields, options) => {
            calls.wrapped.push([...Object.keys(fields), String(options.ttlSeconds)]);
            return Promise.resolve(new Secret(`wrap-${Object.keys(fields).join()}`));
          },
        },
        egressAllowlist: ['npm-proxy:4873', 'litellm:4000'],
      };
    }

    beforeEach(() => {
      refuseKey = undefined;
      calls.keys.length = 0;
      calls.revoked.length = 0;
      calls.wrapped.length = 0;
    });

    it('POLICY: issues the contract from the passed proposal, a key and two wrapped secrets', async () => {
      const intent = await atG4(t, 'medium');
      await t.settle(intent);
      const result = await prepareRun(t.f.scope, deps(), intent.id);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.run).toMatchObject({ attempt: 1, modelRef: MODEL, agentKey: t.agent.key });
      expect(result.run.wrappedGitToken.reveal()).toBe('wrap-token');
      expect(result.run.wrappedVirtualKey.reveal()).toBe('wrap-key');
      // Wrapping tokens live as long as the contract is valid (15 minutes by default).
      expect(calls.wrapped).toEqual([
        ['token', '900'],
        ['key', '900'],
      ]);

      const run = (await t.f.scope.runs.getById(result.run.runId))!;
      expect(run).toMatchObject({ status: 'queued', triggered_by: null, base_sha: BASE_1 });
      const contract = (await t.f.scope.runContracts.getByRunId(run.id))!.contract_json;
      expect(contract).toMatchObject({
        agent_id: t.agent.id,
        autonomy_level: 'L2',
        allowed_models: [MODEL],
        allowed_tools: ['file_editor', 'terminal'],
        egress_allowlist: ['litellm:4000', 'npm-proxy:4873'],
        max_budget_usd: '2',
        max_iterations: 30,
        max_duration_min: 60,
      });
    });

    it('C07: records key_issued with the cap and the budget that set it; never the key', async () => {
      const intent = await atG4(t, 'medium');
      await t.settle(intent);
      const result = await prepareRun(t.f.scope, deps(), intent.id);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const events = await t.f.scope.runEvents.list(result.run.runId);
      const issued = events.filter((e) => e.event_type === 'key_issued');
      expect(issued.map((e) => e.payload)).toEqual([{ max_budget_usd: '2', limited_by: 'run' }]);
      expect(JSON.stringify(events)).not.toMatch(/sk-virtual|key-/);
    });

    it('refuses when the proposal changed since G4 passed, or when a check fails', async () => {
      const intent = await atG4(t, 'medium');
      await t.settle(intent);
      t.world.base = BASE_2;
      expect(await prepareRun(t.f.scope, deps(), intent.id)).toEqual({
        ok: false,
        reason: 'not_decided',
      });
      t.world.models = [];
      expect(await prepareRun(t.f.scope, deps(), intent.id)).toEqual({
        ok: false,
        reason: 'not_ready',
      });
      expect(calls.keys).toEqual([]);
    });

    it('HITL: the run is triggered by the approver', async () => {
      const intent = await atG4(t, 'high');
      await t.settle(intent);
      await t.decide(await t.reload(intent), 'approve', 'a');
      const result = await prepareRun(t.f.scope, deps(), intent.id);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const run = (await t.f.scope.runs.getById(result.run.runId))!;
      expect(run.triggered_by).toBe(t.f.users.a);
      const contract = (await t.f.scope.runContracts.getByRunId(run.id))!.contract_json;
      expect(contract).toMatchObject({ autonomy_level: 'L1' });
    });

    it('a used-up budget cancels the run (budget_exceeded)', async () => {
      const intent = await atG4(t, 'medium');
      await t.settle(intent);
      refuseKey = new CostError('tenant_budget_exhausted', 'used up');
      expect(await prepareRun(t.f.scope, deps(), intent.id)).toEqual({
        ok: false,
        reason: 'budget_exceeded',
      });
      const [run] = await t.f.scope.runs.listForIntent(intent.id);
      expect(run).toMatchObject({ status: 'cancelled', stop_reason: 'budget_exceeded' });
    });

    it('FR-36: an overdue recertification warns the owner and does not block the run', async () => {
      const stale = await seedAgent(t.f.scope, t.f.users.gov, {
        model: MODEL,
        instructionsSha256: sha256(AGENTS_MD),
        tools: ['file_editor'],
        activatedAt: T0,
      });
      await t.setConfig(`run:\n  agent_key: ${stale.key}\n`);
      const intent = await atG4(t, 'medium');
      await t.settle(intent);
      // Four months after the first activation (the certification date).
      t.setClock(new Date(T0.getTime() + 125 * 24 * HOUR));
      const result = await prepareRun(t.f.scope, deps(), intent.id);
      expect(result).toMatchObject({ ok: true, run: { warnings: ['recertification_overdue'] } });
      if (!result.ok) return;
      const events = await t.f.scope.audit.listForEntity(stale.id, [
        'agent.recertification_overdue',
      ]);
      expect(events.map((e) => e.payload)).toEqual([
        { agent_key: stale.key, run_id: result.run.runId },
      ]);
      const notice = (await t.f.scope.intentNotices.listForIntent(intent.id)).find(
        (n) => n.kind === 'agent_recertification_due',
      );
      expect(notice).toMatchObject({ agent_id: stale.id, audience_roles: [] });
      await flush(t);
      const posted = t.f.posted(intent).find((b) => b.includes('recertification is overdue'));
      // The owner (Gina) is mentioned, read when the comment is posted.
      expect(posted).toContain('@gina');
      expect(posted).toContain(`\`${stale.key}\``);
    });
  });
});
