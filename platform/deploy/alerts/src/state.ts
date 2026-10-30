// The state file of `pnpm alerts` (D-08 O03, design/ADR-M101): per channel, what was last sent for
// each check and subject, so a problem is not sent every run and a channel that is down does not
// make the others send again. It holds channel names, check IDs, subjects, statuses and times
// only. Written with mode 600 to a new file of a random name (never an existing one), then moved
// over the old one.
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import type { AlertState, SentAlert } from './decide.js';

const VERSION = 1;

export type Channel = 'webhook' | 'e-mail';
export type ChannelStates = Readonly<Partial<Record<Channel, AlertState>>>;

function validAlert(value: unknown): value is SentAlert {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    (v.status === 'warning' || v.status === 'failed') &&
    typeof v.sentAt === 'string' &&
    !Number.isNaN(Date.parse(v.sentAt))
  );
}

function validChannels(value: unknown): value is ChannelStates {
  if (typeof value !== 'object' || value === null) return false;
  return Object.entries(value).every(
    ([channel, alerts]) =>
      (channel === 'webhook' || channel === 'e-mail') &&
      typeof alerts === 'object' &&
      alerts !== null &&
      Object.values(alerts as object).every(validAlert),
  );
}

/** The state, or `reset` when the file exists but is not a state file of this version. */
export function readState(file: string): { state: ChannelStates; reset: boolean } {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return { state: {}, reset: false };
  }
  try {
    const parsed = JSON.parse(text) as { version?: unknown; channels?: unknown };
    if (parsed.version !== VERSION || !validChannels(parsed.channels)) {
      return { state: {}, reset: true };
    }
    return { state: parsed.channels, reset: false };
  } catch {
    return { state: {}, reset: true };
  }
}

/** Whether the state file's folder takes a new file (checked before anything is sent). */
export function stateWritable(file: string): boolean {
  try {
    fs.accessSync(path.dirname(file), fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

export function writeState(file: string, state: ChannelStates): void {
  const temp = path.join(
    path.dirname(file),
    `.${path.basename(file)}.${randomBytes(6).toString('hex')}`,
  );
  // `wx`: never opens an existing file or a link at that name.
  fs.writeFileSync(temp, `${JSON.stringify({ version: VERSION, channels: state }, null, 2)}\n`, {
    mode: 0o600,
    flag: 'wx',
  });
  fs.renameSync(temp, file);
}
