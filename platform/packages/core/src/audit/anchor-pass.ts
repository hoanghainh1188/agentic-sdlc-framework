// One pass of the daily audit anchor (task E05 PR 2, design/ADR-M51 §2.9; D-05 §7.4). The worker
// runs it first in each retention loop pass, under the retention advisory lock. Every tenant, at
// most once per UTC day per process (`anchoredOn`):
//
// 1. The check: every version of every anchor of the tenant is read and compared with the row at
//    its `seq`. A key with more than one version or a delete marker, a malformed file, a missing
//    row or another hash is a mismatch: one `worker.audit_anchor_mismatch` log line (error) each,
//    and one `audit.anchor_mismatch` audit event per check run. Never a hash in either.
// 2. The write: the tenant's last audit row as today's anchor, `If-None-Match: *`. `exists` (412)
//    means another pass or process already anchored today. No backfill of missed days: an anchor's
//    date is the day it was written. Written even without new rows: it shows the chain did not
//    shrink. The new version's lock is checked (COMPLIANCE, at least 730 days), so an admin who
//    lowered the bucket's default is noticed (`worker.audit_anchor_unlocked`).
//
// `worker.audit_anchored` carries the anchored hash: D-05 §7.4 also writes it to the operations
// log (Harry, plan approval). A failure of one tenant is logged and counted; the next pass retries.
import { EvidenceError, type AuditAnchorStore } from '@sdlc/contracts';

import type { PlatformDatabase } from '../db/platform-database.js';
import type { TenantId } from '../db/tenant-id.js';
import type { TenantScope } from '../db/tenant-scope.js';
import type { PlatformLogger } from '../observability/logger.js';
import {
  anchorBytes,
  anchorDate,
  anchorKey,
  anchorLockHolds,
  compareAnchor,
  dateOfAnchorKey,
  MAX_ANCHOR_BYTES,
  parseAnchor,
  type AnchorMismatchReason,
  type AuditAnchor,
} from './anchor.js';

export interface AnchorPassDeps {
  readonly db: PlatformDatabase;
  readonly store: AuditAnchorStore;
  readonly logger: PlatformLogger;
  now(): Date;
  /**
   * Tenant ID → the UTC date its anchor was written or found and checked, owned by the caller (the
   * loop) across passes. A tenant done today is skipped until the next UTC day.
   */
  readonly anchoredOn: Map<string, string>;
}

export interface AnchorPassResult {
  tenants: number;
  /** Tenants already done today. */
  skipped: number;
  written: number;
  /** Today's anchor was already there (412). */
  exists: number;
  /** Tenants without an audit row: nothing to anchor. */
  empty: number;
  /** Anchor versions compared. */
  checked: number;
  mismatched: number;
  /** New anchors without the expected COMPLIANCE lock. */
  unlocked: number;
  failed: number;
}

interface Mismatch {
  readonly reason: AnchorMismatchReason;
  readonly date: string;
  readonly seq: number | null;
}

/** A code for logs, never an error message. */
function errorCode(error: unknown): string {
  if (error instanceof EvidenceError) return `evidence_${error.code}`;
  if (error instanceof Error && 'code' in error && typeof error.code === 'string') {
    return error.code;
  }
  return error instanceof Error ? error.name : 'unexpected';
}

/** Checks and writes the anchors of every tenant not done today. Never throws per tenant. */
export async function runAnchorPass(deps: AnchorPassDeps): Promise<AnchorPassResult> {
  const result: AnchorPassResult = {
    tenants: 0,
    skipped: 0,
    written: 0,
    exists: 0,
    empty: 0,
    checked: 0,
    mismatched: 0,
    unlocked: 0,
    failed: 0,
  };
  for (const tenant of await deps.db.system.listTenants()) {
    result.tenants += 1;
    const now = deps.now();
    const today = anchorDate(now);
    if (deps.anchoredOn.get(tenant.id) === today) {
      result.skipped += 1;
      continue;
    }
    const scope = deps.db.forTenant(tenant.id as TenantId);
    let done = true;
    try {
      await checkTenant(deps, scope, tenant.id, result);
    } catch (error) {
      done = false;
      result.failed += 1;
      deps.logger.log('error', 'worker.audit_anchor_check_failed', {
        tenant_id: tenant.id,
        error: errorCode(error),
      });
    }
    try {
      await writeAnchor(deps, scope, tenant.id, now, result);
    } catch (error) {
      done = false;
      result.failed += 1;
      deps.logger.log('error', 'worker.audit_anchor_failed', {
        tenant_id: tenant.id,
        error: errorCode(error),
      });
    }
    if (done) deps.anchoredOn.set(tenant.id, today);
  }
  return result;
}

