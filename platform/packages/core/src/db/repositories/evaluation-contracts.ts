// Contracts of evaluation runs (task L04, design/ADR-M81 §2.2; D-05 §6.8; migration 0030). A
// contract is stored once per attempt and never changed (SELECT and INSERT only). The signed bytes
// are the RFC 8785 canonical JSON of the contract; the column is read back for the stored values
// (hash, signature, key version), never for the signed text.
import type { EvaluationRunContract } from '@sdlc/contracts';

import type { EvaluationRunContractRow } from '../schema.js';
import { isUuid } from '../tenant-id.js';
import { TenantRepository } from './base.js';

export interface StoreEvaluationContract {
  readonly contract: EvaluationRunContract;
  readonly contractSha256: string;
  readonly signature: string;
  readonly keyVersion: number;
}

export class EvaluationContractRepository extends TenantRepository {
  /** Stores the contract of the run's current attempt; the database refuses a second one. */
  async store(input: StoreEvaluationContract): Promise<EvaluationRunContractRow> {
    const { contract } = input;
    return this.run(
      this.db
        .insertInto('evaluation_run_contracts')
        .values({
          tenant_id: this.tenantId,
          evaluation_run_id: contract.evaluation_run_id,
          attempt: contract.attempt,
          contract_json: JSON.stringify(contract),
          contract_sha256: input.contractSha256,
          signature: input.signature,
          key_version: input.keyVersion,
          issued_at: new Date(contract.issued_at),
          expires_at: new Date(contract.expires_at),
        })
        .returningAll()
        .executeTakeFirstOrThrow(),
    );
  }

  /** The contract of one attempt, or undefined. */
  getForAttempt(
    evaluationRunId: string,
    attempt: number,
  ): Promise<EvaluationRunContractRow | undefined> {
    if (!isUuid(evaluationRunId)) return Promise.resolve(undefined);
    return this.run(
      this.db
        .selectFrom('evaluation_run_contracts')
        .selectAll()
        .where('tenant_id', '=', this.tenantId)
        .where('evaluation_run_id', '=', evaluationRunId)
        .where('attempt', '=', attempt)
        .executeTakeFirst(),
    );
  }
}
