// `pnpm alerts` (O03, design/ADR-M101): the message. Every word comes from the catalog; it holds
// the host name, the check, its subject (a service, a certificate, a folder), doctor's text and
// fix, and nothing else: no env value, no log line, no command output.
import { describe, expect, it } from 'vitest';

import type { AlertItem } from '../../deploy/alerts/src/decide.js';
import { buildMessage, testMessage } from '../../deploy/alerts/src/message.js';

const NOW = new Date('2026-10-30T10:00:00.000Z');
const items: AlertItem[] = [
  {
    kind: 'problem',
    result: {
      id: 'services.health',
      subject: 'sdlc-api',
      status: 'failed',
      text: { key: 'doctor.services.unhealthy', params: { state: 'running', health: 'unhealthy' } },
      fix: { key: 'doctor.fix.logs', params: { service: 'sdlc-api' } },
    },
  },
  {
    kind: 'resolved',
    result: { id: 'openbao.state', status: 'ok', text: { key: 'doctor.openbao.unsealed' } },
  },
];

describe('buildMessage', () => {
  it('the text: a header with the host and counts, one line per item with its fix', () => {
    const m = buildMessage(items, 'sdlc-server-1', NOW);
    const lines = m.text.split('\n');
    expect(lines[0]).toContain('sdlc-server-1');
    expect(lines[0]).toContain('1 problem');
    expect(lines[0]).toContain('1 resolved');
    expect(m.text).toContain('services.health (sdlc-api)');
    expect(m.text).toContain('openbao.state');
    expect(m.text).not.toMatch(/\{[a-z_]+\}/);
    expect(m.subject).toContain('sdlc-server-1');
  });

  it('the JSON: codes and texts only, a fixed shape', () => {
    const m = buildMessage(items, 'sdlc-server-1', NOW);
    expect(m.json).toEqual({
      version: 1,
      host: 'sdlc-server-1',
      sent_at: NOW.toISOString(),
      items: [
        expect.objectContaining({
          kind: 'problem',
          check: 'services.health',
          subject: 'sdlc-api',
          status: 'failed',
        }),
        expect.objectContaining({
          kind: 'resolved',
          check: 'openbao.state',
          subject: null,
          status: 'ok',
          fix: null,
        }),
      ],
    });
  });

  it('a test message says it is a test', () => {
    const m = testMessage('sdlc-server-1', NOW);
    expect(m.text).toContain('sdlc-server-1');
    expect(m.json).toMatchObject({ version: 1, host: 'sdlc-server-1', items: [], test: true });
  });
});
