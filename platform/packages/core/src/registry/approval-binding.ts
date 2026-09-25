// Approval binding (D-02 FR-17, design/D-03 section 6.3). An approval stores the reviewed version
// (`input_sha256`), its scope and an expiry. Just before the protected action, the caller checks
// it again; any mismatch or expiry makes it void.
import { canonicalJson } from '@sdlc/config';

import { DbError } from '../db/errors.js';

/**
 * What an approval covers: environment, resources and allowed actions, as short codes such as
 * `production`, `db:orders` or `deploy`. Never free text. Lists are compared as sets.
 */
export interface ApprovalScope {
  readonly environment?: string;
  readonly resources?: readonly string[];
  readonly actions?: readonly string[];
}

const SCOPE_CODE = /^[A-Za-z0-9][A-Za-z0-9_.:/@-]{0,127}$/;
const MAX_SCOPE_ITEMS = 50;
const SCOPE_KEYS = new Set(['environment', 'resources', 'actions']);

export type BindingStatus = 'valid' | 'expired' | 'input_mismatch' | 'scope_mismatch';

function codeList(name: string, value: unknown): string[] {
  if (!Array.isArray(value) || value.length > MAX_SCOPE_ITEMS) {
    throw invalid(`scope.${name} must be a list of at most ${String(MAX_SCOPE_ITEMS)} codes`);
  }
  for (const item of value) {
    if (typeof item !== 'string' || !SCOPE_CODE.test(item)) {
      throw invalid(`scope.${name} holds a value that is not a code`);
    }
  }
  return [...new Set(value as string[])].sort();
}

/**
 * Checks a scope and returns its normal form (sorted, no duplicates, no empty lists), or null for
 * no scope. Throws `DbError('invalid_value')` for unknown keys or values that are not codes.
 */
export function normalizeScope(scope: unknown): ApprovalScope | null {
  if (scope === undefined || scope === null) return null;
  if (typeof scope !== 'object' || Array.isArray(scope)) throw invalid('scope must be an object');
  const record = scope as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!SCOPE_KEYS.has(key)) throw invalid(`scope has an unknown key ${JSON.stringify(key)}`);
  }
  const normal: { environment?: string; resources?: string[]; actions?: string[] } = {};
  if (record.environment !== undefined) {
    if (typeof record.environment !== 'string' || !SCOPE_CODE.test(record.environment)) {
      throw invalid('scope.environment must be a code');
    }
    normal.environment = record.environment;
  }
  for (const key of ['resources', 'actions'] as const) {
    if (record[key] === undefined) continue;
    const list = codeList(key, record[key]);
    if (list.length > 0) normal[key] = list;
  }
  return Object.keys(normal).length === 0 ? null : normal;
}

export function scopesEqual(a: unknown, b: unknown): boolean {
  return canonicalJson(normalizeScope(a)) === canonicalJson(normalizeScope(b));
}

export interface BoundApproval {
  readonly input_sha256: string;
  readonly scope: unknown;
  readonly expires_at: Date | null;
}

export interface CurrentInput {
  readonly inputSha256: string;
  readonly scope?: ApprovalScope | null;
  readonly now: Date;
}

/**
 * Checks an approval against the current input just before the protected action. When several
 * reasons apply, the stored reason is the first of: expired, input mismatch, scope mismatch.
 * Expiry comes first because it holds whatever the input is.
 */
export function checkApprovalBinding(
  approval: BoundApproval,
  current: CurrentInput,
): BindingStatus {
  if (approval.expires_at === null || current.now.getTime() >= approval.expires_at.getTime()) {
    return 'expired';
  }
  if (approval.input_sha256 !== current.inputSha256) return 'input_mismatch';
  if (!scopesEqual(approval.scope, current.scope ?? null)) return 'scope_mismatch';
  return 'valid';
}

function invalid(message: string): DbError {
  return new DbError('invalid_value', message);
}
