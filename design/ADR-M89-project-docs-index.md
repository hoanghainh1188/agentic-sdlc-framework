# ADR-M89. The first register tool: the index of a project's documents

| Item | Value |
|---|---|
| Status | **Accepted** (the repository owner, 2026-10-23, with D-05 1.58; task X04 PR 3a). Version 1.1 (§2.7, task X04 PR 3b) records the answers to QUESTIONS #540–#544 (the repository owner, 2026-10-24) |
| Date | 2026-10-23 |
| Decided by | The repository owner (X04 PR 3 plan approved on 2026-10-23: QUESTIONS #533–#539) |
| Related | D-08 X04 AC1–AC5; D-02 FR-33, FR-44, NFR-03; D-05 §6.1, §6.4, §6.5, §6.6; D-07 §4–§5; ADR-M51 (retention), ADR-M59 §5 (K01 limits), ADR-M69 (tool register, accepted), ADR-M87 (MCP gateway, accepted); runbook T11 §5o; design/QUESTIONS.md #531–#544 |

## 1. Context

ADR-M69 and ADR-M87 give a run register tools behind one MCP gateway (X04 PR 1 and PR 2). The first tool searches the project's Markdown documents (D-08 X04 AC1). K01 (ADR-M59) found that bge-m3 embeddings and a plain vector search match WeKnora's retrieval on such documents, without WeKnora. This ADR records how the index is stored, built, used and deleted. PR 3a builds the index; PR 3b builds the tool, its credential and `knowledge_read` (QUESTIONS #539).

## 2. Decision

### 2.1. The store: `knowledge-db` (QUESTIONS #534)

- A PostgreSQL with the pgvector extension of its own, `knowledge-db` (image `pgvector/pgvector:0.8.1-pg17`, pinned by digest), in the Compose profile `knowledge`, on the `sdlc` network, with its own volume and its own admin password. Never the platform's PostgreSQL: a tool's service network reaches it (ADR-M69 §2.4), and it must never reach the platform's data.
- **One schema per project**, `kdocs_p<project ID without dashes>`, created by the worker. Its tables hold client content (document paths and text) and can be deleted:
  - `chunks` (`sha256`, `model`, `text`, `embedding`): one row per chunk text and model, reused by every index version of the project;
  - `index_versions` (`id`, `base_sha`, `model`, `created_at`): one per base commit and model;
  - `documents` (`index_id`, `doc_id`, `path`, `content_sha256`) and `document_chunks` (`index_id`, `doc_id`, `ord`, `chunk_sha256`).
- One role per project, `kdocs_p<…>_read` (no login), may read that schema only. PR 3b gives a run's tool a login in that role (QUESTIONS #535, #537).
- Chunks are never shared across projects or tenants. The embedding column has no fixed size and no approximate index: a plain search, as K01 measured, is fast enough for a project's documents.
- The worker connects with the admin login from OpenBao (`kv/worker/knowledge-db`, field `password`; the URL without the password in `SDLC_WORKER_KNOWLEDGE_DB_URL`). Without them the index is off and a run with a `read_documents` tool fails (`tool_unavailable`).
- The store is behind the interface `KnowledgeStore` of `@sdlc/contracts`; the adapter `@sdlc/adapter-knowledge-pgvector` implements it (R033).

### 2.2. The platform's record (D-05 §6.1, migration 0039)

Codes, IDs, hashes, counts and dates only:
- `knowledge_indexes`: one row per index built, at most one ready (not purged) per tenant, project, base commit and model: the counts (documents, chunks, bytes), `created_at`, `last_used_at`, `purged_at`.
- `knowledge_index_uses` (append-only): which run and intent used which index version, so retention knows when an index is no longer needed.

### 2.3. Building the index (QUESTIONS #538)

- **When.** In the worker's run preparation, after G4, for each grant with the permission `read_documents`, once the run's key is issued and before the secrets are wrapped. A ready index of the same base commit and model is reused (`last_used_at`, a new use).
- **What.** The Markdown files (`*.md`, `*.markdown`) at the run's `base_sha`, read through the Git host adapter (`listPaths`, `getFileAtCommit`), outside the sandbox. A commit the host lists only in part fails (`tree_truncated`), as at G4.
- **Chunks.** Split at Markdown headings, then at paragraphs, to at most `knowledge.chunk_chars` characters. A chunk's key is the SHA-256 of the model and its text: only new chunks are embedded.
- **Embeddings.** Through LiteLLM with the **run's own virtual key** (its labels: tenant, project, intent, run, gate G4, agent, data class), so the cost counts for the run (R027). The model is the tool's `model_ref` in the register; it must be one of the contract's `allowed_models`, which G4 already checked for the data class (D-07 §4: `client_restricted` only with a self-hosted model, `prohibited` never). The first model is a self-hosted `bge-m3`.
- **Limits** (configuration `knowledge.*`): files, bytes per file, total bytes, chunks, chunk size, embedding batch. A repository over a limit, a file the host cannot read, a model call that fails: the run is cancelled (`tool_unavailable`). A run never gets a partial index.
- The run preparation has 5 minutes (`prepareRun`): the limits keep a first index within it; later runs reuse their chunks.

### 2.4. Retention (FR-44, ADR-M51)

A pass of the retention loop, after the evidence and the Langfuse passes, per project:
- An index version is deleted from `knowledge-db` when every intent that used it is finished and not held (`evidence_holds`), and its `last_used_at` is older than the project's evidence retention (configuration `retention.evidence_retention_days`, never under 180 days).
- When a project is archived, its whole schema is deleted after the archive grace (`archiveDueFor`), unless an intent of the project is held.
- Each deleted index version appends `knowledge.purged` (the project, the index ID, the counts, the cause `retention` or `archive`). The platform's row keeps its counts and hashes, with `purged_at`.
- Order: the row is marked `purged_at` and the audit event written in one transaction, under the row's lock and the intents' locks; only then is the version deleted from `knowledge-db`. So a run never reuses a version whose data is gone. A run that reuses a version moves `last_used_at` under the same row lock.
- The sweep (`purge` mode): store data that no ready row covers and that is older than one hour is deleted: a version whose delete failed, a version a failed build left without a row, and chunks no version uses. An archived project past its grace with no ready version loses its schema and read role. A version no run recorded a use of is decided only one day after its last use, also for an archive.
- A build that finds a shared chunk deleted under it (the retention pass ran between its check and its write) checks and writes once more.
- The pass follows the loop's mode: `report` only counts what it would delete.

### 2.5. What a run records (QUESTIONS #533, #536)

- `knowledge_read` (PR 3b): once per run and tool, the SHA-256 of the sorted list of document ID and content hash the tool returned, and the counts (documents, chunks). The list itself, IDs and hashes only, is an evidence item that the Evidence Pack references. The tool reports what it returned in its own log lines, from outside the sandbox. Never a query, a path or a text.

### 2.6. The run gateway, as found in X04 PR 2 (agentgateway 1.6.0)

- The agent sees a tool by its own name with one target, and as `<tool_key>_<tool>` with more.
- A refusal by the argument rule, the cap or the key is logged without a target: with more than one tool these refusals count for the run only.
- A call refused by the argument rule does not use the cap; over the cap the gateway answers 200 with a tool result marked as an error.

### 2.7. The tool, its login and `knowledge_read` (PR 3b, QUESTIONS #540–#544)

- **The image** (QUESTIONS #542). The repository builds the first tool: `platform/apps/tool-project-docs` (`@sdlc/tool-project-docs`), a small MCP server over Streamable HTTP with one tool, `search_project_docs` (the call rules of `read_documents`). It checks its arguments again, frames the passages as data, and answers with the paths and texts of the best chunks of the run's index version (a plain cosine search, `PgVectorKnowledgeReader`). Image `tool-project-docs`: `pnpm tool-image:build project-docs` locally, the release matrix, `images.sh` and the lock file for a release; CI scans it with the sandbox images. A tenant registers it by digest with the backing services `knowledge-db:5432,litellm:4000` and `--model bge-m3`.
- **The login** (QUESTIONS #535, #537, #540). OpenBao's database engine (mount `database/`, connection `knowledge-db`, `allowed_roles` `kdocs-*`) logs in as the role `kdocs_issuer`: it may create and drop roles and end their sessions, and holds each project's read role with the admin option only (`INHERIT FALSE, SET FALSE`), so it cannot read an index itself. Its password is rotated inside OpenBao (`rotate-root`); nobody knows it. For each run with a `read_documents` tool the worker writes **one OpenBao role per run**, `kdocs-<run_id>`, whose creation statement grants only the project's read role (`@sdlc/secrets` builds it from checked names), and reads one login with a time to live of the run's time cap plus the contract's validity (`VALID UNTIL` too). At the end of the run, at a kill and for an abandoned run, it revokes `sys/leases/revoke-prefix/database/creds/kdocs-<run_id>` and deletes the role: the run ID alone finds them, so no lease ID is kept or travels (R031). Run events `tool_credential_revoked` / `tool_credential_revoke_failed`, once per tool.
- **The tool's model key** (QUESTIONS #541). A second virtual key per tool grant, alias `tool-<run_id>-<tool_key>`, with the run's labels and `agent` = `tool:<tool_key>` (`cost_records.agent` takes the colon from migration 0040), the tool's `model_ref` only, and the cap `tools.model_budget_usd` (default 0.5, never above the run key's cap). It is revoked with the run's key, by alias.
- **The handoff.** The worker wraps `{ db_username, db_password, llm_key }` into one single-use wrapping token per tool; only the token and the index version's ID travel through Temporal (`ExecuteRunInput.toolSecrets`). The runner checks that the index is the one this run's preparation recorded in the run's project (`knowledge_index_uses`), unwraps the token, and writes `config.json` (the index ID, the project's schema, the model, the service host names) and `credentials.json` into the tool's own runtime volume (`sdlc-toolrt-<run_id>-<tool_key>`, at `/run/sdlc-tool`) with the archive upload, before the tool starts. Never an environment value. A token OpenBao refuses records `wrap_token_reused` (`tool_secrets`).
- **The service network** (QUESTIONS #531). `sdlc-toolsvc-<run_id>-<tool_key>`, internal like the run network, holds the tool and the backing services the runner was configured with (`SDLC_RUNNER_TOOL_SERVICES`, by alias and port); a grant that names another service is refused (`tool_not_enforceable`). The gateway, the sandbox and other tools are never on it. The teardown detaches the services and removes the network and the runtime volume.
- **`knowledge_read`** (QUESTIONS #533, #536, #543). The tool writes one log line per answer with the document IDs and content hashes it returned and a chunk count, nothing else. At the end of the run (also after a kill, a failure or a restart's clean-up) the runner reads the tool's log, keeps only lines of that exact shape, and records the sorted list of distinct `[doc_id, content_sha256]` as the evidence item `knowledge_read` (with the run's diff credential, under `diffs/`) and the run event `knowledge_read` with its SHA-256, the index ID and the counts.
- **Failures.** A login or key that cannot be issued (no database engine, OpenBao or LiteLLM down) ends the run `failed` with `tool_unavailable` (run event `knowledge_unavailable`, code `credentials_unavailable`) and revokes what was issued.

## 3. Alternatives not chosen

- **pgvector in the platform's PostgreSQL** (ADR-M59 §6): a tool's service network would reach the platform's database (QUESTIONS #534).
- **One table for all projects with row-level security**: one shared login role and SQL on every query (QUESTIONS #537 b).
- **A background job per default-branch head**: faster run starts, but a second moving part and indexes nobody uses (QUESTIONS #538 b).
- **WeKnora** (K02, ADR-M59): no quality gain for the platform's documents.

## 4. Consequences

- One more service and image to pin, scan and back up: `knowledge-db` is optional (profile `knowledge`); A10 measures bge-m3 on CPU (about 1.2 GB) and the store.
- The OpenBao database secrets engine came with PR 3b (§2.7), with runbook T11 §5o; it needs `pnpm openbao:bootstrap knowledge-issuer-credentials` once per server.
- A large documentation set may not fit the limits of a first run: the operator raises them, or the run fails with a clear code.

## Version history

| Version | Date | Author | Notes |
|---|---|---|---|
| 0.1 | 2026-10-23 | Claude (task X04 PR 3a) | First version: the store, the platform's record, the indexer, retention, `knowledge_read`, the gateway facts of PR 2 (QUESTIONS #533–#539) |
| 1.0 | 2026-10-23 | Harry | Accepted, with D-05 1.58 |
| 1.1 | 2026-10-24 | Claude (task X04 PR 3b) | §2.7: the tool, its per-run login (one OpenBao role per run), its model key, the handoff, the service network and `knowledge_read`, as answered in QUESTIONS #540–#544 (the repository owner, 2026-10-24); with D-05 1.59 |
