// Interfaces for secrets and Run Contract signatures (design/D-03 sections 8 and 8.2, task A04,
// design/ADR-M21). The implementation is `@sdlc/secrets` (OpenBao). Adapters receive these
// interfaces from the apps; they never import the implementation (ADR-M16 §2.5).

/**
 * A secret value that never shows up in logs: `String()`, template literals, `JSON.stringify`
 * and `util.inspect` all give `[redacted]`. `reveal()` is the only way to read the value; call
 * it at the place that uses the value, never to log or store it.
 */
export interface RedactedSecret {
  reveal(): string;
}

/** One secret: a KV entry with its fields (for example `private_key`, `app_id`). */
export interface SecretEntry {
  /** Field name → value. */
  readonly data: Readonly<Record<string, RedactedSecret>>;
  /** Version of the KV entry (KV v2). */
  readonly version: number;
}

/** Reads secrets the process is allowed to read (its own AppRole policy). */
export interface SecretReader {
  /**
   * Reads the entry at `path` (for example `worker/database` or `shared/github-app`). Path
   * segments are letters, digits, `-`, `_` and `.`; `..` is refused. `version` reads an older
   * version; the latest by default.
   */
  read(path: string, options?: { version?: number }): Promise<SecretEntry>;
}

/** A signature and the version of the signing key that made it. */
export interface SignatureResult {
  /** The signature as returned by the signing service, including its version prefix. */
  readonly signature: string;
  /** Signing key version; stored in `run_contracts.key_version` (D-05 §6.4). */
  readonly keyVersion: number;
}

/** Signs Run Contracts with the platform key. The key never leaves the secret manager. */
export interface RunContractSigner {
  /** Signs the exact bytes (the canonical JSON of the contract). Latest key version by default. */
  sign(payload: Uint8Array, options?: { keyVersion?: number }): Promise<SignatureResult>;
}

/** Verifies Run Contract signatures (runner, D-03 §8). */
export interface RunContractVerifier {
  /** True when `signature` is a valid signature of `payload`. The key version comes from the signature. */
  verify(payload: Uint8Array, signature: string): Promise<boolean>;
  /** The public key of one key version, as raw Ed25519 bytes (32 bytes). */
  publicKey(keyVersion: number): Promise<Uint8Array>;
}
