# ADR-M68. A second, open-source coding agent (Aider, OpenCode): result of the X01 spike

| Item | Value |
|---|---|
| Status | **Accepted** (repository owner, 2026-10-22: OpenCode, and the answers to QUESTIONS #521–#524) |
| Date | 2026-10-22 |
| Decided by | Harry (plan approved 2026-10-21, with the OpenHands baseline through `pnpm eval`) |
| Related | D-08 tasks X01, X03; D-02 NFR-04, NFR-05, FR-31, FR-32, FR-35, FR-36, FR-50; D-03 §7.2, §9; D-05 §6.1 (`agents`); ADR-M10, ADR-M25, ADR-M29, ADR-M31, ADR-M42 §2.7, ADR-M69, ADR-M78; design/QUESTIONS.md #361, #519, #521–#524 |
| Spike code | `platform/spikes/agent2/` (may be thrown away; numbers in `results/`) |

## 1. Context

The platform drives one agent, OpenHands, through `AgentAdapter` (`platform/packages/contracts/src/agent.ts`, ADR-M29). QUESTIONS #361 (Harry, 2026-10-10): an open-source agent comes second, to prove that the interface is vendor-neutral; Claude Code comes later. X01 compares two candidates, **Aider** and **OpenCode**, before task X03 builds the second adapter and the agent register's `adapter` column.

The spike answers four questions (D-08 X01):

1. Can each agent run in the `node24` sandbox under the platform's rules: the model only through LiteLLM with the run's virtual key, no other egress, no Git push, an iteration cap, a time cap, a stop on request, and the counts for loop detection (`events`, `identicalCalls`)? (AC1)
2. How do they compare with the same model on pilot tasks: result, time, tokens, how they report progress and how they stop? (AC2)
3. What do their licences and supply chain look like (NFR-04)? (AC3)
4. How does each map onto `AgentAdapter`, what does the agent register need, and what is missing? (AC4)

## 2. Method

- **Versions** (pinned; each at least two weeks old when the spike started): Aider **0.86.2** (PyPI `aider-chat`, Apache-2.0), OpenCode **1.18.35** (npm `opencode-linux-<arch>`, MIT). OpenHands Agent Server 1.48.0 is the baseline (ADR-M10).
- **Images**: both are built FROM the `node24` sandbox image by digest (`platform/spikes/agent2/build.sh`).
  - Aider: a pinned CPython 3.12.13 installed by uv (Aider needs Python < 3.13; the base has 3.13), Aider in its own venv: 108 packages resolved at build time with a fixed cut-off date (`--exclude-newer 2026-10-07`) and hashes, installed with `--require-hashes --no-deps`. The lock is not committed, because the repository's Trivy scan blocks on the CRITICAL findings Aider pins (§3.3). Aider is a command-line tool with no server, and the runner's Docker client has no `exec` (ADR-M25 §2.5). So the spike adds `supervisor.mjs`: a small Node.js HTTP server on port 8000 that starts, watches and stops Aider, with the run's `SESSION_API_KEY`.
  - OpenCode: the npm platform binary, checked against the registry's sha512 integrity; Debian's `ripgrep` (OpenCode downloads one at run time when none is on `PATH`); `entry.sh` starts `opencode serve` on port 8000 with the run's `SESSION_API_KEY` as the server password.
- **The platform's own code drives both.** The spike calls `startAgentRun` → `createSandbox` (the guard, the run's internal network, egress `litellm` and `npm-proxy` only, read-only root, user 10001, no capabilities), then `driveAgent` (caps, interrupt, loop watch, commit, the changes step with the hardened diff outside the sandbox), with a spike `AgentAdapter` for each agent. The model key is a Cost Controller virtual key with the seven labels and a USD 1.00 cap. Nothing in `platform/apps`, `platform/packages` or `platform/eval` changes.
- **Model**: `gpt-oss-20b` (local Ollama `gpt-oss:20b`, `reasoning_effort: low`, context 32 768) behind a throw-away LiteLLM, the same entry as `pnpm eval` (ADR-M78). No secret.
- **Tasks**: two tasks of the evaluation task set v1 (ADR-M78 §2.3), both in `apps/api` of the pilot repository: `feat-sku-rule` (shape of T02) and `bug-order-number` (a seeded bug). Two runs per agent and task, scored like `pnpm eval` (hidden tests in an isolated container). OpenHands numbers come from `pnpm eval --configurations gpt-oss-20b --tasks feat-sku-rule,bug-order-number --n 2`.
- **Caps** for the comparison: 30 iterations, 20 minutes (the eval configuration `local.yaml`).
- **Machine**: the owner's developer Mac (Apple M4 Pro, 24 GB), one run at a time.
- **Limit**: 2 tasks × 2 runs is far too small for a statistical claim (ADR-M83 needs McNemar and intervals). The numbers show behaviour and order of size, not a ranking.

