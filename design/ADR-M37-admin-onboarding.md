# ADR-M37. Admin onboarding: tenant admins, projects, users, identities, roles, configuration

| Item | Value |
|---|---|
| Status | **Proposed** (task B13, PR 1 for review) |
| Date | 2026-10-03 |
| Decided by | Harry (plan approved 2026-10-03, with answers to QUESTIONS #150–#154) |
| Related | D-08 task B13 (AC1–AC8); D-02 FR-11, FR-14, FR-19; D-05 sections 5, 6.1 (version 1.19); handbook codes table §5, Ch.5, Ch.19, Ch.20 §20.7, §20.9, §20.11; ADR-M09, ADR-M18, ADR-M26, ADR-M31 §2.2, ADR-M36; QUESTIONS #45, #63, #65, #95, #150–#154 |

## 1. Context

Until B13, a tenant could only be set up with direct database access:

- The operator runs `sdlc admin bootstrap` on the server. It creates the tenant, its first user and a token (ADR-M26 §2.2).
- Nothing else could create projects, users, Git host identities, project roles or project configurations, except tests.
- `role_bindings.project_id` is `NOT NULL`, so the data model had no tenant-wide admin (QUESTIONS #65).

B13 must also settle four more things:

- how a stored configuration survives a platform release that changes a default (QUESTIONS #95, AC8);
- who may grant roles without breaking separation of duties;
- how tokens and `sdlc audit verify` move behind the API (AC5, PR 2);
- who approves agents in the register (handbook Ch.20, AC7, PR 2).

B13 has two PRs:

- **PR 1** covers AC1–AC4, AC6 and AC8.
- **PR 2** covers AC5, AC7 and the rename of the operator commands to `sdlc ops`.

## 2. Decision

### 2.1. Tenant admins: a tenant-level role table (QUESTIONS #150, option A)

- New enum `tenant_role` with one value, `tenant_admin`, and new table `tenant_role_bindings` (D-05 §6.1). They follow the pattern of `role_bindings`:
  - a role is withdrawn by setting `revoked_at`, never deleted;
  - one active row per person and role;
  - a revoked row never changes again (trigger, SQLSTATE `SDA11`).
- A tenant admin manages:
  - projects, users and Git host identities;
  - the roles and configuration of every project;
  - other tenant admins;
  - in PR 2, other people's tokens, the agent register and `audit verify`.
- The project role `admin` manages **that project's** roles and configuration only.
- A tenant admin approves no gate: `tenant_admin` is not a project role, so the policy engine never sees it.
- `sdlc admin bootstrap` makes the first user the first tenant admin, in the same transaction, and appends `tenant_role.granted`.
- The tenant always keeps at least one active tenant admin whose user is active:
  - revoking or disabling the last one is refused with `last_tenant_admin`, also for the operator;
  - the tenant's admin bindings are locked (`FOR UPDATE`) during the check, so two admins who remove each other at the same time cannot both succeed.

Option B ("`admin` on any project counts as tenant admin") was rejected:

- The first project needs an admin who has no project yet.
- An admin of one project would get power over every project, user and token.
- Archiving a project would silently change who is a tenant admin.

### 2.2. Separation of duties for admin actions (QUESTIONS #151, #154)

- **No self-grants.** Through the API, nobody grants a project role or a tenant role to themselves (`self_action`, 403), and nobody disables themselves.
  - Another admin does it.
  - A one-admin tenant uses the operator command on the server (`sdlc ops role grant`, PR 2), audited as actor `system`.
  - Revoking one's own role is allowed: it only removes power.
- **Conflicting roles.** One person never holds both roles of a pair on the same project.
  - The pairs are project configuration `access.conflicting_roles`. The default is `[person_a, person_b]` and `[person_b, second_approver]`.
  - New mandatory rule **M21**: the list always contains `person_a` + `person_b`. G1–G3 have no producers (QUESTIONS #64), so one person holding both roles could approve every gate of their own intent.
  - A grant that breaks a pair is refused with `conflicting_role` (409), with the role already held as `reason`.
  - Grants for one project hold a transaction lock while they check, so two grants for the same person cannot interleave.
  - A configuration change that adds a pair does not remove roles granted before it. The next grant is checked.
- The operator commands follow the same rules, except the self-grant rule.

### 2.3. Projects, users, Git host identities

- **Projects.** A project has a slug, a name, a repository (`owner/name`), a default branch and a Git host.
  - The slug and the Git host never change.
  - `github` is the only Git host for now: GitLab comes with its adapter (D-02 §4.2).
  - Archiving sets the status to `archived`. An archived project takes no new role or configuration (`project_archived`).
  - Purging an archived project's evidence and client data is E05 (FR-44).
- **Users** are addressed by ID in every URL: an e-mail address never goes into a URL. The CLI finds a user by e-mail address in the tenant's user list.
  - E-mail addresses are unique per tenant, without regard to case.
  - Disabling a user stops their tokens at once: the API checks the user on every request (ADR-M26 §2.3).
- **Git host identities** are linked by the **numeric account ID** (QUESTIONS #45, AC3).
  - A CHECK refuses anything else in `external_id`. The login is stored for display only.
  - An identity is unlinked by setting `unlinked_at`, never deleted. An unlinked identity never changes again (`SDA11`).
  - Only linked identities are unique, so an account can be linked again, to the same person or another one.
  - Unlinked identities are never used to map a comment to a person, and never mentioned in a comment.
- Values are checked in `@sdlc/core` (`admin/validation.ts`), so the API and the operator commands apply the same rules.

### 2.4. Project configuration upload (AC4)

- `PUT /v1/admin/projects/:project/config` with `config_yaml` and `expected_version`. The YAML is at most 32 KiB.
- `@sdlc/config` validates the YAML (schema, rules M1–M21) and computes `config_hash` (ADR-M18 §2.5).
  - A breach is refused with `config_rejected` (422). The details give one line per problem: the path, the message key and the catalog text.
  - A stale version is refused with `config_version_conflict` (409).
- Loosening warnings (ADR-M18 §2.4) are returned to the caller and recorded in `config.changed`:
  - `warnings`: up to 16 codes of the form `<warning>:<path>`, for example `mode_loosened:oversight.matrix.G2.medium.mode`;
  - `warning_count`: the number of warnings.
  - The audit log gets a new field kind `codes` (a list of 1–16 codes) for this. The hashed field list does not change, so `hash_version` stays 1.
- `config.changed` also records `override_sha256` and the `cause` (`upload` or `defaults_changed`). It never records the YAML text.
- Anyone with a role on the project, and every tenant admin, may read the stored configuration. A person with no role and no tenant admin role gets 404.
- **Change from the approved plan:** no `project_config_versions` table.
  - An append-only table never holds free text (CLAUDE.md), and a YAML file can carry comments.
  - The hash of every version is already in its `config.changed` event.
  - `project_configs` keeps the YAML in force, where it can be edited or deleted.

### 2.5. Stored configurations after a change of platform defaults (AC8, QUESTIONS #95)

- New column `project_configs.override_sha256`: the SHA-256 of the stored YAML text. The repository writes it on every save, and the migration fills it for existing rows.
- `config_hash` stays the hash of the **effective** configuration (ADR-M18 §2.5). A release that adds or changes a default therefore changes the effective hash of every stored configuration.
- When the api and the worker start, they check every stored configuration (`checkStoredConfigsAtStart`, before they serve):

| Stored YAML (`override_sha256`) | Effective hash | Outcome |
|---|---|---|
| unchanged | unchanged | nothing to do |
| unchanged | changed, still valid | re-hashed: a new version is saved, `config.changed` (actor `system`, cause `defaults_changed`), and it is used from then on |
| unchanged | no longer valid under the new defaults | left as is; refused (`config_invalid`); warning in the log |
| changed outside the platform | — | left as is; refused (`config_hash_mismatch`); warning in the log |

- A compare-and-set on the version makes it safe when the api and the worker check at the same time: one saves, the other sees `raced` or `unchanged`.
- Between a release and the check, `loadEffectiveConfig` refuses with the new code `config_defaults_drift`, so the project fails closed and never runs on a hash that is not stored.
- New defaults only arrive with new code, and new code only runs after a restart. So a check at start-up is enough, and the ~10 callers of `loadEffectiveConfig` stay unchanged.
- An old process still running during a rollout fails closed in the same way.

### 2.6. API endpoints (PR 1)

Every handler works on the caller's tenant scope. Another tenant's objects give the same 404 as unknown ones.

| Method and path | Who |
|---|---|
| `GET`, `POST /v1/admin/projects`; `GET`, `PATCH /v1/admin/projects/:project`; `POST /v1/admin/projects/:project/archive` | tenant admin |
| `GET`, `POST /v1/admin/users`; `GET`, `PATCH /v1/admin/users/:user`; `POST /v1/admin/users/:user/disable` and `/enable` | tenant admin |
| `GET`, `POST /v1/admin/users/:user/identities` (`?include_unlinked=true`); `DELETE /v1/admin/users/:user/identities/:id` | tenant admin |
| `GET /v1/admin/projects/:project/roles` (`?include_revoked=true`) | any role on the project, or a tenant admin |
| `POST /v1/admin/projects/:project/roles`; `DELETE /v1/admin/projects/:project/roles/:id` | tenant admin, or the project's `admin` |
| `GET /v1/admin/projects/:project/config` | any role on the project, or a tenant admin |
| `PUT /v1/admin/projects/:project/config` | tenant admin, or the project's `admin` |
| `GET`, `POST /v1/admin/tenant-admins` (`?include_revoked=true`); `DELETE /v1/admin/tenant-admins/:id` | tenant admin |

- `GET /v1/me` adds `tenant_admin` (true or false).
- `revoked_at` and `unlinked_at` come from the database clock, like `created_at`, so a clock difference between the api and the database can never make a revocation look earlier than the grant.
- New error codes, each with a catalog key `api.error.<code>`:

  | Code | Status |
  |---|---|
  | `user_not_found`, `identity_not_found`, `role_binding_not_found` | 404 |
  | `project_archived`, `user_not_active`, `conflicting_role`, `last_tenant_admin`, `already_exists`, `config_version_conflict` | 409 |
  | `self_action` | 403 |
  | `config_rejected` | 422 |

- A permission check always comes first: a caller without permission learns nothing about the configuration it sent.

### 2.7. CLI (PR 1)

- `sdlc admin project|user|identity|role|config|tenant-admin …` go through the API.
  - They are user commands: the B04 client and the saved login of `sdlc login` (or `SDLC_API_URL` and `SDLC_API_TOKEN` in CI), the same exit codes and output rules (ADR-M36). There is no second login mechanism.
  - `--user` takes a user ID or an e-mail address. The address is looked up in the user list and never goes into a URL.
  - `sdlc admin config set --file <yaml> --expected-version <n>` reads a regular file of at most 32 KiB.
- In PR 1, the other `sdlc admin …` commands (`bootstrap`, `token`, `agent`, `ai-record`) stay operator commands with direct database access. PR 2 moves them to `sdlc ops …` (§2.8).

### 2.8. PR 2 (decided, not built yet)

- **Tokens through the API (AC5, QUESTIONS #152).**
  - People issue, list and revoke their own tokens (`/v1/me/tokens`). `sdlc logout` revokes the current token before it deletes the saved login (the ADR-M36 §4 follow-up).
  - A tenant admin may issue a first token for another user, valid **at most 7 days**. The audit event records who issued it, and the user is told to create their own token and revoke that one.
  - The raw token appears once, in the response body. It is never logged.
- **`sdlc audit verify` through the API** for tenant admins.
- **Operator commands move to `sdlc ops …`.**
  - `bootstrap`, `token`, `ai-record`, `audit verify`, `tenant-admin` and `role grant` keep their direct database access.
  - The `sdlc ops agent` write commands are removed, except `suspend` and `quarantine`. They stay as safety moves for when the API is down. `activate` never goes through ops.
  - Runbook T11 is updated for the rename.
- **Agent register endpoints (AC7)** enforce handbook Ch.20:

  | Action | Approvers |
  |---|---|
  | Use approval, L0 | Person A + technical owner |
  | Use approval, L1–L2 | Technical owner + Person B |
  | Change approval | Technical owner + Person B |
  | Retire | Owner + leadership (`governance`) |
  | Suspend or quarantine | One person: Person B or `governance`, at any time |

  - Approvers are always two different people.
  - "Holds the role" means: holds it on any active project of the tenant (MVP).
  - Approvals are bound to the agent version.
- **Time-limited exception.** The approver table of the agent register lives in code (`agents/approval-rules.ts`, with sources) and not in configuration. This breaks the rule that handbook rules belong in configuration. The reason: agents belong to the tenant, and no tenant-level configuration exists yet. The table moves into a tenant configuration once one exists.

## 3. Alternatives considered

| Alternative | Why not |
|---|---|
| Option B: project `admin` counts as tenant admin | §2.1 |
| Allow self-grants of `viewer` and `admin` | Harry chose no self-grants at all (QUESTIONS #151) |
| Re-hash drifted configurations in `loadEffectiveConfig` (lazily) | Changes about 10 callers, some of them in C07's work. Read paths would start writing audit events. Not needed: defaults change only with a restart |
| Hash the stored override plus a "defaults version" instead of the effective configuration | Changes the meaning of `config_hash` (ADR-M18, D-05) for every past gate decision |
| A `project_config_versions` table with the YAML | Free text in an append-only table (§2.4) |
| Users in URLs by e-mail address | Personal data in URLs and in access logs |

## 4. Consequences

- D-05 version 1.19: §5 `tenant_role`; §6.1 `tenant_role_bindings`, `user_identities.unlinked_at` and its CHECKs, `project_configs.override_sha256`.
- `@sdlc/config`: new key `access.conflicting_roles` and rule M21. The default `config_hash` changes, and AC8 handles the change for stored configurations.
- New audit actions:
  - `project.created`, `project.updated`, `project.archived`;
  - `user.updated`, `user.disabled`, `user.enabled`;
  - `identity.linked`, `identity.unlinked`;
  - `role.granted`, `role.revoked`;
  - `tenant_role.granted`, `tenant_role.revoked`.
  - `config.changed` gains `override_sha256`, `cause`, `warning_count` and `warnings`.
  - They hold IDs and codes only: never a name, an e-mail address, a login, an account ID, a repository or YAML text.
- The numbers of this PR (migration `0014`, `SDA11`, rule M21) were taken before C07 PR 2. Whichever of the two merges second renumbers its migration, SQLSTATE and rule (Harry, 2026-10-03).
- Tests:
  - `pnpm test`: rules, warning codes, value checks, CLI commands against a mocked API, CLI schemas against the presenters.
  - `pnpm test:db` (`admin-onboarding.test.ts`): every endpoint, separation of duties, tenant isolation, the audit chain, no token in the logs.
  - `pnpm test:db` (`config-reconcile.test.ts`): AC8.

## Version history

| Version | Date | Author | Notes |
|---|---|---|---|
| 0.1 | 2026-10-03 | Claude (task B13, PR 1) | First version |
