# ADR-M63. OpenBao TLS everywhere, and backups

| Item | Value |
|---|---|
| Status | **Proposed** (task A10, PR 1: TLS; PR 2 adds the backups section) |
| Date | 2026-10-09 |
| Decided by | Harry (A10 plan approved 2026-10-09, with answers to QUESTIONS #325–#327) |
| Related | D-08 task A10 (AC1); D-03 §8.2, §9 (TLS for internal services); QUESTIONS #20 (the internal CA), #27 (no host port), #67 (plain HTTP until A10), #325–#327; ADR-M19 §2.5, §3; ADR-M21 §2.4 (the client always verifies); runbook T11 section 3c |

## 1. Context

- QUESTIONS #20 decided TLS on OpenBao's listener 8200 with a company internal CA: server certificate 1 year, CA 5 years, the CA key offline, the operator renews 30 days before the end, clients always verify. Listener 8210 (key holders, inside the container only) stays plain.
- Until A10 every platform process talked to OpenBao over plain HTTP on the Compose network, with `SDLC_OPENBAO_ALLOW_PLAINTEXT=1` (QUESTIONS #67). The client library `@sdlc/secrets` already verifies a CA and refuses `http://` without that flag (ADR-M21 §2.4).
- The `openbao` image runs as uid 100 (gid 1000), the platform processes as `node` (uid 1000). A host file with mode 600, owned by the operator, cannot be read by either on Linux.

## 2. Decision

### 2.1. TLS everywhere (QUESTIONS #325)

- **Development machines, CI and the server all run TLS on 8200.** There is no plain listener on the Compose network and no `SDLC_OPENBAO_ALLOW_PLAINTEXT` in the compose file (a static test fails if one comes back). One configuration, so CI tests the server's path.
- Development machines and tests use a **throw-away CA**: `pnpm compose:env` (`init-env.sh`) runs `openbao/tls.sh dev`, which makes a CA and a server certificate (EC P-256, 825 days) next to the env file (`openbao-tls/`, Git-ignored) and **deletes the CA key at once**. Every live test's env file gets its own CA.
- The server uses the **company internal CA** (QUESTIONS #20): `pnpm openbao:tls ca <folder>` makes the CA (5 years) in a folder outside the repository that goes offline with the key shares; `pnpm openbao:tls server <folder>` issues the server certificate (1 year). The CA key never enters the certificate folder.
- The certificate names `openbao` and `127.0.0.1` (the admin commands inside the container go through TLS too).

### 2.2. How the files reach the containers

- The env file names the certificate folder: `SDLC_OPENBAO_TLS_DIR`, an absolute path (`ca.pem`, `server.pem`, `server-key.pem` with mode 600).
- A one-shot job **`openbao-tls-init`** (the OpenBao image, as root, no network) copies the files into two named volumes at every start: **`openbao-tls`** (key and certificate, owner `openbao`, key mode 600) and **`openbao-ca`** (the CA certificate, mode 644). `openbao` starts only after the job succeeded; a missing file fails the job (fail closed).
- Every client mounts `openbao-ca` read-only: `sdlc-api`, `sdlc-worker`, `sdlc-runner` (`SDLC_OPENBAO_ADDR=https://openbao:8200`, `SDLC_OPENBAO_CA_CERT_FILE`), `litellm-agent` (`BAO_CACERT`), and `openbao` itself for its admin commands.
- No host file is bind-mounted into OpenBao or a client, so host file owners and modes never matter, on Linux and on Docker Desktop.

### 2.3. Health, renewal and checks

- OpenBao's health check runs `bao status` over TLS with the CA: exit 0 (unsealed) or 2 (sealed or uninitialised) is healthy; a bad or untrusted certificate is unhealthy. `bootstrap.sh status` reads the seal status on the in-container listener 8210.
- **Renewal without unsealing again:** `pnpm openbao:tls server <ca-folder>`, then `pnpm openbao:tls reload` (runs `openbao-tls-init` again and sends SIGHUP; OpenBao reads the new certificate and stays unsealed). Clients read the CA when they start: restart them only when `ca.pem` changed (a new CA).
- `pnpm openbao:tls check` shows when the CA and the certificate end and fails within 30 days of the end; `up.sh` runs it and prints a warning, never blocks.
- Existing development stacks: `pnpm openbao:tls dev` adds a throw-away CA and the variable to an existing `.env`; OpenBao's data stays.

## 3. Consequences

- One more one-shot job (`openbao-tls-init`) in `up.sh` and two small volumes.
- Every OpenBao live test reaches OpenBao over TLS with the project's CA (`throwaway-compose.ts`); tests that reach it by IP from the host map the name `openbao` to the IP (`--add-host`).
- OpenSSL 3 or later is needed on the host (already a requirement; LibreSSL is refused).
- Open (A10, with the operator): the real CA and key holders on the server, the backups (PR 2), the resource measurement and the runner's VM (PR 3).

## 4. Rejected

- **TLS only on the server** (a compose overlay): two configurations, and CI would test the plain one.
- **Bind-mounting the host files**: needs host modes the container users can read (a key readable by others, or a group change on the host).
- **The health check on the plain listener 8210**: it could not see a bad certificate on 8200.

## Version history

| Version | Date | Author | Notes |
|---|---|---|---|
| 0.1 | 2026-10-09 | Claude Code (task A10, PR 1) | TLS everywhere, the throw-away CA on development machines and in CI, `openbao-tls-init`, renewal by SIGHUP, `tls.sh` |
