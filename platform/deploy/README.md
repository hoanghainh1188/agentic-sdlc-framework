# Platform infrastructure (Docker Compose)

This folder runs the infrastructure that the platform reuses, on one server, with Docker Compose (D-03 section 10, task A02). Image versions, licences and trade-offs: [ADR-M17](../../design/ADR-M17-compose-infrastructure.md).

## Profiles

| Profile | Services | When to use |
|---|---|---|
| `core` | PostgreSQL, Temporal (+ Temporal UI), LiteLLM, Valkey, SeaweedFS (S3 API), OpenBao | Always. Required by the platform |
| `observability` | Langfuse (web + worker), ClickHouse, the OpenTelemetry Collector (A08). Reuses PostgreSQL, Valkey and SeaweedFS | Optional. The heaviest part; enable it when the server has room (D-03 section 10.1) |
| `models` | `litellm-agent`: OpenBao Agent that gives LiteLLM its model provider keys, master key and salt key from OpenBao (task C03, [ADR-M24](../../design/ADR-M24-litellm-cost-controller.md)) | **Always on the server** (`pnpm compose:models`). Needs OpenBao unsealed and configured and the sidecar's credentials (runbook T11 §5d). Without it, LiteLLM has no models and uses the development keys from `.env` |
| `platform` | `sdlc-api`: the REST API for the CLI (task B03, [ADR-M26](../../design/ADR-M26-api-app.md)); `sdlc-worker`: the GitHub poller and comment commands (task B06, [ADR-M27](../../design/ADR-M27-github-poller.md)), the escalation clocks (B11) and the Temporal worker of the intent workflow (B07, [ADR-M30](../../design/ADR-M30-intent-workflow.md)). Both built from this repo; both reach Temporal on the Compose network | With `core` (`pnpm compose:platform`). Needs OpenBao unsealed and configured, `pnpm openbao:bootstrap api-credentials` and `worker-credentials` first, and the GitHub App key stored (runbook T11 §5b, §5e, §5f) |
| `sandbox` | `sdlc-runner` (built from this repo), `docker-socket-proxy` (wollomatic/socket-proxy: the runner's only way to Docker), `npm-proxy` (Verdaccio: npm packages for the sandboxes), `registry` (local registry for sandbox images, 127.0.0.1 only) (task C04, [ADR-M25](../../design/ADR-M25-runner-sandbox.md)) | With `core` (`pnpm compose:sandbox`). Needs OpenBao unsealed and configured, `SDLC_DOCKER_GID` right and `pnpm openbao:bootstrap runner-credentials` first (runbook T11 §5g) |

Three one-shot jobs run at every start and then exit: `temporal-schema` (creates or upgrades the Temporal schemas), `temporal-namespace` (creates the namespace) and `seaweedfs-init` (creates the `evidence` and `langfuse` buckets). All three are safe to re-run.

## Requirements

- Docker Engine with Docker Compose v2.24 or later.
- OpenSSL 3.x as `openssl` on the `PATH` (for `init-env.sh` and the TLS tests of `@sdlc/secrets`). On macOS, `/usr/bin/openssl` is LibreSSL, and the TLS tests stop with a message when they find it: install OpenSSL 3 (`brew install openssl@3`) and put it first (`export PATH="$(brew --prefix openssl@3)/bin:$PATH"`).
- Node.js 24 + pnpm 10 (`corepack enable` once). The fresh deployment below needs them (`pnpm install`, `pnpm openbao:bootstrap`, `pnpm db:migrate`, `pnpm sdlc ops …`), and so do the `pnpm` shortcuts and the tests. Only starting and stopping the containers works without them (`init-env.sh`, `up.sh`).

## Fresh deployment (operator)

How to bring up the whole platform on a new machine with Docker Compose, from an empty checkout to the first intent at G1 (D-08 E07 AC3). Run every step **yourself, in a terminal, from the repo root**. Several steps print or ask for key shares, tokens or keys at a hidden prompt: never run them through a chat tool, and never paste their output anywhere except your password manager. `pnpm test:fresh-deploy` runs the same steps on a throw-away Compose project with throw-away keys (section [Tests](#tests)).

After the first deployment, use [GETTING-STARTED Step 13](../GETTING-STARTED.md#step-13-restart-the-dev-stack-after-a-break-dev) to restart the stack after a break, and [Step 14](../GETTING-STARTED.md#step-14-prepare-the-pilot-repo-for-live-tests-dev) for the live tests on the pilot repository.

### 1. Prerequisites

- The [Requirements](#requirements) above (Docker Compose v2.24+, Node.js 24, pnpm 10 with `corepack enable`, OpenSSL 3).
- A GitHub App installed on the project's repository only, and its private key in a file outside the repo. The App's settings are below; how to create one, step by step: [GETTING-STARTED Step 11](../GETTING-STARTED.md#step-11-create-the-github-app-devtest).
- On the internal server: the three OpenBao key holders are named and TLS is in place (runbook T11 §3.2, task A10). Until then, use this procedure on a development machine with throw-away keys only.
- `pnpm install` and `pnpm build`.

<a id="github-app-permissions"></a>**The GitHub App's settings.** This is the one list of the App's permissions; other documents link here. One App per installation of the platform (`design/ADR-M23-github-adapter.md` §2.2).

| Permission (repository) | Level | Used for |
|---|---|---|
| Contents | Read and write | Clone, read specs and plans; the runner pushes `agent/INT-…` branches (C08) |
| Issues | Read and write | Read comment commands, post status comments and replies |
| Pull requests | Read and write | Open the pull request (C08), read reviews and their feedback (E01) |
| Code scanning alerts | Read-only | Security findings at G6 (C08, QUESTIONS #157) |
| Checks | Read-only | CI results at G6 |
| Commit statuses | Read-only | CI results at G6 |
| Metadata | Read-only | Automatic |

- Everything else "No access"; no organization or account permissions.
- Webhook: **off** (the platform polls GitHub, ADR-M11). Installable only on your own account or organization.
- Install it on **selected repositories** only: the project's application repository.
- After a permission change, accept it on each installation (GitHub asks the owner), or tokens keep the old permissions.

### 2. Settings file

```bash
pnpm compose:env
```

It creates `platform/deploy/.env` with random passwords (mode 600, never overwritten). It also fills `SDLC_DOCKER_GID`, the group ID of the Docker socket: check it on the server (runbook T11 §5g). On the server, leave `LITELLM_MASTER_KEY` and `LITELLM_SALT_KEY` empty (runbook T11 §5d).

### 3. OpenBao

Start only OpenBao, PostgreSQL and SeaweedFS (the credentials commands of step 5 create SeaweedFS identities). The whole `core` profile cannot be healthy yet: on the server, LiteLLM gets its keys from OpenBao (profile `models`, step 7), and `.env` holds none.

```bash
docker compose -f platform/deploy/docker-compose.yml --env-file platform/deploy/.env --profile core up -d --wait openbao postgres seaweedfs
pnpm openbao:bootstrap init       # 3 key shares and a root token, printed ONCE to the terminal
pnpm openbao:bootstrap unseal     # 2 shares at the hidden prompt
pnpm openbao:bootstrap configure  # root token at the hidden prompt; KV, Transit, every AppRole
```

Details and key custody: runbook T11 §3 and §4. `configure` revokes the root token, so make a new one from two shares, then an admin token for the next two steps (T11 §5.1):

```bash
pnpm openbao:bootstrap root-token
docker compose -f platform/deploy/docker-compose.yml --env-file platform/deploy/.env exec openbao sh -c 'read -rs BAO_TOKEN && export BAO_TOKEN && bao token create -role=platform-admin -field=token'
```

The admin token lives one hour and cannot be renewed: do steps 4 and 5 in one go, and make a new token when a command answers `permission denied`. On a development machine, GETTING-STARTED Step 11b has every command of steps 3–7 with its check.

### 4. Shared secrets

With the admin token, store (runbook T11 §5b and §5d; each value is read at a hidden prompt or from a file, never typed into a command line):

- the GitHub App's `client_id` and `private_key` at `kv/shared/github-app` (T11 §5b);
- the LiteLLM master key at `kv/cost-controller/litellm-master-key` (field `value`, starts with `sk-`) and the salt key at `kv/litellm/salt-key` (T11 §5d);
- one key per model provider at `kv/litellm/providers/<provider>`, field `api_key` (T11 §5d). The models are listed in `litellm/config.ctmpl`.

The commands in T11 §5b and §5d end with `stored` or `FAILED`; the master key and the salt key can be made at random inside the container, so nobody sees them (T11 §5b).

### 5. Credentials of every process

Each command asks for the admin token, delivers one AppRole's role ID and a new secret ID into the service's volume, and prints no secret:

```bash
pnpm openbao:bootstrap litellm-credentials          # T11 §5d
pnpm openbao:bootstrap api-credentials              # T11 §5e
pnpm openbao:bootstrap worker-credentials           # T11 §5f (AppRoles worker and cost-controller)
pnpm openbao:bootstrap runner-credentials           # T11 §5g
pnpm openbao:bootstrap runner-evidence-credentials  # T11 §5g (L1 proposals, run diffs)
pnpm openbao:bootstrap api-evidence-credentials     # T11 §5h (Evidence Packs)
pnpm openbao:bootstrap worker-evidence-credentials  # T11 §5i (G8 release packs)
pnpm openbao:bootstrap worker-purge-credentials     # T11 §5j (evidence retention)
pnpm openbao:bootstrap worker-anchor-credentials    # T11 §5k (daily audit anchor)
```

Record each one in the operations log (role, date, reason; never the secret ID).

### 6. Database

```bash
SDLC_DB_MIGRATION_URL="postgres://platform:<PLATFORM_DB_PASSWORD>@127.0.0.1:5432/platform" pnpm db:migrate
```

The password is in `platform/deploy/.env`. `pnpm db:status` (same variable) lists no pending migration.

### 7. Start the platform

```bash
platform/deploy/scripts/up.sh core models platform sandbox
curl -s http://127.0.0.1:8090/health/ready
```

This starts everything else of `core` too. The script waits until every service is healthy. Then check that no process lacks a credential: the logs of `sdlc-api`, `sdlc-worker` and `sdlc-runner` must have no `…_missing` event (GETTING-STARTED Step 11b part 7). A missing one names the credentials command to run again.

Optional, Langfuse (section [Logs and traces](#logs-and-traces-a08)): add `observability` to the `up.sh` call. Then create the worker's own Langfuse key in the Langfuse UI and deliver the worker's purge credentials (runbook T11 §5m), so the retention loop can delete a purged project's traces:

```bash
pnpm openbao:bootstrap worker-langfuse-credentials  # T11 §5m (needs the profile observability)
``` The worker's retention loop starts in `report` mode: it deletes nothing (runbook T11 §5j).

### 8. The tenant and its first admin

```bash
export SDLC_DB_URL="postgres://platform_app:<PLATFORM_APP_DB_PASSWORD>@127.0.0.1:5432/platform"
pnpm sdlc ops bootstrap --tenant <slug> --tenant-name "<name>" --email <you> --name "<your name>"
pnpm sdlc login --api-url http://127.0.0.1:8090
```

The bootstrap creates the tenant, its first user and that user's first personal API token (`sdlc_pat_…`, [ADR-M26](../../design/ADR-M26-api-app.md) §2.2), and makes the user the first **tenant admin** (task B13). `sdlc login` reads the token at a hidden prompt. From here on, everything goes through the API: people set up projects, users and roles with `sdlc admin …` and their own tokens with `sdlc token …` (handbook [Ch.19 §19.8c](../../handbook/02-playbook/ch19-approval-queues.md#198c-using-the-platform-the-sdlc-command) and [§19.8d](../../handbook/02-playbook/ch19-approval-queues.md#198d-using-the-platform-setting-up-a-team-admins)).

- The token is printed **once**. Store it in a password manager; never paste it into a chat, a ticket or a file in a repository.
- The bootstrap runs once per tenant; a second run with the same slug is refused.
- Tokens last 90 days by default, at most 365. Only their SHA-256 hash is stored. Every issue and revocation is written to the audit log (IDs only).
- The operator's commands on the server are `sdlc ops …` (they connect to the database with `SDLC_DB_URL`, actor `system`; renamed from `sdlc admin …` in task B13). Besides `bootstrap`: `sdlc ops token issue|list|revoke`, `sdlc ops audit verify` ([Checking the audit log](#checking-the-audit-log)), `sdlc ops tenant-admin grant|revoke|list` and `sdlc ops role grant|revoke` (for a tenant with one admin, or to recover one that lost its admins), `sdlc ops ai-record set|show`, `sdlc ops agent show|list|suspend|quarantine` (safety moves when the API is down), `sdlc ops run kill`, `sdlc ops retention report`. For example, a token for an existing user:

```bash
pnpm sdlc ops token issue --tenant <slug> --email <email> --name <token name> --days 90
```

### 9. The project and its team

```bash
pnpm sdlc admin project create --slug <project> --name "<name>" --repo <owner/name>
pnpm sdlc admin user create --email <person-a> --name "<name>"
pnpm sdlc admin identity link --user <person-a> --github-id <numeric ID> --github-login <login>
pnpm sdlc admin role grant --project <project> --user <person-a> --role person_a
pnpm sdlc admin token issue --user <person-a> --name <token-name>
```

Do the same for Person B (`--role person_b`) and every other role you need (handbook Ch.19 §19.8d). Person A and Person B are always two different people with two GitHub accounts. The numeric ID comes from `gh api users/<login> --jq .id`. Each person replaces the issued token with their own (`sdlc token create`, then `sdlc token revoke`).

### 10. The sandbox image

```bash
pnpm sandbox-image:build node24
```

It prints the image reference by digest (`…@sha256:…`) for the project configuration (runbook T11 §5g; on Docker Desktop add `--no-push`).

### 11. The agent

```bash
pnpm sdlc admin agent register --key <agent-key> --version 1.0.0 --owner <person-a> \
  --model <gateway model with version> --instructions AGENTS.md@<label> \
  --instructions-file <the repository's AGENTS.md> --tools file_editor,terminal \
  --max-autonomy L2 --environments sandbox
```

Then the agent's owner (`--as owner`) and Person B (`--as person_b`) each run `pnpm sdlc admin agent approve --key <agent-key> --purpose activate` (handbook Ch.20 §20.5b). The model is a gateway model name from `litellm/config.ctmpl`, for example `claude-haiku-4-5-20251001`.

### 12. The project configuration

`pnpm sdlc admin config show --project <project>` gives the version. Write the settings that differ from the defaults into a YAML file outside the repo, at least:

```yaml
run:
  agent_key: <agent-key>
sandbox:
  image: <the reference of step 10>
verification:
  required_checks: [<the repository's required CI check>]
```

Then `pnpm sdlc admin config set --project <project> --file <file> --expected-version <version>` (handbook Ch.19 §19.8d).

### 13. The project AI record

Person A (or the PM / BrSE) records the client's consent (handbook Ch.2 §2.5, template T7):

```bash
pnpm sdlc ai-record set --project <project> --expected-version 0 --ai-allowed yes \
  --classes public,internal --prod-logs no --disclosure standard_note
```

### 14. The first intent

```bash
pnpm sdlc intent create --project <project> --title "<title>" --risk low --data-class internal
pnpm sdlc intent show <INT-YYYY-NNNN>
```

The intent is `in_gate` at `G1`: Person A approves it with `pnpm sdlc gate approve G1 <INT-…>` or `/approve G1` on its issue (handbook Ch.19 §19.8c).

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
docker compose -f platform/deploy/docker-compose.yml --env-file platform/deploy/.env --profile core --profile observability down
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
| SeaweedFS S3 | 8333 | Anonymous access denied. The only SeaweedFS port reachable from outside its container (A12) |
| Langfuse | 3000 | `observability` profile only |
| API (`sdlc-api`) | 8090 | `platform` profile only. 8080 is taken by the Temporal UI. Also serves the read-only dashboard at `/dashboard/` (U01, `SDLC_API_DASHBOARD_DIR`, built into the image; `off` turns it off). Keep it on `127.0.0.1`: the dashboard is not for other machines (ADR-M54 §2.2; how people use it: [handbook Ch.19 §19.8e](../../handbook/02-playbook/ch19-approval-queues.md#198e-using-the-platform-the-dashboard-read-only)) |
| Sandbox image registry | 5050 | `sandbox` profile only. **Always 127.0.0.1** (not `SDLC_BIND_ADDR`): it has no authentication. Not 5000: macOS uses it |

Valkey, ClickHouse, the Langfuse worker, the OpenTelemetry Collector, **OpenBao**, the runner, the socket proxy and the npm proxy publish no port.

OpenBao is reachable only on the Compose network (`design/QUESTIONS.md` #27, task A11). The platform processes run in Compose and use `http://openbao:8200`. Key holders and admins work inside the container with `pnpm openbao:bootstrap …` or `docker compose … exec openbao …` (runbook T11). There is no host port for `curl`.

SeaweedFS (task A12, `design/ADR-M52-seaweedfs-internal-access.md`): only the S3 API (8333) listens on the Compose network; every platform process uses it with its own identity. The master, volume server and filer listen on `127.0.0.1` inside the container and need JWT keys that `seaweedfs/start.sh` makes at every start (kept nowhere else; no keys, no start). Admin work: `docker compose … exec seaweedfs weed shell -master=127.0.0.1:9333` (runbook T11 §5l). `seaweedfs-init` runs in the container's network namespace.

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
SDLC_DB_URL="postgres://platform_app:<PLATFORM_APP_DB_PASSWORD>@127.0.0.1:5432/platform" pnpm sdlc ops audit verify
```

Add `--tenant <slug>` for one tenant, `--json` for machine-readable output. The command connects straight to the database. Tenant admins run the same check through the API with `sdlc audit verify` (task B13, `design/ADR-M37-admin-onboarding.md`).

### First admin and API tokens (task B03)

The first admin, the bootstrap token and the operator's `sdlc ops …` commands: [Fresh deployment, step 8](#8-the-tenant-and-its-first-admin). How people log in and manage their own tokens: handbook [Ch.19 §19.8c](../../handbook/02-playbook/ch19-approval-queues.md#198c-using-the-platform-the-sdlc-command).

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

OpenBao starts **uninitialised and sealed**. `openbao/bootstrap.sh` initialises it (3 key shares, any 2 unseal), unseals it and applies the configuration ([ADR-M19](../../design/ADR-M19-openbao-bootstrap.md)). After every restart it is sealed again.

- The order of the commands on a new machine: [Fresh deployment, step 3](#3-openbao).
- The procedure, the key custody, unsealing after a restart, the settings files and troubleshooting: [runbook T11](../../handbook/03-templates/T11-openbao-runbook.md) §3 and §4 (on a development machine with throw-away keys: §3.1).
- The real initialisation on the internal server waits until the three key holders are named and TLS is in place (T11 §3.2, `design/QUESTIONS.md` #20).

## Health: what "healthy" means

| Service | Healthy means |
|---|---|
| PostgreSQL | `pg_isready` answers |
| Temporal | The frontend gRPC port accepts connections. The `temporal-namespace` job then checks full cluster health with the Temporal CLI |
| Temporal UI, Langfuse web and worker, ClickHouse, SeaweedFS | Their HTTP health endpoint answers |
| OpenTelemetry Collector | Its `health_check` extension answers (inside the container) |
| Valkey | `PING` with the password returns `PONG` |
| LiteLLM | `/health/liveliness` answers |
| **OpenBao** | **The API is reachable. It does NOT mean initialised or unsealed.** A new volume is uninitialised and sealed; initialise it with `openbao/bootstrap.sh` (see above). After every restart, OpenBao is sealed again until two key holders unseal it (D-03 section 10.2). Check with `pnpm openbao:bootstrap status` (OpenBao publishes no host port) |

## Logs and traces (A08)

Design: [ADR-M35](../../design/ADR-M35-observability.md). Usage for operators: handbook Chapter 18 §18.8c.

- **Logs.** `sdlc-api`, `sdlc-worker` and `sdlc-runner` write one JSON line per event, with `tenant_id`, `intent_id` and `run_id` when known. Only codes, IDs and counts; never a token, a key or client data.
- **Traces are off unless `SDLC_OTEL_ENDPOINT` is set.** `up.sh` sets it to `http://otel-collector:4318` when `observability` is one of the profiles of the same call, so start the profiles that use it together:

  ```bash
  platform/deploy/scripts/up.sh core models platform observability
  ```

  `pnpm compose:obs` alone starts Langfuse and the collector, but no traced process.
- The **OpenTelemetry Collector** (`otel-collector`, image `sdlc-otel-collector:0.161.0` built from `otel-collector/`) receives OTLP from the api, the worker and LiteLLM without credentials and forwards it to Langfuse v4. It is the only service with the Langfuse project key (`LANGFUSE_INIT_PROJECT_PUBLIC_KEY` / `…_SECRET_KEY` from `.env`; OpenBao with A10). No host port; sandboxes never reach it.
- **LiteLLM** traces every model call with its `langfuse_otel` callback (rendered by `litellm/config.ctmpl` when the sidecar has `SDLC_OTEL_ENDPOINT`). Each call is one Langfuse trace tagged with the seven labels (`tenant:`, `project:`, `intent_id:`, `run_id:`, `gate:`, `agent:`, `data_class:`). It holds the prompt and the answer: client data (ADR-M35 §2.5).
- Langfuse runs v4 in `events_only` mode: read traces through `GET /api/public/v2/observations` (the old `/api/public/traces` answers 404).

## Scheduled spend sync (C12)

Design: [ADR-M24 §2.5](../../design/ADR-M24-litellm-cost-controller.md). `sdlc-worker` copies spend from LiteLLM into `cost_records` on a schedule, besides the copy when each run ends. It runs only when the worker has the `cost-controller` AppRole (`pnpm openbao:bootstrap worker-credentials`); otherwise it logs `worker.cost_sync_off`. The defaults need no setting:

| Setting | Default | Bounds | Meaning |
|---|---|---|---|
| `SDLC_WORKER_COST_SYNC_INTERVAL_SECONDS` | 300 | 30–3600 | Time between two passes |
| `SDLC_WORKER_COST_SYNC_LOOKBACK_MINUTES` | 120 | 10–1440, at least two intervals | Each pass reads the calls of this window again (LiteLLM writes spend logs in batches) |
| `SDLC_WORKER_COST_SYNC_CATCH_UP_MINUTES` | 1440 | look-back–10080 | The first pass after a start reads this far back; a retry never reaches further |
| `SDLC_WORKER_COST_SYNC_SETTLE_MINUTES` | 30 | 5–1440 | Runs that ended within this window are read again from their start |

Logs: `worker.cost_synced` (counts), `worker.cost_sync_failed` (an error code; the next pass retries from the failed slice), `worker.cost_sync_busy` (another worker holds the lock), and `worker.cost_sync_gap` (warning, `uncovered_minutes`): the sync failed for longer than the catch-up window, so the calls of those minutes are not recorded.

**Manual sync: no operator command yet (open item, ADR-M24 §3).** After a `worker.cost_sync_gap` warning, set `SDLC_WORKER_COST_SYNC_CATCH_UP_MINUTES` to cover the gap (at most 10080, seven days) and restart `sdlc-worker`: its first pass reads that window again. Calls already recorded are never counted twice. Calls older than seven days, or older than LiteLLM keeps its spend logs, cannot be recovered this way.

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
| `pnpm test:observability` | A08 AC3: `core + models + observability` on a throw-away Compose project (ports +27000) with a stub model and throw-away OpenBao keys. One model call through LiteLLM must give a Langfuse trace with all seven labels; a span of a platform process must reach Langfuse through the collector; the collector has no host port. About 2 minutes | Yes |
| `pnpm test:fresh-deploy` | E07 AC3: follows the section [Fresh deployment](#fresh-deployment-operator) on a throw-away Compose project (ports +31000, throw-away keys): `compose:env`, OpenBao init, unseal and configure, the shared secrets, every credentials command, the migrations, `up.sh core models platform sandbox`, `ops bootstrap`, the team, the sandbox image, the agent, the configuration, the AI record and the first intent at G1, then `sdlc audit verify`. CI: weekly and manual runs only. Prints `e07:fresh_deploy_seconds` | Yes |
| `pnpm test:compose` | Starts `core`, then `core + observability`, with a throw-away env file, its own project name and ports shifted by 20000. Checks health, databases, namespace, buckets, Valkey policy, OpenBao state, Langfuse sign-up and trace upload. Removes everything afterwards. Takes about 2–5 minutes | Yes |
