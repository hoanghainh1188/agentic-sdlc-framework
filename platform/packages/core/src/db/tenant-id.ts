// A tenant ID that has been checked (design/D-05 D1, D-08 A06 AC3).
// Branded: a plain string cannot be passed where a TenantId is expected.
import { DbError } from './errors.js';

declare const tenantIdBrand: unique symbol;
export type TenantId = string & { readonly [tenantIdBrand]: true };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}

/** Validates the format and returns a TenantId. Throws `DbError('invalid_tenant_id')` otherwise. */
export function parseTenantId(value: unknown): TenantId {
  if (typeof value === 'string' && UUID.test(value.toLowerCase())) {
    return value.toLowerCase() as TenantId;
  }
  throw new DbError('invalid_tenant_id', 'tenant ID must be a UUID');
}
