# ADR-M21. OpenBao client for the platform processes

| Item | Value |
|---|---|
| Status | **Proposed** (task A04, PR for review) |
| Date | 2026-09-25 |
| Decided by | Harry (plan approved 2026-09-25, decisions D1–D3) |
| Related | D-03 sections 8, 8.1, 8.2, 9; D-08 task A04; ADR-M05, ADR-M16, ADR-M17 §2.3, ADR-M18, ADR-M19; QUESTIONS #1, #2, #20, #27 |

## 1. Context

Task A04 gives the platform processes (api, worker, runner, cost-controller) a client for OpenBao. Each process logs in with its AppRole, keeps a short-lived token alive, reads its own KV v2 secrets, and (worker, runner) signs or verifies Run Contracts with the Transit key `run-contract` (Ed25519). A03 (ADR-M19) set up the server side.

Requirements beyond the backlog:

- OpenBao reports "healthy" in Compose while it is sealed or not initialised. The client must say so clearly (QUESTIONS #2).
- With TLS on, the client verifies the server certificate against the company internal CA, and nothing can turn verification off (QUESTIONS #20). TLS itself arrives in A10.
- Secret values never reach logs, error messages or stack traces (A04 AC3).

## 2. Decision

### 2.1. Our own small client, no dependencies

| Option | Licence | Why not |
|---|---|---|
| `node-vault` | MIT | Built on the unmaintained `request` package. No clean way to set a CA per client |
| `hashi-vault-js` | MIT | Brings axios and a large API we do not need |
| Built-in `fetch` | — | A custom CA needs an `undici` Agent, which means a direct `undici` dependency |
| **Own client on `node:http` / `node:https`** | — | **Chosen.** Seven endpoints. Full control over TLS options and over what goes into errors |

- Package `@sdlc/secrets` (`platform/packages/secrets/`). It is a normal package, not an adapter: core and the apps may import it. It imports `@sdlc/contracts` and `@sdlc/messages` only, and has **no runtime dependencies**.
- The interfaces other packages depend on are in `@sdlc/contracts` (`secrets.ts`): `SecretReader`, `RunContractSigner`, `RunContractVerifier`, `RedactedSecret`. Adapters (for example the GitHub adapter, B05) receive them from the apps (ADR-M16 §2.5).

### 2.2. Settings

| Environment variable | Meaning |
|---|---|
| `SDLC_OPENBAO_ADDR` | `https://host:8200` (production), `http://openbao:8200` only with the next variable |
| `SDLC_OPENBAO_ALLOW_PLAINTEXT` | `1` allows `http://` (development machines and CI only, §2.4) |
| `SDLC_OPENBAO_CA_CERT_FILE` | PEM file of the company internal CA. When set, only this CA is trusted |
| `SDLC_OPENBAO_ROLE_ID_FILE` | File with the AppRole role ID |
| `SDLC_OPENBAO_SECRET_ID_FILE` | File with the AppRole secret ID (mode 600, tmpfs mount) |
| `SDLC_OPENBAO_TIMEOUT_MS` | Request timeout, default 10 000 |

- The role ID and secret ID come from **files**, never from environment variables: `docker inspect` shows environment values (ADR-M17 §2.3).
- Mount names (`kv`, `transit`, `approle`) and the key name `run-contract` are defaults in the client. A drift test compares them with `bootstrap.conf` and the policies.
- No handbook rule is in the client. Token and secret ID lifetimes are OpenBao settings (`bootstrap.conf`, ADR-M19 §2.3); the client follows the TTLs OpenBao returns. `@sdlc/config` is not used: it holds per-project gate configuration.

### 2.3. Behaviour

| Topic | Behaviour |
|---|---|
| Login | `auth/approle/login`. The secret ID file is **read again at every login**, so the 90-day rotation (ADR-M19 §2.3) needs no restart. Concurrent callers share one login |
| Renewal | At 2/3 of the TTL, `renew-self`. When OpenBao gives less than asked for (the maximum TTL of 4 h is near), or the token is not renewable, the client logs in again and revokes the old token. A failed renewal is logged and retried while the token is still valid; the timer never throws and never keeps the process alive |
| 403 | OpenBao answers 403 both for an expired token and for a policy refusal. The client asks `lookup-self`: an invalid token leads to one new login and one retry; a valid token means a policy refusal, reported as `secrets.permission_denied` with no new login |
| 503 | Always explained with `sys/seal-status`: `secrets.openbao.not_initialised` or `secrets.openbao.sealed` (QUESTIONS #2). `assertReady()` lets a process fail fast at start-up |
| KV v2 | `kv/data/<path>`, optional version. Path segments: letters, digits, `-`, `_`, `.`; no `.` or `..`. Values come back as `Redacted` |
| Transit sign | Base64 input, raw Ed25519 (no prehash). Latest key version unless one is given. The key version is read from the signature prefix (`vault:v<N>:`) and returned; C02 stores it in `run_contracts.key_version` (D-05) |
| Transit verify | Through OpenBao (`verify`) or locally (`verifyLocally`): public keys from `transit/keys/run-contract`, cached per version (a version's public key never changes). A malformed signature is `false`, never an error |
| close() | Stops renewal, waits for a login in flight, revokes the token |

### 2.4. TLS (QUESTIONS #20, decision D1)

- Certificate verification is always on (`rejectUnauthorized: true`, set explicitly, so `NODE_TLS_REJECT_UNAUTHORIZED=0` does not change it). There is no option to skip verification. A test checks the source code for such options.
- With `SDLC_OPENBAO_CA_CERT_FILE`, only that CA is trusted.
- Plain `http://` is refused unless `SDLC_OPENBAO_ALLOW_PLAINTEXT=1`. With it, the client logs a warning (`openbao.plaintext`, catalog text `secrets.warning.plaintext`) when it is created and at every login. This turns off encryption, not certificate verification. Development and CI need it until A10 adds TLS on 8200. A10 must add a check that no production deployment file sets it.
- Tests use throw-away CAs made with `openssl` in a temp folder: valid certificate, no CA file, another CA, expired certificate, wrong host name.

### 2.5. Token binding (decision D2)

- `configure.sh` (A03) now sets `token_bound_cidrs` to the same CIDRs as `secret_id_bound_cidrs`. A token copied out of a platform process does not work from anywhere else.
- Development machines and CI: no new friction. A token works from exactly where its secret ID already works.
- Live check (QUESTIONS #27): a login from the **host** through the published port `127.0.0.1:8200` passes the CIDR check. Docker's port proxy connects from the network gateway (`x.x.x.1`), which is inside the bound subnet. The same holds for tokens. Decision pending; the live test documents the current behaviour.

### 2.6. No secret in logs, errors or stack traces (AC3)

- `Redacted` wraps secret values. `String()`, template literals, `JSON.stringify` and `util.inspect` give `[redacted]`; `reveal()` is the only way to the value.
- Tokens and credentials are held in private class fields (`#…`), invisible to `inspect` and `JSON.stringify`.
- `SecretsError` has a catalog key and params that hold only addresses, file paths, secret paths, HTTP status codes and Node error codes. Never a request body, a header, raw OpenBao error text (it can echo input) or a `cause`.
- The logger hook takes an event name and primitive fields (TTLs, status codes, error keys). The default logger is silent; A08 connects the platform logger.
- Tests: a stub OpenBao puts a marker in every credential, token and value, and echoes input in its error texts. Every failure path is checked: the marker never appears in the message, stack, `JSON.stringify`, `util.inspect` or log fields. The live test checks all driver output against the throw-away key shares, root token, secret IDs and values.

### 2.7. Tests

| Where | What |
|---|---|
| `pnpm test` (`platform/tests/secrets/`) | Unit tests against an in-process stub: login, renewal (fake timers), 403 handling, sealed / not initialised, network errors, KV, Transit with several key versions, options, TLS with throw-away CAs, redaction, drift against `bootstrap.conf` |
| `pnpm test:openbao` (`platform/tests/integration/openbao/secrets-client.test.ts`) | Throw-away Compose project. The built client runs in a `node:24` container on the Compose network (`secrets-driver.mjs`). OpenBao healthy but not initialised, then sealed, then working; each AppRole's permissions; worker signs, runner verifies (Transit and local); revoked tokens; restart → sealed; the host-gateway check |

The CI `compose` job runs `pnpm test:openbao` when `platform/deploy/`, `platform/packages/secrets/` or `platform/tests/integration/openbao/` changes.

### 2.8. QUESTIONS #1 (LiteLLM provider keys)

A04 is not affected. The sidecar is OpenBao's own Agent, not this client. The `litellm` AppRole and its policy belong to C03.

## 3. Open items

| Item | Where |
|---|---|
| Response-wrapped secret IDs (a wrapping token that the client unwraps once), to limit exposure during delivery (decision D3: deferred) | Deployment of the platform processes |
| Mounting the role ID and secret ID files (tmpfs, mode 600) into the process containers | Deployment of the platform processes |
| TLS on 8200 with the internal CA; check that no production file sets `SDLC_OPENBAO_ALLOW_PLAINTEXT` | A10 |
| Host logins through the published port pass the CIDR check | QUESTIONS #27 |
| Connecting the logger hook to the platform logger | A08 |

## 4. Consequences

- New workspace package `@sdlc/secrets`; the root `tsconfig.json`, the Vitest aliases and the workspace structure test list it.
- The GitHub adapter (B05), Run Contracts (C02), the runner (C04) and the Cost Controller (C03) use the interfaces in `@sdlc/contracts`, wired by the apps.

## Version history

| Version | Date | Author | Notes |
|---|---|---|---|
| 0.1 | 2026-09-25 | Claude (task A04) | First version |
