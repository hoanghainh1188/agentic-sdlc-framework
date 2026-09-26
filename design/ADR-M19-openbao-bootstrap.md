# ADR-M19. OpenBao bootstrap: tool, policy layout, token handling

| Item | Value |
|---|---|
| Status | **Proposed** (task A03, PR for review) |
| Date | 2026-09-25 |
| Decided by | Harry (plan approved 2026-09-25, with changes) |
| Related | D-03 sections 8, 8.1, 8.2, 10.2; D-08 tasks A03, A11; ADR-M05, ADR-M17; handbook Ch.3; runbook T11; QUESTIONS #1, #2, #20, #27, #37, #42 |

## 1. Context

Task A03 initialises OpenBao (Shamir 3-of-2), enables KV v2 and Transit with the Ed25519 key `run-contract`, and creates one AppRole per platform process, each reading only its own secrets. The same script must be safe to run again. Key shares must be printed once, to the screen only.

A03 runs on development machines with **throw-away test keys** only. The real initialisation on the internal server waits until the three key holders are named (CLAUDE.md, "Current constraints"). The runbook T11 describes it; nobody has performed it yet.

## 2. Decision

### 2.1. Tool: a POSIX shell script on the host, `bao` inside the container

- `platform/deploy/openbao/bootstrap.sh` runs on the host. It calls the `bao` command inside the Compose `openbao` container with `docker compose exec`. The host needs only Docker: no Node.js, no `bao` binary, no `jq`. This matches the other scripts in `platform/deploy/scripts/`.
- Subcommands: `status`, `init`, `unseal`, `configure [--keep-token]`, `root-token`. Each does one step; the runbook T11 says who runs which step.
- `bootstrap/configure.sh` and `bootstrap/root-token.sh` run **inside** the container. The folder `platform/deploy/openbao/bootstrap/` is mounted read-only at `/openbao/bootstrap`. It is outside `/openbao/config`, because OpenBao reads every `.hcl` file there as server configuration.

### 2.2. How secrets move

| Secret | Rule |
|---|---|
| Key shares and the first root token (`init`) | Printed once by `bao operator init`, straight to the terminal. `init` refuses when stdout is not a terminal and when OpenBao is already initialised. Never stored |
| Key shares (`unseal`, `root-token`) | Hidden prompt on a terminal, or one line per share on stdin. Passed to the container **on stdin** (`bao write sys/unseal key=-`), never as a command-line argument or environment variable |
| Root token (`configure`) | Same: hidden prompt or stdin, then stdin of the in-container script. `configure` refuses a token without the `root` policy and **revokes it at the end** (D-03 §10.2) unless `--keep-token` is given |
| Test hook | `--stdout-not-tty` lets the live test keep the printed values in memory. The script accepts it only when `SDLC_OPENBAO_TEST=1`, and `--help` does not list it (static test) |

`docker compose exec` reads stdin until it ends. Every call that does not pass a secret gets `/dev/null` as stdin. Otherwise a status check would swallow the next key share.

### 2.3. Settings are data, not code

`bootstrap/bootstrap.conf` holds the values that come from the handbook and design docs. Both scripts read it with `sed`; it is never executed as shell code.

| Setting | Value | Source |
|---|---|---|
| `BAO_KEY_SHARES` / `BAO_KEY_THRESHOLD` | 3 / 2 | D-03 §10.2 |
| `TRANSIT_KEY` / `TRANSIT_KEY_TYPE` | `run-contract` / `ed25519` | D-03 §8, D-08 A03 |
| `APPROLE_ROLES` | `api worker runner cost-controller` | D-08 A03 AC2 |
| `APPROLE_TOKEN_TTL` / `APPROLE_TOKEN_MAX_TTL` | 1h / 4h, renewable | [Proposal], approved |
| `APPROLE_SECRET_ID_TTL` | 2160h (90 days). Rotated every 3 months with the access review | Handbook Ch.3; approved |
| `SECRET_ID_BOUND_CIDRS` | `compose-network`: the subnet of the Compose network | Approved |
| `ADMIN_TOKEN_MAX_TTL` | 1h | Approved |

