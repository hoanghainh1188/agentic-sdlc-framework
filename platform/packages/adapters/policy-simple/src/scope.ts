// G5 file scope: changed files against the plan's files and path patterns (D-08 B01 AC4,
// design/D-05 `plans.planned_files`). Patterns use glob syntax (`*`, `**`, `?`, `{a,b}`) and are
// matched with Node's `path.posix.matchesGlob`.
import path from 'node:path';

import type { ScopeResult } from '@sdlc/contracts';

/**
 * A repository-relative POSIX path with no `.` or `..` segment. Anything else (absolute paths,
 * backslashes, traversal) never matches a plan, so it is always out of scope.
 */
function isSafeRelativePath(value: string): boolean {
  if (value === '' || value.startsWith('/') || value.includes('\\') || value.includes('\0')) {
    return false;
  }
  return value.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

function matches(file: string, pattern: string): boolean {
  return file === pattern || path.posix.matchesGlob(file, pattern);
}

export function checkScope(input: {
  plannedFiles: readonly string[];
  changedFiles: readonly string[];
}): ScopeResult {
  const patterns = input.plannedFiles.filter(isSafeRelativePath);
  const outOfScope = input.changedFiles.filter(
    (file) => !isSafeRelativePath(file) || !patterns.some((pattern) => matches(file, pattern)),
  );
  return { withinScope: outOfScope.length === 0, outOfScope };
}
