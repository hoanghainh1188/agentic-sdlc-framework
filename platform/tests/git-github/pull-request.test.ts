// D-08 C08 AC1, design/ADR-M38 §2.4, D-03 §7.1: the adapter opens the pull request of an agent
// branch with a token of its own that may write pull requests (the adapter's cached token stays
// read-only), and finds an open one first so a repeated call never opens a second. Against the
// in-process GitHub stub.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { startHarness, type Harness } from './helpers';
import { pull, REPO } from './stub-github';

let h: Harness;

beforeEach(async () => {
  h = await startHarness();
});

afterEach(async () => {
  await h.stub.stop();
});

const HEAD = 'agent/INT-2026-0007';
const INPUT = { head: HEAD, base: 'main', title: 'INT-2026-0007: changes', body: 'Body.' };

describe('openPullRequest (C08 AC1)', () => {
  it('opens a ready pull request with its own pull_requests:write token', async () => {
    h.stub.on('POST', '/repos/acme/shop/pulls', {
      status: 201,
      body: pull(7, '2026-09-26T07:00:00Z'),
    });
    const pr = await h.adapter().openPullRequest(REPO, INPUT);
    expect(pr).toMatchObject({ number: 7, state: 'open', headRef: HEAD, baseRef: 'main' });

    const [request] = h.stub.requestsTo('POST', '/repos/acme/shop/pulls');
    expect(request?.body).toEqual({
      title: INPUT.title,
      body: INPUT.body,
      head: HEAD,
      base: 'main',
      draft: false,
      maintainer_can_modify: false,
    });
    // The call's token: minted for this call, for the one repository, pull requests write only.
    const minted = h.stub.issuedTokens.find(
      (t) => request?.headers.authorization === `Bearer ${t.token}`,
    );
    expect(minted?.body).toEqual({
      repositories: ['shop'],
      permissions: { pull_requests: 'write' },
    });
  });

  it('refuses bad input before any call (branch names, empty or long text)', async () => {
    const adapter = h.adapter();
    for (const bad of [
      { ...INPUT, head: '../main' },
      { ...INPUT, base: '' },
      { ...INPUT, title: ' ' },
      { ...INPUT, body: '' },
      { ...INPUT, title: 'x'.repeat(257) },
    ]) {
      await expect(adapter.openPullRequest(REPO, bad)).rejects.toMatchObject({
        code: 'invalid_input',
      });
    }
    await expect(
      adapter.openPullRequest(REPO, { ...INPUT, body: 'x'.repeat(65_537) }),
    ).rejects.toMatchObject({ code: 'body_too_large' });
    expect(h.stub.requests).toHaveLength(0);
  });

  it('refuses an answer for another branch', async () => {
    h.stub.on('POST', '/repos/acme/shop/pulls', {
      status: 201,
      body: { ...pull(7, '2026-09-26T07:00:00Z'), head: { ref: 'other', sha: 'a'.repeat(40) } },
    });
    await expect(h.adapter().openPullRequest(REPO, INPUT)).rejects.toMatchObject({
      code: 'invalid_response',
    });
  });

  it('passes a refusal of GitHub on as a code (for example 422: no commits between)', async () => {
    h.stub.on('POST', '/repos/acme/shop/pulls', {
      status: 422,
      body: { message: 'Validation Failed' },
    });
    await expect(h.adapter().openPullRequest(REPO, INPUT)).rejects.toMatchObject({
      name: 'GitHostError',
    });
  });
});

describe('findOpenPullRequest (C08 AC1)', () => {
  it('finds the open pull request from the branch, read again by number', async () => {
    h.stub.on('GET', '/repos/acme/shop/pulls', (req) => {
      expect(req.query.get('head')).toBe(`acme:${HEAD}`);
      expect(req.query.get('base')).toBe('main');
      expect(req.query.get('state')).toBe('open');
      return { body: [pull(7, '2026-09-26T07:00:00Z')] };
    });
    h.stub.on('GET', '/repos/acme/shop/pulls/7', { body: pull(7, '2026-09-26T07:00:00Z') });
    expect(await h.adapter().findOpenPullRequest(REPO, HEAD, 'main')).toMatchObject({
      number: 7,
      changedFiles: 2,
    });
  });

  it('returns null when there is none, and refuses two matches', async () => {
    h.stub.on('GET', '/repos/acme/shop/pulls', { body: [] });
    expect(await h.adapter().findOpenPullRequest(REPO, HEAD, 'main')).toBeNull();
    h.stub.on('GET', '/repos/acme/shop/pulls', {
      body: [
        pull(7, '2026-09-26T07:00:00Z'),
        { ...pull(8, '2026-09-26T07:00:00Z'), head: { ref: HEAD, sha: 'b'.repeat(40) } },
      ],
    });
    await expect(h.adapter().findOpenPullRequest(REPO, HEAD, 'main')).rejects.toMatchObject({
      code: 'invalid_response',
    });
  });
});
