# ADR-M09. Database access and migration tooling

| Item | Value |
|---|---|
| Status | **Proposed** (task A06, PR for review) |
| Date | 2026-09-25 |
| Decided by | Harry (plan approved 2026-09-25) |
| Related | D-05 sections 3, 5, 6.1, 8, 9 and 11; D-03 AP6 and section 12; D-08 task A06; ADR-M16; ADR-M17; NFR-02, NFR-04 |

## 1. Context

Task A06 chooses the ORM or migration tool and creates the tenancy tables of D-05 section 6.1. Requirements:

- Raw SQL migrations. Task A07 needs triggers, `REVOKE` / `GRANT` and advisory locks.
- Good TypeScript support.
- A data access layer that **requires** a tenant (D-05 D1, D-08 A06 AC3).
- A licence that allows commercial use (NFR-04).

## 2. Decision

### 2.1. Tools

| Need | Choice | Version | Licence |
|---|---|---|---|
| Query builder and migrator | Kysely | 0.29.6 | MIT |
| PostgreSQL driver | `pg` (node-postgres) | 8.23.0 | MIT |
| Driver types | `@types/pg` | 8.23.1 | MIT |

- Neither package runs an install script, so `pnpm.onlyBuiltDependencies` stays empty (ADR-M16 section 2.4).
- Kysely 0.29 is published **as ESM only**. Our packages compile to CommonJS (ADR-M16 section 2.2). Node.js 24 loads ESM packages with `require()`, so this works without changes. The migrator is imported from `kysely/migration`.
- The Kysely `Database` types are **written by hand** (`platform/packages/core/src/db/schema.ts`). `TABLE_COLUMNS` mirrors them at runtime; a type check keeps both equal, and an integration test compares both with the live schema. No code generator is needed.

### 2.2. Migrations

- A migration is a TypeScript module holding **plain SQL statements** (`platform/packages/core/src/db/migrations/NNNN-name.ts`). The statements run one by one; the migrator wraps each migration in one transaction.
- Migrations are listed in a static, ordered index (`migrations/index.ts`): no directory scan, no computed `import()`.
- **Once merged to `main`, a migration never changes.** Fix forward with a new migration.
- Production migrations only go forward. `down` exists for development only.
- The migrator keeps its state in `kysely_migration` and `kysely_migration_lock` (created by Kysely). These two tables have no `tenant_id`: they are infrastructure, not business data, and `platform_app` has no access to them.
- Commands: `pnpm db:migrate` and `pnpm db:status`, with `SDLC_DB_MIGRATION_URL` (owner role). In production, run them after a backup (D-05 section 11). Automatic migration when the API starts in development belongs to task B03.

### 2.3. Database roles

| Role | Used by | Rights in the `platform` database |
|---|---|---|
| `platform` | Migrations only | Owner: creates and changes tables, grants rights |
| `platform_app` | api, worker, runner (the data access layer) | `SELECT` and `INSERT`; `UPDATE` **only on columns that may change**. Never `DELETE`, `TRUNCATE` or DDL. No access to the migration tables |

- `platform_app` is created by `platform/deploy/postgres/init/02-create-platform-app-role.sh` with `PLATFORM_APP_DB_PASSWORD`. Every migration grants it rights on the tables it creates. The first migration stops with a clear error if the role is missing.
- `id`, `tenant_id` and `created_at` are never updatable, so a row cannot move to another tenant even through a bug.
- No `DELETE` enforces D-05 D7 (no hard deletes of business data) in the database.
- A07 grants only `SELECT` and `INSERT` on the append-only tables.
- **Purge and retention (E05, FR-44)** will use a **separate maintenance role**, used only by the cleanup job, with every action written to the audit log. `platform_app` never receives extra rights for purging.
- Until A04, database URLs and passwords come from the environment (`.env`, allowed by NFR-03). Later they come from OpenBao (D-03 section 8.2).
- Existing data volumes do not run the init scripts again. The script is idempotent: run it once by hand (`platform/deploy/README.md`, "Platform database roles").

