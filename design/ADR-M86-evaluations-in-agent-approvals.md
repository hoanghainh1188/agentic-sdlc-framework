# ADR-M86. Evaluations in the agent register's approvals and recertification

| Item | Value |
|---|---|
| Status | **Accepted** (repository owner, 2026-10-20; design task L08, built by L09 and L10) |
| Date | 2026-10-20 |
| Decided by | The repository owner (L08 plan approved in the session, 2026-10-20, with answers to QUESTIONS #496–#500) |
| Related | D-08 task L08 (AC1–AC2), then L09 and L10; D-02 FR-11, FR-36; handbook Ch.20 §20.5b–§20.11; ADR-M31 (the agent register), ADR-M37 §2.8 (approvals, `agent_approvals`), ADR-M78 §2.5 (statistics), ADR-M81 (evaluations on the server), ADR-M82 (plans), ADR-M83 §2.3 (the one test for a difference), ADR-M85 (a project's task set); QUESTIONS #450, #496–#500 |

## 1. Context

Handbook Ch.20 asks for an evaluation before an agent is approved (§20.6–§20.7, §20.9) and for a recertification every 3 months (§20.8). The platform has both halves, but they are not connected:

- The register (ADR-M31, ADR-M37 §2.8) records approvals by capacity. It looks at no evaluation.
- `recertify` only records a date. It checks nothing about quality.
- Evaluation plans (ADR-M82 §2.1) accept only `active` agents. A new version is `proposed` or `suspended`, so it cannot be evaluated as an agent of the register.
- To change an active agent, the owner suspends it first (ADR-M31 §2.3). An evaluation that runs while the agent is suspended stops its real runs for hours.

L08 designs the connection. It adds no code (AC2). L09 and L10 build it.

## 2. Decision

### 2.1. An evaluation result belongs to a fingerprint

The **fingerprint** of an agent version is:

- `model_ref` (the gateway model name, with its version, ADR-M31 §2.4);
- the SHA-256 of its instructions file (`instructions_sha256`);
- the SHA-256 of its sorted `allowed_tools`.

A configuration of an evaluation has the same fingerprint, from what the evaluation resolved and stored when it started (`evaluation_configurations`). An evaluation counts as evidence for an agent version only when one of its configurations has exactly that fingerprint.

- This lets the owner evaluate a change **before** suspending the agent: a plan configuration "model by name + prompt variant" (ADR-M82 §2.1, §2.3) has the fingerprint of the next version. Real runs go on during the evaluation.
- The agent runtime (the OpenHands image) is not in the fingerprint. All configurations of one platform version run the same image. Known limit: an evaluation made before a platform upgrade still counts after it; the age limit (§2.5) bounds this.
- L09 adds two columns to `evaluation_configurations` (rows are written once): `source` (`agent` when the configuration named an agent of the register by its key, `model` when it named a model, with or without a prompt variant) and `tools_sha256`.

### 2.2. Plans may evaluate agents that are not active (changes ADR-M82 §2.1)

- A plan configuration may name an agent in `proposed` or `suspended`, not only `active`. Never `quarantined` or `retired`: a quarantined agent is reviewed as `suspended` first (ADR-M31 §2.3).
- This is for evaluations only. `checkAgentForRun` (ADR-M31 §2.6) does not change: a real run still needs an `active` agent. An evaluation has its own contract kind (ADR-M81 §2.2), never a Run Contract.
- The `on_change` hash of a plan (ADR-M82 §2.4) covers the version of each of its agents, whatever the status.

### 2.3. A qualifying evaluation

An evaluation **qualifies** for an agent version on a project when all of these hold. Each failed condition has its own code (§2.8).

| Condition | Rule |
|---|---|
| Finished | Status `completed` |
| Same project | The evaluation is of the project whose configuration applies (§2.4) |
| Fingerprint | One configuration has the version's fingerprint (§2.1): the **candidate** |
| Whole task set | The evaluation used every approved task of the project's task set when it started (ADR-M85 §2.10), not a list of chosen task IDs. Exception (QUESTIONS #498): when the project had no approved task at the evaluation's start, a numbered task set (`folder`, for example v1) counts |
| Enough tasks | At least `min_tasks` distinct tasks with a scored run of the candidate |
| Resolve rate | The candidate's resolve rate is at least `min_resolve_rate`. The report quotes it with its bootstrap interval |
| Scope | No run of the candidate breached its scope. This is fixed in code (a safety rule, handbook Ch.20 §20.6), not a setting |
| Not worse | For a change (§2.5): the candidate is **not worse** than the **baseline**, the last approved version of the same agent in the same evaluation. "Worse" is decided only by the one test of ADR-M83 §2.3 (`differs`: McNemar below `alpha` and intervals apart) with the candidate's rate lower. It uses the paired tasks and needs at least `min_tasks` of them |
| Fresh | The evaluation finished no more than the age limit ago (§2.5, §2.6) |
| Latest | It is the **latest** finished evaluation with this fingerprint on this project. Running an evaluation again until one passes does not help |

The numbers are evidence for the approvers. They are not the whole readiness record of Ch.20 §20.7 (safety, security and operations checks stay with people).

### 2.4. Where the thresholds live (QUESTIONS #496, #497, #499)

Agents belong to the tenant, but a task set belongs to a project, and in practice an agent pins one `AGENTS.md`, so one project (ADR-M31 §2.5). The thresholds are therefore **project configuration** of the evaluation's project, a new section `agents.evaluation`. Defaults are [Proposal]:

| Key | Default | Meaning |
|---|---|---|
| `mode` | `warn` | `off`: no check · `warn`: an approval or recertification without a qualifying evaluation is accepted, with a warning in the answer and the result code in the audit · `required`: it is refused |
| `min_tasks` | 8 | Distinct tasks (as `min_paired_tasks` of ADR-M83) |
| `min_resolve_rate` | 0.5 | The candidate's resolve rate (point value) |
| `approval_max_age_days` | 30 | Age limit for an approval |
| `recertification_max_age_days` | 90 | Age limit for a recertification |

- `alpha` is the one of `evaluation.recommendations` (ADR-M83), so the report and the register never disagree on a difference.
- Mandatory rules: `recertification_max_age_days` never more than 90 (as M18 keeps the recertification at 3 months or less); `min_tasks` at least 1; `min_resolve_rate` between 0 and 1.
- Default `warn` first, because most projects have no own task set yet (L07 is new). A later change moves the default to `required`, after an approved handbook change.
- The new section changes the default `config_hash` (QUESTIONS #95).

### 2.5. Approvals name the evaluation (FR-11 unchanged)

- An approval with purpose `activate` (`POST /v1/admin/agents/:key/approvals`, `sdlc admin agent approve`) takes an optional `evaluation_code` (`EVAL-…`; `--evaluation` in the CLI). With `mode: required` it is mandatory.
- The platform checks the evaluation against §2.3 for the agent **as it is now** (its current fingerprint) and the age limit `approval_max_age_days`.
- **One evaluation per round.** All approvals of one round name the same evaluation, or none (only in `warn` mode). A different code is refused (`evaluation_round_mismatch`): each approver confirms the same evidence.
- **First use** (`proposed` → `active`, §20.7): there is no baseline, so "not worse" does not apply; the other conditions do (QUESTIONS #498).
- **A change** (`suspended` → `active`, §20.11): the baseline is a configuration of the same evaluation with `source = agent`, this agent, and the version of the agent's last completed activation round (`agent_approvals.agent_version`). Without that configuration the evaluation does not qualify (`evaluation_no_baseline`). The normal order is: a plan with two configurations (the agent by its key, the next version as a model and a prompt variant), run it, read the report, suspend, update, approve.
- The approvers stay the ones of ADR-M37 §2.8 (owner + Person B for L1–L2 and for a change). The evaluation does not replace a person. The owner, as producer of the change, may start the evaluation: its result is numbers from the platform, on tasks that people who did not produce them reviewed (ADR-M85 §2.6).
- `agent_approvals` gets a nullable `evaluation_id` and a `evaluation_result` code (`passed`, `missing`, or a failing code from §2.8, kept in `warn` mode). The table stays append-only.
- `sdlc admin agent show` (and `GET /v1/admin/agents/:key`) lists, for the current fingerprint, the latest evaluation, whether it qualifies, and the failing codes with their numbers.

### 2.6. Recertification uses evaluation numbers (FR-36)

- `recertify` (`POST /v1/admin/agents/:key/recertify`) takes an optional `evaluation_code`, mandatory with `mode: required`.
- The evaluation must qualify (§2.3) for the **active** version, with the age limit `recertification_max_age_days`.
- **Aging** (Ch.20 §20.8): the platform also compares it with the evaluation recorded at the agent's last activation, on the tasks both share (ADR-M85 §2.9), with the same test. A significant drop refuses the recertification (`evaluation_quality_dropped`; in `warn` mode a warning). Fewer than `min_tasks` shared tasks skip this comparison, and the answer says so.
- The platform **never suspends an agent by itself**. A drop is a fact for the owner and Person B, who may suspend it (§20.9).
- FR-36 does not change: a run of an agent whose recertification is overdue still starts, and the owner gets the warning (ADR-M31 §2.7).
- To keep evidence fresh, the owner makes a plan with a weekly schedule or `on_change` (ADR-M82 §2.4). `sdlc admin agent list --overdue` shows the latest qualifying evaluation of each agent.
- The audit event `agent.recertified` gains the evaluation ID and the result code.

### 2.7. Data, audit, Temporal

- New columns hold IDs and codes only (R030). No model name in audit events (ADR-M31 §2.8): the fingerprint is compared in the database, never written to the audit log.
- `agent.approval_recorded` and `agent.recertified` gain `evaluation_id` (or none) and `evaluation_result`.
- Nothing new goes into Temporal: the checks run in the api's transaction.

### 2.8. Refusal codes

`evaluation_missing`, `evaluation_not_found`, `evaluation_not_completed`, `evaluation_other_project`, `evaluation_not_matching` (no configuration with the fingerprint), `evaluation_task_set_partial`, `evaluation_too_few_tasks`, `evaluation_below_threshold`, `evaluation_scope_breach`, `evaluation_no_baseline`, `evaluation_worse_than_baseline`, `evaluation_too_old`, `evaluation_not_latest`, `evaluation_round_mismatch`, `evaluation_quality_dropped`. In `required` mode they answer `agent_refused` (409) with the code as `reason` and its catalog text quoting the numbers (ADR-M37 §2.8). In `warn` mode the same text is a warning.

## 3. Tasks (QUESTIONS #500)

| Task | Content |
|---|---|
| L09 | §2.1–§2.5, §2.7–§2.8: the fingerprint columns, plans with non-active agents, the configuration section, the check of an approval, `show`, the API and CLI, handbook Ch.20 §20.5b |
| L10 | §2.6: the recertification check, the aging comparison, `list --overdue`, handbook Ch.20 §20.5b and §20.8 usage |

## 4. Alternatives not chosen

| Alternative | Why not |
|---|---|
| Thresholds in a tenant configuration | It does not exist yet (ADR-M37 §2.8) |
| Thresholds in code | Handbook rules belong in configuration (`CLAUDE.md`) |
| `required` at once | Blocks every approval in projects without a task set |
| A table of "candidate versions" next to `agents` | More schema; the fingerprint of a plan configuration gives the same evidence without a suspend gap |
| Evaluate only while suspended | Stops real runs for the whole evaluation |
| Any passing evaluation counts | Invites running it again until one passes; the latest one counts |
| The platform suspends an agent whose quality dropped | A person decides (Ch.20 §20.9); the platform reports |

## 5. Consequences

- ADR-M82 §2.1 changes in one point: plan configurations may name `proposed` and `suspended` agents (§2.2).
- ADR-M31 and ADR-M37 §2.8 stay valid; their approvals gain evidence.
- D-05 §6.1 (`agent_approvals`) and §6.9 (`evaluation_configurations`) change in L09.
- A project without its own task set uses a numbered set until it has one.

## 6. As built

### 6.1. L09 PR 1: the fingerprint, plans with agents that are not active, the configuration

- Migration `0036-evaluation-fingerprints`. `evaluation_configurations` gains `source` (`agent` or `model`), `tools_sha256` and also `allowed_tools`, the list itself (QUESTIONS #501): the runner gives the agent the tools the evaluation recorded at its start. `tools_sha256` is the SHA-256 of the sorted list as JSON (`toolsSha256`, `platform/packages/core/src/agents/fingerprint.ts`). All three are null on rows written before the migration; those never match.
- The tools in the runs (QUESTIONS #501, changes ADR-M78 for plans only): a configuration that names an agent gets that agent's `allowed_tools`; a configuration that names a model gets the tools of the project's default agent (`run.agent_key`). An operator evaluation (L04) keeps the harness's `file_editor` and `terminal`.
- The instructions part (QUESTIONS #502): compared by run. A configuration matches a version when its model and `tools_sha256` match and every scored run of it read instructions with the version's `instructions_sha256` (`evaluation_run_results.instructions_sha256`). No new column.
- `evaluations.approved_tasks_at_start` (QUESTIONS #503): the number of approved tasks of the project, counted in the transaction that starts the evaluation; fixed by the guard trigger (`SDA21`). It decides the exception of QUESTIONS #498.
- `agent_approvals.evaluation_id` (a foreign key with the tenant) and `evaluation_result` (`passed`, `missing` or `evaluation_…`); a named evaluation needs a result. Still append-only.
- Plans (§2.2): `proposed`, `active` and `suspended` agents; a `quarantined` or `retired` agent keeps the refusal code `agent_not_active` (its text now says so). `planFleetSha256` hashes every agent's version, whatever its status, so suspending an agent alone no longer looks like a change to `on_change`; a new version does.
- Configuration `agents.evaluation` (§2.4) with the defaults of §2.4; `min_tasks` 1–1000, `min_resolve_rate` 0–1 and the age limits 1–365 days are checked by the schema; mandatory rule **M34** keeps `recertification_max_age_days` at 90 or less. The default `config_hash` changes.
- The check of an approval, `show`, the API and the CLI come in L09 PR 2.

### 6.2. L09 PR 2: the check of an approval, `show`, the API and the CLI

- `checkAgentEvaluation` (`platform/packages/core/src/agents/evaluation-check.ts`) checks the conditions of §2.3 in their order and returns the first failing code with the numbers its catalog text quotes. It never throws a refusal; `approveAgent` applies the mode.
- Whose configuration (QUESTIONS #504): the agent's projects are the active projects whose effective `run.agent_key` is the agent. The mode is the strictest of theirs (`required` > `warn` > `off`); with none, the default configuration. A named evaluation must be of one of them (`evaluation_other_project`), or of any project when the agent has none. The thresholds and `alpha` come from the evaluation's project. No `--project` option.
- The statistics come from the same engine as the report: `toRunResult` moved from the api to `@sdlc/core` (`evaluation/report-rows.ts`), and the check uses `buildReport` and `differs` of `@sdlc/eval`.
- The baseline of a change is the version of the latest `activate` round with approvals in two different capacities (every approver set of v0.1 has two). An agent activated before approvals existed has none: a change then gives `evaluation_no_baseline`. Fewer paired tasks than `min_tasks` give `evaluation_too_few_tasks` with the paired count.
- "Latest": the completed evaluations of the same project that ended later (at most 50 are read). A later evaluation of another fingerprint does not count.
- `approveAgent` takes `evaluationCode` (`evaluation_code` in the API, `--evaluation` in the CLI). `off`: nothing checked, nothing recorded. `warn`: the result is recorded and answered (`evaluation` in the round's body; the CLI prints the catalog text as a warning). `required`: anything but `passed` is refused with `agent_refused` (409) and the code as `reason`; `missing` refuses as `evaluation_missing`. A round whose approvals name another evaluation (or none against one) is refused with `evaluation_round_mismatch` in `warn` and `required` mode.
- `agent.approval_recorded` gains `evaluation_id` (when one was found) and `evaluation_result`.
- `GET /v1/admin/agents/:key` (`sdlc admin agent show`) returns `evaluation`: the latest completed evaluation with the agent's current fingerprint in its projects and its check for an approval (`mode`, `code`, `result`, `qualifies`, `params`). For an active agent it is checked as a first use: there is no next version to compare.
- New rule R135 in `platform/apps/api/CLAUDE.md`.

## Version history

| Version | Date | Author | Notes |
|---|---|---|---|
| 1.0 | 2026-10-20 | Claude (task L08), accepted by the repository owner | Design with the answers to QUESTIONS #496–#500 |
| 1.1 | 2026-10-20 | Claude (task L09, PR 1), approved by the repository owner | §6.1 as built, with the answers to QUESTIONS #501–#503 |
| 1.2 | 2026-10-21 | Claude (task L09, PR 2), approved by the repository owner | §6.2 as built, with the answer to QUESTIONS #504 |
