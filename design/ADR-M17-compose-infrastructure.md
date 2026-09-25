# ADR-M17. Docker Compose infrastructure

| Item | Value |
|---|---|
| Status | **Proposed** (task A02, PR for review) |
| Date | 2026-09-25 |
| Decided by | Harry (plan approved 2026-09-25) |
| Related | D-03 sections 5.3, 10 and 10.1; D-01 section 5.8e; D-07 section 3; D-08 task A02; NFR-01, NFR-03, NFR-04 |

## 1. Context

Task A02 runs the reused infrastructure on one modest internal server with Docker Compose. D-03 fixes the components (PostgreSQL, Temporal, LiteLLM, Valkey, SeaweedFS, OpenBao, Langfuse, ClickHouse) and two profiles: `core` and `observability`. This ADR records the versions, how each component is wired, and the trade-offs.

## 2. Decision

### 2.1. Images

Versions were checked against Docker Hub, GHCR and GitHub releases on 2026-09-25. We prefer the latest patch of the previous minor release over a release that is only days old.

| Service | Profile | Image | Licence |
|---|---|---|---|
| postgres | core | `postgres:17.11-trixie` | PostgreSQL |
| temporal | core | `temporalio/server:1.31.2` | MIT |
| temporal-schema, temporal-namespace (jobs) | core | `temporalio/admin-tools:1.31.2` | MIT |
| temporal-ui | core | `temporalio/ui:2.54.1` | MIT |
| valkey | core | `valkey/valkey:8.1.10-alpine3.24` | BSD-3-Clause |
| litellm | core | `ghcr.io/berriai/litellm:v1.102.1` | MIT (the `enterprise/` code is not activated) |
| seaweedfs, seaweedfs-init (job) | core | `chrislusf/seaweedfs:4.47` | Apache-2.0 |
| openbao | core | `openbao/openbao:2.6.3` | MPL-2.0 |
| clickhouse | observability | `clickhouse/clickhouse-server:26.3.32.14` (LTS) | Apache-2.0 |
| langfuse-web, langfuse-worker | observability | `langfuse/langfuse:4.45.1`, `langfuse/langfuse-worker:4.45.1` | MIT (the `ee/` code is not activated) |

All licences allow commercial use and redistribution (NFR-04). No MinIO, Redis or Elasticsearch (D-01 section 5.8e).

### 2.2. Pinning

- Every image is pinned to an **exact version tag**. A test rejects `latest`, bare major tags and variables in image names.
- **No digest pinning yet.** Digests (`@sha256:…`) are stronger for the supply chain but need a bot to keep them current. Add digests when Dependabot for Docker images is enabled (task A09).

### 2.3. Component wiring

| Topic | Decision |
|---|---|
| PostgreSQL | One server. One database **and one owner role** per component: `platform`, `temporal` + `temporal_visibility`, `litellm`, `langfuse`. Created by an init script on the first start |
| Temporal | Temporal stopped publishing the `auto-setup` image after 1.29. A one-shot job (`admin-tools`, `temporal-sql-tool`) creates and upgrades the schemas. A second job creates the namespace `default`. The server uses the PostgreSQL plugin and SQL visibility, with no Elasticsearch |
| Temporal retention | Closed workflows are kept **30 days** (`TEMPORAL_NAMESPACE_RETENTION`). This is unrelated to audit retention, which lives in the platform database (≥ 2 years, A07) |
| LiteLLM | Uses its own database (mandatory for budgets, D-07 section 3). No models and no provider keys yet. Telemetry is off |
| SeaweedFS | Single node (`weed server -s3`). One S3 admin identity from `.env`; anonymous access is denied. A job creates the buckets `evidence` and `langfuse`. The `evidence` bucket has no lifecycle rule: retention is `evidence_retention_days` in project config (A05, E05) |
| OpenBao | Raft storage, no dev mode. It starts **uninitialised and sealed**; A03 initialises it. Its healthcheck means "API reachable", **not** "unsealed". TLS is off on the internal network and the port is bound to 127.0.0.1; TLS is an open item for A03 |
| Langfuse | Version 4. Open sign-up is disabled (`AUTH_DISABLE_SIGNUP=true`). The only account is created by headless initialisation from `.env`. Telemetry is off. It shares PostgreSQL, Valkey and SeaweedFS |
| ClickHouse | 26.3 LTS with a small low-memory config. If Langfuse's migrations fail on it, fall back to 25.12 (Langfuse's reference version) |
| Ports | Published ports bind to `SDLC_BIND_ADDR`, default `127.0.0.1` (D-03 section 9). Valkey, ClickHouse and the Langfuse worker publish no port |
| Secrets | Only in `.env` (created by `scripts/init-env.sh` with random values, mode 600, ignored by Git). Every secret variable uses `${VAR:?}`, so Compose stops when one is missing <br>Valkey reads its password from a mode-600 config file written at start, never from process arguments. **Accepted until OpenBao is used (A03/A04):** secrets reach containers as environment variables, so anyone allowed to run `docker inspect` on the server can read them. Access to Docker on the server must be limited to operators |
| Start-up | `scripts/up.sh` waits for long-running services to be healthy and checks that each one-shot job exited 0. `docker compose up --wait` alone treats a job that exits 0 as a failure |

### 2.4. Shared Valkey and `noeviction`

- Langfuse uses BullMQ queues, which require `maxmemory-policy noeviction`. The policy applies to the whole Valkey server.
- Valkey has an explicit limit: `VALKEY_MAXMEMORY` (default `256mb`, set in `.env`).
- **Trade-off:** when Valkey reaches the limit, **writes fail for both Langfuse and LiteLLM**. Evicting keys instead would silently drop Langfuse jobs, which is worse.
- Mitigation: LiteLLM uses Valkey only for router and rate-limit state, whose keys expire. Response caching stays off (it is D-07 item 9, later). A10 measures real memory use; raise the limit if needed.
- If this becomes a problem, run a second Valkey instance for LiteLLM (with an eviction policy). This costs about 20 MiB of RAM.

### 2.5. Langfuse v4 ingestion

- Langfuse v4 accepts traces **only through OpenTelemetry (OTLP)**. It rejects the v3 `/api/public/ingestion` event types.
- Consequence for A08: LiteLLM must send traces with its OTLP-based Langfuse integration (`langfuse_otel`), not the v3 `langfuse` callback. This is recorded in `design/QUESTIONS.md`.

## 3. Alternatives not chosen

| Option | Why not |
|---|---|
| `temporalio/auto-setup` | Not published after 1.29 |
| Langfuse v3 (3.225.x) | Still patched, but v4 is the current major version. Starting on v3 means a migration soon |
| ClickHouse 25.12 | Not an LTS release; kept only as the fallback |
| Separate Valkey for LiteLLM | Not needed yet; see 2.4 |
| Digest pinning now | Needs Dependabot to stay current; see 2.2 |

## 4. Consequences

- `pnpm compose:core` and `pnpm compose:obs` start a working stack from a fresh clone after `pnpm compose:env`.
- Upgrading an image means changing its tag in `docker-compose.yml`, updating this table, and running `pnpm test:compose`.
- Measured at idle on a development machine: about 1.3 GiB RAM for `core` and about 3.7 GiB for `core + observability` (see `platform/deploy/README.md`). A10 does the formal measurement.

## Version history

| Version | Date | Author | Notes |
|---|---|---|---|
| 0.1 | 2026-09-25 | Claude (task A02) | First version |
