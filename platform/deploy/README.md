# Platform deployment and operations (Docker Compose)

This folder runs the infrastructure that the platform reuses, on one server, with Docker Compose (D-03 section 10, task A02). Image versions, licences and trade-offs: [ADR-M17](../../design/ADR-M17-compose-infrastructure.md).

## Profiles

| Profile | Services | When to use |
|---|---|---|
| `core` | PostgreSQL, Temporal (+ Temporal UI), LiteLLM, Valkey, SeaweedFS (S3 API), OpenBao | Always. Required by the platform |
| `observability` | Langfuse (web + worker), ClickHouse, the OpenTelemetry Collector (A08). Reuses PostgreSQL, Valkey and SeaweedFS | Optional. The heaviest part; enable it when the server has room (D-03 section 10.1) |
| `models` | `litellm-agent`: a sidecar (a helper container next to LiteLLM) that reads LiteLLM's model provider keys, master key and salt key from OpenBao and writes its configuration ([ADR-M24](../../design/ADR-M24-litellm-cost-controller.md)) | **Always on the server** (`pnpm compose:models`). Needs OpenBao unsealed and configured and the sidecar's credentials (runbook T11 §5d). Without it, LiteLLM has no models and uses the development keys from `.env` |
| `platform` | `sdlc-api`: the REST API and the dashboard ([ADR-M26](../../design/ADR-M26-api-app.md)); `sdlc-worker`: the GitHub poller, the intent workflow, the escalation clocks and the retention loop ([ADR-M27](../../design/ADR-M27-github-poller.md), [ADR-M30](../../design/ADR-M30-intent-workflow.md)). Both built from this repository | With `core` (`pnpm compose:platform`). Needs OpenBao unsealed and configured, `pnpm openbao:bootstrap api-credentials` and `worker-credentials` first, and the GitHub App key stored (runbook T11 §5b, §5e, §5f) |
| `sandbox` | `sdlc-runner` (built from this repository; runs the agent sandboxes), `docker-socket-proxy` (the runner's only way to Docker), `npm-proxy` (Verdaccio: npm packages for the sandboxes), `registry` (sandbox images, 127.0.0.1 only) ([ADR-M25](../../design/ADR-M25-runner-sandbox.md)) | With `core` (`pnpm compose:sandbox`). Needs OpenBao unsealed and configured, `SDLC_DOCKER_GID` right and `pnpm openbao:bootstrap runner-credentials` first (runbook T11 §5g) |

Three one-shot jobs run at every start and then exit: `temporal-schema` (creates or upgrades the Temporal schemas), `temporal-namespace` (creates the namespace) and `seaweedfs-init` (creates the `evidence` and `langfuse` buckets). All three are safe to re-run.

## Requirements

- Docker Engine with Docker Compose v2.24 or later.
- OpenSSL 3 or later as `openssl` on the `PATH` (for `init-env.sh`, OpenBao's TLS certificates and the TLS tests of `@sdlc/secrets`). On macOS, `/usr/bin/openssl` is LibreSSL, and the TLS tests stop with a message when they find it: install OpenSSL 3 (`brew install openssl@3`) and put it first (`export PATH="$(brew --prefix openssl@3)/bin:$PATH"`).
- Node.js 24 + pnpm 10 (`corepack enable` once). The fresh deployment below needs them (`pnpm install`, `pnpm openbao:bootstrap`, `pnpm db:migrate`, `pnpm sdlc ops …`), and so do the `pnpm` shortcuts and the tests. Only starting and stopping the containers works without them (`init-env.sh`, `up.sh`).

## Where to run it

[Proposal] Recommended until task A10 measures and hardens the target server:

| Item | Recommendation |
|---|---|
| Host | One internal Linux server (or VM) with Docker Engine and Docker Compose. Docker Desktop on a laptop is for development and the trial only |
| Network | Outbound HTTPS only: to GitHub, the model providers, the npm registry and the image registries ([Network and data flows](#network-and-data-flows)). No inbound connection from the internet: the platform polls GitHub and needs no webhook |
| Size | See [Resource estimate](#resource-estimate): about 3 GiB RAM and 2 vCPU for `core`, 6 GiB and 4 vCPU with `observability`, plus up to 2 GiB per running sandbox. Estimates only, not measured on a server yet (A10) |
| GPU | Not needed with API models. Only for a self-hosted model on the same machine (D-07 §3) |
| Sandboxes | 1 by default (`SDLC_RUNNER_MAX_SANDBOXES`); 2 on a larger server |
| The runner | In its own VM or with rootless Docker, because it controls Docker (ADR-M25 §2.5). Not yet done (A10) |
| OpenBao | TLS on port 8200 runs everywhere (A10); on the server the certificate comes from the company CA ([T11 §3c](../../handbook/03-templates/T11-openbao-runbook.md#3c-tls-on-port-8200-the-ca-the-certificate-renewal)). Three named key holders before any real secret or client data (runbook T11 §3.2): not yet done (A10) |
| Backups | Off the server, encrypted ([Backup and restore](#backup-and-restore)) |

**Access from other machines: not supported yet.** The API and the dashboard listen on `127.0.0.1:8090` of the server only. TLS and a reverse proxy for team access come later (A10, M-F). Until then, people use the CLI and the dashboard on the server itself; an SSH tunnel to `127.0.0.1:8090` works for one person, but it is not a supported set-up. Comment commands and reviews on GitHub work from anywhere.

## Create the GitHub App (operator)

The platform reaches each project's repository through one **GitHub App** per installation of the platform (`design/ADR-M23-github-adapter.md` §2.2). The operator creates it once, in the browser, and installs it on every project repository. Never let a chat tool or an AI session handle the private key.

### Option A: from the manifest (recommended)

`platform/deploy/github-app/manifest.json` holds the App's settings: exactly the permissions of [The GitHub App's settings](#github-app-permissions), webhook off, installable only on your own account (D-08 V03). Run, **yourself, in a terminal** (never through a chat tool):

```bash
pnpm github-app:create --out ~/secrets/sdlc-app.private-key.pem
```

- Add `--org <organization>` to create the App in an organization you administer, `--name <name>` to choose its name (default `sdlc-<random>`, at most 34 characters), `--force` to replace an existing key file.
- It prints a local page (`http://127.0.0.1:<port>/`). Open it in the browser where you are signed in to GitHub and press the button; GitHub shows the App with its permissions; confirm with **Create GitHub App**. GitHub sends the browser back to `127.0.0.1`, and the command finishes the App (`POST /app-manifests/{code}/conversions`).
- It saves the private key to `--out` with mode 600 (never inside the repository, never over an existing file without `--force`) and prints only the App ID, the **Client ID** (`Iv…`, not a secret) and the install link. The key is never printed. GitHub also returns a client secret and a webhook secret: the platform uses neither, so they are dropped at once (`design/QUESTIONS.md` #351).
- If the browser cannot open `127.0.0.1` after GitHub (a remote desktop, a browser on another machine), copy the whole address from the browser's address bar and paste it at the command's hidden prompt (QUESTIONS #350). The code from GitHub works once, within one hour; the command waits at most 15 minutes.
- Then **install** the App with the printed link: "Only select repositories", the project's application repository (step 6 below).

### Option B: by hand (the fallback)

1. Open the App settings of the account or organization that owns the project repositories: Settings → Developer settings → GitHub Apps → **New GitHub App**.
2. Fill in the form:

   | Field | Value |
   |---|---|
   | GitHub App name | A name of your own, for example `<company>-sdlc` |
   | Homepage URL | Any URL (for example this repository) |
   | Callback URL | Empty |
   | Webhook → Active | **Off** (the platform polls GitHub) |
   | Where can this App be installed | Only on this account |

3. Set the repository permissions exactly as listed in [The GitHub App's settings](#github-app-permissions); everything else "No access".
4. Note the **Client ID** (`Iv…`). It is not a secret.
5. Generate a **private key** and move the file out of Downloads, outside every repository, readable only by you (`chmod 600`). It goes into OpenBao in [Fresh deployment, step 4](#4-shared-secrets) and nowhere else.
6. **Install** the App on the account: "Only select repositories", the project's application repository. Add a repository later in the same place when a second project joins ([ROLLOUT-GUIDE step 2](../ROLLOUT-GUIDE.md#step-2-set-up-the-platform-for-the-project-operator-tenant-admin-pm--brse-about-1-day)).
7. After a later permission change, accept it on the installation, or tokens keep the old permissions.

The development machine uses a separate **test App** on the fictional sample repository ([GETTING-STARTED Step 11](../GETTING-STARTED.md#step-11-create-the-github-app-devtest)); never reuse a production App there.

## Fresh deployment (operator)

How to bring up the whole platform on a new machine with Docker Compose, from an empty checkout to the first intent at G1 (D-08 E07 AC3). Run every step **yourself, in a terminal, from the repo root**. Several steps print or ask for key shares, tokens or keys at a hidden prompt: never run them through a chat tool, and never paste their output anywhere except your password manager. `pnpm test:fresh-deploy` runs the same steps on a throw-away Compose project with throw-away keys (section [Tests](#tests)).

**Trying the platform on a developer machine (the community trial)?** `pnpm trial:up --settings <file>` runs steps 2–13 below for you with throw-away keys, on its own Compose project `sdlc-trial` ([TRIAL.md §3.2](../../TRIAL.md#32-the-platform), D-08 V02). Never on a server.

After the first deployment: [Restart after a reboot](#restart-after-a-reboot), [Upgrade](#upgrade), [Troubleshooting](#troubleshooting). Use [Step 14](../GETTING-STARTED.md#step-14-prepare-the-pilot-repo-for-live-tests-dev) for the live tests on the pilot repository.

### 1. Prerequisites

- The [Requirements](#requirements) above (Docker Compose v2.24+, Node.js 24, pnpm 10 with `corepack enable`, OpenSSL 3).
- A GitHub App installed on the project's repository only, and its private key in a file outside the repo. The App's settings are below; how to create one, step by step: [Create the GitHub App](#create-the-github-app-operator).
- On the internal server: the three OpenBao key holders are named (runbook T11 §3.2, task A10), and OpenBao's certificate is issued with the company CA ([T11 §3c](../../handbook/03-templates/T11-openbao-runbook.md#3c-tls-on-port-8200-the-ca-the-certificate-renewal)). Until then, use this procedure on a development machine with throw-away keys only.
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

It creates `platform/deploy/.env` with random passwords (mode 600, never overwritten). It also makes a throw-away CA and OpenBao's TLS certificate in `platform/deploy/openbao-tls/` (Git-ignored; the CA key is deleted at once) and sets `SDLC_OPENBAO_TLS_DIR`. On the server, replace them with the company CA's certificate before step 3: `pnpm openbao:tls ca <offline folder>`, then `pnpm openbao:tls server <offline folder>` ([T11 §3c](../../handbook/03-templates/T11-openbao-runbook.md#3c-tls-on-port-8200-the-ca-the-certificate-renewal)). It also fills `SDLC_DOCKER_GID`, the group ID of the Docker socket: check it on the server (runbook T11 §5g). On the server, leave `LITELLM_MASTER_KEY` and `LITELLM_SALT_KEY` empty (runbook T11 §5d).

### 3. OpenBao

Start only OpenBao, PostgreSQL and SeaweedFS (the credentials commands of step 5 create SeaweedFS identities). The whole `core` profile cannot be healthy yet: on the server, LiteLLM gets its keys from OpenBao (profile `models`, step 7), and `.env` holds none.

```bash
docker compose -f platform/deploy/docker-compose.yml --env-file platform/deploy/.env --profile core up -d --wait openbao postgres seaweedfs
pnpm openbao:bootstrap init       # 3 key shares and a root token, printed ONCE to the terminal
pnpm openbao:bootstrap unseal     # 2 shares at the hidden prompt
pnpm openbao:bootstrap configure  # root token at the hidden prompt; KV, Transit, every AppRole
```

KV is OpenBao's key-value store for secrets; Transit signs the Run Contracts; an AppRole is a login for one platform process (a role ID plus a secret ID that expires).

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
pnpm openbao:bootstrap backup-credentials           # T11 §6 (the backup job: OpenBao's snapshot only)
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
```

The worker's retention loop starts in `report` mode: it deletes nothing (runbook T11 §5j).

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
- The operator's commands on the server are `sdlc ops …`: they connect to the database with `SDLC_DB_URL` as the actor `system`. Besides `bootstrap`:

  | Command | Use |
  |---|---|
  | `sdlc ops token issue\|list\|revoke` | API tokens for an existing user |
  | `sdlc ops audit verify` | Check the audit log's hash chain ([Checking the audit log](#checking-the-audit-log)) |
  | `sdlc ops tenant-admin grant\|revoke\|list`, `sdlc ops role grant\|revoke` | A tenant with one admin, or a tenant that lost its admins |
  | `sdlc ops ai-record set\|show` | The project AI record, on behalf of a person with a write role |
  | `sdlc ops agent show\|list\|suspend\|quarantine` | Safety moves on the agent register when the API is down |
  | `sdlc ops run kill` | The kill switch as the system |
  | `sdlc ops retention report` | What the retention loop would purge |

  For example, a token for an existing user:

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

Do the same for Person B (`--role person_b`) and every other role you need (the rules and every command: [handbook Ch.19 §19.8d](../../handbook/02-playbook/ch19-approval-queues.md#198d-using-the-platform-setting-up-a-team-admins)). Person A and Person B are always two different people with two GitHub accounts. The numeric ID comes from `gh api users/<login> --jq .id`. Each person replaces the issued token with their own (`sdlc token create`, then `sdlc token revoke`).

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

`pnpm sdlc admin config show --project <project>` shows the current configuration version; `config set` below needs it as `--expected-version`. Write the settings that differ from the defaults into a YAML file outside the repo, at least:

```yaml
run:
  agent_key: <agent-key>
sandbox:
  image: <the reference of step 10>
verification:
  required_checks: [<the repository's required CI check>]
```

Then `pnpm sdlc admin config set --project <project> --file <file> --expected-version <version>` ([handbook Ch.19 §19.8d](../../handbook/02-playbook/ch19-approval-queues.md#198d-using-the-platform-setting-up-a-team-admins)).

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

## Restart after a reboot

After a reboot (or `pnpm compose:down`) OpenBao is sealed again, and LiteLLM, the API, the worker, the runner and `litellm-agent` cannot become healthy until it is unsealed. On the server, `up.sh core` alone never becomes healthy either: LiteLLM gets its keys from OpenBao (profile `models`). The order:

```bash
docker compose -f platform/deploy/docker-compose.yml --env-file platform/deploy/.env --profile core up -d --wait openbao postgres seaweedfs
pnpm openbao:bootstrap status     # says sealed
pnpm openbao:bootstrap unseal     # two key holders, each their share at the hidden prompt (runbook T11 §4)
platform/deploy/scripts/up.sh core models platform sandbox   # add observability if you use it
curl -s http://127.0.0.1:8090/health/ready
```

- **No credentials command is needed** after a plain restart: the AppRole secret IDs stay in the services' volumes for 90 days.
- After a `git pull` with new code, follow [Upgrade](#upgrade) instead (migrations, images).
- Record the restart and who unsealed in the operations log (T11 §4).
- On a development machine, [GETTING-STARTED Step 13](../GETTING-STARTED.md#step-13-restart-the-dev-stack-after-a-break-dev) is the same procedure with `up.sh core` (the LiteLLM keys are in `.env` there).

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

OpenBao is reachable only on the Compose network (`design/QUESTIONS.md` #27, task A11). The platform processes run in Compose and use `https://openbao:8200`, verified with the CA of the volume `openbao-ca` (TLS since A10, [T11 §3c](../../handbook/03-templates/T11-openbao-runbook.md#3c-tls-on-port-8200-the-ca-the-certificate-renewal)). Key holders and admins work inside the container with `pnpm openbao:bootstrap …` or `docker compose … exec openbao …` (runbook T11). There is no host port for `curl`.

SeaweedFS (task A12, `design/ADR-M52-seaweedfs-internal-access.md`): only the S3 API (8333) listens on the Compose network; every platform process uses it with its own identity. The master, volume server and filer listen on `127.0.0.1` inside the container and need JWT keys that `seaweedfs/start.sh` makes at every start (kept nowhere else; no keys, no start). Admin work: `docker compose … exec seaweedfs weed shell -master=127.0.0.1:9333` (runbook T11 §5l). `seaweedfs-init` runs in the container's network namespace.

## Network and data flows

What leaves the server, and what stays on it. The data classes and which models may receive them: [D-07 §4](../../design/D-07-model-and-token-management.md).

| Goes out to | From | What is sent |
|---|---|---|
| GitHub API (`api.github.com`) and Git over HTTPS | `sdlc-api`, `sdlc-worker`, `sdlc-runner` | Reads issues, comments, reviews, CI results, specs and plans; clones; pushes `agent/INT-…` branches; opens pull requests and posts comments with codes only |
| The model providers (for example Anthropic), through LiteLLM | `litellm` | The agent's prompts: the task, the spec, the plan and **parts of the project's code**. A self-hosted model keeps them on your infrastructure; `client_restricted` data may go only to self-hosted models |
| The npm registry (`registry.npmjs.org`) | `npm-proxy` (Verdaccio) | Package downloads for the sandboxes |
| Image registries (Docker Hub, GHCR) | Docker, at pull and build time | Image downloads |

| Stays on the server | Where | Kept |
|---|---|---|
| Each run's diff, L1 proposals, Evidence Packs | SeaweedFS | At least 180 days (object lock); purged after the project's retention only when the retention loop runs in `purge` mode (`report` by default: it deletes nothing) ([handbook Ch.15 §15.10.2](../../handbook/02-playbook/ch15-p5-release.md#15102-the-evidence-pack)) |
| Model prompts and answers | Langfuse (profile `observability` only) | Until the retention purge of the same loop (`purge` mode only) |
| Audit log, gate decisions, escalations | PostgreSQL | At least 2 years |
| Secrets and keys | OpenBao | Until rotated |

Sandboxes reach only LiteLLM and the package proxy; never GitHub, OpenBao or the internet. The platform keeps no working copy of the code: clones are removed when a run ends.

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
- The real initialisation on the internal server waits until the three key holders are named and the company CA's certificate is issued (T11 §3.2, §3c, `design/QUESTIONS.md` #20).

## Health: what "healthy" means

| Service | Healthy means |
|---|---|
| PostgreSQL | `pg_isready` answers |
| Temporal | The frontend gRPC port accepts connections. The `temporal-namespace` job then checks full cluster health with the Temporal CLI |
| Temporal UI, Langfuse web and worker, ClickHouse, SeaweedFS | Their HTTP health endpoint answers |
| OpenTelemetry Collector | Its `health_check` extension answers (inside the container) |
| Valkey | `PING` with the password returns `PONG` |
| LiteLLM | `/health/liveliness` answers |
| **OpenBao** | **The API answers over TLS with a certificate the CA accepts (`bao status`). It does NOT mean initialised or unsealed.** A new volume is uninitialised and sealed; initialise it with `openbao/bootstrap.sh` (see above). After every restart, OpenBao is sealed again until two key holders unseal it (D-03 section 10.2). Check with `pnpm openbao:bootstrap status` (OpenBao publishes no host port) |

## Logs and traces (A08)

Design: [ADR-M35](../../design/ADR-M35-observability.md). Usage for operators: [handbook Chapter 18 §18.8c](../../handbook/02-playbook/ch18-timeouts-rollback-and-containment.md#188c-using-the-platform-logs-and-traces-of-a-run).

- **Logs.** `sdlc-api`, `sdlc-worker` and `sdlc-runner` write one JSON line per event, with `tenant_id`, `intent_id` and `run_id` when known. Only codes, IDs and counts; never a token, a key or client data.
- **Traces are off unless `SDLC_OTEL_ENDPOINT` is set.** `up.sh` sets it to `http://otel-collector:4318` when `observability` is one of the profiles of the same call, so start the profiles that use it together:

  ```bash
  platform/deploy/scripts/up.sh core models platform observability
  ```

  `pnpm compose:obs` alone starts Langfuse and the collector, but no traced process.
- The **OpenTelemetry Collector** (`otel-collector`, image `sdlc-otel-collector:0.161.0` built from `otel-collector/`) receives traces (OTLP, the OpenTelemetry format) from the api, the worker and LiteLLM without credentials and forwards it to Langfuse v4. It is the only service with the Langfuse project key (`LANGFUSE_INIT_PROJECT_PUBLIC_KEY` / `…_SECRET_KEY` from `.env`; OpenBao with A10). No host port; sandboxes never reach it.
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

## Backup and restore

`pnpm backup` backs up the whole platform into one encrypted folder: every database, OpenBao's snapshot, the volumes of SeaweedFS (evidence, audit anchors), OpenBao's audit log and ClickHouse, the env file and OpenBao's TLS folder (task A10, `design/ADR-M63-openbao-tls-and-backups.md`). Each part is encrypted with `age` as it streams; the server holds only the public key, so it cannot read its own backups.

| Setting (env file) | Meaning |
|---|---|
| `SDLC_BACKUP_DIR` | Target folder, outside the repository: a mounted NAS or an external disk. Copying it further away is the company infrastructure's job |
| `SDLC_BACKUP_AGE_RECIPIENTS` | File with the age public key (`age1…`). The private key stays offline with the OpenBao key shares |
| `SDLC_BACKUP_KEEP` | How many backups to keep (default 14) |

- Set up once: install `age`, make the key pair away from the server, set the variables, `pnpm openbao:bootstrap backup-credentials`, and the daily systemd timer (`backup/sdlc-backup.service`, `.timer`): [runbook T11 §6](../../handbook/03-templates/T11-openbao-runbook.md#6-daily-backup).
- SeaweedFS and ClickHouse stop for about a minute during the copy; run it at night (the timer: 02:30).
- Restore, also the recovery drill every 3 months: `pnpm restore <backup folder> <age private key file>` into an empty stack, then two key holders unseal with their original shares: [runbook T11 §7](../../handbook/03-templates/T11-openbao-runbook.md#7-restore-and-the-recovery-drill). `pnpm test:backup` runs the whole drill on throw-away keys.
- Every backup holds personal data, client code (the evidence) and every password, encrypted: treat it like the server.

## Upgrade

Upgrades come from `main` as reviewed changes; read the [CHANGELOG](../../CHANGELOG.md) first.

1. Take a backup: `pnpm backup` ([above](#backup-and-restore)); it holds OpenBao's snapshot, the way back after an OpenBao image change ([T11 §4b](../../handbook/03-templates/T11-openbao-runbook.md#4b-upgrading-the-openbao-image)).
2. `git pull`, then `pnpm install && pnpm build`.
3. Add any new `.env` variables (`.env.example` lists them; `init-env.sh` never overwrites `.env`). After the A10 update (TLS on OpenBao): `pnpm openbao:tls dev` on a development machine; on the server, the company CA ([T11 §3c](../../handbook/03-templates/T11-openbao-runbook.md#3c-tls-on-port-8200-the-ca-the-certificate-renewal)).
4. Pull the pinned images and rebuild the platform images (and the sandbox image when `platform/sandbox-images/` changed: `pnpm sandbox-image:build node24`, then the new digest in `sandbox.image`): `docker compose -f platform/deploy/docker-compose.yml --env-file platform/deploy/.env --profile core --profile models --profile platform --profile sandbox pull`, then the same with `build` (add `--profile observability` when you use it).
5. Start only OpenBao, PostgreSQL and SeaweedFS, unseal OpenBao ([Restart after a reboot](#restart-after-a-reboot), first three commands), apply new migrations ([step 6](#6-database)), then start everything ([step 7](#7-start-the-platform)).
6. Run a credentials command only when the CHANGELOG says an update added one or gave one new rights ([Fresh deployment, step 5](#5-credentials-of-every-process)).
7. Check: `curl -s http://127.0.0.1:8090/health/ready`, and no `…_missing` line in the logs ([Troubleshooting](#troubleshooting)).

Never run `docker volume prune` or `docker system prune --volumes`: they delete the platform's data.

## Troubleshooting

| You see | Cause | Do |
|---|---|---|
| `sdlc-api`, `sdlc-worker` or `sdlc-runner` restart every minute; the log says "OpenBao at … is sealed" | OpenBao is sealed after a restart | `pnpm openbao:bootstrap status`, then two key holders unseal it (runbook T11 §4) |
| `up.sh` times out with the `core`, `platform`, `models` or `sandbox` profile | OpenBao is sealed, or `up.sh core` was run alone on the server (LiteLLM has no keys without `models`) | Follow [Restart after a reboot](#restart-after-a-reboot) |
| A log line ending in `_missing` (for example `worker.evidence_missing`) | A process has no credential for that feature | Run the credentials command the message names ([step 5](#5-credentials-of-every-process); `worker-langfuse-credentials`: [step 7](#7-start-the-platform)), then restart the service |
| `openbao` does not start; `openbao-tls-init` says a file is missing in `SDLC_OPENBAO_TLS_DIR` | No TLS certificate for OpenBao (an `.env` from before A10, or a missing file) | Development: `pnpm openbao:tls dev`. Server: [T11 §3c](../../handbook/03-templates/T11-openbao-runbook.md#3c-tls-on-port-8200-the-ca-the-certificate-renewal) |
| `up.sh` warns that OpenBao's TLS certificate ends soon | Less than 30 days left | Renew: [T11 §3c](../../handbook/03-templates/T11-openbao-runbook.md#3c-tls-on-port-8200-the-ca-the-certificate-renewal); OpenBao stays unsealed |
| "AppRole login failed (HTTP status 400)" in a log | The AppRole secret ID expired (90 days) or was destroyed | That process's credentials command again, then restart it |
| `worker.runs_off`; every intent waits at G4 | The worker has no `cost-controller` AppRole | `pnpm openbao:bootstrap worker-credentials`, restart `sdlc-worker` |
| Intents wait at G8; packs answer `evidence_unavailable` | No evidence credential for the worker or the API | `api-evidence-credentials` (runbook T11 §5h) or `worker-evidence-credentials` (§5i) |
| `worker.cost_sync_gap` | The spend sync was down longer than its catch-up window | [Scheduled spend sync](#scheduled-spend-sync-c12) |
| LiteLLM lists no model | Profile `models` not started, or the provider entry is not in OpenBao | `pnpm compose:models`; runbook T11 §5d |
| A service stays unhealthy | See its log | `docker compose -f platform/deploy/docker-compose.yml logs <service>`; [what "healthy" means](#health-what-healthy-means) |
| Valkey writes fail in Langfuse and LiteLLM | Valkey is full | [Shared Valkey](#shared-valkey-memory-limit) |

Problems with a gate or an intent (refused commands, held intents, escalations): [USER-GUIDE §5](../USER-GUIDE.md#5-when-something-goes-wrong). Still stuck: open an issue with the bug report template, and never paste a log line with a secret or client data. Security problems: [SECURITY.md](../../SECURITY.md).

## Uninstall

This deletes every intent, the evidence, the audit log and the secrets. Keep a backup first if the records must be kept (the audit log at least 2 years, handbook Ch.3).

1. Stop and remove the containers and their volumes: `docker compose -f platform/deploy/docker-compose.yml --env-file platform/deploy/.env --profile core --profile observability --profile models --profile platform --profile sandbox down -v`.
2. Remove the per-run objects the runner may have left after a crash: containers, networks and volumes whose name starts with `sdlc-sandbox-`, `sdlc-run-` or `sdlc-ws-` (`docker ps -a`, `docker network ls`, `docker volume ls`).
3. Remove the images if you want the disk back (`docker image ls`).
4. On GitHub: uninstall the GitHub App from the repositories, then delete the App and its private key.
5. Revoke the model provider keys that were stored in OpenBao, at each provider.
6. Delete `platform/deploy/.env` and the checkout.

## Tests

| Command | What it checks | Needs Docker |
|---|---|---|
| `pnpm test` | Static checks of the compose file, `.env.example`, `init-env.sh` and `.gitignore` (`platform/tests/deploy/`) | No |
| `pnpm test:db` | Migrations and tenant isolation on a throw-away PostgreSQL container (same image and init script). Takes about 10 seconds ([ADR-M09](../../design/ADR-M09-database-tooling.md) section 2.6) | Yes |
| `pnpm test:backup` | A10 PR 2: the backup and the restore drill on a throw-away Compose project (age, throw-away keys): data in every store, `pnpm backup`, the stack removed, a tampered copy refused, `pnpm restore`, the original shares unseal, every piece of data back. A few minutes. Needs `age` | Yes |
| `pnpm test:openbao` | OpenBao bootstrap (A03): starts only `openbao` in a throw-away Compose project, runs `init`, `unseal`, `configure`, `root-token`, checks every AppRole's access, re-runs `configure`, then removes everything. Throw-away keys, kept in memory only. Also TLS (A10, `tls.test.ts`): a wrong CA, an address other than `openbao` and plain HTTP are refused, a renewal is read without a restart, a missing file stops OpenBao. A few minutes | Yes |
| `pnpm test:runner` | The runner on the local Docker Engine: sandbox egress and hardening, the provisioning flow, the clean-up after a restart (throw-away PostgreSQL, fixture image) | Yes |
| `pnpm test:runner-compose` | The `sdlc-runner` container in the profile `sandbox` on a throw-away Compose project: `runner-credentials`, socket proxy, clean-up at start, health check, no secret in the container. About 1 minute | Yes |
| `pnpm test:sandbox-image` | Builds the sandbox image `node24` and runs it hardened with the real Verdaccio: Node 24, pnpm through corepack and the proxy, no other way out. Needs internet | Yes |
| `pnpm test:observability` | A08 AC3: `core + models + observability` on a throw-away Compose project (ports +27000) with a stub model and throw-away OpenBao keys. One model call through LiteLLM must give a Langfuse trace with all seven labels; a span of a platform process must reach Langfuse through the collector; the collector has no host port. About 2 minutes | Yes |
| `pnpm test:fresh-deploy` | E07 AC3: follows the section [Fresh deployment](#fresh-deployment-operator) on a throw-away Compose project (ports +31000, throw-away keys): `compose:env`, OpenBao init, unseal and configure, the shared secrets, every credentials command, the migrations, `up.sh core models platform sandbox`, `ops bootstrap`, the team, the sandbox image, the agent, the configuration, the AI record and the first intent at G1, then `sdlc audit verify`. CI: weekly and manual runs only. Prints `e07:fresh_deploy_seconds` | Yes |
| `pnpm test:compose` | Starts `core`, then `core + observability`, with a throw-away env file, its own project name and ports shifted by 20000. Checks health, databases, namespace, buckets, Valkey policy, OpenBao state, Langfuse sign-up and trace upload. Removes everything afterwards. Takes about 2–5 minutes | Yes |
