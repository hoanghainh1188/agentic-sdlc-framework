# T11 Runbook: operating OpenBao (unseal, root token, backup, restore)

> Status: **v0.6: tested on a development machine with throw-away keys (tasks A03, 2026-09-25, and C03, 2026-09-26): sections 3.1, 4, 5, 5b, 5d and 8.1.** Sections 6, 7 and 8.2 (rekey) give the commands; the recovery drill in task A10 tests them.
> Readers: key holders, infrastructure operator, platform admin.
> The real initialisation on the internal server **has not been done**. It waits until leadership names the three key holders.

---

## 1. Purpose and scope

OpenBao is the platform's secret manager. It stores the platform secrets (GitHub App key, LiteLLM master key, model provider keys, database passwords) and signs Run Contracts with a key that never leaves it.

All OpenBao data is encrypted. After every restart OpenBao is **sealed**: it cannot answer any request until key holders **unseal** it with their key shares. If the key shares are lost, every secret is lost.

This runbook covers:
- the first initialisation;
- unsealing after a restart;
- root tokens;
- daily admin work and AppRole secret IDs;
- the keys of LiteLLM (model provider keys, master key, salt key);
- snapshot backup and restore;
- changing a key holder;
- troubleshooting;
- the operations log.

It does **not** cover the platform processes that read secrets (task A04) or TLS (open item, `design/QUESTIONS.md` #20).

All commands run from the repo root on the server. They need Docker only. `pnpm openbao:bootstrap <command>` is the same as `platform/deploy/openbao/bootstrap.sh <command>`.

**OpenBao publishes no port on the host** (task A11, `design/QUESTIONS.md` #27). It is reachable only on the Compose network. Every admin and key-holder step therefore runs **inside the OpenBao container**: through `pnpm openbao:bootstrap …`, or through `docker compose -f platform/deploy/docker-compose.yml --env-file platform/deploy/.env exec openbao …` as shown below. Do not publish the port to make admin work easier: a static test fails when a compose file publishes port 8200 or 8210.

## 2. Roles

| Role | Who | Holds | Does |
|---|---|---|---|
| Key holder 1 | A leadership representative (named by leadership) | Share 1 | Unseals, creates root tokens, rekeys |
| Key holder 2 | Tech lead / platform owner (named by leadership) | Share 2 | Same |
| Key holder 3 | Infrastructure operator (named by leadership) | Share 3 | Same |
| Infrastructure operator | IT / DevOps | Access to Docker on the server | Starts and stops the stack, runs backups, keeps the operations log |
| Platform admin | Named by the tech lead | Short-lived `platform-admin` tokens | Stores secrets, delivers AppRole credentials |

Rules:
- **3 shares, any 2 unseal.** Nobody holds two shares. If one person holds two roles above, leadership names someone else for one share.
- Every share is stored twice: in the holder's personal password manager, and on paper in a sealed, signed and dated envelope in the company safe. The safe has a log of who opened it and when.
- **Never** put a share or a root token on the OpenBao server, in the repo, in chat, in email, in an issue or in a screenshot.
- Access to Docker on the server = access to OpenBao's key-holder listener and to every container. Give it only to operators.

## 3. Initialisation (once)

### 3.1. On a development machine (throw-away keys)

Use this to learn the procedure and to test changes. The keys are worthless: delete the data afterwards.

```bash
pnpm compose:env               # once
pnpm compose:core
pnpm openbao:bootstrap init    # prints 3 shares and a root token ONCE
pnpm openbao:bootstrap unseal  # enter 2 of the shares (hidden input)
pnpm openbao:bootstrap configure   # enter the root token; it is revoked at the end
```

To start again from zero: `docker compose -f platform/deploy/docker-compose.yml --env-file platform/deploy/.env --profile core down -v` (this deletes **all** data of the stack).

### 3.2. On the internal server (real keys): described, not yet done

Preconditions:
- leadership has named the three key holders (section 2);
- three envelopes, a pen, and access to the safe are ready;
- a room with no cameras, and screens that nobody else can see;
- the operations log (section 10) is open.

Steps:
1. The operator starts the stack: `pnpm compose:core`. `pnpm openbao:bootstrap status` must say `uninitialised`.
2. All three key holders are present. The operator runs `pnpm openbao:bootstrap init` in a terminal on the server. The script refuses to run if its output is redirected or piped.
3. Each key holder copies **only their own share** into their password manager, and writes it on paper for their envelope. The operator does not copy any share.
4. The operator notes the **initial root token** only long enough for step 6. It is not stored anywhere.
5. Two key holders unseal: `pnpm openbao:bootstrap unseal`. Each types their own share at the hidden prompt.
6. The operator runs `pnpm openbao:bootstrap configure` and types the root token. At the end the script prints `the root token is revoked`. Check it.
7. Clear the terminal and close it (`clear`, then close the window). Check that no scroll-back or session recording kept the output.
8. Each key holder seals their envelope, signs it across the seal, dates it, and puts it in the safe. Record it in the safe log.
9. Record the initialisation in the operations log: date, time, people present, "root token revoked: yes".

What `configure` sets up (details: `design/ADR-M19-openbao-bootstrap.md`):
- KV version 2 at `kv/`;
- Transit at `transit/`, with the Ed25519 key `run-contract` (not exportable, not deletable);
- AppRoles `api`, `worker`, `runner`, `cost-controller`, each reading only `kv/<its name>/…` (plus `kv/shared/github-app` for `api` and `worker`; the `runner` receives each run's GitHub token from the worker as a single-use wrapped token, `design/ADR-M25-runner-sandbox.md` §2.11);
- the AppRole `litellm` for the LiteLLM sidecar: it reads the model provider keys, the LiteLLM salt key and the LiteLLM master key, nothing else (section 5d);
- the token role `platform-admin` (tokens of at most 1 hour);
- a check that the file audit device is on.

Settings (key shares, threshold, token and secret ID lifetimes) are in `platform/deploy/openbao/bootstrap/bootstrap.conf`. Access rules are in `platform/deploy/openbao/bootstrap/policies/*.hcl`. Changes to either go through a reviewed pull request, then `configure` again.

## 4. Unseal after a server restart

1. The operator announces the restart in the internal channel.
2. After the restart, `pnpm openbao:bootstrap status` says `sealed`. The platform processes cannot read secrets until OpenBao is unsealed.
3. Two key holders run `pnpm openbao:bootstrap unseal` in turn, or one after the other in the same session. Each types their share at the hidden prompt. Remote access is allowed only over a secure connection (company VPN + SSH), never by sending the share to someone else.
4. `status` says `unsealed`. Check that the platform processes reconnect.
5. Record it in the operations log.

A wrong share is refused and OpenBao stays sealed. To reset a half-finished unseal, restart the `openbao` container.

## 5. Root token: create only when needed, revoke immediately

Daily work never uses a root token. A root token is needed only to:
- run `configure` again (new policies, new AppRoles, changed settings);
- create `platform-admin` tokens;
- rekey (section 8.2).

Steps:
1. Record the reason in the operations log **before** you start.
2. Two key holders run `pnpm openbao:bootstrap root-token`. Each types their share at the hidden prompt. The script prints the new root token once.
3. Use it at once. For example: `pnpm openbao:bootstrap configure` (this revokes the token at the end), or create an admin token (section 5.1) and then revoke the root token.
4. Revoke it if it is still valid:
   ```bash
   docker compose -f platform/deploy/docker-compose.yml --env-file platform/deploy/.env exec openbao \
     sh -c 'read -rs BAO_TOKEN && export BAO_TOKEN && bao token revoke -self'
   ```
   Type the token (hidden) and press Enter.
5. Record the end time and "revoked: yes" in the operations log.

`root-token` works only through the key-holder listener `127.0.0.1:8210`, which is reachable only from inside the OpenBao container.

### 5.1. Admin token for daily work

With a root token (section 5). An admin token cannot create another admin token, so the 1-hour limit holds:

```bash
docker compose -f platform/deploy/docker-compose.yml --env-file platform/deploy/.env exec openbao \
  sh -c 'read -rs BAO_TOKEN && export BAO_TOKEN && bao token create -role=platform-admin -field=token'
```

- The token lives **at most 1 hour** and cannot be renewed.
- It can store and update secrets under `kv/`, read AppRole role IDs, issue and revoke secret IDs, and read the public Run Contract key.
- It cannot change policies, mounts, the audit device or the Transit key, and cannot delete secrets.
- Admin work is rare in the MVP (storing secrets once, rotating secret IDs every 3 months). Each admin session therefore needs two key holders for the root token. A personal admin login (for example user and password, or company single sign-on) is an open item (`design/ADR-M19-openbao-bootstrap.md` section 3).

## 5b. Secrets and AppRole secret IDs

### Storing a secret

With an admin token (hidden input, the value is read from stdin):

```bash
docker compose -f platform/deploy/docker-compose.yml --env-file platform/deploy/.env exec openbao \
  sh -c 'read -rs BAO_TOKEN && export BAO_TOKEN && read -rs VALUE && printf %s "$VALUE" | bao kv put -mount=kv cost-controller/litellm-master-key value=-'
```

| Secret | Path | Read by |
|---|---|---|
| GitHub App private key | `kv/shared/github-app` | `api`, `worker` (not `runner`, `design/QUESTIONS.md` #44) |
| LiteLLM master key (field `value`) | `kv/cost-controller/litellm-master-key` | `cost-controller`, `litellm` (one source for both, section 5d) |
| LiteLLM salt key (field `value`) | `kv/litellm/salt-key` | `litellm` |
| Model provider keys (field `api_key`), one entry per provider | `kv/litellm/providers/<provider>`, for example `kv/litellm/providers/anthropic` | `litellm` |
| `platform_app` database password of the API (field `password`) | `kv/api/database` | `api` (section 5e) |
| `platform_app` database password of the worker (field `password`) | `kv/worker/database` | `worker` (section 5f) |
| Database and SeaweedFS passwords of a process | `kv/<process>/…` | That process |

The GitHub App key is read by `api`, by the `worker` (it polls GitHub, posts gate comments and reads spec files; `design/QUESTIONS.md` #42) and by the runner to create short-lived tokens. It must **never** enter an agent sandbox (task C04; `design/QUESTIONS.md` #44 may remove the runner's access).

### The GitHub App (task B05)

Create one GitHub App per installation of the platform (`design/ADR-M23-github-adapter.md` section 2.2):

- Repository permissions: Metadata read, Issues read and write, Pull requests read, Checks read, Commit statuses read, Contents read. Later tasks add Contents write (C04) and Pull requests write (C08).
- No organisation or account permissions. Webhook: off (the platform polls). Install it on **selected** repositories only.
- Generate a private key. Store it with the App's client ID in `kv/shared/github-app` (fields `client_id` and `private_key`), then delete the downloaded `.pem` file. The admin token is typed at the hidden prompt; the key goes through stdin, never through a command-line argument:

```bash
{ read -rs t && printf '%s\n%s\n' "$t" "<client ID>" && cat /path/to/app.private-key.pem; } | \
  docker compose -f platform/deploy/docker-compose.yml --env-file platform/deploy/.env exec -T openbao \
  sh -c 'read -r BAO_TOKEN && read -r CLIENT_ID && export BAO_TOKEN && bao kv put -mount=kv shared/github-app client_id="$CLIENT_ID" private_key=-'
```

- Key rotation: generate a new key in GitHub, store it the same way, wait 10 minutes (the platform reads the key again after that), then delete the old key in GitHub.

### 5b.1. Development: the test GitHub App in the development OpenBao (task B06)

On a development machine, the worker (GitHub poller) reads the key of the **test** App `harryforge-sdlc-dev` (Client ID `Iv23liQtMQBwNyVYZuJt`, `platform/GETTING-STARTED.md` Step 11) from the development OpenBao, at `kv/shared/github-app`. Only throw-away OpenBao keys are used there. The production App gets its own key in the real OpenBao later.

- **The repository owner runs these commands in the macOS Terminal**, from the repository root. Never run them through a chat tool, and never paste the key or the token into a chat.
- The key is read from its file (`~/.config/sdlc-secrets/github-app-dev.pem`, mode 600, outside the repository) and goes to OpenBao on stdin. It is never typed, pasted, passed as an argument, written to the repository or a log, or kept in shell history.
- The admin token (section 5.1) is typed at a hidden prompt.

Before: OpenBao is running (`pnpm compose:core`), unsealed and configured (sections 3.1 and 4).

1. Store the Client ID and the key:
   ```bash
   KEY_FILE="$HOME/.config/sdlc-secrets/github-app-dev.pem"
   CLIENT_ID=Iv23liQtMQBwNyVYZuJt
   { printf 'Admin token (hidden): ' >&2; read -rs t && echo >&2 && printf '%s\n%s\n' "$t" "$CLIENT_ID" && cat "$KEY_FILE"; } | \
     docker compose -f platform/deploy/docker-compose.yml --env-file platform/deploy/.env exec -T openbao \
     sh -c 'read -r BAO_TOKEN && read -r CLIENT_ID && export BAO_TOKEN && bao kv put -mount=kv shared/github-app client_id="$CLIENT_ID" private_key=- >/dev/null && echo stored'
   unset t
   ```
   The answer is `stored`.
2. Check. This prints the Client ID only, never the key:
   ```bash
   { printf 'Admin token (hidden): ' >&2; read -rs t && echo >&2 && printf '%s\n' "$t"; } | \
     docker compose -f platform/deploy/docker-compose.yml --env-file platform/deploy/.env exec -T openbao \
     sh -c 'read -r BAO_TOKEN && export BAO_TOKEN && bao kv get -mount=kv -field=client_id shared/github-app'
   unset t
   ```
3. Keep the `.pem` file where it is: the optional live tests read it (`platform/GETTING-STARTED.md` Step 11). If the key ever leaves the machine, delete it in the App settings on GitHub and create a new one.
4. Deliver the worker's credentials (section 5f) and start it: `pnpm compose:platform`.

### Issuing a secret ID: sensitive, audited

A secret ID + role ID lets a process log in as that AppRole. Treat issuing one like handing over a key.

- Only the platform admin issues secret IDs, only for a process being deployed or rotated, and records it in the operations log (role, date, reason, accessor, not the secret ID).
- Every issue is in the OpenBao audit log.
- A secret ID works only from the Compose network subnet and expires after **90 days**. The tokens a process gets at login work only from the same subnet. The network gateway (`SDLC_NETWORK_GATEWAY`) is left out: every process on the server reaches the containers from the gateway address, so a secret ID or token used on the server outside a container is refused (`design/QUESTIONS.md` #27, #37).
- Trust model: this stops users of the server without root rights, and credentials that leak out of a container. Root on the server is trusted: root can `docker exec` into any container. Access to root and to Docker on the server is controlled by server administration.
- Deliver it straight to the process as a file (section 5c). Never through chat or email.

```bash
# role ID (not secret)
bao read -field=role_id auth/approle/role/runner/role-id
# new secret ID: note the accessor in the operations log
bao write -f auth/approle/role/runner/secret-id
```

(Run inside the container, with `BAO_TOKEN` set to an admin token as above.)

## 5c. How a platform process uses its credentials

Each platform process (api, worker, runner, cost-controller) uses the OpenBao client `@sdlc/secrets` (design/ADR-M21). It reads these settings:

| Setting | Value |
|---|---|
| `SDLC_OPENBAO_ADDR` | `https://openbao:8200` after A10 (the process runs in Compose; OpenBao publishes no host port). Before A10, only on development machines and in CI: `http://openbao:8200` together with `SDLC_OPENBAO_ALLOW_PLAINTEXT=1` |
| `SDLC_OPENBAO_CA_CERT_FILE` | The company internal CA certificate (after A10). The client always checks the server certificate; there is no way to skip the check |
| `SDLC_OPENBAO_ROLE_ID_FILE` | File with the role ID |
| `SDLC_OPENBAO_SECRET_ID_FILE` | File with the secret ID: mode 600, on a tmpfs mount, readable only by the process |

- The role ID and the secret ID are **files**, never environment variables: anyone allowed to run `docker inspect` can read environment variables.
- **Rotating a secret ID** (every 90 days, section 8.1): issue a new secret ID, replace the file, then destroy the old secret ID. No restart is needed: the client reads the file again at its next login (at the latest when its token reaches the 4-hour maximum).
- The client renews its token by itself and logs in again when needed. It never writes a token, secret ID or secret value to its logs.

## 5d. LiteLLM keys (Compose profile `models`)

LiteLLM (the model gateway) gets its keys from OpenBao through a sidecar: an OpenBao Agent (service `litellm-agent`, same image as OpenBao). The sidecar logs in with the AppRole `litellm` and writes LiteLLM's configuration, with the keys, into a file in memory (tmpfs). LiteLLM reads the file when it starts. No model provider key is ever in `.env`, in the repo, in an image or in an environment variable (`design/QUESTIONS.md` #1, `design/ADR-M24-litellm-cost-controller.md`).

**The server always runs with the profile `models`:** `pnpm compose:models` (profiles `core` and `models`). Without the profile, LiteLLM starts with no models and uses the development keys from `.env`; that is for development machines only. On the server, leave `LITELLM_MASTER_KEY` and `LITELLM_SALT_KEY` empty in `.env`.

### First set-up

1. OpenBao is initialised, unsealed and configured (sections 3 and 4). `configure` creates the AppRole `litellm`.
2. With an admin token, store three kinds of secret (section 5b shows how to pass a value on stdin):
   - the LiteLLM master key at `kv/cost-controller/litellm-master-key`, field `value` (it must start with `sk-`). The Cost Controller reads the same entry: there is only one master key;
   - the LiteLLM salt key at `kv/litellm/salt-key`, field `value`. **Never change it after the first start**: LiteLLM encrypts stored credentials with it;
   - one model provider key per provider at `kv/litellm/providers/<provider>`, field `api_key`:
     ```bash
     docker compose -f platform/deploy/docker-compose.yml --env-file platform/deploy/.env exec openbao \
       sh -c 'read -rs BAO_TOKEN && export BAO_TOKEN && read -rs VALUE && printf %s "$VALUE" | bao kv put -mount=kv litellm/providers/anthropic api_key=-'
     ```
3. Deliver the sidecar's AppRole credentials. The command asks for an admin token (hidden), issues a new secret ID and writes it with the role ID into the sidecar's volume. It prints no secret:
   ```bash
   pnpm openbao:bootstrap litellm-credentials
   ```
   Record it in the operations log (role `litellm`, date, reason; not the secret ID).
4. Start: `pnpm compose:models`. LiteLLM waits until the sidecar has written the configuration.
5. Check: `docker compose -f platform/deploy/docker-compose.yml --env-file platform/deploy/.env --profile core --profile models ps` shows `litellm-agent` and `litellm` as healthy.

**Developer machines only: a local Ollama model** (`design/QUESTIONS.md` #78). Ollama has no key; its entry holds the address LiteLLM uses (on Docker Desktop, `http://host.docker.internal:11434`). Store it with an admin token, then restart `litellm-agent` and `litellm`:
```bash
docker compose -f platform/deploy/docker-compose.yml --env-file platform/deploy/.env exec openbao \
  sh -c 'read -rs BAO_TOKEN && export BAO_TOKEN && bao kv put -mount=kv litellm/providers/ollama api_base=http://host.docker.internal:11434'
```
Pull the model first on the machine (`ollama pull gpt-oss:20b`, a local tag, never a `:cloud` model). Never on the internal server: it has no GPU.

A model appears in LiteLLM only when its provider has a key in `kv/litellm/providers/`. The list of models is in `platform/deploy/litellm/config.ctmpl`. To add a model, change that file in a reviewed pull request: every model declares `provider_type` (`api` or `self_hosted`), and a self-hosted model declares a cost per token above 0, because LiteLLM skips budget checks for a model that costs 0 (`design/D-07-model-and-token-management.md` section 3). Then restart LiteLLM.

### Rotation

| What | Steps |
|---|---|
| A model provider key | Store the new value (step 2). The sidecar writes the new configuration within about 5 minutes. Then restart LiteLLM: `docker compose … --profile core --profile models restart litellm`. Revoke the old key at the provider |
| The master key | Store the new value. Restart `litellm-agent`, then `litellm`. The Cost Controller reads the new value at its next read. Virtual keys already issued stay valid |
| The sidecar's secret ID (every 90 days, section 8.1) | `pnpm openbao:bootstrap litellm-credentials`, then restart `litellm-agent`. Then destroy the old secret ID (section 8.1, step 4) |
| The salt key | Never |

## 5e. The API (Compose profile `platform`)

The API (service `sdlc-api`, task B03) logs in with the AppRole `api` and reads the password of the database role `platform_app` from `kv/api/database` once, when it starts. The password is never in its environment or image (`design/ADR-M26-api-app.md` §2.6, `design/QUESTIONS.md` #67).

### First set-up

1. OpenBao is initialised, unsealed and configured (sections 3 and 4). `configure` creates the AppRole `api`.
2. Store the password and deliver the API's AppRole credentials. The command asks for an admin token (hidden). It stores `PLATFORM_APP_DB_PASSWORD` from `platform/deploy/.env` at `kv/api/database`, issues a new secret ID, and writes the secret ID with the role ID into the volume `api-approle`. It prints no secret:
   ```bash
   pnpm openbao:bootstrap api-credentials
   ```
   Record it in the operations log (role `api`, date, reason; not the secret ID).
3. Start: `pnpm compose:platform` (profiles `core` and `platform`). The API listens on `127.0.0.1:8090`.
4. Check: `curl -s http://127.0.0.1:8090/health/ready` answers `{"status":"ok"}`.

### Rotation

| What | Steps |
|---|---|
| The API's secret ID (every 90 days, section 8.1) | `pnpm openbao:bootstrap api-credentials`, then restart `sdlc-api`. Then destroy the old secret ID (section 8.1, step 4) |
| The `platform_app` password | Change it in PostgreSQL and in `.env`, run `pnpm openbao:bootstrap api-credentials`, then restart `sdlc-api` |

## 5f. The worker (Compose profile `platform`)

The worker (service `sdlc-worker`, task B06) polls GitHub and handles the comment commands (`design/ADR-M27-github-poller.md`). It logs in with the AppRole `worker`. It reads the password of the database role `platform_app` from `kv/worker/database` once, when it starts, and the GitHub App key from `kv/shared/github-app` every 10 minutes. No password or key is in its environment or image.

### First set-up

1. OpenBao is initialised, unsealed and configured (sections 3 and 4). `configure` creates the AppRole `worker`. The GitHub App key is stored (section 5b; on a development machine section 5b.1).
2. Store the password and deliver the worker's AppRole credentials. The command asks for an admin token (hidden). It stores `PLATFORM_APP_DB_PASSWORD` from `platform/deploy/.env` at `kv/worker/database`, issues a new secret ID, and writes it with the role ID into the volume `worker-approle`. It prints no secret:
   ```bash
   pnpm openbao:bootstrap worker-credentials
   ```
   Record it in the operations log (role `worker`, date, reason; not the secret ID).
3. Start: `pnpm compose:platform` (profiles `core` and `platform`). The worker publishes no port.
4. Check: `docker compose -f platform/deploy/docker-compose.yml --env-file platform/deploy/.env logs sdlc-worker` shows `worker.started`, then one `poll.completed` per project and interval. The logs hold IDs and codes only.

### Rotation

| What | Steps |
|---|---|
| The worker's secret ID (every 90 days, section 8.1) | `pnpm openbao:bootstrap worker-credentials`, then restart `sdlc-worker`. Then destroy the old secret ID (section 8.1, step 4) |
| The `platform_app` password | Change it in PostgreSQL and in `.env`, run `api-credentials`, `worker-credentials` and `runner-credentials`, then restart `sdlc-api`, `sdlc-worker` and `sdlc-runner` |
| The GitHub App key | Section 5b. No restart: the worker reads the key again after 10 minutes |

## 5g. The runner and sandboxes (Compose profile `sandbox`)

The runner (service `sdlc-runner`, task C04) creates one hardened sandbox per agent run (`design/ADR-M25-runner-sandbox.md`). It logs in with the AppRole `runner` and reads the password of the database role `platform_app` from `kv/runner/database` once, when it starts. It reaches Docker only through the socket proxy (`docker-socket-proxy`); it never mounts the Docker socket itself.

### First set-up

1. OpenBao is initialised, unsealed and configured (sections 3 and 4). `configure` creates the AppRole `runner`.
2. Check `SDLC_DOCKER_GID` in `platform/deploy/.env`: the group of `/var/run/docker.sock` on the host (`init-env.sh` fills it in; `stat -c %g /var/run/docker.sock` on Linux, `0` on Docker Desktop). With a wrong value the socket proxy cannot read the socket and stays unhealthy.
3. Store the password and deliver the runner's AppRole credentials. The command asks for an admin token (hidden). It stores `PLATFORM_APP_DB_PASSWORD` from `platform/deploy/.env` at `kv/runner/database`, issues a new secret ID, and writes the secret ID with the role ID into the volume `runner-approle`. It prints no secret:
   ```bash
   pnpm openbao:bootstrap runner-credentials
   ```
   Record it in the operations log (role `runner`, date, reason; not the secret ID).
4. Start: `pnpm compose:sandbox` (profiles `core` and `sandbox`). It also starts the npm package proxy (`npm-proxy`, Verdaccio) and the local image registry (`registry`).
5. Check: `docker compose … ps sdlc-runner` shows `healthy`. The runner's log has one line with `"event":"runner.started"`.

### Sandbox images and the local registry

- The registry listens on **127.0.0.1 only** (`SDLC_REGISTRY_HOST_PORT`, default 5050) and has **no authentication**. Only operators logged in on the server can push. Never publish it on another address.
- Images are **always used by digest**, never by tag. Build and push, then copy the printed reference into the project configuration as `sandbox.image`:
  ```bash
  pnpm sandbox-image:build node24
  # prints localhost:5050/sdlc/sandbox-node24@sha256:<digest>
  ```
- On Docker Desktop (development) the Engine cannot push to a port published on the Mac. Use `platform/sandbox-images/build.sh node24 --no-push`: it prints the local reference by digest.
- Old images: delete the manifest by digest (`curl -X DELETE http://127.0.0.1:5050/v2/sdlc/sandbox-node24/manifests/sha256:<digest>`), then run garbage collection: `docker compose … exec registry registry garbage-collect /etc/docker/registry/config.yml`. Keep every digest a project configuration still names.

### Rotation

| What | Steps |
|---|---|
| The `platform_app` password | See section 5f: all three credentials commands, then restart the three services |
| The runner's secret ID (every 90 days, section 8.1) | `pnpm openbao:bootstrap runner-credentials`, then restart `sdlc-runner`. Then destroy the old secret ID (section 8.1, step 4) |

### After a crash or restart

The runner cleans up by itself when it starts: it removes every sandbox, network and workspace volume that carries its instance label (`COMPOSE_PROJECT_NAME`). Runs that were still provisioning or running end as `failed` with `runner_restarted`. Nothing to do by hand. Run **one** `sdlc-runner` per Compose project: two runners with the same instance label would remove each other's sandboxes.

## 6. Daily snapshot backup

> Commands only. The procedure is tested in the recovery drill of task A10, which also adds the backup script.

Two jobs, both required:
- the **snapshot** (the encrypted data);
- the **key shares** (sections 2 and 3), kept separately.

A snapshot is useless without 2 shares.

```bash
# needs a token allowed to read sys/storage/raft/snapshot (root, created per section 5)
docker compose -f platform/deploy/docker-compose.yml --env-file platform/deploy/.env exec -T openbao \
  sh -c 'read -r BAO_TOKEN && export BAO_TOKEN && bao operator raft snapshot save /openbao/file/snapshot.snap'
```

- Copy the snapshot **off the server**, encrypted, daily. Then delete the copy inside the container.
- Also back up the audit volume `openbao-audit`. The handbook (Ch.3) requires audit records to be kept at least 2 years. Rotation and the copy to evidence storage are tasks A10 and E05.
- Check each backup: file size is not zero, and the date is today.

## 7. Restore on a test machine (recovery drill)

> Commands only. Tested in task A10. Drills: first at milestone M-A, then every 3 months and whenever a key holder changes.

1. On a test machine, start a fresh stack (`pnpm compose:env`, `pnpm compose:core`).
2. Initialise a throw-away instance (section 3.1: `init`, `unseal`). The restore replaces it.
3. Copy the snapshot into the container, then restore with a root token of the throw-away instance:
   `bao operator raft snapshot restore -force /openbao/file/snapshot.snap`
4. OpenBao is now sealed with the **real** keys. Two real key holders unseal it (section 4).
5. Check:
   - `bootstrap.sh status` says `unsealed`;
   - the Transit key `run-contract` exists;
   - an AppRole can log in from the Compose network.
6. Destroy the test instance (`down -v`). Record the drill in the operations log.

## 8. Changing a key holder, rotating secret IDs

### 8.1. Access review every 3 months (handbook Ch.3)

Every 3 months, and when someone changes project:
- check the list of key holders and people with Docker access on the server;
- **rotate every AppRole secret ID**:
  1. issue a new one (section 5b);
  2. deploy it;
  3. check the process logs in;
  4. destroy the old one: `bao write auth/approle/role/<role>/secret-id-accessor/destroy secret_id_accessor=<accessor>`.
- record the review in the operations log.

Secret IDs expire after 90 days in any case, so a missed rotation shows up as a failed login.

### 8.2. Rekey when a key holder changes

> Not yet tested: the rekey commands need an interactive terminal. The `bao operator rekey` command may call token-protected endpoints, as `bao operator generate-root` does in OpenBao 2.5+. The A10 drill checks the commands below and adds a `bootstrap.sh rekey` command if needed.

When a key holder leaves or changes role, create a **new set of shares** and destroy the old envelopes:

1. The new holder is named by leadership. Record the change in the operations log.
2. Two current key holders start the rekey inside the container, on the key-holder listener:
   ```bash
   docker compose -f platform/deploy/docker-compose.yml --env-file platform/deploy/.env exec openbao \
     sh -c 'BAO_ADDR=http://127.0.0.1:8210 bao operator rekey -init -key-shares=3 -key-threshold=2'
   ```
3. Each of the two holders runs `bao operator rekey -nonce=<nonce>` (same `docker compose exec … sh -c 'BAO_ADDR=http://127.0.0.1:8210 …'`) and types their share at the hidden prompt.
4. The new 3 shares are printed once. Handle them as in section 3.2 steps 3, 7 and 8: one share for each holder, including the new one.
5. Unseal test: restart the `openbao` container and unseal with two **new** shares.
6. Destroy the old envelopes in front of a witness. Record it in the safe log and the operations log.
7. Run a recovery drill (section 7) with the new shares.

## 9. Troubleshooting

| Symptom | Cause | What to do |
|---|---|---|
| `OpenBao is not reachable` | Container not running | `pnpm compose:core`; `docker compose … logs openbao` |
| `OpenBao is sealed; unseal it first` | Restart | Section 4 |
| `OpenBao is not initialised` | New, empty volume | Section 3. If you expected data, **stop**: you may be on the wrong volume or project |
| `output is not a terminal` | `init` or `root-token` run with output redirected or piped | Run it again in a normal terminal. This is intended |
| `a root token is required` | `configure` got an admin token or an expired token | Section 5 |
| `a root token generation is already in progress` | An earlier `root-token` was interrupted | Inside the container: `BAO_ADDR=http://127.0.0.1:8210 bao delete sys/generate-root/attempt`, then try again |
| `the key share was rejected` | Mistyped or old share | Try again carefully. After a rekey, old shares no longer work |
| A process says `AppRole login failed (HTTP status …)` | Secret ID expired (90 days), destroyed, wrong, or used outside the Compose subnet (the gateway address counts as outside) | Section 8.1; check that the process runs in a container on the Compose network, `SDLC_NETWORK_SUBNET`, `SDLC_NETWORK_GATEWAY` and the secret ID file (section 5c) |
| `curl http://127.0.0.1:8200/…` on the server fails | OpenBao publishes no host port (by design, task A11) | `pnpm openbao:bootstrap status`, or `docker compose … exec openbao bao status` |
| A process says `OpenBao at … is sealed` | Restart. Compose still shows OpenBao as healthy: healthy only means the API answers | Section 4 |
| A process says `OpenBao at … is not initialised` | New, empty volume, or the wrong Compose project | Section 3. If you expected data, **stop** and check the volume |
| A process says `The OpenBao policy of this process does not allow …` | The process asked for a path outside its policy | Correct the path in the process. Change a policy only through `bootstrap/policies/` and `configure` |
| A process says `The certificate of OpenBao at … could not be verified` | Wrong or missing CA file, expired server certificate, or the address does not match the certificate | Check `SDLC_OPENBAO_CA_CERT_FILE` and the certificate dates (A10). Never turn the check off |
| A process says `… does not use TLS` | `http://` address without `SDLC_OPENBAO_ALLOW_PLAINTEXT=1` | On the server: use `https://`. The flag is for development machines and CI only |
| `no file audit device` | `openbao.hcl` changed | Restore the `audit "file"` block. OpenBao also refuses requests when it cannot write the audit log: check the `openbao-audit` volume (disk full, permissions) |
| `litellm-agent` stays unhealthy; LiteLLM does not start | OpenBao is sealed, the sidecar's secret ID is missing or expired, or the master key or salt key is not stored | Section 4; `pnpm openbao:bootstrap litellm-credentials`; section 5d step 2. `docker compose … logs litellm-agent` shows the reason (never a key) |
| LiteLLM exits with `no rendered configuration (Compose profile models) and no LITELLM_MASTER_KEY` | Started without the profile `models` and without a development master key | On the server: `pnpm compose:models`. On a development machine: set `LITELLM_MASTER_KEY` in `.env` |
| `could not deliver the litellm credentials` | Wrong or expired admin token, or `configure` has not created the AppRole `litellm` yet | Section 5.1; run `configure` again after an upgrade |
| `sdlc-api` restarts with "Cannot read SDLC_OPENBAO_ROLE_ID_FILE" or "no password field" | `api-credentials` was not run, or the volume was removed | Section 5e, step 2 |
| `sdlc-runner` restarts with `runner.start_failed` ("no password field", "Cannot read SDLC_OPENBAO_ROLE_ID_FILE") | `runner-credentials` was not run, or the volume was removed | Section 5g, step 3 |
| `docker-socket-proxy` stays unhealthy, or the runner says it cannot reach the Docker socket (`EACCES`) | `SDLC_DOCKER_GID` is not the group of the host's Docker socket | Section 5g, step 2; then `pnpm compose:sandbox` again |
| A run fails with `image_unavailable` | `sandbox.image` names a digest the local registry does not have, or the registry is down | Section 5g, sandbox images: push the image again and check the digest |
| A run fails with `agent_runner_not_attachable` or `agent_model_unreachable` | `SDLC_RUNNER_SELF_CONTAINER` is not the runner's container name, or `SDLC_RUNNER_AGENT_LLM_URL` (`alias:port`) is not in the run's egress list | Check the `sdlc-runner` environment in `platform/deploy/docker-compose.yml` (design/ADR-M29 §2.7) |
| A model is missing in LiteLLM | Its provider has no key in `kv/litellm/providers/`, or LiteLLM was not restarted after the key was stored | Section 5d |
| Compose says the network has a different configuration | `SDLC_NETWORK_SUBNET` or `SDLC_NETWORK_GATEWAY` changed | `pnpm compose:down`, then `pnpm compose:core`. Then run `configure` again (secret IDs are bound to the subnet without the gateway) |
| `the Compose network has no fixed gateway` from `configure` | The network was created before A11 | `pnpm compose:down`, then `pnpm compose:core`, then `configure` again |

## 10. Operations log template

Keep one log per installation. Never write a share, a token or a secret ID in it.

| Date and time (UTC) | Action | People present | Reason | Result | Root token revoked? | Signed |
|---|---|---|---|---|---|---|
| 2026-MM-DD hh:mm | e.g. unseal after restart / root token for configure / secret ID issued (role, accessor) / drill / rekey | | | | yes / n/a | |

---

## Version history

| Version | Date | Author | Notes |
|---|---|---|---|
| 0.0 | 2026-09-24 | — | Skeleton |
| 0.1 | 2026-09-24 | Claude (draft) | Outline; content written by Claude Code in A03/A10 |
| 0.2 | 2026-09-25 | Claude Code (task A03) | Full content. Sections 3.1, 4, 5, 5b and 8.1 tested on a development machine with throw-away keys (`bootstrap.sh`, live test `pnpm test:openbao`). Sections 6, 7 and 8.2 to be tested in A10. The real initialisation (3.2) is described, not performed |
| 0.3 | 2026-09-25 | Claude Code (task A04) | Section 5c (client settings, credential files, secret ID rotation without restart); tokens bound to the subnet; troubleshooting rows for the client messages; host-port exception (`design/QUESTIONS.md` #27) |
| 0.4 | 2026-09-26 | Claude Code (task A11) | OpenBao publishes no host port: all admin work through `docker compose exec` (section 1); gateway left out of the bound CIDRs and the trust model (section 5b, `design/QUESTIONS.md` #27, #37); `SDLC_OPENBAO_ADDR` in section 5c; troubleshooting rows |
| 0.5 | 2026-09-26 | Claude Code (task B05) | The `worker` AppRole also reads the GitHub App key `kv/shared/github-app` (`design/QUESTIONS.md` #42); section 5b: creating the GitHub App, storing and rotating its key (not yet tested with a real App) |
| 0.6 | 2026-09-26 | Claude Code (task C03) | Section 5d: LiteLLM keys through the OpenBao Agent sidecar (profile `models`), `litellm-credentials`, rotation; AppRole `litellm`; key table; troubleshooting rows (`design/QUESTIONS.md` #1, ADR-M24) |
| 0.7 | 2026-09-27 | Claude Code (task B03) | Section 5e: the API reads the `platform_app` password from `kv/api/database` with the AppRole `api`; `api-credentials`, rotation; key table row; troubleshooting row (`design/QUESTIONS.md` #67, ADR-M26). Tested with throw-away keys (`pnpm test:api`) |
| 0.8 | 2026-09-27 | Claude Code (task C04) | The `runner` AppRole no longer reads `kv/shared/github-app`; the worker hands it each run's token as a single-use response-wrapped token (`design/QUESTIONS.md` #44). Existing installations: run `configure` again to load the new `runner` and `worker` policies |
| 0.9 | 2026-09-27 | Claude Code (task B06) | Section 5b.1: storing the test GitHub App key in the development OpenBao from its file (run by the owner in the macOS Terminal); section 5f: the worker reads `kv/worker/database` and `kv/shared/github-app` with the AppRole `worker`, `worker-credentials`, rotation; key table row |
| 0.10 | 2026-09-27 | Claude Code (task C04, session 3) | Section 5g: the runner reads the `platform_app` password from `kv/runner/database` (`runner-credentials`); `SDLC_DOCKER_GID`; the local registry (127.0.0.1 only, no authentication, images by digest, clean-up); clean-up after a restart; troubleshooting rows (ADR-M25). Tested with throw-away keys (`pnpm test:runner-compose`) |
| 0.11 | 2026-09-27 | Claude Code (task C05) | Troubleshooting row: agent runs that cannot reach the Agent Server or LiteLLM (ADR-M29) |
| 0.12 | 2026-09-27 | Claude Code (task C05, session 2) | Section 5d: a local Ollama model on developer machines only (`kv/litellm/providers/ollama`, field `api_base`; QUESTIONS #78) |
