// One run of `pnpm alerts` (D-08 O03, design/ADR-M101): doctor's results in, the decision sent to
// each channel. Each channel keeps its own state, so a channel that failed is tried again on the
// next run and the others do not send again. `--dry-run` and `--test` never change the state.
// Exit 0 done, 1 a channel failed or the state could not be written, 2 usage or settings.
import fs from 'node:fs';
import { parseArgs } from 'node:util';

import { t } from '@sdlc/messages';

import { allowedValues } from '../../doctor/dist/env-facts.js';
import type { CheckResult } from '../../doctor/dist/types.js';

import { sendEmail, sendWebhook, type Delivery, type Post } from './channels.js';
import { decide, type AlertState } from './decide.js';
import { buildMessage, testMessage, type AlertMessage } from './message.js';
import { alertSettings, ALERT_KEYS, type AlertSettings } from './settings.js';
import { readState, stateWritable, writeState, type Channel, type ChannelStates } from './state.js';

export const EXIT = { ok: 0, failed: 1, usage: 2 } as const;

export interface RunDeps {
  readonly envFile: string;
  readonly now: () => Date;
  /** The machine's name, when `SDLC_ALERT_HOST_NAME` is not set. */
  readonly hostname: string;
  /** Doctor's results for the env file (only called for a real run). */
  readonly results: () => Promise<readonly CheckResult[]>;
  readonly post: Post;
  readonly out: (line: string) => void;
}

type Mode = 'run' | 'dry-run' | 'test';

function mode(argv: readonly string[]): Mode | null {
  try {
    const { values } = parseArgs({
      args: [...argv],
      options: { 'dry-run': { type: 'boolean' }, test: { type: 'boolean' } },
      strict: true,
      allowPositionals: false,
    });
    if (values['dry-run'] && values.test) return null;
    return values.test ? 'test' : values['dry-run'] ? 'dry-run' : 'run';
  } catch {
    return null;
  }
}

function settingsOf(deps: RunDeps, m: Mode): AlertSettings | null {
  if (!fs.existsSync(deps.envFile)) {
    deps.out(t('alerts.no_env', { path: deps.envFile }));
    return null;
  }
  const values = allowedValues(fs.readFileSync(deps.envFile, 'utf8'), ALERT_KEYS);
  const r = alertSettings(values, deps.envFile, deps.hostname);
  if (!r.ok) {
    deps.out(r.key === 'none' ? t('alerts.no_channel') : t('alerts.setting_bad', { key: r.key }));
    return null;
  }
  // Checked before sending: a state that cannot be written would send the same alert every run.
  if (m === 'run' && !stateWritable(r.settings.stateFile)) {
    deps.out(t('alerts.setting_bad', { key: 'SDLC_ALERT_STATE_FILE' }));
    return null;
  }
  return r.settings;
}

function channels(s: AlertSettings): Channel[] {
  return [...(s.webhook ? ['webhook' as const] : []), ...(s.email ? ['e-mail' as const] : [])];
}

async function send(
  s: AlertSettings,
  c: Channel,
  m: AlertMessage,
  deps: RunDeps,
): Promise<boolean> {
  const result: Delivery =
    c === 'webhook' ? await sendWebhook(s.webhook!, m, deps.post) : await sendEmail(s.email!, m);
  if (result !== 'sent') deps.out(t('alerts.channel_failed', { channel: c, code: result }));
  return result === 'sent';
}

export async function runAlerts(argv: readonly string[], deps: RunDeps): Promise<number> {
  const m = mode(argv);
  if (m === null) {
    deps.out(t('alerts.usage'));
    return EXIT.usage;
  }
  const settings = settingsOf(deps, m);
  if (settings === null) return EXIT.usage;
  const now = deps.now();
  if (m === 'test') {
    const message = testMessage(settings.hostName, now);
    const sent: Channel[] = [];
    for (const c of channels(settings)) if (await send(settings, c, message, deps)) sent.push(c);
    if (sent.length < channels(settings).length) return EXIT.failed;
    deps.out(t('alerts.test_sent', { channels: sent.join(', ') }));
    return EXIT.ok;
  }
  return runChecks(m, settings, now, deps);
}

async function runChecks(m: Mode, s: AlertSettings, now: Date, deps: RunDeps): Promise<number> {
  const { state, reset } = readState(s.stateFile);
  if (reset) deps.out(t('alerts.state_reset'));
  const results = await deps.results();
  const next: Partial<Record<Channel, AlertState>> = { ...state };
  let failed = false;
  for (const c of channels(s)) {
    const { items, next: after } = decide(state[c] ?? {}, results, now, s.remindHours);
    const message = buildMessage(items, s.hostName, now);
    if (m === 'dry-run') {
      deps.out(t('alerts.dry_run'));
      deps.out(message.text);
      return EXIT.ok;
    }
    if (items.length === 0) {
      next[c] = after;
      deps.out(t('alerts.nothing', { open: Object.keys(after).length }));
    } else if (await send(s, c, message, deps)) {
      next[c] = after;
      deps.out(t('alerts.sent', { count: items.length, channels: c }));
    } else {
      failed = true;
    }
  }
  return save(s.stateFile, next, deps) && !failed ? EXIT.ok : EXIT.failed;
}

function save(file: string, state: ChannelStates, deps: RunDeps): boolean {
  try {
    writeState(file, state);
    return true;
  } catch {
    deps.out(t('alerts.state_write_failed'));
    return false;
  }
}
