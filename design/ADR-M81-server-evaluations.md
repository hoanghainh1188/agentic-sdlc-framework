# ADR-M81. Evaluations on the server: one engine for the server and developer machines

| Item | Value |
|---|---|
| Status | **Proposed** (task L04, PR 3 of 5 done; for review) |
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

### 2.3. The queue never blocks a real run (QUESTIONS #461, AC2)

- Evaluation runs go on their own Temporal task queue, `sdlc-runner-eval`.
- They use **free slots only**, at most `SDLC_RUNNER_MAX_EVAL_SANDBOXES` (default 1, never above `SDLC_RUNNER_MAX_SANDBOXES`). A real run always counts first.
- When a real run waits and no slot is free, a running evaluation run is stopped (interrupt, then kill), marked `preempted`, queued again and **not counted** in the results.
- Because the kill switch is for real runs, an evaluation run is stopped by its own path (`cancelled` or `preempted`), never by `kill_run`.

### 2.4. Cost (QUESTIONS #462, AC2)

- New nullable column `cost_records.evaluation_run_id` (a migration; the table stays append-only). A cost record belongs to a real intent or to an evaluation run, never both.
- The seven LiteLLM labels stay: `tenant`, `project`, `intent_id` = the evaluation code (`EVAL-…`), `run_id` = the evaluation run ID, `gate` = `EVAL`, `agent`, `data_class`.
- The cost report (ADR-M45) shows evaluations as their own line, never inside an intent and never in a per-person view.
- Each evaluation has its own budget (a decimal string). Each run's virtual key is capped at what is left. When the budget is used up, the evaluation stops and its status says why (a code). A budget goes up only by a decision, as ADR-M28.

### 2.5. Scoring without `docker build` (QUESTIONS #463, AC3)

The runner talks to Docker only through its endpoint allowlist, which has no image build. So the scoring container is the project's sandbox image, created through `docker/guard.ts`, on its own internal network:

1. Clean install from the base lockfile through the package proxy.
2. The proxy is detached from the container.
3. The agent's diff and the hidden tests are applied and run with no egress: no network, no capability, `no-new-privileges`, user `node`, memory, CPU, process and time limits as today.

Developer machines use the same three steps (replacing `sdlc-eval-base`), so both places score the same way. As built (PR 2, `LocalExecutor`): the container is created from the sandbox image with the sandbox user, no capability, a read-only root and one volume `/workspace` (the repository, its packages and the pnpm store); the pinned commit and the inputs go in through `docker exec … tar`, never a bind mount. Step 1 first waits until the package proxy answers. If the packages cannot be installed, scoring throws and the run gets no result (it is not the agent's fault, and it can be repeated). The diff is recomputed outside the sandbox with hardened git (ADR-M29 §2.5). A new guard rule needs its own test and a note in ADR-M25.

### 2.6. Data classes and models (AC4)

An evaluation belongs to a project and has a data class never below the project's default. Models come only through the policy's `allowedModels`. `client_restricted` → self-hosted models only. `prohibited` → refused at start. The platform never raises a data class (ADR-M32). As built (PR 3, `startEvaluation`): the project has no "default data class" (the AI record lists the classes it allows; intents name their own), so the caller names the class (`--data-class`, default `internal`: the sample repository is fictional) and the same rule as G1 applies: the class must be allowed by the project's AI record (`aiRecordRefusal`). On top of it: `client_restricted` needs self-hosted configurations whatever the project configuration says, and every model must be in the policy's `allowedModels`.

### 2.7. How an evaluation starts in L04 (QUESTIONS #464)

Only the operator command `pnpm sdlc ops eval start --tenant --project --config --tasks --n --budget` (actor `system`; the audit event holds IDs and codes). As built (PR 3): `--tenant <slug> --project <slug> --config <file> --budget <USD>` and the optional `--configurations`, `--tasks`, `--n` (default 5), `--data-class`, `--tasks-dir`, `--json`; it writes `evaluation.started`; the evaluation ends with `evaluation.finished`. The API, CLI and schedules come in L05; reports in L06.

- Task set v1 is packed into the runner image. A private set is mounted read-only through `SDLC_EVAL_TASKS_DIR`. Hidden tests and `solution.patch` never reach the agent.
- The sample repository is cloned like a real run, with the GitHub App's short-lived single-repository token. The App must be installed on `pilot-order-inventory`; the deploy README says so.

### 2.8. The flow on the server (AC2, AC3)

1. `ops eval start` writes an `evaluations` row (`queued`) and one `evaluation_runs` row per task × run × configuration.
2. A plain worker loop, `EvaluationLoop` (never a Temporal schedule), picks `queued` evaluations. Per run it issues the evaluation contract and a capped virtual key, then queues the run on `sdlc-runner-eval`. Temporal inputs hold IDs only; single-use OpenBao wrapping tokens as for real runs.
3. The runner drives the agent with `driveAgent`, scores it as §2.5 and writes the result.
4. The Cost Controller syncs spend into `cost_records` with `evaluation_run_id`.

## 3. Pull requests

| PR | Content |
|---|---|
| 1 | This ADR, QUESTIONS #460–#464, the D-05 draft (three tables, one column), the number block |
| 2 | `@sdlc/eval`, `LocalExecutor`, scoring as §2.5 on developer machines, the hardware block in reports |
| 3 | Migration, repositories, core `evaluations` (budget, append-only, tenant), `ops eval start` |
| 4 | `EvaluationLoop`, the eval queue and slot priority in the runner, the scoring container through the guard, cost labels and column |
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
