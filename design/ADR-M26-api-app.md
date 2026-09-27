# ADR-M26. API app (NestJS), personal API tokens, admin bootstrap, gate commands

| Item | Value |
|---|---|
| Status | **Proposed** (task B03, PR for review) |
| Date | 2026-09-27 |
| Decided by | Harry (plan approved 2026-09-27, with answers D1–D7) |
| Related | D-08 tasks B03, B04, B06, B07, B12, B13, E07; D-02 FR-10, FR-11, FR-17, FR-20, NFR-02, NFR-08; D-03 sections 5.1, 5.2, 6.2, 6.3, 8.2, 9, 10; D-05 sections 6.1–6.3; ADR-M09, ADR-M16, ADR-M18, ADR-M19, ADR-M20, ADR-M21; QUESTIONS #58, #63–#67 |

## 1. Context

Task B03 builds the `api` process: a REST API for the CLI (D-03 section 5.1). Users authenticate with personal API tokens that an admin issues (D-08 B03 AC1). The tenant comes from the token (AC2). The first endpoints are intents (create, show, list) and gate decisions (approve, reject, request changes) (AC3). Error messages come from the message catalog (AC4).

Four points were open:

- No task onboards a tenant or a project, and nothing creates the first admin or its token (QUESTIONS #58).
- `role_bindings.project_id` is `NOT NULL`, so `admin` is a project role. The data model has no tenant admin.
- A gate decision needs a bound input hash and a list of producers (ADR-M20 section 2.6). No document says what the input is at G1, and the workflow (B07) does not exist yet.
- Since A11, OpenBao has no host port and its AppRoles are bound to the Compose subnet without the gateway, so the api must run inside Compose to read its secrets.

## 2. Decision

### 2.1. Stack (D7)

| Part | Choice | Licence |
|---|---|---|
| Framework | NestJS 12.1.0 (`@nestjs/core`, `common`, `platform-fastify`, `testing`) | MIT |
| HTTP server | Fastify 5 (through `@nestjs/platform-fastify`) | MIT |
| Validation | zod 4.6.5 (already used by `@sdlc/config`) | MIT |
| Other runtime | `reflect-metadata` 0.2.2, `rxjs` 7.8.2 (NestJS peers) | Apache-2.0 |

- NestJS 12 is ESM only. `@sdlc/api` is `"type": "module"`; the workspace packages stay CommonJS (ADR-M16). Node 24 loads both. The day-one spike checked this with Vitest and with the built output.
- **No decorator metadata.** Every injection uses an explicit token (`@Inject(DATABASE)`, `src/tokens.ts`). `emitDecoratorMetadata` is off, so Vitest needs no `unplugin-swc` and no native `@swc/core` build. `experimentalDecorators` is on for `platform/apps/api` and `platform/tests` only.
- Request bodies are validated by zod schemas in the handlers (`parseRequest`), not by class-validator. zod's English text never reaches the client: a failure is `invalid_request` with `details: [{ path, issue }]` (issue = zod code).
- Tests call the app through Fastify `inject()`; no port is opened.

### 2.2. First admin and tokens: operator commands (D1, QUESTIONS #63)

B03 covers only what is needed to use and test the API. Everything else in #58 is a new task **B13 "Admin onboarding"** (Harry adds it to the backlog in a separate docs PR).

| Command (on the server, `SDLC_DB_URL` = `platform_app`) | What it does |
|---|---|
| `sdlc admin bootstrap --tenant <slug> --tenant-name <name> --email <email> --name <name> [--token-name] [--days] [--json]` | Creates the tenant, its first user and a token in **one transaction**, with the audit events `tenant.created`, `user.created`, `api_token.issued`. Refuses an existing tenant slug |
| `sdlc admin token issue --tenant --email --name [--days] [--json]` | Issues a token for an active user of the tenant; audits `api_token.issued` |
| `sdlc admin token list --tenant --email [--json]` | Lists tokens (ID, name, expiry, revocation, last use); never the token or its hash |
| `sdlc admin token revoke --tenant --id` | Revokes; idempotent; audits `api_token.revoked` once |

- The operator is "the admin" until B13 (QUESTIONS #65, option C): whoever can run commands on the server with the `platform_app` URL. Audit events of these commands use `actor_type = system` with no actor ID.
- The raw token is printed once, to stdout. It is never logged or stored. Run these commands in a terminal, never through a chat tool.
- Audit payloads hold IDs only: never the slug, names, e-mail address, token or token hash.

### 2.3. Personal API tokens (D6)

- Format: `sdlc_pat_` + 32 random bytes in base64url (43 characters). The prefix lets secret scanners find leaks: the Gitleaks rule `sdlc-api-token` (`.gitleaks.toml`) blocks CI; a clearly fake fixture is allow-listed in `platform/tests/gitleaks/fixtures/` only; CI checks the rule against a fresh token on every run.
- Stored as SHA-256 hash only (existing `api_tokens.token_hash`, D-05 section 6.1). Unique across tenants.
- Lifetime: default 90 days, maximum 365 days. [Proposal] pilot defaults. Platform settings (`API_TOKEN_*` in `@sdlc/core`), not project configuration: a token belongs to a tenant user, not to a project.
- Each request: the shape is checked first; then `SystemScope.resolveApiToken(hash)` finds the tenant and user only when the token is not revoked, not expired, and the user and tenant are active. `last_used_at` is written at most once a minute per token.
- Token names are short codes (`laptop-harry`), never free text.

### 2.4. Gate decisions through commands (D2, QUESTIONS #64)

- One shared handler, `decideGate` in `@sdlc/core` (`core/src/commands`). The API uses it now; comment commands (B06) and the workflow signal (B07) reuse it.
- B03 accepts **G1–G3** only. Other gates return `gate_not_supported` (422); E01 and E03 add G7 and G8. G4–G6 are system gates.
- The platform computes the bound input; a client never sends a hash:

| Gate | `input_sha256` |
|---|---|
| G1 | SHA-256 of the RFC 8785 canonical JSON of `{ v: 1, code, project_id, risk_tier, data_class, budget_usd, title_sha256, description_sha256 }` of the intent |
| G2 | `content_sha256` of the latest spec (`gate_input_missing`, 409, when there is none) |
| G3 | `plan_sha256` of the latest plan (`gate_input_missing` when there is none) |

- Producers at G1–G3: the empty list. No change has been produced yet; producers start with the run (run starter, commit authors) and the intent creator at G7 (QUESTIONS #16).
- The handler records the decision only (through `Registry.decide`, which resolves the oversight mode and checks the approver with the policy engine). Moving the intent to the next gate is the workflow's job (B07).
- Decisions take codes only: `decision` (approve, reject, request_changes), `reason_code` from `GATE_REASON_CODES`, an optional `https://` `reason_ref`, an optional approval `scope` of codes. A `reason` text field is refused (400).

### 2.5. Who may create and read intents (D4, QUESTIONS #66)

- New project configuration `access`:
  - `intent_create_roles`, default `[person_a]` (D-02 section 3);
  - `intent_read_roles`, default all seven project roles.
  - Creators may always read.
- New mandatory rule **M16**: the `viewer` role never creates intents.
- Responses:
  - no active role on the project → **404**, like an unknown project or intent;
  - a read role but no create role → **403** on create (the caller already knows the project exists).
- The caller of `POST /v1/intents` is always the intent's `created_by` (Person A owns the intent, QUESTIONS #16).

### 2.6. Secrets, database and deployment (D5, QUESTIONS #67)

- The api connects to the platform database as `platform_app`. On the server, it reads the password once at start-up from OpenBao `kv/api/database` (field `password`) with the AppRole `api` (`@sdlc/secrets`), then closes the OpenBao client. The existing policy `api.hcl` already allows `kv/data/api/*`.
- `pnpm openbao:bootstrap api-credentials` asks for an admin token. It stores `PLATFORM_APP_DB_PASSWORD` from the env file at `kv/api/database`, and it writes the role ID and a new secret ID into the volume `api-approle`. It prints no secret, and running it again rotates the secret ID.
- Compose: service `sdlc-api` in the new profile `platform` (`pnpm compose:platform` = `core` + `platform`).
  - It is built from `platform/apps/api/Dockerfile`: multi-stage, `node:24.13.0-bookworm-slim`, `pnpm deploy`, user `node`.
  - The image tag is the package version (`sdlc-api:0.0.0`).
  - The container runs with a read-only root file system, `cap_drop: [ALL]` and `no-new-privileges`.
  - It is published on `127.0.0.1:8090`, because Temporal UI already uses 8080.
  - OpenBao is plain HTTP on the Compose network until A10 adds TLS (QUESTIONS #20).
- Settings (environment, validated by zod):

  | Setting | Default |
  |---|---|
  | `SDLC_API_HOST` | `127.0.0.1` (`0.0.0.0` in the container) |
  | `SDLC_API_PORT` | `8080` |
  | `SDLC_API_DB_HOST`, `SDLC_API_DB_PORT`, `SDLC_API_DB_NAME` | `postgres`, `5432`, `platform` |
  | `SDLC_API_DB_SECRET_PATH` | `api/database`; must stay under `api/` |
  | `SDLC_API_RATE_LIMIT_PER_MINUTE` | 120 |
  | `SDLC_API_AUTH_FAILURES_PER_MINUTE` | 10 |
  | `SDLC_OPENBAO_*` | ADR-M21 |

- **Development without OpenBao:** `SDLC_API_DEV_MODE=1` with `SDLC_API_DEV_DB_URL` (`pnpm api:start`). The api refuses to start when `NODE_ENV=production`, and it logs a warning.

### 2.7. Rate limits and errors

- In-memory fixed windows, one api instance:
  - requests per token per minute;
  - failed authentications per client address per minute (429 once over).
  - A shared limiter (Valkey) comes when there is more than one instance.
- Error envelope: `{ error: { code, message, reason?, reason_message?, details? } }`.
  - Every code has a catalog key `api.error.<code>`.
  - Every refusal reason of the registry and the policy engine has a key `api.reason.<code>`.
  - The locale comes from `Accept-Language` (English until vi and ja exist).
  - Unknown errors are `internal` (500) and are logged without request data. Stack traces, SQL and library text never reach the client.
- Another tenant's intent, an intent in a project without a role, and an unknown intent all give the same 404.

### 2.8. Endpoints

| Method and path | Notes |
|---|---|
| `GET /health/live`, `GET /health/ready` | No token. `ready` → 503 `not_ready` when the database does not answer |
| `GET /v1/me` | User, tenant, active role bindings (for `sdlc login`, B04) |
| `POST /v1/intents` | `project` (slug), `title`, `description`, `risk_tier`, `data_class`, optional `budget_usd` (decimal string), `issue_number` |
| `GET /v1/intents?project=&status=&limit=&cursor=` | Newest first; keyset cursor on (`created_at`, `id`); `limit` ≤ 100 |
| `GET /v1/intents/:code-or-id` | With the latest spec and plan hashes and every gate decision |
| `POST /v1/intents/:code-or-id/gates/:gate/decisions` | `source = cli` |

## 3. Handbook rules: where they are read

| Rule | Source |
|---|---|
| Roles per gate, oversight mode, forced HITL, dual approval, producers never approve | Config `oversight.*` through the policy engine (unchanged) |
| Approval expiry and working calendar | Config `oversight.approval_expiry`, `escalation.calendar` |
| Maximum autonomy, default intent budget | Config `autonomy.*`, `budget.*` |
| Who may create and read intents | Config `access.*` (new); floor M16 |
| Token lifetime, rate limits | Platform settings, not handbook rules |

## 4. Consequences

- `@sdlc/config`: new `access` block, rule M16; the default `config_hash` changes. ADR-M18 still says "M1–M15"; this ADR adds M16.
- `@sdlc/core`: `admin/` (bootstrap, tokens) and `commands/` (access, gate input, gate command). `SystemScope.createTenantWith` (tenant plus tenant-scoped work in one transaction) and `ping`. `IntentRepository.page` (keyset pages). `TenantScope.transaction` now joins an open transaction instead of failing.
- New audit actions: `tenant.created`, `user.created` (no fields), `api_token.issued`, `api_token.revoked` (`user_id`).
- `sdlc audit verify` stays a direct database command until B13 adds a tenant admin role. B04 no longer moves it behind the API (QUESTIONS #65).
- Tests:
  - `pnpm test`: unit tests (settings, errors and catalog, cursor, rate limiter, tokens, G1 binding, gitleaks rule, compose static checks).
  - `pnpm test:db`: API and admin commands on PostgreSQL.
  - `pnpm test:api`: the container with OpenBao on a throw-away Compose project. It also runs in the CI `compose` job.
- B13 decides what a tenant admin is (QUESTIONS #65: a new table, or `admin` on any project). It then moves token issuing and `sdlc audit verify` behind the API.

## Version history

| Version | Date | Author | Notes |
|---|---|---|---|
| 0.1 | 2026-09-27 | Claude (task B03) | First version |
