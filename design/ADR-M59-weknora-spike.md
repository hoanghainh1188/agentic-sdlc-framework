# ADR-M59. WeKnora for document knowledge: result of the K01 spike

| Item | Value |
|---|---|
| Status | **Proposed** (task K01, PR for review) |
| Date | 2026-10-08 |
| Decided by | Harry (plan approved 2026-10-08, with six additions) |
| Related | D-08 tasks K01, K02; D-01 §5.8b; D-02 §4.2; D-07 §3–§4; D-09 §7–§8; ADR-M25 §2.2; design/QUESTIONS.md #285, #300 |
| Spike code | `platform/spikes/weknora/` (may be thrown away) |

## 1. Context

D-01 §5.8b proposed WeKnora (Tencent, MIT) as the "document knowledge" service: agents would search a project's documents over MCP instead of reading whole files. QUESTIONS #285 put a spike (K01) before the trial M-E, and K02 (agents search through WeKnora) only if the spike says go.

The spike answers five questions on the pilot's fictional Japanese–English documents (D-09: specs T01–T10, README, AGENTS.md of `harryforge/pilot-order-inventory`, 12 Markdown files, 55 KB):

1. Does WeKnora find the right passage, in Japanese and English, and clearly better than a plain baseline?
2. What does it need on the modest target host?
3. Is everything in it allowed for commercial use (NFR-04), and can it run without MinIO, Redis and AGPL parts?
4. Are workspaces of two tenants isolated, and can an agent get search and read tools only?
5. Does any data leave the machine?

All sources were accessed on 2026-10-08.

## 2. Decision

