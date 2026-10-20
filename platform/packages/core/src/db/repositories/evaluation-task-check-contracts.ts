// Contracts of the checks of a project's evaluation tasks (task L07, design/ADR-M85 §2.5; D-05
// §6.10; migration 0034). A contract is stored once per card and attempt, never changed (SELECT
// and INSERT only). The column is read back for the stored values (hash, signature, key version),
// never for the signed text.
import type { TaskCheckContract } from '@sdlc/contracts';

import type { EvaluationTaskCheckContractRow } from '../schema.js';
import { isUuid } from '../tenant-id.js';
import { TenantRepository } from './base.js';

const SHA256 = /^[0-9a-f]{64}$/;

export interface StoreTaskCheckContract {
  readonly contract: TaskCheckContract;
  readonly contractSha256: string;
  readonly signature: string;
  readonly keyVersion: number;
}

export class EvaluationTaskCheckContractRepository extends TenantRepository {
  /** Stores the contract of one check attempt; the database refuses a second one. */
  async store(input: StoreTaskCheckContract): Promise<EvaluationTaskCheckContractRow> {
    const { contract } = input;
    return this.run(
      this.db
        .insertInto('evaluation_task_check_contracts')
        .values({
          tenant_id: this.tenantId,
          evaluation_task_id: contract.evaluation_task_id,
          card_sha256: contract.card_sha256,
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

  /** The contract of one attempt of a card's check, or undefined. */
  get(
    evaluationTaskId: string,
    cardSha256: string,
    attempt: number,
  ): Promise<EvaluationTaskCheckContractRow | undefined> {
    if (!isUuid(evaluationTaskId) || !SHA256.test(cardSha256)) return Promise.resolve(undefined);
    return this.run(
      this.db
        .selectFrom('evaluation_task_check_contracts')
        .selectAll()
        .where('tenant_id', '=', this.tenantId)
        .where('evaluation_task_id', '=', evaluationTaskId)
        .where('card_sha256', '=', cardSha256)
        .where('attempt', '=', attempt)
        .executeTakeFirst(),
    );
  }
}
