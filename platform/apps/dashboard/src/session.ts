// How this tab is signed in. Two ways:
// - a personal API token (ADR-M54 §2.3, Harry's decision), in memory only: never in a URL,
//   localStorage, sessionStorage, a cookie or a log. A reload or "Sign out" forgets it.
// - a GitHub sign-in (U05, ADR-M73 §2.2): the api holds the session; the browser holds only the
//   `HttpOnly` cookie `__Host-sdlc_session`, which this code never reads. `cookie` only records
//   that the API accepted it.
// - U06 (ADR-M73 §2.3): with a GitHub sign-in, the session's CSRF token (from
//   `GET /v1/auth/session`), in memory only like the personal token, sent in `X-SDLC-CSRF` with
//   every write; and whether the platform has actions on. A reload reads them again.

/** The format the API issues (`sdlc_pat_` + 32 random bytes in base64url, ADR-M26). */
export const TOKEN_FORMAT = /^sdlc_pat_[A-Za-z0-9_-]{43}$/;

type Listener = () => void;

let token: string | null = null;
let cookie = false;
let csrf: string | null = null;
let actions = false;
const listeners = new Set<Listener>();

function notify(): void {
  for (const listener of listeners) listener();
}

export const session = {
  token: (): string | null => token,
  /** True when the API accepted this browser's GitHub session cookie. */
  cookie: (): boolean => cookie,
  signedIn: (): boolean => token !== null || cookie,
  /** The session's CSRF token (U06); null without a GitHub session. */
  csrf: (): string | null => csrf,
  /** True when a GitHub session may write (actions on at the API, U06). */
  actions: (): boolean => cookie && actions,
  /** What `GET /v1/auth/session` answered (U06). */
  setWebSession(value: { readonly csrfToken: string; readonly actions: boolean }): void {
    csrf = value.csrfToken;
    actions = value.actions;
    notify();
  },
  signIn(value: string): void {
    token = value;
    cookie = false;
    csrf = null;
    actions = false;
    notify();
  },
  /** The API answered `GET /v1/me` with the session cookie (U05). */
  signInWithCookie(): void {
    token = null;
    cookie = true;
    notify();
  },
  /** Forgets the sign-in in this tab. A GitHub session also needs `endSession` (the API). */
  signOut(): void {
    token = null;
    cookie = false;
    csrf = null;
    actions = false;
    notify();
  },
  subscribe(listener: Listener): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};
