# ADR-M78. The evaluation harness for agents, models and prompts

| Item | Value |
|---|---|
| Status | **Accepted** (Harry, 2026-10-16; built by task L02) |
| Date | 2026-10-13 |
| Decided by | Harry (plan approved 2026-10-13, with answers to QUESTIONS #435–#439) |
| Related | D-08 task L02 (AC1–AC10); D-07 §3–§5; D-09 §7; ADR-M10, ADR-M29 (the agent path), ADR-M24 (cost), ADR-M35 (Langfuse), ADR-M79 (the report from real runs); QUESTIONS #362, #422, #423, #435–#439 |

## 1. Context

Leadership will ask which model size is good enough and how much GPU that needs (D-07 §9, task L03). Many clients are `client_restricted`, so a self-hosted model is a condition to sell (QUESTIONS #362). V13 measures real runs; it cannot compare two configurations on the same work. L02 builds a harness that runs a fixed set of tasks on the sample repository, several times per configuration, and scores the results with tests the agent never sees (QUESTIONS #422, #423).

What exists: `pnpm test:agent-real` drives the OpenHands Agent Server in a `node24` sandbox through the runner (`driveAgent`), with a real LiteLLM, a per-run virtual key from the Cost Controller and spend synced into `cost_records` (ADR-M10 §3, QUESTIONS #78).

## 2. Decision

### 2.1. Reuse an existing framework? (AC9)

The four candidates of D-08 L02, checked on 2026-10-13 (GitHub API: licence, last push):

| Candidate | Licence | Language | Fit |
|---|---|---|---|
| Inspect AI (`UKGovernmentBEIS/inspect_ai`, 0.3.279) | MIT | Python | Strong for agent evals in its own sandboxes and solvers. It would run the agent its own way, not through the platform's runner, Run Contract, egress rules and Cost Controller, and it adds Python to a TypeScript monorepo |
| promptfoo (`promptfoo/promptfoo`) | MIT | TypeScript | Strong for prompt and model matrices with assertions and repeats, and a local viewer. An agent run of several minutes in a container would be a custom provider; hidden-test scoring, pass^k, bootstrap intervals and paired tests are not built in |
| SWE-bench harness (`SWE-bench/SWE-bench`) | MIT | Python | The reference for scoring: `FAIL_TO_PASS` and `PASS_TO_PASS` tests applied to the agent's patch in a fresh container. Built for Python repositories and its own task format |
| Langfuse datasets, experiments and scores | MIT outside `ee/` | TypeScript | Already deployed (profile `observability`, ADR-M35). Useful to store and view scores; does not run agents |

**Decision.** A thin harness of our own in TypeScript that runs each task through the platform's own agent path (`driveAgent`, the sandbox, LiteLLM, the Cost Controller), so the numbers describe what the platform runs. Reused, not rebuilt:

- the SWE-bench scoring model (hidden `fail_to_pass` and `pass_to_pass` tests on the agent's diff, in a fresh container);
- Langfuse datasets and scores for storing and viewing results: **later** (QUESTIONS #446), after a check of that API on the pinned Langfuse v4 in `events_only` mode. Until then the report (JSON, Markdown, an SVG chart) is the only output;
- the statistics are standard formulas (§2.5), implemented and unit-tested, not a new method.

Inspect AI and promptfoo stay options for prompt-only comparisons later; neither is added now.

### 2.2. Where it lives and how it runs

- `pnpm eval --out <folder> [--config <file>] [--configurations <ids>] [--tasks <ids>] [--n <runs>]` and `pnpm eval --check`. The pure parts (tasks, configurations, run results, the scoring script, the base) are `platform/eval/src/`, a TypeScript project in the root `tsconfig.json` (like `platform/deploy/doctor`), not a workspace package. The runs are a live test, `platform/tests/integration/eval/eval-run.test.ts`, started through `test-db.sh` like `test:agent-real`, so they reuse the live tests' set-up (a throw-away PostgreSQL, the sandbox image, the relay, the agent helpers).
- **The agent works as on a real run**: the sandbox reaches LiteLLM and the package proxy only (Verdaccio, its storage in the volume `sdlc-eval-npm-cache`), so it can run `pnpm install` and the tests, as `AGENTS.md` tells it.
- **The scoring container** (`sdlc-eval-base:<commit>`, built once with the packages installed) runs code the agent wrote: `--network none`, `--cap-drop ALL`, `no-new-privileges`, the user `node`, memory, CPU, process and time limits. It applies the base and the agent's diff, runs the repository's checks, `pass_to_pass`, then copies the hidden files in and runs `fail_to_pass` and ESLint on the changed files, and writes exit codes and a count only.
- **Developer machines only, never in CI.** It needs Docker, internet (the sample repository at a pinned commit, as `test:proposal-pilot`) and the models. No secret for local models; a run with an API model is started by the owner in a terminal (the key comes from OpenBao as in `test:agent-api`).
- **Runner and agent only, not G1–G8** (QUESTIONS #436): gates are not what is measured. The harness computes the file scope (`checkScope` against the task's plan) and runs the repository's CI commands itself.
- Results are written per run to `--out` (outside the repository), so a stopped evaluation continues where it stopped (QUESTIONS #437).
- `--check` checks the task set itself: each task's `solution.patch` (a reference fix, never given to the agent) resolves it, and the base without a change fails its hidden tests. A new or changed task must pass it.

### 2.3. The task set (AC1, AC8)

- Task set version 1: 8 tasks on `pilot-order-inventory` at commit `7d5341d`, all in `apps/api`: 4 seeded bugs (`findShortages`, `mergeRequests`, `likePattern`, `formatOrderNumber`) and 4 features in the shapes of T02, T05, T06, T08, each naming the function the hidden tests call. Screens, migrations and database tests are not in v1: their tests need a browser or PostgreSQL in the scoring container (a later version).
- Each task: the spec and the plan the agent gets, the base commit (or a seed patch for a bug), and **hidden tests**: `fail_to_pass` (the new behaviour) and `pass_to_pass` (what must not break). The agent never sees them: they are copied into a fresh container with the agent's diff after the run.
- Tasks live in `platform/eval/tasks/v1/` (QUESTIONS #435). The repository is public, so a model may have seen them; `SDLC_EVAL_TASKS_DIR` points at a private task set outside the repository. Every report names the task set version; new tasks go into a new version.

### 2.4. A configuration and the measures (AC2, AC3, AC6)

- A configuration = agent × model × instructions version, in a YAML file; one factor changes at a time between two configurations that are compared.
- Each task runs N times per configuration (default 5, QUESTIONS #437).
- Per run, numbers and codes only: hidden tests passed (resolved), CI commands passed on the first try, scope breach, stop reason, new static-analysis findings (count), diff size (files, lines), wall-clock time, model calls, input, output and cached tokens, cost (the internal cost for self-hosted models, D-07 §3).
- **The report never holds prompts, task text, code or diffs** (AC6). One exception, for blind pairs only (QUESTIONS #445): each run's diff is kept on the developer's machine in `<out>/diffs/` (outside the repository, folders 700, files 600), never in a result, the report, Langfuse or a commit; `pnpm eval:pairs purge-diffs` deletes them. The sample repository is fictional, so they hold no client data.
- Models (QUESTIONS #439): `gpt-oss:20b` and `qwen3:8b` (`platform/eval/configs/local.yaml`), pulled on the owner's machine. `qwen2.5-coder:7b` was tried first and dropped: it made no tool call through OpenHands, so every run ended after one reply with no change (2026-10-13, one run per task). A first `qwen3:8b` run called the tools 26 times and reached the 20-minute cap without a change; never an Ollama `:cloud` model (the configuration loader refuses one). **No 30B model on the owner's machine** (24 GB of memory, with Docker, LiteLLM and the sandbox): the report says so; a larger machine or L01 measures it. The provider `stub` checks the harness itself. API models (`claude-haiku-4-5-20251001`) come in a later PR: the run needs the key from OpenBao, started by the owner in a terminal.

### 2.5. Statistics and the report (AC3, AC4)

- Per configuration and task: resolve rate, pass@k with the unbiased estimator `1 − C(n−c, k) / C(n, k)`, and pass^k estimated as `C(c, k) / C(n, k)` (all k runs pass).
- Confidence intervals by bootstrap over tasks; a paired comparison of two configurations on the same tasks with McNemar's test on resolved / not resolved.
- A quality-against-cost (Pareto) chart; a short result table for leadership that L01 and L03 use. The report does not call a difference when the intervals overlap.

### 2.6. Pairwise ranking and the judge (AC5, AC7)

- **Blind pairs** (AC7): `pnpm eval:pairs --out <folder> --a <id> --b <id>` shows a reviewer the kept diffs of two configurations for the same task and run, as A and B in a random order per pair, on the reviewer's machine only; the reviewer picks A, B or a tie (or skips). The choices file `<out>/pairs/v<set>.jsonl` holds codes only (task, run, the two configurations, the winner). They give a Bradley-Terry ranking (MM algorithm; ties half a win; one virtual tie per compared pair so the ranking stays defined) next to the automatic scores.
- **LLM judge** (AC5): deferred (QUESTIONS #438). Tests and blind pairs are enough for the GPU decision; a judge is added later, measured against human scores first.

### 2.7. Pull requests

| PR | Content |
|---|---|
| 1 | This ADR, QUESTIONS #435–#439 (docs only) |
| 2 | The harness, task set v1, configurations, per-run measures; unit tests, a live run on the stub model |
| 3 | Statistics, the report and chart (`pnpm eval:report`), blind pairs and Bradley-Terry (`pnpm eval:pairs`), kept diffs (QUESTIONS #445); Langfuse scores later (QUESTIONS #446) |
| 4 | The result table in D-07 §9 from the evaluation that was run (53 of 80 runs, stopped by Harry's decision, QUESTIONS #447; Harry approves) |

## 3. Consequences

- The numbers describe the platform's own agent path, so they can be compared with V13's numbers from real runs.
- A full evaluation takes hours on a developer machine; `--tasks` and `--n` make small runs possible.
- A developer machine may not run a 30B model; the report then states which sizes were measured.

## 4. Alternatives not chosen

| Alternative | Why not |
|---|---|
| Inspect AI as the runner | Runs agents outside the platform's runner and contract; adds Python |
| promptfoo as the runner | Built for prompts and model matrices; hidden-test scoring and the statistics would be written anyway |
| The full G1–G8 pilot stack per run | Gates are not measured; much slower (QUESTIONS #436) |
| Tasks only inside the public repository | A model may have seen them; a private set must be possible (QUESTIONS #435) |
| An LLM judge as a main score | Needs calibration against people first (QUESTIONS #438) |

## Version history

| Version | Date | Author | Notes |
|---|---|---|---|
| 0.1 | 2026-10-13 | Claude (task L02, PR 1) | First version |
| 0.2 | 2026-10-13 | Claude (task L02, PR 2) | §2.2–§2.4 as built: the live test runs the evaluation, the package proxy for the agent, the scoring container's limits, `--check`, task set v1, the models and the 24 GB limit; API models later |
| 0.3 | 2026-10-13 | Claude (task L02, PR 3) | §2.1 Langfuse later (QUESTIONS #446); §2.4 kept diffs for blind pairs (QUESTIONS #445); §2.6, §2.7 as built |
| 0.4 | 2026-10-13 | Claude (task L02, PR 4) | §2.7: PR 4 as built: the first measurement of local models is in D-07 §9 with its limits; the evaluation was stopped at 53 of 80 runs (QUESTIONS #447) |
| 0.5 | 2026-10-16 | Harry | Accepted (the design is built and merged; open items stay follow-ups) |
