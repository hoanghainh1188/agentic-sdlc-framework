// `sdlc ops audit verify` (D-02 FR-41, D-08 A07 AC4, design/D-05 section 7.3): the operator's
// check on the server, straight on the platform database as `platform_app` (SDLC_DB_URL), for
// every tenant or one. Tenant admins use `sdlc audit verify` through the API (B13, ADR-M37 §2.8;
// audit-verify-api.ts); this stays for when the API is down.
import { parseArgs } from 'node:util';

import { PlatformDatabase, parseTenantId, type ChainBreakReason, type Tenant } from '@sdlc/core';
import { t, type MessageKey } from '@sdlc/messages';

import { EXIT, type CliContext } from '../context.js';

export const REASON_KEYS: Readonly<Record<ChainBreakReason, MessageKey>> = {
  seq_gap: 'audit.verify.reason.seq_gap',
  prev_hash_mismatch: 'audit.verify.reason.prev_hash_mismatch',
  hash_mismatch: 'audit.verify.reason.hash_mismatch',
  unknown_hash_version: 'audit.verify.reason.unknown_hash_version',
};

export interface AuditVerifyOptions {
  readonly tenant?: string;
  readonly json: boolean;
}

interface TenantResult {
  readonly tenant: string;
  readonly tenant_id: string;
  readonly ok: boolean;
  readonly checked: number;
  readonly last_seq: number;
  readonly broken: { readonly seq: number; readonly reason: ChainBreakReason } | null;
}

/** `[--tenant <slug>] [--json]`. Undefined: print the usage. */
export function parseAuditVerifyOptions(args: readonly string[]): AuditVerifyOptions | undefined {
  try {
    const { values } = parseArgs({
      args: [...args],
      options: { tenant: { type: 'string' }, json: { type: 'boolean', default: false } },
      strict: true,
      allowPositionals: false,
    });
    return { json: values.json, ...(values.tenant === undefined ? {} : { tenant: values.tenant }) };
  } catch {
    return undefined;
  }
}

export async function auditVerify(options: AuditVerifyOptions, ctx: CliContext): Promise<number> {
  const url = ctx.env.SDLC_DB_URL;
  if (!url) {
    ctx.stderr(t('audit.verify.missing_url'));
    return EXIT.usage;
  }
  const db = ctx.connect({ connectionString: url, maxConnections: 1, applicationName: 'sdlc-cli' });
  try {
    const tenants = await selectTenants(db, options.tenant);
    if (!tenants) {
      ctx.stderr(t('audit.verify.tenant_not_found', { slug: options.tenant ?? '' }));
      return EXIT.usage;
    }
    const results: TenantResult[] = [];
    for (const tenant of tenants) results.push(await verifyTenant(db, tenant));
    report(results, options.json, ctx);
    return results.every((r) => r.ok) ? EXIT.ok : EXIT.failed;
  } finally {
    await db.close();
  }
}

async function selectTenants(
  db: PlatformDatabase,
  slug: string | undefined,
): Promise<readonly Tenant[] | undefined> {
  if (slug === undefined) return db.system.listTenants();
  const tenant = await db.system.getTenantBySlug(slug);
  return tenant ? [tenant] : undefined;
}

async function verifyTenant(db: PlatformDatabase, tenant: Tenant): Promise<TenantResult> {
  const state = await db.forTenant(parseTenantId(tenant.id)).audit.verify();
  return {
    tenant: tenant.slug,
    tenant_id: tenant.id,
    ok: state.broken === undefined,
    checked: state.checked,
    last_seq: state.lastSeq,
    broken: state.broken ?? null,
  };
}

function report(results: readonly TenantResult[], json: boolean, ctx: CliContext): void {
  if (json) {
    ctx.stdout(JSON.stringify(results, null, 2));
    return;
  }
  if (results.length === 0) ctx.stdout(t('audit.verify.no_tenants'));
  for (const r of results) {
    if (r.broken) {
      ctx.stdout(
        t('audit.verify.broken', {
          tenant: r.tenant,
          seq: r.broken.seq,
          reason: t(REASON_KEYS[r.broken.reason]),
          count: r.checked,
        }),
      );
    } else {
      ctx.stdout(t('audit.verify.intact', { tenant: r.tenant, count: r.checked }));
    }
  }
}
