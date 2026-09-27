# Platform infrastructure (Docker Compose)

This folder runs the infrastructure that the platform reuses, on one server, with Docker Compose (D-03 section 10, task A02). Image versions, licences and trade-offs: [ADR-M17](../../design/ADR-M17-compose-infrastructure.md).

## Profiles

| Profile | Services | When to use |
|---|---|---|
| `core` | PostgreSQL, Temporal (+ Temporal UI), LiteLLM, Valkey, SeaweedFS (S3 API), OpenBao | Always. Required by the platform |
| `observability` | Langfuse (web + worker), ClickHouse. Reuses PostgreSQL, Valkey and SeaweedFS | Optional. The heaviest part; enable it when the server has room (D-03 section 10.1) |
| `models` | `litellm-agent`: OpenBao Agent that gives LiteLLM its model provider keys, master key and salt key from OpenBao (task C03, [ADR-M24](../../design/ADR-M24-litellm-cost-controller.md)) | **Always on the server** (`pnpm compose:models`). Needs OpenBao unsealed and configured and the sidecar's credentials (runbook T11 §5d). Without it, LiteLLM has no models and uses the development keys from `.env` |
| `platform` | `sdlc-api`: the REST API for the CLI (task B03, [ADR-M26](../../design/ADR-M26-api-app.md)); `sdlc-worker`: the GitHub poller and comment commands (task B06, [ADR-M27](../../design/ADR-M27-github-poller.md)). Both built from this repo | With `core` (`pnpm compose:platform`). Needs OpenBao unsealed and configured, `pnpm openbao:bootstrap api-credentials` and `worker-credentials` first, and the GitHub App key stored (runbook T11 §5b, §5e, §5f) |
| `sandbox` | `sdlc-runner` (built from this repo), `docker-socket-proxy` (wollomatic/socket-proxy: the runner's only way to Docker), `npm-proxy` (Verdaccio: npm packages for the sandboxes), `registry` (local registry for sandbox images, 127.0.0.1 only) (task C04, [ADR-M25](../../design/ADR-M25-runner-sandbox.md)) | With `core` (`pnpm compose:sandbox`). Needs OpenBao unsealed and configured, `SDLC_DOCKER_GID` right and `pnpm openbao:bootstrap runner-credentials` first (runbook T11 §5g) |

Three one-shot jobs run at every start and then exit: `temporal-schema` (creates or upgrades the Temporal schemas), `temporal-namespace` (creates the namespace) and `seaweedfs-init` (creates the `evidence` and `langfuse` buckets). All three are safe to re-run.

## Requirements

- Docker Engine with Docker Compose v2.24 or later.
- OpenSSL 3.x as `openssl` on the `PATH` (for `init-env.sh` and the TLS tests of `@sdlc/secrets`). On macOS, `/usr/bin/openssl` is LibreSSL, and the TLS tests stop with a message when they find it: install OpenSSL 3 (`brew install openssl@3`) and put it first (`export PATH="$(brew --prefix openssl@3)/bin:$PATH"`).
- Node.js 24 + pnpm 10 only for the `pnpm` shortcuts and tests. The shell scripts work without them.

## Start and stop

Run from the repo root.

```bash
pnpm compose:env     # once: creates platform/deploy/.env with random secrets (mode 600)
pnpm compose:core    # starts the core profile and waits until it is healthy
pnpm compose:obs     # core + observability
pnpm compose:models  # core + models: LiteLLM with keys from OpenBao (the server; runbook T11 §5d)
pnpm compose:platform # core + platform: the API (sdlc-api) and the worker (sdlc-worker; runbook T11 §5e, §5f)
pnpm compose:sandbox # core + sandbox: the runner, socket proxy, npm proxy, image registry (runbook T11 §5g)
pnpm compose:down    # stops everything; data volumes are kept
```

Without pnpm:

```bash
platform/deploy/scripts/init-env.sh
platform/deploy/scripts/up.sh core
platform/deploy/scripts/up.sh core observability
docker compose -f platform/deploy/docker-compose.yml --profile core --profile observability down
```

- `up.sh` fails if a service is not healthy within `SDLC_WAIT_TIMEOUT` seconds (default 300), or if a job does not exit 0.
- **Reset all data** (destroys databases, buckets and OpenBao storage): add `-v` to the `down` command. Do this only on a development machine.
- Logs: `docker compose -f platform/deploy/docker-compose.yml logs <service>`.

## Secrets and `.env`

- `.env` holds every password and key. It is ignored by Git and has mode 600. **Never commit it and never paste it into chat, issues or email.**
- `init-env.sh` never overwrites an existing `.env` and never prints secrets. To regenerate, delete `.env` first. Existing volumes keep the old passwords, so reset the data too (`down -v`).
- `.env.example` lists every variable. `CHANGEME` values are placeholders; Compose refuses to start while a secret is missing.
- The Langfuse admin account (email and password) is in `.env`: `LANGFUSE_INIT_USER_EMAIL`, `LANGFUSE_INIT_USER_PASSWORD`. Open sign-up is disabled.
- After task A03, secrets move into OpenBao step by step (D-03 section 8.2).

## Ports

All published ports bind to `127.0.0.1` by default (`SDLC_BIND_ADDR`). The server accepts no inbound internet connections (D-03 section 9). Change a host port in `.env` when it is already in use.

| Service | Default host port | Notes |
|---|---|---|
| PostgreSQL | 5432 | Databases `platform`, `temporal`, `temporal_visibility`, `litellm`, `langfuse`, one owner role each. The `platform` database also has the application role `platform_app` (see below) |
| Temporal (gRPC) | 7233 | Namespace `default`; closed workflows kept 30 days |
| Temporal UI | 8080 | |
| LiteLLM | 4000 | Models only with the profile `models` (keys from OpenBao). Without it: no models, development keys from `.env` |
| SeaweedFS S3 | 8333 | Anonymous access denied |
| Langfuse | 3000 | `observability` profile only |
| API (`sdlc-api`) | 8090 | `platform` profile only. 8080 is taken by the Temporal UI |
| Sandbox image registry | 5050 | `sandbox` profile only. **Always 127.0.0.1** (not `SDLC_BIND_ADDR`): it has no authentication. Not 5000: macOS uses it |

Valkey, ClickHouse, the Langfuse worker, **OpenBao**, the runner, the socket proxy and the npm proxy publish no port.

OpenBao is reachable only on the Compose network (`design/QUESTIONS.md` #27, task A11). The platform processes run in Compose and use `http://openbao:8200`. Key holders and admins work inside the container with `pnpm openbao:bootstrap …` or `docker compose … exec openbao …` (runbook T11). There is no host port for `curl`.

## Platform database roles

The `platform` database has two roles ([ADR-M09](../../design/ADR-M09-database-tooling.md) section 2.3):

| Role | Password variable | Used for |
|---|---|---|
| `platform` (owner) | `PLATFORM_DB_PASSWORD` | Migrations only: `SDLC_DB_MIGRATION_URL=postgres://platform:…@127.0.0.1:5432/platform pnpm db:migrate` |
| `platform_app` | `PLATFORM_APP_DB_PASSWORD` | The platform processes. `SELECT`, `INSERT`, `UPDATE` on chosen columns; never `DELETE` or DDL |

The init scripts create both roles only on an **empty** data volume. A volume created before task A06 has no `platform_app`. Add `PLATFORM_APP_DB_PASSWORD` to `.env` (for example `openssl rand -hex 24`), restart with `pnpm compose:core`, then run the idempotent script once:

```bash
docker compose -f platform/deploy/docker-compose.yml --env-file platform/deploy/.env exec -T postgres sh /docker-entrypoint-initdb.d/02-create-platform-app-role.sh
```

### Checking the audit log

The audit log is append-only and hash-chained per tenant (ADR-M09 section 2.8). Check every tenant's chain (exit code 1 when a record was changed or removed):

```bash
SDLC_DB_URL="postgres://platform_app:<PLATFORM_APP_DB_PASSWORD>@127.0.0.1:5432/platform" pnpm sdlc audit verify
```

Add `--tenant <slug>` for one tenant, `--json` for machine-readable output. The command connects straight to the database until task B13 adds a tenant admin role (`design/QUESTIONS.md` #65).

### First admin and API tokens (task B03)

The API authenticates people with personal API tokens (`sdlc_pat_…`). The first user of a tenant and its token come from a one-time bootstrap, run by the operator on the server ([ADR-M26](../../design/ADR-M26-api-app.md) §2.2). Run it in a terminal: the token is printed **once**. Store it in a password manager; never paste it into a chat, a ticket or a file in a repository.

```bash
export SDLC_DB_URL="postgres://platform_app:<PLATFORM_APP_DB_PASSWORD>@127.0.0.1:5432/platform"
pnpm sdlc admin bootstrap --tenant internal --tenant-name "Internal" --email you@example.com --name "Your Name"
pnpm sdlc admin token issue --tenant internal --email you@example.com --name laptop-you --days 90
pnpm sdlc admin token list --tenant internal --email you@example.com
pnpm sdlc admin token revoke --tenant internal --id <token-id>
```

- The bootstrap runs once per tenant; a second run with the same slug is refused.
- Tokens last 90 days by default, at most 365. Only the SHA-256 hash is stored. Every issue and revocation is written to the audit log (IDs only).
- Projects, users, GitHub identities, roles and project configuration have no command yet (task B13, `design/QUESTIONS.md` #58).

### Reset after a change to migration 0001 (development only)

Migration `0001-tenancy` was changed before it was merged (task A06: `role_bindings.revoked_at`). A development database that already applied an earlier version of 0001 does not get the change: the migrator only runs migrations it has not recorded. Recreate the `platform` database, then migrate again. **This deletes all data in it.**

```bash
docker compose -f platform/deploy/docker-compose.yml --env-file platform/deploy/.env exec -T postgres \
  psql -v ON_ERROR_STOP=1 -U postgres -d postgres \
  -c 'DROP DATABASE platform WITH (FORCE)' \
  -c 'CREATE DATABASE platform OWNER platform' \
  -c 'REVOKE ALL ON DATABASE platform FROM PUBLIC' \
  -c 'GRANT CONNECT ON DATABASE platform TO platform_app'
SDLC_DB_MIGRATION_URL="postgres://platform:<PLATFORM_DB_PASSWORD>@127.0.0.1:5432/platform" pnpm db:migrate
```

Alternatively, recreate the whole Compose stack with its volumes (`docker compose … down -v`). Once 0001 is on `main` it never changes again (ADR-M09 section 2.2).

## OpenBao: initialise, unseal, configure (task A03)

OpenBao starts **uninitialised and sealed**. `openbao/bootstrap.sh` initialises it (3 key shares, any 2 unseal), unseals it and applies the configuration: KV v2, the Ed25519 Transit key `run-contract`, one AppRole per platform process, the `platform-admin` token role. Design: [ADR-M19](../../design/ADR-M19-openbao-bootstrap.md). Procedure, key custody and troubleshooting: [runbook T11](../../handbook/03-templates/T11-openbao-runbook.md).

On a development machine, with **throw-away keys only**:

```bash
pnpm compose:core
pnpm openbao:bootstrap init       # prints 3 shares and a root token ONCE, to the terminal only
pnpm openbao:bootstrap unseal     # 2 shares, hidden input
pnpm openbao:bootstrap configure  # root token, hidden input; revoked at the end
pnpm openbao:bootstrap status
```

- `init` and `root-token` refuse to run when their output is redirected or piped. Shares and tokens are never written to a file.
- `configure` is safe to run again. It needs a root token: `pnpm openbao:bootstrap root-token` makes one from 2 shares.
- After every restart, OpenBao is sealed again: run `unseal`.
- Settings (shares, threshold, token and secret ID lifetimes) are in `openbao/bootstrap/bootstrap.conf`. Access rules are in `openbao/bootstrap/policies/*.hcl`.
- AppRole secret IDs and tokens work only from the Compose network subnet (`SDLC_NETWORK_SUBNET`, default `172.30.0.0/24`) **without its gateway** (`SDLC_NETWORK_GATEWAY`, default `172.30.0.1`). On a Linux host every host process reaches the containers from the gateway address, so leaving it out stops logins from the host (`design/QUESTIONS.md` #37). A stack started before A03 has no fixed subnet, and one started before A11 has no fixed gateway: run `pnpm compose:down`, then `pnpm compose:core` once, then `pnpm openbao:bootstrap configure` again.
- A `.env` created before A11 still has `OPENBAO_HOST_PORT`: delete that line (it is not used), and add `SDLC_NETWORK_GATEWAY=172.30.0.1` (or the `.1` address of your own subnet).
- The audit log is `/openbao/logs/audit.log` on the volume `openbao-audit`.
- The real initialisation on the internal server waits until the three key holders are named (runbook T11 section 3.2).
- TLS is off (development only): `design/QUESTIONS.md` #20.

## Health: what "healthy" means

| Service | Healthy means |
|---|---|
| PostgreSQL | `pg_isready` answers |
| Temporal | The frontend gRPC port accepts connections. The `temporal-namespace` job then checks full cluster health with the Temporal CLI |
| Temporal UI, Langfuse web and worker, ClickHouse, SeaweedFS | Their HTTP health endpoint answers |
| Valkey | `PING` with the password returns `PONG` |
| LiteLLM | `/health/liveliness` answers |
| **OpenBao** | **The API is reachable. It does NOT mean initialised or unsealed.** A new volume is uninitialised and sealed; initialise it with `openbao/bootstrap.sh` (see above). After every restart, OpenBao is sealed again until two key holders unseal it (D-03 section 10.2). Check with `pnpm openbao:bootstrap status` (OpenBao publishes no host port) |

## Shared Valkey: memory limit

Langfuse and LiteLLM share one Valkey with `maxmemory-policy noeviction`, which Langfuse requires. The limit is `VALKEY_MAXMEMORY` in `.env` (default `256mb`). **When Valkey is full, writes fail for both Langfuse and LiteLLM.** Watch memory use:

```bash
docker compose -f platform/deploy/docker-compose.yml exec valkey sh -c 'REDISCLI_AUTH="$VALKEY_PASSWORD" valkey-cli info memory' | grep used_memory_human
```

## Resource estimate

Measured with `docker stats` on a development machine (Docker Desktop, 8 GiB VM), at idle, right after start-up, on 2026-09-25. These are **estimates only**; task A10 does the formal measurement on the target server.

| Profile | RAM in use (idle) | Suggested minimum for the server | CPU |
|---|---|---|---|
| `core` | about 1.3 GiB (LiteLLM about 0.8 GiB; PostgreSQL, Temporal, SeaweedFS about 0.15–0.2 GiB each; Valkey, OpenBao, Temporal UI under 30 MiB each) | 3 GiB RAM | 2 vCPU. Idle use is well below one core |
| `core + observability` | about 3.7 GiB (adds Langfuse web about 1.3 GiB, Langfuse worker about 0.75 GiB, ClickHouse about 0.4 GiB) | 6 GiB RAM | 4 vCPU |

- Disk for images: about 4.5 GB for `core` and about 4.7 GB more for `observability`. Data volumes start small and grow with use.
- Add room for the platform processes (api, worker, runner) and 1–2 agent sandboxes (D-03 section 10.1).
- Profile `sandbox` (estimates, A10 measures): socket proxy about 10 MiB, runner about 100–150 MiB, Verdaccio about 100–200 MiB, registry about 20 MiB, so about 0.3–0.4 GiB in total, plus **up to 2 GiB per sandbox** (`SDLC_RUNNER_SANDBOX_MEMORY_MB`, 1 sandbox by default). Disk: the `node24` image is about 0.85 GB compressed and about 3 GB unpacked; the npm cache grows with use (1–5 GB typical); clones up to `SDLC_RUNNER_WORKSPACE_MAX_MB` per running sandbox.

## Tests

| Command | What it checks | Needs Docker |
|---|---|---|
| `pnpm test` | Static checks of the compose file, `.env.example`, `init-env.sh` and `.gitignore` (`platform/tests/deploy/`) | No |
| `pnpm test:db` | Migrations and tenant isolation on a throw-away PostgreSQL container (same image and init script). Takes about 10 seconds ([ADR-M09](../../design/ADR-M09-database-tooling.md) section 2.6) | Yes |
| `pnpm test:openbao` | OpenBao bootstrap (A03): starts only `openbao` in a throw-away Compose project, runs `init`, `unseal`, `configure`, `root-token`, checks every AppRole's access, re-runs `configure`, then removes everything. Throw-away keys, kept in memory only. About 1 minute | Yes |
| `pnpm test:runner` | The runner on the local Docker Engine: sandbox egress and hardening, the provisioning flow, the clean-up after a restart (throw-away PostgreSQL, fixture image) | Yes |
| `pnpm test:runner-compose` | The `sdlc-runner` container in the profile `sandbox` on a throw-away Compose project: `runner-credentials`, socket proxy, clean-up at start, health check, no secret in the container. About 1 minute | Yes |
| `pnpm test:sandbox-image` | Builds the sandbox image `node24` and runs it hardened with the real Verdaccio: Node 24, pnpm through corepack and the proxy, no other way out. Needs internet | Yes |
| `pnpm test:compose` | Starts `core`, then `core + observability`, with a throw-away env file, its own project name and ports shifted by 20000. Checks health, databases, namespace, buckets, Valkey policy, OpenBao state, Langfuse sign-up and trace upload. Removes everything afterwards. Takes about 2–5 minutes | Yes |
