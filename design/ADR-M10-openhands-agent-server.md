# ADR-M10. OpenHands Agent Server: result of the C01 PoC

| Item | Value |
|---|---|
| Status | **Proposed** (task C01, PR for review) |
| Date | 2026-09-25 |
| Decided by | Harry (plan approved 2026-09-25) |
| Related | D-08 tasks C01, C04, C05, C11; D-02 FR-30…FR-35, FR-50, FR-51; D-03 sections 5.3, 7.2, 8, 9, 12 (ADR-M04), 13; D-07 section 3; D-01 section 5.1; ADR-M17; design/QUESTIONS.md #13 |
| Spike code | `platform/spikes/openhands/` (may be thrown away) |

## 1. Context

ADR-M04 decided that the TypeScript platform calls OpenHands through the **Agent Server REST API**, and does not embed the Python SDK. D-03 section 7.2 asks for a PoC at the start of M-C: run the Agent Server in a container, call it from Node.js, get the log and the changed files. The model must go through LiteLLM with a per-run virtual key (FR-50). This ADR records what works, the pinned version, the limits we found, and the go / no-go for C05.

All sources were accessed on 2026-09-25.

## 2. Decision

**Go for C05.** OpenHands Agent Server `1.48.0` can be controlled from Node.js over REST, with every model call going through LiteLLM on a per-run virtual key. The sandbox has no route out except LiteLLM, drops all capabilities and runs with a read-only root filesystem.

### 2.1. Pinned image and licence

| Item | Value |
|---|---|
| Image | `ghcr.io/openhands/agent-server:1.48.0-python-slim` |
| Digest (multi-arch index) | `sha256:8fcfab2dedb4b41b6aef219b9fa9b1f2588033fad3d998ae6aa11fe8c4fcf8b7` (linux/amd64, linux/arm64) |
| Source | https://github.com/OpenHands/software-agent-sdk, tag `v1.48.0` (released 2026-09-15), `build_git_sha` 481dfb3d reported by `/server_info` |
| Why 1.48.0 | ADR-M17 rule: the latest patch of the previous minor release. 1.49 had 5 patch releases between 2026-09-16 and 2026-09-23 |
| Why `-slim` | The non-slim image bundles third-party ACP agent CLIs with their own licences. `-slim` leaves them out |
| Size | About 862 MB compressed (amd64), 3.05 GB on disk (arm64) |
| Licence of OpenHands code | MIT (repository licence). The repository has **no `enterprise/` directory**; the `enterprise/` code lives in the separate `OpenHands/OpenHands` app repository, which we do not use |
| Trivy licence scan (0.74.0) | **No CRITICAL** findings (no AGPL, SSPL or commercial licences). HIGH findings are only Debian OS packages under GPL/LGPL (bash, coreutils, git, chromium and similar), used unmodified. When we ship the image to clients, the usual Debian source-offer duties apply; C04 may build a smaller image without the browser and VS Code (see 4.3) |

The API was verified in the router sources at tag `v1.48.0` (`openhands-agent-server/openhands/agent_server/*.py`), in the release asset `openapi.json`, and in the documentation at https://docs.openhands.dev/sdk/guides/agent-server/overview. The official TypeScript client (`clients/typescript`) is marked **alpha**; we do not use it.

### 2.2. Usable API

Authentication: header `X-Session-API-Key` with a random per-run key, passed to the container as `SESSION_API_KEY`. Health endpoints (`/alive`, `/health`, `/ready`, `/server_info`) need no key.

| Need (D-03 §7.2) | Call | Verified in the PoC |
|---|---|---|
| Ready | `GET /ready`, `GET /server_info` | Yes. Start-up to ready: 4.5–6.8 s |
| Start (`startRun`) | `POST /api/conversations` with `agent{kind, llm, tools}`, `workspace{kind: LocalWorkspace, working_dir}`, `initial_message{content, run: true}`, `max_iterations`, `stuck_detection`, `autotitle: false` | Yes |
| Status (`getStatus`) | `GET /api/conversations/{id}` → `execution_status`: `idle`, `running`, `paused`, `waiting_for_confirmation`, `finished`, `error`, `stuck`, `deleting` | Yes |
| Stop (`stop`) | `POST /api/conversations/{id}/interrupt` (cancels the in-flight model call; state `paused` in 16–32 ms). `pause` waits for the current call | Yes |
| Kill switch | `docker rm --force` on the container, then `POST /key/delete` on LiteLLM | Yes: 179–204 ms; the revoked key gets HTTP 401 |
| Logs (`collectOutputs`) | `GET /api/conversations/{id}/events/search?limit=100&page_id=…` (paged with `next_page_id`; filters `kind`, `source`) | Yes: `SystemPromptEvent`, `MessageEvent`, `ActionEvent`, `ObservationEvent`, `ConversationStateUpdateEvent` |
| Changed files | `GET /api/git/changes?path=<working_dir>` → `[{path, status: ADDED/UPDATED/DELETED/MOVED}]` against `HEAD` | Yes |
| Diff, last commit | `GET /api/git/diff?path=…`, `GET /api/git/commits?path=…&limit=…` | Commits yes; diff not exercised |
| Workspace set-up | `POST /api/bash/execute_bash_command` (`command`, `cwd`, `timeout`) | Yes: `git init` and a fixture commit |

