// D-08 L04 (PR 4a) on a live PostgreSQL (design/ADR-M81 §2.2, §2.4; QUESTIONS #460, #462):
// - the contract of an evaluation run is issued for a queued run, capped at what is left of the
//   evaluation's budget, signed in the same form as the Run Contract, stored once per attempt and
//   never changed;
// - the runner's check refuses a contract that is forged, unknown, different from the stored one,
//   expired, early, revoked, or for a run that is not queued on that attempt;
// - the virtual key carries the seven labels (`intent_id` = the evaluation code, `gate` = EVAL),
//   is capped by the smallest of the contract, the budget that is left and the tenant's month;
// - the spend sync records an evaluation run's calls with `evaluation_run_id`, never with an
//   intent, and refuses calls whose labels do not match.
import crypto from 'node:crypto';

import { createSimplePolicyEngine } from '@sdlc/adapter-policy-simple';
import type {
  CreateRunKey,
  EvaluationContractEnvelope,
  ModelGateway,
  ModelRef,
  RunContractSigner,
  RunContractVerifier,
  SpendRecord,
  TenantBudget,
  VirtualKey,
} from '@sdlc/contracts';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { CostController, CostError } from '../../../packages/core/src/cost/index.js';
import { DbError } from '../../../packages/core/src/db/errors.js';
import type { TenantScope } from '../../../packages/core/src/db/tenant-scope.js';
import { parseTenantId } from '../../../packages/core/src/db/tenant-id.js';
import {
  EvaluationContractError,
  evaluationContractBytes,
  issueEvaluationContract,
  startEvaluation,
  verifyEvaluationContract,
  type EvaluationContractErrorCode,
} from '../../../packages/core/src/evaluation/index.js';
import { createTestDatabase, describeDb, type TestDatabase } from './helpers.js';

const NOW = new Date('2026-10-14T08:00:00.000Z');
const MIN = 60_000;
const MODEL = 'gpt-oss-20b';
const EGRESS = ['litellm:4000', 'npm-proxy:4873'];
const CONFIGURATION = {
  id: 'gpt-oss-20b',
  model: MODEL,
  providerType: 'self_hosted',
  agentVersion: '1.0.0',
  maxIterations: 30,
  maxDurationMin: 20,
} as const;

/** Signs with random bytes and remembers what it signed; the verifier accepts only that pair. */
class FakeTransit implements RunContractSigner, RunContractVerifier {
  readonly signed = new Map<string, string>();
  sign(bytes: Uint8Array) {
    const signature = `vault:v1:${crypto.randomBytes(48).toString('base64')}`;
    this.signed.set(Buffer.from(bytes).toString('hex'), signature);
    return Promise.resolve({ signature, keyVersion: 1 });
  }
  publicKey() {
    return Promise.reject(new Error('not used'));
  }
  verify(bytes: Uint8Array, signature: string) {
    return Promise.resolve(this.signed.get(Buffer.from(bytes).toString('hex')) === signature);
  }
}

class FakeGateway implements ModelGateway {
  readonly keys: CreateRunKey[] = [];
  spend: SpendRecord[] = [];
  readonly models: ModelRef[] = [{ model: MODEL, providerType: 'self_hosted' }];
  ensureTenantBudget(input: TenantBudget) {
    return Promise.resolve({ tenantGroupId: `sdlc-tenant-${input.tenantSlug}` });
  }
  createRunKey(input: CreateRunKey): Promise<VirtualKey> {
    this.keys.push(input);
    return Promise.resolve({
      keyId: 'f'.repeat(64),
      key: { reveal: () => 'sk-virtual' },
      expiresAt: new Date(NOW.getTime() + input.durationMinutes * MIN),
    });
  }
  revokeKey() {
    return Promise.resolve();
  }
  revokeRunKey() {
    return Promise.resolve();
  }
  getSpend() {
    return Promise.resolve({ spendUsd: '0', maxBudgetUsd: null });
  }
  listModels() {
    return Promise.resolve(this.models);
  }
  listSpend() {
    return Promise.resolve({ records: this.spend, unreadable: 0 });
  }
}

