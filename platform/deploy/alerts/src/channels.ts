// The channels of `pnpm alerts` (D-08 O03, design/ADR-M101): a chat webhook and e-mail through the
// server's `sendmail`. The webhook URL is read from its file only here, used once and never
// printed, logged or kept; the answer's body is never read. A failure is a code, never a message
// that could hold the URL.
import { spawn } from 'node:child_process';
import fs from 'node:fs';

import type { AlertMessage } from './message.js';
import type { EmailSettings, WebhookSettings } from './settings.js';

export type ChannelProblem =
  | 'webhook_file_missing'
  | 'webhook_file_mode'
  | 'webhook_url'
  | 'webhook_status'
  | 'webhook_unreachable'
  | 'email_failed';

export type Delivery = 'sent' | ChannelProblem;

/** POSTs a body; the HTTP status, or null when there was no answer. */
export type Post = (url: string, body: string, contentType: string) => Promise<number | null>;

const TIMEOUT_MS = 10_000;

/** The real POST: no redirect followed (it could leave HTTPS), a timeout, the body discarded. */
export const httpsPost: Post = async (url, body, contentType) => {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': contentType },
      body,
      redirect: 'error',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    await res.body?.cancel();
    return res.status;
  } catch {
    return null;
  }
};

function readUrl(file: string): { url: string } | { problem: ChannelProblem } {
  let mode: number;
  let text: string;
  try {
    mode = fs.statSync(file).mode;
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return { problem: 'webhook_file_missing' };
  }
  if ((mode & 0o077) !== 0) return { problem: 'webhook_file_mode' };
  let url: URL;
  try {
    url = new URL(text.trim());
  } catch {
    return { problem: 'webhook_url' };
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') {
    return { problem: 'webhook_url' };
  }
  return { url: url.href };
}

export async function sendWebhook(
  settings: WebhookSettings,
  message: AlertMessage,
  post: Post = httpsPost,
): Promise<Delivery> {
  const read = readUrl(settings.file);
  if ('problem' in read) return read.problem;
  const body = JSON.stringify(settings.format === 'json' ? message.json : { text: message.text });
  const status = await post(read.url, body, 'application/json');
  if (status === null) return 'webhook_unreachable';
  return status >= 200 && status < 300 ? 'sent' : 'webhook_status';
}

/** The mail for `sendmail -t`: fixed headers; addresses were checked by `settings.ts`. */
export function mailText(settings: EmailSettings, message: AlertMessage): string {
  return [
    `To: ${settings.to.join(', ')}`,
    ...(settings.from ? [`From: ${settings.from}`] : []),
    `Subject: ${message.subject}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: 8bit',
    '',
    message.text,
    '',
  ].join('\n');
}

export function sendEmail(settings: EmailSettings, message: AlertMessage): Promise<Delivery> {
  return new Promise((resolve) => {
    // -t: recipients from the headers; -oi: a line with a single dot does not end the mail.
    const child = spawn(settings.sendmail, ['-t', '-oi'], { stdio: ['pipe', 'ignore', 'ignore'] });
    child.on('error', () => resolve('email_failed'));
    child.on('close', (code) => resolve(code === 0 ? 'sent' : 'email_failed'));
    child.stdin.on('error', () => undefined);
    child.stdin.end(mailText(settings, message));
  });
}
