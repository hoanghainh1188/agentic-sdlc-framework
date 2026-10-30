// The state file of `pnpm alerts` (D-08 O03, design/ADR-M101): what was last sent for each check
// and subject, so a problem is not sent every run. It holds check IDs, subjects, statuses and
// times only. Written with mode 600 to a new file, then moved over the old one.
import fs from 'node:fs';
import path from 'node:path';

import type { AlertState, SentAlert } from './decide.js';

const VERSION = 1;

function valid(value: unknown): value is SentAlert {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    (v.status === 'warning' || v.status === 'failed') &&
    typeof v.sentAt === 'string' &&
    !Number.isNaN(Date.parse(v.sentAt))
  );
}

/** The state, or `reset` when the file exists but is not a state file of this version. */
export function readState(file: string): { state: AlertState; reset: boolean } {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return { state: {}, reset: false };
  }
  try {
    const parsed = JSON.parse(text) as { version?: unknown; alerts?: unknown };
    const alerts = parsed.alerts as Record<string, unknown> | undefined;
    if (parsed.version !== VERSION || typeof alerts !== 'object' || alerts === null) {
      return { state: {}, reset: true };
    }
    if (!Object.values(alerts).every(valid)) return { state: {}, reset: true };
    return { state: alerts as AlertState, reset: false };
  } catch {
    return { state: {}, reset: true };
  }
}

export function writeState(file: string, state: AlertState): void {
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}`);
  fs.writeFileSync(temp, `${JSON.stringify({ version: VERSION, alerts: state }, null, 2)}\n`, {
    mode: 0o600,
  });
  fs.chmodSync(temp, 0o600);
  fs.renameSync(temp, file);
}
