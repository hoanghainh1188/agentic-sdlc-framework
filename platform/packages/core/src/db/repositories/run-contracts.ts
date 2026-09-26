// Run Contracts (design/D-03 section 8, D-05 section 6.4, D-08 C02, ADR-M22). A contract is
// stored once, together with its run, and never changed (SELECT and INSERT only).
import type { RunContract } from '@sdlc/contracts';
import { sql, type Kysely } from 'kysely';

import { RunContractError } from '../../run-contract/errors.js';
import type { Database, Run, RunContractRow } from '../schema.js';
import { isUuid } from '../tenant-id.js';
import { AuditLogRepository } from './audit-log.js';
import { TenantRepository } from './base.js';
import { lockIntent } from './locks.js';
import { latestPlan } from './plans.js';
import { RunEventRepository } from './run-events.js';

export interface StoreRunContract {
  readonly contract: RunContract;
  readonly contractSha256: string;
  readonly signature: string;
  readonly keyVersion: number;
  /** The G3/G4 approver who allowed the run (D-05 `runs.triggered_by`); null for the system. */
  readonly triggeredBy: string | null;
}

export interface StoredRunContract {
  readonly run: Run;
  readonly contract: RunContractRow;
}

export class RunContractRepository extends TenantRepository {
  /**
   * Creates the run (status `queued`, next attempt of the intent) and stores its signed contract.
   * In the same transaction: the run event `contract_issued` and the audit event
   * `run.contract_issued`. Refuses the contract when its plan is no longer the intent's latest.
   * Use `issueRunContract`, which builds and signs the contract first.
   */
  async store(input: StoreRunContract): Promise<StoredRunContract> {
    const { contract } = input;
    return this.run(
      this.transactional(async (db) => {
        await lockIntent(db, contract.intent_id);
        const plan = await latestPlan(db, this.tenantId, contract.intent_id);
        if (plan?.id !== contract.plan_id || plan.plan_sha256 !== contract.plan_sha256) {
          throw new RunContractError(
            'plan_not_latest',
            `plan ${contract.plan_id} is not the latest plan of intent ${contract.intent_id}`,
          );
        }
        const attempt = (await this.lastAttempt(db, contract.intent_id)) + 1;
        const run = await db
          .insertInto('runs')
          .values({
            id: contract.run_id,
            tenant_id: this.tenantId,
            intent_id: contract.intent_id,
            plan_id: contract.plan_id,
            attempt,
            agent_id: contract.agent_id,
            agent_version: contract.agent_version,
            branch: contract.branch,
            base_sha: contract.base_sha,
            triggered_by: input.triggeredBy,
          })
          .returningAll()
          .executeTakeFirstOrThrow();
        const row = await db
          .insertInto('run_contracts')
          .values({
            run_id: contract.run_id,
            tenant_id: this.tenantId,
            // jsonb normalises key order whatever text is sent; readers recompute the signed bytes
            // with `runContractBytes` (RFC 8785), never from this column's text.
            contract_json: JSON.stringify(contract),
            contract_sha256: input.contractSha256,
            signature: input.signature,
            key_version: input.keyVersion,
            issued_at: new Date(contract.issued_at),
            expires_at: new Date(contract.expires_at),
          })
          .returningAll()
          .executeTakeFirstOrThrow();
        await new RunEventRepository(db, this.tenantId).append(run.id, 'contract_issued', {
          contract_sha256: input.contractSha256,
          key_version: input.keyVersion,
        });
        await new AuditLogRepository(db, this.tenantId).append({
          action: 'run.contract_issued',
          actorType: 'system',
          actorId: null,
          entityId: run.id,
          payload: {
            intent_id: run.intent_id,
            attempt: run.attempt,
            contract_sha256: input.contractSha256,
            key_version: input.keyVersion,
          },
        });
        return { run, contract: row };
      }),
    );
  }

  getByRunId(runId: string): Promise<RunContractRow | undefined> {
    if (!isUuid(runId)) return Promise.resolve(undefined);
    return this.run(
      this.db
        .selectFrom('run_contracts')
        .selectAll()
        .where('tenant_id', '=', this.tenantId)
        .where('run_id', '=', runId)
        .executeTakeFirst(),
    );
  }

  private async lastAttempt(db: Kysely<Database>, intentId: string): Promise<number> {
    const last = await db
      .selectFrom('runs')
      .select(sql<number | null>`max(attempt)`.as('attempt'))
      .where('tenant_id', '=', this.tenantId)
      .where('intent_id', '=', intentId)
      .executeTakeFirst();
    return last?.attempt ?? 0;
  }
}
