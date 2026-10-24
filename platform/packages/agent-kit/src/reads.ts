// The files an agent opened, for the run's context snapshot (D-08 X07 AC1, ADR-M90 §2.1). Each
// adapter finds its own file-reading calls in its log and passes their paths here; calls that can
// read files without naming them (a shell, a search) are only counted. The paths are client data:
// they go back to the runner in memory only, which hashes them (never a path in a run event).
import path from 'node:path';

import type { AgentFileReads } from '@sdlc/contracts';

/**
 * A path the agent named, relative to `workingDir` (POSIX, no `.` or `..` parts, no trailing
 * slash): `''` for the working directory itself, `undefined` when it is outside the working
 * directory or not a usable path. A relative path is read from `workingDir`, as the agent's
 * tools do.
 */
export function workspacePath(raw: string, workingDir: string): string | undefined {
  if (raw.length === 0 || raw.includes('\0')) return undefined;
  const root = path.posix.resolve('/', workingDir);
  const relative = path.posix.relative(root, path.posix.resolve(root, raw));
  if (relative === '..' || relative.startsWith('../')) return undefined;
  return relative;
}

/** Builds `AgentFileReads` from the raw paths of the file-reading calls and the other count. */
export function fileReadsOf(
  rawPaths: readonly string[],
  workingDir: string,
  unattributed: number,
): AgentFileReads {
  const inside = new Set<string>();
  let outside = 0;
  for (const raw of rawPaths) {
    const relative = workspacePath(raw, workingDir);
    if (relative === undefined) outside += 1;
    // A view of the working directory itself lists it: no file of the repository was opened.
    else if (relative !== '') inside.add(relative);
  }
  return { paths: [...inside].sort(), outside, unattributed };
}
