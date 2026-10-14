# ADR-M81. Evaluations on the server: one engine for the server and developer machines

| Item | Value |
|---|---|
| Status | **Proposed** (task L04, PR 4d done; for review) |
| Date | 2026-10-14 |
| Decided by | Harry (L04 plan approved 2026-10-14, with answers to QUESTIONS #460–#464) |
| Related | D-08 task L04 (AC1–AC5), then L05 (plans, API, CLI, schedules) and L06 (reports in the dashboard); ADR-M78 (the harness), ADR-M25 (sandbox, guard), ADR-M33 §2.6 (runner queue), ADR-M24 and ADR-M45 (cost), ADR-M29 (agent path), ADR-M80 §4.1 (canary search); D-07 §3–§5; D-05 §6.8 (the tables); QUESTIONS #450, #460–#464 |

## 1. Context

ADR-M78 built an evaluation harness that runs on a developer machine (`pnpm eval`). Managers also need evaluations on the company server, where the runner, LiteLLM and the Cost Controller already run, so they can compare agents, models and prompts without a developer's laptop (QUESTIONS #450). L04 moves the evaluation onto the server **without a second engine**: the same tasks, scoring and statistics must give comparable numbers in both places.

Two risks shape the design: an evaluation must never slow down or block a real run, and it must never mix its cost, metrics or gates with real intents.

## 2. Decision

### 2.1. One engine, two executors (AC1)

- The pure parts of `platform/eval/src` (tasks, configurations, scoring script, statistics, report, result shape) are the workspace package `@sdlc/eval` (PR 2: the folder `platform/eval` stays, with the task sets and configurations; it now has a `package.json`).
- An interface `EvalExecutor` runs one task for one configuration and returns one run result (numbers and codes). Two implementations:
  - `LocalExecutor`: the Docker CLI path of today's `pnpm eval`. Behaviour and result shape stay as before.
  - `ServerExecutor`: the worker queues the run, the deployed runner drives the agent and scores it.
- Both call the same scoring and statistics code. A result and a report say where they ran (`developer` or `server`) and on what hardware: CPU model, cores, memory, Docker version, GPU if any, and (on the server) the runner instance label. As built (PR 2): a run result has the optional fields `where` and `hardware` (checked like every other field; results of L02 stay valid without them), the report has a section "Where it ran", and `buildRunResult` builds the result for both executors.
- `core` does not import `@sdlc/eval` adapters directly; the worker and runner depend on the interface (module boundaries as in CLAUDE.md).

### 2.2. Own tables, never `runs` (QUESTIONS #460)

Three tables, all with `tenant_id`, codes and numbers only (D-05 §6.8):

| Table | Role |
|---|---|
| `evaluations` | One evaluation: project, configuration IDs, task set version and task IDs, runs per task, budget, data class, status, where it runs |
| `evaluation_runs` | One run of one task for one configuration: status (`queued`, `running`, `scored`, `failed`, `preempted`, `cancelled`), attempt, runner instance |
| `evaluation_run_results` (append-only) | The scored result of a run: hidden tests passed, CI first try, scope breach, stop reason code, finding count, diff size, wall-clock time, model calls, tokens, cost as a decimal string |

Real `runs`, V13 metrics, gates, the kill switch and the cost report stay unmixed. As built (PR 3): migration `0029-evaluations`, D-05 §6.8. The evaluation keeps its configuration file as a code (`config_name`) and each run copies the model, provider type and agent version of its configuration, so the worker and the runner read no prompt from a table. The signed contract is stored in PR 4. The Run Contract gets a second kind, `evaluation`: same OpenBao Transit key, its own schema, no intent and no plan. A runner verifies the kind before it acts.

No prompt, task text, code or diff is stored in any table, run event, audit event, log or Temporal history (ADR-M78 §2.4).

As built (PR 4a): the contract (`@sdlc/contracts` `EvaluationRunContract`, kind `evaluation`) names the evaluation run, the evaluation code, the sample repository and its commit, the codes of the configuration and the task, the attempt, the one model (the only entry of `allowed_models`), the caps and the egress hosts; it has no intent, plan or branch, and a Run Contract fails its schema and the other way round. It is stored per attempt in `evaluation_run_contracts` (migration `0030`); `evaluations.base_sha` and the configuration's caps on `evaluation_runs` let the worker issue it without reading a configuration file. `issueEvaluationContract` caps `max_budget_usd` at what is left of the budget and refuses a used-up budget; `verifyEvaluationContract` (runner side) checks the signature, the stored contract, the time window and that the run is `queued` on that attempt; the runner then takes the run with `claim(id, attempt, instance)`, one conditional update. A preempted run gets a new contract for its next attempt; the old one is useless.

### 2.3. The queue never blocks a real run (QUESTIONS #461, AC2)

- Evaluation runs go on their own Temporal task queue, `sdlc-runner-eval`.
- They use **free slots only**, at most `SDLC_RUNNER_MAX_EVAL_SANDBOXES` (default 1, never above `SDLC_RUNNER_MAX_SANDBOXES`). A real run always counts first.
- As built (PR 4b): the runner's `SlotPool` has a second class. `acquireEvaluation(onPreempt)` is granted only while an evaluation slot is free (`SDLC_RUNNER_MAX_EVAL_SANDBOXES`), the pool has a free slot and no real run waits; a freed slot goes to a waiting real run first. When a real run waits and no slot is free, the evaluation runs holding slots are asked to stop (once each, newest first, as many as real runs wait); the evaluation activity (PR 4c) then interrupts its agent, marks the run `preempted`, queues it again and frees the slot. After a lost runner (a restart or a crash) the sweep queues a `running` evaluation run again, and fails it with `runner_lost` after three attempts (`MAX_EVALUATION_ATTEMPTS`).
- When a real run waits and no slot is free, a running evaluation run is stopped (interrupt, then kill), marked `preempted`, queued again and **not counted** in the results.
- Because the kill switch is for real runs, an evaluation run is stopped by its own path (`cancelled` or `preempted`), never by `kill_run`.

### 2.4. Cost (QUESTIONS #462, AC2)

- New nullable column `cost_records.evaluation_run_id` (a migration; the table stays append-only). A cost record belongs to a real intent or to an evaluation run, never both.
- The seven LiteLLM labels stay: `tenant`, `project`, `intent_id` = the evaluation code (`EVAL-…`), `run_id` = the evaluation run ID, `gate` = `EVAL`, `agent`, `data_class`.
- As built (PR 4a): `CostController.issueEvaluationRunKey` issues the key (`run_id` = the evaluation run, `agent` = the configuration, `gate` = `EVAL`; the cap is the smallest of the contract, what is left of the evaluation's budget and of the tenant's month). The spend sync recognises the label `gate` = `EVAL`, checks that `intent_id` is the evaluation's code and `project` its project's slug, and records the call with `evaluation_run_id` (intent, run and gate null); a mismatch is skipped as `label_mismatch`. A key is revoked with `endRunKey` by the evaluation run's ID, and a preempted run's key is revoked before its next attempt is queued.
- The cost report (ADR-M45) shows evaluations as their own line, never inside an intent and never in a per-person view.
- Each evaluation has its own budget (a decimal string). Each run's virtual key is capped at what is left. When the budget is used up, the evaluation stops and its status says why (a code). A budget goes up only by a decision, as ADR-M28.

### 2.5. Scoring without `docker build` (QUESTIONS #463, AC3)

The runner talks to Docker only through its endpoint allowlist, which has no image build. So the scoring container is the project's sandbox image, created through `docker/guard.ts`, on its own internal network:

1. Clean install from the base lockfile through the package proxy.
2. The proxy is detached from the container.
3. The agent's diff and the hidden tests are applied and run with no egress: no network, no capability, `no-new-privileges`, user `node`, memory, CPU, process and time limits as today.

Developer machines use the same three steps (replacing `sdlc-eval-base`), so both places score the same way. As built (PR 2, `LocalExecutor`): the container is created from the sandbox image with the sandbox user, no capability, a read-only root and one volume `/workspace` (the repository, its packages and the pnpm store); the pinned commit and the inputs go in through `docker exec … tar`, never a bind mount. Step 1 first waits until the package proxy answers. If the packages cannot be installed, scoring throws and the run gets no result (it is not the agent's fault, and it can be repeated). The diff is recomputed outside the sandbox with hardened git (ADR-M29 §2.5). A new guard rule needs its own test and a note in ADR-M25.

As built (PR 4b, `scoreEvaluationRun` in the runner): the Docker client has no exec, so each step is a container over one workspace volume, and the proxy is "detached" by the next container having no network at all. Step 1 is a container on the run's internal network with the package proxy attached; it installs and exits. The container, the proxy attachment and the network are removed. Step 3 is a new container with `NetworkMode: none` over the same volume (the repository, its packages, the pnpm store and the corepack cache all live on it). The guard rule is in ADR-M25 §2.5. The inputs go into the volume with one archive before step 1 (the pinned commit's tree, the two patches, the two scripts, the hidden tests); the result is the script's last line on the container's standard output. The step that runs the agent's code is stronger than on a developer machine: not a network that was detached, but none. The live test `pnpm test:eval-score` shows the same score as `LocalExecutor` for the reference solution and for the untouched base of a task, and that the proxy, the internet and DNS all fail from step 3 (with a positive control). Known limit, the same on both: the tests of the task run as the same user as the script, so code written to forge the result could try; the last line of the output and the fixed command make it hard, not impossible (ADR-M80).


### 2.6. Data classes and models (AC4)

An evaluation belongs to a project and has a data class never below the project's default. Models come only through the policy's `allowedModels`. `client_restricted` → self-hosted models only. `prohibited` → refused at start. The platform never raises a data class (ADR-M32). As built (PR 3, `startEvaluation`): the project has no "default data class" (the AI record lists the classes it allows; intents name their own), so the caller names the class (`--data-class`, default `internal`: the sample repository is fictional) and the same rule as G1 applies: the class must be allowed by the project's AI record (`aiRecordRefusal`). On top of it: `client_restricted` needs self-hosted configurations whatever the project configuration says, and every model must be in the policy's `allowedModels`.

### 2.7. How an evaluation starts in L04 (QUESTIONS #464)

Only the operator command `pnpm sdlc ops eval start --tenant --project --config --tasks --n --budget` (actor `system`; the audit event holds IDs and codes). As built (PR 3): `--tenant <slug> --project <slug> --config <file> --budget <USD>` and the optional `--configurations`, `--tasks`, `--n` (default 5), `--data-class`, `--tasks-dir`, `--json`; it writes `evaluation.started`; the evaluation ends with `evaluation.finished`. The API, CLI and schedules come in L05; reports in L06.

- Task set v1 is packed into the runner image. A private set is mounted read-only through `SDLC_EVAL_TASKS_DIR`. Hidden tests and `solution.patch` never reach the agent.
- The sample repository is cloned like a real run, with the GitHub App's short-lived single-repository token. The App must be installed on `pilot-order-inventory`; the deploy README says so.

### 2.8. The flow on the server (AC2, AC3)

1. `ops eval start` writes an `evaluations` row (`queued`) and one `evaluation_runs` row per task × run × configuration.
2. A plain worker loop, `EvaluationLoop` (never a Temporal schedule), picks `queued` evaluations. Per run it issues the evaluation contract and a capped virtual key, then queues the run on `sdlc-runner-eval`. Temporal inputs hold IDs only; single-use OpenBao wrapping tokens as for real runs.
3. The runner drives the agent, scores it as §2.5 and returns the measures (codes and numbers). The worker adds the model calls, tokens and cost from the cost records and writes the result.
4. The Cost Controller syncs spend into `cost_records` with `evaluation_run_id`.

As built (PR 4c, the runner side): `executeEvaluation` (`apps/runner/src/evaluation/execute.ts`), run by the activity `executeEvaluationRun` of a second Temporal worker on `sdlc-runner-eval` (its activity slots are `SDLC_RUNNER_MAX_EVAL_SANDBOXES`):

1. wait for an evaluation slot (the run is still `queued`); verify the signed contract and claim the run;
2. clone the sample repository at the contract's commit with a single-repository token (revoked as soon as the clone ended), read the task from the task set and the configuration from the config folder (both packed into the runner image: `/app/eval-tasks`, `/app/eval-configs`, or `SDLC_EVAL_TASKS_DIR` / `SDLC_EVAL_CONFIG_DIR`; the reference solutions are removed from the image), build the base with `prepareBase` of `@sdlc/eval`, start the sandbox from it;
3. drive the agent with `driveEvaluationAgent`, which shares the poll loop, the stop step, the budget stop and the loop detection with `driveAgent` and writes no run event (an evaluation run has no row in `runs`);
4. recompute the change outside the sandbox with hardened git (`computeRunPatch`), count the files outside the plan, remove the sandbox, score in the scoring containers (`ServerExecutor` is the server's `EvalExecutor`);
5. return `scored` with the measures; the run stays `running` until the worker writes the result.

A real run that needs the slot aborts the activity's signal: the agent is stopped (interrupt, then kill), the run is marked `preempted` and queued again for the next attempt, and the stopped attempt is not counted. A cancel of the activity ends the run `cancelled` (`evaluation_stopped`). A refused contract (expired, …) gives the run its next attempt. Any other failure marks the run `failed` with a code (`clone_clone_failed`, `agent_…`, `scoring_install_failed`, `task_unavailable`, …). The result is written by the worker, not the runner, because the cost is synced into `cost_records` by the worker (the runner holds no gateway key). The hardware block is the runner's: Docker version from the ping answer's `Server` header (no new endpoint), `SDLC_RUNNER_GPU`, the instance label.

As built (PR 4d, the worker side): the loop `EvaluationLoop` (`apps/worker/src/evaluation-loop.ts`) runs every `SDLC_WORKER_EVAL_TICK_SECONDS` (default 15) when the worker has the Cost Controller and Temporal. Per pass it visits the tenants with an open evaluation, or a run still on a runner (`SystemScope.listTenantsWithOpenEvaluations`, IDs only), and for each tenant:

1. cancels the workflow of every `running` run whose evaluation already ended (a budget stop, an operator stop);
2. gives the next attempt to a run that was handed over (it has a contract for its current attempt) but has no live workflow, for example after a worker stop between the contract and the start;
3. hands over queued runs while fewer than `SDLC_WORKER_EVAL_MAX_IN_FLIGHT` (default 2, over all tenants) are running or waiting for a runner slot, so a contract does not expire in a queue: `prepareEvaluationRun` (core) re-checks the model against the gateway's current list and the project's policy for the evaluation's data class (a model that is gone cancels the run: `model_not_allowed`), checks the budget (a used-up budget stops the evaluation), issues and signs the contract, issues the virtual key capped at what is left of the evaluation, the run and the tenant (`CostController.issueEvaluationRunKey`; a used-up tenant budget stops the evaluation: `tenant_budget_used`), issues the single-repository read token and wraps both secrets. A run is not prepared while the workflow of its previous attempt still lives, so the finish of that attempt never revokes the next attempt's key.

The workflow `evaluationRunWorkflow` (ID `evaluation-run/<tenant>/<run>/<attempt>`, so a second start is refused by Temporal) calls the runner's activity once (12 hours, heartbeat timeout 2 minutes, no retry, `WAIT_CANCELLATION_COMPLETED`), then calls the worker activity `finishEvaluationRun` outside the cancel scope (up to 8 tries; idempotent). Its input holds IDs, one time and the two wrapping tokens; its history holds no secret. `finishEvaluationRun` (core) revokes the run's key and syncs the spend, then by the answer: `scored` → waits (bounded: three syncs, 5 seconds apart) until the cost records show the calls, and writes the result with the model calls, tokens and cost from the cost records; `failed` → the run fails with the runner's code; `lost` (the activity failed or the heartbeat was lost) → the run is queued again, and fails with `runner_lost` after `MAX_EVALUATION_ATTEMPTS` (three); `refused` → the next attempt; `cancelled` before a runner took the run → `cancelled` (`evaluation_stopped`); `preempted` and a runner-side `cancelled` need nothing. Then it stops the evaluation if its budget is used up (`stopped_budget`), or ends it when no run is left to do (`completed` when at least one run was scored, else `failed` with `no_run_scored`). The runner's evaluation worker sends heartbeats at least every 5 seconds, so a cancel reaches the agent quickly.

## 3. Pull requests

| PR | Content |
|---|---|
| 1 | This ADR, QUESTIONS #460–#464, the D-05 draft (three tables, one column), the number block |
| 2 | `@sdlc/eval`, `LocalExecutor`, scoring as §2.5 on developer machines, the hardware block in reports |
| 3 | Migration, repositories, core `evaluations` (budget, append-only, tenant), `ops eval start` |
| 4a | The contract of kind `evaluation` (schema, signing, storage per attempt, the runner's check), the capped virtual key with the label `gate` = `EVAL`, the spend sync into `cost_records.evaluation_run_id`, the claim of a queued run (migration `0030`) |
| 4b | The runner: the second task queue and the slot rule (free slots only, preemption of an evaluation run for a real run), the scoring container through `docker/guard.ts` with its test and an ADR-M25 note |
| 4c | The runner side: `executeEvaluation`, the activity and the second Temporal worker, `driveEvaluationAgent`, `ServerExecutor`, task set and configurations in the runner image, the stub-model live test (`pnpm test:eval-server`) with the canary search of ADR-M80 §4.1 |
| 4d | The worker side: the workflow that runs the activity, `EvaluationLoop` (contract, capped key, wrapping tokens, the result with the cost, the budget stop, the end of an evaluation); tests on PostgreSQL and on the Temporal test server |
| 5 | Handbook Ch.19 usage, deploy README, `platform/DEVELOPMENT.md` rows, troubleshooting, CHANGELOG |

## 4. Tests (AC5)

- Unit: both executors share the scoring code; the evaluation contract; preemption logic; data-class checks.
- `pnpm test:db`: tenants, append-only results, budget stop, the queue never blocks a real run (a waiting real run preempts an evaluation run).
- Live: a run on the stub model through the real runner gives a result equal to `LocalExecutor` on the same task and stub.
- The canary search of ADR-M80 §4.1 finds nothing in tables, events, logs and Temporal.

## 5. Consequences

- Managers can compare configurations on the server; the numbers are comparable with a developer machine's because the code is shared.
- Evaluation uses spare capacity only. On a busy server it may wait or be preempted, and preempted runs are repeated, so a full evaluation takes longer.
- One more Run Contract kind, one more queue and three more tables to keep in the audit and tenant tests.

## 6. Alternatives not chosen

| Alternative | Why not |
|---|---|
| Evaluation runs as rows of `runs` | Would mix V13 metrics, gates, the kill switch and the cost report; every reader would need a filter |
| A second runner for evaluations | More hosts to run on a modest server; the deployed runner already has the sandbox rules |
| `docker build` for the scoring image | The runner's Docker allowlist has no build; adding one widens the attack surface |
| Evaluation runs sharing the slots of real runs | A long evaluation could delay a real run |
| A Temporal schedule for the loop | CLAUDE.md: clocks and loops are plain worker loops |

## Version history

| Version | Date | Author | Notes |
|---|---|---|---|
| 0.1 | 2026-10-14 | Claude (task L04, PR 1) | First version |
| 0.2 | 2026-10-14 | Claude (task L04, PR 2) | §2.1, §2.5 as built: `@sdlc/eval`, `EvalExecutor`, `LocalExecutor`, the hardware block, scoring in the sandbox image |
| 0.3 | 2026-10-14 | Claude (task L04, PR 3) | §2.2, §2.6, §2.7 as built: the tables, the data-class rule without a project default, the operator command; budget service and queue primitives in core |
| 0.4 | 2026-10-14 | Claude (task L04, PR 4a) | §2.2, §2.4 as built: the evaluation contract, the key and the sync; §3: PR 4 is split into 4a, 4b and 4c because the runner's provisioning and driver are tied to `runs` (4b and 4c reuse their polling and caps without a `runs` row) |
| 0.5 | 2026-10-14 | Claude (task L04, PR 4b) | §2.3, §2.5 as built: the slot pool, the sweep of lost evaluation runs, scoring in two containers over one volume with the guard rule |
| 0.6 | 2026-10-14 | Claude (task L04, PR 4c) | §2.8 as built on the runner side; §3: PR 4 is now 4a to 4d (4d is the worker side); the result is written by the worker because it adds the cost |
| 0.7 | 2026-10-14 | Claude (task L04, PR 4d) | §2.8 as built on the worker side: the loop, `prepareEvaluationRun`, the workflow, `finishEvaluationRun`, the settings `SDLC_WORKER_EVAL_TICK_SECONDS` and `SDLC_WORKER_EVAL_MAX_IN_FLIGHT` |