Mapping to D-05 `run_status` (spike `status-map.ts`): `finished` → `succeeded`; `error` → `failed`; `stuck` → `stopped_stalled`; `paused` after our own interrupt → `stopped_killed`, `stopped_stalled` or `stopped_timeout` by the reason we stopped it. Budget and scope stops are decided by the platform (LiteLLM spend, G5), not read from the Agent Server.

### 2.3. Model through LiteLLM (FR-50)

- The agent's LLM is `model: litellm_proxy/<alias>`, `base_url: http://litellm:4000`, `api_key: <per-run virtual key>`. The container receives no provider key and no LiteLLM master key (checked with `docker inspect`).
- The virtual key is created with `POST /key/generate`: `models: [alias]`, `max_budget`, `duration`, and `metadata` with the seven D-07 labels (`tenant`, `project`, `intent_id`, `run_id`, `gate`, `agent`, `data_class`). `GET /key/info` returns the labels and the spend; `GET /spend/logs?api_key=…` returns one row per model call.
- The PoC uses a **scripted stub model** (an OpenAI-compatible server on the internal network) so the whole path runs without a provider key. It returns real tool calls, so the agent really edits the workspace.

### 2.4. Sandbox and network in the PoC

| Setting | Value | Result |
|---|---|---|
| Network | Only the Docker network `sdlc-poc-sandbox` (`internal: true`), shared with LiteLLM and the stub model | `curl https://api.github.com` from inside fails. No route to OpenBao, PostgreSQL or the internet |
| Published ports | None on the sandbox | Docker does **not** publish ports for a container that is only on an internal network. The host reaches the API through a small relay container (default bridge + internal network, 127.0.0.1 only) |
| Listening ports inside (from `/proc/net/tcp`; the image has no `ss` or `netstat`) | `0.0.0.0:8000` (API, uid 10001) and `127.0.0.11:<random>` (Docker's embedded DNS, not ours) | With default settings the image also listens on `0.0.0.0:8001` (VS Code server). `OH_ENABLE_VSCODE=false` removes it |
| User, capabilities | `--user 10001:10001`, `--cap-drop ALL`, `--security-opt no-new-privileges` | Works. `no-new-privileges` also neutralises the image's passwordless `sudo` for user `openhands` |
| Limits | `--memory 2g --memory-swap 2g --cpus 1.5 --pids-limit 512` (spike values) | Works |
| **Read-only root filesystem** | `--read-only` plus tmpfs `/tmp` (**with `exec`**), `/workspace` (uid 10001) and `/home/openhands` | **Works.** Without `exec` on `/tmp` the server does not start: the entrypoint is a PyInstaller binary that unpacks shared libraries to `/tmp` (`libz.so.1: failed to map segment`) |
| Environment | Allowlist only: `SESSION_API_KEY`, `OH_SECRET_KEY`, `OH_ENABLE_VSCODE=false`, `OH_TELEMETRY_EXPORTER=none`, `DO_NOT_TRACK=1`, `OPENHANDS_SUPPRESS_BANNER=1` | FR-33 check passes |
| Mounts | No Docker socket, no host directory | Workspace lives in tmpfs and disappears with the container |

### 2.5. Resources (development machine, arm64, stub model)

| Measure | Value |
|---|---|
| Sandbox RAM at idle / after a run | about 0.49 GiB / 0.51 GiB |
| Sandbox CPU at idle | under 1 % |
| Start-up to ready | 4.5–6.8 s |
| Stub model container | about 33 MiB |

With the default of 1–2 concurrent runs, reserve about 2 GiB per sandbox (the limit) on top of the ~1.3 GiB of the `core` profile. A real model run uses more memory in the terminal tool; the real-model figures are in section 3.

### 2.6. Handbook rules: config, not code

- Loop limit: `run.loop_detection.identical_tool_calls_max` (3) from `@sdlc/config`.
- Run budget: `budget.default_run_usd` from `@sdlc/config`; the real-model run uses `min(default_run_usd, 1.00)`.
- Iteration and time caps: spike defaults (30 iterations, 10 minutes), clearly labelled. C05 adds `run.default_max_iterations` and `run.default_max_duration_minutes` to `@sdlc/config` (QUESTIONS.md #13).

## 3. Real-model run

**Pending:** the Anthropic key is not yet in `platform/deploy/.env`. Planned run: `anthropic/claude-haiku-4-5-20251001` through LiteLLM alias `poc-claude`, key budget USD 1.00, fixture workspace only. The live test case `real Claude run through LiteLLM` fills this section.

## 4. Limitations and findings for later tasks

### 4.1. C05 (OpenHands adapter)

1. **Send `autotitle: false`.** By default OpenHands makes one extra model call per conversation to write a title (measured: 3 calls instead of 2 for a two-step task).
2. **OpenHands' stuck detector has fixed thresholds** (4 repeats; not configurable over REST). The platform must run its own check with the config limit (FR-35). With the handbook default (3) both trigger on the 4th identical call. With a 250 ms poll the platform interrupted after 4 identical calls; with a 500 ms poll and a fast model it overshot to 5. C11 should read events over the WebSocket (`/sockets/events/{id}`) or poll faster.
3. **Iteration cap is native** (`max_iterations`); the **time cap** is ours: interrupt, then kill.
4. Keep the tool list explicit (`terminal`, `file_editor`, `task_tracker`). The server offers more tools (`browser_tool_set`, `task`, `delegate`, `workflow` and others) that we do not want at L2.
5. The Agent Server keeps state per conversation in the container. We run **one conversation per container**, so a crash loses nothing that the platform needs: evidence is collected through the API before the container is removed.
6. The OpenHands image tries to download LiteLLM's price list from GitHub at start-up. It fails on the internal network and falls back to the bundled list. This is harmless, but it is an outbound attempt to record in C04.

### 4.2. C03 / C07 (cost)

- **LiteLLM budgets are not strictly ordered.** With fast calls on a key with `max_budget` USD 0.002 and USD 0.0012 per call, we saw `200, 429, 200, 429` in one run and `200, 200, 429, 429` in another. Spend is updated asynchronously. The key budget is a hard backstop that can be off by about one call; G5 must also check spend from `cost_records` (FR-52) and must not rely on the LiteLLM block alone.
- The labels on the key metadata are enough for per-run spend (`/key/info`, `/spend/logs`). Langfuse was not part of this PoC (A08).

### 4.3. C04 (runner)

- **GitHub egress** cannot be allowed by a Docker network, which works on IP level and has no domain allowlist. C04 needs an egress proxy with a domain allowlist (GitHub, LiteLLM) or firewall rules. Until then the sandbox has no GitHub access, so the runner must clone outside and push outside, or the proxy comes first.
- The runner must reach sandboxes on an internal network: either the runner itself joins that network (preferred, no published ports at all), or it uses a relay as in the PoC.
- Read-only root works; `/tmp` needs `exec` (see 2.4). The workspace in tmpfs counts against container memory; size it for the repo (the PoC used 512 MB).
- A custom image built from the same Dockerfile with `INSTALL_CAPABILITIES` empty (no VS Code, browser or Docker CLI) would be smaller and remove most GPL/LGPL packages. Decide in C04.
- The spike uses the Docker CLI. C04 decides between the CLI and a Docker API client.

### 4.4. General

- OpenHands releases very often (about one minor a week). Pin by digest, keep the `openapi.json` of the pinned version, and upgrade on purpose with the live PoC test as the regression check.
- The Agent Server API is large (conversations, skills, plugins, MCP, VS Code, desktop). We use a small part of it; C05 should fail closed on anything unexpected.

## 5. Alternatives not chosen

| Option | Why not |
|---|---|
| `1.49.5` | Only 2 days old, 5 patches in a week (ADR-M17 rule) |
| Non-slim image | Bundles third-party ACP agent CLIs with their own licences |
| Official TypeScript client `@openhands/typescript-client` | Alpha, browser-oriented, API may change without notice |
| LiteLLM `mock_response` instead of a stub model | Returns text only, so the agent finishes without editing any file; it cannot prove the changed-files path |
| Embedding the Python SDK | Rejected by ADR-M04 |

## 6. Consequences

- C05 can implement `AgentAdapter` on the endpoints in 2.2, with the findings in 4.1.
- C04 takes the hardening flags in 2.4 as its starting point and must solve GitHub egress (4.3).
- C03 / C07 treat the LiteLLM key budget as a backstop, not the only stop (4.2).
- The spike's live test (`SDLC_OPENHANDS_POC=1`) can serve as the upgrade check for new OpenHands versions until C09 exists.

## Version history

| Version | Date | Author | Notes |
|---|---|---|---|
| 0.1 | 2026-09-25 | Claude (task C01) | First version |
