# ADR-M76. The trial stack's key file: age with a passphrase, through the library `age-encryption`

| Item | Value |
|---|---|
| Status | **Accepted** (task V08) |
| Date | 2026-10-12 |
| Decided by | Harry (V08 plan approved 2026-10-12; QUESTIONS #415–#419 answered 2026-10-12) |
| Related | D-08 task V08; QUESTIONS #345, #356, #415–#419; ADR-M19 (OpenBao bootstrap); ADR-M63 (TLS and backups, which use the `age` program); runbook T11 §3.1b; `TRIAL.md` §3.2 |

## 1. Context

`pnpm trial:up` (V02) kept the trial stack's throw-away OpenBao key shares in memory only (QUESTIONS #345): after a reboot or `pnpm trial:down` nobody could unseal the stack, and the trial's intents were lost. QUESTIONS #356 changed that **for the trial stack only**: its data is fictional and it can never hold client data. The shares are kept encrypted with a passphrase the person chooses (age, scrypt); never the root token; only `pnpm trial:start` on a `sdlc-trial…` project uses them. A server keeps the key-holder rules (runbook T11 §3.2, §4).

`pnpm backup` already uses age, through the `age` program installed by the operator (apt, Homebrew), with public keys only. The `age` program reads a passphrase **only from a terminal**: there is no flag and no stdin form. So it cannot be tested in CI, and a trial tester would need to install one more program.

## 2. Decision

### 2.1 The library `age-encryption` 0.3.1

`trial:up` and `trial:start` encrypt and decrypt in memory with the npm package `age-encryption` (BSD-3-Clause, the TypeScript implementation by the author of age), **pinned exactly** in the root `devDependencies`. Its dependencies are `@noble/ciphers`, `@noble/curves`, `@noble/hashes`, `@noble/post-quantum` and `@scure/base` (MIT, no native code, no install scripts). Every version was published more than two weeks before this decision (2026-08). It is used only by `platform/deploy/trial/` (developer machines), never by a platform process or an image.

The file is standard age with one scrypt stanza, so a person can still open it by hand with the `age` program (`age -d`, which asks the passphrase). The scrypt work factor is the library's default, 2^18 (about one second and 256 MiB).

### 2.2 The file

- **Name and place:** `trial-openbao-keys.age` next to the trial's env file (by default `platform/deploy/trial-openbao-keys.age`). `.gitignore` lists it and its temporary file; `trial:up` refuses to write it where Git would not ignore it (`git check-ignore`), and refuses an existing one (never overwritten).
- **Content (encrypted):** JSON `{v: 1, project, created_at, threshold: 2, shares: [two shares]}`: exactly the shares needed to unseal (`BAO_KEY_THRESHOLD` 2), never the third share, never the root token.
- **Writing:** encrypted in memory; the ciphertext goes to a new temporary file in the same folder (exclusive create, mode 600, fsync), then to its name with a hard link that fails when the name exists; the temporary file is removed. Plaintext never touches the disk. Written right after the first unseal, so a later failure of `trial:up` still leaves a usable file.
- **Reading:** `trial:start` refuses a file others can read, a file that is not age with scrypt, and a record of another Compose project.

### 2.3 The passphrase (QUESTIONS #416)

A hidden prompt on a terminal, twice for a new one (three tries), or the first line of standard input with `--passphrase-stdin`. Never an argument or an environment variable: both show in process listings. At least 12 characters (characters, not bytes), at most 1024, normalised to Unicode NFC so the same passphrase typed with another input method works. Never logged; `trial:up` keeps it in its redaction bag.

### 2.4 `pnpm trial:start` (QUESTIONS #419)

GETTING-STARTED Step 13's order: OpenBao, PostgreSQL and SeaweedFS; a check that the `openbao` container carries the trial project's Compose label; `bootstrap.sh status`; when sealed, the passphrase (three tries on a terminal, one from stdin), the shares decrypted in memory and given to `bootstrap.sh unseal` on stdin, then dropped; the migrations (idempotent); `up.sh core models platform sandbox`. Already unsealed: no passphrase. Refused: `NODE_ENV=production`, an env file of another Compose project, a missing key file when sealed (a stack set up before V08). `bootstrap.sh` does not change: its `unseal` already reads shares from stdin without a terminal.

### 2.5 The 90-day limit (QUESTIONS #417)

The processes' AppRole secret IDs live 90 days and only a root token renews them; the trial stack has none. A trial stack therefore lives at most 90 days. `trial:start` warns from day 80 (the key file's age) and says to set the stack up again after day 90. No renewal path is added.

## 3. Consequences

- A reboot no longer loses a trial stack. The strength of the key file is the strength of the passphrase; it sits next to the env file, which already holds the stack's database passwords on the same machine.
- A forgotten passphrase loses the trial stack, as a reboot did before: the messages say so, and that the data is fictional.
- One more development dependency (six packages), pinned in the lockfile.
- `pnpm doctor` points a sealed trial stack to `pnpm trial:start`, or to a new set-up when the key file is missing.

## 4. Alternatives not chosen

- **The `age` program:** a terminal-only passphrase, not testable in CI, one more install for testers.
- **Node's own `crypto` (scrypt + ChaCha20-Poly1305):** no dependency, but our own file format, which nobody else can open and which needs its own review.
- **Printing two shares at the end of `trial:up`:** refused in QUESTIONS #345; shares in a terminal's scroll-back are worse than an encrypted file.
