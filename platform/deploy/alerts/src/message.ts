// The message of `pnpm alerts` (D-08 O03, design/ADR-M101). Every word comes from the catalog. It
// holds the host name, the check ID, its subject (a service, a certificate, a folder), doctor's text
// and fix, and nothing else: no env value, no log line, no command output.
import { t } from '@sdlc/messages';

import type { Text } from '../../doctor/dist/types.js';

import type { AlertItem } from './decide.js';

export interface AlertMessage {
  /** The e-mail subject. */
  readonly subject: string;
  /** Plain text: the e-mail body and the webhook `text`. */
  readonly text: string;
  /** The webhook body of the format `json`. */
  readonly json: Readonly<Record<string, unknown>>;
}

const say = (x: Text): string => t(x.key, x.params);
const utc = (now: Date): string => now.toISOString().slice(0, 16).replace('T', ' ');

function counts(items: readonly AlertItem[]) {
  const resolved = items.filter((i) => i.kind === 'resolved').length;
  return { problems: items.length - resolved, resolved };
}

function lines(item: AlertItem): string[] {
  const r = item.result;
  const mark =
    item.kind === 'resolved'
      ? t('alerts.kind.resolved')
      : t(item.kind === 'problem' ? 'alerts.kind.problem' : 'alerts.kind.reminder', {
          status: r.status,
        });
  const subject = r.subject ? ` (${r.subject})` : '';
  const out = [t('alerts.line', { mark, check: r.id, subject, text: say(r.text) })];
  if (item.kind !== 'resolved' && r.fix) out.push(t('alerts.fix', { fix: say(r.fix) }));
  return out;
}

export function buildMessage(items: readonly AlertItem[], host: string, now: Date): AlertMessage {
  const c = counts(items);
  const header = t('alerts.header', { host, ...c, time: utc(now) });
  return {
    subject: t('alerts.subject', { host, ...c }),
    text: [header, '', ...items.flatMap(lines)].join('\n'),
    json: {
      version: 1,
      host,
      sent_at: now.toISOString(),
      items: items.map((i) => ({
        kind: i.kind,
        check: i.result.id,
        subject: i.result.subject ?? null,
        status: i.result.status,
        message: say(i.result.text),
        fix: i.kind !== 'resolved' && i.result.fix ? say(i.result.fix) : null,
      })),
    },
  };
}

/** `pnpm alerts --test`: proves a channel works, without running the checks. */
export function testMessage(host: string, now: Date): AlertMessage {
  return {
    subject: t('alerts.test_subject', { host }),
    text: t('alerts.test_header', { host, time: utc(now) }),
    json: { version: 1, host, sent_at: now.toISOString(), items: [], test: true },
  };
}