### 2.4. How the data access layer requires a tenant

| Layer | Mechanism |
|---|---|
| Type | `TenantId` is a branded string, created only by `parseTenantId()` (UUID check). Tenant data is only reachable through `PlatformDatabase.forTenant(tenantId)`, which returns a `TenantScope` with the repositories. Insert inputs omit `tenant_id`; the scope sets it. The raw query builder is not exported from `@sdlc/core` |
| Runtime | `TenantScope` checks the tenant ID again. Every repository query adds `tenant_id = <tenant>`. The **tenant guard** (a Kysely plugin) checks every query before it runs. Rules are listed below |
| Database | Composite foreign keys `(tenant_id, <fk>) → parent (tenant_id, id)` (D-05 D2): a row can never reference another tenant's row. Column-level `UPDATE` grants (section 2.3) |

Tenant guard rules:

- Every occurrence of a platform table needs its own condition `<table or alias>.<tenant column> = <this tenant>`. This covers `FROM`, `JOIN`, `UPDATE` and `DELETE`, in every query level: the main query, subqueries, derived tables and CTEs.
- The condition must be in `WHERE`, or in the `ON` clause of that table's own `JOIN`. It must not sit under `OR` or `NOT`.
- An unqualified `tenant_id` counts only when the query level reads one table.
- `INSERT` must set the tenant column to this tenant in every row. `INSERT … SELECT` is rejected.
- `ON CONFLICT DO UPDATE` is rejected, because its target row may belong to another tenant. `UPDATE` must never write the tenant column.
- `INSERT` into and `UPDATE` of `tenants` are rejected. A tenant may read its own row; tenants are managed through the system scope only.
- These are rejected: raw SQL statements, `MERGE`, tables not in `TENANT_COLUMN`, other schemas, and CTE names equal to a table name.
- Raw SQL *fragments* inside a built query (for example ``sql`lower(email)` ``) are allowed. They must never reference a table; code review checks this.

**System scope.** A few operations cannot be bound to one tenant. They live in `SystemScope` as a short list of named methods; there is no generic access:

- create a tenant
- read a tenant by ID or slug
- `resolveApiToken(hash)`: task B03 finds the tenant from the token, so this lookup crosses tenants

PostgreSQL Row-Level Security stays in MVP+1 (D-05 section 8).

### 2.5. Enums

- Only the enums used by existing tables are created: `data_class`, `project_role` and `git_provider`. Each later task creates its enums with its tables. This keeps rework small while the handbook is not yet approved as a whole.
- Enums hold **vocabulary** only: role names, data classes. The **rules** that use them live in project config (A05) and policy (B01): who approves which gate, which data classes need consent, SLAs.
- `platform/packages/core/src/db/vocabulary.ts` lists the same values; a test compares them with the database.

**Changing an enum later** (for example when the handbook changes the 2+N roles):

1. Add the value in a new migration: `ALTER TYPE project_role ADD VALUE 'new_role';`.
2. PostgreSQL does not allow a new enum value to be **used in the same transaction** that added it. Each migration runs in one transaction, so a migration that adds a value must not insert or compare that value. Use it in a later migration or in application code.
3. Add the value to `vocabulary.ts` in the same PR.
4. To rename a value, use `ALTER TYPE … RENAME VALUE 'old' TO 'new'`.
5. PostgreSQL cannot remove a value. Removing one means creating a new type, converting the columns, and dropping the old type. Plan it as its own migration and design review.

### 2.6. Tests

| Kind | Where | Database |
|---|---|---|
| Unit | `platform/tests/db/` (in `pnpm test`) | None: queries are compiled with a dummy driver. Covers the tenant guard (including JOIN, subquery and CTE cases), `TenantId`, the migration SQL, and compile-time checks |
| Integration | `platform/tests/integration/db/` (`pnpm test:db`) | Throw-away PostgreSQL |