Who may read what is **only** in `bootstrap/policies/<name>.hcl`. The scripts contain no path rules. `@sdlc/config` (ADR-M18) is per-project gate configuration and is not used for infrastructure settings.

### 2.4. Policy layout

| Policy | KV (mount `kv/`, version 2) | Transit |
|---|---|---|
| `api` | `api/*`, `shared/github-app` | — |
| `worker` | `worker/*`, `shared/github-app` (QUESTIONS #42) | sign and verify with `run-contract`; read the public key |
| `runner` | `runner/*`, `shared/github-app` | verify; read the public key |
| `cost-controller` | `cost-controller/*` (includes `litellm-master-key`) | — |
| `platform-admin` | create, read, update `kv/*` (no delete, no destroy) | read the public key |

- One subtree per process: `kv/<process>/…`. Shared secrets live under `kv/shared/…`, and each policy that needs one names it explicitly.
- No policy grants `sys/*`, Transit `export`, `backup` or `restore`, or any change to Transit keys. The key is created with `exportable=false`, `allow_plaintext_backup=false` and `deletion_allowed=false`. `configure` checks these values on every run and never changes an existing key.
- `kv/litellm/providers/*` is reserved for model provider keys. **No AppRole reads it yet**; it waits for QUESTIONS #1 (how LiteLLM gets provider keys).
- `platform-admin` is for daily work (D-03 §10.2). Its tokens come only from the token role `platform-admin`: orphan, not renewable, at most 1 hour. Issuing AppRole secret IDs is part of this policy. It is a sensitive, audited operation (runbook T11 §8).
- Everything else (policies, mounts, AppRoles, audit) needs a root token: `configure` again.

### 2.5. AppRoles

- Each role has `token_policies=<role>`, service tokens, TTL 1h, maximum 4h. Secret IDs are valid 90 days and are bound to the Compose network subnet **without its gateway address** (`secret_id_bound_cidrs`). Since A04, the login tokens are bound to the same CIDRs (`token_bound_cidrs`, ADR-M21 §2.5). A secret ID or token used from anywhere else is refused. This includes `docker exec` into the OpenBao container (source `127.0.0.1`) and every process on the host (source: the gateway). Since A11, OpenBao publishes no port on the host (QUESTIONS #27, #37).
- Why the gateway is left out: on a Linux host, every host process can connect to a container IP on the Compose network without any published port. The connection arrives from the network gateway, which is inside the subnet (QUESTIONS #37, found in the A11 plan). Before A11, Docker's port proxy for the published port also connected from the gateway (QUESTIONS #27).
- Trust model: the CIDR binding stops users of the host without root rights and credentials that leak out of a container. Root on the host is trusted: root can `docker exec` into any container and read its files. Access to root and to Docker on the server is covered by server administration (ADR-M17 §2.3), not by OpenBao.
- The subnet and the gateway are fixed in Compose (`SDLC_NETWORK_SUBNET`, default `172.30.0.0/24`; `SDLC_NETWORK_GATEWAY`, default `172.30.0.1`) so that they do not change when the network is recreated. `configure` reads both from the running network and binds the roles to the subnet minus the gateway (`openbao/cidr-exclude.sh`: one CIDR block per host bit, for example 8 blocks for a `/24`).
- `configure` writes the roles again on every run. This keeps `role_id` and the secret IDs already issued (live test, AC4).
- `configure` does **not** issue secret IDs. Delivering them to the processes belongs to A04 and to the deployment of the platform processes.

### 2.6. Key-holder listener

- OpenBao 2.5+ disables the key-share endpoints that need no token (`sys/generate-root/*`, `sys/rekey/*`) by default. Without them, nobody can create a new root token after the first one is revoked.
- `openbao.hcl` adds a second listener, `127.0.0.1:8210`. It is reachable only inside the container (through `docker compose exec`); it is not published and not on the Compose network. Only there are the two groups of endpoints enabled. The main listener keeps them disabled.
- The `bao operator generate-root` command also calls token-protected status endpoints. `root-token.sh` therefore uses `bao read/write/delete` on `sys/generate-root/*`, makes the one-time password itself (base62, the length OpenBao asks for), and decodes the result (base64, XOR with the password).

### 2.7. Audit device

- A `file` audit device is declared in `openbao.hcl` (not through the API). It writes `/openbao/logs/audit.log`, mode 600, on the named volume `openbao-audit`. The volume survives `docker compose down` and container removal. OpenBao HMAC-hashes secret values in audit entries (live test: no key share, token or secret ID appears in clear).
- `configure` refuses to continue when no file audit device is present.
- No second device on stdout for now; Docker logs disappear with the container.
- **Open for A10 / E05:** the handbook (Ch.3) requires audit records to be kept at least 2 years. Rotating `audit.log`, copying it to evidence storage (SeaweedFS, object locking) and checking it are part of the backup work in A10 and the retention jobs in E05.

### 2.8. Note for C04 (runner)

The `runner` policy can read the GitHub App private key (`kv/shared/github-app`), because the runner creates the short-lived token for each run. **This key must never enter a sandbox.** The sandbox receives only a short-lived installation token limited to one repository (D-03 §9, D-08 C04 AC2, AC4). C04 must test this.

## 3. Open items

| Item | Where |
|---|---|
| TLS on the OpenBao listeners (carried over from A02) | QUESTIONS #20 |
| How LiteLLM reads model provider keys | QUESTIONS #1 |
| Delivering secret IDs to processes (response wrapping, file mounts) | A04 defined the client side: role ID and secret ID files (ADR-M21 §2.2). File mounts and response wrapping: deployment of the platform processes (ADR-M21 §3) |
| Audit log rotation, off-server copy, 2-year retention | A10, E05 |
| Real initialisation on the internal server | After the three key holders are named (runbook T11 §3) |
| `token_bound_cidrs` on AppRole tokens (secret IDs are already bound) | Done in A04 (decision D2, ADR-M21 §2.5) |
| Host logins through the published port pass the CIDR check | Done in A11: no host port, gateway left out of the bound CIDRs (QUESTIONS #27, #37, §2.5) |
| Personal admin login (userpass or OIDC with `token_max_ttl` 1h), so that each admin session does not need a root token from two key holders | Decide when admin work becomes frequent (after A04) |

## 4. Alternatives not chosen

| Option | Why not |
|---|---|
| TypeScript bootstrap calling the HTTP API | Needs Node.js on the server. Must be run by key holders, who should need only Docker |
| `bao` installed on the host | One more binary to pin and update. The container already has the matching version |
| Terraform / OpenTofu provider | Heavy for a handful of settings. Its state file would hold secrets |
| Leaving `init` output to the operator (`bao operator init` by hand) | No check against redirecting to a file. No single, tested procedure |
| Key-share endpoints on the main listener | Reachable from every container on the Compose network and from the host port |
| Unlimited secret IDs | Rejected by Harry: 90 days, rotated with the access review |

## 5. Consequences

- Development: `pnpm compose:core`, then `pnpm openbao:bootstrap init`, `unseal`, `configure`. The runbook T11 has the full procedure.
- Tests: `pnpm test` has the static checks (`platform/tests/deploy/openbao-static.test.ts`). `pnpm test:openbao` is the live test (throw-away Compose project, about 1 minute). The CI `compose` job runs it whenever `platform/deploy/` changes.
- Changing the Compose subnet of an existing development stack requires `pnpm compose:down` first (Docker cannot change a network's subnet in place).

## Version history

| Version | Date | Author | Notes |
|---|---|---|---|
| 0.1 | 2026-09-25 | Claude (task A03) | First version |
| 0.2 | 2026-09-25 | Claude (task A04) | §2.5: tokens bound to the subnet (`token_bound_cidrs`), host exception (QUESTIONS #27); §3: open items updated |
| 0.3 | 2026-09-26 | Claude (task A11), approved by Harry | §2.5: no host port (QUESTIONS #27, option A); gateway pinned and left out of the bound CIDRs, trust model (QUESTIONS #37, option A2) |
| 0.4 | 2026-09-26 | Claude (task B05), approved by Harry | §2.4: `worker` also reads `shared/github-app` (it polls GitHub, posts gate comments, reads spec files; QUESTIONS #42) |
