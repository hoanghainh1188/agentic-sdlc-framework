// How this tab is signed in. Two ways:
// - a personal API token (ADR-M54 §2.3, Harry's decision), in memory only: never in a URL,
//   localStorage, sessionStorage, a cookie or a log. A reload or "Sign out" forgets it.
// - a GitHub sign-in (U05, ADR-M73 §2.2): the api holds the session; the browser holds only the
//   `HttpOnly` cookie `__Host-sdlc_session`, which this code never reads. `cookie` only records
//   that the API accepted it.

/** The format the API issues (`sdlc_pat_` + 32 random bytes in base64url, ADR-M26). */
export const TOKEN_FORMAT = /^sdlc_pat_[A-Za-z0-9_-]{43}$/;

type Listener = () => void;

let token: string | null = null;
let cookie = false;
const listeners = new Set<Listener>();

function notify(): void {
  for (const listener of listeners) listener();
}

export const session = {
  token: (): string | null => token,
  /** True when the API accepted this browser's GitHub session cookie. */
  cookie: (): boolean => cookie,
  signedIn: (): boolean => token !== null || cookie,
  signIn(value: string): void {
    token = value;
    cookie = false;
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
    notify();
  },
  subscribe(listener: Listener): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};
