// One housekeeping pass (task O04, design/ADR-M103; D-05 §6.1): ended web sessions and used or
// expired passkey challenges of every tenant, removed after a fixed time. The worker runs it in the
// retention loop, under the retention lock, with or without the evidence identities: it touches
// only the database. Mode `report` counts; `remove` removes, and appends one
// `housekeeping.removed` (counts only) per tenant that had something to remove, in the same
// transaction. A failed tenant is logged and counted; the next pass retries it.
import type { PlatformDatabase } from '../db/platform-database.js';
import type { HousekeepingCounts } from '../db/repositories/housekeeping.js';
import type { TenantId } from '../db/tenant-id.js';
import type { PlatformLogger } from '../observability/logger.js';

/** The floors of migration 0046: the database refuses an earlier removal. */
export const SESSION_KEEP_DAYS_MIN = 7;
export const CHALLENGE_KEEP_HOURS_MIN = 1;

export interface HousekeepingSettings {
  readonly mode: 'report' | 'remove';
  /** Days a session stays after it ended (at least `SESSION_KEEP_DAYS_MIN`). */
  readonly sessionDays: number;
  /** Hours a challenge stays after it was used or expired (at least `CHALLENGE_KEEP_HOURS_MIN`). */
  readonly challengeHours: number;
}

export interface HousekeepingPassDeps {
  readonly db: PlatformDatabase;
  readonly logger: PlatformLogger;
  now(): Date;
  readonly settings: HousekeepingSettings;
}

export interface HousekeepingPassResult {
  readonly tenants: number;
  readonly sessions: number;
  readonly challenges: number;
  readonly failed: number;
}

const HOUR_MS = 3_600_000;

export async function runHousekeepingPass(
  deps: HousekeepingPassDeps,
): Promise<HousekeepingPassResult> {
  const { settings } = deps;
  const now = deps.now();
  const cut = {
    sessionsBefore: new Date(
      now.getTime() - Math.max(settings.sessionDays, SESSION_KEEP_DAYS_MIN) * 24 * HOUR_MS,
    ),
    challengesBefore: new Date(
      now.getTime() - Math.max(settings.challengeHours, CHALLENGE_KEEP_HOURS_MIN) * HOUR_MS,
    ),
  };
  let tenants = 0;
  let sessions = 0;
  let challenges = 0;
  let failed = 0;
  for (const tenant of await deps.db.system.listTenants()) {
    tenants += 1;
    try {
      const counts = await tenantPass(deps, tenant.id as TenantId, cut, now);
      sessions += counts.sessions;
      challenges += counts.challenges;
    } catch (error) {
      failed += 1;
      deps.logger.log('warn', 'worker.housekeeping_tenant_failed', {
        tenant_id: tenant.id,
        error: error instanceof Error ? error.name : 'unexpected',
      });
    }
  }
  return { tenants, sessions, challenges, failed };
}

async function tenantPass(
  deps: HousekeepingPassDeps,
  tenantId: TenantId,
  cut: { sessionsBefore: Date; challengesBefore: Date },
  now: Date,
): Promise<HousekeepingCounts> {
  const scope = deps.db.forTenant(tenantId);
  if (deps.settings.mode === 'report') return scope.housekeeping.count(cut);
  return scope.transaction(async (tx) => {
    const counts = await tx.housekeeping.remove(cut);
    if (counts.sessions + counts.challenges > 0) {
      await tx.audit.append({
        action: 'housekeeping.removed',
        actorType: 'system',
        actorId: null,
        entityId: tenantId,
        payload: { sessions: counts.sessions, challenges: counts.challenges },
        occurredAt: now,
      });
    }
    return counts;
  });
}
