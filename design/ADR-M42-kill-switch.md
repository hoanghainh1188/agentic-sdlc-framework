# ADR-M42. The kill switch and loop detection

| Item | Value |
|---|---|
| Status | **Proposed** (task C11, for review) |
| Date | 2026-10-03 |
| Decided by | Harry (plan approved 2026-10-03, with answers to QUESTIONS #180–#184) |
| Related | D-08 task C11 (AC1–AC3); D-02 FR-11, FR-18, FR-34, FR-35, §10 item 5d; D-03 §6, §6.5, §7.1, §8.2, §9 (version 1.22; PR 2: §6.5, §7.2, 1.24); D-05 §5, §6.2, §6.4 (version 1.27; PR 2: 1.29); config rule M27 (PR 2); handbook Ch.3 §3.6, Ch.6 §6.7, Ch.18; ADR-M10 §4.1, ADR-M22, ADR-M23, ADR-M25, ADR-M27, ADR-M28, ADR-M29, ADR-M33 §2.6–§2.7, ADR-M34 §2.2, §2.6, ADR-M38 §2.3; QUESTIONS #44, #52, #180–#184 |

## 1. Context

D-02 FR-34 asks for a kill switch: Person A, Person B, governance or the platform stop any run, the sandbox stops, and the run's credentials and virtual key are revoked **within 5 minutes** (§10 item 5d). FR-35 asks for loop detection: more than 3 identical consecutive tool calls, or no progress within a window, stop the run as stalled.

What existed before C11:

- `run_status` already had `stopping`, and `runs.killed_by` existed (D-05, ADR-M22). `platform_app` may update both.
- The runner's driver already gives way when another process moves a run out of `running` first (ADR-M29 §2.4), and provisioning already throws `run_stopped` when the run leaves `provisioning` (ADR-M25 §2.8).
- A run is one Temporal activity on the queue `sdlc-runner` with a 30-second heartbeat (ADR-M33 §2.6). A cancel of that activity makes the runner stop the agent first (interrupt, then kill), then remove the sandbox.
- `finishRun` and `abandonRun` revoke the run's virtual key at once, by run (`endRunKey`, ADR-M33 §2.7). `stopped_killed` already paused the intent at G4, "C11 raises its own escalation".
- GitHub tokens: the worker issues a `contents: read` token per run and a `contents: write` token per push, and hands them to the runner wrapped (single use). Only the runner holds them; the sandbox holds none (QUESTIONS #44, #52).
- Escalations: `kill_run` and `revoke_credentials` are never frozen (ADR-M28 §2.4).

This ADR covers PR 1 (the kill switch, AC1–AC2) and PR 2 (loop detection, AC3).

## 2. Decision

### 2.1. Who may kill (AC1, QUESTIONS #180)

- New project config **`access.kill_roles`**, default `[person_a, person_b, governance]` (FR-34). **Mandatory rule M25:** the list always holds these three roles and never `viewer`; a project may add roles (for example `pm_brse`).
- **The producer of the run may kill it.** Killing is containment, never an approval: making it harder makes the platform less safe. The escalation it raises is decided by someone else (FR-18), and the run's `triggered_by` is a producer of that escalation.
- No role on the project → `run_not_found` (404), as for any object of a project the caller cannot see. Another role → `forbidden` (403).
- "The platform" kills with the operator command `sdlc ops run kill --tenant <slug> --run <id>` (actor `system`, `killed_by` null), for when nobody with a role is reachable or the API is down.

### 2.2. The path of a kill (QUESTIONS #182)

The database is the source of truth; two signals carry the kill to the runner.

```text
API / `/kill` / ops ──► requestRunKill (core, one transaction under the intent lock)
                          queued → stopped_killed            (no runner took it)
                          provisioning | running → stopping  (killed_by = the person)
                          run event kill_requested · escalation · audit run.kill_requested · notice run_killed
                    ──► after the commit: workflow signal `kill`, then `wake` (API, poller)
runner (each poll, 1 s) ─ sees `stopping` ──► interrupt, then kill the agent ──► stopped_killed / killed
workflow (kill signal while `executeRun` is pending)
                          ──► cancel the activity (WAIT_CANCELLATION_COMPLETED)
                          ──► revokeKilledRunKey (worker): the virtual key, at once
runner lost              ──► heartbeat timeout (2 min) ──► abandonRun: stopping → stopped_killed, key revoked
```

- **The runner reads the run status on every poll** of the agent (`pollUntilDone`, default 1 s), and once more after the clone and before the sandbox (`provisionRun`). A kill reaches it even when Temporal or the worker is down.
- **The workflow's `kill` signal** (no data) cancels `executeRun` when it arrives while that activity is pending. An activity that has not started (the run waits in Temporal for a runner slot) never starts. A started one gets the cancel on its next heartbeat; the runner's cancel path checks the database and ends a `stopping` run `stopped_killed`, any other run `failed` / `agent_cancelled` as before. A kill signal at another time changes nothing: the workflow counts signals from the moment it prepares a run, and every kill freezes the intent (§2.3), so no newer run can exist when a late signal arrives.
- **Lost signals.** The API and the poller only log a failed signal. The worker's reconcile loop sends `kill` again, every pass, to `running` intents whose current run is `stopping` or `stopped_killed` (`SystemScope.listKillingIntents`); this also covers the operator command, which has no Temporal client.
- **No lost kill** (code review): a kill can land between a writer's read and its update (for example while the runner commits after the agent finished). Every writer that ends a run (the driver, the activity's cancel path, provisioning, `abandonRun`, the runner's clean-up) uses one conditional update, `RunRepository.end`: from the statuses it expects to its outcome, **or**, when the run is `stopping`, to `stopped_killed` / `killed`. A run is therefore never left in `stopping`.
- **Replay.** The run activity now runs in a `CancellationScope` raced with a `condition`; neither adds a command, and `cancellationType` is not part of the scheduling command. Old histories never saw the signal and replay unchanged (tested).

### 2.3. How the intent continues (QUESTIONS #181)

- The kill raises its escalation **at once**, in the transaction that records it: trigger `risky_action`, route `technical` (Person B first), severity and response level from new config **`run.kill_escalation`** (default `high` / `contain`). **Mandatory rule M26:** the level is `pause`, `contain` or `incident`, so the intent stays frozen until a person decides. Packet: subject `run_contract` (the contract hash), gate `G4`, the run and the agent.
- When the run ends, `finishRun` moves the intent to `paused` at G4 (notice `run_failed`, as before; the kill's own notice `run_killed` was posted at the kill).
- The decision: `resume` → back to G4 and a new round (as for a failed run, ADR-M33 §2.7); `terminate` → the intent ends `cancelled` (notice `terminated`, gate G4). `terminate` is new for a paused G4 and also applies to a failed run's escalation.
- `already`: a second kill of a `stopping` or `stopped_killed` run records nothing again and answers `already: true`. A run that ended otherwise is refused (`run_not_active`, 409). A kill during the push at G6 is refused too: the run is final (`succeeded`) and what runs is a short platform action, not the agent; the freeze of an escalation already covers `push` and `open_pr`.

### 2.4. Credentials (QUESTIONS #182, ADR-M38 §2.3)

- **The virtual key** is revoked by the worker, which holds the LiteLLM master key: at the kill signal (`revokeKilledRunKey`), and again when the run ends (`finishRun`, `abandonRun`; revoking twice is harmless).
- **GitHub tokens.** GitHub revokes an installation token only with the token itself (`DELETE /installation/token`), and only the runner holds the run's tokens. So the runner revokes them **right after their use**: the clone token when the clone ended, the push token when the push ended, whatever the outcome (run events `token_revoked`, `token_revoke_failed`). A kill then finds no GitHub token left, except during a clone, which revokes its own when it ends. A failed revocation is recorded and never blocks: the token expires within the hour.
- New `GitHostAdapter.revokeShortLivedToken(token)` (fifteen methods, D-03 §7.1). It needs no App key, so the runner uses a token-only `GitHubAdapter` (its secret reader refuses every read; the runner never holds the App key, QUESTIONS #44). Setting `SDLC_RUNNER_GITHUB_API_URL` (default `https://api.github.com`, `https://` only because the run's tokens go there; `off`: tokens expire by themselves). An already revoked or expired token (401) counts as revoked.

### 2.5. A wrapping token someone else opened (ADR-M38 §2.3)

- A single-use wrapping token that OpenBao **refuses** while the run's contract is valid (unknown, expired or used: `secrets.wrapping.invalid_token`, or not made by `sys/wrapping/wrap`: `wrong_origin`) was probably opened by someone else (ADR-M25 §2.11). An unreachable, sealed or failing OpenBao is not such a signal (code review); the secrets client now reports a lookup answer other than 400, 403 or 404 as `secrets.openbao.invalid_response`, not `invalid_token`. The runner records **`wrap_token_reused`** (`clone`, `push`, `virtual_key`); the run fails as before (`token_unavailable`, `key_unavailable`, `publish_failed`).
- The escalation of such a failed run (and of a stopped push at G6) goes to the **`security` route** instead of `technical` (`failedRunRoute`). OpenBao answers the same for a used and an expired wrapping token; the push token's wrapping lives 10 minutes, so an attempt that started very late is a false alarm the security owner closes.

### 2.6. The killed run's diff (QUESTIONS #183)

- A killed run often means suspicious behaviour: its changes are the key evidence for the escalation review and an incident record (handbook Ch.6 §6.7 "preserve evidence").
- The runner stores the diff **best-effort, after containment**: only after the run is recorded `stopped_killed`, after it killed every process of the sandbox (`POST /containers/sdlc-sandbox-<run>/kill`, a new endpoint of the runner's Docker allowlist and of the socket proxy, sandbox names only: nothing the agent left running may change the workspace while it is read; the volume stays), and only once the gateway refuses the run's key (`LiteLLMKeySpendReader.keyRevoked`: `/key/info` with the key answers 401; a 403, which a proxy could send, does not count), within `SDLC_RUNNER_KILL_EVIDENCE_SECONDS` (default 60, 5–300). Then the same code as a run that goes to G5 (`computeRunPatch`, `storeChanges`, ADR-M34 §2.2): evidence `diff`, run events `diff_stored`, `changes_checked`.
- Every failure is only recorded (`kill_evidence_failed`: `unavailable`, `sandbox_not_stopped`, `key_not_revoked`, `timeout`, `failed`) and the sandbox is removed anyway. This time is outside the 5-minute clock: the run is `stopped_killed` and its key revoked before it starts. A diff still being written when the time is up may land after `kill_evidence_failed` (the store refuses overwrites, so it is never a second version).

### 2.7. Loop detection (AC3, QUESTIONS #184, PR 2)

As built in PR 2 (`packages/adapters/agent-openhands/src/loop.ts`, `apps/runner/src/agent/loop-watch.ts`, `drive.ts`):

- **Identical** tool calls: the same tool and the same SHA-256 of the canonical arguments (RFC 8785; the volatile fields `summary`, `security_risk` and `kind` dropped at every depth, as in the spike's `loop-detector.ts`; string arguments are parsed first, so a string and an object with the same content are equal; the tool-call ID never counts). Adapters import `@sdlc/contracts` only, so the adapter has its own canonicaliser; a test checks that it gives the same text as `canonicalJson` of `@sdlc/config` for JSON data. Unlike that module it never throws on the agent's input (a lone surrogate is made well formed, a value that is not JSON counts as `null`); this changes only the comparison.
- `AgentRunStatus` (`@sdlc/contracts`, D-03 §7.2) carries two counts the adapter computes from the event log it already reads on every poll: `events` (events of any kind) and `identicalCalls` (identical calls in a row at the end of the log; other events between them do not break the run). The hashes stay in the adapter's memory.
- The runner stops the agent (interrupt, then kill, as at the time cap) when `identicalCalls` is **more than** `loop_threshold` (the contract; config `run.loop_detection.identical_tool_calls_max`, rule M10: ≤ 3) → `stopped_stalled` / stop reason `loop_detected`.
- **No progress:** `events` has not grown for `run.loop_detection.no_progress_window_minutes`, read from the effective configuration when the run starts (not a contract field: that would change `schema_version`, ADR-M22) → `stopped_stalled` / `no_progress`. The window starts when the agent starts; only a status that was read counts (a failed read is neither progress nor silence). File changes are not used: they are invisible while the agent reads or runs tests, and a long `pnpm install` gives its observation only at the end, so the window needs slack. Rule **M27**: at most 30 minutes ([Proposal]); a warning under 5 (`config.warning.loop_window_short`). The default (15) is unchanged, so stored configuration hashes do not change; a stored configuration with a window above 30 now fails closed (`config_invalid`).
- **Periodic events (Harry's review):** "any new event" only works if the Agent Server sends nothing while the agent waits. Checked on Agent Server 1.48.0 in `pnpm test:agent` on 2026-10-04 (`[stub:silent]`: the model holds its first reply for 10 minutes; real time, no scaled clock; a one-minute window against a five-minute time cap): the run ended `no_progress` with `idle_minutes` 1, more than a full real minute after the agent's last event, well before the time cap. While the agent waits for the model the Agent Server sends **no** periodic event (no heartbeat, no state update) into the conversation's event log, so no event kind needs to be filtered. If a later Agent Server version adds such events, this test fails (the time cap ends the run instead): check it whenever the pinned version changes.
- **Order** when several stops are due in one poll: the kill, the activity's cancel, the agent's own end, the time cap, the budget, then the loop checks (identical calls before no progress). A run over budget ends `stopped_budget` (`max_budget`), which tells the reviewer more; every one of them goes to G5. A kill that lands after the poll still wins (`RunRepository.end`, §2.2).
- Run event `loop_detected` with counts only (`identical_calls`, `threshold`, `idle_minutes`: whole minutes since the log last grew), then `agent_stopped` with `reason` `loop_detected` or `no_progress`. Never tool arguments, paths, commands or agent text. Both stops go to G5, which already treats `stopped_stalled` as `run_cap_reached` (ADR-M34 §2.8): the intent is paused at G5 with an `intent` escalation; the run's key is revoked when the run ends (`finishRun`), as for any run.
- **OpenHands' own stuck detector** stays on (ADR-M29). It has fixed thresholds (4 repeats, ADR-M10 §4.1 item 2): with the default threshold 3 both may fire on the 4th identical call, and the run may end `agent_stuck` instead of `loop_detected`. Both are `stopped_stalled` and G5 treats them the same; the stop reason tells which detector fired. Not turned off: it is a second, independent check.
- At a 1-second poll the agent may make one more call before the interrupt lands; the stop still happens after more than 3 identical calls, as FR-35 asks. Reading events over the WebSocket stays a later option (ADR-M10 §4.1 item 2).

### 2.8. Where the rules live

| Rule | Source | Where |
|---|---|---|
| Who may kill | FR-34; QUESTIONS #180 | Config `access.kill_roles`; mandatory rule M25 |
| The kill's escalation freezes the intent | D-03 §6.5; QUESTIONS #181 | Config `run.kill_escalation`; mandatory rule M26 |
| Loop threshold | FR-35; Ch.3 §3.6 | Config `run.loop_detection.identical_tool_calls_max` → contract `loop_threshold`; rule M10 |
| No-progress window | FR-35; QUESTIONS #184 | Config `run.loop_detection.no_progress_window_minutes`; mandatory rule M27 (≤ 30), warning under 5 |
| Order of stops due in the same poll | Harry's review of the PR 2 plan | Code (`apps/runner/src/agent/drive.ts`, `pollUntilDone`) |
| Time for a killed run's evidence | QUESTIONS #183 | Runner setting `SDLC_RUNNER_KILL_EVIDENCE_SECONDS` (technical) |
| A kill stays a kill: `stopping` ends `stopped_killed` only; `killed_by` set once; stop reason `killed` | D-05 §6.4 | Database (migration 0020, `SDA13`) |
| Tokens revoked after use; a reused wrapping token goes to security | ADR-M38 §2.3; QUESTIONS #182 | Code (`apps/runner/src/tokens.ts`, `kill/kill-run.ts`) |

## 3. Interfaces

- API: `POST /v1/runs/:run/kill` (202: `{ run, intent, status, already, escalation }`; 403, 404 `run_not_found`, 409 `run_not_active`) and `GET /v1/intents/:intent/runs` (codes, counts and times; read roles as for plans).
- CLI: `sdlc run kill <run ID|INT-…>` (an intent code stops its current run) and `sdlc run list <INT-…>`, both with `--json`; `sdlc ops run kill`.
- Comment command: `/kill` on the intent's issue or pull request; any text after it is the reason and stays on GitHub (a kill never fails on its wording). Refusals are answered (`kill_forbidden`, `kill_no_active_run`, `user_not_linked`, `intent_not_found`); a kill is confirmed by the status notice `run_killed`. Bots never kill.
- Contracts: `INTENT_KILL_SIGNAL`, `IntentWorkflowSignals.kill`, `GitHostAdapter.revokeShortLivedToken`.

## 4. Consequences

- **Measured** (`pnpm test:runner`, live Docker on a developer Mac, 2026-10-03): from the kill to the run `stopped_killed` with its diff stored about **1.0 s**, and to the sandbox, its network and volume removed about **1.1 s**, against the 5-minute target (FR-34, §10 item 5d). The clone token was revoked before the kill, right after the clone. In the field the time is bounded by the runner's poll (1 s), the agent's stop grace (30 s) and, when the runner is lost, the heartbeat timeout (2 minutes).
- A run killed while waiting for a runner slot never starts, and the intent moves on at once instead of after the slot frees.
- The runner reads the run's row once per poll: one indexed read per second per running sandbox.
- The workflow waits until the runner has stopped the agent and cleaned up before it finishes the run (`WAIT_CANCELLATION_COMPLETED`); a lost runner is still bounded by the heartbeat timeout.
- A token revocation failure leaves a token alive until GitHub's expiry (1 hour); it is recorded.

## 5. Open items

- Kill by intent in one call (`POST /v1/intents/:intent/kill`): not needed; the CLI resolves the current run.
- An automatic kill by the platform (for example on a critical finding during a run) is not in the MVP; the operator command covers "the platform" of FR-34.

## Version history

| Version | Date | Author | Notes |
|---|---|---|---|
| 1.0 | 2026-10-03 | Claude (task C11, PR 1), approved by Harry | Kill switch (§2.1–§2.6); loop detection planned |
| 1.1 | 2026-10-04 | Claude (task C11, PR 2), approved by Harry | §2.7 as built: the adapter's counts, the runner's loop watch, rule M27, the order of stops, the periodic-events check, the OpenHands stuck detector; §2.8 |
