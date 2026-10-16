# ADR-M82. Evaluation plans that managers make themselves, dashboard first

| Item | Value |
|---|---|
| Status | **Accepted** (Harry, 2026-10-16; built by task L05) |
| Date | 2026-10-14 |
| Decided by | Harry (L05 plan approved 2026-10-14, with answers to QUESTIONS #470–#474) |
| Related | D-08 task L05 (AC1–AC4), then L06 (reports, recommendations) and L07 (a project's own task set); ADR-M81 (evaluations on the server), ADR-M73 (the dashboard's actions, CSRF, passkey step-up), ADR-M78 (the harness), ADR-M31 (the agent register), ADR-M39 and ADR-M40 (files read from the default branch, hashes only), ADR-M28 (budgets only go up by a decision); D-05 §6.8; QUESTIONS #450, #465, #470–#474 |

## 1. Context

L04 runs an evaluation on the server, but only an operator starts one, on the server, with `sdlc ops eval start`. Managers should plan evaluations themselves, run them again when something changes, and follow them (QUESTIONS #450). They use the CLI little, so the dashboard comes first (QUESTIONS #465). The engine of L04 stays as it is: a plan only decides what to evaluate and when, and each run of a plan is one L04 evaluation.

## 2. Decision

### 2.1. An evaluation plan (AC1)

A plan belongs to a project and holds codes, IDs, numbers and hashes only:

- a name code (`[a-z][a-z0-9-]{0,47}`, unique in the project) and a data class (the rules of ADR-M81 §2.6 apply when a run starts);
- the configurations: for each, an agent version from the agent register (its model from the gateway's list) or a model by name, and an optional **prompt variant** (§2.3);
- the task set (§2.6) and an optional list of task IDs, the number of runs per task (1–20);
- the budget of each run (USD, a decimal string) and a monthly cap (§2.5);
- when it runs (§2.4).

A plan is versioned: every change writes a new row of `evaluation_plan_versions` (append-only); the plan row points at its current version. A plan is archived, never deleted. Each evaluation started from a plan records the plan and the version (`evaluations.plan_id`, `evaluations.plan_version`).

As built (PR 2, QUESTIONS #475): a configuration names an agent of the register by its key, or a model by name (with its provider type) run by the project's default agent (`run.agent_key`). When a run starts, each configuration is resolved: the agent must be `active` and have a model, the model must be on the gateway's list and allowed for the data class; the result (agent, version, model, provider type, caps, the instructions file's path, commit and SHA-256) is stored in `evaluation_configurations` (append-only), and the runner reads it there instead of a configuration file (PR 4). An evaluation has either a `config_name` (the operator command of L04) or a plan, never both (a CHECK). Migration `0031-evaluation-plans`; trigger SDA23 fixes a plan's identity, keeps an archived plan final and the version going up; a unique index keeps one open evaluation per plan. The default of `access.eval_roles` is `person_a`, `person_b`, `governance`, `admin` (the project role codes); mandatory rule M33.

### 2.2. Who (AC1, AC4)

A new project configuration key `access.eval_roles` (default `person_a`, `person_b`, `governance`, `tenant_admin`, the role codes of the project). A mandatory rule refuses `viewer` in it (`config.rule.viewer_never_runs_evaluations`). People with a role in the list create, change, archive and run plans; everybody who may read the project reads plans and their evaluations. Agents never do: there is no agent capability for plans. The operator command of L04 stays.

### 2.3. Prompt variants are files on the default branch (QUESTIONS #471)

A prompt variant is the path of an instructions file on the project's default branch (for example `eval/prompts/short-agents.md`), like specs and plans (ADR-M39, ADR-M40). When a plan is saved, the platform reads the file once and stores only the path, the commit and the SHA-256; when a run of the plan starts it reads the file again from the default branch and records the commit and SHA-256 it used in the evaluation. The text is never stored, logged or put into Temporal; it goes to the sandbox as the agent's `AGENTS.md` for that configuration only. A file that cannot be read makes the start wait (`git_host_unavailable`) or refuses it (`prompt_not_found`); it never falls back to another file. The dashboard has no field to paste a prompt.

### 2.4. When a plan runs (QUESTIONS #472, AC2)

- `once`: only when a person presses **Run now** (or `sdlc eval run`).
- `schedule`: daily or weekly, at an hour in UTC (and a weekday for weekly). The plan row holds `next_run_at`.
- `on_change`: when the gateway's model list or the active versions of the plan's agents change. The plan row holds a SHA-256 of the sorted model names and agent version IDs it last saw.

A plain worker loop, `EvaluationPlanLoop` (never a Temporal schedule), checks the due plans.

As built (PR 4): the loop runs every `SDLC_WORKER_EVAL_TICK_SECONDS` when the worker has the Cost Controller; it visits only tenants with plan work (`SystemScope.listTenantsWithPlanWork`) and advances each plan one step (core `advanceEvaluationPlan`): an ended pause is lifted; a Run now request is taken once and started as the person who asked; a due schedule starts one run as the system and the next time is set from now (a missed schedule runs once; an open evaluation waits for the next time); for `on_change` the first sight records the hash without a run and a change starts one. A refusal stays on the plan (`last_refusal`) and in the audit log; a Git host that cannot be read leaves a request for the next pass. The worker image carries task set v1 without the reference solutions (`/app/eval-tasks`, `SDLC_EVAL_TASKS_DIR`). The runner builds a plan's configuration from `evaluation_configurations`; a prompt variant is read from a second clone at the recorded commit with the same single-repository token, must be a regular file of the repository (at most 256 KB) and must have the recorded SHA-256, else the run fails with `task_unavailable`. A plan never has two open evaluations: a due plan with an open evaluation waits for the next time. A schedule that was missed while the worker was down runs once, not once per missed time. Every start, by a person or by the loop, writes `evaluation_plan.run_started`; an automatic start has the actor `system` and the reason code `schedule` or `on_change`.

### 2.5. Budgets (QUESTIONS #473)

Each run of a plan is an L04 evaluation with the plan's budget per run, capped by what is left of the plan's monthly cap and of the tenant's monthly budget. When the monthly cap is used up, the plan's schedule pauses until the next UTC month (`evaluation_plan.paused`, reason `monthly_cap_used`); **Run now** is refused. The per-run budget and the monthly cap only go up by a change of the plan (a new version, audited with the old and the new amount); lowering them is a change too, but never below what the current month already spent.

### 2.6. Task sets (QUESTIONS #474)

L05 knows the task set packed in the runner image (v1) and the server's own set (`SDLC_EVAL_TASKS_DIR`), named by its version. A project's own task set comes with L07.

### 2.7. Dashboard first, through a narrow exception to U07 (QUESTIONS #470, AC3)

ADR-M73 keeps business writes from a dashboard session until U07. L05 adds exactly four session actions, marked `@SessionAction('actions')`, on fixed paths in `src/api/writes.ts`:

| Action | Endpoint | Passkey step-up |
|---|---|---|
| Create a plan | `POST /v1/projects/:project/eval-plans` | only if it has a schedule or `on_change` |
| Change a plan (a new version) | `POST /v1/eval-plans/:plan/versions` | only if it turns a schedule or `on_change` on, or raises a budget |
| Archive a plan | `POST /v1/eval-plans/:plan/archive` | no |
| Run now | `POST /v1/eval-plans/:plan/runs` | always |

The three CSRF layers of ADR-M73 §2.3 apply to all four; with `SDLC_API_DASHBOARD_ACTIONS=off` they answer 403 `dashboard_actions_off` (the API with a token still works). The step-up binds the action (`eval_plan.create`, `eval_plan.change`, `eval_plan.run`), the plan and the request's SHA-256, as ADR-M73 §2.4b. Gate decisions, kills and escalations still wait for U07. The dashboard reads plans and evaluations with `GET` through `src/api/reads.ts`: the list of plans, a plan with its versions, and an evaluation with its runs by status, its spend and its budget. The full report is L06.

The API (`/v1/projects/:project/eval-plans`, `/v1/eval-plans/:plan…`, `/v1/evaluations…`) and the CLI (`sdlc eval plan create|change|show|list|archive`, `sdlc eval run`, `sdlc eval list|show`, all with `--json`) give the same actions with a token; a token takes no step-up (ADR-M36).

As built (PR 3, QUESTIONS #476): the api has neither the gateway's model list nor the task sets, so it checks the role, the format, the register (the agent exists, is active and has a model), the prompt files and the project's AI record, and saves the plan. **Run now** (`POST /v1/eval-plans/:plan/runs`) answers 202 and records a request on the plan (`run_requested_at`, `run_requested_by`, migration `0032-evaluation-plan-requests`; audit `evaluation_plan.run_requested`; a second request while one waits records nothing). The worker's plan loop (PR 4) takes the request, checks the models and the task set and starts the evaluation; when it cannot, it keeps the refusal code on the plan (`last_refusal`, `last_refusal_at`) and writes `evaluation_plan.run_refused`. Refusals reach the caller as `evaluation_refused` (422), `evaluation_conflict` (409), `forbidden` (403) or `not_found` / `project_not_found` (404), with the code as `reason` and its catalog text (`evaluation.error.*`). The CLI reads the plan from a JSON file of at most 64 KB (`--file`), never from an argument holding text. The response schemas are in `@sdlc/api-schemas` for the dashboard (PR 5).

As built (PR 5, QUESTIONS #477, #478): the four routes are `@SessionAction('actions')`. A dashboard session sends the passkey answer as `step_up` in the body when the API's rule needs it (Run now always; a create or change that turns a schedule or `on_change` on or raises a budget; archive never). The step-up actions are `eval_plan.create`, `eval_plan.change` and `eval_plan.run`; the binding names no intent or escalation, its decision is the action's own name, and its request SHA-256 covers the body exactly as the page sent it (without `step_up`) plus `decision` and `target` (the project's slug for create, else the plan's ID). The API uses the step-up in the write's transaction. The list and the plan answer `can_change` (a role in `access.eval_roles`, the plan not archived). The dashboard has four screens: the plans and latest evaluations of a project, one plan with Run now, change and archive (asked twice), the form (codes, numbers, amounts, a prompt file's path; never a prompt text), and one evaluation (runs by status, spend against budget). Refusals show the API's reason from the catalog (`evaluation.error.*`).

### 2.8. Audit (AC3)

New audit actions, IDs, codes, hashes and amounts only: `evaluation_plan.created`, `evaluation_plan.changed` (the version, the changed field names, old and new amounts), `evaluation_plan.archived`, `evaluation_plan.run_started` (the evaluation, the reason code), `evaluation_plan.paused`. `evaluation.started` of L04 gains the plan and its version when it has one.

## 3. Pull requests

| PR | Content |
|---|---|
| 1 | This ADR, QUESTIONS #470–#474, D-05 §6.8 (draft), ADR-M73 note |
| 2 | Migration (`evaluation_plans`, `evaluation_plan_versions`, `evaluations.plan_id`), core (create, change, archive, start from a plan, budgets), `access.eval_roles` and its mandatory rule, audit actions |
| 3 | API and CLI |
| 4 | The worker's `EvaluationPlanLoop` (schedules, `on_change`), prompt variants read at start and passed to the runner |
| 5 | Dashboard: plans, the form, Run now with the step-up, following an evaluation |
| 6 | Handbook Ch.19, deploy README, CHANGELOG, `platform/DEVELOPMENT.md` |

## 4. Tests (AC4)

- Roles: a person with a role in `access.eval_roles` creates and runs; `viewer`, another project and another tenant are refused; an agent cannot.
- Budgets: the monthly cap pauses a schedule and refuses Run now; the tenant budget; amounts only change by a new version; never below the month's spend.
- Schedules: due, missed while down (one run), one open evaluation per plan; `on_change` fires once per change.
- Prompt variants: hashes only stored; a changed file is read again and recorded; a missing file refuses, a Git host down waits.
- Dashboard: the four writes only, CSRF, actions off, step-up bound to the request; refusals shown from the catalog.

## 5. Consequences

- Managers run evaluations without the operator; spend stays bounded by three budgets (run, plan month, tenant month).
- The rule "no business writes from the dashboard before U07" gets a named, narrow exception; U07 keeps gate decisions, kills and escalations.
- Prompts to try live in the project's repository, reviewed like any other file.

## 6. Alternatives not chosen

| Alternative | Why not |
|---|---|
| Paste a prompt variant in the dashboard | The text would be stored by the platform (free text in tables), outside review |
| Temporal schedules | Against the rule for plain worker loops (ADR-M28, ADR-M51); state stays in PostgreSQL |
| One budget per plan only | A schedule could spend without bound in a month |
| CLI first, dashboard later | Managers use the CLI little (QUESTIONS #465) |

## Version history

| Version | Date | Author | Notes |
|---|---|---|---|
| 0.1 | 2026-10-14 | Claude (task L05, PR 1) | First version |
| 0.6 | 2026-10-15 | Claude (task L05, PR 6) | Status: all PRs done; usage in handbook Ch.19 §19.8c, §19.8e and the deployment README "Evaluation plans" |
| 0.5 | 2026-10-15 | Claude (task L05, PR 5) | §2.7 as built: the session actions, the step-up binding of plan actions, `can_change`, the four dashboard screens (QUESTIONS #477, #478) |
| 0.4 | 2026-10-15 | Claude (task L05, PR 4) | §2.4 as built: the plan loop, task set v1 in the worker image, the runner reading a plan's configurations and prompt variants |
| 0.3 | 2026-10-14 | Claude (task L05, PR 3) | §2.7 as built: the API and CLI; Run now as a request the worker starts (QUESTIONS #476, migration 0032) |
| 0.2 | 2026-10-14 | Claude (task L05, PR 2) | §2.1 as built: configurations from the agent register or a model with the default agent, resolved into `evaluation_configurations` at start (QUESTIONS #475); migration 0031, SDA23, M33 |
| 0.7 | 2026-10-16 | Harry | Accepted (the design is built and merged; open items stay follow-ups) |
