# ADR-M93. A secret scan of a run's diff before G5

| Item | Value |
|---|---|
| Status | **Accepted** (Harry, 2026-10-24, in the H04 plan; QUESTIONS #586–#590) |
| Date | 2026-10-24 |
| Decided by | Harry (H04 plan approved on 2026-10-24) |
| Related | D-08 H04 AC1–AC3; D-02 FR-33, NFR-03, NFR-04; D-03 §6 (G5); D-05 §5, §6.4; ADR-M34 §2.2–§2.8 (the changes step, G5); ADR-M38 (the push after G5); ADR-M80 §5 gap G-10; ADR-M22 §2.5 (coded run events); QUESTIONS #586–#590 |

## 1. Context

ADR-M80 gap G-10 (Medium): the agent may carry a secret it found in the repository (a key in a test file, a token in a configuration) into its diff. The platform had no scan of the diff. G6 relied on the project's own CI, which runs only **after** the platform pushed the branch and opened the pull request: by then the secret is on the Git host, in a branch everybody with read access can see.

The runner already computes the run's diff outside the sandbox and stores it as evidence (ADR-M34 §2.2). Nothing is pushed before G5 passes (ADR-M38 §2.2). A scan of that diff before G5 closes the gap at the right place.

## 2. Decision

### 2.1. Gitleaks, pinned, always on (QUESTIONS #588)

- **Scanner: Gitleaks 8.30.1** (MIT licence, NFR-04). The repository already uses it in the CI `scan` job; D-01 lists it. It is a single static binary, and its regular expressions use RE2, which runs in linear time: a crafted pattern cannot make it hang.
- **One pin.** `platform/deploy/scripts/gitleaks.sh` downloads the release archive and checks its SHA-256 (linux x64 and arm64, macOS x64 and arm64). The version and the linux x64 digest equal the CI `scan` job's `GITLEAKS_VERSION` and `GITLEAKS_SHA256`; a unit test keeps them equal. The runner image runs the script in its build stage (for the build machine's own architecture) and copies the binary to `/usr/local/bin/gitleaks`. CI jobs that run the runner in-process, and developers, put the script's binary on `PATH` (the tests build runner settings without `SDLC_RUNNER_GITLEAKS_PATH`, and the default `gitleaks` is found there) and set `SDLC_RUNNER_GITLEAKS_PATH` for the scanner tests.
- **Always on.** No project configuration turns the scan off. A project chooses its rules only through its own `.gitleaks.toml` (§2.2). The runner settings name the binary (`SDLC_RUNNER_GITLEAKS_PATH`, default `gitleaks` on `PATH`) and the time limit (`SDLC_RUNNER_SECRET_SCAN_TIMEOUT_SECONDS`, default 120).

### 2.2. What is scanned, with which rules (QUESTIONS #586)

