// One run of `pnpm alerts` (D-08 O03, design/ADR-M101): doctor's results in, the decision sent to
// every channel. The state file is written only when every channel took the message, so a failed
// delivery is tried again on the next run (a channel that worked may then get it twice).
// `--dry-run` and `--test` never change the state. Exit 0 done, 1 a channel failed, 2 usage or
// settings.
import fs from 'node:fs';
import { parseArgs } from 'node:util';

import { t } from '@sdlc/messages';

import { allowedValues } from '../../doctor/dist/env-facts.js';
import type { CheckResult } from '../../doctor/dist/types.js';

import { sendEmail, sendWebhook, type Delivery, type Post } from './channels.js';
import { decide } from './decide.js';
import { buildMessage, testMessage, type AlertMessage } from './message.js';
import { alertSettings, ALERT_KEYS, type AlertSettings } from './settings.js';
import { readState, writeState } from './state.js';

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

function settingsOf(deps: RunDeps): AlertSettings | null {
  if (!fs.existsSync(deps.envFile)) {
    deps.out(t('alerts.no_env', { path: deps.envFile }));
    return null;
  }
  const values = allowedValues(fs.readFileSync(deps.envFile, 'utf8'), ALERT_KEYS);
  const r = alertSettings(values, deps.envFile, deps.hostname);
  if (r.ok) return r.settings;
  deps.out(r.key === 'none' ? t('alerts.no_channel') : t('alerts.setting_bad', { key: r.key }));
  return null;
}

/** Sends to every configured channel; the names of those that took it, or null if one failed. */
async function deliver(s: AlertSettings, m: AlertMessage, deps: RunDeps): Promise<string[] | null> {
  const sent: string[] = [];
  let failed = false;
  const report = (channel: string, result: Delivery) => {
    if (result === 'sent') sent.push(channel);
    else {
      failed = true;
      deps.out(t('alerts.channel_failed', { channel, code: result }));
    }
  };
  if (s.webhook) report('webhook', await sendWebhook(s.webhook, m, deps.post));
  if (s.email) report('e-mail', await sendEmail(s.email, m));
  return failed ? null : sent;
}

export async function runAlerts(argv: readonly string[], deps: RunDeps): Promise<number> {
  const m = mode(argv);
  if (m === null) {
    deps.out(t('alerts.usage'));
    return EXIT.usage;
  }
  const settings = settingsOf(deps);
  if (settings === null) return EXIT.usage;
  const now = deps.now();
  if (m === 'test') {
    const sent = await deliver(settings, testMessage(settings.hostName, now), deps);
    if (sent === null) return EXIT.failed;
    deps.out(t('alerts.test_sent', { channels: sent.join(', ') }));
    return EXIT.ok;
  }
  return runChecks(m, settings, now, deps);
}

async function runChecks(m: Mode, s: AlertSettings, now: Date, deps: RunDeps): Promise<number> {
  const { state, reset } = readState(s.stateFile);
  if (reset) deps.out(t('alerts.state_reset'));
  const { items, next } = decide(state, await deps.results(), now, s.remindHours);
  const message = buildMessage(items, s.hostName, now);
  if (m === 'dry-run') {
    deps.out(t('alerts.dry_run'));
    deps.out(message.text);
    return EXIT.ok;
  }
  if (items.length === 0) {
    writeState(s.stateFile, next);
    deps.out(t('alerts.nothing', { open: Object.keys(next).length }));
    return EXIT.ok;
  }
  const sent = await deliver(s, message, deps);
  if (sent === null) return EXIT.failed;
  writeState(s.stateFile, next);
  deps.out(t('alerts.sent', { count: items.length, channels: sent.join(', ') }));
  return EXIT.ok;
}
