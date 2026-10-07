# ADR-M33. Gate G4: the checks, the run proposal, and the handoff to the runner

| Item | Value |
|---|---|
| Status | **Proposed** (task C06; session 1 merged in PR #105; session 2a merged in PR #108: the Temporal `sdlc-runner` handoff and the run's end; session 2b in review: the L1 proposal as evidence) |
| Date | 2026-09-27 |
| Decided by | Harry (plan approved 2026-09-27: QUESTIONS #108–#112, two sessions, with conditions on #111 and #112 and the rule for lost runs, §2.7; session 2 plan approved 2026-09-27: PRs 2a and 2b, D1–D3 with conditions, §2.6–§2.7, §2.9) |
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
| 2 | The last HOTL block window is closed (ADR-M30 §2.4b) | Wait until it closes (`later_gate`, `wakeInMs`; since U02 `hotl_block_window`, ADR-M54 §2.4b) |
| 3 | Not frozen for `run_start` (ADR-M28 §2.4) | Wait (`frozen`) |
| 4 | The spec and plan are the versions G2 and G3 passed (Ch.13: approved "for these exact versions") | `fail`, `input_mismatch` (`spec_changed`, `plan_changed`). B08 and B09 add the send-back to G2 or G3 |
| 5 | The project AI record allows the data class (FR-19 at G4, ADR-M32 §2.6) | `fail`, `ai_record_missing` / `data_class_not_allowed` |
| 6 | The agent may run: `checkAgentForRun` (FR-36, ADR-M31 §2.6) | `fail`, `agent_not_runnable` (not configured, not found, not active, not approved for the sandbox, model not pinned or not allowed), `instructions_mismatch` (file edited or missing), `autonomy_not_allowed` (the run's autonomy is above the agent's) |
| 7 | The intent budget, and the tenant's budget of this UTC month (session 2a, code review: otherwise a POLICY G4 kept starting runs the Cost Controller refused), are not used up | `fail`, `budget_exceeded` (`intent_budget_exhausted`, `tenant_budget_exhausted`, once per month) |

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

### 2.6. The handoff to the runner (session 2a, D-08 C06 AC4, QUESTIONS #53, #55)

```text
step at G4, decided → move in_gate G4 → running (same transaction: block window, freeze) → 'run_prepare'
prepareRun   [sdlc-intents]  one attempt → { runId, modelRef, wrapped GitHub token, wrapped virtual key }
executeRun   [sdlc-runner]   one attempt, heartbeat every 30 s (timeout 2 min) → { outcome, status } (codes)
finishRun    [sdlc-intents]  one attempt: revoke the run's key, sync spend, move the intent (§2.7)
lost runner  → abandonRun    revoke the key at once, the run fails (runner_lost) → finishRun
```

- **The database drives the round.** While the intent is `running`, the step looks at the runs started since it became `running` (`roundRuns`: `created_at` ≥ the intent's `updated_at`, one database clock):
  - no run → `run_prepare`;
  - the last run is final → `run_ended` (the workflow calls `finishRun`);
  - the last run is `queued` and its contract expired before a runner took it → the run is cancelled (`contract_expired`) and a new attempt is prepared, at most `run.contract_attempts_max` (default 3, [Proposal]) contracts per round; then the round ends with an escalation (§2.7);
  - otherwise the run is under way → wait (`run_in_progress`).
  A workflow that starts again, or a result Temporal lost, finds its way from the database. A runner that refuses a contract for another reason leaves the run `queued` until its contract expires.
- **No run is issued twice** (code review of session 1): `prepareRun` refuses (`run_exists`) while a run of the round is not final. The run activities are never retried by Temporal (`maximumAttempts: 1`); a failed worker activity only makes the workflow ask the step again after a minute.
- **The contract is signed outside the lock**, so after the insert `prepareRun` checks again, under the lock and with the same facts, that the proposal is still ready and decided (the G4 input hash). A freeze, a block or a new proposal in between cancels the run (`not_decided`) before any key or token is issued (tested with a freeze raised while the contract is signed).
- **Any other refusal of `prepareRun`** (the budget is used up, the proposal changed) takes the intent back to `in_gate G4` (notice `run_not_started`), where G4 is decided again; a HITL approval must be given again, because approvals count only after the last entry into G4.
- **The runner is a Temporal worker** on `sdlc-runner` (`apps/runner/src/activities.ts`, settings `SDLC_RUNNER_TEMPORAL_ADDRESS`, `SDLC_RUNNER_TEMPORAL_NAMESPACE`). Its activity slots are `SDLC_RUNNER_MAX_SANDBOXES`, so extra runs wait in Temporal (tested with one slot and two intents); the slot pool stays as the backstop. `executeRun` reads the signed contract stored for the run (the input holds IDs only), provisions (C04), unwraps the virtual key, drives the agent (C05) and returns the run's final status as codes.
- **What the Temporal history holds** (Harry, session 2 plan): IDs, codes, the model name, and the two single-use wrapping tokens. Their time to live is `run.contract_validity_minutes` (the contract's validity, never longer): a runner that takes the run later cannot unwrap them, and the contract has expired anyway. **The key ID never enters the history:** the run's key is revoked by its run (`ModelGateway.revokeRunKey`, LiteLLM `key_alias = run-<run_id>`, D-03 §7.4). The key ID is LiteLLM's hash of the key; the pinned LiteLLM refuses it as a key (live test `pnpm test:litellm`), but it stays out of Temporal anyway. The test reads the decoded history and finds neither the key, the key ID nor the GitHub token.
- **L1 (High risk) runs** waited at G4 in session 2a (`proposal_runs_unavailable`, Harry: no `proposal_ready` notice without a stored proposal). Session 2b removes that wait: a decided L1 G4 moves to `running` like L2, and the run ends with a stored proposal (§2.9).
- **When the activity is cancelled** (the runner stops gracefully; the kill switch comes with C11), the driver stops the agent first, like at the time cap (interrupt, then kill), records `agent_stopped` (`cancelled`), ends the run `failed` (`agent_cancelled`), and only then is the sandbox removed (`release`): never a teardown while the agent is being driven (code review of session 2a). **After a runner restart**, its clean-up at start and its sweep remove what is left and end the run `runner_restarted` or `sandbox_lost` (ADR-M25 §2.8).
- No escalation timer in the workflow (ADR-M28). The workflow code changed for new step outcomes only; old histories never saw them and replay unchanged (tested), so no `patched()` is needed.

### 2.7. How a run ends, and lost runs (Harry, plan approval and session 2 plan)

| The run ends as | The intent goes to |
|---|---|
| `succeeded`, `stopped_budget`, `stopped_scope`, `stopped_timeout`, `stopped_stalled` | `in_gate G5` (notice `run_finished`). C07 decides; a budget or scope stop never resumes by itself (QUESTIONS #21, #82) |
| `failed` (the agent, provisioning, the infrastructure, `runner_lost`), or the contracts kept expiring | `paused` at G4 and a `technical` escalation (notice `run_failed`) |
| `succeeded_proposal_only` (L1, session 2b) | `paused` at G4, no escalation (notice `proposal_ready` to Person A); it waits (`proposal_review`): Person A takes the proposal forward, no new run starts by itself (§2.9) |
| `stopped_killed` | `paused` at G4, no escalation here: C11 raises its own |
| `cancelled` before it started (`budget_exceeded`, `not_decided`, `prepare_failed`) | Back to `in_gate G4` (notice `run_not_started`) |

- A failed or lost run does **not** go straight to G5 (D-03 §6: "Stopped → Escalated: always reviewed"). The escalation: trigger `unusual_behaviour`, route `technical`, severity and response level from config `run.failed_run_escalation` (default `high` / `pause`; new mandatory rule **M20**: the level is `pause`, `contain` or `incident`, so the intent stays frozen until a person decides). Packet: `run_contract` with the contract hash, the run and the agent; the person who allowed the run (`triggered_by`) is a producer.
- **A lost runner:** the heartbeat timeout fails the activity; the workflow calls `abandonRun`, which **revokes the run's key at once** (Harry: not at its expiry), ends the run `failed` / `runner_lost` and records `run_abandoned`. The sandbox is removed by the runner: on the activity's cancel if it is still alive, otherwise by its clean-up at start and its sweep.
- **Back from `paused`:** the step moves the intent to `in_gate G4` (notice `run_resumed`) once the run's escalation is closed, or a person decided `resume` for this run's contract (re-checked with `revalidateEscalationDecision`, then closed). G4 is then decided again and a new round starts. A killed run waits (`run_review`) until C11 adds its escalation.
- **The decisions on a failed run's escalation** (QUESTIONS #211, B09 PR 2; before, `modify` and `roll_back` acted only after the G7 feedback was gone, #191, and every other cause waited for `run_review` with no way forward but `terminate`):

  | Decision (bound to the run's contract, not expired) | The intent goes to |
  |---|---|
  | `resume` | `in_gate G4` (notice `run_resumed`), a new round. After the G7 feedback was gone (`agent_feedback_unavailable`): back to G7 when the pull request still shows the pushed commit (ADR-M41 §2.7) |
  | `modify`, `roll_back` | `in_gate G3`, HITL from then on (`returnedFromG5`), the G3 approvals in force voided (`input_mismatch`), the escalation closed. Notice `run_returned`; `g7_returned` after the G7 feedback was gone. For every stop reason (`agent_task_unavailable`, `runner_lost`, `agent_error`, `agent_changes_unavailable`, …) and for a killed run (C11: its escalation, raised at the kill, is decided the same way), as G5, G6 and G7 escalations already do |
  | `terminate` | `cancelled` (C11) |

  An expired decision, or one bound to another contract, is voided (`escalation.decision_voided`), never acted on: the escalation goes back to `acknowledged` and the intent waits (`run_review`).

### 2.8. Where the rules live

| Rule | Source | Where |
|---|---|---|
| G4 oversight per risk tier (POLICY, HITL Person A) | Codes table §4; QUESTIONS #5, #6 | Config `oversight.matrix.G4` |
| Maximum autonomy per risk tier | Codes table §3; FR-03 | Config `autonomy.max_by_risk` (M7) |
| Models per data class | D-07 §4 | Config `model_routing.allowed_provider_types` |
| Which agent runs | QUESTIONS #108 | Config `run.agent_key` |
| Run caps; contract validity | FR-32; T13; QUESTIONS #13, #33 | Config `budget.default_run_usd`, `run.default_max_*`, `run.contract_validity_minutes` |
| Contracts per round before an escalation | QUESTIONS #53 (session 2a, [Proposal]) | Config `run.contract_attempts_max` |
| Escalation of a failed or lost run | D-03 §6; Harry (session 2) | Config `run.failed_run_escalation`; mandatory rule M20 (`pause` or higher) |
| Where a run's end takes the intent; runs never issued twice; key revoked by run, at once when the runner is lost; no key ID or secret in Temporal | D-03 §6; QUESTIONS #21, #82, #112; Harry (session 2 plan) | Code (`workflow/run-lifecycle.ts`, `prepare-run.ts`, the workflow) |
| Recertification age | Ch.20 §20.8 | Config `agents.recertification_months` (M18) |
| Approval expiry, block window, gate deadline, overdue escalation | QUESTIONS #9, #88, #90 | Config `oversight.*`, `escalation.calendar` |
| Safe actions while frozen | Ch.6 §6.5 | Config `escalation.safe_actions` |
| Check order; L0 never runs; only active registered agents run; nothing above L2; pinned model and instructions hash; no run during a block window or a freeze; a failed check is recorded once per cause | FR-03, FR-36; D-03 §6; ADR-M30 §2.4b; QUESTIONS #79, #94, #110 | Code (`workflow/g4.ts`) |
| G4 input = the run proposal | FR-17; QUESTIONS #109 | Code (`workflow/g4-proposal.ts`) |
| Token permissions (`contents: read`), wrapped secrets | QUESTIONS #44, #112 | Code (`workflow/prepare-run.ts`) |

Adding the default key `run.agent_key` changes the effective `config_hash` of every stored configuration (QUESTIONS #95). No configuration is stored outside tests yet; B13 AC8 handles it.

### 2.9. Session 2b: the L1 proposal as evidence (QUESTIONS #111, option A)

**Checks before building** (Harry, session 2b; throw-away containers, nothing kept, 2026-09-27):

- `@aws-sdk/client-s3` **3.1141.0**, pinned exactly: 26 packages, none with an install script (nothing to allow in `pnpm.onlyBuiltDependencies`); a strict type-check with library types passes; licences Apache-2.0 (24), MIT (`bowser`), 0BSD (`tslib`): all allow commercial use. The CI Trivy licence scan runs on the lockfile.
- **SeaweedFS 4.47** (the pinned image):

  | Question | `Write:evidence` (bucket) | `Write:evidence/proposals/*` (prefix) |
  |---|---|---|
  | Write inside its scope | yes | yes |
  | Write outside its prefix | — | refused |
  | Read, Head, List, Copy | refused | refused |
  | DeleteObject, DeleteObjects | **allowed** | **allowed inside the prefix** |
  | Overwrite an existing key | allowed | allowed |
  | `If-None-Match: *` on an existing key | refused (412) | refused (412) |
  | Delete a specific version (`VersionId`) | **allowed** | **allowed inside the prefix** |
  | Suspend versioning | **allowed** | refused |
  | Delete the bucket, set a bucket policy | refused | refused |

  - Versioning is supported (`weed shell s3.bucket.versioning -enable`): a plain delete leaves a delete marker and the older versions.
  - Object lock (COMPLIANCE) is supported on a bucket created with it: even the admin cannot delete a locked version (403).
  - A **dynamic** identity (`weed shell s3.configure … -apply`) is stored in the filer, survives a restart, and coexists with the admin identity from the environment. Its key can reach `weed shell` on stdin, never as a process argument. `s3.config.show` prints secrets: never used.

**What 2b builds** (Harry's conditions):

- The runner keeps its own clone of an L1 run until the run ends (`run-<run_id>` in its work folder, removed at release and by the clean-up at start). When the agent finished, the runner reads the sandbox's `/workspace` with Docker `GET /containers/{name}/archive`: a new endpoint of the runner's Docker client and the socket proxy, allowed only on the run's own sandbox container, after checking its name and this runner's instance and run labels.
- The archive is untrusted:
  - regular files and directories only; symbolic links are kept as links and never followed; hard links, devices, FIFOs and path escapes are refused;
  - total size (`SDLC_RUNNER_WORKSPACE_MAX_MB`) and entry count are capped;
  - every `.git` path is ignored, so the agent's `.git` never replaces the runner's;
  - deletions are mirrored: a file of the clone that is not in the archive is removed (`.git` excepted).
- The runner computes the proposal in its own clone with hardened git (no system or user configuration, no hooks, no fsmonitor, no replace objects, no external diff or textconv): `git add -A`, then `git diff --cached --binary --no-renames <base_sha>`. Nothing the sandbox reports is used. **C07 and C08 can reuse this export to recompute changed files outside the sandbox.**
- The patch goes to SeaweedFS through `EvidenceStore` (D-03 §7.5) and the adapter `@sdlc/adapter-evidence-s3`, at `s3://evidence/proposals/<tenant>/<intent>/<run>.patch`, with `If-None-Match: *` (one path per run; never overwritten). A row in `evidence_items` (kind `proposal`, SHA-256, size) records it; E02 re-checks the SHA-256 when it builds the pack. The run ends `succeeded_proposal_only`; the intent is `paused` with the notice `proposal_ready` to Person A, who takes it forward (handbook Ch.13 §13.5 Step 4).
- The runner's credential `runner-evidence` lives in OpenBao (`kv/runner/evidence`), never in `.env`; `openbao:bootstrap runner-evidence-credentials` creates it and applies it to SeaweedFS as a dynamic identity limited to `Write:evidence/proposals/*`. The bucket `evidence` gets versioning (`seaweedfs-init`).

**As built** (session 2b):

- **Runner:** `Runner` keeps the clone of an L1 run (`provisionRun` returns `cloneDir`) and gives the driver a `proposal` step when it has an evidence store. When the agent `finished`, the driver calls it instead of `commitWork`: `storeProposal` = `exportWorkspace` → `mirrorWorkspace` → `computeProposal` → `EvidenceStore.put` → one transaction with the `evidence_items` row (kind `proposal`) and the run event `proposal_stored` (SHA-256, size, number of changed paths; never the paths). The run ends `succeeded_proposal_only` with no `head_sha`; what the sandbox reports is not used. Without an evidence store the run fails `agent_proposal_unavailable`; any error while reading, computing or storing fails it `agent_proposal_failed` (the intent is paused and escalated like any failed run). An L1 run that stops at a cap goes to G5 like L2 (C07). The clone is removed at release, and by the clean-up at start (`run-*` in the work folder).
- **Realistic workspaces** (Harry, review of PR #112): the archive is **streamed** (`DockerClient.getArchive` returns the response stream; `untarWorkspace` reads it with a byte reader), capped at `SDLC_RUNNER_EXPORT_MAX_MB` (default 8192) streamed bytes. Paths ignored by the ignore rules **of `base_sha`** are read past and never kept: one `git check-ignore --stdin -z --verbose --non-matching` process in the runner's clone, before the mirror, answers each path (`ignore.ts`; paths sent as `./<path>`, so pathspec magic never applies); an ignored directory (`node_modules/`) is skipped with everything under it, unless it holds a tracked path; paths git tracks at `base_sha` are never ignored; a path beyond a tracked link is kept without asking. A kept file is copied once, into a buffer of its size; only kept files count against `SDLC_RUNNER_WORKSPACE_MAX_MB`. Then `git add -A -f`, so a `.gitignore` the agent adds hides nothing (its change shows in the proposal), and `.git/info/attributes` unsets `text`, `eol`, `crlf`, `diff`, `filter`, `ident`, `merge` and `working-tree-encoding` for every path, so a `.gitattributes` from the workspace cannot turn a text change into an unreadable binary patch or convert line endings (git 2.39 in the runner image has no `--attr-source`). The mirror check covers `.git/config`, `.git/info/attributes` and `.git/info/exclude`. Measured on the pilot repository (`pnpm test:proposal-pilot`, 2026-09-28, a developer machine): after `pnpm install` the workspace held 317 MB (316 MB of `node_modules`) in 37 011 entries; the proposal (2 changed files, a 717-byte patch) took 5.5 s, and the runner process's peak resident memory rose by 44 MB (heap by 1 MB) against a workspace cap of 1024 MB.
- **Case-insensitive file systems** (security review of 2b): `.git` is matched folded (NFC, invisible characters removed, lower case), so `.GIT/config` in the archive is never written into the runner's real `.git` on macOS, where it could set a git `alias` that runs a program. Two archive paths that fold to the same path are refused, and the SHA-256 of `.git/config` must be the same before and after the mirror.
- **Symbolic links** in a proposal can point anywhere (they are kept as links, never followed by the runner). Whoever applies a proposal later (Person A, C07, C08, E02) must not follow them blindly.
- **Docker:** the runner's allowlist and the socket proxy's allow `GET /containers/sdlc-sandbox-<uuid>/archive` only (a run sandbox name; the static test keeps the two lists equal); `exportWorkspace` also checks the container's name and this runner's instance and run labels before reading.
- **Settings:** `SDLC_RUNNER_EVIDENCE_URL` (default `http://seaweedfs:8333`; `off` = no proposals), `SDLC_RUNNER_EVIDENCE_BUCKET` (`evidence`), `SDLC_RUNNER_EVIDENCE_SECRET_PATH` (`runner/evidence`, fields `access_key`, `secret_key`). A missing credential is a warning at start (`runner.evidence_missing`), not a failure.
- **Bootstrap:** `openbao:bootstrap runner-evidence-credentials` makes the key pair inside the openbao container, stores it at `kv/runner/evidence` (JSON on stdin) and pipes the `s3.configure … -actions Write:evidence/proposals/* -apply` line to `weed shell` on its stdin; `weed shell` output (it prints secrets) is discarded, and the check reads the identity's name only and the KV version. The old identity is deleted first, so a rotation disables the old key (live test). `seaweedfs-init` enables versioning on `evidence` (`SEAWEEDFS_VERSIONED_BUCKETS`) and checks it.
- **Core:** `finishRun` moves `succeeded_proposal_only` to `paused` G4 with the notice `proposal_ready`; `stepPaused` then waits (`proposal_review`). How Person A records a decision on the proposal (a new intent, a manual change, a rejection) is not built here; the handbook Ch.13 §13.10 describes the manual path.
- **Data:** migration `0012-evidence-items` (D-05 §6.6 version 1.17).
- **Tests:** untar attack cases and a real system tar archive, mirror (links never followed, `.git` kept, deletions mirrored), `computeProposal` with real git (a tampered repository configuration never runs a program; the binary patch applies at `base_sha`), the archive guard, the S3 adapter against a stub, the driver's L1 paths, `finishRun` and the step on PostgreSQL, and the live runner Compose test: the identity writes under `proposals/` only, cannot read or overwrite, a delete keeps the versions, a rotation disables the old key.

**Remaining gaps** (recorded as Harry asked):

1. **Write includes delete.** SeaweedFS has no write-only action: the runner's credential can delete, and delete a specific version of, any object under `proposals/`. It cannot touch anything else in the bucket (E02 packs), cannot read or list, and cannot suspend versioning. Mitigations: `If-None-Match: *`, versioning (a plain delete keeps the versions), the SHA-256 in `evidence_items` checked by E02. **Object lock: not now** (Harry, review of PR #112). SeaweedFS supports it (COMPLIANCE) on a bucket created with lock enabled; the lock period is per bucket or per object while the retention is per project and `retention_hold` must keep objects longer. The question moved to a note on E05 (D-08).
2. **No per-tenant limit.** One static identity covers `proposals/` for every tenant. Per-tenant identities (issued at onboarding) go to B13 / MVP+1.
3. The admin identity of SeaweedFS still comes from `.env` (A02); unchanged here.
4. **The evidence secret is on disk inside SeaweedFS** (checked on the pinned image, review of PR #112). `weed shell` without a terminal writes no history file, and neither the container logs nor the glog files show the secret after `s3.configure`. But SeaweedFS keeps dynamic identities, secret keys included, in plain text in its filer store (`/data/filerldb2` on the volume `seaweedfs-data`). Whoever can read that volume (or its backups, A10) can read the key; the same volume holds the evidence the key protects. **Possible follow-up:** static identities rendered by an OpenBao Agent sidecar into a tmpfs file for `-s3.config`, as for LiteLLM (ADR-M24), so no S3 secret is written to disk; it would replace the admin identity from `.env` too (gap 3).

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
- Session 1 did not wire G4 into the worker process. Session 2a does: the worker evaluates G4 and hands runs to the runner when its second AppRole `cost-controller` is delivered (`openbao:bootstrap worker-credentials`); without it, runs are off and intents wait at G4 (`worker.runs_off`).
- Session 2b: D-03 1.13 (§6 L1 runs, §7.5 `EvidenceStore` as built, §10), D-05 1.17 (§6.6 `evidence_items`, notice kind `proposal_ready`, run event `proposal_stored`, stop reasons), D-08 1.11 (C07, C08, E02 notes), migration `0012-evidence-items`, `@sdlc/adapter-evidence-s3` (`@aws-sdk/client-s3` 3.1141.0, pinned), Compose (runner evidence settings, socket-proxy archive read, `evidence` versioning), bootstrap `runner-evidence-credentials`, runbook T11 §5g, handbook Ch.13 §13.10.
- Session 2a: D-03 1.12 (§6 the run's round, §7.4 `revokeRunKey`, §10 the runner's task queue), D-05 1.16 (notice kinds `run_started`, `run_finished`, `run_failed`, `run_not_started`, `run_resumed`; run stop reasons), config `run.contract_attempts_max`, `run.failed_run_escalation`, rule M20 (the default `config_hash` changes), Compose (worker `worker-cost-approle`, runner Temporal settings), runbook T11 §5f, handbook Ch.13 §13.10.

## Version history

| Version | Date | Author | Notes |
|---|---|---|---|
| 0.1 | 2026-09-27 | Claude (task C06, session 1) | First version: §2.1–§2.5 built; §2.6–§2.7 planned for session 2 |
| 0.2 | 2026-09-27 | Claude (task C06, session 2a) | §2.4 check 7 includes the tenant's monthly budget; §2.6 the handoff as built (a cancel stops the agent before the sandbox is removed) (the round from the database, no run twice, the re-check after signing, what the history holds, L1 waits); §2.7 how a run ends, lost runs, back from `paused`; §2.9 session 2b plan with Harry's conditions |
| 0.3 | 2026-09-27 | Claude (task C06, session 2b) | §2.6 L1 no longer waits; §2.7 `succeeded_proposal_only` → `paused` (`proposal_ready`); §2.9 SeaweedFS and `@aws-sdk/client-s3` checks, as built, remaining gaps; §4 consequences of 2b |
| 0.4 | 2026-10-04 | Claude (task B09, PR 2), approved by Harry | §2.7 the decisions on a failed run's escalation: `modify` and `roll_back` → G3 HITL for every stop reason and after a kill (QUESTIONS #211) |
