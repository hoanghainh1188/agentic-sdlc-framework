// D-08 B05 AC2: webhook signature check kept ready for later (ADR-M11). HMAC-SHA-256 of the raw
// body; webhook events map to the same `GitEvent` (same IDs) as polling.
import { createHmac } from 'node:crypto';

import { GitHubAdapter } from '@sdlc/adapter-git-github';
import { describe, expect, it } from 'vitest';

import { checkRun, comment, FakeSecrets, pull, review, secret, SHA_A, user } from './stub-github';

const SECRET = 'webhook-test-secret';
const adapter = new GitHubAdapter({ secrets: new FakeSecrets(), webhookSecret: secret(SECRET) });
const repository = { name: 'shop', owner: { login: 'acme' } };

function signed(event: string, payload: unknown, key = SECRET) {
  const body = Buffer.from(JSON.stringify(payload));
  const signature = `sha256=${createHmac('sha256', key).update(body).digest('hex')}`;
  return {
    headers: {
      'X-GitHub-Event': event,
      'X-Hub-Signature-256': signature,
      'X-GitHub-Delivery': 'd1',
    },
    body,
  };
}

describe('signature', () => {
  const ok = signed('issue_comment', {
    action: 'created',
    repository,
    issue: { number: 3, pull_request: { url: 'x' } },
    comment: comment(10, 3, '2026-09-26T08:01:00Z', '/approve G7', { pull: true }),
  });

  it('accepts a correct signature (header names in any case)', () => {
    const lower = Object.fromEntries(
      Object.entries(ok.headers).map(([k, v]) => [k.toLowerCase(), v]),
    );
    expect(adapter.verifyWebhook(lower, ok.body).id).toBe('github:comment:10');
    expect(adapter.verifyWebhook(ok.headers, ok.body).source).toBe('webhook');
  });

  it.each([
    ['a missing header', (h: Record<string, string>) => ({ ...h, 'X-Hub-Signature-256': '' })],
    [
      'a SHA-1 signature',
      (h: Record<string, string>) => ({ ...h, 'X-Hub-Signature-256': 'sha1=abc' }),
    ],
    ['another secret', () => signed('issue_comment', {}, 'wrong').headers],
    [
      'a short hex value',
      (h: Record<string, string>) => ({ ...h, 'X-Hub-Signature-256': 'sha256=ab' }),
    ],
  ])('refuses %s', (_case, change) => {
    expect(() => adapter.verifyWebhook(change(ok.headers), ok.body)).toThrow(
      expect.objectContaining({ code: 'webhook_bad_signature' }),
    );
  });

  it('refuses a body changed after signing', () => {
    const tampered = Buffer.from(ok.body.toString().replace('/approve G7', '/approve G8'));
    expect(() => adapter.verifyWebhook(ok.headers, tampered)).toThrow(
      expect.objectContaining({ code: 'webhook_bad_signature' }),
    );
  });

  it('refuses everything when no webhook secret is configured (MVP default)', () => {
    const noSecret = new GitHubAdapter({ secrets: new FakeSecrets() });
    expect(() => noSecret.verifyWebhook(ok.headers, ok.body)).toThrow(
      expect.objectContaining({ code: 'webhook_disabled' }),
    );
  });
});

describe('events: same shape and IDs as polling', () => {
  it('pull_request_review submitted', () => {
    const r = signed('pull_request_review', {
      action: 'submitted',
      repository,
      pull_request: pull(7, '2026-09-26T08:00:00Z'),
      review: review(70, user(3003, 'person-b'), 'approved', '2026-09-26T08:00:00Z'),
    });
    expect(adapter.verifyWebhook(r.headers, r.body)).toMatchObject({
      kind: 'review_submitted',
      id: 'github:review:70',
      prNumber: 7,
      state: 'approved',
      commitSha: SHA_A,
    });
  });

  it('check_run completed', () => {
    const r = signed('check_run', {
      action: 'completed',
      repository,
      check_run: {
        ...checkRun(501, 'lint', 'failure', '2026-09-26T08:00:00Z'),
        pull_requests: [{ number: 7 }],
      },
    });
    expect(adapter.verifyWebhook(r.headers, r.body)).toMatchObject({
      id: 'github:check_run:501',
      prNumbers: [7],
      conclusion: 'failure',
    });
  });

  it('status', () => {
    const r = signed('status', {
      id: 601,
      sha: SHA_A,
      context: 'ci/build',
      state: 'success',
      target_url: null,
      created_at: '2026-09-26T08:00:00Z',
      updated_at: '2026-09-26T08:00:00Z',
      commit: { html_url: `https://github.com/acme/shop/commit/${SHA_A}` },
      repository,
    });
    expect(adapter.verifyWebhook(r.headers, r.body)).toMatchObject({
      id: 'github:status:601',
      url: `https://github.com/acme/shop/commit/${SHA_A}`,
    });
  });

  it.each([
    ['ping', { zen: 'x', repository }],
    ['issue_comment', { action: 'edited', repository }],
    ['check_run', { action: 'created', repository, check_run: checkRun(1, 'x', null, null) }],
  ])('refuses the unhandled event %s', (event, payload) => {
    const r = signed(event, payload);
    expect(() => adapter.verifyWebhook(r.headers, r.body)).toThrow(
      expect.objectContaining({ code: 'unsupported_event' }),
    );
  });
});
