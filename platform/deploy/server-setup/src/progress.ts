// The progress file of `pnpm server:setup` (D-08 V16 AC3, AC5): which steps are done and where the
// last run stopped, so a new start skips what is done and says where it stopped. It holds step
// names, command names, codes and times only, never a secret (QUESTIONS #616 (a)). It lives next to
// the env file (Git ignores it), mode 600.
import fs from 'node:fs';
import path from 'node:path';

export const PROGRESS_FILE = 'server-setup-progress.json';

/** Why the last run stopped. */
export type StopReason = 'failed' | 'interrupted';

export interface Progress {
  readonly v: 1;
  /** Steps done, as markers: `2`, `3.init`, `3.configure`, `4`, `5`, `6`, `7.up`, `7.<part>`. */
  readonly done: readonly string[];
  /** README step 5 and 7 credentials commands delivered. */
  readonly credentials: readonly string[];
  /**
   * A root token of an earlier run may still be valid (it stopped while OpenBao was sealed): the
   * next `configure` first revokes every other root token by accessor.
   */
  readonly leftoverRoot?: true;
  readonly stopped?: {
    readonly step: string;
    readonly reason: StopReason;
    readonly at: string;
    /** Whether the root token of that run was revoked (or there was none). */
    readonly rootRevoked: boolean;
  };
}

export const EMPTY_PROGRESS: Progress = { v: 1, done: [], credentials: [] };

export function progressFileFor(envFile: string): string {
  return path.join(path.dirname(envFile), PROGRESS_FILE);
}

const MARKER = /^[0-9](?:\.[a-z-]+)?$/;
const COMMAND = /^[a-z-]+-credentials$/;

/** The progress in a file's text; anything malformed counts as no progress. Pure. */
export function parseProgress(text: string | undefined): Progress {
  if (text === undefined) return EMPTY_PROGRESS;
  try {
    const doc = JSON.parse(text) as Partial<Record<keyof Progress, unknown>>;
    const strings = (v: unknown, re: RegExp) =>
      Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string' && re.test(s)) : [];
    const s = doc.stopped as Record<string, unknown> | undefined;
    const stopped: Progress['stopped'] =
      s &&
      typeof s.step === 'string' &&
      MARKER.test(s.step) &&
      (s.reason === 'failed' || s.reason === 'interrupted') &&
      typeof s.at === 'string' &&
      typeof s.rootRevoked === 'boolean'
        ? { step: s.step, reason: s.reason, at: s.at, rootRevoked: s.rootRevoked }
        : undefined;
    return {
      v: 1,
      done: strings(doc.done, MARKER),
      credentials: strings(doc.credentials, COMMAND),
      ...(doc.leftoverRoot === true || stopped?.rootRevoked === false
        ? { leftoverRoot: true as const }
        : {}),
      ...(stopped ? { stopped } : {}),
    };
  } catch {
    return EMPTY_PROGRESS;
  }
}

export function readProgress(file: string): Progress {
  return parseProgress(fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : undefined);
}

/** Writes the progress (mode 600) through a temporary file, so a crash never leaves half a file. */
export function writeProgress(file: string, p: Progress): void {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(p, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}
