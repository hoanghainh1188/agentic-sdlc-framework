import { DbError } from '../errors.js';

/**
 * Optimistic versioning for 1–1 project records (`project_configs`, `project_ai_records`).
 * `expectedVersion` is the version the caller read: 0 when no record exists yet.
 */
export function versionConflict(table: string, expectedVersion: number): DbError {
  return new DbError(
    'version_conflict',
    `${table}: the record changed since version ${expectedVersion} was read`,
  );
}

export function assertExpectedVersion(expectedVersion: number): void {
  if (!Number.isInteger(expectedVersion) || expectedVersion < 0) {
    throw new DbError('invalid_value', 'expectedVersion must be an integer >= 0');
  }
}
