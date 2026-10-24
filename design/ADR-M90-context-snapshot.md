# ADR-M90. A context snapshot for every run

| Item | Value |
|---|---|
| Status | **Accepted** (Harry, 2026-10-24, in the X07 plan, with D-05 1.61; QUESTIONS #556, #557) |
| Date | 2026-10-24 |
| Decided by | Harry (X07 plan approved on 2026-10-24) |
| Related | D-08 X07 AC1–AC4; D-02 FR-40, FR-41, §4.2; D-05 §6.4, §6.6; ADR-M29 (OpenHands adapter), ADR-M88 (OpenCode adapter), ADR-M48 (Evidence Pack), ADR-M89 §2.7 (`knowledge_read`); QUESTIONS #361, #556, #557 |

## 1. Context

A reviewer of an agent's change wants to know what the agent based it on: which repository files it opened, which project documents its tools returned, and which plan and spec it was given. D-02 §4.2 put "full context snapshots" later; QUESTIONS #361 moved a first version into milestone EXT as X07. X04 PR 3b already records what a `read_documents` tool returned (`knowledge_read`, ADR-M89 §2.7). X07 adds the files and the versions and joins them into one record per run.

The rules of the platform still hold: append-only tables, run events, logs and Temporal never hold a path, a text, a prompt or code (R030, R031).

## 2. Decision

### 2.1. What the agent opened (`AgentFileReads`)

- `AgentOutputs` gains `reads`: the files the agent opened with its file-reading tool, relative to the working directory, sorted and distinct; how many opens were outside the working directory; and how many tool calls can read files without naming them.
- Each adapter reads its own log, because the log format is the adapter's:
  - OpenHands: `file_editor` with the command `view` is a read; every `terminal` call is counted as unattributed. Edits (`create`, `str_replace`, `insert`) are not reads: the diff records them.
  - OpenCode: the `read` tool (`filePath`) is a read; `bash`, `grep`, `glob` and `list` are counted as unattributed. The adapter's own commit and diff commands, which OpenCode logs as `bash` calls, are never counted.
- `@sdlc/agent-kit` makes the paths relative (`workspacePath`, `fileReadsOf`); a view of the working directory itself is not a file read. The paths are client data: they go back to the runner in memory only, like `changedFiles`.
- The driver returns `reads` with the run's result (also for an L1 run). Without a readable log (a kill, a time cap kill, a failure, a restart) there is no `reads`.

### 2.2. The snapshot (evidence kind `context_snapshot`)

One JSON file per run, canonical (RFC 8785), stored with the run's diff credential under `diffs/`, path `<intent>/<run>.context-snapshot.json`:

| Field | Content |
|---|---|
| `schema_version` | `1` |
| `run_id`, `intent_id`, `base_sha` | From the signed Run Contract |
| `plan` | `plan_id`, `plan_sha256` from the contract |
| `spec` | `version`, `commit_sha`, `content_sha256` of the intent's newest spec version linked before the run started; `null` when there is none |
| `files` | `source` (`agent_log` or `unavailable`), `path_sha256` (the SHA-256 of each relative path, sorted), `outside`, `unattributed_calls` |
| `documents` | Per `read_documents` tool, sorted by key: `tool_key`, `index_id`, `list_sha256`, `documents`, `chunks` (the latest `knowledge_read` of the tool) |

- Paths are hashed, never stored in clear, not even in the evidence file (QUESTIONS #556 a). A plain SHA-256 of a common path can be guessed; this is accepted, because access is tenant-scoped and `knowledge_read` uses the same pattern. A reviewer checks a path by hashing it.
- Migration `0041-context-snapshot-evidence` adds the kind to `evidence_items`.

### 2.3. When it is recorded (run event `context_snapshot`)

- In `releaseSandbox` and in the clean-up after a restart, right after `knowledge_read` and before the sandbox is removed, once per run (a retried release records nothing new).
- Only for a run whose agent started (`agent_started`): a run that failed in provisioning or was still queued read nothing.
- The run event holds `snapshot_sha256`, `source`, `files`, `files_outside`, `unattributed_calls`, `document_tools`, `documents`. Without an evidence store the event is still written; the file is then not kept.
- A failure to record it never keeps the sandbox (like `tool_used` and `knowledge_read`).
- When the evidence store refuses the file (down, or the path taken by an earlier attempt whose transaction failed), the event is still written with the snapshot's hash and no evidence row, as for `knowledge_read`: the pack then shows the hash and counts without the file.

### 2.4. In the Evidence Pack

`context_snapshot` is one of the run events the pack copies (`PACK_RUN_EVENTS`): the manifest lists it under each run's `events`, the Markdown in the checks table. The file itself is listed with the evidence files and re-checked (SHA-256, size) before every build (ADR-M48).

## 3. Consequences

- The snapshot shows what the agent opened by name, not everything it saw: a shell command or a search can read files the snapshot cannot name. `unattributed_calls` says how many such calls there were, so a reviewer knows how complete the list is.
- The snapshot does not hold the prompts or the model's answers (they stay in Langfuse traces, ADR-M53) or the content of the files (the base commit identifies it).
- A second agent adapter must fill `reads` from its own log.
- Packs built before X07 do not change; a run with a snapshot changes the pack's content hash.

## 4. Tests (QUESTIONS #557 a)

- Unit: the paths (`platform/tests/agent/file-reads.test.ts`), both adapters' `collectOutputs`, the snapshot and its recording (`platform/tests/runner/context-snapshot.test.ts`), the event type, the pack (`platform/tests/evidence/pack.test.ts`).
- PostgreSQL (`pnpm test:db`): a run with a `knowledge_read` event and file reads gets one snapshot, the database accepts the kind and the event, and the Evidence Pack lists it (`platform/tests/integration/db/context-snapshot.test.ts`).
- `pnpm test:agent` (both adapters): `[stub:reads]` makes the real agent open two files and run one shell command; the snapshot lists the two path hashes and one unattributed call, and no path reaches a run event or a row.
- `knowledge_read` from a real tool is proven by the X04 live test (`platform/tests/integration/runner/tool-docs.test.ts`). One live run with both a tool and file reads can come later in a pilot test.

## Version history

| Version | Date | Author | Notes |
|---|---|---|---|
| 1.0 | 2026-10-24 | Claude (task X07), accepted by Harry | First version (QUESTIONS #556, #557) |
