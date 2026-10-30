// D-08 O04 AC2, AC4 on a live PostgreSQL (design/ADR-M103; D-05 §6.1): ended web sessions and used
// or expired passkey challenges are removed after a fixed time, by the definer functions of
// migration 0046 only. The cutoffs never go below their floors (7 days, 1 hour); open and recent
// rows stay; each tenant is removed on its own, with one `housekeeping.removed` event of counts.
// A DELETE outside the functions is refused for platform_app (no grant) and for the owner
// (trigger SDA01).
import { randomBytes } from 'node:crypto';

import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { bootstrapTenant } from '../../../packages/core/src/admin/bootstrap.js';
import { parseTenantId, type TenantId } from '../../../packages/core/src/db/tenant-id.js';
import { APPEND_ONLY_TABLES, SQL_TABLE_SIZES } from '../../../deploy/doctor/src/commands.js';
import { parseTableSizes } from '../../../deploy/doctor/src/host.js';
import { createJsonLogger } from '../../../packages/core/src/observability/index.js';
import { runHousekeepingPass } from '../../../packages/core/src/retention/housekeeping.js';
import { createTestDatabase, describeDb, type TestDatabase } from './helpers.js';

const NOW = new Date('2026-10-31T12:00:00.000Z');
const DAY = 86_400_000;
const HOUR = 3_600_000;
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const hex = () => randomBytes(32).toString('hex');

interface Person {
  readonly tenantId: TenantId;
  readonly userId: string;
  readonly identityId: string;
}

