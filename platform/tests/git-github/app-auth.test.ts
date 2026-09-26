// D-08 B05 AC1: GitHub App authentication with the private key from the secret manager
// (`SecretReader`, D-03 §8.2); short-lived installation tokens limited to one repository.
// Against the in-process GitHub stub (no real GitHub).
import { inspect } from 'node:util';

import { ADAPTER_PERMISSIONS, GitHubAdapter } from '@sdlc/adapter-git-github';
import { GitHostError, type GitHostLogEvent } from '@sdlc/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  APP_CLIENT_ID,
  APP_PRIVATE_KEY_PEM,
  FakeSecrets,
  INSTALLATION_ID,
  REPO,
  StubGitHub,
  verifyJwt,
} from './stub-github';

let stub: StubGitHub;
let secrets: FakeSecrets;
let logs: { level: string; event: GitHostLogEvent; fields: Record<string, unknown> }[];

function adapter(extra: Partial<ConstructorParameters<typeof GitHubAdapter>[0]> = {}) {
  return new GitHubAdapter({
    secrets,
    apiUrl: stub.address,
    allowPlaintext: true,
    now: () => stub.now,
    sleep: () => Promise.resolve(),
    logger: { log: (level, event, fields) => logs.push({ level, event, fields: { ...fields } }) },
    ...extra,
  });
}

const TOKEN_PATH = `/app/installations/${INSTALLATION_ID}/access_tokens`;

beforeEach(async () => {
  stub = new StubGitHub();
  await stub.start();
  secrets = new FakeSecrets();
  logs = [];
  stub.on('POST', '/repos/acme/shop/issues/1/comments', { status: 201, body: { id: 1 } });
});

afterEach(async () => {
  await stub.stop();
});

describe('App JWT and the private key', () => {
  it('reads the key through SecretReader at shared/github-app and signs an RS256 JWT', async () => {
    await adapter().createIssueComment(REPO, 1, 'hello');
    expect(secrets.paths).toEqual(['shared/github-app']);
    const [lookup] = stub.requestsTo('GET', '/repos/acme/shop/installation');
    const jwt = verifyJwt(String(lookup?.headers.authorization).replace('Bearer ', ''));
    expect(jwt).not.toBeNull();
    const now = Math.floor(stub.now.getTime() / 1000);
    expect(jwt!.header).toEqual({ alg: 'RS256', typ: 'JWT' });
    expect(jwt!.claims).toEqual({ iat: now - 60, exp: now + 540, iss: APP_CLIENT_ID });
  });

  it('accepts app_id as the issuer when client_id is absent', async () => {
    secrets.data = { app_id: '123456', private_key: APP_PRIVATE_KEY_PEM };
    stub.on('GET', '/repos/acme/shop/installation', { body: { id: INSTALLATION_ID } });
    // The stub only accepts the client ID; the refusal proves the issuer came from app_id.
    await expect(adapter().createIssueComment(REPO, 1, 'x')).rejects.toMatchObject({
      code: 'auth_failed',
    });
  });

  it.each([
    ['no private key', { client_id: APP_CLIENT_ID }],
    ['no issuer', { private_key: APP_PRIVATE_KEY_PEM }],
    ['not a key', { client_id: APP_CLIENT_ID, private_key: 'not a pem' }],
    ['bad issuer', { client_id: 'has space', private_key: APP_PRIVATE_KEY_PEM }],
  ])('refuses a GitHub App entry with %s (secret_invalid)', async (_case, data) => {
    secrets.data = data;
    const error = await adapter()
      .createIssueComment(REPO, 1, 'x')
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GitHostError);
    expect(error).toMatchObject({ code: 'secret_invalid', params: { path: 'shared/github-app' } });
    expect(String((error as Error).message)).not.toContain('BEGIN');
  });

  it('reads the key again after keyCacheSeconds (rotation without restart)', async () => {
    const a = adapter({ keyCacheSeconds: 600 });
    await a.issueShortLivedToken(REPO, { permissions: { contents: 'read' } });
    await a.issueShortLivedToken(REPO, { permissions: { contents: 'read' } });
    expect(secrets.reads).toBe(1);
    stub.now = new Date(stub.now.getTime() + 601_000);
    await a.issueShortLivedToken(REPO, { permissions: { contents: 'read' } });
    expect(secrets.reads).toBe(2);
  });

  it('looks the installation up again after the App was reinstalled', async () => {
    const a = adapter();
    await a.issueShortLivedToken(REPO, { permissions: { contents: 'read' } });
    stub.on('POST', TOKEN_PATH, { status: 404, body: { message: 'Not Found' } });
    await expect(
      a.issueShortLivedToken(REPO, { permissions: { contents: 'read' } }),
    ).rejects.toMatchObject({ code: 'app_not_installed' });
    stub.on('POST', TOKEN_PATH, (req) => stub.issueToken(req.body as Record<string, unknown>));
    await a.issueShortLivedToken(REPO, { permissions: { contents: 'read' } });
    expect(stub.requestsTo('GET', '/repos/acme/shop/installation')).toHaveLength(2);
  });

  it('maps a repository without the App installed to app_not_installed', async () => {
    stub.on('GET', '/repos/acme/shop/installation', {
      status: 404,
      body: { message: 'Not Found' },
    });
    await expect(adapter().createIssueComment(REPO, 1, 'x')).rejects.toMatchObject({
      code: 'app_not_installed',
      params: { repo: 'acme/shop' },
    });
  });
});

