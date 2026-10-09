# Getting started: the platform developer's machine

> **For the developers of the platform** (the repository owner and Claude Code sessions): their machine, the dev stack, the test GitHub App. To use the platform, read [USER-GUIDE.md](USER-GUIDE.md); to install it on a server, read [deploy/README.md](deploy/README.md) "Fresh deployment".

This guide covers: the test GitHub App (Step 11), a dev stack from scratch (Step 11b), the first admin on a dev machine (Step 12), restarting the dev stack (Step 13), the live tests on the pilot repository (Step 14), sending handbook comments and maintaining the backlog. The repository's settings and CI: [CONTRIBUTING.md §2](../CONTRIBUTING.md#2-the-repository). How the repository was first set up in September 2026 (Steps 0–10): [History](#history-the-first-set-up-2026-09) at the end. The step numbers are kept, because other documents and code comments cite them.

---

## Step 11. Create the GitHub App (dev/test)

The GitHub adapter (B05, ADR-M23) talks to GitHub through a **GitHub App**. Use a **dev/test App** that is installed on a test repository only. Production gets its own App later, with its key in the real OpenBao.

Done once by the repo owner in the browser. Claude must never read or handle the private key.

A new test App can also be made from the manifest: `pnpm github-app:create --org harryforge --name <name> --out ~/.config/sdlc-secrets/github-app-dev.pem`, run by the owner in the macOS Terminal ([deploy/README, option A](deploy/README.md#option-a-from-the-manifest-recommended)). The steps below are the manual way.

1. **Test repository.** Public repository `harryforge/pilot-order-inventory` (fictional data only) with a README, and one open issue for the live test (issue #1, "Live test issue (GitHub adapter)").
2. **Create the App:** organization settings → Developer settings → GitHub Apps → **New GitHub App** (`https://github.com/organizations/harryforge/settings/apps/new`).

| Field | Value |
|---|---|
| GitHub App name | `harryforge-sdlc-dev` |
| Homepage URL | `https://github.com/hoanghainh1188/agentic-sdlc-framework` (any URL works; the App was created with the old one) |
| Callback URL | empty |
| Webhook → Active | **off** (the MVP polls, QUESTIONS #43, ADR-M11) |
| Where can this App be installed | Only on this account |

3. **Repository permissions:** set them as listed in [deploy/README, "The GitHub App's settings"](deploy/README.md#github-app-permissions); everything else "No access". After a permission change, accept it on the installation, or tokens keep the old permissions.

4. **Note the Client ID** (`Iv…`). It is not a secret; the adapter uses it as the JWT issuer (the numeric App ID also works).
5. **Private key:** "Generate a private key", then move it out of Downloads, outside the repository:

```bash
mkdir -p ~/.config/sdlc-secrets && chmod 700 ~/.config/sdlc-secrets
mv ~/Downloads/*.private-key.pem ~/.config/sdlc-secrets/github-app-dev.pem
chmod 600 ~/.config/sdlc-secrets/github-app-dev.pem
```

   Never paste the key into a chat, commit it, or send it by e-mail or chat tools.
6. **Install the App** on `harryforge` → **Only select repositories** → `pilot-order-inventory` only.
7. **Live test** (optional, never in CI). Create `~/.config/sdlc-secrets/github-test-app.json` (mode 600); it holds a **path** to the key, not the key:

```json
{
  "client_id": "Iv…",
  "private_key_file": "/Users/<you>/.config/sdlc-secrets/github-app-dev.pem",
  "repo": "harryforge/pilot-order-inventory",
  "issue": 1,
  "file_path": "README.md",
  "commit_sha": "<40-hex commit on main>"
}
```

```bash
nvm use 24   # the repository needs Node 24
SDLC_GITHUB_LIVE_TEST=1 SDLC_GITHUB_TEST_APP_FILE=~/.config/sdlc-secrets/github-test-app.json \
  pnpm exec vitest run --config vitest.integration.config.ts platform/tests/integration/github
```

   It issues a one-repository token, posts a comment on the issue, polls it back and reads a file.
8. **OpenBao:** the key goes into the development OpenBao in [Step 11b part 4](#step-11b-set-up-the-dev-stack-from-scratch-dev) (runbook T11 §5b.1, in the macOS Terminal, never through a chat tool). Nothing else to do here: Step 11b starts the worker and the other processes.
9. **Live test of the poller** (optional, never in CI; needs Docker for the throw-away database). The App posts `/approve G9` on the test issue; the poller must ignore it, because the App is a bot, and post no reply:

```bash
SDLC_GITHUB_LIVE_TEST=1 SDLC_GITHUB_TEST_APP_FILE=~/.config/sdlc-secrets/github-test-app.json \
  SDLC_TEST_DB_DIR=platform/tests/integration/github pnpm test:db
```

## Step 11b. Set up the dev stack from scratch (dev)

Use this on a new machine, or when the Docker volumes of the project `sdlc` are gone (`docker volume ls | grep '^sdlc_'` shows nothing). After a plain restart, use Step 13 instead. It follows `platform/deploy/README.md` "Fresh deployment (operator)", with the commands and checks of a development machine. It takes about 30 minutes; Step 11 (the GitHub App and its key file) comes first.

**Where to run what.**

- 🧑 **The owner, in the macOS Terminal app** (a separate window). These steps print key shares or tokens, or ask for them at a hidden prompt. Never run them in a chat tool, and never in the terminal pane of the Claude desktop app: Claude can read that pane, and a chat keeps everything it shows.
- 🤖 **Claude Code may run** the steps marked so: they read or print no secret.
- **Never run `docker volume prune` or `docker system prune --volumes`** on a machine with a dev stack: they delete OpenBao, PostgreSQL and SeaweedFS data, and you start again here. Remove volumes only with `pnpm compose:down` plus `-v`, on purpose.

### 1. Prepare (🤖)

| # | Do | Check |
|---|---|---|
| 1 | `pnpm install && pnpm build` on the latest `main` | No error |
| 2 | `pnpm compose:env` when `platform/deploy/.env` does not exist. When it exists, list the variables it lacks (names only, never values): `comm -13 <(grep -oE '^[A-Z_]+=' platform/deploy/.env \| sort) <(grep -oE '^[A-Z_]+=' platform/deploy/.env.example \| sort)` | Most listed variables have defaults. `SDLC_DOCKER_GID` must be set: `0` on Docker Desktop for macOS, the group of `/var/run/docker.sock` on Linux (runbook T11 §5g) |
| 3 | Build the platform images from the current code. `up.sh` never rebuilds an image that exists: `docker compose -f platform/deploy/docker-compose.yml --env-file platform/deploy/.env --profile core --profile platform --profile sandbox build sdlc-api sdlc-worker sdlc-runner` | `docker images` shows `sdlc-api`, `sdlc-worker`, `sdlc-runner` created just now |

### 2. OpenBao (🧑, Terminal app)

Have your password manager open: `init` prints three key shares and a root token **once**. On a development machine they are throw-away keys; you hold all three.

```bash
docker compose -f platform/deploy/docker-compose.yml --env-file platform/deploy/.env --profile core up -d --wait openbao postgres seaweedfs
pnpm openbao:bootstrap init
pnpm openbao:bootstrap unseal
pnpm openbao:bootstrap configure
pnpm openbao:bootstrap status
```

`unseal` asks for two shares, `configure` for the root token (hidden prompts). `configure` ends with `the root token is revoked`; `status` says `unsealed`.

### 3. Admin token (🧑, Terminal app)

`configure` revoked the root token, so make a new one from two shares first, then the admin token (runbook T11 §5.1):

```bash
pnpm openbao:bootstrap root-token
docker compose -f platform/deploy/docker-compose.yml --env-file platform/deploy/.env exec openbao \
  sh -c 'read -rs BAO_TOKEN && export BAO_TOKEN && bao token create -role=platform-admin -field=token'
```

The second command asks for the root token at a hidden prompt and prints the admin token. **It lives one hour** and cannot be renewed: do parts 4 and 5 in one go. When a command answers `permission denied` or `FAILED`, the token has probably expired: make a new one and run that command again.

### 4. Shared secrets (🧑, Terminal app, admin token)

Each block asks for the admin token at a hidden prompt and ends with `stored`, or `FAILED`. None prints a secret.

The GitHub App (Step 11; the key is read from its file, runbook T11 §5b.1):

```bash
KEY_FILE="$HOME/.config/sdlc-secrets/github-app-dev.pem"
CLIENT_ID=Iv23liQtMQBwNyVYZuJt
{ printf 'Admin token (hidden): ' >&2; read -rs t && echo >&2 && printf '%s\n%s\n' "$t" "$CLIENT_ID" && cat "$KEY_FILE"; } | \
  docker compose -f platform/deploy/docker-compose.yml --env-file platform/deploy/.env exec -T openbao \
  sh -c 'read -r BAO_TOKEN && read -r CLIENT_ID && export BAO_TOKEN && bao kv put -mount=kv shared/github-app client_id="$CLIENT_ID" private_key=- >/dev/null && echo stored || echo FAILED'
unset t
```

The LiteLLM master key and salt key, made at random inside the container, so nobody sees them (runbook T11 §5d). Never change the salt key later:

```bash
for entry in cost-controller/litellm-master-key:sk- litellm/salt-key:; do
  { printf 'Admin token (hidden): ' >&2; read -rs t && echo >&2 && printf '%s\n' "$t"; } | \
    docker compose -f platform/deploy/docker-compose.yml --env-file platform/deploy/.env exec -T openbao \
    sh -c 'read -r BAO_TOKEN && export BAO_TOKEN && bao kv put -mount=kv "${1%%:*}" value="${1#*:}$(head -c 24 /dev/urandom | od -An -tx1 | tr -d " \n")" >/dev/null && echo stored || echo FAILED' sh "$entry"
done
unset t
```

A model. On a development machine, the local Ollama model (`ollama pull gpt-oss:20b` first; QUESTIONS #78, #81):

```bash
docker compose -f platform/deploy/docker-compose.yml --env-file platform/deploy/.env exec openbao \
  sh -c 'printf "Admin token (hidden): "; read -rs BAO_TOKEN; echo; export BAO_TOKEN; bao kv put -mount=kv litellm/providers/ollama api_base=http://host.docker.internal:11434 >/dev/null && echo stored || echo FAILED'
```

An API model, when a key exists (for example Anthropic, with a spend limit at the provider; the key starts with `sk-ant-api03-`):

```bash
docker compose -f platform/deploy/docker-compose.yml --env-file platform/deploy/.env exec openbao \
  sh -c 'printf "Admin token (hidden): "; read -rs BAO_TOKEN; echo; export BAO_TOKEN; printf "Provider API key (hidden): "; read -rs VALUE; echo; printf %s "$VALUE" | bao kv put -mount=kv litellm/providers/anthropic api_key=- >/dev/null && echo stored || echo FAILED'
```

### 5. Credentials of every process (🧑, Terminal app, admin token)

The nine commands of `platform/deploy/README.md` "Fresh deployment", step 5: `litellm-credentials`, `api-credentials`, `worker-credentials`, `runner-credentials`, `runner-evidence-credentials`, `api-evidence-credentials`, `worker-evidence-credentials`, `worker-purge-credentials`, `worker-anchor-credentials`, each as `pnpm openbao:bootstrap <command>`. Each asks for the admin token and ends with a line that names what it stored. Skip `worker-langfuse-credentials` unless you run the profile `observability` (runbook T11 §5m).

### 6. Database and start (🤖)

```bash
SDLC_DB_MIGRATION_URL="postgres://platform:$(grep '^PLATFORM_DB_PASSWORD=' platform/deploy/.env | cut -d= -f2-)@127.0.0.1:5432/platform" pnpm db:migrate
platform/deploy/scripts/up.sh core models platform sandbox
```

The password goes from `.env` into the command without being printed. `up.sh` ends with `all services healthy`.

### 7. Check (🤖)

| Check | Command | Expected |
|---|---|---|
| The API | `curl -s http://127.0.0.1:8090/health/ready` | `{"status":"ok"}` |
| No missing credential | `docker compose -f platform/deploy/docker-compose.yml --env-file platform/deploy/.env --profile core --profile platform --profile sandbox logs sdlc-api sdlc-worker sdlc-runner \| grep -oE '"event":"[a-z_.]+_missing"' \| sort -u` | Nothing. A line such as `worker.evidence_missing` names the credentials command to run again (part 5), then restart that service |
| The models | `docker compose -f platform/deploy/docker-compose.yml --env-file platform/deploy/.env --profile core --profile models exec -T litellm sh -c 'grep -E "model_name:" /run/litellm/config.yaml \| sed -E "s/.*model_name:[[:space:]]*//"'` (names only) | Every model whose provider entry you stored. A missing one: the entry is not in OpenBao (part 4), or `litellm-agent` and `litellm` need a restart |

`worker.cost_sync_failed` with `unreachable` right after the start is normal: the worker started before LiteLLM was ready, and the next pass (5 minutes) syncs. Then continue with Step 12 item 2 (the database is migrated and the API is running).

## Step 12. Create the first admin and the pilot project (dev)

The development version of [deploy/README, Fresh deployment steps 8–9](deploy/README.md#8-the-tenant-and-its-first-admin), which explains the bootstrap, the token and the `sdlc ops …` commands; how people log in and use tokens: handbook [Ch.19 §19.8c](../handbook/02-playbook/ch19-approval-queues.md#198c-using-the-platform-the-sdlc-command). Run the commands below yourself, in a terminal: they print a token **once**. Never run them through a chat tool, and never paste the token anywhere except your password manager.

1. Step 11b is done: the API answers `curl -s http://127.0.0.1:8090/health/ready` and the database is migrated (Step 11b part 6).
2. Create your tenant, your user and your first token. `SDLC_DB_URL` is the `platform_app` URL (deploy/README step 8):
   ```bash
   pnpm sdlc ops bootstrap --tenant internal --tenant-name "Internal" --email you@example.com --name "Your Name"
   ```
3. Check the token: `curl -s -H "Authorization: Bearer <token>" http://127.0.0.1:8090/v1/me`.
4. Log in with the CLI (task B04, [ADR-M36](../design/ADR-M36-cli-api-client.md)) and paste the token at the hidden prompt. The login is saved in `~/.config/sdlc/credentials.json`, readable only by you:
   ```bash
   pnpm sdlc login --api-url http://127.0.0.1:8090
   pnpm sdlc whoami
   ```
   Then every `pnpm sdlc …` command works through the API (handbook Ch.19 §19.8c).

5. Set up a project and its team through the API. The rules (nobody gives a role to themselves; [roles that conflict](../handbook/02-playbook/ch19-approval-queues.md#conflicting-roles)) and every command: handbook [Ch.19 §19.8d](../handbook/02-playbook/ch19-approval-queues.md#198d-using-the-platform-setting-up-a-team-admins). On a development machine:
   ```bash
   pnpm sdlc admin project create --slug pilot --name "Pilot" --repo harryforge/pilot-order-inventory
   pnpm sdlc admin user create --email colleague@example.com --name "Colleague"
   pnpm sdlc admin identity link --user colleague@example.com --github-id <numeric ID> --github-login <login>
   pnpm sdlc admin role grant --project pilot --user colleague@example.com --role person_b
   pnpm sdlc admin config show --project pilot
   ```
   The numeric GitHub ID comes from `gh api users/<login> --jq .id`. A role for yourself comes from a second tenant admin, or from the operator on the server (`pnpm sdlc ops role grant --tenant internal --project pilot --email you@example.com --role person_a`, with `SDLC_DB_URL`).
6. Replace the bootstrap token with your own: `pnpm sdlc token create --name laptop-you`, log in again with it (`pnpm sdlc login`), then revoke the bootstrap token (`pnpm sdlc token list`, `pnpm sdlc token revoke --id <ID>`).

## Step 13. Restart the dev stack after a break (dev)

Use this after a reboot, after Docker Desktop restarted, or when `sdlc-api` and `sdlc-worker` keep restarting with "OpenBao at … is sealed". It assumes Steps 11, 11b and 12 were done once on this machine; when the `sdlc_*` Docker volumes are gone, use Step 11b instead. Run every command **yourself, in the macOS Terminal app**, from the repo root: some ask for key shares or tokens at a hidden prompt, and these never go through a chat tool or the terminal pane of the Claude desktop app.

| # | Do | Check |
|---|---|---|
| 1 | Start the infrastructure: `platform/deploy/scripts/up.sh core` | The script ends without an error (it waits until the services are healthy) |
| 2 | `pnpm openbao:bootstrap status` | Says `sealed` after every restart (runbook T11 §4) |
| 3 | `pnpm openbao:bootstrap unseal`: type key shares at the hidden prompt until it is unsealed (on a dev machine you hold all the throw-away shares) | `status` says `unsealed` |
| 4 | Apply new migrations, if `main` has new ones: `SDLC_DB_MIGRATION_URL="postgres://platform:<PLATFORM_DB_PASSWORD>@127.0.0.1:5432/platform" pnpm db:migrate` (the password is in `platform/deploy/.env`) | `pnpm db:status` (same variable) lists no pending migration |
| 5 | When `main` has new code since the last start, rebuild the platform images and add new `.env` variables first (Step 11b part 1, items 2–3). Then start the rest: `platform/deploy/scripts/up.sh core models platform sandbox` (add `observability` for Langfuse) | The script ends without an error; Step 11b part 7 shows no missing credential |
| 6 | `curl -s http://127.0.0.1:8090/health/ready` | Ready |
| 7 | `pnpm sdlc whoami` (if the login was removed: `pnpm sdlc login --api-url http://127.0.0.1:8090`) | Shows your user |

Start `core` alone first: `sdlc-api`, `sdlc-worker`, `sdlc-runner` and `litellm-agent` cannot become healthy while OpenBao is sealed, so `up.sh` with those profiles would wait until it times out.

**After the A10 update (TLS on OpenBao, 2026-10):** an `.env` made before it has no `SDLC_OPENBAO_TLS_DIR`, and `up.sh` stops with `set SDLC_OPENBAO_TLS_DIR in .env`. Run once, in a terminal: `pnpm openbao:tls dev` (a throw-away CA and certificate in `platform/deploy/openbao-tls/`, the variable added to `.env`), then rebuild the platform images and follow the table from item 1. OpenBao's data and its key shares stay the same; no credentials command is needed (runbook T11 §3c).

**The credentials commands are NOT needed after a plain restart.** The AppRole secret IDs stay in the services' volumes and live 90 days (`APPROLE_SECRET_ID_TTL`); the processes log in again by themselves. Run a credentials command only in these cases (each one asks for an admin token, runbook T11 §5.1, and prints no secret):

| When | Do (then restart that service) |
|---|---|
| First set-up, or a secret ID is older than 90 days | Every credentials command: the full list is [deploy/README, Fresh deployment step 5](deploy/README.md#5-credentials-of-every-process) (one runbook T11 section each) |
| A service log says "AppRole login failed", or names a missing credential (`…_missing`, Step 11b part 7) | That service's credentials command |
| An update on `main` adds a credentials command or new rights to one (the CHANGELOG says so; for example C08: the runner reads stored diffs, E02: the API's evidence identity) | That command, once |
| A key may have leaked | That command again: it rotates the secret ID (runbook T11 §8.2) |

**After an image update on `main`** (for example issue #177: OpenBao 2.7.1, ClickHouse 26.3.39.7, Langfuse 4.50.0), on an existing dev stack:

1. Pull the new images: `docker compose -f platform/deploy/docker-compose.yml --env-file platform/deploy/.env --profile core --profile models --profile platform --profile sandbox --profile observability pull`.
2. Follow the table above from item 1. The new OpenBao container starts sealed: unseal it as usual (items 2–3), then check `pnpm openbao:bootstrap status` says `unsealed`. OpenBao needs no data migration; ClickHouse and Langfuse migrate their own data at start-up.
3. Your `sdlc_*` volumes keep their owner. OpenBao 2.7 no longer declares `VOLUME` in its image, which matters only for new volumes (covered by the live tests).
4. Since OpenBao 2.7.1 an AppRole secret ID stops working exactly at its expiry (90 days, `APPROLE_SECRET_ID_TTL`); before, it could keep working until a tidy ran. A process that cannot log in to OpenBao after that time ("AppRole login failed" in its log) needs its `pnpm openbao:bootstrap *-credentials` command again (table above, then restart that service).
5. Never run `docker volume prune` or `docker system prune --volumes`.

Restart one service: `docker compose -f platform/deploy/docker-compose.yml --env-file platform/deploy/.env --profile core --profile models --profile platform --profile sandbox restart <service>`.

To stop everything and keep the data: `pnpm compose:down`. If you do not need the platform for a while, stop it this way: a sealed OpenBao makes `sdlc-api` and `sdlc-worker` restart every minute.

## Step 14. Prepare the pilot repo for live tests (dev)

Live tests run the platform against the real `harryforge/pilot-order-inventory` with the test GitHub App. They never run in CI. Do these once, in this order (the same order as deploy/README Fresh deployment steps 9–13: the configuration needs the image and the agent); each line says where the details are.

| # | What | How | Check |
|---|---|---|---|
| 1 | Test App permissions | App settings (Step 11) as listed in [deploy/README](deploy/README.md#github-app-permissions). Then accept the new permissions on the installation (organization settings → GitHub Apps → Configure) | `gh api /orgs/harryforge/installations --jq '.installations[]\|select(.app_slug=="harryforge-sdlc-dev")\|.permissions'` |
| 2 | The pilot project, its team and AI record | Step 12 item 5; `pnpm sdlc ai-record set …` (handbook Ch.19 §19.8b). Person A and Person B are two different people with two GitHub accounts | `pnpm sdlc admin config show --project pilot`, `pnpm sdlc ai-record show --project pilot` |
| 3 | The sandbox image | `pnpm sandbox-image:build node24` prints the reference by digest; on Docker Desktop use `platform/sandbox-images/build.sh node24 --no-push` (runbook T11 §5g). Put it in `sandbox.image` | The reference ends in `@sha256:…` |
| 4 | A registered, active agent | `pnpm sdlc admin agent register …`, then the approvals (handbook Ch.20 §20.5b). Its `instructions_ref` points at the pilot's `AGENTS.md` | `pnpm sdlc admin agent show --key <key>` says `active` |
| 5 | The project configuration | `pnpm sdlc admin config show --project pilot` gives the version; write the settings that differ from the defaults into a YAML file outside the repo, then `pnpm sdlc admin config set --project pilot --file <file> --expected-version <version>` (handbook Ch.19 §19.8d). For the pilot: `verification.required_checks: [ci-ok]` (G6 waits only for the pilot's `ci-ok`, handbook Ch.14), `sandbox.image` (item 3) and `run.agent_key` (item 4) | `config show` prints the new version and values |
| 6 | A model | A provider key in OpenBao (runbook T11 §5d), or on a dev machine the local Ollama model `gpt-oss:20b` (QUESTIONS #78). One real run with an API model is needed before M-F (QUESTIONS #81; the trial M-E runs with the local model) (QUESTIONS #81): `pnpm test:agent-api` (runbook T11 §5d, "The real API-model run") | `curl -s -H "Authorization: Bearer <master key>" http://127.0.0.1:4000/v1/models` lists it (run in the terminal; never paste the key) |
| 7 | The plan file of the C09 / E07 live test (QUESTIONS #230) | Once a year: open a pull request on the pilot that adds `.sdlc/plans/INT-<UTC year>-0001.yaml` with the content of `platform/tests/integration/pilot/fixtures/live-plan.yaml` (change the year in `intent_id` too), let `ci-ok` pass and merge it yourself. The App and the platform never merge. The plan allows `docs/live-test/**` only: a live run never changes the application code. A file merged before E07 (`allowed_paths: [apps/web/src/features/products/**]`, `[stub:append]`) must be replaced by the new content | `gh api repos/harryforge/pilot-order-inventory/contents/.sdlc/plans/INT-2026-0001.yaml --jq .path` |
| 8 | Person B's GitHub account (E07 live G8 only) | A second person with their own GitHub account and write access to the pilot (they review and merge). Add to the settings file of the test App (Step 11 item 7): `"person_b_github_id": <numeric ID>` (`gh api users/<login> --jq .id`) and `"person_b_login": "<login>"` | `gh api repos/harryforge/pilot-order-inventory/collaborators/<login>/permission --jq .permission` says `write` or more |

The live tests (each needs the test App's private key file, kept outside the repo):

```bash
SDLC_GITHUB_LIVE_TEST=1 SDLC_GITHUB_TEST_APP_FILE=<file outside the repo> pnpm exec vitest run --config vitest.integration.config.ts platform/tests/integration/github
SDLC_SANDBOX_LIVE_TEST=1 SDLC_GITHUB_TEST_APP_FILE=<file outside the repo> pnpm test:sandbox-live
pnpm test:agent-real
SDLC_PILOT_LIVE_TEST=1 SDLC_GITHUB_TEST_APP_FILE=<file outside the repo> pnpm test:pilot-live
SDLC_PILOT_LIVE_TEST=1 SDLC_PILOT_LIVE_G8=1 SDLC_GITHUB_TEST_APP_FILE=<file outside the repo> pnpm test:pilot-live
```

The first includes the publish test (C08: push and pull request on the pilot); the second clones the pilot into a real sandbox; the third runs the agent with the local Ollama model (CLAUDE.md, "OpenHands adapter"). The fourth (C09) runs T01 from G1 to G7 on the pilot in this process: a throw-away database, the Temporal test server, a real node24 sandbox with the stub model (no model key; needs Docker and item 7, not the dev stack of Step 13), a real push, a real pull request and the pilot's real `ci-ok`; then it checks that `main` refuses a push (N6), closes the pull request and deletes the branch. It takes 15–30 minutes (the pilot's CI). Optional: `SDLC_SANDBOX_IMAGE` (skips the image build), `SDLC_PILOT_LIVE_CI_TIMEOUT_MINUTES` (default 30).

The fifth (E07, D-08 E07 AC1) is the same run taken on to G8; it needs items 7 and 8. After N6 it does **not** close the pull request. It prints the pull request's link and waits (`SDLC_PILOT_LIVE_MERGE_TIMEOUT_MINUTES`, default 60) for a person:

1. Person B opens the pull request on GitHub with their own account, reviews it and approves it.
2. Person B merges it (merge commit or squash). Only Person B: the platform counts a merge by a producer, a bot or an account it does not know as a merge before approval (security escalation). The App and the platform never merge.
3. The test sees the merge on its next poll. The worker builds the release pack, Person B's user approves G8 through the CLI, the pack is sealed, the intent ends `done`, and `sdlc audit verify` passes. The test prints `e07-live: INT-… done`.

The merged change is one fixed, fictional line appended to `docs/live-test/RUNS.md` on the pilot's `main`. Each live G8 run adds one more line there; nothing under `apps/` changes, so the pilot stays clean for the T01–T10 trials. Do not revert it.

## Sending handbook comments

Any format works. To make changes fast, one line per comment is ideal:

| Chapter / section | Comment | Type |
|---|---|---|
| Ch.13 §13.5 Step 3 | "Loop threshold 3 is too strict for test runs; use 5" | change |
| T1 §12 | "Also add a column for the client's document number" | add |
| 0.2 Glossary | "承認者 is fine; for Person A the client says 担当者" | wording |

Types: **change** (a rule is different), **add**, **remove**, **wording** (meaning unchanged), **question**.

What happens next:
1. Claude updates the handbook chapter(s) and lists the effects on design and code.
2. You approve the chapter change.
3. If the platform is affected: update the design document first, add a change task to the backlog, then change the code (CLAUDE.md; [Step 10](#step-10-when-the-handbook-changes) of the history).

Still awaiting comments: Ch.13–20, Part 0 (0.2 glossary, 0.3, 0.4), templates T1, T3–T18.

---

## Maintaining the backlog

D-08 and its CSV are generated from `scripts/generate-backlog.py`. Edit the data in the script, then run:

```bash
python3 scripts/generate-backlog.py
```

---

## History: the first set-up (2026-09)

Steps 0–10 record how the repository was first set up, from a zip file to the first task, on 2026-09-24. They are kept for reference and are not needed to work on the platform today: the repository, its settings ([CONTRIBUTING.md §2](../CONTRIBUTING.md#2-the-repository)) and its issues exist. Done by the repo owner (Harry); about half a day for steps 1–6.

| State on 2026-09-24 | |
|---|---|
| Design | Version 1.0 approved, tag `design-v1.0` |
| Handbook | Version 1.0, **not yet approved as a whole** |
| Coding | Whole backlog now, starting with A01; rework accepted after the handbook is approved |

### Step 0. Prepare before you start

| What | Needed for | Who |
|---|---|---|
| GitHub organisation account with rights to create repositories | Step 1 | Harry |
| GitHub CLI installed and logged in (`gh auth login`) | Step 3 | Harry |
| Claude Code access through the company plan (not a personal account — handbook Ch.2 Rule 1) | Step 4 | Leadership / tool owner |
| Developer machine: Git, Node.js LTS, pnpm; Docker from A02; OpenSSL 3.x first in `PATH` from A04 (on macOS not the built-in LibreSSL, see `platform/deploy/README.md`) | A01, A02, A04 | Developer |
| **Three people to hold the OpenBao key shares** | **Before A03** | Leadership |
| Infrastructure operator for the internal server | Before A10 | Leadership |
| Person B for reviewing platform PRs | Every task | Leadership |

Building the platform is **internal work** with no client data, so Claude Code may be used here (handbook Ch.2 Rule 9). The usual rules still apply: own branch, pull request, human review, AI disclosure.

---

### Step 1. Create the repo on GitHub and push

1. Create a repository `agentic-sdlc-framework` (it was private until 2026-10-08, public since). Do not add a README, licence or `.gitignore` (the repo already has them).
   - Where the repository is today, and the risks of a personal account: [CONTRIBUTING.md §2](../CONTRIBUTING.md#2-the-repository).
2. Unzip, copy the folder where you want it, and push **one initial commit** (the repository history starts here):

```bash
cd agentic-sdlc-framework
git config --global user.name  "<your name>"      # once per machine; commits fail without it
git config --global user.email "<your email>"
git init
git add .
git commit -m "Initial commit: handbook v1.0 (in review), design v1.0 (approved)"
git branch -M main
git remote add origin git@github.com:hoanghainh1188/agentic-sdlc-framework.git
git push -u origin main

# mark the approved design on this first commit
git tag -a design-v1.0 -m "Design version 1.0 approved by Harry (2026-09-24)"
git push origin design-v1.0
```

Check on GitHub:
- [ ] Branch `main` with one commit
- [ ] Tag `design-v1.0`
- [ ] `handbook/`, `design/`, `platform/`, `scripts/`, `CLAUDE.md`, `.github/` are present (`.github/` is a hidden folder: make sure it was copied)

### Step 2. Configure the repo

Do this **after** the first push, so protection does not block it. The settings in force today (branch protection, the required check `ci-ok`, merging, CI, scan exceptions): [CONTRIBUTING.md §2](../CONTRIBUTING.md#2-the-repository).

### Step 3. Create milestones, labels and the 49 issues

```bash
# Dry run: shows what would be created, creates nothing
python3 scripts/create-issues.py --repo hoanghainh1188/agentic-sdlc-framework --dry-run

# Create: 5 milestones (M-A, M-B, M-0, M-C, M-D), labels, 49 issues
python3 scripts/create-issues.py --repo hoanghainh1188/agentic-sdlc-framework
```

- Safe to run again: issues that already exist (same `[ID] ` title prefix) are skipped.
- After D-08 changes (`scripts/generate-backlog.py`), run it with `--update` (first with `--dry-run`): it brings the **open** issues in line with the CSV (title, body, size label). Closed issues are never changed.
- `--only A01,A02` creates only some tasks.
- Tasks `R01–R04` are labelled `repo:pilot`: tracked here, code in the separate repo `pilot-order-inventory`.

Check: 49 issues, each with its milestone, size label and acceptance criteria.

#### Tasks most affected by handbook changes

The script labels 12 tasks `handbook-dependent`: B01, B07, B11, B12, C06, C07, C10, C11, E01, E02, E03, E05. They implement rules from handbook chapters still awaiting comments, so they are the most likely to need rework. The list is in `scripts/create-issues.py` (`HANDBOOK_DEPENDENT`).

### Step 4. Prepare Claude Code

1. Install Claude Code following the official guide: https://docs.claude.com/en/docs/claude-code/overview
2. Open a terminal at the **repo root** and start Claude Code. It reads `CLAUDE.md` at the start of every session.
3. Keep the permission prompts on. Do not use any mode that skips permission checks.
4. First session only — ask a check question before giving work:

```text
Read CLAUDE.md and README.md. Summarise in 10 bullets: the current status, the rules you must follow,
the order of work, and what you must do when a document is missing or contradictory. Do not write code.
```

If the summary misses "code the whole backlog, rework accepted", "handbook rules go in config", or "open questions go to `design/QUESTIONS.md`", correct it before continuing.

### Step 5. Run task A01

Paste into Claude Code:

```text
Task: A01 — Initialise the TypeScript monorepo
Issue: #<A01 issue number>

Read: CLAUDE.md, design/D-08-mvp-backlog.md (task A01), design/D-03-mvp-architecture.md section 11.

Step 1 — Plan (do NOT code yet):
- List the files and folders to create.
- Proposed tools: workspace management, lint, format, test, and how to enforce module boundaries
  (packages/core must not import packages/adapters/*). Explain each choice and its licence.
- How each acceptance criterion (AC1–AC3) will be tested.
- Risks or unclear points.
Stop and wait for my approval.

Step 2 — After approval: create branch task/A01-monorepo-init, write code and tests for AC1–AC3.
Step 3 — Run lint, build and tests. Fill in the "Commands" section of CLAUDE.md.
         Summarise the results and open a PR with the template; put "A01" in the title.

If a document is missing or contradictory: add the question to design/QUESTIONS.md and stop.
```

### Step 6. Review the plan and the PR

**Plan (step 1):**
- [ ] Structure matches `platform/apps/{api,worker,runner,cli}` and `platform/packages/{core,contracts,adapters/*,config}`
- [ ] Tools are reasonable; licences allow commercial use
- [ ] An **automatic** check stops `core` importing `adapters` (AC3)

**Pull request:**
- [ ] AI disclosure in the PR template is complete
- [ ] CI passes
- [ ] Locally: `pnpm install && pnpm build && pnpm lint && pnpm test`
- [ ] Add a bad import in `core` on purpose → lint must fail
- [ ] `Commands` section of `CLAUDE.md` filled in
- [ ] Reviewer is not the person who ran Claude Code for this task (2+N)

Then squash-merge and close the issue (see step 8).

### Step 7. The standard loop for every task

```text
pick the next task (step 9 order) → paste the task prompt → review the plan → approve
→ Claude Code codes on task/<ID>-<short-name> → PR → review (checklist handbook T3) → merge → close issue
```

Task prompt template (change the ID, title and sections):

```text
Task: <ID> — <title>
Issue: #<number>
Read: CLAUDE.md, design/D-08-mvp-backlog.md (task <ID>), <design sections listed in the task>.
Step 1 — Plan only; include how each acceptance criterion is tested; list rules that come from the
handbook and confirm they are read from config, not hard-coded. Stop for approval.
Step 2 — Code and tests on branch task/<ID>-<short-name>.
Step 3 — Run lint, build, tests; open a PR with "<ID>" in the title.
If a document is missing or contradictory: add the question to design/QUESTIONS.md and stop.
```

Rules for every task:
- **One task per session.** Start a new session for the next task.
- Tasks sized **L** are split into 2–3 sessions (the task note says how).
- Check `design/QUESTIONS.md` after each session; answer or escalate open questions.
- For `handbook-dependent` tasks, check in review that rules sit in config (oversight matrix, roles, SLAs, thresholds).

### Step 8. After each task

Write on the issue when closing it:
- actual time spent (to recalibrate sizes);
- how many times the plan or PR had to change;
- questions raised (already in `design/QUESTIONS.md`).

This is the framework's first real data: AI used to build the platform itself.

### Step 9. Suggested order after A01

Follow the dependencies in D-08. A practical order:

| # | Tasks | Note |
|---|---|---|
| 1 | A02 Docker Compose → C01 OpenHands PoC | Reduce the biggest technical risk early |
| 2 | A03 OpenBao → A04 secrets client | **Key holders must be named first** |
| 3 | A05 config, A06 database, A07 audit | Base for everything else |
| 4 | A08, A09, A10 | A10 needs the infrastructure operator |
| 5 | M-B: B01 → B02 → … → B11 escalation, B12 AI record → B10 tests | Mostly `handbook-dependent` |
| 6 | M-0: R01–R04 (sample repo) | Right before M-C |
| 7 | M-C: C02 → … → C10 agent register, C11 kill switch → C09 tests | |
| 8 | M-D: E01 → E07 | E07 = MVP definition of done |

### Step 10. When the handbook changes

Coding continues while the handbook is reviewed. When a handbook change is **approved** and affects the platform:

```text
handbook updated (approved) → design doc updated → change task added in scripts/generate-backlog.py
→ python3 scripts/generate-backlog.py → create the new issue (--only <ID>) → Claude Code implements it
```

- Never change code to follow an **unapproved** handbook draft.
- Label the change issues `handbook-dependent` too.

---
