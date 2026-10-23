# ADR-M89. The first register tool: the index of a project's documents

| Item | Value |
|---|---|
| Status | **Proposed** (task X04 PR 3a; for the repository owner's approval with the D-05 change of the same pull request) |
| Date | 2026-10-23 |
| Decided by | The repository owner (X04 PR 3 plan approved on 2026-10-23: QUESTIONS #533–#539) |
| Related | D-08 X04 AC1–AC5; D-02 FR-33, FR-44, NFR-03; D-05 §6.1, §6.4; D-07 §4–§5; ADR-M51 (retention), ADR-M59 §5 (K01 limits), ADR-M69 (tool register, accepted), ADR-M87 (MCP gateway, accepted); design/QUESTIONS.md #531–#539 |

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

## 3. Alternatives not chosen

- **pgvector in the platform's PostgreSQL** (ADR-M59 §6): a tool's service network would reach the platform's database (QUESTIONS #534).
- **One table for all projects with row-level security**: one shared login role and SQL on every query (QUESTIONS #537 b).
- **A background job per default-branch head**: faster run starts, but a second moving part and indexes nobody uses (QUESTIONS #538 b).
- **WeKnora** (K02, ADR-M59): no quality gain for the platform's documents.

## 4. Consequences

- One more service and image to pin, scan and back up: `knowledge-db` is optional (profile `knowledge`); A10 measures bge-m3 on CPU (about 1.2 GB) and the store.
- The OpenBao database secrets engine comes in PR 3b, with runbook T11.
- A large documentation set may not fit the limits of a first run: the operator raises them, or the run fails with a clear code.

## Version history

| Version | Date | Author | Notes |
|---|---|---|---|
| 0.1 | 2026-10-23 | Claude (task X04 PR 3a) | First version: the store, the platform's record, the indexer, retention, `knowledge_read`, the gateway facts of PR 2 (QUESTIONS #533–#539) |
