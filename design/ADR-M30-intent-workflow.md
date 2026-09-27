# ADR-M30. Intent workflow on Temporal: a thin loop over the database

| Item | Value |
|---|---|
| Status | **Proposed** (task B07: session 1 merged in PR #101; session 2 adds HOTL, the block window, the gate deadline and overdue escalations, for review) |
| Date | 2026-09-27 |
| Decided by | Harry (plan approved 2026-09-27: QUESTIONS #88–#92, #68 option A, with conditions; review of PR #101: §2.4 current-gate rule accepted, strict re-approval kept for the pilot; session 2 plan approved 2026-09-27: D1–D4, §2.4b, §2.9) |
| Related | D-02 FR-10, FR-12, FR-14, FR-17, FR-18, FR-22; D-03 sections 5.1, 6, 6.1–6.4, 12 (ADR-M02, ADR-M14); D-05 sections 6.2, 6.2b, 6.3 (version 1.12); D-08 tasks B07, B08, B09, B10, B12, C06, E06; handbook codes table §4, Ch.11, Ch.12, Ch.19 §19.8b; ADR-M16, ADR-M20, ADR-M26, ADR-M27, ADR-M28; QUESTIONS #16, #21, #53, #55, #64, #68, #73, #76, #88–#92 |

## 1. Context

Task B07 runs the gate workflow of an intent on Temporal (ADR-M02): Draft → G1 → G2 → G3, with the oversight mode from the configuration, approvals bound to version, scope and expiry, overdue gates escalated, waiting time recorded, and a worker restart that continues in the right state. It is the first use of Temporal in the platform.

Some pieces already exist:

- the registry records decisions and checks the approver (ADR-M20);
- the shared handler `decideGate` records people's decisions from the API and from comments (ADR-M26 §2.4, ADR-M27);
- escalations keep their clocks in the database and freeze the intent (ADR-M28). B07 must not add a second timer for them.

## 2. Decision

### 2.1. Temporal set-up

- **Packages:** `@temporalio/client`, `worker`, `workflow`, `activity` 1.24.0 (MIT), exact versions.
  - `@temporalio/testing` 1.24.0, and `client` and `worker` for the tests, are root development dependencies.
  - `@temporalio/core-bridge` ships prebuilt binaries: no install script is needed.
  - `@swc/core` and `protobufjs` have install scripts, which pnpm blocks (`onlyBuiltDependencies: []`, ADR-M16). Workflow bundling works without them: the native `@swc/core` binary comes as an optional dependency for the platform, and the `protobufjs` script only checks versions. This was checked on macOS arm64 and in the Linux worker image. The allow-list stays empty.
- **Connection:** the Compose Temporal (`temporalio/server:1.31.2`) at `temporal:7233`, namespace `${TEMPORAL_NAMESPACE:-default}`, which Compose creates. Plain gRPC on the internal Compose network, like PostgreSQL. The api and the worker start after `temporal-namespace` completed.
- **Task queue:** `sdlc-intents`. The runner's queue `sdlc-runner` belongs to C06 (QUESTIONS #55).
- **Workflow ID:** `intent/<tenant_id>/<intent_id>`: UUIDs only.
- **No client data in Temporal.** The workflow input, the signal and the activity results hold IDs and codes only. Temporal keeps its history for 30 days in its own database; titles, specs and reasons never reach it (tested).
- **Names in one place:** `@sdlc/contracts` (`intent-workflow.ts`): task queue, workflow type, signal name, workflow ID, the `IntentWorkflowSignals` interface and the step result codes. The workflow code imports them too, so the module is pure.
- **`@sdlc/workflow-client`** (new package, `@sdlc/contracts` only): `connectTemporal` and `TemporalIntentSignals`. Core never imports it (lint rule).
- **The worker process** (`platform/apps/worker`) runs the Temporal worker next to the GitHub poller and the escalation clock loop:
  - Settings `SDLC_WORKER_TEMPORAL_ADDRESS` (default `temporal:7233`; `off` in development mode only), `SDLC_WORKER_TEMPORAL_NAMESPACE` (`default`), `SDLC_WORKER_RECONCILE_MS` (600 000), `SDLC_WORKER_RECONCILE_BATCH` (500), `SDLC_WORKER_WORKFLOW_BUNDLE`. Technical settings, not handbook rules.
  - The image bundles the workflow code at build time (`dist/bundle-workflows.js` → `dist/workflow-bundle.js`) and sets `SDLC_WORKER_WORKFLOW_BUNDLE`, so the container runs no bundler.
  - A failed Temporal worker stops the process; Compose restarts it.
  - The SDK's warnings go to the worker's JSON log (`temporal.log`).
- **The api** wakes workflows: settings `SDLC_API_TEMPORAL_ADDRESS` and `SDLC_API_TEMPORAL_NAMESPACE`, same rules.

### 2.2. The workflow is a thin loop; the database is the source of truth

```text
loop:
  result = stepIntent(ref)          # activity, one transaction under the intent lock
  finished → return the status      # done, rejected, cancelled
  moved    → step again             # at most 16 moves per wake-up
  waiting  → wait for a wake signal # then continue-as-new when the history grows
```

- **`stepIntent`** (`@sdlc/core`, `workflow/step.ts`) reads the intent under its advisory lock and makes **at most one move**. The move, its audit event (`intent.state_changed`, system actor) and its status notice commit together.
  - The move is a **compare-and-set** on status and gate (`IntentRepository.moveState`). An activity retried after a crash, or two steps at the same time, move once (tested).
  - An unknown intent fails with `WorkflowError`, which the workflow does not retry.
- **The workflow code** (`apps/worker/src/workflows/`) imports only `@temporalio/workflow`, `@sdlc/contracts` and activity types. A lint rule enforces it (deterministic sandbox). A replay test runs a recorded history on the current code.
- **One timer only (session 2).** A step that waits may return `wakeInMs`, a delay (never a time: the workflow never compares its own clock with the database's). The workflow then waits for a wake signal **or** that delay (at least 1 second), and steps again. The step decides what the time means. Two uses:
  - the gate deadline (§2.9);
  - the end of the last open HOTL block window, at G4 (§2.4b), so that C06 can start the run.
- Escalation clocks stay in the database (ADR-M28): the workflow never sets a timer for them.
- A recorded history without `wakeInMs` replays unchanged (tested); a history with the timer replays too.

### 2.3. Waking the workflow

- The signal `wake` carries no data. A duplicate or replayed signal is harmless, because the workflow reads the database again.
- **Signal-with-start:** a workflow that does not run yet is started. When two processes start the same workflow at once, the loser gets `WorkflowExecutionAlreadyStartedError` and sends a plain signal (tested).
- **Who wakes it, after their commit:**
  - the api: after creating an intent (the submit, QUESTIONS #89), after a gate decision, after an escalation acknowledgement or decision;
  - the poller: after a batch that recorded a gate decision, `/ack` or `/decide` (`PollDeps.intentSignals`).
- **A failed signal never fails the request or the poll.** It is logged with IDs only.
- **The reconcile loop** (worker) wakes every open intent at start-up and then every `SDLC_WORKER_RECONCILE_MS` (`SystemScope.listOpenIntents`: IDs only, active tenants, keyset pages). It catches up:
  - a signal lost when a process stopped between its commit and the signal;
  - an intent created while Temporal was down (tested).

### 2.4. Moves and decisions

- **Moves** (D-03 section 6):

  | From | To | When |
  |---|---|---|
  | `draft` | `in_gate` G1 | Always: creating the intent is the submit (QUESTIONS #89). B12 adds the AI-record check at this point |
  | `in_gate` G1, G2, G3 | `in_gate` G2, G3, G4 | Enough valid approvals (below) and the intent not frozen |
  | `in_gate` G1, G2, G3 | `rejected` | A rejection at that gate. Ending the intent is never frozen |
  | `in_gate` G2, G3 | `in_gate` next gate | HOTL: the conditions hold, a system `pass` (session 2, §2.4b) and the intent not frozen |
  | `in_gate` later gate (up to G4) | `in_gate` the passed gate, or `rejected` | A block of a HOTL-passed gate within its window (session 2, §2.4b). Never frozen |
  | `in_gate` G4 and later | — | The intent waits: C06 continues |

- **A decision counts only when recorded after the intent last entered the gate, and after the last request for changes at that gate.**
  - The order comes from the **audit chain** (`seq`), not from timestamps. Gate decisions and intent moves both append to the tenant's chain under the audit lock, so `seq` orders them exactly as they committed. A transaction's `now()` is its start time: a poll batch that started before a move could commit a decision after it with an earlier time. A new index `audit_log (tenant_id, entity_id, seq)` keeps this read small.
  - A request for changes keeps the intent at the gate and records a `changes_requested` notice once. An approval of the same input by the same person stays recorded, so the policy engine refuses a second one (`already_approved`): the input must change first (a new spec or plan version voids the old approval, FR-17).
  - **Kept strict for the pilot** (Harry, review of PR #101). It can be loosened later without a data change: the registry would ignore, in its `priorApprovals` check, approvals recorded before the gate's last request for changes (the order from the audit chain, as in `gateHistory`).
- **`decideGate` refuses a decision for a gate the intent is not waiting at** (`gate_not_current`, API 409, comment reply `comment.reply.gate_not_current`). Accepted by Harry in the review of PR #101: a refusal the person sees is better than a decision that is recorded and then silently ignored by the workflow.
  - The check reads the intent **under its lock, in the transaction of the decision**, so the workflow cannot move the intent between the check and the record (found by the code review of PR #101).
  - Callers that decide gates in tests or tools must first bring the intent to the gate (the B03 and B06 tests do).
- **Approvals needed:** from the policy engine (`oversightMode`, project config `oversight.matrix` and change flags). At least one person decides.
  - HITL: `approvalsNeeded` (dual approval included).
  - HOTL: one explicit approval passes at once; otherwise the HOTL pass (§2.4b).
  - AUDIT and POLICY are not used at G1–G3; the gate would wait.
- **Before a move:**
  - `revalidateApprovals` against the gate's current input hash (QUESTIONS #64: G1 the intent's fixed fields, G2 the latest spec, G3 the latest plan). An expired or mismatched approval gets a `void` decision and no longer counts (FR-17). Tested: expiry, input mismatch, scope mismatch, dual approval from the configuration.
  - **No scope at G1–G3** (Harry, session 2 plan, D3): the gate advance has no environment, resources or actions. `decideGate` refuses an approval with a scope (`scope_not_allowed`, API 422). The `scope_mismatch` void stays as a safeguard for an approval written past the handler.
  - the freeze check: `assertActionAllowed(scope, intentId, 'gate_advance')` (ADR-M28 §2.4). A frozen intent waits (`waiting: frozen`); the workflow is woken when the escalation is decided.
- **`gate_entered_at`** (new column) records when the intent entered its gate. **`waited_seconds`** (FR-12, session 2) = decision time − `gate_entered_at`, wall-clock seconds, stored on each person's decision at the current gate and on the HOTL `pass`; null on a block of a passed gate. E06 reports it.

### 2.4b. HOTL gates and the block window (session 2, QUESTIONS #88 option A)

- **The pass.** When the resolved mode of G2 or G3 is HOTL and its conditions hold, the step records a system `pass` (bound to the gate's input hash) and moves to the next gate in the same transaction, after the freeze check. The notice `hotl_passed` mentions the roles of the passed gate's matrix cell (for HOTL: the people told) and the next gate's actors; it shows when the block window closes (UTC).
  - Conditions: G2 a spec is linked; G3 a plan with at least one planned file (the registry already refuses an empty plan). A forced-HITL flag makes G3 HITL through the policy engine. B08 and B09 add their conditions in `workflow/hotl.ts`.
  - The registry refuses a system `pass` at a HITL gate: no gate passes by silence.
  - **No pass again on an input a person sent back** (D1): when a request for changes at the gate is bound to the current input hash, the gate waits for a new spec or plan, or for an explicit approval.
- **An explicit `/approve`** passes a HOTL gate at once and opens no block window: a person decided.
- **The block window** starts at the pass and lasts `oversight.hotl_block_window` on `escalation.calendar`. While it is open, a holder of the gate's role may **reject** or **request changes** at the passed gate, although the intent waits at a later gate (in_gate, up to G4) (D2). `decideGate` allows exactly this; an approval of a passed gate stays refused (`gate_not_current`).
  - The next step acts on it, before anything else, and is never frozen: a request for changes takes the intent back to that gate (notice `returned`); a rejection ends the intent. The earliest blocked gate wins.
  - Back at the gate, approvals recorded at the later gates no longer count: decisions count only after the last entry into a gate (§2.4, tested).
- **For C06:** `hotlBlockWindowOpenUntil(scope, registry, intentId)` returns when the last open window of the intent's path closes, or null. **C06 must not start a run before that time**; call it in the transaction that starts the run. At G4 the step returns `later_gate` with `wakeInMs` = the time left.
- **Time on one clock.** The block window starts at the `occurred_at` of the pass's `gate.decided` audit event, which the registry now writes from its own clock; the gate history reads it from the audit chain with the order (`seq`).

### 2.5. Gate status comments (FR-22)

- New table `intent_notices`: the outbox of the status comments. Codes and IDs only: kind (`submitted`, `advanced`, `rejected`, `changes_requested`), status, gate, previous gate, the decision that caused it, and the roles to mention (never `viewer`). Posted or abandoned is final (trigger, `SDA10`).
- The workflow records one notice per status change, in the transaction of the change.
- The poller posts them after its replies and escalation notices, with the same delivery rules (ADR-M27 §2.4: at least once, retries, give-up).
- The comment is rendered from the catalog (`intent.status.*`, `gate.name.*`). It names the people who decided and mentions the current holders of the roles that act next. Logins are read at posting time and never stored.
- **It confirms a successful comment command** (ADR-M27 §2.4: "a successful command gets no reply").

### 2.6. One open intent per issue (QUESTIONS #68, option A)

- Partial unique indexes on (`tenant_id`, `project_id`, `issue_number`) and on `pr_number`, for intents not `done`, `rejected` or `cancelled`.
- `POST /v1/intents` answers 409 `issue_already_linked`. A closed intent frees its issue.
- The poller's `intent_ambiguous` reply stays for data created before migration 0009 only.

### 2.7. Tests and the Temporal test server (QUESTIONS #92)

- `pnpm test`: settings, the reconcile loop, the workflow client (signal-with-start, fallback), the status comment texts, static Compose and Dockerfile checks.
- `pnpm test:db` (`intent-workflow.test.ts`): `stepIntent` on PostgreSQL: the moves, rejection, request for changes, binding and void, freeze, concurrent steps, `gate_not_current`, the status comments posted on the issue, the wake signals, the reconcile listing, the notice grants.
- `pnpm test:workflow` (CI job `db`): the workflow on the Temporal **time-skipping test server** with a throw-away PostgreSQL:
  - AC1 end to end through the poller's and the api's signals; a rejection ends the workflow; repeated signals;
  - AC5: the worker stopped while the intent waits, the decision and its signal arrive, a new worker continues; a lost signal and a missed start caught up by the reconcile loop; the history replays on the current code.
  - The restart test uses workers without a workflow cache (every task replays the history, as after a process restart). With a cache, the stopped worker's sticky queue holds the next task until its schedule-to-start timeout, and the Java test server does not hand it over. A real server does (10 s by default).
  - Session 2 (`intent-workflow-2.test.ts`, its own test environment so no stopped worker blocks the time skipping): Low risk G2 and G3 on HOTL and a block read from a comment; the deadline timer raises one escalation with no signal, the approval closes it, and the history with the timer replays.
- `pnpm test:db` (`intent-workflow-2.test.ts`, session 2): the HOTL pass and its notices, blocks inside and outside the window, D1, D2, an explicit approval, the binding cases and dual approval, the deadline across working hours, one escalation per clock start, closing, its own freeze, `waited_seconds`.
- **`pnpm test:workflow-compose`** (CI job `compose`, session 2): the smoke test on the Compose Temporal (`temporalio/server:1.31.2`, own throw-away project, ports +25000). Workers with the default cache: worker 1 stops while the intent waits at G1, the decision and its signal arrive, worker 2 continues.
- **The test server** (`temporal-test-server` from the sdk-java release 1.39.0, the version the SDK 1.24.0 picks by default) is fetched by `platform/deploy/scripts/temporal-test-server.sh`:
  - from the GitHub release, never from the SDK's own download (`temporal.download`), which has no checksum;
  - checked against the SHA-256 digests GitHub publishes for the release assets, pinned in the script for linux amd64 and arm64 and macOS amd64 and arm64;
  - the archive is cached (`~/.cache/sdlc/temporal-test-server`; CI `actions/cache`, key = the script's hash) and checked again on every run; the executable is extracted again every run.

### 2.8. Where the rules live

| Rule | Source | Where |
|---|---|---|
| Oversight mode, roles and approvals per gate × risk; forced HITL at G3 | Config `oversight.matrix`, `forced_hitl_g3` | Policy engine (`oversightMode`, `canApprove`) |
| Approval expiry, working calendar | Config `oversight.approval_expiry`, `escalation.calendar` | Registry |
| Safe list while frozen | Config `escalation.safe_actions` | `checkFreeze` |
| Polling interval (when comments are read) | Config `github.poll_interval_seconds` | Poller |
| HOTL block window; gate deadline | Config `oversight.hotl_block_window`, `oversight.hitl_gate_deadline`, calendar `escalation.calendar` | `workflow/hotl.ts`, `workflow/overdue.ts` |
| Severity and response level of an overdue gate | Config `oversight.gate_overdue` (QUESTIONS #90) | `workflow/overdue.ts` |
| HOTL pass conditions; no pass again on a sent-back input; route `intent` or `technical` | QUESTIONS #88, #90; session 2 plan D1 | Code |
| No scope on G1–G3 approvals | Session 2 plan D3 | `decideGate` |
| Gate order Draft → G1 → G2 → G3 → G4; reject ends the intent | D-03 section 6 | Code (`step.ts`) |
| No gate passes by silence | D-03 section 6 | Code (a person's approval; the registry refuses a system `pass` at HITL) |
| Decisions count after entry and after the last request for changes; only at the current gate | This ADR (FR-17) | Code |
| One open intent per issue | QUESTIONS #68 | Unique indexes |
| Temporal address, namespace, reconcile interval | Technical settings | `SDLC_WORKER_*`, `SDLC_API_*` |

Adding the default key `oversight.gate_overdue` changes the effective `config_hash` of every stored configuration (QUESTIONS #95). No configuration is stored outside tests yet; B13 AC8 handles it before a real project stores one.

### 2.9. Overdue gates (session 2, QUESTIONS #90)

- **The gate clock** starts when the intent enters G1, G2 or G3, and starts again at each request for changes at the gate (D4). **The deadline** = the clock start + `oversight.hitl_gate_deadline` on `escalation.calendar`. It runs while the gate waits for a person (`decision` or `input_missing`), not while the intent is frozen.
- Before the deadline, the step returns `wakeInMs` (the workflow's timer, §2.2). At or after it, the step raises **one escalation per clock start** through `raiseEscalation`:
  - trigger `time`; route `intent` when the gate's roles include `person_a`, otherwise `technical`;
  - severity and response level from config **`oversight.gate_overdue`** (default `medium` / `notify`, [Proposal] pilot values);
  - packet: `subject_kind` `intent`, `spec` or `plan` with the gate's input hash (`intent` with the G1 hash while the input is missing), and `gate`; producers: none (no change produced yet, QUESTIONS #64).
  - "Once" is checked against the escalations of the intent (trigger `time`, same gate, created at or after the clock start). `escalations.created_at` is now the escalation clock, like the other clock columns.
- **Closing:** when the gate is decided (the advance, a rejection, a request for changes, the HOTL pass, a return), the step closes its open `time` escalations of that gate, **before the freeze check**: its own freeze (a missed acknowledgement) never blocks the move it was raised for. Other escalations still freeze.
- From the raise on, the escalation's clocks (acknowledge, backup, governance, resolve) are the escalation loop's (ADR-M28), never a workflow timer.

## 3. Risks

- **A late signal delays a gate.** A lost signal is caught up by the reconcile loop, at most `SDLC_WORKER_RECONCILE_MS` later (10 minutes by default). Signals are only lost when a process stops between a commit and the signal.
- **Temporal down.** Decisions are still recorded (the database is the source of truth); the api and the poller log the failed signal; the reconcile loop catches up after Temporal returns.
- **Workflow code changes** after intents run: from C06 on, changes to `intentWorkflow` use `patched()` or a new workflow type. No production workflows exist yet.
- **Status comments wait for the poll** (up to `github.poll_interval_seconds`), like escalation notices.
- **An approval before a request for changes** blocks the same person from approving the same input again. The fix is a new input version (§2.4). Kept for the pilot; §2.4 says how to loosen it if the pilot data shows it is too strict.
- **The test server differs from a real server** in one known way (sticky queues, §2.7). The smoke test on the Compose Temporal covers it.
- **A HOTL pass can be taken back** only within its window and only to send the intent back or end it. C06 waits for the window, so no run starts on a gate that may still be blocked.
- **An overdue escalation closes itself** when the gate is decided. If people rely on it as a reminder after a request for changes, the clock starts again and a new one is raised at the next deadline.

## 4. Consequences

- D-05 version 1.12: `intents.gate_entered_at`, the one-open-intent indexes, table `intent_notices`, the audit index by entity.
- Migration `0009-intent-workflow`. SQLSTATE `SDA10`.
- Catalog: `intent.status.*`, `gate.name.*`, `api.error.gate_not_current`, `api.error.issue_already_linked`, `comment.reply.gate_not_current`, settings and start messages.
- Handbook Ch.19 §19.8b: status comments, decisions at the current gate, one open intent per issue.
- New package `@sdlc/workflow-client`; new command `pnpm test:workflow`; CI job `db` runs it.
- Session 2: D-05 version 1.13 (notice kinds `hotl_passed`, `returned`; `waited_seconds`; clock notes), D-03 version 1.9 (§6 HOTL block window and C06; §6.4 the gate timer), D-08 version 1.9 (C06 note). Config key `oversight.gate_overdue`. Catalog `intent.status.hotl_passed`, `intent.status.returned`, `api.error.scope_not_allowed`. Handbook Ch.19 §19.8b and Ch.18 §18.8b. Command `pnpm test:workflow-compose` in the CI job `compose`. No migration.

## Version history

| Version | Date | Author | Notes |
|---|---|---|---|
| 0.1 | 2026-09-27 | Claude (task B07, session 1) | First version |
| 0.2 | 2026-09-27 | Claude (task B07, review of PR #101) | §2.4: current-gate rule accepted and checked under the intent lock; strict re-approval after a request for changes kept for the pilot, with the way to loosen it |
| 0.3 | 2026-09-27 | Claude (task B07, session 2) | §2.2 the one timer (`wakeInMs`); §2.4 no scope at G1–G3 (D3), `waited_seconds`; new §2.4b HOTL and the block window (#88, D1, D2); new §2.9 overdue gates (#90, D4); §2.7 session 2 tests and the Compose smoke test; §2.8 rules |