describeDb('housekeeping: sessions and challenges (O04, migration 0046)', () => {
  let db: TestDatabase;
  let a: Person;
  let b: Person;
  const logger = createJsonLogger({ write: () => undefined });

  let githubId = 9_100_001;

  async function person(slug: string): Promise<Person> {
    const boot = await bootstrapTenant(db.app, {
      tenantSlug: slug,
      tenantName: slug,
      adminEmail: `${slug}@example.test`,
      adminName: slug,
    });
    const { rows } = await sql<{ id: string }>`
      INSERT INTO user_identities (tenant_id, user_id, provider, external_id, external_login)
      VALUES (${boot.tenant.id}, ${boot.user.id}, 'github', ${String(githubId++)}, ${slug}) RETURNING id`.execute(
      db.owner,
    );
    return {
      tenantId: parseTenantId(boot.tenant.id),
      userId: boot.user.id,
      identityId: rows[0]!.id,
    };
  }

  /** A session created at `created`, ending at `revokedAt` (or open) and expiring at `expires`. */
  async function session(
    p: Person,
    created: Date,
    expires: Date,
    revokedAt?: Date,
  ): Promise<string> {
    const { rows } = await sql<{ id: string }>`
      INSERT INTO web_sessions (tenant_id, user_id, identity_id, secret_sha256, last_seen_at,
        expires_at, revoked_at, end_reason, created_at)
      VALUES (${p.tenantId}, ${p.userId}, ${p.identityId}, ${hex()}, ${created}, ${expires},
        ${revokedAt ?? null}, ${revokedAt ? 'sign_out' : null}, ${created}) RETURNING id`.execute(
      db.owner,
    );
    return rows[0]!.id;
  }

  async function challenge(
    p: Person,
    sessionId: string,
    created: Date,
    used?: Date,
  ): Promise<string> {
    const { rows } = await sql<{ id: string }>`
      INSERT INTO passkey_challenges (tenant_id, user_id, session_id, purpose, challenge_sha256,
        expires_at, used_at, created_at)
      VALUES (${p.tenantId}, ${p.userId}, ${sessionId}, 'register', ${hex()},
        ${new Date(created.getTime() + 5 * 60_000)}, ${used ?? null}, ${created}) RETURNING id`.execute(
      db.owner,
    );
    return rows[0]!.id;
  }

  const ids = async (table: 'web_sessions' | 'passkey_challenges'): Promise<string[]> =>
    (
      await sql<{ id: string }>`SELECT id FROM ${sql.table(table)} ORDER BY id`.execute(db.owner)
    ).rows.map((r) => r.id);

  const settings = (mode: 'report' | 'remove') => ({ mode, sessionDays: 30, challengeHours: 24 });

  beforeAll(async () => {
    db = await createTestDatabase();
    a = await person('house-a');
    b = await person('house-b');
  });
  afterAll(async () => {
    await db?.drop();
  });

  describe('the rows', () => {
    const kept: string[] = [];
    const gone: string[] = [];
    const keptChallenges: string[] = [];
    const goneChallenges: string[] = [];

    beforeAll(async () => {
      // Session ended (signed out) 40 days ago: removed, with its old challenges.
      const ended = await session(a, ago(41 * DAY), ago(30 * DAY), ago(40 * DAY));
      gone.push(ended);
      goneChallenges.push(await challenge(a, ended, ago(41 * DAY), ago(41 * DAY)));
      // Session that expired 31 days ago without a sign-out: removed.
      gone.push(await session(a, ago(32 * DAY), ago(31 * DAY)));
      // Ended 10 days ago: kept (30 days).
      kept.push(await session(a, ago(11 * DAY), ago(5 * DAY), ago(10 * DAY)));
      // Open: kept, whatever its age; its old challenges go, a recent one stays.
      const open = await session(a, ago(60 * DAY), new Date(NOW.getTime() + DAY));
      kept.push(open);
      goneChallenges.push(await challenge(a, open, ago(3 * DAY), ago(3 * DAY)));
      goneChallenges.push(await challenge(a, open, ago(2 * DAY)));
      keptChallenges.push(await challenge(a, open, ago(2 * HOUR), ago(2 * HOUR)));
      // An old ended session that still has a recent challenge: kept until the challenge goes.
      const blocked = await session(a, ago(45 * DAY), ago(40 * DAY), ago(44 * DAY));
      kept.push(blocked);
      keptChallenges.push(await challenge(a, blocked, ago(HOUR)));
      // Tenant B: an old ended session, counted for B only.
      gone.push(await session(b, ago(50 * DAY), ago(45 * DAY), ago(49 * DAY)));
    });

    it('report mode counts per tenant and removes nothing', async () => {
      const before = await ids('web_sessions');
      const result = await runHousekeepingPass({
        db: db.app,
        logger,
        now: () => NOW,
        settings: settings('report'),
      });
      expect(result).toEqual({ tenants: 2, sessions: 3, challenges: 3, failed: 0 });
      expect(await ids('web_sessions')).toEqual(before);
    });

    it('remove mode removes exactly the old rows, challenges before their session', async () => {
      const result = await runHousekeepingPass({
        db: db.app,
        logger,
        now: () => NOW,
        settings: settings('remove'),
      });
      expect(result).toEqual({ tenants: 2, sessions: 3, challenges: 3, failed: 0 });
      expect(await ids('web_sessions')).toEqual([...kept].sort());
      expect(await ids('passkey_challenges')).toEqual([...keptChallenges].sort());
    });

    it('one housekeeping.removed per tenant with removals, counts only', async () => {
      const rowsA = await db.app
        .forTenant(a.tenantId)
        .audit.listForEntity(a.tenantId, ['housekeeping.removed']);
      const rowsB = await db.app
        .forTenant(b.tenantId)
        .audit.listForEntity(b.tenantId, ['housekeeping.removed']);
      expect(rowsA.map((r) => r.payload)).toEqual([{ sessions: 2, challenges: 3 }]);
      expect(rowsB.map((r) => r.payload)).toEqual([{ sessions: 1, challenges: 0 }]);
      expect((await db.app.forTenant(a.tenantId).audit.verify()).broken).toBeUndefined();
    });

    it('a second pass finds nothing and writes no event', async () => {
      const result = await runHousekeepingPass({
        db: db.app,
        logger,
        now: () => NOW,
        settings: settings('remove'),
      });
      expect(result).toEqual({ tenants: 2, sessions: 0, challenges: 0, failed: 0 });
      const rows = await db.app
        .forTenant(a.tenantId)
        .audit.listForEntity(a.tenantId, ['housekeeping.removed']);
      expect(rows).toHaveLength(1);
    });
  });

  describe('the guards', () => {
    it('platform_app has no DELETE; the owner is refused outside the functions (SDA01)', async () => {
      await expect(sql`DELETE FROM web_sessions`.execute(db.appRaw)).rejects.toThrow(
        /permission denied/,
      );
      await expect(sql`DELETE FROM passkey_challenges`.execute(db.appRaw)).rejects.toThrow(
        /permission denied/,
      );
      await expect(sql`DELETE FROM web_sessions`.execute(db.owner)).rejects.toMatchObject({
        code: 'SDA01',
      });
      await expect(sql`DELETE FROM passkey_challenges`.execute(db.owner)).rejects.toMatchObject({
        code: 'SDA01',
      });
    });

    it('the guard closes when the function returns: a later DELETE in the same transaction is refused', async () => {
      const old = new Date(Date.now() - 40 * DAY);
      await expect(
        db.owner.transaction().execute(async (tx) => {
          await sql`SELECT housekeeping_remove_web_sessions(${a.tenantId}, ${old})`.execute(tx);
          await sql`DELETE FROM web_sessions`.execute(tx);
        }),
      ).rejects.toMatchObject({ code: 'SDA01' });
    });

    it('the trigger keeps its own floor: an open guard still refuses a session ended a day ago (SDA27)', async () => {
      const real = new Date();
      const recent = await session(
        a,
        new Date(real.getTime() - 3 * DAY),
        new Date(real.getTime() - 2 * DAY),
        new Date(real.getTime() - DAY),
      );
      await expect(
        db.owner.transaction().execute(async (tx) => {
          await sql`SELECT set_config('sdlc.housekeeping', 'on', true)`.execute(tx);
          await sql`DELETE FROM web_sessions WHERE id = ${recent}`.execute(tx);
        }),
      ).rejects.toMatchObject({ code: 'SDA27' });
      const fresh = await challenge(a, recent, new Date(real.getTime() - 20 * 60_000));
      await expect(
        db.owner.transaction().execute(async (tx) => {
          await sql`SELECT set_config('sdlc.housekeeping', 'on', true)`.execute(tx);
          await sql`DELETE FROM passkey_challenges WHERE id = ${fresh}`.execute(tx);
        }),
      ).rejects.toMatchObject({ code: 'SDA27' });
    });

    it("one tenant's call never touches another tenant's old rows", async () => {
      const real = Date.now();
      const oldA = await session(
        a,
        new Date(real - 60 * DAY),
        new Date(real - 50 * DAY),
        new Date(real - 55 * DAY),
      );
      const oldB = await session(
        b,
        new Date(real - 60 * DAY),
        new Date(real - 50 * DAY),
        new Date(real - 55 * DAY),
      );
      const cutoff = new Date(real - 30 * DAY);
      await sql`SELECT housekeeping_remove_web_sessions(${a.tenantId}, ${cutoff})`.execute(
        db.appRaw,
      );
      const left = await ids('web_sessions');
      expect(left).not.toContain(oldA);
      expect(left).toContain(oldB);
    });

    it("doctor's size query runs read-only on PostgreSQL and lists every append-only table", async () => {
      const result = await db.owner.transaction().execute(async (tx) => {
        await sql`SET TRANSACTION READ ONLY`.execute(tx);
        return sql<{ sizes: unknown }>`${sql.raw(SQL_TABLE_SIZES)}`.execute(tx);
      });
      const sizes = parseTableSizes(JSON.stringify(Object.values(result.rows[0]!)[0]));
      expect(sizes?.map((t) => t.table).sort()).toEqual([...APPEND_ONLY_TABLES].sort());
      // An empty table can be 0 bytes; the audit log has rows here.
      expect(sizes?.every((t) => Number.isInteger(t.bytes) && t.bytes >= 0)).toBe(true);
      expect(sizes?.find((t) => t.table === 'audit_log')?.bytes).toBeGreaterThan(0);
    });

    it('platform_app cannot open the guard by itself', async () => {
      await expect(
        db.appRaw.transaction().execute(async (tx) => {
          await sql`SELECT set_config('sdlc.housekeeping', 'on', true)`.execute(tx);
          await sql`DELETE FROM web_sessions`.execute(tx);
        }),
      ).rejects.toThrow(/permission denied/);
    });

    it('a cutoff later than the floor is refused (7 days, 1 hour), even for platform_app', async () => {
      const recent = new Date(Date.now() - 6 * DAY);
      await expect(
        sql`SELECT housekeeping_remove_web_sessions(${a.tenantId}, ${recent})`.execute(db.appRaw),
      ).rejects.toMatchObject({ code: 'SDA27' });
      const challengeRecent = new Date(Date.now() - 30 * 60_000);
      await expect(
        sql`SELECT housekeeping_remove_passkey_challenges(${a.tenantId}, ${challengeRecent})`.execute(
          db.appRaw,
        ),
      ).rejects.toMatchObject({ code: 'SDA27' });
    });

    it('the functions run as their owner with a fixed search_path; nobody but platform_app may run them', async () => {
      const { rows } = await sql<{ name: string; definer: boolean; config: string[] | null }>`
        SELECT proname AS name, prosecdef AS definer, proconfig AS config FROM pg_proc
        WHERE proname IN ('housekeeping_remove_web_sessions', 'housekeeping_remove_passkey_challenges')
        ORDER BY proname`.execute(db.owner);
      expect(rows).toEqual([
        {
          name: 'housekeeping_remove_passkey_challenges',
          definer: true,
          config: ['search_path=pg_catalog, public'],
        },
        {
          name: 'housekeeping_remove_web_sessions',
          definer: true,
          config: ['search_path=pg_catalog, public'],
        },
      ]);
      const { rows: grants } = await sql<{ grantee: string }>`
        SELECT DISTINCT grantee FROM information_schema.routine_privileges
        WHERE routine_name LIKE 'housekeeping_remove_%' AND grantee <> 'platform' ORDER BY grantee`.execute(
        db.owner,
      );
      expect(grants.map((g) => g.grantee)).toEqual(['platform_app']);
    });
  });
});