- `platform/deploy/scripts/test-db.sh` starts the Compose PostgreSQL image with the Compose init script. It uses random passwords and a port bound to 127.0.0.1, and removes the container afterwards. With `SDLC_TEST_DATABASE_URL` set, it uses that server instead.
- Each test file creates its own database and drops it afterwards.
- Tests connect as superuser with `-c role=platform` or `-c role=platform_app`, so every check runs with the privileges of the real role.
- CI job `db` runs `pnpm test:db` on every PR. `ci-ok` waits for it. With `SDLC_REQUIRE_DB=1`, a missing database fails the tests instead of skipping them.

### 2.7. Details not written in D-05

Approved with the plan:

- `tenants.created_at`
- email unique per tenant ignoring case (`lower(email)`)
- `api_tokens.token_hash` unique across tenants
- unique `(tenant_id, user_id, project_id, role)` on `role_bindings`

Implementation choices:

- Text status and AI record columns use `CHECK` constraints with the values of D-05.
- Every foreign key uses `ON DELETE RESTRICT`.
- `project_configs.updated_by` may be null: the platform wrote the config itself.
- `api_tokens` stores only the SHA-256 hash (`CHECK` on 64 lowercase hex characters). The repository rejects anything else, and the raw token never reaches the database.
- `project_configs` and `project_ai_records` are versioned with optimistic locking: `save(…, expectedVersion)`. History goes to the audit log from A07 on.
- `role_bindings.revoked_at` (QUESTIONS #11, approved): a role is withdrawn by setting it; revoked rows stay as history. The unique key applies to active bindings only (`WHERE revoked_at IS NULL`), so a role can be granted again. `platform_app` may update only `revoked_at`, and a `CHECK` keeps it after `created_at`. `revoke()` uses the database clock by default. Raw SQL could still set `revoked_at` back to NULL; A07 adds a trigger that refuses any change once it is set (QUESTIONS #12).
- The 1–1 tables are keyed by `project_id` alone (D-05). A cross-tenant insert into them fails on the primary key before the foreign key. It is still rejected, but with the error code `conflict` instead of `reference_not_found`.

## 3. Alternatives not chosen

| Option | Why not |
|---|---|
| Drizzle ORM + drizzle-kit (Apache-2.0 / MIT) | Migrations are generated from a schema file; triggers and grants live outside it, so generated diffs and the real database drift apart |
| Prisma 7 (Apache-2.0) | Its schema language does not model triggers or grants; heavier (CLI, generated client); tenant enforcement only through client extensions |
| TypeORM (MIT) | Decorator metadata, weaker types, history of maintenance problems |
| node-pg-migrate (MIT) + plain `pg` | Good SQL-first migrations, but no typed query builder |
| Testcontainers (MIT) for tests | Extra dependencies (dockerode and friends); a 60-line script does the same |
| Separate CI `services:` container | Service containers start before checkout and cannot mount the init script |

## 4. Consequences

- Every later table must follow section 2.2 and the rules in the header of `0001-tenancy.ts`, and be added to `schema.ts` (types, `TABLE_COLUMNS`, `TENANT_COLUMN`). Tests fail otherwise.
- Repository code must satisfy the tenant guard. A query the guard rejects is a bug in the repository, not in the guard.
- A role is withdrawn by setting `role_bindings.revoked_at`, never by `DELETE` (`design/QUESTIONS.md` #11, approved). Reads return active bindings only by default, so approval checks never see a revoked role.

## Version history

| Version | Date | Author | Notes |
|---|---|---|---|
| 0.1 | 2026-09-25 | Claude (task A06) | First version |
| 0.2 | 2026-09-25 | Claude (task A06) | `role_bindings.revoked_at` (QUESTIONS #11, approved by Harry) |
