// Errors of the data access layer. They carry a stable `code`; the API and CLI turn codes into
// user-facing text through the message catalog (NFR-08). `message` is for logs and developers only.

export type DbErrorCode =
  | 'invalid_tenant_id'
  | 'invalid_value'
  | 'conflict'
  | 'reference_not_found'
  | 'version_conflict'
  | 'permission_denied';

export class DbError extends Error {
  override readonly name = 'DbError';

  constructor(
    readonly code: DbErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export type TenantGuardErrorCode =
  | 'raw_sql'
  | 'unsupported_statement'
  | 'unknown_table'
  | 'missing_tenant_filter'
  | 'tenant_column_write'
  | 'insert_without_tenant'
  | 'cte_shadows_table';

/** A query that could read or write another tenant's data. Always a programming error. */
export class TenantGuardError extends Error {
  override readonly name = 'TenantGuardError';

  constructor(
    readonly code: TenantGuardErrorCode,
    message: string,
  ) {
    super(message);
  }
}

const PG_ERROR_CODES: Record<string, DbErrorCode> = {
  '23505': 'conflict', // unique_violation
  '23503': 'reference_not_found', // foreign_key_violation (includes cross-tenant references, D-05 D2)
  '23514': 'invalid_value', // check_violation
  '23502': 'invalid_value', // not_null_violation
  '22P02': 'invalid_value', // invalid_text_representation (bad UUID, bad enum value)
  '42501': 'permission_denied', // insufficient_privilege
};

/** Maps a PostgreSQL error to a DbError; anything else is rethrown unchanged. */
export function translatePgError(error: unknown): never {
  const code = (error as { code?: unknown } | null)?.code;
  const mapped = typeof code === 'string' ? PG_ERROR_CODES[code] : undefined;
  if (mapped) {
    const constraint = (error as { constraint?: unknown }).constraint;
    const detail = typeof constraint === 'string' ? ` (${constraint})` : '';
    throw new DbError(mapped, `database rejected the statement: ${mapped}${detail}`, {
      cause: error,
    });
  }
  throw error;
}
