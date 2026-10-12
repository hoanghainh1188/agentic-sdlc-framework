// D-08 U05, design/ADR-M73 §2.2: the pieces of the dashboard sign-in that need no database: the
// `__Host-` cookies (attributes, one value only), and the pending sign-ins (one use, 10 minutes,
// the state compared by hash, a capacity limit, QUESTIONS #385).
import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  clearCookie,
  hasCookie,
  OAUTH_COOKIE,
  oauthCookie,
  readCookie,
  SESSION_COOKIE,
  sessionCookie,
} from '../../apps/api/src/auth/cookies.js';
import {
  MAX_PENDING_SIGN_INS,
  OAUTH_STATE_TTL_MS,
  OAuthStates,
} from '../../apps/api/src/auth/oauth-states.js';

const VALUE = 'a'.repeat(43);

describe('U05: cookies', () => {
  it('session: __Host-, HttpOnly, Secure, SameSite=Strict, Path=/, no Domain', () => {
    expect(sessionCookie(VALUE, 28_800)).toBe(
      `__Host-sdlc_session=${VALUE}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=28800`,
    );
    expect(sessionCookie(VALUE, 1)).not.toMatch(/Domain/i);
  });

  it('pre-login: SameSite=Lax (the redirect back from github.com is cross-site)', () => {
    expect(oauthCookie(VALUE, 600)).toBe(
      `__Host-sdlc_oauth=${VALUE}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=600`,
    );
  });

  it('clearing keeps the attributes and sets Max-Age=0', () => {
    expect(clearCookie(SESSION_COOKIE)).toBe(
      '__Host-sdlc_session=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0',
    );
    expect(clearCookie(OAUTH_COOKIE)).toBe(
      '__Host-sdlc_oauth=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0',
    );
  });

  it('reads one well-formed value only; a cookie sent twice counts as absent', () => {
    expect(readCookie(`a=b; __Host-sdlc_session=${VALUE}`, SESSION_COOKIE)).toBe(VALUE);
    expect(
      readCookie(`__Host-sdlc_session=${VALUE}; __Host-sdlc_session=${VALUE}`, SESSION_COOKIE),
    ).toBeUndefined();
    expect(readCookie('__Host-sdlc_session=short', SESSION_COOKIE)).toBeUndefined();
    expect(readCookie(`sdlc_session=${VALUE}`, SESSION_COOKIE)).toBeUndefined();
    expect(readCookie(undefined, SESSION_COOKIE)).toBeUndefined();
    expect(readCookie([`__Host-sdlc_session=${VALUE}`], SESSION_COOKIE)).toBeUndefined();
    expect(hasCookie('__Host-sdlc_session=bad', SESSION_COOKIE)).toBe(true);
    expect(hasCookie('other=1', SESSION_COOKIE)).toBe(false);
  });
});

describe('U05: pending sign-ins (OAuthStates)', () => {
  it('gives a handle, a state and the S256 challenge of a verifier it keeps', () => {
    const states = new OAuthStates(() => 0);
    const started = states.start('acme');
    for (const v of [started.handle, started.state, started.codeChallenge]) {
      expect(v).toMatch(/^[A-Za-z0-9_-]{43}$/);
    }
    expect(new Set([started.handle, started.state]).size).toBe(2);
    const taken = states.take(started.handle, started.state)!;
    expect(taken.tenantSlug).toBe('acme');
    expect(createHash('sha256').update(taken.verifier).digest('base64url')).toBe(
      started.codeChallenge,
    );
  });

  it('is used once; a wrong state leaves it in place (security review, LOW-1)', () => {
    const states = new OAuthStates(() => 0);
    const a = states.start('acme');
    expect(states.take(a.handle, `${a.state.slice(1)}x`)).toBeUndefined();
    expect(states.take(a.handle, a.state)).toBeDefined();
    expect(states.take(a.handle, a.state)).toBeUndefined();
    const b = states.start('acme');
    expect(states.take(b.handle, b.state)).toBeDefined();
    expect(states.take(b.handle, b.state)).toBeUndefined();
    expect(states.size).toBe(0);
  });

  it('needs the handle of the browser that started it', () => {
    const states = new OAuthStates(() => 0);
    const a = states.start('acme');
    const b = states.start('acme');
    expect(states.take(a.handle, b.state)).toBeUndefined();
  });

  it('expires after 10 minutes', () => {
    let now = 0;
    const states = new OAuthStates(() => now);
    const a = states.start('acme');
    now = OAUTH_STATE_TTL_MS;
    expect(states.take(a.handle, a.state)).toBeUndefined();
  });

  it('when full, drops expired ones first, then the oldest; never refuses (review, MEDIUM-3)', () => {
    let now = 0;
    const states = new OAuthStates(() => now);
    const first = states.start('acme');
    const second = states.start('acme');
    for (let i = 2; i < MAX_PENDING_SIGN_INS; i += 1) states.start('acme');
    expect(states.size).toBe(MAX_PENDING_SIGN_INS);
    const newest = states.start('acme');
    expect(states.size).toBe(MAX_PENDING_SIGN_INS);
    expect(states.take(first.handle, first.state)).toBeUndefined();
    expect(states.take(second.handle, second.state)).toBeDefined();
    expect(states.take(newest.handle, newest.state)).toBeDefined();
    now = OAUTH_STATE_TTL_MS + 1;
    states.start('acme');
    states.start('acme');
    expect(states.size).toBeLessThanOrEqual(MAX_PENDING_SIGN_INS);
  });
});
