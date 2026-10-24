# ADR-M29. OpenHands adapter: driving the agent in the sandbox

| Item | Value |
|---|---|
| Status | **Accepted** (Harry, 2026-10-16; built by task C05) |
| Date | 2026-09-27 |
| Decided by | Harry (C05 plan approved 2026-09-27, with conditions; QUESTIONS #13, #78–#80) |
| Related | D-02 FR-11, FR-30…FR-33, FR-35, FR-50; D-03 sections 7.2, 8, 9; D-05 section 6.4; D-07 sections 3, 4, 6, 7; D-08 tasks C05, C06, C07, C08, C11, X11; ADR-M04, ADR-M10, ADR-M22, ADR-M24, ADR-M25 |

## 1. Context

C04 (ADR-M25) provisions one hardened sandbox per run from the project image; the image runs the OpenHands Agent Server 1.48.0 (ADR-M10). C05 adds the adapter that drives the agent (D-03 §7.2) and the runner code around it:

- pass the spec, the plan and AGENTS.md to the agent (AC2);
- enforce the iteration cap and the time cap, and record why a run stopped (AC3);
- collect the changed files, the log and the last commit (AC4).

C05 has two sessions. Session 1 (this ADR, first version) runs everything with a scripted stub model. Session 2 is the real-model run (QUESTIONS #78: a local Ollama model on a developer machine) and the D-02, D-07 and ADR-M10 wording changes.

All Agent Server behaviour below was checked on the pinned image (node24 built on `ghcr.io/openhands/agent-server:1.48.0-python-slim@sha256:8fcfab2d…`) by the live test `pnpm test:agent`.

## 2. Decision

### 2.1. Interface and packages

- `AgentAdapter` in `@sdlc/contracts` (`agent.ts`); `OpenHandsAdapter` in `@sdlc/adapter-agent-openhands` (imports `@sdlc/contracts` only). The runner uses the interface; `main.ts` wires the OpenHands adapter.
- Same responsibilities as D-03 §7.2. Differences:
  - `startRun(input)` takes the contract, the endpoint (URL and per-run session key), the model access (model name, LiteLLM URL, virtual key) and the task.
  - `getStatus` returns an agent state (`running`, `finished`, `max_iterations`, `stopped`, `error`, `stuck`) and the step count, not a `run_status`: the runner decides the run status.
  - `stop` interrupts (cancels the model call in flight).
  - New `commitWork` (QUESTIONS #80, §2.5). `collectOutputs(handle, baseSha)` returns the files changed since `base_sha`.
- Errors are `AgentError` codes; the runner renders them from the catalog (`agent.error.*`), like `GitHostError` (ADR-M23). Errors never carry text from the Agent Server.

### 2.2. What the conversation gets

| Field | Value | Why |
|---|---|---|
| `agent.llm` | `litellm_proxy/<model>`, `base_url` LiteLLM as the sandbox sees it (`http://litellm:4000`), `api_key` the run's virtual key | FR-50. The key travels in the API body only, never as a sandbox environment variable (ADR-M25 §2.4) |
| Model | Chosen by the caller; must be in the contract's `allowed_models`, else `model_not_allowed` | D-07 §4, QUESTIONS #79 |
| `agent.tools` | The contract's `allowed_tools`; each must be `file_editor`, `task_tracker` or `terminal`, else `tool_not_allowed` | ADR-M10 §4.1 item 4 |
| `agent.agent_context` | `load_project_skills: true`; `load_user_skills`, `load_public_skills`, `load_memory: false` | AGENTS.md (and `.openhands/skills/`) come from the workspace. Public skills would be fetched from GitHub, which the sandbox cannot and must not reach |
| `max_iterations` | The contract's `max_iterations` | FR-32, native cap |
| `stuck_detection` | `true` | OpenHands' own detector (fixed thresholds). The platform's loop check with `loop_threshold` comes in C11 |
| `autotitle` | `false` | One model call fewer (ADR-M10 §4.1 item 1) |
| `observability_metadata` | Run, intent, tenant and agent IDs | No client data |
| `initial_message` | Built by `buildTaskMessage` | AC2, below |

The first user message names the spec file with its commit and SHA-256, gives the plan summary and every planned file or pattern, asks the agent to follow AGENTS.md, and states the rules: stay on `agent/INT-…`, never push or change Git remotes or configuration, install from the lockfile, call `finish` when done. It points at the spec instead of copying it: the agent reads it from the workspace, which the runner cloned at `base_sha`. This text is for the model, not a user-facing message, so it is not in the message catalog (NFR-08 covers user-facing messages). It never goes into `run_events` or the audit log.

The runner loads the task from the database (`loadAgentTask`): the contract's plan (same ID, same `plan_sha256`, same file list) and the intent's latest spec. A missing or different plan or spec refuses the run (`task_unavailable`).

### 2.3. How the runner reaches the Agent Server (Harry's conditions)

- The sandbox publishes no port and sits on its own internal network (ADR-M25 §2.2). The runner **joins the run's network with its own container** (`SDLC_RUNNER_SELF_CONTAINER`, no alias) and calls `http://sdlc-sandbox-<run_id>:8000`.
- The guard `assertSafeNetworkConnect` lets only a run network be joined, and only by the configured containers: the egress services (C04) and the runner itself. Everything else stays off the sandbox's network.
- **Session key:** the sandbox gets a random per-run `SESSION_API_KEY` (C04); only the runner holds it (in memory, redacted). Every Agent Server call carries it. LiteLLM, the package proxy or anything else on the run's network cannot call the API: the live test calls it from LiteLLM's container without the key and with a wrong key, and gets HTTP 401 both times. The health endpoints (`/alive`, `/health`, `/ready`, `/server_info`) need no key; they return no conversation data.
- **The runner listens on no port**, so joining the network gives the sandbox nothing to reach: a static test checks the runner sources (no server, no listening socket), and the Compose live test checks the running container (`/proc/net/tcp{,6}` has no LISTEN entry).
- **The runner leaves at clean-up:** `teardownSandbox` now detaches every container still on the run's network (the egress services and the runner), then removes the network. Checked in the stub-Docker tests and in the live test.
- The live test on the host cannot join a Docker network, so a small relay container stands in for the runner's container (the runner code attaches it). In Compose there is no relay.

### 2.4. Caps and how a run ends (AC3)

`driveAgent` (runner) polls the agent every `SDLC_RUNNER_AGENT_POLL_MS`:

| The agent… | Outcome | Run status | `stop_reason` |
|---|---|---|---|
| calls `finish` | `finished` | `succeeded` | — |
| reaches `max_iterations` (native cap) | `max_iterations` | `stopped_budget` | `max_iterations` |
| is still running at `max_duration_min` | `max_duration` | `stopped_timeout` | `max_duration` |
| is stopped by its own stuck detector | `stuck` | `stopped_stalled` | `agent_stuck` |
| reports another error | `agent_error` | `failed` | `agent_error` |
| cannot be started or reached; the task, LiteLLM or the commit fails | `failed` | `failed` | `agent_<code>` |

- **Time cap: interrupt, then kill.** At `max_duration_min` the runner interrupts the agent and waits up to `SDLC_RUNNER_AGENT_STOP_GRACE_SECONDS`. If the agent stops, the runner still collects the outputs (`agent_stopped {method: interrupt}`). If not, it does not wait: the sandbox is removed right after (`method: kill`, no outputs).
- **Iteration cap:** Agent Server 1.48.0 writes a `ConversationErrorEvent` with code `MaxIterationsReached`, then sets the status `error` (found in the live test). The adapter reports that as `max_iterations`. Backstop: a stop without a reason at or above the cap also counts as `max_iterations`.
- `stopped_budget` for the iteration cap: D-05 has no dedicated status, and D-07 §6 counts the iteration cap as part of a run's budget. Accepted for the MVP (QUESTIONS #82): C07 tells a cost cap from an iteration cap by `stop_reason`; both need a human decision to resume (QUESTIONS #21).
- **Kill switch race:** the run leaves `running` only with one conditional update. If the kill switch (C11) or the sweep moved it first, the driver changes nothing, and a run that is not `running` is not started at all.
- **Found in the live test:** the `kind` filter of `/events/search` and `/events/count` matches nothing in 1.48.0. The adapter therefore reads the whole paged log and filters it locally (steps = `ActionEvent`, one per tool call). This is cheap for MVP run lengths; C11 may move to the WebSocket (ADR-M10 §4.1 item 2).
- The caps come from the Run Contract; their defaults from configuration (§3).

### 2.5. Commit and outputs (AC4, QUESTIONS #80)

- When the agent finished, the runner commits what the agent left, through the Agent Server's bash endpoint (`/api/bash/execute_bash_command`) in `/workspace`:
  - only on the run's branch: if `HEAD` is not on `agent/INT-…` any more, nothing is committed and the run fails (`agent_branch_changed`);
  - `git add -A`, then a commit only when something is staged; no hooks (`core.hooksPath=/dev/null`, `--no-verify`), no signing, no pager;
  - fixed author and committer `sdlc-agent <agent-<agent_id>@agents.sdlc.invalid>`: it identifies the agent, so G7 counts the agent as a producer (FR-11). The person who started the run still counts as a producer. Commit message `sdlc: agent run <run_id>`;
  - if the agent already committed, only what is left is committed; `head_sha` is the final `HEAD`.
- Every value put into a command is checked against a strict pattern and single-quoted. Answers are read from marker lines (`sdlc:…`) only; a missing marker fails closed.
- Git runs as `/usr/bin/git` with no system or global configuration (`GIT_CONFIG_NOSYSTEM`, `GIT_CONFIG_GLOBAL=/dev/null`), no replace refs (`--no-replace-objects`), no fsmonitor, and none of the `GIT_*` variables that move the repository.
- **These answers are what the sandbox reports.** The agent controls everything inside the sandbox (files, `.git`, its shell), so it could make them lie. They are good enough to record the run and to choose what to push; G5 (C07) and the push (C08) must recompute the changed files and `head_sha` from the pushed branch outside the sandbox (the runner's clone or the Git host) before any gate relies on them (D-08 1.7 notes on C07 and C08).
- `collectOutputs` lists the files changed between `base_sha` and `HEAD` (`git diff --no-renames --name-status`: a rename is a delete and an add, so G5 sees both paths; Git's C-quoted paths are unquoted), the final `HEAD`, the step count and the whole log.
- **Only a finished agent's leftovers are committed.** After the iteration or time cap, a stuck agent or an error, the runner does not commit: `changed_files` then counts only what the agent committed itself (between `base_sha` and `HEAD`). Such runs do not reach G6; C07 decides whether uncommitted work of a stopped run is kept as evidence (from the code review).
- **Where outputs go:** changed paths and the log are client data. They are returned to the caller only; storing them is E02 (evidence) and G5 (C07). The database gets `runs.head_sha`, `runs.iterations` and coded run events.
- Note for E01: commits the agent made itself may carry any author. E01 must treat every commit on the agent branch as produced by the agent.

### 2.6. Run events (codes and counts only)

| Event | Fields |
|---|---|
| `agent_started` | `max_iterations`, `max_duration_min` |
| `agent_stopped` | `reason` (`max_duration`), `method` (`interrupt`, `kill`) |
| `agent_finished` | `outcome`, `iterations`, optional `changed_files` (count), `head_sha`, `commit` (`committed`, `nothing`) |
| `agent_failed` | `reason` (an `AgentErrorCode` or `model_unreachable`, `task_unavailable`, `runner_not_attachable`) |

The model name is not in an event: model names may hold `/` or `@`, which a code may not; `cost_records` has the model.

### 2.7. Runner settings

| Setting | Default | Notes |
|---|---|---|
| `SDLC_RUNNER_SELF_CONTAINER` | none | The runner's own container name. Required to run an agent. Compose: `<project>-sdlc-runner-1` |
| `SDLC_RUNNER_AGENT_PORT` | 8000 | Agent Server port in the sandbox |
| `SDLC_RUNNER_AGENT_LLM_URL` | `http://litellm:4000` | LiteLLM as the sandbox sees it: an egress alias with a port. Its `alias:port` must be in the contract's `egress_allowlist`, or the run fails (`agent_model_unreachable`) |
| `SDLC_RUNNER_AGENT_POLL_MS` | 1000 | 100–10000 |
| `SDLC_RUNNER_AGENT_STOP_GRACE_SECONDS` | 30 | 1–600. Interrupt → kill at the time cap |

These are technical settings, not handbook rules.

### 2.8. `Runner.runAgent`

`Runner.runAgent(request)` drives the agent of a provisioned run, then removes the sandbox (`sandbox_removed {reason: finished | failed}`) and frees the slot, whatever happened. The run's virtual key is the caller's to create and revoke (`CostController.issueRunKey`, `endRun`). The Temporal activity that calls it comes in C06 (QUESTIONS #53, #55).

### 2.9. The real-model run (session 2, QUESTIONS #78)

- The ADR-M10 condition is met with a **local Ollama model on a developer machine**: `gpt-oss:20b` (Apache-2.0), local tag only, never an Ollama `:cloud` model. Results: ADR-M10 §3.
- **LiteLLM entry** in `config.ctmpl` (and the test template): `gpt-oss-20b` → `ollama_chat/gpt-oss:20b`, `api_base` from OpenBao `kv/litellm/providers/ollama` (field `api_base`, not a secret; the entry exists only on developer machines), `provider_type: self_hosted`, an internal cost above 0 ([Proposal] USD 0.10 / 0.40 per million input / output tokens, until a GPU cost per token is known; D-07 §3).
- `reasoning_effort: low` and `num_ctx: 32768` are set in the entry, at the gateway, so no model-specific setting enters the adapter. Checked before the run: `low` gave 27 completion tokens where `high` gave 121 for the same question; Ollama loaded the model with context 32768, 100 % on the GPU. OpenHands needs a large context; Ollama's default is too small for its system prompt.
- **Network:** Ollama runs on the machine (in Docker on macOS it has no GPU). LiteLLM reaches it at `http://host.docker.internal:11434`; the sandbox cannot (its run network has no route out, ADR-M25 §2.2). Docker Desktop reaches an Ollama bound to the host's 127.0.0.1 (checked).
- **Test:** `pnpm test:agent-real` (developer machines only, never in CI). A throw-away LiteLLM with the template's Ollama entry and its own database, the Cost Controller's virtual key (seven labels, cap `min(budget.default_run_usd, 1.00)`), a node24 sandbox, the runner driving the agent, then `endRun` (revoke, sync into `cost_records`). No secret is involved. It samples memory every 2 s (Ollama processes, sandbox, LiteLLM, free memory).

### 2.10. Context condensing (X11, QUESTIONS #395, #551–#555)

Small local models have small context windows (`num_ctx` 32768, §2.9). The model reads the whole run at every step, so a long run fills the context and fails. X11 adds context condensing, off by default.

**What the pinned Agent Server 1.48.0 offers (AC1).** Checked on the running image (its OpenAPI description) and in `pnpm test:agent`:

| Item | Finding |
|---|---|
| How it is set | One condenser per conversation, in `agent.condenser` of `POST /api/conversations`. Not set (before X11): none |
| Condensers | `LLMSummarizingCondenser`, `NoOpCondenser` (for tests), `PipelineCondenser` (a chain) |
| `LLMSummarizingCondenser` | Its own `llm` object (model, URL, key, `usage_id`); `max_size` (events in the view, default 240); `max_tokens` (optional); `keep_first` (events kept at the start, default 2); `minimum_progress` 0.1; `hard_context_reset_max_retries` 5; `hard_context_reset_context_scaling` 0.8 |
| The agent's context size | `agent.llm.max_input_tokens` |
| Events in the log | `Condensation` (`forgotten_event_ids`, `summary`, `summary_offset`, `llm_response_id`); `CondensationRequest` (no text; written when the model reports a full context); `CondensationSummaryEvent` (`summary`; not seen in the log in our runs) |
| Forced condensing | `POST /api/conversations/{id}/condense` (not used) |
| The log | Forgotten events **stay in the log**; only the model's view drops them. A later condensation also forgets the summary of the one before, as the ID `<condensation id>-summary`: that ID is in the view only, never an event of the log |
| The summary request | One user message (the condenser's prompt and the forgotten events), **no tools**, on the condenser's `llm` |
| Steps | A condensation is not a step: `max_iterations` counts tool calls only (`ActionEvent`). With condensing on, a run of 14 commands and `finish` had 15 steps and 4 condensations |
| A full context | The model's HTTP 400 with `context_length_exceeded` (as LiteLLM forwards it) makes the agent write a `CondensationRequest`, condense and go on |

**Decisions.**

- **Configuration** (`run.context_condensing`, @sdlc/config): `mode` `off` or `summarize`, `max_events` (10–1000, default 120), `keep_first` (0–50, default 2), `model_context_tokens` (the context size per model name, 4 096–2 000 000). Rule **M35**: `summarize` needs at least one context size and `keep_first` below `max_events`. The runner reads the setting from the effective configuration when the run starts, like the loop window (ADR-M42 §2.7).
- **Which runs** (QUESTIONS #554): `condensingFor` (contracts) returns `summarize` with the limits only for the OpenHands adapter and a model with a size; `context_unknown` when the model has none (the run runs without a condenser: the platform never condenses with an unknown context size); `unsupported` for OpenCode, which keeps its own behaviour. Evaluation runs never condense, so their results stay comparable.
- **The request** (AC3): `agent.condenser` is an `LLMSummarizingCondenser` whose `llm` is the agent's own `litellm_proxy/<model>`, LiteLLM URL and run virtual key, with `usage_id: condenser`. So the summary calls carry the key's seven labels, count against the run's budget and use a model in `allowed_models`, by construction. `max_size` = `max_events`, `keep_first`, and `max_tokens` = 75 % of the context size ([Proposal]: room for the system prompt, the tools and the reply). `agent.llm.max_input_tokens` = the context size. Without condensing, the body has neither field: it is the body before X11.
- **Counts, never text** (AC3, QUESTIONS #551, #552): the condenser's three event kinds are not steps and not progress for loop detection (`events` leaves them out); `identicalCalls` counts only tool calls, so a condensation between two identical calls does not hide a loop. `getStatus` adds `condensations` and `eventsForgotten` (forgotten log events, without the `-summary` IDs). The log that `collectOutputs` hands over has each summary replaced by `summary: null`, `summary_sha256` and `summary_chars`. Run events: `agent_started.condensing` (left out when off) and `agent_finished.condensations`, `agent_finished.events_forgotten` (only when on). D-05 1.60.
- **Default** (QUESTIONS #553): `off`, until Harry chooses from the numbers below.

**Numbers (AC4).** `pnpm test:agent-real`, local Ollama `gpt-oss:20b` (`reasoning_effort` low, `num_ctx` 32768), the same task without and with condensing (`max_events` 24, `keep_first` 2, context 32768):

| Run (2026-10-24, one run each) | Result | Time | Steps | Model calls | Input tokens | Output tokens | Largest call (input tokens) | Condensations (events forgotten) | Changed files | Cost (internal) |
|---|---|---|---|---|---|---|---|---|---|---|
| Without condensing | `finished` | 197 s | 24 | 25 | 172 504 | 1 044 | 7 829 | 0 | 9 of the 12 asked for | USD 0.017667 |
| With condensing | `finished` | 292 s | 34 | 40 | 238 881 | 2 841 | 6 889 | 4 (58) | 12 | USD 0.025026 |

- The short task (`hello.txt`) is unchanged: `finished`, 110 s, 3 steps, 17 862 input tokens, no condensation.
- On this task the context never filled: the largest call without condensing was 7 829 tokens of 32 768. Condensing then costs more (+60 % model calls, +38 % input tokens, +48 % time: the summaries and the steps after them), and lowers the largest call by 12 %.
- The run without condensing finished early (9 files of 12); the run with condensing did all 12. One run each, so this is not a measure of quality.
- [Proposal] for the default (QUESTIONS #553): keep `off`, and turn on `summarize` per project for small local models on long tasks, with `max_events` well above 24 (for example the default 120), so that condensing starts only when a run is really long. Harry decides in the PR.

**Tests.** `pnpm test`: `tests/agent/condensing.test.ts` (the request with and without condensing, `condensingFor`, counts, loop key through condensations, the log without summaries), `tests/config/context-condensing-config.test.ts` (rule M35, schema), `tests/run-contract/run-events.test.ts`. `pnpm test:db`: `agent-drive.test.ts` ("X11": the condenser from the configuration, `context_unknown`, no change when off, loop detection and the kill switch with condensing on). `pnpm test:agent` (`[stub:condense]`, `[stub:context]`, `[stub:condensecap]`, `[stub:condenseloop]`): condensing past `max_events` with the run key and a finished run; a stub model that answers `context_length_exceeded` past its context, and the run condenses and finishes; the iteration cap; loop detection after a condensation; no summary in run events or the handed-over log.

## 3. Rules and where they live

| Rule | Source | Where |
|---|---|---|
| Iteration cap default: 30 | FR-32, template T13, QUESTIONS #13 | Config `run.default_max_iterations` → contract `max_iterations` (the issuer, C06). Raising it warns (`config.warning.run_cap_raised`) |
| Time cap default: 60 minutes | FR-32, template T13, QUESTIONS #13 | Config `run.default_max_duration_minutes` → contract `max_duration_min`. Raising it warns |
| Loop threshold: 3 | FR-35, handbook Ch.3 §3.6 | Config `run.loop_detection.identical_tool_calls_max` → contract `loop_threshold` (unchanged). Stopping on loops is C11 |
| Run budget | D-07 §6 | Config `budget.default_run_usd` → virtual key (C03), unchanged |
| Model chosen by the platform, from `allowed_models` | D-07 §4, QUESTIONS #79 | Code (adapter). Not configurable |
| Tools granted to an agent | ADR-M10 §4.1 | Code (`AGENT_TOOLS`). Not configurable |
| No public or user skills; AGENTS.md from the workspace | ADR-M29 §2.2 | Code (request builder). Not configurable |
| Commit author names the agent | FR-11, QUESTIONS #80 | Code (`agentCommitAuthor`) |
| Poll interval, stop grace period, runner container | Deployment | Runner settings §2.7 |
| Context condensing: off or summarize, limits, context size per model; never with an unknown size | D-08 X11, QUESTIONS #395, #551–#554 | Config `run.context_condensing` (rule M35) → `condensingFor` → the request (§2.10). Default off |
| The condenser uses the run's own model, URL and key; summaries never leave the adapter as text | X11 AC3, QUESTIONS #551 | Code (`condenserOf`, `withoutSummaries`). Not configurable |

## 4. Tests

| Where | What |
|---|---|
| `pnpm test` | `tests/agent/`: request body and task message (AC2, model and tool refusals), Git commands on a real repository (commit without hooks, agent author, only what is left, changed files, branch changed), adapter against a fake Agent Server (session key on every call, status mapping, `MaxIterationsReached`, fail-closed answers, errors without server text). `tests/runner/agent-access.test.ts`: settings, guard, join and leave the run network, no listening port (static), outcome rules, catalog. `tests/config/run-caps-config.test.ts` |
| `pnpm test:db` | `integration/db/agent-drive.test.ts`: the driver on PostgreSQL with a fake agent and stub Docker: every outcome, run status, `stop_reason`, `head_sha`, `iterations`, events without paths or keys, refusals before the start, kill switch race, `Runner.runAgent` clean-up |
| `pnpm test:agent` | `integration/agent/agent-live.test.ts`: the real Agent Server 1.48.0 in a node24 sandbox, the scripted stub model on the run's network as `litellm`: (1) edit, finish, commit, collect, clean-up, 401 without or with a wrong session key, the model sees the spec, the plan, the AGENTS.md rule and the AGENTS.md content; (2) iteration cap; (3) time cap with interrupt. CI job `sandbox-image` |
| `pnpm test:runner-compose` | The runner container listens on no port and has `SDLC_RUNNER_SELF_CONTAINER` |

## 5. Open items

| Item | Where |
|---|---|
| Real-model run (local Ollama, `gpt-oss:20b`), numbers recorded; D-02, D-07, ADR-M10 wording | Done in session 2 (§2.9, ADR-M10 §3) |
| One API-model run before M-F (changed from M-E, 2026-10-06) | QUESTIONS #81 |
| Status for the iteration cap: accepted (`stopped_budget` / `max_iterations`) | QUESTIONS #82, C07 |
| Temporal activity around `runAgent`; the virtual key per run; contract caps from config | C06 |
| G5 checks on the changed files and spend | C07 |
| Push of `agent/INT-…` by the runner; the commit made here is what it pushes | C08 |
| Platform loop detection with `loop_threshold`; kill switch | C11 |
| Store the log and changed files as evidence | E02 |
| A D-03 §7.2 note on the exact `AgentAdapter`, and D-05 §6.4 event names | Done in session 2 (D-03 1.8, D-05 1.10) |

## 6. Alternatives not chosen

| Option | Why not |
|---|---|
| Relay container or published port to reach the Agent Server | A container on two networks bridges the sandbox to the platform network; a published port is refused on internal networks anyway (ADR-M10 §2.4) |
| The agent commits (instruction only) | The model may not do it, or may do it partly; G5 and C08 need one deterministic final commit (QUESTIONS #80) |
| Changed files from `/api/git/changes` | Compares with `HEAD` only: misses what the agent committed itself, and is empty after the platform's commit |
| Copy the spec text into the first message | The spec is already in the workspace at `base_sha`; copying it adds tokens and a second copy that could differ |
| Count steps with the `kind` filter of the events API | Matches nothing in 1.48.0 (live test) |
| Model name in `agent_started` | Model names may hold `/` and `@`, which run event codes refuse |

## Version history

| Version | Date | Author | Notes |
|---|---|---|---|
| 0.1 | 2026-09-27 | Claude (task C05, session 1) | First version |
| 0.2 | 2026-09-27 | Claude (task C05, session 1 review) | §2.4: iteration cap status accepted (QUESTIONS #82); §2.5: recomputation outside the sandbox tracked in D-08 1.7 (C07, C08) |
| 0.3 | 2026-09-27 | Claude (task C05, session 2) | §2.9: the real-model run with a local Ollama model, the LiteLLM entry, reasoning effort and context at the gateway, `pnpm test:agent-real`; open items done |
| 0.4 | 2026-10-06 | Claude (coordinator), approved by Harry | Open items: the API-model run before M-F (QUESTIONS #81) |
| 0.5 | 2026-10-16 | Harry | Accepted (the design is built and merged; open items stay follow-ups) |
| 0.6 | 2026-10-24 | Claude (task X11), approved by Harry in the X11 plan (QUESTIONS #551–#555) | §2.10: context condensing (what Agent Server 1.48.0 offers, the configuration, rule M35, the request, counts and summaries, the numbers); §3: two rows |
