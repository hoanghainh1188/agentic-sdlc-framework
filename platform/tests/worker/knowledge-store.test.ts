// D-08 X04 PR 3a (design/ADR-M89 §2.1): how the worker opens the index of project documents.
// `SDLC_WORKER_KNOWLEDGE_DB_URL=off` → off, with a warning; a URL with a password, a query or
// another scheme is refused; the OpenBao entry missing or empty → off (`worker.knowledge_missing`);
// the password present → the store and the embedder. Never the password in a log line.
import type { GitHostAdapter, RedactedSecret, SecretEntry, SecretReader } from '@sdlc/contracts';
import { SecretsError } from '@sdlc/secrets';
import { describe, expect, it } from 'vitest';

import { openKnowledge } from '../../apps/worker/src/knowledge-store.js';
import { loadSettings, SettingsError } from '../../apps/worker/src/settings.js';

const PASSWORD = 'knowledge-password-canary';
const secret = (value: string): RedactedSecret =>
  ({ reveal: () => value, toString: () => '[redacted]' }) as RedactedSecret;

function reader(fields: Record<string, string> | 'missing' | 'down'): SecretReader {
  return {
    read: (path) => {
      expect(path).toBe('worker/knowledge-db');
      if (fields === 'missing') return Promise.reject(new SecretsError('secrets.not_found'));
      if (fields === 'down') return Promise.reject(new SecretsError('secrets.permission_denied'));
      const data = Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, secret(v)]));
      return Promise.resolve({ data, version: 1 } as unknown as SecretEntry);
    },
  };
}

function logger() {
  const lines: string[] = [];
  return {
    lines,
    log: {
      log: (level: string, event: string, fields = {}) =>
        lines.push(JSON.stringify({ level, event, ...fields })),
    } as never,
  };
}

const gitHost = {} as GitHostAdapter;
const URL_OK = 'postgresql://knowledge@knowledge-db:5432/knowledge';
const settings = { url: URL_OK, secretPath: 'worker/knowledge-db' };

describe('X04 PR 3a: worker settings of the document index', () => {
  it('is off by default and takes a URL without a password', () => {
    expect(loadSettings({}).knowledge).toBeNull();
    expect(loadSettings({ SDLC_WORKER_KNOWLEDGE_DB_URL: URL_OK }).knowledge).toEqual(settings);
  });

  it.each([
    'postgresql://knowledge:secret@knowledge-db:5432/knowledge',
    'postgresql://knowledge@knowledge-db:5432/knowledge?sslmode=disable',
    'postgresql://knowledge@knowledge-db:5432/',
    'postgresql://knowledge@/knowledge',
    'mysql://knowledge@knowledge-db/knowledge',
    'on',
  ])('refuses %s', (value) => {
    expect(() => loadSettings({ SDLC_WORKER_KNOWLEDGE_DB_URL: value })).toThrow(SettingsError);
  });
});

describe('X04 PR 3a: openKnowledge', () => {
  it('off → no index, with a warning', async () => {
    const log = logger();
    const opened = await openKnowledge(
      null,
      reader('missing'),
      gitHost,
      'http://litellm:4000',
      log.log,
    );
    expect(opened.deps).toBeUndefined();
    expect(log.lines.map((l) => (JSON.parse(l) as { event: string }).event)).toEqual([
      'worker.knowledge_off',
    ]);
    await opened.close();
  });

  it.each([
    ['no entry', 'missing' as const],
    ['an empty password', { password: '' }],
    ['no password field', { other: 'x' }],
  ])('%s → no index, worker.knowledge_missing', async (_name, fields) => {
    const log = logger();
    const opened = await openKnowledge(
      settings,
      reader(fields),
      gitHost,
      'http://litellm:4000',
      log.log,
    );
    expect(opened.deps).toBeUndefined();
    expect(log.lines.map((l) => (JSON.parse(l) as { event: string }).event)).toEqual([
      'worker.knowledge_missing',
    ]);
  });

  it('OpenBao refusing → the error, not a silent off', async () => {
    const log = logger();
    await expect(
      openKnowledge(settings, reader('down'), gitHost, 'http://litellm:4000', log.log),
    ).rejects.toBeInstanceOf(SecretsError);
  });

  it('the password present → the store and the embedder; never the password in a log', async () => {
    const log = logger();
    const opened = await openKnowledge(
      settings,
      reader({ password: PASSWORD }),
      gitHost,
      'http://litellm:4000',
      log.log,
    );
    expect(opened.deps?.store).toBeDefined();
    expect(opened.deps?.embedder).toBeDefined();
    expect(opened.deps?.gitHost).toBe(gitHost);
    expect(log.lines.join('\n')).not.toContain(PASSWORD);
    await opened.close();
  });
});
