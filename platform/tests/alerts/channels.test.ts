// `pnpm alerts` (O03, design/ADR-M101): the channels. The webhook URL is read from a file of mode
// 600 and only `https://` without a user name is accepted; it is never printed, and the answer's
// body is never read. E-mail goes through the server's `sendmail` with fixed headers; an address
// with a line break or a header character is refused.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { sendEmail, sendWebhook, type Post } from '../../deploy/alerts/src/channels.js';
import { buildMessage } from '../../deploy/alerts/src/message.js';

const NOW = new Date('2026-10-30T10:00:00.000Z');
const MESSAGE = buildMessage(
  [
    {
      kind: 'problem',
      result: {
        id: 'openbao.state',
        status: 'failed',
        text: { key: 'doctor.openbao.sealed' },
        fix: { key: 'doctor.fix.unseal' },
      },
    },
  ],
  'sdlc-server-1',
  NOW,
);
const URL_TEXT = 'https://hooks.example.test/services/T000/B000/secret-part';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});
function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'alerts-'));
  dirs.push(d);
  return d;
}
function urlFile(content: string, mode = 0o600): string {
  const file = path.join(tmp(), 'webhook-url');
  fs.writeFileSync(file, content, { mode });
  fs.chmodSync(file, mode);
  return file;
}
function recorder(status: number | null = 200) {
  const calls: { url: string; body: string; contentType: string }[] = [];
  const post: Post = (url, body, contentType) => {
    calls.push({ url, body, contentType });
    return Promise.resolve(status);
  };
  return { calls, post };
}

describe('sendWebhook', () => {
  it('posts {"text": …} for the text format and the JSON shape for json', async () => {
    const r = recorder();
    expect(
      await sendWebhook({ file: urlFile(`${URL_TEXT}\n`), format: 'text' }, MESSAGE, r.post),
    ).toBe('sent');
    expect(r.calls[0]).toMatchObject({ url: URL_TEXT, contentType: 'application/json' });
    expect(JSON.parse(r.calls[0]!.body)).toEqual({ text: MESSAGE.text });
    await sendWebhook({ file: urlFile(URL_TEXT), format: 'json' }, MESSAGE, r.post);
    expect(JSON.parse(r.calls[1]!.body)).toEqual(MESSAGE.json);
  });

  it('refuses a file others can read, a missing file, http:// and a user name in the URL', async () => {
    const r = recorder();
    expect(
      await sendWebhook({ file: urlFile(URL_TEXT, 0o644), format: 'text' }, MESSAGE, r.post),
    ).toBe('webhook_file_mode');
    expect(await sendWebhook({ file: '/nonexistent/url', format: 'text' }, MESSAGE, r.post)).toBe(
      'webhook_file_missing',
    );
    for (const bad of [
      'http://hooks.example.test/x',
      'https://user:pw@hooks.example.test/x',
      'not a url',
      '',
    ]) {
      expect(await sendWebhook({ file: urlFile(bad), format: 'text' }, MESSAGE, r.post), bad).toBe(
        'webhook_url',
      );
    }
    expect(r.calls).toEqual([]);
  });

  it('a non-2xx answer or no answer is a failure, never "sent"', async () => {
    const file = urlFile(URL_TEXT);
    expect(await sendWebhook({ file, format: 'text' }, MESSAGE, recorder(500).post)).toBe(
      'webhook_status',
    );
    expect(await sendWebhook({ file, format: 'text' }, MESSAGE, recorder(null).post)).toBe(
      'webhook_unreachable',
    );
  });
});

describe('sendEmail', () => {
  function fakeSendmail(exit = 0): { bin: string; out: string } {
    const dir = tmp();
    const out = path.join(dir, 'mail.txt');
    const bin = path.join(dir, 'sendmail');
    fs.writeFileSync(bin, `#!/bin/sh\necho "$@" > "${out}.args"\ncat > "${out}"\nexit ${exit}\n`, {
      mode: 0o700,
    });
    return { bin, out };
  }

  it('runs sendmail -t -oi with fixed headers and the text as the body', async () => {
    const { bin, out } = fakeSendmail();
    const email = {
      to: ['ops@example.test', 'b@example.test'],
      from: 'sdlc@example.test',
      sendmail: bin,
    };
    expect(await sendEmail(email, MESSAGE)).toBe('sent');
    expect(fs.readFileSync(`${out}.args`, 'utf8').trim()).toBe('-t -oi');
    const mail = fs.readFileSync(out, 'utf8');
    expect(mail).toMatch(/^To: ops@example\.test, b@example\.test\n/);
    expect(mail).toContain('From: sdlc@example.test\n');
    expect(mail).toContain(`Subject: ${MESSAGE.subject}\n`);
    expect(mail).toContain('Content-Type: text/plain; charset=utf-8\n');
    expect(mail.endsWith(`\n\n${MESSAGE.text}\n`)).toBe(true);
  });

  it('without a sender, sendmail chooses it (no From line)', async () => {
    const { bin, out } = fakeSendmail();
    await sendEmail({ to: ['ops@example.test'], from: null, sendmail: bin }, MESSAGE);
    expect(fs.readFileSync(out, 'utf8')).not.toContain('From:');
  });

  it('a failing or missing sendmail is a failure', async () => {
    expect(
      await sendEmail(
        { to: ['ops@example.test'], from: null, sendmail: fakeSendmail(75).bin },
        MESSAGE,
      ),
    ).toBe('email_failed');
    expect(
      await sendEmail(
        { to: ['ops@example.test'], from: null, sendmail: '/nonexistent/sendmail' },
        MESSAGE,
      ),
    ).toBe('email_failed');
  });
});
