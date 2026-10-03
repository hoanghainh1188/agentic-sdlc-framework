// D-08 C11 AC2, design/ADR-M42 §2.4, D-03 §7.1: the adapter revokes an installation token with the
// token itself (`DELETE /installation/token`), so the runner, which holds no App key, can end the
// run's clone and push tokens right after their use. Against the in-process GitHub stub.
import { Redacted } from '@sdlc/secrets';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { startHarness, type Harness } from './helpers';

let h: Harness;

beforeEach(async () => {
  h = await startHarness();
});

afterEach(async () => {
  await h.stub.stop();
});

/** A token the stub issued (the stub refuses unknown tokens with 401). */
function issued(): string {
  return (h.stub.issueToken({}).body as { token: string }).token;
}

describe('revokeShortLivedToken (C11 AC2)', () => {
  it('sends DELETE /installation/token with the token itself and needs no App key', async () => {
    const token = issued();
    h.stub.on('DELETE', '/installation/token', { status: 204 });
    await h.adapter().revokeShortLivedToken(new Redacted(token));
    const [request] = h.stub.requestsTo('DELETE', '/installation/token');
    expect(request?.headers.authorization).toBe(`Bearer ${token}`);
    // No App key read, no installation token minted by the adapter.
    expect(h.secrets.reads).toBe(0);
    expect(h.stub.issuedTokens).toHaveLength(1);
  });

  it('counts an already revoked or expired token (401) as revoked', async () => {
    // The stub answers 401 for a token it does not know.
    await expect(
      h.adapter().revokeShortLivedToken(new Redacted(['ghs', 'unknown0001'].join('_'))),
    ).resolves.toBeUndefined();
  });

  it('passes other refusals on as codes, never with the token', async () => {
    const token = issued();
    h.stub.on('DELETE', '/installation/token', { status: 403, body: { message: 'no' } });
    const error = await h
      .adapter()
      .revokeShortLivedToken(new Redacted(token))
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ name: 'GitHostError', code: 'forbidden' });
    expect(JSON.stringify(error)).not.toContain(token);
    expect(String(error)).not.toContain(token);
  });

  it('refuses an empty token before any call', async () => {
    await expect(h.adapter().revokeShortLivedToken(new Redacted(''))).rejects.toMatchObject({
      code: 'invalid_input',
    });
    expect(h.stub.requests).toHaveLength(0);
  });
});
