# Changelog

## [Unreleased]

### Added
- A01: TypeScript monorepo (pnpm 10 workspaces, TypeScript project references, ESLint, Prettier, Vitest). Packages `@sdlc/api`, `worker`, `runner`, `cli`, `core`, `contracts`, `config` and five `@sdlc/adapter-*` placeholders (D-03 section 11).
- A01: module boundaries enforced by lint: `core` must not import adapters; adapters may import `@sdlc/contracts` only. Formatting and linting never touch the handbook, design docs or Markdown.
- ADR-M16 (proposed): monorepo tooling, CommonJS output (open to change), pnpm build-script allow-list.
- CLAUDE.md: `Commands` section filled.
- A02: Docker Compose infrastructure in `platform/deploy/` with profiles `core` (PostgreSQL 17 with one database and role per component, Temporal 1.31 on PostgreSQL + UI, LiteLLM, Valkey, SeaweedFS, OpenBao sealed until A03) and `observability` (Langfuse 4, ClickHouse 26.3 LTS). Images pinned to exact versions; healthchecks on every service; ports bound to 127.0.0.1.
- A02: `init-env.sh` generates `.env` with random secrets (mode 600); `up.sh` waits for health and one-shot jobs; Langfuse open sign-up disabled, admin created by headless initialisation; Valkey `maxmemory` + `noeviction` shared by LiteLLM and Langfuse.
- A02: static compose tests in `pnpm test`; live test `pnpm test:compose`. ADR-M17 (proposed). `design/QUESTIONS.md` #1–#4 (LiteLLM provider keys from OpenBao, sealed-OpenBao errors in A04, Dependabot for images in A09, Langfuse v4 OTLP for A08). CLAUDE.md: Docker Compose commands.
- A02: `.gitleaks.toml` allowlist for the `valkey/valkey:<tag>` image name (false positive of `generic-api-key`), approved by Harry (Person B) on 2026-09-25 in PR #50.

- A09: CI workflow `ci.yml`: build, type check, lint, format check, unit tests and actionlint on every PR; Gitleaks (any finding blocks), Semgrep (`ERROR` blocks), Trivy (`CRITICAL` blocks, `HIGH` listed in the job summary); Compose `core` integration job that runs when `platform/deploy/**` changes and nightly (skipped until A02 is merged); one summary job `ci-ok`. Actions pinned by commit SHA, downloaded tools checked by SHA-256, read-only permissions.
- A09: Dependabot (GitHub Actions and Compose images, weekly), `.github/CODEOWNERS` (inactive on GitHub Free), `pnpm test:integration`.
- A06: data access layer in `@sdlc/core` (Kysely 0.29 + `pg` 8.23, ADR-M09 proposed). Migration `0001-tenancy`: tables `tenants`, `projects`, `project_configs`, `project_ai_records`, `users`, `user_identities`, `role_bindings`, `api_tokens`, `git_event_cursors`; enums `data_class`, `project_role`, `git_provider`; composite tenant foreign keys (D-05 D2); `ON DELETE RESTRICT`.
- A06: tenant enforcement: branded `TenantId`, `PlatformDatabase.forTenant()` repositories, a tenant guard plugin (rejects queries, including JOINs, subqueries and CTEs, without the tenant condition), a short `SystemScope` (tenants, API token resolution). API tokens stored as SHA-256 hashes only.
- A06: application role `platform_app` (init script, `PLATFORM_APP_DB_PASSWORD`): SELECT, INSERT, column-level UPDATE; no DELETE, TRUNCATE or DDL. Commands `pnpm db:migrate`, `pnpm db:status`, `pnpm test:db`; CI job `db` (throw-away PostgreSQL on every PR, part of `ci-ok`). `design/QUESTIONS.md` #11 (removing a role binding), approved: `role_bindings.revoked_at` with a partial unique index on active bindings, `revoke()`, reads return active bindings by default.

