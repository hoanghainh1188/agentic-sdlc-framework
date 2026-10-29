// The command `sdlc` became `adlc` in v0.9.0 (design/ADR-M100 §2.2). For one minor release the
// package installs both; `sdlc` prints one note on stderr and then runs exactly as `adlc`.
// v0.10.0 removes the alias, this file and `sdlc.ts`.
import { basename } from 'node:path';

/** True when the process was started as the old command (`sdlc`, `sdlc.js`, `sdlc.cjs`). */
export function startedAsLegacyName(scriptPath: string | undefined): boolean {
  return /^sdlc(\.c?js)?$/.test(basename(scriptPath ?? ''));
}
