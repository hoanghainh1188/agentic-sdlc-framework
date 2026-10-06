# ADR-M35. Observability: structured logs, OpenTelemetry traces, one OTLP pipeline to Langfuse

| Item | Value |
|---|---|
| Status | **Proposed** (task A08, for review) |
| Date | 2026-09-30 |
| Decided by | Harry (QUESTIONS #4 answer A, 2026-09-30; A08 plan approved 2026-09-30 with D1–D4 and conditions 1–4) |
| Related | D-02 NFR-06, FR-31, FR-44; D-03 sections 5.3, 10 (version 1.14); D-05 section 2; D-07 sections 3, 5; D-08 tasks A08, A10, E05; ADR-M17 §2.5, ADR-M24 §2.2, ADR-M25, ADR-M26, ADR-M27, ADR-M30, ADR-M33; QUESTIONS #4 |

## 1. Context

D-02 NFR-06 asks for structured logs and OpenTelemetry tracing; FR-31 asks that every model call in Langfuse carries the seven labels (tenant, project, intent_id, run_id, gate, agent, data_class). D-08 A08 has three acceptance criteria:

- AC1: JSON logs include `tenant_id`, `intent_id`, `run_id` when available;
- AC2: OpenTelemetry traces for the api and the worker;
- AC3: LiteLLM sends traces to Langfuse when the Compose profile `observability` is on.

Before A08 each process had its own small logger (the worker's `jsonLogger`, the runner's `log()`, Nest's `Logger` in the api) and the `CostLogger` / `SecretsLogger` hooks had no platform logger behind them. No line carried the IDs of the request or activity.

Langfuse v4 (ADR-M17 §2.5) accepts traces only over OpenTelemetry (OTLP). QUESTIONS #4, answer A: keep Langfuse v4; LiteLLM uses its `langfuse_otel` integration, and the api and worker traces use the same OTLP pipeline. Condition: a live test shows one model call through LiteLLM creates a Langfuse trace with all seven labels; if the pinned LiteLLM has no `langfuse_otel`, stop and ask. The pinned `ghcr.io/berriai/litellm:v1.102.1` has it (`integrations/langfuse/langfuse_otel.py`, registered as `"langfuse_otel"`, sends the header `x-langfuse-ingestion-version: 4`).

## 2. Decision

### 2.1. One platform logger (`@sdlc/core`, `observability/`)

- `createJsonLogger({ write, now?, traceIds? })`: one JSON line per event: `time`, `level`, `event` (a code), the context IDs, `trace_id` / `span_id` when tracing is on, then the fields.
- Same shape as before (`log(level, event, fields)`), so the worker, the Cost Controller hook and the OpenBao client hook take it unchanged. The worker's `jsonLogger` and the runner's `log()` now use it; the api writes Nest's warnings and errors through `NestJsonLogger` (Nest's start-up messages are dropped, stacks are never written).
- **Field guard**, a second line of defence behind the rule "codes and IDs only" (the audit rules): the field name is split into words (at `_`, `-`, `.` and camelCase), and the field is dropped (and counted in `dropped_fields`) when a word is one of `token`, `secret`, `password`, `passwd`, `passphrase`, `authorization`, `auth`, `bearer`, `jwt`, `cookie`, `session`, `key`, `credential(s)`, `body`, `text`, `comment`, `prompt`, `content`, `header(s)`, `url`, `uri`, `query`, `value`. Word matching keeps names such as `context_id` or `tokens_in`; a test lists every field name the platform logs today, so a guard change that drops one fails. Values must be flat (string, finite number, boolean); strings are cut at 500 characters. The keys the logger writes itself cannot be replaced.
- The guard checks names, not values. `message` is allowed and holds catalog text only; callers must still never put an error's message or a library text into a field (review rule).
- No logger library: the code is about 80 lines of the pattern the repo already had. Pino (MIT) would add dependencies, and its redaction works by path, not by field name.

### 2.2. Log context

- `withLogContext({ tenantId, intentId, runId }, fn)` (AsyncLocalStorage): every line inside `fn`, including lines of the GitHub adapter and the OpenBao client, carries the IDs. An explicit field wins over the context.
- Where the context is set:

| Process | Where | IDs |
|---|---|---|
| api | `LogContextInterceptor` (after the auth guard), the error filter, `wakeQuietly` | tenant; tenant + intent for a failed wake |
| worker | the poller loop (per project), the escalation loop (per escalation), every Temporal activity (§2.6) | tenant; tenant + intent (+ run) in activities |
| runner | every Temporal activity (§2.6); `runner.run_started` and `runner.run_ended` lines | tenant + run |

### 2.3. Tracing (`@sdlc/telemetry`)

- New package, used by the apps only, so `@sdlc/core` never loads the SDK. `startTracing({ serviceName, endpoint })`: `NodeTracerProvider`, OTLP/HTTP exporter (`<endpoint>/v1/traces`), batch processor, service names `sdlc-api` and `sdlc-worker`.
- **Off by default.** One variable for every process: `SDLC_OTEL_ENDPOINT` (an http(s) URL without user info, query or fragment; a wrong value stops the process with the catalog's "setting not valid" message). Empty or unset: no SDK starts, `@opentelemetry/api` stays a no-op, and tests and dev work need nothing.
- Instrumentations: `http` (incoming api requests, outgoing calls to GitHub, OpenBao, LiteLLM) and `pg` (`requireParentSpan`: queries of the background loops make no root spans). Health checks are not traced.
- **Load order.** An instrumentation patches a module when it is required after the instrumentation is registered. Each app imports its `telemetry.ts` first (api and worker `main.ts`), and `@sdlc/telemetry` imports `@sdlc/core` (which loads `pg`) for types only. A static test checks both (`platform/tests/observability/load-order.test.ts`); ESLint allows `@sdlc/telemetry` to import only `@sdlc/core`, and never the other way.
- The workflow code (Temporal's deterministic sandbox, ADR-M30 §2.2) has no spans.
- **Limit:** outgoing `fetch` (undici) calls are not traced; the `http` instrumentation sees `node:http` only. Incoming api requests are traced (Fastify loads `node:http` through `require`, also in the ESM api; checked by starting the built api with an OTLP sink: server span and `pg` span). An undici instrumentation can be added later.

### 2.4. One OTLP pipeline through a collector (D1)

- New Compose service `otel-collector` in the profile `observability`: the core distribution of the OpenTelemetry Collector 0.161.0 (Apache-2.0). The upstream image has no shell, so Docker cannot run a health check in it; the image `sdlc-otel-collector:0.161.0` copies the pinned binary onto the pinned busybox the repo already uses (both stages by tag and digest) and runs as uid 10001.
- It receives OTLP/HTTP on port 4318 **without credentials**, and forwards to `http://langfuse-web:3000/api/public/otel/v1/traces` with Basic authorization and `x-langfuse-ingestion-version: 4`. `memory_limiter` (200 MiB) and `batch` processors.
- **Only the collector holds the Langfuse project key** (D2): it reads `LANGFUSE_INIT_PROJECT_PUBLIC_KEY` / `…_SECRET_KEY` from `.env`, the same values `langfuse-web` already reads there (ADR-M17 infrastructure secret, mode 600). `start.sh` builds the authorization in memory; it is never written or printed. The api, the worker and LiteLLM hold no Langfuse key.
- The OTLP receiver has no authentication: any container on the network `sdlc` can send spans to Langfuse, so span attributes such as `sdlc.tenant_id` are not proof. Only platform services run on that network; sandboxes never do.
- Condition 1: no host port, only the Compose network `sdlc`; it is never a sandbox egress service, so sandbox egress stays LiteLLM and the npm proxy (ADR-M25). Static tests check all three; the live test checks the running container.
- `up.sh` sets `SDLC_OTEL_ENDPOINT=http://otel-collector:4318` when `observability` is one of the profiles of the call, unless the environment or the env file sets another value. The profiles that use it (`platform`, `models`) must be started in the same call: `pnpm compose:obs` alone starts no traced process.
- **LiteLLM.** When the OpenBao Agent sidecar has `SDLC_OTEL_ENDPOINT`, `config.ctmpl` adds `litellm_settings.callbacks: ["langfuse_otel"]` and `OTEL_EXPORTER=otlp_http`, `OTEL_ENDPOINT=<endpoint>`, `OTEL_SERVICE_NAME=sdlc-litellm` in `environment_variables` (loaded before the callbacks). Without Langfuse keys, `langfuse_otel` exports to that endpoint; the collector adds the authorization.
- **Labels.** C03 already puts the seven labels on every run key, as metadata fields and as tags `<label>:<value>` (ADR-M24 §2.2). `langfuse_otel` sends the key's tags as the span attribute `langfuse.trace.tags`, so the labels reach Langfuse through LiteLLM configuration alone (condition 3; QUESTIONS #135 was not needed). Measured with `pnpm test:observability` (2026-09-30): one call gives one `GENERATION` observation (`litellm_request`, service `sdlc-litellm`) whose trace tags are exactly the seven labels, for example `run_id:<uuid>`, `gate:G4`, `data_class:internal`. The span also holds the key alias (`run-<run_id>`), the tenant's team alias and LiteLLM's hash of the virtual key, never the key itself (checked by the test).
- **Reading traces.** The deployment runs Langfuse v4 in `events_only` mode: the legacy `GET /api/public/traces` answers 404, and the read API is `GET /api/public/v2/observations` (span attributes in `metadata`). The live test and later tools (E06 metrics, E02 evidence) use it.

### 2.5. What a span never holds (condition 2)

- `http`: no header is recorded (`headersToSpanAttributes` empty, stated in code). Query strings are removed from `url.full`, `http.url`, `http.target`, `url.original`; `url.query` is dropped.
- `pg`: the SQL text with `$n` placeholders only (`enhancedDatabaseReporting: false`, no SQL commenter); parameter values are never recorded.
- `ScrubbingSpanProcessor` runs on every span just before it ends (`onEnding`, before the exporter), so a later instrumentation or SDK default cannot bring them back: it drops `url.query`, `http.(request|response).header.*`, `*.headers`, `db.postgresql.values`, `db.query.parameter.*`, `db.statement.parameters`, and strips query strings.
- Tests: real HTTP requests with a token in the query and in `Authorization`/`Cookie` headers; a live PostgreSQL query with parameter values (`pnpm test:db`).
- **Error texts:** the scrubber keeps a span's status code but drops the status message, and keeps only `exception.type` on span events (`exception.message` and `exception.stacktrace` are dropped). The `pg` and `http` instrumentations put raw error messages there; a PostgreSQL message can quote a value.
- Our own activity spans hold IDs and codes only; a failure records the error class, never its message.
- **LiteLLM spans hold the prompt and the response** (`langfuse_otel` sets the observation input and output). This is by design (D3): prompts and responses live in Langfuse (D-05 §2, D-07). They are client data, so Langfuse is a store of client data (§4).

### 2.6. Temporal activities

- Our own activity interceptor (`activityTracingInterceptor`), about 60 lines on `@opentelemetry/api`: one span `activity <type>` per activity (type, attempt, task queue, `sdlc.tenant_id`, `sdlc.intent_id`, `sdlc.run_id`) and the log context of its IDs. The IDs come from the first argument (`tenantId`, `intentId`, `runId`) and a second UUID argument (`finishRun(ref, runId)`); values that are not UUIDs are ignored.
- Not `@temporalio/interceptors-opentelemetry@1.24.0`: it pins the 1.x OpenTelemetry SDK (a second SDK next to 2.x) and needs a workflow part inside the workflow bundle, which the workflow lint rule forbids.
- The interceptor is always installed (worker and runner); with tracing off the span is a no-op and the log context still works. The runner starts no tracing yet.

### 2.7. Dependencies

All pinned to exact versions (Apache-2.0): `@opentelemetry/api` 1.9.1, `@opentelemetry/sdk-trace-node` 2.11.0, `@opentelemetry/sdk-trace-base` 2.11.0, `@opentelemetry/resources` 2.11.0, `@opentelemetry/exporter-trace-otlp-http` 0.222.0, `@opentelemetry/instrumentation` 0.222.0, `@opentelemetry/instrumentation-http` 0.222.0, `@opentelemetry/instrumentation-pg` 0.74.0, `@opentelemetry/semantic-conventions` 1.43.0. Image: `otel/opentelemetry-collector:0.161.0` (Apache-2.0) by digest.

## 3. Rules and where they live

| Rule | Where |
|---|---|
| Log lines: codes and IDs; field guard | `core/src/observability/logger.ts` |
| Log context | `core/src/observability/context.ts`, the api interceptor, the worker loops, the activity interceptor |
| Tracing off without `SDLC_OTEL_ENDPOINT` | `telemetry/src/settings.ts`, `tracing.ts` |
| No headers, query strings or SQL values in spans | `telemetry/src/tracing.ts` (instrumentation options), `scrub.ts` |
| Telemetry first, core types only | api/worker `main.ts`, `platform/tests/observability/load-order.test.ts`, ESLint module boundaries |
| Collector: no host port, network `sdlc` only, never egress, only key holder | `platform/deploy/docker-compose.yml`, `platform/tests/deploy/observability-static.test.ts` |
| LiteLLM `langfuse_otel` only with the endpoint | `platform/deploy/litellm/config.ctmpl` |

## 4. Follow-ups

- **The Langfuse project key moves to OpenBao** with the real server (task A10): the collector then gets it through an OpenBao Agent sidecar, like LiteLLM (D2). Until then the key is in the collector's environment (`docker inspect`, `/proc/1/environ`), like the other `.env` infrastructure secrets (ADR-M17).
- **Langfuse holds client data** (prompts and responses, D3). Project archive (FR-44) and retention must also purge the project's Langfuse data: note added to task E05 (`scripts/generate-backlog.py`). Done in E08 (ADR-M53): the worker deletes an intent's traces with its own Langfuse key (`kv/worker/langfuse`), sweeps the raw OTLP files and compacts ClickHouse. The collector keeps its own key (above).
- Runner traces (the agent run as spans) and spans for the background loops: later, with the same interceptor and `startTracing`.
- Trace context from the api to the workflow (Temporal headers): later; the IDs already join the api's and the worker's lines.

## 5. Alternatives considered

| Alternative | Why not |
|---|---|
| Direct export: the api, the worker and LiteLLM each send to Langfuse with the project key | Three more holders of the key; the processes would depend on Langfuse by name |
| LiteLLM's v3 `langfuse` callback, Langfuse v3 | QUESTIONS #4: Langfuse stays v4, which accepts OTLP only |
| `@temporalio/interceptors-opentelemetry` | A second, older OpenTelemetry SDK and a workflow part in the bundle (§2.6) |
| `@opentelemetry/sdk-node` with auto-instrumentations | Many instrumentations we do not want; harder to control what spans hold |
| Pino | See §2.1 |
| The contrib collector image | Also without a shell (same health check problem); many more components |

## 6. Consequences

- One log format for every process; lines can be joined by `tenant_id`, `intent_id`, `run_id` and, with tracing on, `trace_id`.
- With the profile `observability`, one model call through LiteLLM is one Langfuse trace, filterable by the seven label tags.
- One more container in `observability` (small; `memory_limiter` 200 MiB).
- The task grew from S to about M (a new package, the collector image, a live test).

## Version history

| Version | Date | Author | Notes |
|---|---|---|---|
| 0.1 | 2026-09-30 | Claude (task A08) | First version |
| 0.2 | 2026-10-05 | Claude (task E08) | §4: the Langfuse purge is done by ADR-M53; the worker has its own Langfuse key |
