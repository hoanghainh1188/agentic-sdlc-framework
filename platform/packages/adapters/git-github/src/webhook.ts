// Webhook check (D-08 B05 AC2: "kept ready for later", ADR-M11, design/ADR-M23 §2.5). Not wired
// to any HTTP route in the MVP. When webhooks are enabled, the API passes the raw request body
// and headers here and feeds the result to the same handler as polling.
//
// The signature is `X-Hub-Signature-256: sha256=<hex>`, an HMAC-SHA-256 of the raw body with the
// webhook secret, compared in constant time. Nothing in the body is read before the check passes.
// Replays: the event ID is the same as for polling (for example `github:comment:123`), so the
// handler's de-duplication by event ID also drops a replayed delivery.
import { createHmac, timingSafeEqual } from 'node:crypto';

import { GitHostError, type GitEvent, type RedactedSecret, type RepoRef } from '@sdlc/contracts';

import { arr, checkRepo, int, obj, sha, str } from './json.js';
import {
  checkRunEvent,
  commentEvent,
  pullClosedEvent,
  reviewEvent,
  statusEvent,
} from './mapping.js';

const SIGNATURE = /^sha256=([0-9a-f]{64})$/;

function header(headers: Record<string, string>, name: string): string | undefined {
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === name) return v;
  }
  return undefined;
}

export function verifyWebhookRequest(
  secret: RedactedSecret | undefined,
  headers: Record<string, string>,
  rawBody: Buffer,
): GitEvent {
  if (!secret) throw new GitHostError('webhook_disabled');
  const match = SIGNATURE.exec(header(headers, 'x-hub-signature-256') ?? '');
  if (!match?.[1] || !Buffer.isBuffer(rawBody)) throw new GitHostError('webhook_bad_signature');
  const expected = createHmac('sha256', secret.reveal()).update(rawBody).digest();
  const given = Buffer.from(match[1], 'hex');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    throw new GitHostError('webhook_bad_signature');
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody.toString('utf8'));
  } catch {
    throw new GitHostError('invalid_response', { field: 'body' });
  }
  const body = obj(payload, 'payload');
  const event = header(headers, 'x-github-event') ?? '';
  const action = typeof body.action === 'string' ? body.action : '';
  const repo = repoOf(body);

  let result: GitEvent | null = null;
  if (event === 'issue_comment' && action === 'created') {
    const issue = obj(body.issue, 'issue');
    result = commentEvent(repo, body.comment, 'webhook', issue.pull_request !== undefined);
  } else if (
    event === 'pull_request_review' &&
    (action === 'submitted' || action === 'dismissed')
  ) {
    const pr = int(obj(body.pull_request, 'pull_request').number, 'pull_request.number');
    result = reviewEvent(repo, pr, body.review, 'webhook');
  } else if (event === 'pull_request' && action === 'closed') {
    // E01: the merge event (or a close without merge).
    result = pullClosedEvent(repo, body.pull_request, 'webhook');
  } else if (event === 'check_run' && action === 'completed') {
    const run = obj(body.check_run, 'check_run');
    const prs = arr(run.pull_requests ?? [], 'check_run.pull_requests').map((p) =>
      int(obj(p, 'pull_request').number, 'pull_request.number'),
    );
    result = checkRunEvent(repo, run, prs, 'webhook');
  } else if (event === 'status') {
    const commit = obj(body.commit, 'commit');
    result = statusEvent(
      repo,
      sha(body.sha, 'sha'),
      { ...body, url: commit.html_url },
      [],
      'webhook',
    );
  }
  if (!result) throw new GitHostError('unsupported_event');
  return result;
}

function repoOf(body: Readonly<Record<string, unknown>>): RepoRef {
  const repository = obj(body.repository, 'repository');
  const owner = obj(repository.owner, 'repository.owner');
  try {
    return checkRepo({
      owner: str(owner.login, 'repository.owner.login'),
      name: str(repository.name, 'repository.name'),
    });
  } catch {
    throw new GitHostError('invalid_response', { field: 'repository' });
  }
}
