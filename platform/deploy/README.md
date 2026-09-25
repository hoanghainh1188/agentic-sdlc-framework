# Platform infrastructure (Docker Compose)

This folder runs the infrastructure that the platform reuses, on one server, with Docker Compose (D-03 section 10, task A02). Image versions, licences and trade-offs: [ADR-M17](../../design/ADR-M17-compose-infrastructure.md).

## Profiles

| Profile | Services | When to use |
|---|---|---|
| `core` | PostgreSQL, Temporal (+ Temporal UI), LiteLLM, Valkey, SeaweedFS (S3 API), OpenBao | Always. Required by the platform |
| `observability` | Langfuse (web + worker), ClickHouse. Reuses PostgreSQL, Valkey and SeaweedFS | Optional. The heaviest part; enable it when the server has room (D-03 section 10.1) |

Three one-shot jobs run at every start and then exit: `temporal-schema` (creates or upgrades the Temporal schemas), `temporal-namespace` (creates the namespace) and `seaweedfs-init` (creates the `evidence` and `langfuse` buckets). All three are safe to re-run.

## Requirements

- Docker Engine with Docker Compose v2.24 or later.
- `openssl` (for `init-env.sh`).
- Node.js 24 + pnpm 10 only for the `pnpm` shortcuts and tests. The shell scripts work without them.

## Start and stop

Run from the repo root.

```bash
pnpm compose:env     # once: creates platform/deploy/.env with random secrets (mode 600)
pnpm compose:core    # starts the core profile and waits until it is healthy
pnpm compose:obs     # core + observability
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
| LiteLLM | 4000 | No models yet (added in M-C) |
| SeaweedFS S3 | 8333 | Anonymous access denied |
| OpenBao | 8200 | See below |
| Langfuse | 3000 | `observability` profile only |

Valkey, ClickHouse and the Langfuse worker publish no port.

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

Add `--tenant <slug>` for one tenant, `--json` for machine-readable output. Until task B04 the command connects straight to the database; B04 moves it behind the API.

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

## Health: what "healthy" means

| Service | Healthy means |
|---|---|
| PostgreSQL | `pg_isready` answers |
| Temporal | The frontend gRPC port accepts connections. The `temporal-namespace` job then checks full cluster health with the Temporal CLI |
| Temporal UI, Langfuse web and worker, ClickHouse, SeaweedFS | Their HTTP health endpoint answers |
| Valkey | `PING` with the password returns `PONG` |
| LiteLLM | `/health/liveliness` answers |
| **OpenBao** | **The API is reachable. It does NOT mean initialised or unsealed.** After A02, OpenBao is uninitialised and sealed; task A03 initialises it (Shamir 3-of-2). After every restart, OpenBao is sealed again until two key holders unseal it (D-03 section 10.2). Check with `curl -s http://127.0.0.1:8200/v1/sys/seal-status` |

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

## Tests

| Command | What it checks | Needs Docker |
|---|---|---|
| `pnpm test` | Static checks of the compose file, `.env.example`, `init-env.sh` and `.gitignore` (`platform/tests/deploy/`) | No |
| `pnpm test:db` | Migrations and tenant isolation on a throw-away PostgreSQL container (same image and init script). Takes about 10 seconds ([ADR-M09](../../design/ADR-M09-database-tooling.md) section 2.6) | Yes |
| `pnpm test:compose` | Starts `core`, then `core + observability`, with a throw-away env file, its own project name and ports shifted by 20000. Checks health, databases, namespace, buckets, Valkey policy, OpenBao state, Langfuse sign-up and trace upload. Removes everything afterwards. Takes about 2–5 minutes | Yes |
