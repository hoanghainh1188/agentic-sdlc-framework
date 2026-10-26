# ADR-M95. A size bound for a change a person must review

| Item | Value |
|---|---|
| Status | **Accepted** (Harry, 2026-10-26, in the H05 plan; QUESTIONS #456, #601–#603) |
| Date | 2026-10-26 |
| Decided by | Harry (limits: QUESTIONS #456, 2026-10-13; H05 plan approved on 2026-10-26) |
| Related | D-08 H05 AC1–AC3; D-02 FR-11, FR-12, NFR-03; D-03 §6 (G5); D-05 §5, §6.4; ADR-M34 §2.2–§2.8 (the changes step, G5); ADR-M54 §2.4 (one oversight resolution, waiting causes); ADR-M80 §5 gap G-9; ADR-M93 (the secret scan, same step); QUESTIONS #456, #601–#605 |

## 1. Context

ADR-M80 gap G-9 (Medium): nothing limits how large a change a person must review at G7. A very large diff, or one full of generated code, defeats review in practice. Person B approves what they could not read. The plan's file scope (G5 `out_of_scope`) limits *where* the agent writes, not *how much*.

Harry decided the limits in QUESTIONS #456 (2026-10-13): 40 changed files and 1500 changed lines (added plus removed), per project, with generated and lock files counted apart. Over a limit, the run is **held at G5**, never blocked: Person A allows it with a reason code, or sends it back to G3 to split the plan.

## 2. Decision

### 2.1. Configuration

`run.review_limits` in the project configuration (default in `project-config.default.yaml`):

| Key | Default | Meaning |
|---|---|---|
| `max_changed_files` | 40 | Changed files a person reviews, generated files left out |
| `max_changed_lines` | 1500 | Added plus removed lines of those files |

Both are positive integers. A project may raise or lower them. "At the limit" passes; one more file or line is over. [Proposal] review the numbers after the first trial reports.

### 2.2. The runner measures; the run event holds counts only

`apps/runner/src/workspace/review-size.ts`, in the changes step (`storeChanges`), right after `computeRunPatch` staged the mirrored tree in the runner's clone. Everything runs outside the sandbox with hardened git (R064):

1. `git diff --cached --numstat -z --no-renames --no-ext-diff --no-textconv <base>`: added and removed lines per path. A rename is a delete and an add, as in the stored diff. A binary file (`-` `-`) counts as one file and no lines.
2. **Generated files are counted apart** (QUESTIONS #602): lock files by file name (`LOCK_FILE_NAMES`: `pnpm-lock.yaml`, `package-lock.json`, `yarn.lock`, `go.sum`, `Cargo.lock`, `poetry.lock`, `uv.lock`, `composer.lock`, `Gemfile.lock` and the others in the list), and the files that the **base commit's** `.gitattributes` files mark `linguist-generated` (set or `true`). The attributes are read from a temporary index of `base_sha` (`git read-tree` into `<clone>/review-size.index`, then `git check-attr --cached`; the file is removed in `finally`). A `.gitattributes` the agent added or changed is never read: the agent cannot mark its own change as generated. `linguist-generated` is GitHub Linguist's attribute; GitHub also folds these files in a pull request.
3. The run event `diff_measured`, in the transaction of `diff_stored`, `changes_checked` and `secrets_scanned`:

| Field | Value |
|---|---|
| `result` | `measured` or `failed` |
| `review_files`, `review_lines` | What a person reviews (generated files left out) |
| `generated_files`, `generated_lines` | Lock and generated files, counted apart |
| `binary_files` | Binary files among all changed files |
| `cause` | Why the measurement failed: `numstat_failed`, `attributes_failed` |

Never a path (R030, R031). The values pass the database CHECK `run_event_payload_is_coded` without a change. A failed measurement is recorded, never thrown. The event is copied into the Evidence Pack (`PACK_RUN_EVENTS`), so Person B sees the size at G7.

### 2.3. The policy engine compares; one resolution for everybody

The limits are a policy threshold, so the policy engine compares them (it already holds the configuration). `GateContext.reviewSize` (contracts) carries `{ files, lines }`, or `null` when there is no measurement. `policy-simple` resolves G5:

- a breach keeps its own resolution (`limit_breached`);
- otherwise, a size over either limit, or `null`, makes G5 **HITL at every tier**, with at least one approval and the override `review_too_large`;
- otherwise, the matrix cell.

`resolveGateOversight` passes the size of the intent's last run (`reviewSizeOf`, from `diff_measured`). The step, the API's `waiting_for` (and so the dashboard and `sdlc next`) and the gate command all use this one resolution (ADR-M54). The G5 input hash does not change: the size is a function of the stored diff, whose SHA-256 it already binds, and of the base commit.

### 2.4. What G5 does

The order of the G5 checks stays (ADR-M34 §2.8, ADR-M93 §2.4): instruction files, secrets, scope, caps. These are **breaches** (a `fail`, an escalation, or back to G3). The review size comes after them and is **never a breach**: no `fail`, no escalation.

| Size | G5 | The intent waits |
|---|---|---|
| Within the limits | as before (HOTL: a system `pass`; HITL: an approval) | — |
| Over a limit | HITL | `g5_decision`, cause `review_too_large` |
| `failed`, or no `diff_measured` event (QUESTIONS #603) | HITL | `g5_decision`, cause `review_size_unknown` |

A held run waits for a person with G5's role (Person A by default). FR-11 still holds: the person who allowed the run never decides it. The person has two choices (QUESTIONS #601):

- **Allow it with a reason** (QUESTIONS #604): an approval counts only with a reason code of `REVIEW_ALLOW_REASON_CODES`: `generated_change` (most of it is generated code the repository does not mark), `mechanical_change` (a rename, a formatting change, a move), `cannot_split` (the change only works as one piece). The gate command refuses an approval without one (`review_reason_required`), and the step counts only such approvals. `sdlc gate approve G5 <intent> --reason-code generated_change`, or the comment `/approve G5 generated_change` (one allowing code after the gate, nothing else).
- **Split the plan**: a request for changes (`sdlc gate request-changes G5 … --reason-code review_too_large`, or the comment) takes the intent back to **G3**, not G4 as for a run within the limits: a new run of the same plan would make a change of the same size. The audit event `gate.g5_split_requested` (decision ID, check, run ID) makes G3 HITL from then on (`returnedFromG5`), and the earlier G3 approval is voided with the cause as reason code. The same plan is not refused (unlike `out_of_scope`): a person decides at G3.

A rejection ends the intent, as before.

Five new gate reason codes (`gate_reason_code`, migration `0043-review-limits`): `review_too_large`, `review_size_unknown` (the cause and the split) and the three allowing codes.

### 2.5. Accepted limits

- **A per-project list of globs for generated files is not in the configuration** (QUESTIONS #605). The runner does not read the project configuration, and the repository's own `.gitattributes` on the default branch already does the job, through a reviewed pull request. A file the repository does not mark counts; the person allows it with `generated_change`.
- Lines are counted by git: a very long line counts as one line.
- The limits do not stop the agent while it works. A run that writes too much finishes and is held at G5; its cost is spent. The plan's scope and the run's caps still bound the work.
- A run that ended before the upgrade has no `diff_measured`: G5 holds it as `review_size_unknown` (QUESTIONS #603). The upgrade notes say so.

## 3. Consequences

- Every run that reaches G5 has `diff_measured`. Test fixtures that play the runner record a size within the limits.
- `sdlc next` explains a held G5 (advice `decide_g5_review`); the catalog has the two causes (`intent.waiting_cause.review_too_large`, `review_size_unknown`).
- Tests: `platform/tests/runner/review-size.test.ts` (parsing, counts, the event, a real clone: at the limits and over, removed lines, binary files, lock and generated files, a `.gitattributes` the agent changed, the run's index unchanged, a failure); `platform/tests/policy/oversight.test.ts` (the resolution at every tier, the limits from the configuration); `platform/tests/workflow/gate-g5.test.ts` (the hold and its cause, the allowing codes, never a breach); `platform/tests/integration/db/gate-g5.test.ts` (on PostgreSQL: at the limits, over files, over lines and the split at G3, a size not measured, a per-project limit); `platform/tests/commands/comment-command.test.ts` (the comment grammar).

## Version history

| Version | Date | Author | Notes |
|---|---|---|---|
| 1.0 | 2026-10-26 | Claude (task H05), accepted by Harry in the plan | First version |
