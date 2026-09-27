# ADR-M33. Gate G4: the checks, the run proposal, and the handoff to the runner

| Item | Value |
|---|---|
| Status | **Proposed** (task C06; session 1 in review: the G4 decision and `prepareRun`; session 2: the Temporal `sdlc-runner` handoff, the L1 proposal as evidence) |
| Date | 2026-09-27 |
| Decided by | Harry (plan approved 2026-09-27: QUESTIONS #108–#112, two sessions, with conditions on #111 and #112 and the rule for lost runs, §2.7) |
| Related | D-02 FR-03, FR-17, FR-19, FR-30…FR-36, FR-50; D-03 sections 6, 6.1, 7.1, 8, 8.2, 9 (version 1.11); D-05 sections 5, 6.2, 6.3 (version 1.15); D-08 tasks C06, C07, C08, C09, C11, E02; handbook codes table §3–§4, Ch.13 §13.5 Step 1 and §13.8, Ch.20; ADR-M22, ADR-M24, ADR-M25, ADR-M28, ADR-M29, ADR-M30, ADR-M31, ADR-M32; QUESTIONS #5, #6, #17, #21, #22, #32, #44, #53, #55, #79, #82, #88, #94, #108–#112 |

## 1. Context

G4 is the execution boundary (handbook Ch.13 §13.5 Step 1): before an agent starts, the platform checks the approvals, the agent, the autonomy, the permissions, the environment, the budget and time caps, and the credentials. The codes table (§4) gives the oversight: an automatic policy check at Low and Medium risk, HITL (Person A) at High, and no agent run at Critical.

Earlier tasks built the parts: the Run Contract (C02, ADR-M22), the Cost Controller (C03, ADR-M24), the runner (C04, ADR-M25), the OpenHands adapter (C05, ADR-M29), the agent register (C10, ADR-M31), the intent workflow up to G4 (B07, ADR-M30) and the project AI record (B12, ADR-M32). C06 connects them.

C06 has two sessions:

- **Session 1** (this version): the G4 checks and decisions in the workflow step, `/approve G4`, the run proposal and its hash, `prepareRun` (contract, capped key, wrapped secrets), the recertification warning, `GitHostAdapter.getBranchHead`.
- **Session 2**: the Temporal task queue `sdlc-runner` with one heartbeat activity per run (D-08 C06 AC4, QUESTIONS #53, #55), the workflow handoff (intent G4 → `running` → G5), the contract-expiry re-attempt, the L1 proposal stored as evidence (T09), the worker and runner wiring, the Compose and OpenBao changes, handbook Ch.13 §13.10 (run parts).

## 2. Decision

### 2.1. Which agent, tools and caps (QUESTIONS #108)

- New project configuration `run.agent_key` (default `null`): the registered agent that runs the project's intents. One agent per project in the MVP. With no key, G4 fails with `agent_not_runnable` (check `agent_not_configured`).
- `plans` stores only `planned_files`. Until B09 stores the T13 task fields (owner agent, tools, limits), the plan tools are the agent's registered tools, so `allowed_tools` = the agent's tools (the adapter still refuses anything but `file_editor`, `task_tracker` and `terminal`). B09 adds the plan tools and maps the T13 tool names.
- Caps: `budget.default_run_usd`, `run.default_max_iterations`, `run.default_max_duration_minutes`. The Cost Controller still caps the run's key at the smallest of the run, intent and tenant remainders (ADR-M24).
- Model: the agent's pinned `model_ref` (QUESTIONS #79), which must be among the models the policy allows for the data class. The Ollama model (`gpt-oss-20b`) exists only where `kv/litellm/providers/ollama` exists, which means developer machines (QUESTIONS #78); there is no code path to it on the server.

### 2.2. The facts G4 reads outside the database (QUESTIONS #109)

`gatherG4Facts` runs before the step's transaction, so no HTTP call runs while the intent lock is held:

- `base_sha` = the head of the project's default branch, from the new `GitHostAdapter.getBranchHead(ref, branch)` (D-03 §7.1, version 1.11; GitHub: `GET /repos/{repo}/git/ref/heads/{branch}`, a non-commit object is refused, the branch name is checked before it reaches a URL).
- The SHA-256 of the agent's instructions file at `base_sha` (`getFileAtCommit`, outside the sandbox, ADR-M31 §2.5). A missing file is a fact (G4 fails with `instructions_mismatch`), not an error.
- The models the policy allows for the data class, from the gateway's model list (`G4Deps.allowedModels`, QUESTIONS #17).

When the Git host cannot be read, the step waits (`git_host_unavailable`) and tries again after 60 seconds.

### 2.3. The run proposal and the G4 input hash (FR-17)

- The **run proposal** is the set of terms G4 passes or approves: plan (ID and hash), spec hash, agent ID and version, instructions hash, model, autonomy, tools, allowed models, budget, iteration and time caps, `base_sha` and data class.
- The **G4 input hash** = SHA-256 of the RFC 8785 canonical JSON of the proposal (version 1). Any change of a term, for example a new commit on the default branch or a new agent version, is a new proposal: a G4 approval of the older one is voided (`input_mismatch`) before it counts.
- Each new proposal is recorded in the audit log as `run.proposed` (the input hash, `base_sha`, plan, agent, version, instructions hash, autonomy; never the model name, which the hash covers). A person's G4 decision (`decideGate`) is bound to the last recorded proposal; before the first one, `gate_input_missing`.

### 2.4. The checks and the decisions (QUESTIONS #110)

`evaluateG4` runs the checks in this order, under the intent lock:

| # | Check | Result when it fails |
|---|---|---|
| 1 | Critical risk, or effective autonomy L0 (the stricter of the stored value and the current configuration's, QUESTIONS #22; never above L2) | `block`, reason `policy_denied`; intent `blocked` (final, the workflow ends); notice `blocked`. The agent never runs (FR-03, T10) |
| 2 | The last HOTL block window is closed (ADR-M30 §2.4b) | Wait until it closes (`later_gate`, `wakeInMs`) |
| 3 | Not frozen for `run_start` (ADR-M28 §2.4) | Wait (`frozen`) |
| 4 | The spec and plan are the versions G2 and G3 passed (Ch.13: approved "for these exact versions") | `fail`, `input_mismatch` (`spec_changed`, `plan_changed`). B08 and B09 add the send-back to G2 or G3 |
| 5 | The project AI record allows the data class (FR-19 at G4, ADR-M32 §2.6) | `fail`, `ai_record_missing` / `data_class_not_allowed` |
| 6 | The agent may run: `checkAgentForRun` (FR-36, ADR-M31 §2.6) | `fail`, `agent_not_runnable` (not configured, not found, not active, not approved for the sandbox, model not pinned or not allowed), `instructions_mismatch` (file edited or missing), `autonomy_not_allowed` (the run's autonomy is above the agent's) |
| 7 | The intent budget is not used up | `fail`, `budget_exceeded` |

- A failed check records a system `fail` **once per cause** (as the AI record check at G1, ADR-M32 §2.5): the decision's input hash binds the cause, its subject (the new spec or plan hash, the instructions file hash, the agent version) and the entry into G4. Never the branch head: an unrelated commit on the default branch records nothing new (code review of session 1). The exact cause (for example `agent_not_active`) goes to the audit event `gate.g4_check_failed`; the gate decision holds the reason code. One notice `g4_refused` mentions Person A, who operates runs (Ch.13 §13.3). **The intent stays at G4** (`waiting: g4_check`); the next wake checks again, so a fixed cause lets the intent continue.
- **POLICY** (Low, Medium; QUESTIONS #6): all checks pass → a system `pass` bound to the proposal, once per proposal since the intent entered G4. Any mode but HITL is handled the same way.
- **HITL** (High): the checks first. Then Person A approves the proposal (`/approve G4` or the API). A new proposal gets a notice `run_proposed` that names the agent and the short `base_sha`. The gate deadline and its overdue escalation work as at G1–G3 (ADR-M30 §2.9; subject `run_contract`, the proposal hash). A rejection at G4 ends the intent (`rejected`). No scope, no producers at G4 (no change produced yet, QUESTIONS #64).
- **Critical** (HITL in the matrix, QUESTIONS #5) is blocked by check 1 before anyone can approve.
- A passed or approved G4 waits for the run (`run_pending`). In session 1 nothing starts it; session 2 moves the intent to `running` in the transaction that re-checks the block window and the freeze.
- New `gate_reason_code` values (migration 0011): `agent_not_runnable`, `instructions_mismatch`, `autonomy_not_allowed`.
- `blocked` is finished: the workflow ends, and a blocked intent frees its issue and pull request (the one-open-intent indexes of migration 0009 are recreated with `blocked`), the reconcile loop skips it, and no escalation is raised for it.

### 2.5. Preparing the run (`prepareRun`, QUESTIONS #44, #112)

Just before the handoff (session 2), the worker calls `prepareRun`:

1. It reads the facts again and runs the checks again under the intent lock. The proposal must still be ready and still be the one G4 passed or approved (FR-17: re-checked just before the action). Otherwise it refuses: `not_at_g4`, `not_ready`, `not_decided`.
2. It issues and signs the Run Contract from the proposal (`issueRunContract`, ADR-M22). `triggered_by` = the HITL approver; null for a POLICY pass.
3. **Recertification** (FR-36, ADR-M31 §2.7): an overdue agent never blocks the run. The audit event `agent.recertification_overdue` (agent key, run ID) and one notice `agent_recertification_due`, which mentions the agent's owner (new column `intent_notices.agent_id`; the login is read when the comment is posted).
4. It issues the run's LiteLLM virtual key (`CostController.issueRunKey`, gate `G4`, the agent key as label). A used-up intent or tenant budget cancels the run (`cancelled`, `budget_exceeded`).
5. It issues the run's single-repository GitHub token with `contents: read` (the runner clones; C08 pushes with its own token) and hands **both secrets** to the runner as single-use OpenBao wrapping tokens that live as long as the contract is valid (`run.contract_validity_minutes`). Only wrapping tokens and IDs travel on: no secret and no client data in the Temporal history (ADR-M30 §2.1). The raw virtual key never leaves the worker.

A failure after the contract revokes the key (`endRun`) and cancels the run (`prepare_failed`), so no run waits in `queued` with a live key.

**The worker holds the Cost Controller capability** (Harry, #112): from session 2 the worker process logs in with two AppRoles, `worker` and `cost-controller`, and can therefore use the LiteLLM master key (`kv/cost-controller/litellm-master-key`). D-03 §8.2 already names the Cost Controller as a reader; the worker is the process that runs it. The two policies stay separate; the credentials of `cost-controller` are delivered by `openbao:bootstrap worker-credentials`.

### 2.6. Session 2: the handoff (planned, for review with session 2)

```text
stepIntent at G4 → G4 decided → move in_gate G4 → running (same transaction: block window, freeze) → 'run'
workflow: prepareRun(ref)        [sdlc-intents]  → { runId, wrapped git token, wrapped virtual key }
workflow: executeRun(input)      [sdlc-runner]   provision + runAgent, heartbeats, one attempt
  expired contract → the run is cancelled (contract_expired) → prepareRun again (new attempt, max run.contract_attempts_max)
workflow: finishRun(ref, runId)  [sdlc-intents]  endRun (revoke + sync); L1: store the proposal, intent paused;
                                                 L2: intent running → in_gate G5 (C07)
```

- The runner is a Temporal worker on `sdlc-runner`; its activity slots = `SDLC_RUNNER_MAX_SANDBOXES`, so extra runs wait in Temporal (QUESTIONS #53, #55). The slot pool stays as the backstop.
- **Required in session 2** (code review of session 1):
  - `prepareRun` must be idempotent under Temporal retries: a retried or concurrent call for the same decided proposal must not issue a second run, contract, token or key (for example: refuse while the intent has a non-final run, and let the workflow resume that run).
  - The move to `running` and the run insert must re-check, under the same lock, that the proposal being issued is still the decided one (the G4 input hash), so nothing is issued for a proposal that was superseded, rejected or frozen after the check.
  - A failure after the GitHub token is issued cannot revoke it yet (no revoke method until C11); the token is short-lived, single-repository and `contents: read`.
- No escalation timer in the workflow (ADR-M28). C11 (kill switch) cancels the activity through the workflow; the driver's conditional update already handles the race.
- **L1 proposal (QUESTIONS #111, option A):** the runner computes the proposal diff from the workspace with the hardened git commands of ADR-M29 §2.5, never from what the sandbox reports. It is stored through a new `EvidenceStore` interface (D-03 §7.5) and the adapter `evidence-s3` on SeaweedFS, in the table `evidence_items` as D-05 §6.6 defines it (kind `proposal`, SHA-256, tenant prefix); E02 builds the pack on top. The runner's SeaweedFS credential is **write-only** (no read, list or delete), limited to the tenant prefix if SeaweedFS supports it; otherwise the gap is recorded here.

### 2.7. Lost and failed runs (Harry, plan approval)

A run lost to the infrastructure (the runner's heartbeat times out, `runner_lost`, a runner restart, a provisioning failure) does **not** go straight to G5. Following D-03 §6 ("Stopped → Escalated: always reviewed"), the workflow raises a `technical` escalation at response level `pause` or higher. Budget and scope stops stay with C07 at G5 (QUESTIONS #21, #82). Built in session 2.

### 2.8. Where the rules live

| Rule | Source | Where |
|---|---|---|
| G4 oversight per risk tier (POLICY, HITL Person A) | Codes table §4; QUESTIONS #5, #6 | Config `oversight.matrix.G4` |
| Maximum autonomy per risk tier | Codes table §3; FR-03 | Config `autonomy.max_by_risk` (M7) |
| Models per data class | D-07 §4 | Config `model_routing.allowed_provider_types` |
| Which agent runs | QUESTIONS #108 | Config `run.agent_key` |
| Run caps; contract validity | FR-32; T13; QUESTIONS #13, #33 | Config `budget.default_run_usd`, `run.default_max_*`, `run.contract_validity_minutes` |
| Recertification age | Ch.20 §20.8 | Config `agents.recertification_months` (M18) |
| Approval expiry, block window, gate deadline, overdue escalation | QUESTIONS #9, #88, #90 | Config `oversight.*`, `escalation.calendar` |
| Safe actions while frozen | Ch.6 §6.5 | Config `escalation.safe_actions` |
| Check order; L0 never runs; only active registered agents run; nothing above L2; pinned model and instructions hash; no run during a block window or a freeze; a failed check is recorded once per cause | FR-03, FR-36; D-03 §6; ADR-M30 §2.4b; QUESTIONS #79, #94, #110 | Code (`workflow/g4.ts`) |
| G4 input = the run proposal | FR-17; QUESTIONS #109 | Code (`workflow/g4-proposal.ts`) |
| Token permissions (`contents: read`), wrapped secrets | QUESTIONS #44, #112 | Code (`workflow/prepare-run.ts`) |

Adding the default key `run.agent_key` changes the effective `config_hash` of every stored configuration (QUESTIONS #95). No configuration is stored outside tests yet; B13 AC8 handles it.

## 3. Alternatives considered

- **Pin `base_sha` when G4 is entered** instead of reading the branch head at each evaluation: an approval would not follow a moving default branch, but the approver would approve a commit that may be old. Refused: #109 binds the approval to the commit the run starts from.
- **Block the intent on any failed check** (D-03 "Blocked: bad config"): a fixed agent or record would need a new intent. Refused (#110): only Critical and L0 block; other causes wait at G4.
- **The runner reads the virtual key from the Cost Controller**: the runner would need the LiteLLM master key. Refused (#112): the worker wraps it.
- **Keep the L1 proposal on a GitHub branch** (#111 B): pushes code at L1. Refused.

## 4. Consequences

- D-03 version 1.11: §6 (G4 checks, blocked is final, failed checks wait at G4), §7.1 (`getBranchHead`, ten methods), §8.2 (the worker holds the Cost Controller AppRole).
- D-05 version 1.15: §5 `gate_reason_code` (three values), §6.2 `intent_notices` (kinds `g4_refused`, `blocked`, `run_proposed`, `agent_recertification_due`; column `agent_id`), one open intent per issue excludes `blocked`.
- Migration `0011-gate-g4`. No new SQLSTATE.
- Audit actions `run.proposed`, `gate.g4_check_failed`; `agent.recertification_overdue` now written.
- `@sdlc/contracts`: `GitHostAdapter.getBranchHead`, `AGENT_KEY_PATTERN`, wait reasons `g4_check`, `run_pending`, `git_host_unavailable`. `@sdlc/config`: `run.agent_key` (the default `config_hash` changes).
- Commands: `/approve G4`, `/reject G4`, `/request-changes G4` and the API gate decisions accept G4 (when it waits for a person).
- Handbook Ch.13 §13.10: G4 usage.
- Session 1 does not wire G4 into the worker process: without `StepDeps.g4` the step leaves an intent at G4 waiting (`later_gate`), as before. Session 2 wires it together with the handoff.

## Version history

| Version | Date | Author | Notes |
|---|---|---|---|
| 0.1 | 2026-09-27 | Claude (task C06, session 1) | First version: §2.1–§2.5 built; §2.6–§2.7 planned for session 2 |