/** Step 1: every version of every anchor of the tenant against its chain. */
async function checkTenant(
  deps: AnchorPassDeps,
  scope: TenantScope,
  tenantId: string,
  result: AnchorPassResult,
): Promise<void> {
  const versions = await deps.store.listVersions(tenantId);
  const byKey = new Map<string, number>();
  for (const v of versions) byKey.set(v.key, (byKey.get(v.key) ?? 0) + 1);
  const mismatches: Mismatch[] = [];
  const anchors: AuditAnchor[] = [];
  const overwritten = new Set<string>();
  let checked = 0;
  for (const version of versions) {
    const date = dateOfAnchorKey(version.key) ?? 'invalid';
    if (version.deleteMarker || (byKey.get(version.key) ?? 0) > 1) {
      // Reported once per key; its versions are still compared below.
      if (!overwritten.has(version.key)) {
        overwritten.add(version.key);
        mismatches.push({ reason: 'anchor_versions', date, seq: null });
      }
      if (version.deleteMarker) continue;
    }
    checked += 1;
    let anchor: AuditAnchor | null = null;
    if (dateOfAnchorKey(version.key) !== null) {
      const bytes = await deps.store.get(version.key, version.versionId, MAX_ANCHOR_BYTES);
      anchor = parseAnchor(bytes, tenantId, version.key);
    }
    if (anchor === null) mismatches.push({ reason: 'anchor_invalid', date, seq: null });
    else anchors.push(anchor);
  }
  result.checked += checked;
  const hashes = await scope.audit.hashesAt(anchors.map((a) => a.seq));
  for (const anchor of anchors) {
    const reason = compareAnchor(anchor, hashes);
    if (reason) mismatches.push({ reason, date: anchorDate(anchor.anchoredAt), seq: anchor.seq });
  }
  if (mismatches.length === 0) return;
  result.mismatched += mismatches.length;
  for (const m of mismatches) {
    deps.logger.log('error', 'worker.audit_anchor_mismatch', {
      tenant_id: tenantId,
      date: m.date,
      reason: m.reason,
      ...(m.seq !== null ? { seq: m.seq } : {}),
    });
  }
  const first = mismatches[0]!;
  await scope.audit.append({
    action: 'audit.anchor_mismatch',
    actorType: 'system',
    actorId: null,
    entityId: tenantId,
    payload: {
      checked,
      mismatched: mismatches.length,
      reason: first.reason,
      ...(first.seq !== null ? { first_seq: first.seq } : {}),
    },
  });
}

/** Step 2: today's anchor of the tenant's last audit row. */
async function writeAnchor(
  deps: AnchorPassDeps,
  scope: TenantScope,
  tenantId: string,
  now: Date,
  result: AnchorPassResult,
): Promise<void> {
  const head = await scope.audit.latest();
  if (!head) {
    result.empty += 1;
    deps.logger.log('info', 'worker.audit_anchor_empty', { tenant_id: tenantId });
    return;
  }
  const anchor: AuditAnchor = {
    tenantId,
    seq: head.seq,
    hash: head.hash,
    hashVersion: head.hashVersion,
    anchoredAt: now,
  };
  const key = anchorKey(tenantId, now);
  const put = await deps.store.put(key, anchorBytes(anchor));
  if (put.outcome === 'exists') {
    result.exists += 1;
    deps.logger.log('info', 'worker.audit_anchored', {
      tenant_id: tenantId,
      date: anchorDate(now),
      outcome: 'exists',
    });
    return;
  }
  result.written += 1;
  deps.logger.log('info', 'worker.audit_anchored', {
    tenant_id: tenantId,
    date: anchorDate(now),
    outcome: 'written',
    seq: head.seq,
    hash: head.hash,
    hash_version: head.hashVersion,
  });
  if (!anchorLockHolds(await deps.store.retention(key, put.versionId), now)) {
    result.unlocked += 1;
    deps.logger.log('error', 'worker.audit_anchor_unlocked', {
      tenant_id: tenantId,
      date: anchorDate(now),
    });
  }
}