## 3. Results

### 3.1. AC1: running under the platform's rules

The egress and environment probe ran inside each sandbox with the agent's own shell (`results/checks.json`).

| Check | Aider | OpenCode |
|---|---|---|
| LiteLLM and the package proxy reachable | yes | yes |
| GitHub, api.github.com, 1.1.1.1, the Ollama host, registry.npmjs.org, pypi.org, huggingface.co, the tiktoken host, opencode.ai, models.dev, PostHog | blocked | blocked |
| External DNS | blocked | blocked |
| `git push` to GitHub | blocked | blocked |
| The agent API without the session key | 401 | 401 |
| `SESSION_API_KEY`, `OH_SECRET_KEY` in the agent's shell | absent | absent |
| Server password in the agent's shell | — (none) | **visible** (`OPENCODE_SERVER_PASSWORD`) |
| Model key in the agent's shell | **visible to the commands Aider runs** (`OPENAI_API_KEY` is inherited by `--test-cmd` and `/run`) | absent |
| Model key in a file | no | **yes**: `PUT /auth` stores it in `~/.local/share/opencode/auth.json` (home tmpfs, readable by the agent's shell) |
| Iteration cap | the supervisor stops Aider at the cap (Aider has none of its own): `max_iterations` → `stopped_budget` | OpenCode's own `steps`, set through `PATCH /global/config`: it stopped at 2 of 2 → `max_iterations` → `stopped_budget`. Set through `PATCH /config` the cap did **not** hold (12 steps for a cap of 2), because that call writes a file OpenCode does not read (below). The spike adapter also aborts at the cap as a backstop; it was not needed after the fix |
| Time cap (`max_duration_min` = 1) | not reached: Aider finished every run in under a minute; the stop on request below uses the same path | interrupt at the cap, the agent stopped within 2 s, outputs collected (`agent_stopped`, `method: interrupt`; first check run on 2026-10-21; the raw file was lost when the temporary folder was cleared, the later runs finished before the cap) |
| Stop on request (after 8 s) | SIGINT; stopped within 1 s | `abort`; stopped within 1 s |
| Loop counts | `events` = model requests and replies; `identicalCalls` = identical replies at the end (SHA-256), as Aider makes no tool calls | `events` = message parts; `identicalCalls` from `tool` parts (tool name + SHA-256 of the canonical arguments, the same key as OpenHands) |
| Commit and diff (ADR-M29 §2.5 commands) | through the supervisor's `/bash` | through `POST /session/:id/shell`, which evaluates the command once more: `$…` expands too early. The spike sends the script base64-encoded to its own `sh` |
| Writes in the repository that are not the task | `.aider.tags.cache.v4/` (the repository map cache): one file outside the plan; the supervisor removes it after the run | `PATCH /config` writes `config.json` at the repository root: one file outside the plan in every run (`results/compare-opencode-before-fix.json`). `PATCH /global/config` writes to the home tmpfs instead |
| Extra model calls | none | a title for each session (OpenCode's `title` agent) uses the run's model: model calls > steps |

**Result:** both agents can run inside the platform's sandbox and egress rules. No candidate reached a host other than LiteLLM and the package proxy, and none could push. Each needed work around it; §6 lists it.

### 3.2. AC2: two pilot tasks with the same model

Model `gpt-oss-20b` for all three; caps 30 iterations and 20 minutes; 2 runs per agent and task (`results/compare.json`). *Resolved* = the hidden tests pass and nothing else breaks (ADR-M78). Means per run.

| Agent | Task | Resolved | Outcome | Time (s) | Steps | Model calls | Input tokens | Output tokens | Files outside the plan |
|---|---|---|---|---|---|---|---|---|---|
| OpenHands 1.48.0 | `feat-sku-rule` | 2 / 2 | finished, finished | 140 | 9 | 10 | 78 574 | 940 | 0 |
| OpenHands 1.48.0 | `bug-order-number` | 0 / 2 | loop detected, finished | 85 | 12 | 12 | 112 488 | 1 417 | 0 |
| OpenCode 1.18.35 | `feat-sku-rule` | 2 / 2 | finished, finished | 33 | 6 | 5 | 21 974 | 428 | 0 |
| OpenCode 1.18.35 | `bug-order-number` | 2 / 2 | finished, finished | 30 | 8 | 7 | 39 827 | 512 | 0 |
| Aider 0.86.2 | `feat-sku-rule` | 2 / 2 | finished, finished | 81 | 1 | 1 | 5 114 | 353 | 0 |
| Aider 0.86.2 | `bug-order-number` | 2 / 2 | finished, finished | 55 | 1 | 1 | 6 005 | 219 | 0 |

- The repository's checks (`ci`) failed on `feat-sku-rule` for **all three** agents and passed on `bug-order-number` for all three: a property of the task, not of an agent.
- **Aider's numbers are not a like-for-like comparison.** The adapter gives Aider the plan's files and the spec directly; Aider makes one edit in one model reply and runs the project's tests (`--test-cmd`). OpenHands and OpenCode read the repository, choose the files and run the checks themselves. On a task whose plan does not name every file, Aider cannot find the others.
- OpenCode's first four runs (before the fix of `PATCH /config`) also resolved 3 of 4, each with `config.json` outside the plan (`results/compare-opencode-before-fix.json`).
- Model calls (from `cost_records`) can be fewer than steps for OpenCode, because the spend of the last calls may arrive after the sync; and more than steps when OpenCode writes a session title.
- 2 runs per task: no difference here is significant (ADR-M83 §2).

How they report progress and stop:

| | OpenHands 1.48.0 | OpenCode 1.18.35 | Aider 0.86.2 (with the supervisor) |
|---|---|---|---|
| Server | Agent Server (REST, WebSocket) | `opencode serve` (REST, SSE `/event`, OpenAPI at `/doc`) | none; a supervisor written for the platform |
| Unit of progress | `ActionEvent` (one tool call) | `step-finish` part (one model reply), `tool` parts | one model reply (LLM history file) |
| Finished | `finish` tool → status `finished` | session `idle` with no error after the last reply | process exit 0 |
| Own iteration cap | `max_iterations` (`MaxIterationsReached`) | `steps` per agent (through the global configuration) | none |
| Own stuck detector | yes | no | no (`--auto-test` retries at most 3 times) |
| Stop | interrupt (ADR-M29 §2.4) | `POST /session/:id/abort` | SIGINT (supervisor) |
| Explores the repository and runs commands | yes (terminal tool) | yes (`bash`, `read`, `grep`, `glob`, …) | no: edits only the files put in its chat; runs only `--test-cmd` |

### 3.3. AC3: licences and supply chain (NFR-04)

Trivy 0.74.0 (the CI's version), HIGH and CRITICAL, with `platform/sandbox-images/.trivyignore` (`results/trivy.json`, counted against `node24`):

| | OpenCode image | Aider image |
|---|---|---|
| Size (`node24` = 3.05 GB) | 3.31 GB (+0.26 GB: one 185 MB binary, ripgrep) | 3.88 GB (+0.83 GB: CPython 3.12, 108 Python packages) |
| Vulnerabilities added | **0** | **66** (6 CRITICAL, 60 HIGH), all in Python packages with a fixed version: `litellm` 1.81.10 (3 CRITICAL), `pillow` 12.1.1 (1 CRITICAL), `anyio` (1 CRITICAL), `GitPython` (1 CRITICAL), and `aiohttp`, `urllib3`, `starlette`, `fsspec`, `soupsieve` |
| Can they be fixed? | — | Not without Aider: `aider-chat` 0.86.2 pins every dependency to an exact version (`litellm==1.81.10`, …). A CRITICAL finding blocks the CI job `sandbox-image` |
| Licence categories added (Trivy) | none | none (the copyleft packages Trivy reports are the same Debian packages as in `node24`) |
| The agent's own licence | MIT (`anomalyco/opencode`, formerly `sst/opencode`); the npm platform packages carry no licence field | Apache-2.0 (`Aider-AI/aider`) |
| Dependencies | One Bun-compiled binary: **Trivy cannot see the packages inside** (no SBOM). The 98 direct dependencies of `packages/opencode` at tag `v1.18.35`: 49 MIT, 33 Apache-2.0, 2 BSD-3-Clause, 2 ISC, 2 BlueOak-1.0.0 (`glob`, `minimatch`), 1 without a licence field (`@openauthjs/openauth`, MIT in its repository), 9 workspace packages | 108 Python packages, hash-locked: permissive, except MPL-2.0 (weak copyleft, file-level) in `certifi`, `orjson`, `pathspec`, `tqdm`. Analytics clients (`posthog`, `mixpanel`) are installed and turned off |
| Downloads at run time | none with the image's settings (models list, LSP servers, ripgrep, auto-update, sharing, default plugins off; all blocked by the sandbox anyway) | none with the image's settings (analytics, update check, Hugging Face, LiteLLM's cost map off) |
| Maintenance (2026-10-22) | active: releases every few days (1.18.32 → 1.19.3 in four weeks), last push 2026-10-21 | slow: last release 0.86.2 on 2026-02-12, last commit 2026-05-22 |

No candidate brings a licence in the CRITICAL category (AGPL, SSPL, commercial; ADR-M10 §2.1).

### 3.4. MCP support (for X02 and X04, QUESTIONS #519)

| Agent | MCP | Per-run server over HTTP with a header key |
|---|---|---|
| OpenCode 1.18.35 | Yes. Configuration `mcp.<name>` and the API `POST /mcp` (`name`, `config`); remote servers (`type: remote`, `url`, `headers`, `oauth: false`, `timeout`) and local ones (`type: local`, a command) | **Yes, from the API description** (`McpRemoteConfig` has `headers`; `oauth: false` turns off OAuth detection). Not exercised in the spike: no MCP tool exists yet. X04 confirms it live |
| Aider 0.86.2 | No (no MCP code in the package, no option) | No |

A remote MCP server fits ADR-M69 (one container per tool and run on the run's network). X03 sets it through `PATCH /global/config` or `POST /mcp` at `startRun`, never from the agent's side; gap 1 (§6) applies, because the agent could add an MCP server of its own through the same API.

## 4. `AgentAdapter` mapping (AC4)

| Method | OpenHands (ADR-M29) | OpenCode | Aider |
|---|---|---|---|
| `startRun` | `POST /api/conversations` with `llm` (key in the body), tools, `max_iterations`, the task message | `PUT /auth/<provider>` (the virtual key), `PATCH /global/config` (provider URL, model, `steps`; never `PATCH /config`, which writes into the repository), `POST /instance/dispose`, `POST /session`, `POST /session/:id/prompt_async` with the model, the agent and a tool map (only the contract's tools) | supervisor `POST /run` (model, URL, key, cap, the task message as a file, the plan's files with `--file`, `AGENTS.md` and the spec with `--read`, the project's check command with `--test-cmd`) |
| `getStatus` | execution status + the event log | `GET /session/status` + `GET /session/:id/message` | supervisor `GET /status` |
| `stop` | interrupt | `abort` | SIGINT, SIGKILL after 10 s |
| `commitWork` | ADR-M29 git command through `/api/bash/execute_bash_command` | the same command through `POST /session/:id/shell` (base64) | the same command through supervisor `/bash` |
| `collectOutputs` | git diff command + the event log | the same diff command + the message parts | the same diff command + one entry per model reply (hash only) |
| Tools | `file_editor`, `task_tracker`, `terminal` | `file_editor` → `read`, `edit`, `write`, `patch`, `multiedit`, `glob`, `grep`, `list`, `apply_patch`; `terminal` → `bash`; `task_tracker` → `todowrite`, `todoread`; everything else (`webfetch`, `task`, `skill`, …) off | no tools; `terminal` cannot be granted |
| Task message | `buildTaskMessage` | `buildTaskMessage` with its own last rule ("reply with a short summary") | `buildTaskMessage` with its own last rule |

What stays the same for every agent: the task message (except its last rule), the git commands, the loop key, the runner's driver, the sandbox and the guard. `AgentAdapter` itself needed **no change** for either candidate.

## 5. Decision (QUESTIONS #521)

**OpenCode becomes the second adapter in X03** (repository owner, 2026-10-22; QUESTIONS #521). Reasons:

1. **It fits `AgentAdapter` without code of our own in the sandbox.** `opencode serve` is an HTTP server with sessions, status, abort, a shell and an OpenAPI description, like the Agent Server. Aider needs a supervisor that the platform would write, harden and keep.
2. **It is an agent of the same kind as OpenHands**: it reads the repository, picks files, runs the project's checks from `AGENTS.md`, and has its own step cap. This proves the interface for a second autonomous agent, which is the point of QUESTIONS #361. Aider is an editor of given files: it cannot be granted `terminal`.
3. **Supply chain**: no finding added over `node24`; Aider adds 6 CRITICAL findings that cannot be fixed without a new Aider release, and Aider's releases have slowed.
4. **Results on the two tasks**: 4 of 4 resolved, the fastest and with about a third of OpenHands' input tokens. On two tasks this shows behaviour only, not a ranking.

Conditions for X03 (the gaps in §6), as decided on 2026-10-22:

- **Image per adapter** (QUESTIONS #522, option a): project configuration `sandbox.images.<adapter>`, each by digest; the runner checks the image's `sdlc.agent.adapter` label against the agent's `adapter`.
- **Gaps 1 and 2** (QUESTIONS #523): in X03, the adapter enforces the caps itself and checks the configuration again on every status call, and fails the run on a change; the key file on the home tmpfs is accepted. Before OpenCode is used for real client work: an authenticating proxy in the image holds the server password, and OpenCode listens on 127.0.0.1 only.
- **Supply chain** (QUESTIONS #524, option a): the npm binary pinned by sha512 integrity, and a CI check of the licences of the dependency tree at the same Git tag; a build from source only if a client asks for an SBOM.

Aider is **not chosen**. Its one-reply edits were cheap and correct on small, well-scoped tasks. If a narrow "edit the planned files only" agent is wanted later, it comes back as its own task, with a supervisor and a dependency policy.

## 6. What X03 must solve (gaps)

For OpenCode, as found by the spike:

| # | Gap | What X03 does (proposal) |
|---|---|---|
| Gap 1 | The server password is in OpenCode's environment, so the agent's `bash` tool can read it and call its own server: change its global configuration (steps, tools, permissions), add an MCP server, start a PTY. The sandbox has no way out, so it cannot reach anything new, but an agent must never change its own permissions or limits (codes table §2.1) | The runner never trusts the agent's own limits: the adapter enforces the iteration cap from the run's step count (the spike's backstop) and re-reads the global configuration on each status call, failing the run on any change (`agent_config_changed`). A better fix (an authenticating proxy in the image that holds the password, with OpenCode bound to 127.0.0.1) is QUESTIONS #523 |
| Gap 2 | `PUT /auth` writes the run's virtual key to `~/.local/share/opencode/auth.json` (home tmpfs) | Accept: the key is per run, capped, revoked by `endRun`, and the sandbox reaches only LiteLLM (the same reach the agent has anyway). The tmpfs goes with the sandbox. Recorded in the threat model (ADR-M80) — QUESTIONS #523 |
| Gap 3 | `PATCH /config` writes `config.json` into the repository | Only `PATCH /global/config`; a test that the workspace has no new file after `startRun` |
| Gap 4 | `POST /session/:id/shell` evaluates the command once more | The git commands travel base64-encoded to their own `sh` (the spike's `wrapped`); a test with `$`, quotes and new lines |
| Gap 5 | A session title costs a model call with the run's model | Switch the title off in the global configuration if the version allows it, else count it (it is in `cost_records` with the run's labels) |
| Gap 6 | The binary is opaque to Trivy (no SBOM) | QUESTIONS #524: check the npm dependency tree of the pinned tag (licences) and pin the binary by integrity, or build OpenCode from source at the tag in the release pipeline (ADR-M66) |
| Gap 7 | Releases every few days | Pin one version (at least two weeks old) by integrity and image digest; an upgrade is a new agent version with an evaluation (ADR-M86) |
| Gap 8 | Image per adapter | The project needs an image for each adapter it runs (QUESTIONS #522); the image's labels name the adapter and its version (§7) |
| Gap 9 | Its own tools differ from the platform's three | A fixed mapping in the adapter (§4); all other tools off in every prompt; an unknown tool ID in a new version fails closed |
| Gap 10 | Progress is per model reply, not per tool call | `iterations` = `step-finish` parts; `events` and `identicalCalls` from the message parts, with the same loop key as OpenHands (`canonicalArguments`). C11's thresholds apply unchanged |

Common to any second agent:

- The OpenHands-specific last line of `buildTaskMessage` ("call the finish tool") becomes a parameter of the adapter.
- `driveAgent` maps a `stopped` state it did not ask for to `agent_error`, as for OpenHands; unchanged.
- `pnpm test:agent`'s scripted stub model works for OpenCode too (OpenAI-compatible); X03 adds a live test like `agent-live.test.ts` for the new adapter.

## 7. The agent register (AC4)

The register (ADR-M31, D-05 §6.1) names the model, the instructions and the tools of an agent, but not which adapter runs it: every agent is OpenHands today. X03 adds:

- **`agents.adapter`**: a code (`openhands`, `opencode`), `NOT NULL`, default `openhands` for existing rows (a migration). Part of an agent's configuration: changing it is a new agent version (handbook Ch.20 §20.9), and it belongs in the evaluation fingerprint (ADR-M86 §2.1) next to the model, the instructions and the tools.
- **The agent's version is pinned through the image**, not a new column: the sandbox image is pinned by digest, and the image carries labels `sdlc.agent.adapter` and `sdlc.agent.version`. Before a run the runner checks that the image's adapter label equals the agent's `adapter` (refusal `adapter_mismatch`), and the check before a run (ADR-M31 §2.6) refuses an adapter the runner does not have (`adapter_unavailable`).
- **Which image a run uses**: today one `sandbox.image` per project. With two adapters a project needs one image per adapter (QUESTIONS #522).
- **Tool codes stay the platform's** (`file_editor`, `task_tracker`, `terminal`); each adapter maps them to its own tools in code, like `TOOL_MAP` in the spike. An adapter refuses a platform tool it cannot grant (Aider: `terminal`).
- `instructions_ref` stays: OpenCode reads `AGENTS.md` by itself; Aider gets it with `--read`.

These are proposals for X03; D-05 and ADR-M31 change in X03's own PR, after the X02 session's D-05 change is merged.

## 8. Alternatives not chosen

| Option | Why not |
|---|---|
| Drive Aider with `docker exec` | The runner's Docker client refuses `exec` on purpose (ADR-M25 §2.5): it would give the runner a way to run any command in any sandbox |
| Aider's Python API in a platform process | The platform is TypeScript (Q3); a Python process outside the sandbox would hold the workspace |
| OpenCode configuration through a sandbox environment variable (`OPENCODE_CONFIG_CONTENT`) | The guard allows no new sandbox environment variable (R061); the API sets the configuration per run |
| Claude Code | After X03, as QUESTIONS #361 says (its licence and the gateway are checked first) |

## Version history

| Version | Date | Author | Notes |
|---|---|---|---|
| 0.1 | 2026-10-22 | Claude (task X01) | First version: the spike's results and a proposal for Harry |
| 0.2 | 2026-10-22 | Claude (docs) | Accepted by the repository owner: OpenCode; answers to QUESTIONS #521–#524 in §5 |
