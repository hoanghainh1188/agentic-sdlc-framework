# ADR-M29. OpenHands adapter: driving the agent in the sandbox

| Item | Value |
|---|---|
| Status | **Proposed** (task C05, session 1; PR for review) |
| Date | 2026-09-27 |
| Decided by | Harry (C05 plan approved 2026-09-27, with conditions; QUESTIONS #13, #78–#80) |
| Related | D-02 FR-11, FR-30…FR-33, FR-35, FR-50; D-03 sections 7.2, 8, 9; D-05 section 6.4; D-07 sections 3, 4, 6; D-08 tasks C05, C06, C07, C08, C11; ADR-M04, ADR-M10, ADR-M22, ADR-M24, ADR-M25 |

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
- **These answers are what the sandbox reports.** The agent controls everything inside the sandbox (files, `.git`, its shell), so it could make them lie. They are good enough to record the run and to choose what to push; G5 (C07) and the push (C08) must recompute the changed files and `head_sha` from the pushed branch outside the sandbox (the runner's clone or the Git host) before any gate relies on them (D-08 1.6 notes on C07 and C08).
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
| Real-model run (local Ollama, `gpt-oss:20b`), numbers recorded; D-02, D-07, ADR-M10 wording | C05 session 2 (QUESTIONS #78) |
| One API-model run before M-E | QUESTIONS #81 |
| Status for the iteration cap: accepted (`stopped_budget` / `max_iterations`) | QUESTIONS #82, C07 |
| Temporal activity around `runAgent`; the virtual key per run; contract caps from config | C06 |
| G5 checks on the changed files and spend | C07 |
| Push of `agent/INT-…` by the runner; the commit made here is what it pushes | C08 |
| Platform loop detection with `loop_threshold`; kill switch | C11 |
| Store the log and changed files as evidence | E02 |
| A D-03 §7.2 note on the exact `AgentAdapter` (like the §7.1, §7.3, §7.4 notes), and D-05 §6.4 event names, for approval with the session 2 design changes | C05 session 2 |

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
| 0.2 | 2026-09-27 | Claude (task C05, session 1 review) | §2.4: iteration cap status accepted (QUESTIONS #82); §2.5: recomputation outside the sandbox tracked in D-08 1.6 (C07, C08) |