- A07: append-only audit log (migration `0002-audit-log`, ADR-M09 §2.8): `audit_log` with a per-tenant hash chain (RFC 8785 canonical JSON, reusing `@sdlc/config` `canonicalJson`, + SHA-256; `hash_version` 1), per-tenant advisory lock, chain link trigger, triggers refusing UPDATE, DELETE and TRUNCATE for every role, `SELECT, INSERT` only for `platform_app`. New enum `actor_type` (`ACTOR_TYPES` in `@sdlc/contracts`).
- A07: audit payloads hold only declared fields per action (IDs, codes, hashes, versions; max 2048 bytes), never personal or client data. Project config and AI record saves append `config.changed` / `ai_record.changed` in the same transaction.
- A07: `sdlc audit verify [--tenant <slug>] [--json]` (`pnpm sdlc …`, first `sdlc` command, temporary direct DB access until B04). QUESTIONS #12: a revoked role binding can never change again (trigger). New `DbError` code `immutable`.
- A05: `@sdlc/config` loads the project configuration: default file with the codes table values (gate × risk matrix, forced-HITL G3 and dual-approval G7 lists, SLA table, autonomy, budgets, loop limits, model routing, evidence retention 180 days, GitHub polling), partial YAML overrides, safe YAML reading, strict schema (zod), mandatory rules M1–M15 that refuse loosening, warnings for allowed loosening, and a stable `config_hash` (RFC 8785 + SHA-256). Working-time calendar with time zone, working hours and `holidays` for SLA clocks; calendar floor of 5 working days per week and 7 working hours per day (M11), warning above 20 holidays a year.
- A05: `@sdlc/messages`, the message catalog (English; Vietnamese and Japanese can be added as JSON files). `@sdlc/contracts` gets the canonical code lists and the `ProjectConfig` types.
- A05: codes-table drift test (default config vs codes table §3, §4, §6.3 and Ch.6 §6.4). ADR-M18 (proposed). `design/QUESTIONS.md` #5–#10, answered by Harry.
- C01: spike `platform/spikes/openhands/` (not product code) controls the OpenHands Agent Server `1.48.0-python-slim` (pinned by digest) from Node.js: start, status, interrupt, events, changed files; every model call through LiteLLM on a per-run virtual key with the seven D-07 labels; sandbox on an internal network with dropped capabilities and a read-only root filesystem; scripted stub model so no provider key is needed; live test behind `SDLC_OPENHANDS_POC=1`. ADR-M10 (proposed): usable API, limits, conditional go for C05 (the real Claude run is deferred until a company API key exists). `design/QUESTIONS.md` #13 (default run caps go to config in C05), #14 (LiteLLM budget is only a backstop; G5 checks spend), #15 (real Claude run is a condition for completing C05). `pnpm typecheck` also checks the spike.
- B01: `@sdlc/adapter-policy-simple`, the MVP policy engine (`PolicyEngine` interface in `@sdlc/contracts`, D-03 §7.3). It reads every rule value from the validated project configuration: oversight from the gate × risk matrix (D-03 §6.1) with forced HITL at G3, G5 `on_breach`, the G6 security threshold and dual approval at G7; autonomy caps (`prohibited` → L0); model routing over the gateway's model list; G5 file scope with glob patterns (unsafe paths are always out of scope). `canApprove` enforces separation of duties: agents and the system never approve, producers never approve, revoked role bindings never count, dual approval needs two different people covering both roles.
- B01: `@sdlc/contracts` gets the `PolicyEngine` types, the forbidden agent-action lists (handbook Ch.4 §4.7) and the `ValidatedProjectConfig` brand, which only `@sdlc/config` creates after M1–M15 pass.
- B01: new config `oversight.g6_security_findings.min_severity` (default `high`); `g6_security_findings` is now a mapping `{ mode, min_severity }`. Rule M6 requires critical findings to be included; raising the threshold is a warning. Default `config_hash` changes. `design/QUESTIONS.md` #16–#19; D-03 1.1, D-05 1.3, ADR-M18 0.3.

