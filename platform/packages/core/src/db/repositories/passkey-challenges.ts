// Passkey challenges (U06, migration 0028, design/ADR-M73 §2.4, QUESTIONS #411, #412). Only the
// challenge's SHA-256 is stored. A challenge is used once, before it expires, by one conditional
// update; rows are never deleted.
import type { GateCode } from '@sdlc/contracts';

import type { PasskeyChallenge, PasskeyChallengePurpose, TenantInsert } from '../schema.js';
import { TenantRepository } from './base.js';

/** What a used challenge must match exactly: the session, the person and the bound action. */
export interface ChallengeMatch {
  readonly userId: string;
  readonly sessionId: string;
  readonly purpose: PasskeyChallengePurpose;
  readonly challengeSha256: string;
  readonly action: string | null;
  readonly intentId: string | null;
  readonly escalationId: string | null;
  readonly gate: GateCode | null;
  readonly decision: string | null;
  readonly expectedInputSha256: string | null;
  readonly requestSha256: string | null;
}

export class PasskeyChallengeRepository extends TenantRepository {
  create(input: TenantInsert<'passkey_challenges'>): Promise<PasskeyChallenge> {
    return this.run(
      this.db
        .insertInto('passkey_challenges')
        .values({ ...input, tenant_id: this.tenantId })
        .returningAll()
        .executeTakeFirstOrThrow(),
    );
  }

  getById(id: string): Promise<PasskeyChallenge | undefined> {
    return this.run(
      this.db
        .selectFrom('passkey_challenges')
        .selectAll()
        .where('tenant_id', '=', this.tenantId)
        .where('id', '=', id)
        .executeTakeFirst(),
    );
  }

  /** Locks the session's row until the transaction ends (orders one session's requests). */
  async lockSession(sessionId: string): Promise<void> {
    await this.run(
      this.db
        .selectFrom('web_sessions')
        .select('id')
        .where('tenant_id', '=', this.tenantId)
        .where('id', '=', sessionId)
        .forUpdate()
        .execute(),
    );
  }

  /** Challenges of a session that are neither used nor expired. */
  async countOpen(sessionId: string, now: Date): Promise<number> {
    const row = await this.run(
      this.db
        .selectFrom('passkey_challenges')
        .select((eb) => eb.fn.countAll<string>().as('count'))
        .where('tenant_id', '=', this.tenantId)
        .where('session_id', '=', sessionId)
        .where('used_at', 'is', null)
        .where('expires_at', '>', now)
        .executeTakeFirstOrThrow(),
    );
    return Number(row.count);
  }

  /**
   * Uses a challenge: one conditional update, so of two concurrent uses only one wins. True when
   * this call used it: the challenge was open, not expired, and matched in every bound column.
   */
  async use(id: string, match: ChallengeMatch, now: Date): Promise<boolean> {
    const result = await this.run(
      this.db
        .updateTable('passkey_challenges')
        .set({ used_at: now })
        .where('tenant_id', '=', this.tenantId)
        .where('id', '=', id)
        .where('used_at', 'is', null)
        .where('expires_at', '>', now)
        .where('user_id', '=', match.userId)
        .where('session_id', '=', match.sessionId)
        .where('purpose', '=', match.purpose)
        .where('challenge_sha256', '=', match.challengeSha256)
        .where('action', 'is not distinct from', match.action)
        .where('intent_id', 'is not distinct from', match.intentId)
        .where('escalation_id', 'is not distinct from', match.escalationId)
        .where('gate', 'is not distinct from', match.gate)
        .where('decision', 'is not distinct from', match.decision)
        .where('expected_input_sha256', 'is not distinct from', match.expectedInputSha256)
        .where('request_sha256', 'is not distinct from', match.requestSha256)
        .executeTakeFirst(),
    );
    return Number(result.numUpdatedRows) === 1;
  }
}
