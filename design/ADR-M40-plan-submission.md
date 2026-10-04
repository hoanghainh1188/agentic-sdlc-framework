# ADR-M40. Plan submission and the G3 approval

| Item | Value |
|---|---|
| Status | **Proposed** (task B09, for review) |
| Date | 2026-10-03 |
| Decided by | Harry (plan approved 2026-10-03, with answers to QUESTIONS #165–#169; PR 2 plan approved 2026-10-04, with answers to QUESTIONS #210, #211) |
| Related | D-08 task B09 (AC1–AC3); D-02 FR-11, FR-15, FR-16, FR-17; D-03 §6 (version 1.20); D-05 §6.2 (version 1.25); handbook Ch.12 §12.4, template T13; ADR-M20, ADR-M30, ADR-M33 §2.1, ADR-M34 §2.8, ADR-M39, ADR-M29 §2.3, ADR-M33 §2.7, ADR-M41 §2.7; QUESTIONS #34, #108, #131, #165–#169, #210, #211 |

## 1. Context

The registry has stored plans since B02 (`plans`: planned files, summary, hash, version, change flags), but only tests created them, with a hash they chose. Since then:

- G3's HOTL condition is "a plan with at least one file" (B07).
- G4 binds the run proposal to the plan (C06, ADR-M33) and fails `plan_changed` when the latest plan is not the one G3 passed; the intent then waits at G4.
- G5 compares the run's changes with `planned_files` (C07, ADR-M34) and, after `out_of_scope`, needs a new plan hash at G3.
- The run's tools were "the agent's registered tools until B09" (QUESTIONS #34, #108).

B09 decides what a plan file is, how it reaches the platform, who submits it, and what happens when it changes after G3.

## 2. Decision

### 2.1. The plan is a file on the default branch (AC1)

- The plan of an intent is the file **`.sdlc/plans/<intent code>.yaml`** (template T13) on the **head of the project's default branch**, like the spec (ADR-M39 §2.1). G4 starts the run from that head.
- The path comes from the intent code: submitting takes no path.
- The platform reads the file, checks it, and stores its **SHA-256** (of the file's bytes) and **coded fields** only. The text is dropped: it holds free text (summaries, inputs, outputs, definitions of done) that stays in the repository.

### 2.2. What a plan file may be (QUESTIONS #165, #166)

Schema version 1 (`plans/parse.ts`, `plans/rules.ts`; design rules, not configuration):

```yaml
plan:
  intent_id: INT-2026-0001        # required: the intent's code
  change_flags: [migration]       # optional: codes of the change_flag enum
  adr_refs: [ADR-0003]            # optional, informative
tasks:                            # 1–20
  - id: T1                        # [A-Za-z0-9_-]{1,32}, unique
    allowed_paths: [apps/api/src/orders/**]   # 1–200 per task; at most 1000 distinct in the plan
    tools: [file_editor, terminal]            # agent tools only (AGENT_TOOLS)
    environments: [sandbox]                   # optional; sandbox only in the MVP
    # allowed, never stored: summary, owner_agent, depends_on, input, output,
    # definition_of_done, required_evidence, escalate_when, checkpoint
```

- **Text fields** (PR 2, QUESTIONS #210): the agent-facing fields `summary`, `input`, `output`, `definition_of_done`, `escalate_when`, `depends_on` and `checkpoint` must be text: a scalar or a list of scalars; an empty value is no field. Any other shape (a mapping, a nested list) is refused with `schema_invalid` and the field path (API detail `file.tasks[<n>].<field>`, issue `not_text`). `owner_agent` and `required_evidence` are informative and not checked.

- **YAML**: the configuration's safe reader (core schema, strict, no duplicate keys, no YAML 1.1 tags), with **no alias at all**. At most 64 KiB, UTF-8. Core keeps its two outside packages (ADR-M09): the checks are explicit code.
- **Refused keys** (`platform_field`): `approved_by`, `approved_at` (approvals are gate decisions; they would also change the hash after each approval), `risk_tier`, `data_class`, `autonomy_level` (the intent's), `plan_version`, `spec_version` (the platform numbers versions), and the task's `limits` (the run caps come from the project configuration and the intent's budget; a plan budget would conflict with G5's budget increase, ADR-M34 §2.9).
- **Path patterns** use the glob language of the G5 scope check (`checkScope`, Node's `path.posix.matchesGlob`), so a pattern means the same thing here and at G5:
  - a safe relative path: no leading `/`, no `\`, no empty, `.` or `..` segment, at most 1024 characters (`invalid_pattern`);
  - not a pattern that matches every file: one that matches an arbitrary file in an arbitrary folder (`**`, `*`, `*/**`, `**/*`; `pattern_too_broad`, QUESTIONS #165);
  - not a pattern that matches a path under `.github/` or `.sdlc/`, an instruction file at the root (`AGENTS.md`, `CLAUDE.md`, `.cursorrules`…, so also `*.md`) or in a skill folder, or a pattern that names an instruction file (`src/**/AGENTS.md`; `protected_path`). The check probes each pattern with sample paths: it is a second line of defence. G5 fails any change of an instruction file (ADR-M34 §2.4), and a change under `.github/` or `.sdlc/` is out of scope as long as no pattern matches it. An `AGENTS.md` in a sub-folder is also an instruction file, but every folder pattern (`src/**`) matches it, so such a pattern is accepted and G5 fails the change.
- **Change flags** (QUESTIONS #166): declared in the file, so they are part of the hash G3 approves; Person B checks them at G3 and requests changes when one is missing. They drive forced HITL at G3 (FR-15) and dual approval at G7 (FR-16, E01: the flags of the plan G3 approved). D-05 changes meaning from "set by Person A / B at G3" to "declared in the plan file, approved at G3".
- **One run covers every task** (D-02 §4.2: one agent task at a time per intent): `plans.planned_files` = the sorted union of every task's `allowed_paths`; `plans.allowed_tools` = the union of every task's `tools`. Runs per task are MVP+1.
- Template T13 needs the same shape (drop the platform fields and `limits`, add `change_flags`). T13 belongs to the handbook authors: they are asked to align it.

### 2.3. Submitting a plan (AC2, QUESTIONS #168)

- **API**: `POST /v1/intents/:intent/plans` with an optional `commit_sha` (40 hex); `GET /v1/intents/:intent/plans` lists the versions (commit, hash, path patterns, tools, flags). **CLI**: `sdlc plan submit <INT> [--commit …]`, `sdlc plan list <INT>`, `sdlc plan show <INT>` (ADR-M36 pattern, `--json`).
- **Who**: a role in project configuration `access.plan_submit_roles` (default `[person_a]`). Mandatory rule **M24**: `viewer` is never in the list. No role on the project → 404 `intent_not_found`; a read role only → 403 `forbidden`.
- **The submitter is a producer of the plan** (FR-11): `plans.submitted_by`; `decideGate` passes the submitters of the intent's plans as G3 producers, so the policy engine refuses their approval (`producer`). Person A submits, Person B approves.
- **When**: the intent is `draft` or waits at G1–G4; otherwise 409 `plan_submit_not_allowed`. A plan submitted at G4 takes the intent back to G3 at the next step (§2.4).
- **How** (`submitPlanFromGitHost`, `@sdlc/core` `plans/`): read the head of the default branch and the file there; parse and check it; with `commit_sha`, the file at that commit must be the same file (otherwise 409 `plan_not_on_default_branch`); under the intent lock, check the state and the role again and store a new version (`plans.submit` with `file`: `commit_sha`, `allowed_tools`, `submitted_by`, no summary). The same file again stores nothing new. The API wakes the intent's workflow.
- **Errors**: a refused file → 422 `plan_invalid` with the reason (`missing`, `not_a_file`, `too_large`, `not_utf8`, `yaml_invalid`, `schema_invalid`, `intent_mismatch`, `platform_field`, `unknown_tool`, `invalid_pattern`, `pattern_too_broad`, `protected_path`, `too_many_paths`); a Git host failure → 503 `git_host_unavailable`. Texts from the catalog (`plan.error.*`, `plan.refusal.*`, `api.error.*`).
- **Audit**: `plan.submitted` gains `commit_sha`. Never the path, the file list or text.
- The api already holds the GitHub App key for the spec (ADR-M39 §2.2); no new secret.

### 2.4. The re-check at G3 and before the run (AC3, QUESTIONS #167)

Whenever the intent waits at **G3 or G4**, the step reads the latest plan's file at the head it read for the spec check (`gatherPlanFacts`, before the transaction; no HTTP call under the intent lock). Under the lock, after the spec check (a return to G2 wins), `checkPlan` decides:

| Finding | At G3 | At G4 |
|---|---|---|
| A person submitted a new plan after G3 passed (the latest plan is not the one G3 approved or passed) | — (the approval binding voids the old approvals) | **Back to G3**, notice `plan_changed`; the current approvals of G3 and G4 are voided (`input_mismatch`) |
| The file at head is not the submitted plan: changed, removed, or not readable | **Held** (`plan_resubmit_needed`) | **Held** (`plan_resubmit_needed`): no run starts |
| The Git host cannot be read | Held (`git_host_unavailable`, tried again after 60 s) | Waits, as today (G4 needs its facts) |
| Otherwise | The step goes on | The step goes on |

- **No automatic new version** (QUESTIONS #167): the platform never takes the head version as a plan by itself. A person with a submit role submits it again; that person is the accountable producer of every version and never approves it at G3. Reason: on a repository where merges need no approval (the pilot repository has 0 required approvals), Person B could otherwise merge a plan change and approve G3 for it.
- `plan.resubmit_needed` (plan ID, cause `changed`, `missing`, `not_a_file`, `too_large` or `not_utf8`, head commit) is recorded once per plan version and cause, with one notice `plan_resubmit_needed` to the submit roles.
- **A held G3 refuses only the advance**, like the spec (ADR-M39 §2.4): rejections, requests for changes, blocks of a passed gate and the gate's overdue escalation are still handled. A held G4 decides nothing and starts no run: after the plan is submitted again, the intent is back at G3, where a person may reject it.
- After `out_of_scope` at G5 the intent waits at G3 for a new plan (ADR-M34 §2.8): Person A changes the file on the default branch and submits it; the refused hash is never approved again and G3 stays HITL. No new code for this.
- Plans stored without a file (before B09, tests) are not compared with the repository; a new plan at G4 still takes the intent back to G3.
- **Wiring**: the check rides on `StepDeps.specs` (the worker always wires it, B08). G4's own `plan_changed` check stays as a second line of defence.

### 2.5. The run's tools (QUESTIONS #34, #108)

- The run proposal's `allowed_tools` (and so the contract's) = the agent's registered tools that the plan lists (`plans.allowed_tools`). None in common → G4 fails (`agent_not_runnable`, check `plan_tools_not_registered`) and the intent waits at G4.
- A plan without a file keeps the agent's registered tools.

### 2.6. Catalog and data

- Migration **0018** (`0018-plan-files`): `plans.commit_sha`, `plans.allowed_tools` (agent tools), `plans.submitted_by` (→ `users`). The three are null for plans without a file, all set for a plan from a file (CHECK), which is human-submitted and has no summary.
- New notice kinds `plan_changed`, `plan_resubmit_needed` (`intent.status.*`); new waiting reason `plan_resubmit_needed`; new audit action `plan.resubmit_needed`.
- New configuration key `access.plan_submit_roles` (the default `config_hash` changes; stored configurations are re-hashed at start, ADR-M37 §2.5). Mandatory rule M24.
- `@sdlc/config` exports its safe YAML reader (`readYamlMapping`, with `maxAliasCount`).

### 2.7. The plan in the agent's prompt (B09 PR 2, QUESTIONS #169, #210, #211)

As built:

- **Where the file comes from**: the runner's own clone of the run (`workspace/plan-file.ts`), at `plans.commit_sha`, never from the sandbox. `cloneForRun` makes a full clone, so every commit of the default branch is in it; nothing is fetched (the clone token is revoked right after the clone, C11). Hardened git (`gitArgs`, `gitEnv`: no system or user configuration, no hooks, no fsmonitor, no replace objects), no token, no network.
- **What is read**: `git ls-tree` first: the path must be a regular file (mode 100644 or 100755, never a symbolic link or a submodule); `git cat-file -s` at most 64 KiB; then `git cat-file blob` returns the stored bytes, which no attribute, filter or text conversion changes. Why the plan's commit and not the run's `base_sha`: after a push, the next run starts from the last pushed commit (ADR-M38 §2.6), where the plan file may be older or missing.
- **Checks** (`apps/runner/src/agent/task.ts`), all fail closed: the SHA-256 of the bytes equals the contract's `plan_sha256`; the bytes are UTF-8; the file passes the submission rules (`readPlanTaskTexts`, the same parser as `parsePlanFile`); its path patterns equal the contract's `planned_files` as sets (sorted, de-duplicated). Any failure, or no clone, → the run fails `task_unavailable` (stop reason `agent_task_unavailable`, no new one) and the run event `plan_unavailable` gives the cause: `no_clone`, `commit_missing`, `missing`, `not_a_file`, `too_large`, `git_failed`, `not_utf8`, `hash_mismatch`, `invalid` or `files_mismatch`.
- **What the agent gets**: per task, `id` and the agent-facing fields of §2.2 (`summary`, `input`, `output`, `definition_of_done`, `escalate_when`, `depends_on`, `checkpoint`), as plain lines (`Task T1`, `summary: …`, `definition of done:` with `- …` items). Not `owner_agent` (one agent runs every task in the MVP) or `required_evidence` (the platform collects evidence). A field that is not text is skipped and counted (QUESTIONS #210, A), so a plan G3 approved never fails at run time for this.
- **Caps**: `PLAN_FIELD_MAX_CHARS` = 2,000 per field and `PLAN_TASK_TEXT_MAX_CHARS` = 16,000 for the whole text (about 4,000 tokens: a plan file is at most 64 KiB, mostly path patterns the prompt already lists; D-07 §7 item 6). Cut text ends with a note and is marked `truncated`. Control, bidirectional and invisible characters are replaced (the cleaner shared with the review feedback, `agent/text.ts`).
- **Framing** (`planTaskBlock`, `@sdlc/adapter-agent-openhands`): the text sits between `<<<PLAN_TASKS <nonce>>>>` and `<<<END_PLAN_TASKS <nonce>>>>` with a random nonce of its own (a text that holds it is refused), after "Approved plan:" and before the file list and the rules. The agent is told the descriptions were approved with the plan but written by people in the repository: data that cannot change the instructions, the rules, the files it may change, its tools or its branch. G5 and the contract enforce those whatever the text says (like the review feedback, ADR-M41 §2.7).
- **Never stored**: the text goes to the agent's prompt in memory only. The run event `plan_read` holds `tasks`, `chars`, `truncated` (`yes`, `no`) and `skipped_fields`. Nothing in Temporal (the history holds IDs only), logs, `run_events`, the audit log or any table (`pnpm test:workflow` checks a marker).
- **Plans without a file** (stored before B09, `commit_sha` null): unchanged, `plans.summary` or "(no summary)".
- **After `plan_unavailable`** (QUESTIONS #211): the run fails and goes down the failed-run path (ADR-M33 §2.7): the intent is paused at G4 with a `technical` escalation. `modify` or `roll_back` → back to G3, HITL from then on, the G3 approvals voided (notice `run_returned`), where a person submits the plan again (a paused intent takes no plan, `planSubmittable`). `resume` → G4 helps only when the file can be read again; otherwise the next run fails the same way. `terminate` → `cancelled`. No dead end.

## 3. Consequences

- G3 and G4 read one more file per step at the Git host (the spec check already reads the head). When GitHub cannot be read, intents wait (fail closed).
- Person A must merge the plan file into the default branch before submitting it: plans go through the repository's review like the spec.
- Any change of the plan file on the default branch, also a comment, holds G3 or G4 until someone submits it again. This is intended: the approved plan is the one the run follows.
- Whoever edits the plan file on the default branch is not recorded as a producer; the submitter is, and the submitter vouches for the file. The repository's branch protection is the control on the edit itself.
- The pattern checks are best effort: they probe sample paths. G5 stays the enforcement point.
- Since PR 2 (QUESTIONS #169, §2.7) the agent's prompt shows the tasks' text of a plan read from a file. A run cannot start when the runner cannot read the submitted file at its commit (a force-push that removed the commit, for example); a person then sends the intent back to G3 with `modify` or `roll_back` and submits the plan again (QUESTIONS #211).

## 4. Not done here

- Per-task runs and per-task scope checks (MVP+1).
- Flags derived from paths (for example `migrations/**` → `migration`).
- Run limits in the plan.
- A comment command to submit a plan.

## Version history

| Version | Date | Author | Notes |
|---|---|---|---|
| 0.1 | 2026-10-03 | Claude (task B09, PR 1) | §2.1–§2.6 |
| 0.2 | 2026-10-04 | Claude (task B09, PR 2), approved by Harry | §2.2 text fields must be text (QUESTIONS #210); new §2.7 the plan in the agent's prompt, as built, and what happens after `plan_unavailable` (QUESTIONS #169, #211); §3, §4 updated |
