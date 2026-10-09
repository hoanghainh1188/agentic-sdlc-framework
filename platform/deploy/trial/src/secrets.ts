// The throw-away secrets of a trial set-up (D-08 V02 AC3): kept in this process's memory only,
// never written to a file, a log or the terminal. Every line `trial:up` shows from a child process
// goes through `redact`, so a secret a tool prints by mistake never reaches the terminal either.

/** Patterns that look like a secret whatever their value (a last line of defence). */
const SECRET_PATTERNS: readonly RegExp[] = [
  /\bsdlc_pat_[A-Za-z0-9_-]+/g,
  /\b(?:hvs|hvb|hvr|s)\.[A-Za-z0-9_-]{20,}/g,
  /^(Unseal Key \d+|Initial Root Token): .*$/gm,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\bsk-[A-Za-z0-9_-]{16,}/g,
];

export class SecretBag {
  #values = new Set<string>();

  /** Remembers a secret so `redact` hides it; returns it unchanged. */
  keep(value: string): string {
    if (value.length >= 6) this.#values.add(value);
    return value;
  }

  /** Forgets a secret that is no longer needed (the key shares and the root token after use). */
  drop(value: string): void {
    this.#values.delete(value);
  }

  get size(): number {
    return this.#values.size;
  }

  /** The text with every kept secret and every secret-looking value replaced by `<redacted>`. */
  redact(text: string): string {
    let out = text;
    // Longest first, so a secret that contains another is hidden whole.
    for (const value of [...this.#values].sort((a, b) => b.length - a.length)) {
      out = out.split(value).join('<redacted>');
    }
    for (const pattern of SECRET_PATTERNS) {
      out = out.replace(pattern, (match) =>
        match.startsWith('Unseal Key') || match.startsWith('Initial Root Token')
          ? `${match.slice(0, match.indexOf(':'))}: <redacted>`
          : '<redacted>',
      );
    }
    return out;
  }
}

/** The key shares and the root token from `bootstrap.sh init` output. */
export function parseInitOutput(stdout: string): { shares: string[]; rootToken: string } {
  const shares = [...stdout.matchAll(/^Unseal Key \d+: (\S+)$/gm)].map((m) => m[1]!);
  const rootToken = /^Initial Root Token: (\S+)$/m.exec(stdout)?.[1] ?? '';
  if (shares.length < 2 || rootToken === '') throw new Error('init output not understood');
  return { shares, rootToken };
}