describe('installation tokens', () => {
  it("limits the adapter's own token to one repository and read + comment permissions", async () => {
    await adapter().createIssueComment(REPO, 1, 'hello');
    expect(stub.issuedTokens).toHaveLength(1);
    expect(stub.issuedTokens[0]?.body).toEqual({
      repositories: ['shop'],
      permissions: ADAPTER_PERMISSIONS,
    });
    expect(ADAPTER_PERMISSIONS).toEqual({
      checks: 'read',
      contents: 'read',
      issues: 'write',
      pull_requests: 'read',
      statuses: 'read',
    });
  });

  it('caches the token and replaces it tokenRefreshMarginSeconds before expiry', async () => {
    const a = adapter();
    await a.createIssueComment(REPO, 1, 'a');
    await a.createIssueComment(REPO, 1, 'b');
    expect(stub.issuedTokens).toHaveLength(1);
    // 55 minutes later the token (1 hour) is inside the 5-minute margin: a new one is minted.
    stub.now = new Date(stub.now.getTime() + 55 * 60_000 + 1000);
    await a.createIssueComment(REPO, 1, 'c');
    expect(stub.issuedTokens).toHaveLength(2);
    const auths = stub
      .requestsTo('POST', '/repos/acme/shop/issues/1/comments')
      .map((r) => r.headers.authorization);
    expect(auths[0]).toBe(auths[1]);
    expect(auths[2]).not.toBe(auths[1]);
  });

  it('mints one token for concurrent calls', async () => {
    const a = adapter();
    await Promise.all([1, 2, 3].map((n) => a.createIssueComment(REPO, 1, `c${n}`)));
    expect(stub.issuedTokens).toHaveLength(1);
  });

  it('drops a token the host no longer accepts and retries once', async () => {
    const a = adapter();
    await a.createIssueComment(REPO, 1, 'a');
    stub.issuedTokens.splice(0); // the stub forgets the token: 401
    await a.createIssueComment(REPO, 1, 'b');
    expect(stub.issuedTokens).toHaveLength(1);
  });

  it('issueShortLivedToken: one repository, exactly the requested scope, never cached', async () => {
    const a = adapter();
    const scope = { permissions: { contents: 'write', pull_requests: 'read' } } as const;
    const first = await a.issueShortLivedToken(REPO, scope);
    const second = await a.issueShortLivedToken(REPO, scope);
    expect(stub.issuedTokens.map((t) => t.body)).toEqual([
      { repositories: ['shop'], permissions: scope.permissions },
      { repositories: ['shop'], permissions: scope.permissions },
    ]);
    expect(first.token.reveal()).not.toBe(second.token.reveal());
    expect(first).toMatchObject({
      repo: REPO,
      permissions: { contents: 'write', pull_requests: 'read' },
      expiresAt: '2026-09-26T09:00:00.000Z',
    });
  });

  it.each([
    ['no permission', {}],
    ['an unknown permission', { administration: 'write' }],
    ['a bad level', { contents: 'admin' }],
  ])('issueShortLivedToken refuses %s', async (_case, permissions) => {
    await expect(
      adapter().issueShortLivedToken(REPO, { permissions } as never),
    ).rejects.toMatchObject({ code: 'invalid_input', params: { field: 'scope' } });
    expect(stub.issuedTokens).toHaveLength(0);
  });

  it.each([
    ['more repositories', { repositories: [{ name: 'shop' }, { name: 'other' }] }],
    ['another repository', { repositories: [{ name: 'other' }] }],
    ['all repositories (no list)', { repositories: undefined }],
    ['wider permissions', { permissions: { metadata: 'read', contents: 'write' } }],
    [
      'an extra permission',
      { permissions: { metadata: 'read', contents: 'read', administration: 'write' } },
    ],
  ])('refuses a token answer with %s', async (_case, override) => {
    stub.on('POST', TOKEN_PATH, (req) => {
      const answer = stub.issueToken(req.body as Record<string, unknown>);
      return { ...answer, body: { ...(answer.body as object), ...override } };
    });
    await expect(
      adapter().issueShortLivedToken(REPO, { permissions: { contents: 'read' } }),
    ).rejects.toMatchObject({ code: 'invalid_response' });
  });

  it('refuses repository names that could change the URL path', async () => {
    for (const bad of [
      { owner: 'acme', name: '../x' },
      { owner: 'ac/me', name: 'shop' },
      { owner: 'acme', name: '..' },
      { owner: '', name: 'shop' },
    ]) {
      await expect(adapter().createIssueComment(bad, 1, 'x')).rejects.toMatchObject({
        code: 'invalid_input',
      });
    }
    expect(stub.requests).toHaveLength(0);
  });
});

describe('no secret in logs, errors or serialised values', () => {
  it('keeps tokens and the key out of logs, String(), JSON and inspect', async () => {
    const a = adapter();
    const t = await a.issueShortLivedToken(REPO, { permissions: { contents: 'read' } });
    const raw = t.token.reveal();
    expect(raw).toMatch(/^ghs_/);
    const asText = (t.token as unknown as { toString(): string }).toString();
    for (const shown of [asText, JSON.stringify(t), inspect(t, { depth: 5 })]) {
      expect(shown).not.toContain(raw);
    }
    const logged = JSON.stringify(logs);
    expect(logged).not.toContain(raw);
    expect(logged).not.toContain('BEGIN RSA');
    expect(logged).not.toMatch(/eyJ[\w-]+\.eyJ/); // no JWT
    expect(logs.map((l) => l.event)).toEqual(['git_host.key_loaded', 'git_host.token_issued']);
    expect(logs[1]?.fields).toEqual({
      repo: 'acme/shop',
      expires_at: '2026-09-26T09:00:00.000Z',
      permissions: 'contents:read',
    });
  });
});