- A03: OpenBao bootstrap `platform/deploy/openbao/bootstrap.sh` (`pnpm openbao:bootstrap`): `init` (Shamir 3-of-2; shares and root token printed once, to a terminal only), `unseal`, `configure` (KV v2 at `kv/`, Transit Ed25519 key `run-contract` that cannot be exported or deleted, AppRoles `api`, `worker`, `runner`, `cost-controller` with one policy each, token role `platform-admin` with 1-hour tokens; safe to re-run; revokes the root token), `root-token`, `status`. Settings in `bootstrap/bootstrap.env`, access rules in `bootstrap/policies/*.hcl`. ADR-M19 (proposed).
- A03: file audit device on the new volume `openbao-audit`; key-holder listener `127.0.0.1:8210` inside the container for creating root tokens and rekeying; fixed Compose subnet `SDLC_NETWORK_SUBNET` (default `172.30.0.0/24`) that AppRole secret IDs are bound to (90 days).
- A03: static tests in `pnpm test`; live test `pnpm test:openbao` (throw-away Compose project and keys), also run by the CI `compose` job. Runbook T11 v0.2. `design/QUESTIONS.md` #20 (TLS for OpenBao).

### Changed
- A03: existing development stacks need `pnpm compose:down` once, because the Compose network now has a fixed subnet. The A02 live test uses its own subnet.
- CLAUDE.md `Current constraints` after A07: session order B01 and A03 now, then A04 and B02; A03 and A04 may use throw-away test keys on dev machines only, while the real OpenBao initialisation on the internal server still waits for the three key holders (Harry, 2026-09-25).
- A07: D-05 v1.2 (§6.7 `hash_version`, identity `id`, nullable `entity_type` / `entity_id`, payload rule; §7.1 hashed fields). ADR-M09 v0.4. `vitest.config.ts` aliases `@sdlc/core` to its sources; the catalog "no unused keys" test also scans `platform/apps`.
- A06 follow-up (#55): the DB layer reuses `DATA_CLASSES` and `PROJECT_ROLES` from `@sdlc/contracts` (no copy in `@sdlc/core`; core no longer exports them) and the `db.*` messages move into `@sdlc/messages` (keys and placeholders in snake_case, for example `db.migrate.missing_url`, `{executed_at}`). The migrate command prints the same text. `vitest.integration.config.ts` reuses the source aliases of `pnpm test`, so the CI `db` job resolves `@sdlc/*` packages without a build. New `pnpm test:db` check: the `data_class` and `project_role` enums in PostgreSQL match the contracts lists. ADR-M09 §2.5 updated.
- A05: D-05 §6.1 v1.1: `config_hash` is the hash of the effective configuration in RFC 8785 canonical JSON (approved by Harry, 2026-09-25).
- A09: Prettier now formats `.github/` workflow files (ADR-M16 §2.6); `render-diagrams.yml` actions pinned by commit SHA.
- Docs fixes (found during A01 planning): README task count 44 and codes table v1.3; leftover pre-2+N roles table removed from D-02 §3.
- ADR-M16 accepted (Harry, 2026-09-25, with PR #46); design/README.md index updated.
- CLAUDE.md: new `Current constraints` section (at most 2 parallel sessions, one task per session in its own worktree, A09 in parallel with A02, A03 waits for the OpenBao key holders).

## [1.3.0-review] — 2026-09-24

### Approved
- Codes table v1.0 (Harry). Ch.1 v0.4: changes requested.
- Ch.1, Ch.2, Ch.3 approved as v1.0 (Harry). Ch.4, Ch.5, Ch.6 approved as v1.0. Ch.8, Ch.9 approved as v1.0. Part I complete (Ch.7 pending legal review). Ch.10–12 approved. Codes table v1.1 (forced-HITL list for G3); v1.2 (dual approval at G7 for sensitive change types). Ch.13–15 awaiting Harry's comments. Ch.2: tool owners and disciplinary rules still open.

### Added / changed
- Handbook: codes table v1.4 (§4 row G6) and Ch.14 v0.2 state the G6 security-finding threshold (default HIGH, CRITICAL always); the codes-table drift test also checks the default threshold. QUESTIONS #21: a G5 breach always stops the run and resuming needs a human decision at every risk tier.
- CLAUDE.md current constraints: each session gets its own `design/QUESTIONS.md` number block (B01 #16–#19, A03 #20; next free #21–#25), after two numbering clashes between parallel sessions.
- render-diagrams workflow hardened: runs on pull requests only and commits SVG to the PR branch (never pushes to main); mermaid-cli pinned (11.17.0); checkout and setup-node v7 (same SHAs as ci.yml); Node 24. New static tests for all workflows: no push trigger with write access, pushes only to a PR branch, pinned global npm installs. Supersedes Dependabot #51 and #52.
- PR template: the human-review box is separate from the AI disclosure and ticked only by the reviewer (T2 v0.3). CLAUDE.md current constraints updated (session order #55, C01, A07; merge-not-rebase rule).
- Repository hosting clarified: organization `harryforge` on GitHub Free; branch protection unavailable; compensating controls (squash-only, delete branch on merge, local pre-push hook, PR review); upgrade to GitHub Team planned.
- Repository history starts with one initial commit on GitHub (Harry); tag `design-v1.0` on that commit. Earlier local history and the `design-pre-handbook` tag are not published.
- Repository: `harryforge/agentic-sdlc-framework` (renamed from `agentic-sdlc-fw`), personal account, risk accepted (Harry). GETTING-STARTED commands use the real repository.
- `platform/GETTING-STARTED.md` rewritten: preparation, push with both tags, 44 issues, Claude Code check session, standard task loop and prompt, order after A01, handbook-change flow, how to send handbook comments. `create-issues.py` labels 12 tasks `handbook-dependent`.
- Decision (Harry): code the whole backlog now, accept rework after the handbook is approved. Handbook-dependent rules kept in config; changes flow handbook → design → backlog → code.
- Handbook status clarified (Harry): version 1.0, **not yet approved as a whole**; chapter approvals are interim. Design and code may change after the handbook is approved.
- **Design version 1.0 approved** (Harry, 2026-09-24), tag `design-v1.0`. **Coding resumed**, starting with A01.
- Design aligned with the handbook: D-02 (2+N users, oversight matrix, FR-14…19, FR-34…36, FR-43…44, MVP+1 list), D-03 (oversight resolution, approvals, binding, escalation, kill switch, new state machine, ADR-M13…M15), D-05 (new enums and tables: project_ai_records, agents, escalations), D-08 (44 tasks: new B11, B12, C10, C11), D-09 (L0–L2; N5 rewritten; N7–N10). Diagrams d10, d12, d13 regenerated. 
- Part III templates drafted: T1, T3–T10, T12–T18 (v0.1); T11 outline (content by Claude Code in A03/A10). T6 now also covers the agent charter and register; T7 also contains the project AI record.
- Review 04 decisions applied: O1 (Rule 9 split: supervised assistants vs autonomous agents), O2/O3 (single SLA source and single incident process), O4 (Ch.1 links to 0.4). Versions: codes 1.3, Ch.1 1.1, Ch.2 1.2, Ch.3 1.1, Ch.6 1.1, Ch.9 1.1, Ch.13 0.2.
- Consistency review (`_review/04`): Person A/B everywhere; leftover citation lines removed; [Proposal] tags removed from approved chapters; codes table §2.1 aligned with Ch.4 §4.7; Ch.4 §4.11 approvers aligned. Open items O1–O4.
- Part 0 drafted: 0.2 glossary (about 60 terms with Japanese reference terms), 0.3 what Agentic SDLC is, 0.4 core principles (14). Ch.20 v0.2 (recertification every 3 months; register in repo). Ch.13–20 awaiting Harry's comments.
- Ch.16 v0.2 (separate client consent for AI on production logs/data), Ch.18 v0.2 (recovery runbook per project; drills per release cycle for High+), Ch.2 v1.1 (AI record field).
- Ch.19 v0.1 approval queues (blocking vs deferred, routing, decision packets, batching, approval binding, metrics). Ch.20 v0.1 agent and model lifecycle (charter, register, evaluation, readiness and ramp-up, recertification, change/suspend/quarantine, retirement and data disposition). Part II drafted in full.
- Ch.16 v0.1 (agents in operations, remediation record, fast lane, maintenance contracts), Ch.17 v0.1 (generated/reviewed/approved, checks by artifact type, typical AI weaknesses, DoD, AI debt), Ch.18 v0.1 (run limits, critical-timeout recovery, last known good, rollback kinds, no-auto-rollback cases, verification, recovery runbook, drills).
- Ch.13 v0.1 (G4 checks, coding-agent rules, G5 pause triggers, manual equivalents today), Ch.14 v0.1 (independent verification, check groups, G6 criteria and failure handling), Ch.15 v0.1 (G7 review depth incl. dual approval, release record, G8, 2-week observation, learning).
- Part II started: Ch.10 v0.1 (steps vs gates, lifecycle, Agile/Waterfall/hybrid, Sprint 0), Ch.11 v0.1 (intent vs prompt, Intent Record, spec qualities, G1/G2, Japanese client tips), Ch.12 v0.1 (options, ADR, task plan, forced-HITL list for G3).
- Handbook no longer mentions the internal reference documents (Harry): [Doc] tags, source columns, internal references and Appendix E removed; old-code conversion moved to `_review/03`. Writing style v0.3.
- Ch.7 v0.9 provisionally approved (legal review pending; ISO 42001 certification decided later). Ch.8 v0.2 (PQC observation window 2 weeks). Ch.9 v0.2.
- Ch.7 v0.1 compliance: Vietnam AI Law (134/2025/QH15) and PDPL (91/2025/QH15 + Decree 356), Japan AI Promotion Act, AI Guidelines for Business Ver 1.2, APPI, METI contract checklist; ISO 42001, NIST AI RMF, OWASP Agentic; coverage map.
- Ch.8 v0.1 metrics, budget, cost (PQC north-star, 12-metric minimum set, governance metrics, early warning, total delivery cost, budgets, baseline/scale gate, reporting).
- Ch.9 v0.1 adoption roadmap (5 steps, readiness assessment, pilots, questions before production, skills, communication, degradation).
- Ch.5 v0.2 / Ch.6 v0.2: confirmed one-person project rules, resolution SLAs, two-tier governance.
- Ch.4 v0.1 autonomy, oversight, permissions (levels, modes, common actions, forbidden actions, veto, overrides, raising/lowering).
- Ch.5 v0.1 2+N team (permissions matrix, SoD by phase, disagreements, few-people compensating controls, hats, RACI, accountability).
- Ch.6 v0.1 governance (2 tiers), escalation (triggers, response levels named Observe…Incident, package, routing, SLA), no-response rules, safe resume, incidents, rule changes, exceptions, break-glass.
- Ch.1 v0.5: evidence on speed (Peng 2023, METR 2025, DORA 2025), expected benefits, costs, Digital Foundry reference targets.
- Ch.2 v0.2: approved tools Claude + GitHub Copilot; unknown client terms → `client_restricted`; always disclose AI use to clients.
- Ch.3 v0.2: audit log ≥ 2 years; access review every 3 months; same-day removal; client data deleted at project end.
- Ch.3 v0.1 security guardrails and client data: threats, 5 layers, agent hard rules, prompt-injection defence, human rules, client data, incidents, project checklist.
- Ch.2 v0.1 AI usage policy: 9 rules, data classes, project AI record, approved tool list (to confirm), incidents.

### Decided (Harry)
- Direction: project reference documents → handbook → platform.
- Reference priority: the source document "Bản chất của việc dùng AI để viết SRS, Code, architecture" is the main frame; `Digital_Foundry.pdf` (a 65-page governance / operating model set) supplements it, scaled down for an SME.
- **Platform coding is paused** until the handbook is reconciled. Approved design docs may change.

### Decided (review 02, Q1–Q3)
- Two-dimensional agent control: autonomy L0–L4 (source Framework v1/v2) + oversight HITL / HOTL / AUDIT.
- 2+N team by default; Digital Foundry roles as hats.
- G1–G8 kept; oversight per gate depends on risk tier.

### Decided (Q4–Q6)
- Handbook structure v2 accepted (new Ch.6 governance, Ch.9 adoption roadmap, Ch.18 timeouts/rollback, Ch.19 approval queues, Ch.20 agent lifecycle; templates T12–T18; appendix E).
- Autonomy codes **L0–L4** as in the source (draft v1.0 meanings obsolete).
- Escalation SLAs: Critical 15 min, High 1 h, Medium 1 working day, Low 3 working days.

### Changed
- Handbook chapters renumbered and renamed (Part I Ch.1–9, Part II Ch.10–20); contents v0.2.
- Codes table v0.4; Ch.1 v0.4; diagram D1 redrawn (red / orange / blue by oversight).
- Codes table v0.3 rebuilt accordingly (phases with mandatory artifacts, gate × risk matrix, role hats, Stage A/B/C, PRI-0…3, escalation severity).
- CLAUDE.md and README updated; design docs flagged as outdated until revised.

### Added
- `_review/02-handbook-vs-references.md`: coverage map, 9 conflicts, proposed handbook structure v2, platform impact.

## [1.2.0] — 2026-09-24

### Changed
- **The whole repo is now in English** (decision: Harry, 2026-09-24). Docs, handbook, diagrams, templates, scripts, CI.
- File and folder names translated (e.g. `design/D-02-mvp-scope.md`, `handbook/01-policy/`, `platform/GETTING-STARTED.md`). All links updated.
- D-02 NFR-08: everything in English; user-facing messages go through a message catalog so Vietnamese and Japanese can be added later. New decision Q5.
- Autonomy levels are written "Level 0–3".
- Writing style guide rewritten for plain English aimed at non-native readers.
- Approved design docs: translation only, content unchanged. Small consistency fixes: D-02 §11.1 (step C belongs to M-F), D-08 E02 adapter name `evidence-s3`, D-03 principles renamed AP1–AP7.

### Added
- `scripts/generate-backlog.py`: single source for D-08 and its CSV.

### Kept
- `_review/`: historical review notes stay in Vietnamese.

## [1.1.1] — 2026-09-24
- Handbook Ch.1 rewritten in natural Vietnamese; Vietnamese style guide added (superseded by 1.2.0).

## [1.1.0] — 2026-09-24
- `platform/GETTING-STARTED.md` (then `KHOI-DONG.md`): push to GitHub, configure, create issues, first task A01.
- `scripts/create-issues.py`: milestones, labels, 40 issues from D-08 (dry-run, no duplicates).
- Handbook Ch.1 executive summary (draft).

## [1.0.x] — 2026-09-24
- Repo named `agentic-sdlc-framework`. README and CLAUDE.md describe framework = handbook + platform.
- `.github/pull_request_template.md` and template T2.

## [1.0-design] — 2026-09-24
- Harry approved D-01, D-02, D-03, D-05, D-07, D-08, D-09 and diagrams D1, D9–D13. Tag `design-v1.0`.

## [0.13] — 2026-09-24 (review fixes)
- SeaweedFS replaces MinIO (no longer maintained); Valkey replaces Redis (licence).
- GitHub events by polling in the MVP, webhooks later (ADR-M11).
- FR-11: intent creator cannot approve G1 or G7.
- D-05: `actor_type` with `agent`, `succeeded_proposal_only`, evidence `proposal`, `git_event_cursors`, `runs.triggered_by`.
- D-08: M-D tasks renamed `E01…E07`.

## [0.8 – 0.12] — 2026-09-24
- D-03: OpenBao (Vault licence is BSL), internal server of moderate size, unseal key custody (Shamir 3-of-2).
- D-05 data model (17 tables, append-only tables, per-tenant audit hash chain); Evidence Packs kept 6 months; `api_tokens`.
- D-08 MVP backlog (40 tasks, 5 milestones, critical path) + CSV. `design/QUESTIONS.md`.

## [0.1 – 0.7] — 2026-09-24
- Repo skeleton (handbook + design + platform + diagrams), codes table (4 autonomy levels, 8 gates, P1–P6).
- D-01 build vs buy (WeKnora, BMAD, LiteLLM, vLLM); D-07 model and token management; D-02 MVP scope; D-09 sample pilot repo; D-03 MVP architecture.
- Monorepo layout; platform first, trial later.
