// The pending GitHub sign-ins (task U05, design/ADR-M73 §2.2, QUESTIONS #385): the OAuth `state`,
// the PKCE verifier and the chosen tenant, kept in the api process's memory for 10 minutes and
// used once. The browser holds only a random handle in the pre-login cookie; the map is keyed by
// the handle's SHA-256. The callback needs both the cookie's handle and the matching `state`, so a
// callback opened in another browser, or a link with someone else's code, fails (login CSRF).
//
// One api process (ADR-M26 §2.7): a restart drops the pending sign-ins; the person starts again.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export const OAUTH_STATE_TTL_MS = 10 * 60_000;
/**
 * At most this many pending sign-ins. When full, expired ones go first, then the oldest: a flood
 * of starts can delay a person's sign-in, never block every new one (security review, MEDIUM-3).
 */
export const MAX_PENDING_SIGN_INS = 10_000;

const sha256 = (value: string): Buffer => createHash('sha256').update(value, 'utf8').digest();
const random = (): string => randomBytes(32).toString('base64url');

interface Pending {
  readonly stateHash: Buffer;
  readonly verifier: string;
  readonly tenantSlug: string;
  readonly expiresAt: number;
}

export interface StartedSignIn {
  /** Goes to the pre-login cookie only. */
  readonly handle: string;
  /** Goes to GitHub in the authorize URL and comes back on the callback. */
  readonly state: string;
  /** The PKCE S256 challenge sent to GitHub. */
  readonly codeChallenge: string;
}

export interface TakenSignIn {
  readonly verifier: string;
  readonly tenantSlug: string;
}

export class OAuthStates {
  readonly #pending = new Map<string, Pending>();

  constructor(private readonly now: () => number = Date.now) {}

  /** A new pending sign-in. */
  start(tenantSlug: string): StartedSignIn {
    const now = this.now();
    if (this.#pending.size >= MAX_PENDING_SIGN_INS) this.#sweep(now);
    // A Map keeps insertion order: the first key is the oldest pending sign-in.
    while (this.#pending.size >= MAX_PENDING_SIGN_INS) {
      this.#pending.delete(this.#pending.keys().next().value!);
    }
    const handle = random();
    const state = random();
    const verifier = random();
    this.#pending.set(sha256(handle).toString('hex'), {
      stateHash: sha256(state),
      verifier,
      tenantSlug,
      expiresAt: now + OAUTH_STATE_TTL_MS,
    });
    return { handle, state, codeChallenge: sha256(verifier).toString('base64url') };
  }

  /**
   * Takes the pending sign-in of `handle` when `state` matches and it has not expired: then it is
   * removed, used once. A wrong state leaves it in place (a link made by someone else cannot
   * cancel it); an expired one is removed.
   */
  take(handle: string, state: string): TakenSignIn | undefined {
    const key = sha256(handle).toString('hex');
    const pending = this.#pending.get(key);
    if (!pending) return undefined;
    if (pending.expiresAt <= this.now()) {
      this.#pending.delete(key);
      return undefined;
    }
    if (!timingSafeEqual(pending.stateHash, sha256(state))) return undefined;
    this.#pending.delete(key);
    return { verifier: pending.verifier, tenantSlug: pending.tenantSlug };
  }

  get size(): number {
    return this.#pending.size;
  }

  #sweep(now: number): void {
    for (const [key, pending] of this.#pending) {
      if (pending.expiresAt <= now) this.#pending.delete(key);
    }
  }
}
