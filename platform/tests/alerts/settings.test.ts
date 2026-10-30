// `pnpm alerts` (O03, design/ADR-M101): the settings in the env file. Only the `SDLC_ALERT_*` keys
// are read; at least one channel is needed; a bad value is refused with its key, never guessed.
import { describe, expect, it } from 'vitest';

import { alertSettings, ALERT_KEYS } from '../../deploy/alerts/src/settings.js';

const ENV = '/srv/sdlc/platform/deploy/.env';
const HOST = 'sdlc-server-1';

describe('alertSettings', () => {
  it('a webhook only: the defaults for the rest', () => {
    expect(alertSettings({ SDLC_ALERT_WEBHOOK_FILE: '/etc/sdlc/webhook-url' }, ENV, HOST)).toEqual({
      ok: true,
      settings: {
        webhook: { file: '/etc/sdlc/webhook-url', format: 'text' },
        email: null,
        stateFile: '/srv/sdlc/platform/deploy/alerts-state.json',
        remindHours: 24,
        hostName: HOST,
      },
    });
  });

  it('e-mail only, with every setting', () => {
    const r = alertSettings(
      {
        SDLC_ALERT_EMAIL_TO: 'ops@example.test, b@example.test',
        SDLC_ALERT_EMAIL_FROM: 'sdlc@example.test',
        SDLC_ALERT_SENDMAIL: '/usr/lib/sendmail',
        SDLC_ALERT_STATE_FILE: '/var/lib/sdlc/alerts.json',
        SDLC_ALERT_REMIND_HOURS: '12',
        SDLC_ALERT_HOST_NAME: 'shop-platform',
      },
      ENV,
      HOST,
    );
    expect(r).toEqual({
      ok: true,
      settings: {
        webhook: null,
        email: {
          to: ['ops@example.test', 'b@example.test'],
          from: 'sdlc@example.test',
          sendmail: '/usr/lib/sendmail',
        },
        stateFile: '/var/lib/sdlc/alerts.json',
        remindHours: 12,
        hostName: 'shop-platform',
      },
    });
  });

  it.each([
    // No channel at all.
    [{}, 'none'],
    [{ SDLC_ALERT_WEBHOOK_FILE: 'relative/url' }, 'SDLC_ALERT_WEBHOOK_FILE'],
    [
      { SDLC_ALERT_WEBHOOK_FILE: '/u', SDLC_ALERT_WEBHOOK_FORMAT: 'xml' },
      'SDLC_ALERT_WEBHOOK_FORMAT',
    ],
    [{ SDLC_ALERT_EMAIL_TO: 'ops@example.test\nBcc: x@evil.test' }, 'SDLC_ALERT_EMAIL_TO'],
    [{ SDLC_ALERT_EMAIL_TO: 'not-an-address' }, 'SDLC_ALERT_EMAIL_TO'],
    [
      { SDLC_ALERT_EMAIL_TO: 'a@example.test', SDLC_ALERT_EMAIL_FROM: 'x y@z' },
      'SDLC_ALERT_EMAIL_FROM',
    ],
    [
      { SDLC_ALERT_EMAIL_TO: 'a@example.test', SDLC_ALERT_SENDMAIL: 'sendmail' },
      'SDLC_ALERT_SENDMAIL',
    ],
    [{ SDLC_ALERT_WEBHOOK_FILE: '/u', SDLC_ALERT_REMIND_HOURS: '0' }, 'SDLC_ALERT_REMIND_HOURS'],
    [
      { SDLC_ALERT_WEBHOOK_FILE: '/u', SDLC_ALERT_STATE_FILE: 'state.json' },
      'SDLC_ALERT_STATE_FILE',
    ],
    [{ SDLC_ALERT_WEBHOOK_FILE: '/u', SDLC_ALERT_HOST_NAME: 'a b' }, 'SDLC_ALERT_HOST_NAME'],
  ])('refuses %j: %s', (values, key) => {
    expect(alertSettings(values, ENV, HOST)).toEqual({ ok: false, key });
  });

  it('reads only SDLC_ALERT_* keys, and no key names a secret value', () => {
    expect(ALERT_KEYS.every((k) => k.startsWith('SDLC_ALERT_'))).toBe(true);
    expect(ALERT_KEYS.join(' ')).not.toMatch(/PASSWORD|TOKEN|SECRET|_URL\b/);
  });
});
