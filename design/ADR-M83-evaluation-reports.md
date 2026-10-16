# ADR-M83. Evaluation reports and recommendations for managers

| Item | Value |
|---|---|
| Status | **Accepted** (Harry, 2026-10-16; task L06) |
| Date | 2026-10-16 |
| Decided by | Harry (L06 plan approved 2026-10-16, with answers to QUESTIONS #480–#481) |
| Related | D-08 task L06 (AC1–AC5); ADR-M78 §2.5 (statistics, report), ADR-M81 (evaluations on the server), ADR-M82 (evaluation plans), ADR-M79 (V13, real-run numbers), ADR-M31 (the agent register); QUESTIONS #438, #450, #465, #480–#482 |

## 1. Context

L04 and L05 run evaluations on the server, and the dashboard shows an evaluation's runs, spend and budget. A manager still cannot read what the results mean. L06 adds the report of an evaluation (dashboard first, QUESTIONS #465; the CLI gives the same data) and recommendations made by fixed rules. A recommendation must never claim what the data does not show.

## 2. Decision

### 2.1. Where the code lives (QUESTIONS #480)

- The report of a server evaluation and the recommendation rules are pure functions in `@sdlc/eval`, next to `stats.ts` and `report.ts`. Developer machines and the server use one engine (ADR-M81 §2).
- `@sdlc/core` reads the rows of `evaluation_run_results` through `PlatformDatabase.forTenant` (numbers and codes only). It does not depend on `@sdlc/eval`.
- The api and the CLI put the two together. D-08 L06 named `core` for the recommendations; this ADR replaces that.

### 2.2. The report (AC1)

- Per configuration: resolve rate with its bootstrap interval, pass@k and pass^k, CI on the first try, runs stopped at a cap, scope breaches, cost per resolved task (decimal string).
- Paired comparisons of configurations on the same tasks (McNemar).
- Next to it, the V13 numbers of real runs for the same agents and models (ADR-M79), read from the existing metrics.
- The dashboard page is read-only, in plain words, every number with its interval. Numbers and codes only; no prompt, task text or diff.
- A notice when an evaluation ends (QUESTIONS #482): no new channel and no new table. `GET /v1/evaluations/recent` lists the evaluations that ended in the last 7 days in the projects where the caller has a role in `access.eval_roles`; the dashboard shows them, and `sdlc next` without an intent prints them.
- As built (PR 2): `GET /v1/evaluations/:code/report` (anybody with a role on the project; no role → 404). The real-run numbers are the V13 rows of the last 30 days for the evaluation's models, only for a caller with a role in both `access.cost_read_roles` and `access.metrics_read_roles`; otherwise `real_runs` says `no_role`. The CLI: `sdlc eval report <EVAL-…>`.
- As built (PR 3): the report is part of the screen of one evaluation (`#/evaluations/EVAL-…`), below its runs and spend; the Evaluations page shows the evaluations of `GET /v1/evaluations/recent` when there are any. The dashboard reads the two GET routes of PR 2 only; it adds no endpoint and no write. Recommendation texts come from the same catalog keys as the CLI (a test checks that the dashboard's rule keys equal those of `@sdlc/eval`).

### 2.3. Recommendation rules (AC2, QUESTIONS #481)

Rules are fixed code, each with a message key in `@sdlc/messages`. Each recommendation quotes the numbers and intervals it rests on.

| Rule | Fires when |
|---|---|
| `cheaper_model_no_difference` | A cheaper configuration shows no difference in resolve rate on at least `min_paired_tasks` paired tasks |
| `low_ci_first_try` | The CI-on-the-first-try rate is below `low_ci_first_try_rate`: add the checks to the instructions |
| `unstable_results` | pass@k minus pass^k is at least `unstable_gap` |
| `stopped_at_cap` | The share of runs stopped at a cap is at least `stopped_at_cap_share` |
| `scope_breach` | Any run breached its scope |

Guards:

- **One test for a difference.** Only one function says two configurations differ: McNemar's exact test below `alpha` **and** bootstrap intervals that do not overlap. Every rule that compares uses it.
- **A minimum sample.** A comparing rule fires only with at least `min_paired_tasks` paired tasks.
- **Words state the limit.** The text says "no difference found on N tasks", never "as good as". It always quotes both resolve rates, their intervals and p.
- **Thresholds are configuration**, never hard-coded. Defaults [Proposal]: `alpha` 0.05, `min_paired_tasks` 8, `low_ci_first_try_rate` 0.5, `unstable_gap` 0.3, `stopped_at_cap_share` 0.2. The configuration keys are chosen in PR 1.

### 2.4. A recommendation is a proposal only (AC3, AC4)

- A change of model or prompt still goes through the agent register: a new version, approvals, 2+N (ADR-M31). The platform never applies a recommendation.
- Recommendations written by a model come later, only after they are checked against people's judgement (as the LLM judge, QUESTIONS #438).

## 3. Consequences

- One engine for the statistics on developer machines and the server.
- Few tasks give few recommendations; this is intended.

## Version history

| Version | Date | Author | Notes |
|---|---|---|---|
| 0.1 | 2026-10-16 | Claude (draft) | Decisions of QUESTIONS #480–#481 |
| 0.2 | 2026-10-16 | Claude (draft) | §2.2: the notice (QUESTIONS #482) and the API and CLI as built (PR 2) |
| 0.3 | 2026-10-16 | Claude (draft) | §2.2: the dashboard as built (PR 3) |
| 1.0 | 2026-10-16 | Harry | Accepted |
