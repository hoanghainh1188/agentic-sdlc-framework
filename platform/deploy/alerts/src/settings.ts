// The settings of `pnpm alerts` in the env file (D-08 O03, design/ADR-M101). Only `SDLC_ALERT_*`
// keys are read. The webhook URL is a secret (it holds a token), so the env file names a file
// that holds it, never the URL itself (R034). A bad value is refused with its key, never guessed.
import path from 'node:path';

export const ALERT_KEYS = [
  'SDLC_ALERT_WEBHOOK_FILE',
  'SDLC_ALERT_WEBHOOK_FORMAT',
  'SDLC_ALERT_EMAIL_TO',
  'SDLC_ALERT_EMAIL_FROM',
  'SDLC_ALERT_SENDMAIL',
  'SDLC_ALERT_STATE_FILE',
  'SDLC_ALERT_REMIND_HOURS',
  'SDLC_ALERT_HOST_NAME',
] as const;

export type WebhookFormat = 'text' | 'json';

export interface WebhookSettings {
  /** A file of mode 600 that holds the URL alone. */
  readonly file: string;
  /** `text`: `{"text": …}` (Slack, Google Chat, Mattermost, Rocket.Chat); `json`: our shape. */
  readonly format: WebhookFormat;
}

export interface EmailSettings {
  readonly to: readonly string[];
  /** null: `sendmail` chooses the sender. */
  readonly from: string | null;
  readonly sendmail: string;
}

export interface AlertSettings {
  readonly webhook: WebhookSettings | null;
  readonly email: EmailSettings | null;
  readonly stateFile: string;
  readonly remindHours: number;
  readonly hostName: string;
}

export type SettingsResult =
  | { readonly ok: true; readonly settings: AlertSettings }
  | { readonly ok: false; readonly key: (typeof ALERT_KEYS)[number] | 'none' };

/** A plain address: no space, no line break, no header or list character. */
const ADDRESS = /^[^\s@<>,;"'()[\]\\]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;
const HOST_NAME = /^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$/;
const DEFAULT_SENDMAIL = '/usr/sbin/sendmail';
const DEFAULT_REMIND_HOURS = 24;
export const STATE_FILE_NAME = 'alerts-state.json';

type Values = Readonly<Partial<Record<(typeof ALERT_KEYS)[number], string>>>;
type Key = (typeof ALERT_KEYS)[number];

class Bad extends Error {
  constructor(readonly key: Key | 'none') {
    super(key);
  }
}

function absolute(values: Values, key: Key, fallback: string | null): string | null {
  const v = values[key];
  if (v === undefined) return fallback;
  if (!path.isAbsolute(v)) throw new Bad(key);
  return v;
}

function webhook(values: Values): WebhookSettings | null {
  const file = absolute(values, 'SDLC_ALERT_WEBHOOK_FILE', null);
  if (file === null) return null;
  const format = values.SDLC_ALERT_WEBHOOK_FORMAT ?? 'text';
  if (format !== 'text' && format !== 'json') throw new Bad('SDLC_ALERT_WEBHOOK_FORMAT');
  return { file, format };
}

function email(values: Values): EmailSettings | null {
  const raw = values.SDLC_ALERT_EMAIL_TO;
  if (raw === undefined) return null;
  const to = raw.split(',').map((a) => a.trim());
  if (to.some((a) => !ADDRESS.test(a))) throw new Bad('SDLC_ALERT_EMAIL_TO');
  const from = values.SDLC_ALERT_EMAIL_FROM ?? null;
  if (from !== null && !ADDRESS.test(from)) throw new Bad('SDLC_ALERT_EMAIL_FROM');
  const sendmail = absolute(values, 'SDLC_ALERT_SENDMAIL', DEFAULT_SENDMAIL)!;
  return { to, from, sendmail };
}

function remindHours(values: Values): number {
  const v = values.SDLC_ALERT_REMIND_HOURS;
  if (v === undefined) return DEFAULT_REMIND_HOURS;
  if (!/^[1-9]\d*$/.test(v)) throw new Bad('SDLC_ALERT_REMIND_HOURS');
  return Number(v);
}

export function alertSettings(values: Values, envFile: string, hostname: string): SettingsResult {
  try {
    const settings: AlertSettings = {
      webhook: webhook(values),
      email: email(values),
      stateFile: absolute(
        values,
        'SDLC_ALERT_STATE_FILE',
        path.join(path.dirname(envFile), STATE_FILE_NAME),
      )!,
      remindHours: remindHours(values),
      hostName: values.SDLC_ALERT_HOST_NAME ?? hostname,
    };
    if (!HOST_NAME.test(settings.hostName)) throw new Bad('SDLC_ALERT_HOST_NAME');
    if (settings.webhook === null && settings.email === null) throw new Bad('none');
    return { ok: true, settings };
  } catch (error) {
    if (error instanceof Bad) return { ok: false, key: error.key };
    throw error;
  }
}