**NO-GO for K02 now** (proposed). Defer K02; the trial M-E does not wait for it (QUESTIONS #285: M-E waits for K02 *or its deferral by this ADR*). Revisit when a project has documents that are not in its repository, mainly Office and PDF files (§5).

Reasons, in order:

1. **No clear quality gain.** WeKnora's default hybrid search found the right passage in the top 5 less often than a plain baseline (bge-m3 embeddings and cosine similarity in a 60-line script). With keyword matching turned off, WeKnora beat the baseline. The same baseline on WeKnora's own chunks did as well. WeKnora's gain is its chunking, which a small script can copy (§3.1). Harry's rule for this spike: no clear win, lean no-go.
2. **Nothing to find yet.** The pilot's documents are in the repository. The agent already reads them with its file tools at the commit it works on. Search over 55 KB adds a service, a credential and a network path, and gives the agent nothing it cannot read now.
3. **Cost on the target host.** The stack itself is light (about 1.3 GB RAM), but WeKnora's default per-document LLM summary took 21 minutes for 55 KB with `gpt-oss:20b` and then stalled Ollama. It must be turned off (§3.2). The images take 7.8 GB of disk; the document reader alone takes 5.5 GB.
4. **Supply chain.** The document reader image (Debian 12.12) has 202 critical and 2,136 high vulnerabilities by Trivy, 162 and 1,263 of them with a fix available, and it loads EbookLib (AGPL-3.0) into its process (§3.3a). Using it would mean building and maintaining our own document reader image.
5. **Not blocking, but work for K02:** WeKnora's default stack uses ParadeDB (`pg_search`, AGPL-3.0) and Redis. Both can be replaced: the spike ran on plain PostgreSQL with pgvector, Qdrant and Valkey (§3.3). Isolation and the MCP endpoints are good (§3.4). No outbound call was seen (§3.5).

## 3. Results

### 3.1. Retrieval quality

24 questions: 12 in Japanese, 12 in English, paraphrased (no heading copied). Each question has a gold document and an evidence string; a retrieved chunk counts when it comes from the gold document and holds the evidence. **The questions were written by AI (Claude) from the documents, so the numbers may be biased** towards wording the model finds natural. Two corpora:

- `bilingual`: the files as they are. Specs hold each line in Japanese and English; README and AGENTS.md are English.
- `split`: the specs with the English lines removed. Every English question about a spec must then find a Japanese passage; Japanese questions about README or AGENTS.md must find an English one. A few English lines that quote Japanese values remain (about 5).

Top 5, `bge-m3` embeddings in every row (through LiteLLM to the host's Ollama). hit@k = questions with the right passage in the top k, of 24. MRR = mean reciprocal rank.

| Method | Corpus | hit@1 | hit@5 | MRR | Cross-lingual hit@5 | Search time p50 |
|---|---|---|---|---|---|---|
| WeKnora hybrid (default: vector + keyword, fused) | bilingual | 9–10 | 17–18 | 0.49–0.54 | 2–3 / 5 | 33–75 ms |
| WeKnora hybrid | split | 7–11 | 18–19 | 0.49–0.58 | 10 / 15 | 42–66 ms |
| WeKnora vector only (`disable_keywords_match`) | bilingual | 13 | **22** | 0.70 | 4 / 5 | 41 ms |
| WeKnora vector only | split | 20 | **22** | 0.86 | 13 / 15 | 39 ms |
| Baseline, own chunks (headings and blank lines, ≤ 500 characters) | bilingual | 13 | 18 | 0.62 | 3 / 5 | 22 ms |
| Baseline, own chunks | split | 14 | 21 | 0.69 | 13 / 15 | 22 ms |
| Baseline on WeKnora's chunks | bilingual | 14 | **23** | 0.72 | 4 / 5 | 21 ms |
| Baseline on WeKnora's chunks | split | 16 | **22** | 0.78 | 13 / 15 | 20 ms |

- Hybrid ranges are two runs: the keyword part changes the fused order between runs. Vector-only and the baseline gave the same ranks each time.
- The keyword part hurts: fused scores are rank-based (about 1/60 per rank), and keyword matching on Japanese text without word boundaries adds noise.
- WeKnora vector-only and the baseline on the same chunks are within one question of each other. WeKnora's split MRR is higher (0.86 against 0.78); with 24 AI-written questions this is not a clear difference.
- Japanese and English questions score the same with vector search (11 of 12 each). Cross-lingual retrieval works with bge-m3 (13 of 15 on `split`).
- Answers (WeKnora's knowledge chat, agent and web search off, 8 questions, 4 per language). The gold document was in the references every time (8/8) with both models. The agent of K02 would only search; it would not use WeKnora's chat.

| Chat model | English, total | Japanese, total | Note |
|---|---|---|---|
| `gpt-oss:20b` (decision D6 of the M-E plan) | 22–40 s | 70–168 s | The host swapped: free memory down to 1 % with the 12 GB model, the embedding model and the 8 GB Docker VM |
| `qwen2.5:7b` (labelled second run, because memory was tight) | 15–39 s | 15–45 s | Longer answers (up to 3,100 characters) |

### 3.2. Resources (developer Mac, 24 GB RAM, Docker VM 8 GB)

| Item | Value |
|---|---|
| Stack RAM, peak (app, docreader, PostgreSQL, Qdrant, Valkey, LiteLLM) | 1.1 GB idle, 1.3 GB during ingest, queries and answers |
| Largest containers | LiteLLM 0.58 GB, Qdrant 0.33 GB, app 0.27 GB, docreader 0.19 GB |
| Models on the host | `gpt-oss:20b` 12 GB, `bge-m3` 1.2 GB |
| Ingest, 12 files, 55 KB, **with** WeKnora's per-document LLM summary | 1,264 s for one corpus; the second did not finish in 30 min and left Ollama stuck (restarted) |
| Ingest **without** the summary (`process_config.summary_enabled=false`) | 3.5–76 s (embedding only; the slow run had the chat model loaded) |
| Chunks | 115 (`bilingual`), 70 (`split`); about 420 characters each |
| Disk: images | docreader 5.5 GB (LibreOffice, Playwright Chromium, speech recognition), app 2.3 GB, pgvector 0.65 GB, Qdrant 0.29 GB, Valkey 0.06 GB |
| Disk: data | Qdrant 905 MB for under 200 chunks (pre-allocated segments), PostgreSQL 74 MB |

The target host is modest and has no GPU (D-03 §10.1). Embedding a project's documents on its CPU is feasible; an LLM pass per document is not.

### 3.3. Licence and supply chain (NFR-04)

| Component | Licence | Note |
|---|---|---|
| WeKnora app, docreader, MCP server (v0.8.2) | MIT | Go dependencies include two MPL-2.0 modules (`go-sql-driver/mysql`, `go-m1cpu`); `THIRD_PARTY_NOTICES.md` ships their source |
| ParadeDB (`paradedb/paradedb`, WeKnora's default database) | **AGPL-3.0** (`pg_search`) | **Not used.** With `RETRIEVE_DRIVER=qdrant` WeKnora skips its `pg_search` migrations; plain `pgvector/pgvector:0.8.1-pg17` (PostgreSQL licence) works |
| Redis (`redis:7.0-alpine`, WeKnora's default queue) | BSD-3 at 7.0, but CLAUDE.md forbids Redis | **Replaced** by `valkey/valkey:8.1.10` (BSD-3); WeKnora's task queue (Asynq) runs unchanged |
| MinIO (optional profile) | AGPL-3.0 | Not used: local file storage |
| Neo4j, SearXNG, Milvus (optional profiles) | GPL-3.0, AGPL-3.0, Apache-2.0 | Not used (graph, web search off) |
| Qdrant | Apache-2.0 | Telemetry turned off (`QDRANT__TELEMETRY_DISABLED`) |
| `bge-m3` (BAAI) | MIT | Through Ollama |
| `gpt-oss:20b` | Apache-2.0 | Through Ollama |
| docreader Python packages (72) | Permissive, except **EbookLib 0.20 (AGPL-3.0-or-later)**, `chardet` (LGPL-2.1), `tld` (MPL-1.1 / GPL-2.0 / LGPL-2.1, choice), `docx2txt` (no licence in its metadata) | EbookLib (EPUB parsing) runs inside the docreader process: the AGPL applies to that service. Commercial use is allowed, but D-01 kept AGPL parts out (MinIO, Garage). A first scan of the package metadata missed it; Trivy found it |
| docreader system packages | LibreOffice (MPL-2.0), poppler (GPL-2.0), pocketsphinx (BSD) | Separate programs; shipping the image to a client brings the usual source-offer duties |
| Trivy 0.74.0 (the CI's version) | — | §3.3a |

### 3.3a. Trivy

Trivy 0.74.0, scanners `vuln` and `license` (`results/trivy.json`). CRITICAL / HIGH vulnerabilities, with the number that has a fixed version in brackets:

| Image | Critical | High | Licence findings Trivy marks forbidden |
|---|---|---|---|
| `wechatopenai/weknora-docreader:v0.8.2` | 202 (162) | 2,136 (1,263) | EbookLib (AGPL-3.0-or-later) |
| `wechatopenai/weknora-app:v0.8.2` | 34 (19) | 684 (61) | `node-path-is-inside` (WTFPL: permissive; forbidden only by Trivy's default list) |
| `pgvector/pgvector:0.8.1-pg17` | 20 (17) | 126 (63) | none |
| `qdrant/qdrant:v1.16.2` | 10 (10) | 179 (135) | none |
| `valkey/valkey:8.1.10-alpine3.24` | 0 | 0 | none |

- Most docreader findings are Debian 12.12 packages (ImageMagick 6 alone has 10 critical entries per package), from a base image that has not been updated; 3 are in `grpc_health_probe` (Go standard library, grpc). The app image has the same base.
- The CI blocks the platform's own dependencies on CRITICAL (A09). Under the same rule none of the WeKnora images, nor the pinned pgvector and Qdrant tags, would pass without rebuilding or updating.
- "Restricted" licence findings (GPL, LGPL, CC-BY-SA) are Debian OS packages used unchanged, as in the OpenHands image (ADR-M10 §2.1).

### 3.4. Tenant isolation and MCP

WeKnora gives each user a tenant ("space"); tenant A and tenant B below are two users. Results of `isolation.mjs`:

| Check | Result |
|---|---|
| Tenant A lists, reads or searches tenant B's knowledge base over REST | Not listed; 403 on read and search; no leak |
| Built-in MCP endpoint (`POST /api/v1/mcp-endpoints`, served at `/mcp/<endpoint id>`) | Token `mcp_…` shown once; only its SHA-256 is stored |
| Tool allowlist (`list_knowledge_bases`, `search_knowledge`, `grep_chunks`, `list_documents`, `read_document`) | `tools/list` shows exactly these five; `add_document` and `ask` (chat) refused |
| Knowledge-base scope (the endpoint names one knowledge base) | Search of another knowledge base of the same tenant refused; tenant B's knowledge base refused, no leak |
| No token, a wrong token | 401 |
| Tenant B deletes tenant A's endpoint | 404 |
| Endpoint deleted | Its token refused at once (401) |

- The endpoint also has a rate limit (60 calls a minute by default). Its tokens do not expire; a per-run credential means creating an endpoint per run and deleting it at the end.
- The separate Python MCP server in WeKnora's repository (`mcp-server/`, 32 tools) uses a tenant API key with full access, including writes and deletes. Never use it for agents.
- WeKnora's knowledge chat runs internal pipeline steps that it reports as tool calls (`query_understand`, `knowledge_search`) even with `agent_enabled: false`. These are not WeKnora's autonomous agent; its sandbox (`WEKNORA_SANDBOX_DOCKER_ENABLED=false`, no Docker socket), web search, graph and memory stayed off.

### 3.5. No data leaves the machine

How we checked:

1. **Enforcement:** WeKnora's containers (app, docreader, PostgreSQL, Qdrant, Valkey) are only on an `internal: true` Docker network. Only LiteLLM also has a route out (to the host's Ollama). From inside the app and docreader containers, requests to a public IP, to `huggingface.co` and to the host all fail.
2. **Detection:** `tcpdump` in the network namespaces of app and docreader for the whole spike: first ingest with summaries, isolation, a full re-run of ingest, both retrieval modes, isolation and two chat answers. Result: **0 packets** to public IPv4 or IPv6 addresses. Every new connection went to a service of the stack: Valkey 6379, LiteLLM 4000, PostgreSQL 5432, Qdrant 6334, docreader 50051, the app's own health check.
3. Gaps: the 8 answers of the `gpt-oss:20b` run (§3.1) fell into a window where the app capture had lost its namespace after a restart of the app; two further `gpt-oss:20b` answers and the whole `qwen2.5:7b` run were captured instead. LiteLLM's own traffic was not captured (the platform's component, started with `--telemetry False`).

Defaults that would send data out if changed, which K02 must keep off: `LANGFUSE_HOST` defaults to `https://cloud.langfuse.com` (tracing is off unless `LANGFUSE_ENABLED`), the Ollama model download endpoint (`/initialization/ollama/models/download`), web search providers, URL import (`/knowledge/url`), and the many cloud storage and IM integrations. `TZ` defaults to `Asia/Shanghai`.

### 3.6. What the spike had to change

- LiteLLM: `drop_params: true` (WeKnora sends `encoding_format` for embeddings, which Ollama refuses) and `additional_drop_params: [reasoning_effort]` on `gpt-oss` (WeKnora sends `reasoning_effort: "none"`, which Ollama's `gpt-oss` refuses). K02 would need the same in the platform's LiteLLM configuration, or a WeKnora setting.
- WeKnora's Qdrant client (v1.18) warns about the pinned Qdrant server (v1.16, WeKnora's own pin); no error was seen.
- WeKnora is pre-1.0 and changes fast: v0.7.2 (2026-08-07) to v0.8.2 (2026-09-24), with large features in each minor release.

## 4. Alternatives

| Option | Why not now |
|---|---|
| Go: K02 as planned, WeKnora over MCP | §2: no measured gain on documents the agent can already read; one more service with Office conversion tools and a fast release cycle |
| Our own small retrieval (pgvector in the platform's PostgreSQL, bge-m3 through LiteLLM, a heading-aware chunker) | Matches WeKnora's retrieval here (§3.1). Not needed while documents live in the repository; a candidate together with the code index of D-01 §5.8b (MVP+1) |
| Nothing: the agent reads the repository's documents with its file tools | **Chosen for M-E.** Specs and AGENTS.md are already in the workspace at `base_sha` |

## 5. If K02 is revisited

Revisit when a real project (M-F) has requirement documents outside the repository, especially Office and PDF files (要件定義書, 設計書, meeting notes): WeKnora's document reader is its main strength, and this spike did not test it (the pilot has Markdown only). Then run this spike again on anonymised documents of that kind, and keep these limits:

1. **Stack:** WeKnora pinned by digest; PostgreSQL with pgvector (never ParadeDB), Qdrant (telemetry off), Valkey, local file storage; profile `knowledge`; every WeKnora container only on an internal network; no host port. Our own docreader image: a current base, without EbookLib and the parts we do not need (speech recognition, browser), passing the CI's Trivy rule (§3.3a).
2. **Ingest:** `summary_enabled: false`, question generation, wiki, graph and auto-tagging off. Vector search only (`disable_keywords_match`) unless a later measurement shows keyword search helps Japanese.
3. **Models:** WeKnora's models only through LiteLLM, with the seven labels (D-07 §5; WeKnora's own model calls get a run-independent label set: tenant, project, `intent_id: none`, `agent: weknora`). The data class rules of D-07 §4 apply to the embedding model too: `client_restricted` only with a self-hosted embedding model; `prohibited` documents never loaded.
4. **Sandbox egress:** a new egress service in `docker/guard.ts` (alias, for example `knowledge:8080`), attached to the run's network like LiteLLM (ADR-M25 §2.2); the agent reaches only the `/mcp/<endpoint id>` path (a small path-filtering relay, because the WeKnora port also serves the full REST API).
5. **Credential:** the worker creates one MCP endpoint per run (one knowledge base: the project's; the five read tools; rate limit) and hands its token to the runner as a single-use wrapping token (like the virtual key); the runner deletes the endpoint when the run ends, also on a kill (FR-34). The worker's WeKnora admin credential lives in OpenBao (`kv/worker/weknora`); the sandbox never gets it.
6. **Evidence:** a run event `knowledge_read` with document IDs and content hashes and a count, never text or queries (CLAUDE.md: append-only tables hold no free text).
7. **Retention and purge:** WeKnora holds client documents; the retention loop must delete a project's knowledge base by the same rules as its evidence (ADR-M51), and archiving a project purges it.
8. **Target host:** about 1.5 GB RAM for the stack, 8 GB disk for images, plus the knowledge data; embeddings on CPU only.

## 6. Consequences

- K02 is deferred (D-08: a backlog change, by Harry). The trial M-E runs without document search.
- D-01 §5.8b stays as an evaluation; this ADR adds the measured result and the limits for a later attempt.
- The spike stack is removed with `platform/spikes/weknora/down.sh` (project `k01-weknora` only).

## Version history

| Version | Date | Author | Notes |
|---|---|---|---|
| 0.1 | 2026-10-08 | Claude (task K01) | First version: no-go for K02 now; numbers, licences, Trivy, isolation, network checks; limits for a later attempt |
