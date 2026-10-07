// The personal API token, in memory only (design/ADR-M54 §2.3, Harry's decision): never in a URL,
// localStorage, sessionStorage, a cookie or a log. A reload or "Sign out" forgets it.

/** The format the API issues (`sdlc_pat_` + 32 random bytes in base64url, ADR-M26). */
export const TOKEN_FORMAT = /^sdlc_pat_[A-Za-z0-9_-]{43}$/;

type Listener = () => void;

let token: string | null = null;
const listeners = new Set<Listener>();

function notify(): void {
  for (const listener of listeners) listener();
}

export const session = {
  token: (): string | null => token,
  signIn(value: string): void {
    token = value;
    notify();
  },
  signOut(): void {
    token = null;
    notify();
  },
  subscribe(listener: Listener): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};
