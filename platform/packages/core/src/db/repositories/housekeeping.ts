// Housekeeping of the dashboard's session tables (task O04, migration 0046, design/ADR-M103; D-05
// §6.1). Ended web sessions and used or expired passkey challenges are removed after a fixed time,
// only through the definer functions of migration 0046: `platform_app` has no DELETE on either
// table. Each call is a fragment without a table reference, so it passes the tenant guard; the
// function itself removes only this tenant's rows. The counts use the same conditions.
import { sql } from 'kysely';

import { TenantRepository } from './base.js';

export interface HousekeepingCutoffs {
  /** Sessions that ended (signed out or expired) before this time. */
  readonly sessionsBefore: Date;
  /** Challenges used, or expired unused, before this time. */
  readonly challengesBefore: Date;
}

export interface HousekeepingCounts {
  readonly sessions: number;
  readonly challenges: number;
}

export class HousekeepingRepository extends TenantRepository {
  /** What `remove` would remove now, without removing it (mode `report`). */
  async count(cut: HousekeepingCutoffs): Promise<HousekeepingCounts> {
    const challenges = await this.run(
      this.db
        .selectFrom('passkey_challenges')
        .select((eb) => eb.fn.countAll<string>().as('n'))
        .where('tenant_id', '=', this.tenantId)
        .where(sql<boolean>`COALESCE(used_at, expires_at) < ${cut.challengesBefore}`)
        .executeTakeFirstOrThrow(),
    );
    const sessions = await this.run(
      this.db
        .selectFrom('web_sessions as s')
        .select((eb) => eb.fn.countAll<string>().as('n'))
        .where('s.tenant_id', '=', this.tenantId)
        .where(sql<boolean>`LEAST(s.revoked_at, s.expires_at) < ${cut.sessionsBefore}`)
        // A session goes only when none of its challenges stays after the challenges' removal.
        .where((eb) =>
          eb.not(
            eb.exists(
              eb
                .selectFrom('passkey_challenges as c')
                .select('c.id')
                .where('c.tenant_id', '=', this.tenantId)
                .whereRef('c.session_id', '=', 's.id')
                .where(sql<boolean>`COALESCE(c.used_at, c.expires_at) >= ${cut.challengesBefore}`),
            ),
          ),
        )
        .executeTakeFirstOrThrow(),
    );
    return { sessions: Number(sessions.n), challenges: Number(challenges.n) };
  }

  /** Removes the old rows of this tenant: challenges first, then the sessions none still needs. */
  remove(cut: HousekeepingCutoffs): Promise<HousekeepingCounts> {
    return this.transactional(async (db) => {
      const challenges = await this.run(
        db
          .selectNoFrom(
            sql<number>`housekeeping_remove_passkey_challenges(${this.tenantId}::uuid, ${cut.challengesBefore}::timestamptz)`.as(
              'removed',
            ),
          )
          .executeTakeFirstOrThrow(),
      );
      const sessions = await this.run(
        db
          .selectNoFrom(
            sql<number>`housekeeping_remove_web_sessions(${this.tenantId}::uuid, ${cut.sessionsBefore}::timestamptz)`.as(
              'removed',
            ),
          )
          .executeTakeFirstOrThrow(),
      );
      return { sessions: Number(sessions.removed), challenges: Number(challenges.removed) };
    });
  }
}