describeDb('L04 PR 4a: the evaluation contract, key and spend on PostgreSQL', () => {
  let db: TestDatabase;
  let tenants = 0;
  const transit = new FakeTransit();
  const gateway = new FakeGateway();

  beforeAll(async () => {
    db = await createTestDatabase();
  }, 60_000);
  afterAll(async () => {
    await db?.drop();
  });

  interface World {
    scope: TenantScope;
    slug: string;
    projectId: string;
    controller: CostController;
  }

  /** A tenant with the project `shop` and one evaluation of two runs (one task, 2 run numbers). */
  async function world(
    options: { monthly?: string | null; budget?: string } = {},
  ): Promise<World & { evaluationId: string; runs: string[]; code: string }> {
    const slug = `ev-${String(++tenants)}`;
    const tenant = await db.app.system.createTenant({
      slug,
      name: slug,
      monthlyBudgetUsd: options.monthly === undefined ? '100' : options.monthly,
    });
    const scope = db.app.forTenant(parseTenantId(tenant.id));
    const project = await scope.projects.create({
      slug: 'shop',
      name: 'Shop',
      git_provider: 'github',
      repo_full_name: 'org/pilot-order-inventory',
    });
    const user = await scope.users.create({ display_name: 'pam', email: `pam@${slug}.test` });
    await scope.projectAiRecords.save(project.id, {
      aiAllowed: 'yes',
      allowedDataClasses: ['internal', 'client_restricted'],
      prodLogsAllowed: 'no',
      disclosureFormat: 'standard_note',
      confirmedAt: null,
      recordRef: null,
      updatedBy: user.id,
      expectedVersion: 0,
      actorType: 'human',
      today: '2026-10-14',
    });
    const evaluation = await startEvaluation(
      scope,
      {
        projectId: project.id,
        dataClass: 'internal',
        taskSetVersion: 1,
        configName: 'local',
        baseSha: '7d5341d'.padEnd(40, '0'),
        taskIds: ['feat-tax'],
        configurations: [CONFIGURATION],
        runsPerTask: 2,
        budgetUsd: options.budget ?? '1',
        startedBy: null,
        now: NOW,
      },
      { policyFactory: (config, models) => createSimplePolicyEngine({ config, models }) },
    );
    const runs = (await scope.evaluationRuns.listForEvaluation(evaluation.id)).map((r) => r.id);
    const controller = new CostController({ gateway, db: db.app, now: () => NOW });
    return {
      scope,
      slug,
      projectId: project.id,
      controller,
      evaluationId: evaluation.id,
      runs,
      code: evaluation.code,
    };
  }

  const issue = (w: World, runId: string, now = NOW) =>
    issueEvaluationContract(
      w.scope,
      { evaluationRunId: runId, egressAllowlist: EGRESS },
      { signer: transit, now: () => now },
    );
  const code = async (promise: Promise<unknown>): Promise<EvaluationContractErrorCode> => {
    const error = await promise.then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(EvaluationContractError);
    return (error as EvaluationContractError).code;
  };
  const verify = (envelope: unknown, now = NOW) =>
    verifyEvaluationContract(db.app, envelope, { verifier: transit, now: () => now });

  describe('issuing the contract', () => {
    it('signs a contract for the queued run, capped at what is left of the budget', async () => {
      const w = await world({ budget: '1' });
      const issued = await issue(w, w.runs[0]!);
      expect(issued.envelope.contract).toMatchObject({
        kind: 'evaluation',
        evaluation_code: w.code,
        evaluation_run_id: w.runs[0],
        repo: 'org/pilot-order-inventory',
        base_sha: '7d5341d'.padEnd(40, '0'),
        configuration_id: 'gpt-oss-20b',
        task_id: 'feat-tax',
        attempt: 1,
        model: MODEL,
        allowed_models: [MODEL],
        max_budget_usd: '1',
        max_iterations: 30,
        max_duration_min: 20,
        egress_allowlist: EGRESS,
      });
      expect(issued.envelope.contract).not.toHaveProperty('intent_id');
      expect(issued.envelope.contract).not.toHaveProperty('plan_id');
      const stored = await w.scope.evaluationContracts.getForAttempt(w.runs[0]!, 1);
      expect(stored).toMatchObject({
        contract_sha256: issued.contractSha256,
        signature: issued.envelope.signature,
        key_version: 1,
        revoked_at: null,
      });
      // The signed bytes are the canonical JSON of the contract.
      expect(
        transit.signed.has(
          Buffer.from(evaluationContractBytes(issued.envelope.contract)).toString('hex'),
        ),
      ).toBe(true);
    });

    it('is written once per attempt and never changed', async () => {
      const w = await world();
      await issue(w, w.runs[0]!);
      await expect(issue(w, w.runs[0]!)).rejects.toBeInstanceOf(DbError);
      await expect(
        sql`UPDATE evaluation_run_contracts SET revoked_at = now() WHERE evaluation_run_id = ${w.runs[0]!}`.execute(
          db.appRaw,
        ),
      ).rejects.toThrow();
      await expect(
        sql`DELETE FROM evaluation_run_contracts WHERE evaluation_run_id = ${w.runs[0]!}`.execute(
          db.appRaw,
        ),
      ).rejects.toThrow();
      await expect(
        sql`UPDATE evaluation_run_contracts SET contract_sha256 = ${'a'.repeat(64)} WHERE evaluation_run_id = ${w.runs[0]!}`.execute(
          db.owner,
        ),
      ).rejects.toThrow();
    });

    it('shrinks the cap with the spend, and refuses when the budget is used up', async () => {
      const w = await world({ budget: '1' });
      const record = (n: string, usd: string) =>
        w.scope.costRecords.insertIfNew({
          projectId: w.projectId,
          intentId: null,
          runId: null,
          gate: null,
          agent: null,
          model: MODEL,
          providerType: 'self_hosted',
          inputTokens: 1,
          outputTokens: 1,
          cachedInputTokens: 0,
          costUsd: usd,
          sourceRef: `used-${w.slug}-${n}`,
          occurredAt: NOW,
          evaluationRunId: w.runs[0]!,
        });
      await record('1', '0.7');
      expect((await issue(w, w.runs[1]!)).envelope.contract.max_budget_usd).toBe('0.3');
      await record('2', '0.3');
      expect(await code(issue(w, w.runs[0]!))).toBe('budget_used');
    });

    it('refuses an unknown run and a run that is not queued', async () => {
      const w = await world();
      expect(await code(issue(w, '99999999-9999-4999-8999-999999999999'))).toBe('run_not_found');
      await w.scope.evaluationRuns.claim(w.runs[0]!, 1, 'runner-1');
      expect(await code(issue(w, w.runs[0]!))).toBe('run_not_queued');
      await w.scope.evaluationRuns.cancelWaiting(w.evaluationId, 'cancelled_by_operator');
      expect(await code(issue(w, w.runs[1]!))).toBe('run_not_queued');
    });

    it('keeps tenants apart', async () => {
      const a = await world();
      const b = await world();
      expect(await code(issue(b, a.runs[0]!))).toBe('run_not_found');
    });
  });

  describe('the runner checks the contract', () => {
    it('accepts the issued contract and refuses a forged or changed one', async () => {
      const w = await world();
      const { envelope } = await issue(w, w.runs[0]!);
      expect(await verify(envelope)).toMatchObject({ ok: true });
      expect(await verify({ ...envelope, signature: `vault:v1:${'A'.repeat(20)}` })).toEqual({
        ok: false,
        reason: 'bad_signature',
      });
      const raised: EvaluationContractEnvelope = {
        ...envelope,
        contract: { ...envelope.contract, max_budget_usd: '99' },
      };
      expect(await verify(raised)).toEqual({ ok: false, reason: 'bad_signature' });
      expect(await verify({ contract: 'x', signature: 'y' })).toEqual({
        ok: false,
        reason: 'malformed',
      });
    });

    it('refuses an unknown contract: signed, but never stored', async () => {
      const w = await world();
      const { envelope } = await issue(w, w.runs[0]!);
      const other = { ...envelope.contract, attempt: 2 };
      const signed = await transit.sign(evaluationContractBytes(other));
      expect(await verify({ contract: other, signature: signed.signature })).toEqual({
        ok: false,
        reason: 'unknown_contract',
      });
    });

    it('refuses a contract that differs from the stored one', async () => {
      const w = await world();
      const { envelope } = await issue(w, w.runs[0]!);
      // A second valid signature of the same bytes is a different signature.
      const again = await transit.sign(evaluationContractBytes(envelope.contract));
      expect(await verify({ contract: envelope.contract, signature: again.signature })).toEqual({
        ok: false,
        reason: 'mismatch',
      });
    });

    it('checks the time window: early, expired', async () => {
      const w = await world();
      const { envelope } = await issue(w, w.runs[0]!);
      expect(await verify(envelope, new Date(NOW.getTime() - 10 * 60_000))).toEqual({
        ok: false,
        reason: 'not_yet_valid',
      });
      expect(await verify(envelope, new Date(Date.parse(envelope.contract.expires_at)))).toEqual({
        ok: false,
        reason: 'expired',
      });
    });

    it('is for the queued run on its attempt: claimed, preempted and queued again', async () => {
      const w = await world();
      const first = await issue(w, w.runs[0]!);
      expect(await w.scope.evaluationRuns.claim(w.runs[0]!, 2, 'runner-1')).toBe(false);
      expect(await w.scope.evaluationRuns.claim(w.runs[0]!, 1, 'runner-1')).toBe(true);
      expect(await w.scope.evaluationRuns.claim(w.runs[0]!, 1, 'runner-2')).toBe(false);
      expect(await verify(first.envelope)).toEqual({ ok: false, reason: 'run_not_startable' });
      expect((await w.scope.evaluations.getById(w.evaluationId))!.status).toBe('running');

      // A real run needs the slot: attempt 2 gets its own contract, attempt 1's is useless.
      await w.scope.evaluationRuns.markPreempted(w.runs[0]!);
      await w.scope.evaluationRuns.requeue(w.runs[0]!);
      expect(await verify(first.envelope)).toEqual({ ok: false, reason: 'run_not_startable' });
      const second = await issue(w, w.runs[0]!);
      expect(second.envelope.contract.attempt).toBe(2);
      expect(await verify(second.envelope)).toMatchObject({ ok: true });
    });
  });

  describe('the virtual key and the spend sync', () => {
    it('labels the key with the evaluation and caps it', async () => {
      const w = await world({ budget: '1' });
      await issue(w, w.runs[0]!);
      gateway.keys.length = 0;
      const issued = await w.controller.issueEvaluationRunKey({
        tenantId: w.scope.tenantId,
        evaluationRunId: w.runs[0]!,
      });
      expect(issued.labels).toEqual({
        tenant: w.slug,
        project: 'shop',
        intent_id: w.code,
        run_id: w.runs[0],
        gate: 'EVAL',
        agent: 'gpt-oss-20b',
        data_class: 'internal',
      });
      expect(issued).toMatchObject({ maxBudgetUsd: '1', limitedBy: 'run' });
      expect(gateway.keys[0]).toMatchObject({
        runId: w.runs[0],
        models: [MODEL],
        maxBudgetUsd: '1',
      });
    });

    it('caps the key at what is left of the evaluation or of the tenant, and refuses a missing contract', async () => {
      const w = await world({ budget: '1', monthly: '0.2' });
      await issue(w, w.runs[0]!);
      expect(
        await w.controller.issueEvaluationRunKey({
          tenantId: w.scope.tenantId,
          evaluationRunId: w.runs[0]!,
        }),
      ).toMatchObject({ maxBudgetUsd: '0.2', limitedBy: 'tenant' });
      await expect(
        w.controller.issueEvaluationRunKey({
          tenantId: w.scope.tenantId,
          evaluationRunId: w.runs[1]!,
        }),
      ).rejects.toBeInstanceOf(CostError);
    });

    it('records the calls of an evaluation run with the run, never with an intent', async () => {
      const w = await world({ budget: '5' });
      await issue(w, w.runs[0]!);
      const call = (ref: string, over: Partial<SpendRecord['labels']> = {}): SpendRecord => ({
        sourceRef: ref,
        model: MODEL,
        status: 'success',
        inputTokens: 100,
        outputTokens: 20,
        cachedInputTokens: 0,
        costUsd: '0.0123',
        occurredAt: NOW,
        labels: {
          tenant: w.slug,
          project: 'shop',
          intent_id: w.code,
          run_id: w.runs[0]!,
          gate: 'EVAL',
          agent: 'gpt-oss-20b',
          data_class: 'internal',
          ...over,
        },
      });
      gateway.spend = [
        call(`ok-${w.slug}-1`),
        call(`ok-${w.slug}-2`),
        call(`wrong-code-${w.slug}`, { intent_id: 'EVAL-2026-9999' }),
        call(`wrong-project-${w.slug}`, { project: 'other' }),
        call(`unknown-run-${w.slug}`, { run_id: '99999999-9999-4999-8999-999999999999' }),
      ];
      const result = await w.controller.syncSpend({
        from: new Date(NOW.getTime() - MIN),
        to: new Date(NOW.getTime() + MIN),
      });
      expect(result).toMatchObject({
        seen: 5,
        inserted: 2,
        skipped: { label_mismatch: 2, unknown_run: 1 },
      });
      expect(
        await w.controller.syncSpend({
          from: new Date(NOW.getTime() - MIN),
          to: new Date(NOW.getTime() + MIN),
        }),
      ).toMatchObject({
        inserted: 0,
        duplicates: 2,
      });
      expect(await w.scope.costRecords.totalForEvaluation(w.evaluationId)).toBe('0.024600');
      const rows = await sql<{
        intent_id: string | null;
        run_id: string | null;
        gate: string | null;
        evaluation_run_id: string;
      }>`
        SELECT intent_id, run_id, gate, evaluation_run_id FROM cost_records WHERE tenant_id = ${w.scope.tenantId}`.execute(
        db.owner,
      );
      expect(rows.rows).toHaveLength(2);
      expect(
        rows.rows.every(
          (r) =>
            r.intent_id === null &&
            r.run_id === null &&
            r.gate === null &&
            r.evaluation_run_id === w.runs[0],
        ),
      ).toBe(true);
      // The evaluation's own spend, its budget and the cost report of intents.
      expect(await w.scope.evaluations.spentUsd(w.evaluationId)).toBe('0.0246');
      const totals = await w.scope.costRecords.reportTotals({
        from: new Date('2026-10-01T00:00:00Z'),
        to: new Date('2026-11-01T00:00:00Z'),
        wastedStatuses: ['failed'],
      });
      expect(totals.calls).toBe('0');
    });
  });
});
