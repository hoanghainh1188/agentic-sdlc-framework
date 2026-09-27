# ADR-M10. OpenHands Agent Server: result of the C01 PoC

| Item | Value |
|---|---|
| Status | **Proposed** (task C01, PR for review); condition met in C05 session 2 (§3, QUESTIONS #78) |
| Date | 2026-09-25 |
| Decided by | Harry (plan approved 2026-09-25) |
| Related | D-08 tasks C01, C04, C05, C11; D-02 FR-30…FR-35, FR-50, FR-51; D-03 sections 5.3, 7.2, 8, 9, 12 (ADR-M04), 13; D-07 section 3; D-01 section 5.1; ADR-M17; design/QUESTIONS.md #13, #14, #15 |
| Spike code | `platform/spikes/openhands/` (may be thrown away) |

## 1. Context

ADR-M04 decided that the TypeScript platform calls OpenHands through the **Agent Server REST API**, and does not embed the Python SDK. D-03 section 7.2 asks for a PoC at the start of M-C: run the Agent Server in a container, call it from Node.js, get the log and the changed files. The model must go through LiteLLM with a per-run virtual key (FR-50). This ADR records what works, the pinned version, the limits we found, and the go / no-go for C05.

All sources were accessed on 2026-09-25.

## 2. Decision

**CONDITIONAL GO for C05** (Harry, 2026-09-25). **Condition met** on 2026-09-27 with a local model (§3, QUESTIONS #78): GO.

- **Proven with the stub model:** OpenHands Agent Server `1.48.0` can be controlled from Node.js over REST. Every model call goes through LiteLLM on a per-run virtual key with the seven labels. The sandbox has no route out except LiteLLM, drops all capabilities and runs with a read-only root filesystem. The kill switch, the budget block and loop detection work.
- **Condition:** one real run with a real model must pass before C05 is done (section 3, QUESTIONS.md #15). The stub model returns scripted tool calls; it does not show how a real model uses the tools, how many tokens a task costs, or how much memory a real run needs.
  - Originally: Claude on a company API key. No company key is planned, so the condition was changed (Harry, 2026-09-27, QUESTIONS #78): one real run through LiteLLM with a **local Ollama model on a developer machine** (`gpt-oss:20b`). Met in C05 session 2.
  - What the local run does not show: Claude-level quality, real API token cost, behaviour on the internal server (which has no GPU and is not a target for this model). One API-model run is still needed before the trial M-E (QUESTIONS #81).

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
| Network | Only the Docker network `sdlc-poc-sandbox` (`internal: true`, checked at run time with `docker network inspect`), shared with LiteLLM and the stub model | Docker gives an internal network no route out. The live test also checks one probe: `curl https://api.github.com` from inside fails. OpenBao and PostgreSQL are on another network, which the sandbox does not join |
| Published ports | None on the sandbox | Docker does **not** publish ports for a container that is only on an internal network. The host reaches the API through a small relay container (default bridge + internal network, 127.0.0.1 only; read-only, no capabilities, 128 MiB, 64 processes). The relay forwards raw TCP and is the one container on both networks: PoC only, see 4.3 |
| Listening ports inside (from `/proc/net/tcp`; the image has no `ss` or `netstat`) | `0.0.0.0:8000` (API, uid 10001) and `127.0.0.11:<random>` (Docker's embedded DNS, not ours) | With default settings the image also listens on `0.0.0.0:8001` (VS Code server). `OH_ENABLE_VSCODE=false` removes it |
| User, capabilities | `--user 10001:10001`, `--cap-drop ALL`, `--security-opt no-new-privileges` | Works. User `openhands` is in group `sudo` with passwordless sudo; with `no-new-privileges` sudo refuses to run (tested: "The no new privileges flag is set, which prevents sudo from running as root") |
| Limits | `--memory 2g --memory-swap 2g --cpus 1.5 --pids-limit 512` (spike values) | Works |
| **Read-only root filesystem** | `--read-only` plus tmpfs `/tmp` (**with `exec`**), `/workspace` (uid 10001) and `/home/openhands` | **Works.** Without `exec` on `/tmp` the server does not start: the entrypoint is a PyInstaller binary that unpacks shared libraries to `/tmp` (`libz.so.1: failed to map segment`) |
| Environment | Allowlist only: `SESSION_API_KEY`, `OH_SECRET_KEY`, `OH_ENABLE_VSCODE=false`, `OH_TELEMETRY_EXPORTER=none`, `DO_NOT_TRACK=1`, `OPENHANDS_SUPPRESS_BANNER=1` | FR-33 check passes |
| Mounts (sandbox) | No Docker socket, no host directory | Workspace lives in tmpfs and disappears with the container. The PoC's relay and stub model containers mount the spike source read-only; the sandbox does not |

### 2.5. Resources (development machine, arm64, stub model)

| Measure | Value |
|---|---|
| Sandbox RAM at idle / after a run | about 0.49 GiB / 0.51 GiB |
| Sandbox CPU at idle | under 1 % |
| Start-up to ready | 4.5–6.8 s |
| Stub model container | about 33 MiB |

With the default of 1–2 concurrent runs, reserve about 2 GiB per sandbox (the limit) on top of the ~1.3 GiB of the `core` profile. A real model run may use more memory and time; those figures come from the deferred real run (section 3).

### 2.6. Handbook rules: config, not code

- Loop limit: `run.loop_detection.identical_tool_calls_max` (3) from `@sdlc/config`.
- Run budget: `budget.default_run_usd` from `@sdlc/config`; the real-model run uses `min(default_run_usd, 1.00)`.
- Iteration and time caps: spike defaults (30 iterations, 10 minutes), clearly labelled. C05 adds `run.default_max_iterations` and `run.default_max_duration_minutes` to `@sdlc/config` (QUESTIONS.md #13).

## 3. Real-model run

**Passed** (C05 session 2, 2026-09-27, QUESTIONS #78). Two runs, both passed. The test is `pnpm test:agent-real` (developer machines only, never in CI; ADR-M29 §2.9).

| Item | Value |
|---|---|
| Model | `gpt-oss:20b` (Apache-2.0), Ollama 0.34.4 on the developer's Mac (Apple M4 Pro, 24 GB unified memory), local tag, MXFP4, 100 % on the GPU. LiteLLM alias `gpt-oss-20b` (`ollama_chat/`), `reasoning_effort: low`, `num_ctx` 32768, `provider_type: self_hosted` |
| Path | Agent Server 1.48.0 in a node24 sandbox → LiteLLM (pinned image, own database) with a per-run virtual key from the Cost Controller (seven labels) → Ollama at `host.docker.internal:11434`. The sandbox reaches only LiteLLM |
| Cap | Virtual key budget `min(budget.default_run_usd, 1.00)` = USD 1.00. Internal cost of the model: [Proposal] USD 0.10 / 0.40 per million input / output tokens |
| Data sent | Fixture workspace only: a README, an AGENTS.md and a two-line spec. No client data |
| Pass criteria | Run `succeeded` (agent `finished`); `hello.txt` reported as added; spend at or below the cap; calls in `cost_records` with the model name; the key refused after `endRun` |

| Measure | Run 1 | Run 2 |
|---|---|---|
| Result | Passed | Passed |
| Time, agent start to end of run | 110 s | 89 s |
| Agent steps / model calls | 3 / 3 | 3 / 3 |
| Tokens in / out | 17 896 / 156 | 17 870 / 158 |
| Cost (internal) | USD 0.001852 | USD 0.001850 |
| Changed files | `hello.txt` (added) | `hello.txt` (added) |
| Ollama memory (resident, all processes) | 12 552 MiB | 12 569 MiB |
| Sandbox peak memory | 518 MiB | 506 MiB |
| LiteLLM peak memory | 700 MiB | 544 MiB |
| Lowest free system memory | 10 % | 8 % |

- **Memory is tight on 24 GB** but was enough. The development stack (profiles `core` and `platform`, about 1 GiB in Docker) kept running during both runs; stopping it would save little, because Ollama (12.5 GiB) and the Docker Desktop VM (7.7 GiB) take most of the memory. Close other large applications before a run.
- About 6 000 input tokens per call: the OpenHands system prompt and the tool definitions. The first call takes longest, while Ollama reads the long prompt.
- `reasoning_effort: low` keeps the output short (156 tokens for the whole task). It is set at the gateway, not in the adapter (ADR-M29 §2.9).
- The runs check the path and the tool use, not the quality of a larger task. The quality of a small local model on real tasks is not measured here.

## 4. Limitations and findings for later tasks

### 4.1. C05 (OpenHands adapter)

1. **Send `autotitle: false`.** By default OpenHands makes one extra model call per conversation to write a title (measured: 3 calls instead of 2 for a two-step task).
2. **OpenHands' stuck detector has fixed thresholds** (4 repeats; not configurable over REST). The platform must run its own check with the config limit (FR-35). With the handbook default (3) both trigger on the 4th identical call. With a 250 ms poll the platform interrupted after 4 identical calls; with a 500 ms poll and a fast model it overshot to 5. C11 should read events over the WebSocket (`/sockets/events/{id}`) or poll faster. Compare tool calls by canonical arguments (string or object), as the spike's `loop-detector.ts` does.
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
- The spike uses the Docker CLI through `execFile` with argument arrays (no shell). Container names come from `randomUUID()`. When run IDs come from the Run Manager, C04 must still validate names before passing them to Docker.
- The relay is a PoC shortcut. In C04 the runner joins the sandbox network itself, so no container bridges the two networks.

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
| 0.2 | 2026-09-27 | Claude (task C05, session 2), approved by Harry | §2: the condition is one real run with a local Ollama model (QUESTIONS #78); §3: two runs with `gpt-oss:20b` passed, numbers recorded; API-model run before M-E (QUESTIONS #81) |