- **The added lines only.** `secrets.ts` reads the stored patch in memory and keeps, per file, the lines a hunk adds (hunks separated by an empty line, so a private key stays whole). Removed and context lines, deleted files and binary patches are not scanned: a secret that only leaves the repository is not a new leak.
- **A private scan folder.** The added lines are written into `<clone>/secret-scan/files/` (mode 700, removed in `finally`), one file per changed path, so path allowlists still apply. A path that is not a plain relative path, and a file named like Gitleaks' own files (`.gitleaksignore`, `.gitleaks.toml`, any case), gets a neutral name: its content is scanned, never used as configuration. Gitleaks reads a `.gitleaksignore` from the scanned folder whatever `--gitleaks-ignore-path` says, and its default rules skip `.gitleaks.toml`; both were found by the H04 tests.
- **Rules.** The repository's `.gitleaks.toml` **at the run's base commit**, read with hardened git (`ls-tree`, `cat-file`; a regular file of at most 256 KiB, never a symbolic link). Never the version in the diff: the agent cannot allowlist its own change. No file: the built-in rules (`[extend] useDefault = true`). A configuration that extends another file (`[extend] path`) is refused, because the path would be read on the runner's host. `.gitleaksignore` is not used: its fingerprints name commits, and the diff has none.
- **How Gitleaks runs.** `gitleaks dir` with an explicit `--config`, an empty ignore folder, `--ignore-gitleaks-allow` (the agent could write `gitleaks:allow` comments), `--redact=100`, no archive traversal, a JSON report on standard output, a clean environment (`PATH`, `HOME`, `LC_ALL` only: no `GITLEAKS_CONFIG` from the runner's) and the time limit. Its standard error is never read or passed on.

### 2.3. What is recorded: codes and counts only (R030, R031)

The run event `secrets_scanned`, written in the same transaction as `diff_stored` and `changes_checked`:

| Field | Value |
|---|---|
| `result` | `clean`, `found` or `failed` |
| `findings` | Number of findings |
| `rules` | `repository` or `built_in` |
| `rule_ids` | Distinct rule codes found, sorted, joined by `:`, at most 128 characters (new run event field kind `codes`). A rule ID that is not a code (a repository may name rules freely) is `custom` |
| `config_sha256` | SHA-256 of the configuration Gitleaks was given |
| `scanner_version` | `gitleaks version`, when it is a version number |
| `cause` | Why a scan failed: `scanner_missing`, `scanner_failed`, `timeout`, `config_refused`, `config_unreadable`, `output_invalid`, `diff_unreadable` |

Never a match, a secret, a line, a path or a fingerprint: only the rule IDs of the redacted report are read. The values pass the database CHECK `run_event_payload_is_coded` without a change. The event is copied into the Evidence Pack (`PACK_RUN_EVENTS`).

### 2.4. What G5 does (QUESTIONS #587, #589, #590)

G5 checks the scan right after the instruction files and before the scope and the caps:

| Scan | G5 | Escalation |
|---|---|---|
| `found` | `fail secret_in_diff` (audit check `secret_found`), paused at G5 | `security`, trigger `risky_action` |
| `failed`, or no `secrets_scanned` event | `fail secret_scan_failed`, paused at G5 | `technical`, trigger `unusual_behaviour` |
| `clean` | the next check | — |

- Two new gate reason codes (`gate_reason_code`, migration `0042-secret-scan`).
- **No pull request carries the secret.** The branch is pushed only after G5 passes, and the push uses exactly the diff G5 checked (ADR-M38 §2.2). A held run is never pushed.
- **No override** (QUESTIONS #589). The escalation's decisions stay `resume` (a new run after G4), `modify` or `roll_back` (back to G3) and `terminate`. There is no "push anyway". A false positive is fixed by an allowlist in `.gitleaks.toml` on the default branch, through a reviewed pull request; then `resume`.
- **A run without the event** (a runner older than this change, QUESTIONS #590) is held as `secret_scan_failed`.
- The G5 input hash does not change: it already binds the diff's SHA-256, and the scan is a function of the diff and the base commit's configuration.

### 2.5. Accepted limits

- Gitleaks' default rules skip some paths (for example lock files). A secret placed in such a file with the built-in rules is not found. A project that needs more uses its own `.gitleaks.toml`.
- A secret Gitleaks has no rule for is not found. The project's own CI scan at G6 stays.
- The stored diff (evidence) still holds the secret for the evidence retention period, as before. The person who decides the escalation rotates the secret.
- The person sees the rule codes and the count, not the place. The agent usually copied a secret already in the repository: Gitleaks on a clone at the run's start commit finds it. There is no download of a work run's diff today (only of an L1 proposal, ADR-M64); one is a possible follow-up.

## 3. Consequences

- Every run that reaches G5 has `secrets_scanned`. A runner without Gitleaks holds every run at G5 (`secret_scan_failed`, cause `scanner_missing`): the image ships it, and the upgrade notes say so.
- Test fixtures that play the runner record a clean scan.
- Tests: `platform/tests/runner/secrets.test.ts` (parsing, the event, the real Gitleaks on a real clone with fake secrets built at run time), `platform/tests/workflow/gate-g5.test.ts` (order), `platform/tests/integration/db/gate-g5.test.ts` (hold and escalation), `platform/tests/gitleaks/runner-pin.test.ts` (one pin).

## Version history

| Version | Date | Author | Notes |
|---|---|---|---|
| 1.0 | 2026-10-24 | Claude (task H04), accepted by Harry in the plan | First version |
