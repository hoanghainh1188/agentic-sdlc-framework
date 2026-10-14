# CLAUDE.md — Agentic SDLC Framework

> Status: **CODING RESUMED** (Harry, 2026-09-24). Design version 1.0 approved (tag `design-v1.0`).
> Work through `design/D-08-mvp-backlog.md` in dependency order, starting with **A01**. One task per session; open questions go to `design/QUESTIONS.md`.
> Direction: project reference docs → handbook → platform. The platform follows the handbook.
> **The handbook is not yet approved as a whole.** Decision (Harry, 2026-09-24): **code the whole backlog now and accept rework later.**
> - Keep code easy to change where it depends on handbook rules: policy, oversight matrix, roles, SLAs, thresholds belong in **config**, not hard-coded.
> - When an approved handbook change affects the platform: update the design doc first, add a change task to the backlog (`scripts/generate-backlog.py`), then change the code. Never change code silently to follow an unapproved handbook draft.
> Order: M-A → M-B → M-0 (sample repo, separate repo, right before M-C) → M-C → M-D. Task IDs: A, B, R (M-0), C, E (M-D).

## What this repo is
Repository name: `agentic-sdlc-framework`.
The **Agentic SDLC Framework = Handbook + Platform**, in one repo:
- `handbook/` — the process for humans (policies, 6 phases, 8 gates, roles, templates, runbooks). It defines *what must happen*.
- `platform/` — a self-hosted system that *enforces* the handbook: runs AI coding agents through 8 human/automatic gates (G1–G8),
  records evidence and an append-only audit log, and tracks token cost per tenant/project/intent/run.
- `design/` — approved design docs that connect the two.
Open for everyone (Harry, 2026-10-08): the code is MIT and the documentation CC BY 4.0, and they stay open; any income later comes from services (deployment, training, support), never from closing the code or a paid edition (`design/POSITIONING.md` §7). Multi-tenant from day one.
Handbook and platform must stay consistent: same codes, same names for gates, autonomy levels and roles.

## Read these first
Read the documents a task needs before planning it (they are not loaded automatically, to save tokens; QUESTIONS #426):
- Scope and requirements, v0.1 baseline (FR/NFR, acceptance criteria): `design/D-02-mvp-scope.md`
- Architecture, interfaces, Run Contract, code layout: `design/D-03-mvp-architecture.md`
- Data model, enums, append-only tables, audit hash chain: `design/D-05-data-model.md`
- Backlog (tasks, dependencies, acceptance criteria): `design/D-08-mvp-backlog.md` (read only the task's section)
- Build vs buy decisions (what we reuse, what we build): `design/D-01-build-vs-buy.md`
- Model gateway and token/cost control: `design/D-07-model-and-token-management.md`
- Sample pilot repository: `design/D-09-sample-pilot-repo.md`
- Tests, CI jobs, live tests and the test map by area: `platform/DEVELOPMENT.md`. The design of each area: its ADR (index `design/README.md`).
Always loaded:
- Canonical codes (phases, autonomy L0–L4, oversight modes, gates G1–G8 × risk, 2+N roles): @handbook/00-introduction/05-codes.md

## Language
- Everything in this repo is English: docs, code, identifiers, commit messages, code comments.
- User-facing messages (CLI output, PR/issue comments, Evidence Pack Markdown) are English by default and **must go through a message catalog** (i18n keys), so Vietnamese and Japanese can be added later (D-02 NFR-08). Never hard-code user-facing strings. The catalog is `@sdlc/messages` (`platform/packages/messages/src/locales/<locale>.json`, ADR-M18).
- Write plain English for non-native readers: @handbook/00-introduction/06-writing-style.md
- The handbook must **not** mention the internal reference documents used to design it ("Bản chất…", `Digital_Foundry.pdf`, draft v1.0). State rules directly; cite only external sources and other repo documents.

## Repo layout
- `platform/apps/` — api (NestJS), worker (Temporal, G1–G8 workflow + GitHub poller), runner (sandbox + OpenHands), cli, dashboard (Preact, served by the api)
- `platform/packages/` — core modules, contracts, adapters (git-github, agent-openhands, model-litellm, evidence-s3, policy-simple, traces-langfuse), config (project configuration, ADR-M18), messages (message catalog), secrets, telemetry, api-schemas, workflow-client
- The platform is a modular monolith: keep module boundaries; core must not import adapters directly (use interfaces).
- `platform/deploy/` — docker-compose, OpenBao bootstrap, TLS, backups, `doctor`, `trial`, `github-app`. `platform/tests/` — unit tests; `platform/tests/integration/` — live and database tests, scenarios N1–N6, tasks T01–T10 (D-09). `platform/DEVELOPMENT.md` — tests and live checks.
- `design/` — approved design docs (D-xx) + `README.md` (index, number history) + `QUESTIONS.md`. `handbook/` — process handbook for humans. `diagrams/` — Mermaid sources + SVG.
- `scripts/` — `create-issues.py` (GitHub issues from the backlog), `generate-backlog.py` (single source for D-08 + CSV). `platform/GETTING-STARTED.md` — human setup guide. `platform/deploy/README.md` — deployment and operations. `RELEASING.md` — releases.
- `_review/` — historical review notes in Vietnamese; not a source of requirements. Ignore unless asked.

## Hard rules (always)
- Use only the canonical codes in the codes table (v1.3): phases P1–P6, gates G1–G8, autonomy **L0–L4**, oversight **HITL / HOTL / AUDIT**, risk tiers, PRI-0…3, Stage A/B/C. Never reintroduce old codes (G0–G12, S0–S9, "Level 0–3"). L0–L4 always has the **source** meaning (L0 Assist … L4 High-impact autonomy), never the draft v1.0 meaning.
- The design follows the codes table. If a design doc and the codes table disagree, the codes table wins; raise it in `design/QUESTIONS.md`.
- Every table has `tenant_id`; every query filters by tenant. Tenant data only through `PlatformDatabase.forTenant(tenantId)` / `TenantScope`.
- Every LLM call goes through the LiteLLM gateway with labels: tenant, project, intent_id, run_id, gate, agent, data_class.
- Agents never hold real provider keys, never push to the default branch, never deploy to production. **The platform never merges**: a person merges at G7.
- Separation of duties (2+N): the producer (human or agent) never approves its own output; Person B approves G3, G7, G8. Enforce by capabilities (producer agent has no merge tool). Person A and Person B are never the same person (rule M21).
- Append-only tables (`audit_log`, `gate_decisions`, `run_events`, `cost_records`, `project_ai_record_versions`, `agent_approvals`, and any later one): never add UPDATE/DELETE paths; DB triggers + grants enforce it. They are kept ≥ 2 years and can never be edited or deleted, so they never hold free text or personal/client data: store codes, IDs, hashes, versions and references (for example a link to a GitHub comment) only. Explanations in words stay where they can be edited or deleted (GitHub). Never add a deletion path for the audit log, gate decisions or escalations (FR-44). Audit uses a per-tenant hash chain (RFC 8785 canonical JSON + SHA-256).
- **Client data and secrets never go into Temporal** (workflow inputs, signals, activity results: IDs and codes only), **logs, run events, audit events or any table**: no key, key ID, token, prompt, diff, plan text, review or comment text, tool argument, path or command. Only single-use OpenBao wrapping tokens travel through Temporal.
- Evidence retention: default 180 days (configurable, never below 180). Purge deletes SeaweedFS objects only; keep DB rows + hashes; respect holds (`evidence_holds`); log `evidence.purged`. Open or held intents are never purged.
- Git host, agent, policy engine and model provider are behind interfaces. Do not hard-code one vendor in core logic.
- No secrets in the repo. All secrets live in OpenBao (Vault-compatible API); processes use AppRole + short-lived tokens, credential files never environment values. Sandboxes never access OpenBao. Never write key shares, root tokens or secret values to files, logs or test output (only exception: the trial stack's encrypted key file, ADR-M76).
- **Commands that print or take a secret or token run only in the owner's macOS Terminal app**, never through a chat tool or the desktop app's terminal pane (Claude can read it): `openbao:bootstrap init|unseal|root-token`, credentials commands that the owner runs, `pnpm sdlc ops bootstrap|token issue`, `pnpm github-app:create`, the live tests with keys.
- Run Contracts are signed via OpenBao Transit (Ed25519); the signing key never leaves OpenBao.
- GitHub events are read by polling (GitHub App + API) in v0.1; webhooks come later. Both must feed the same event handler. Users are matched by numeric GitHub account ID only; bots never decide.
- Object storage: SeaweedFS (S3 API). Cache/rate limit: Valkey. Never MinIO, Redis or Elasticsearch (license/maintenance reasons). Pin every image to an exact version; images we publish or depend on are used by digest.
- Never run `docker volume prune` or `docker system prune --volumes` on a machine with a dev stack. Never run anything against the owner's dev stack without being asked.
- Releases, tags, `push: true` image runs and npm publishes are public actions done by Harry: Claude never pushes a tag, creates a release, runs a workflow with `push: true`, publishes to npm or adds an npm token.
- Target host is a modest internal server: keep concurrent sandboxes configurable (default 1–2); heavy observability stack is an optional Compose profile.
- Every FR in D-02 gets automated tests matching its acceptance criteria.

## Module rules (never break; detail in the linked ADR)
Workflow and gates
- The database is the source of truth: `stepIntent` makes at most one move under the intent lock (compare-and-set, audit event and notice in one transaction). Workflow code imports only `@temporalio/workflow`, `@sdlc/contracts` and activity types (ADR-M30).
- No Temporal timer for escalation clocks: they live in the `escalations` row (ADR-M28). The gate deadline is the workflow's only timer. Escalation clocks, retention, spend sync: plain worker loops, never Temporal schedules.
- Call `assertActionAllowed` before a protected action and `revalidateEscalationDecision` before acting on a decision; `kill_run` and `revoke_credentials` are never frozen. A budget goes up only by a decision that names `budget_increase` with an amount (API or CLI), never by a comment; budgets only go up (ADR-M28, ADR-M34).
- Never start a run while `hotlBlockWindowOpenUntil` returns a time (ADR-M30 §2.4b).
- Every step and `waiting_for` resolve oversight through `resolveGateOversight`: never call `policy.oversightMode` in a step module (ADR-M54). Never compute a waiting reason outside the step; a new reason or cause needs its `IntentWaitReason`, catalog label, `api-schemas` map and `sdlc next` rule (`REASON_RULES`, `CAUSE_RULES`) (ADR-M54 §2.4b).
- G2 passes only with ≥ 1 acceptance criterion, at every tier (ADR-M61). Specs and plans are read from the default branch; only hashes, counts and codes are stored, never their text (ADR-M39, ADR-M40).
- Never store a new plan version automatically: a changed plan file holds G3/G4 until a person submits it again. `plans.commit_sha` is always the head the platform read (ADR-M40).
- G4 decisions are bound to the run proposal; G8 approvals to `evidence_packs.release_sha256` plus the merge, never to `content_sha256` (ADR-M33, ADR-M49).
- G7: reviews of the pushed commit are the approvals; `/approve G7` is refused; a request for changes is found by its receipt's event ID, never "the latest changes_requested review"; the API and CLI refuse `request_changes` at G7 (ADR-M41).
- Never issue a run twice. A kill stays a kill: every writer that ends a run uses `RunRepository.end`; never end a run with `transition` from `running` alone; never let a kill signal reach a later run (ADR-M42).
- Evaluation runs live in `evaluations`, `evaluation_runs` and the append-only `evaluation_run_results`, never in `runs`; their cost has `cost_records.evaluation_run_id` (never with an intent) and stays out of the intent cost reports; they use free runner slots only; codes and numbers, never a prompt, task text or diff (ADR-M81). Their scoring container is the sandbox image, two containers over one volume: install with the package proxy, then the diff and hidden tests with `NetworkMode: none` (guard `assertSafeScoringSpec`). The runner runs them on `sdlc-runner-eval` and writes no run event; the worker writes the result with the cost. The worker's `EvaluationLoop` is a plain loop (never a Temporal schedule); one workflow per run attempt (ID names the attempt); never prepare an attempt while the workflow of the earlier one lives.
- Evaluation plans (ADR-M82): only people with a role in `access.eval_roles` (never `viewer`) change or run them; a prompt variant is a file on the default branch, stored as path, commit and SHA-256, never its text; one open evaluation per plan; amounts change only by a new version, never below the month's spend.
- Never offer an approval to a producer or to someone without the gate's role (`sdlc next`, the dashboard).
- Producers never decide: at G7 the creator, every run's `triggered_by`, the plan submitters and the commit authors; at G8 the creator, the people who allowed its runs and the plan submitters (ADR-M41, ADR-M49). Escalations are acknowledged and decided only by the owner role, the backup role or governance, never a producer (ADR-M28).
- A Git host or file that cannot be read makes the step wait; it never passes a gate (ADR-M39, ADR-M40). HOTL never passes G2 without acceptance criteria.
- The platform never raises an intent's data class (ADR-M32). L1 runs never commit or push; their proposal is evidence, downloaded by a person (mode 600, never printed), and only that paused case takes a G4 rejection (ADR-M33 §2.9, ADR-M64).
- `sdlc plan draft` is local only: no API call, no Git command, never submits, commits or pushes; never fill the `PERSON MUST` fields by guessing (ADR-M62).
- Pull request text on the public pilot is codes only; GitHub logins are read when posting, never stored.

Runner, sandbox, agent
- Never add a sandbox environment variable, mount, capability or network outside `docker/guard.ts`. Sandbox egress = LiteLLM and the package proxy only; GitHub is reached by the runner, never by the sandbox (ADR-M25). The socket proxy allowlist equals `ALLOWED_ENDPOINTS`.
- Trust `sdlc.*` labels only on objects with this runner's instance label; one runner process per instance label.
- The runner talks to Docker only through its own client (endpoint allowlist); the GitHub App key comes only from OpenBao `kv/shared/github-app`, readable by the api and worker AppRoles, never the runner (ADR-M23, ADR-M25).
- Sandbox output is untrusted: changed files, diffs and heads are recomputed outside the sandbox with hardened git. Never push what the sandbox committed, never write the change to a working tree, never force-push; push `agent/INT-…` with an explicit refspec (ADR-M29 §2.5, ADR-M38).
- Tools only `file_editor`, `task_tracker`, `terminal`; the model must be in `allowed_models`; AGENTS.md from the workspace, never public or user skills. Every edit of an agent's instructions file or model is a new agent version (ADR-M29, ADR-M31). Never activate an agent through `sdlc ops`.
- Plan text and review feedback go to the agent only in nonce-delimited blocks, framed as data, cleaned and capped (ADR-M40 §2.7, ADR-M41 §2.7).
- Recognise a LiteLLM budget block by 422 **and** error type `budget_exceeded`, never by 429 alone (ADR-M24). Money is a decimal string, never a float. `listSpend` never returns part of a range as all of it.
- GitHub tokens are single-repository and revoked by the runner right after use (ADR-M42 §2.4).

Evidence, retention, storage
- Evidence is never overwritten (`If-None-Match: *`). Every stored item is re-checked (SHA-256, size) before a pack is built or a file is served: fail closed (ADR-M48). Processes that read client code from the evidence store never log or keep the bytes.
- An Evidence Pack holds codes, IDs, hashes, counts and references only (never a diff, spec, plan or review text); approvers' names only in the Markdown, every Markdown value escaped (ADR-M48). The purge identity `worker-purge` never reads (ADR-M51).
- Reports sum in SQL; money as decimal strings, token sums as digit strings, never floats; never a breakdown per person (ADR-M45, ADR-M47). `sdlc trial report` uses existing GET endpoints only, is built from named fields only and is checked by a strict schema before printing (ADR-M65).
- Retention purges never send the object-lock bypass; only the archive purge and the orphan sweep do. Nothing younger than 180 days is purged for retention, whatever the configuration (ADR-M51). The audit anchor bucket is COMPLIANCE; never log an anchor hash in a mismatch.
- Langfuse purge: select traces by run tags, check every trace's tags, never request `io`; no Langfuse step unless the key's project equals `SDLC_WORKER_LANGFUSE_PROJECT_ID` (ADR-M53). Never give the ClickHouse user `langfuse` access management (ADR-M63 §6).
- SeaweedFS: only the S3 API is reachable; never publish or open another SeaweedFS port, never turn Iceberg or Lance on, never store its JWT keys anywhere else; admin work only with `docker compose exec seaweedfs weed shell -master=127.0.0.1:9333` (never `-master=seaweedfs:9333`). Never run `weed shell s3.config.show`; never pass S3 keys as process arguments (ADR-M52, ADR-M33 §2.9).
- Migrations are plain SQL; never edit a merged one. Audit events are written only through `TenantScope.audit.append`. A new run event type, audit action or payload field is declared in `run-events/types.ts` / `audit/actions.ts` with a test.

Secrets, TLS, deployment
- OpenBao speaks TLS on 8200 everywhere; certificate verification can never be turned off. Never bind-mount host TLS files, never add a plain listener or `SDLC_OPENBAO_ALLOW_PLAINTEXT` to the compose file (ADR-M63). OpenBao "healthy" = API reachable, not unsealed.
- Secret values are `Redacted`: call `reveal()` only where the value is used, never to log it (ADR-M21).
- `pnpm compose:env` never overwrites; add `-v` to `compose down` only to wipe data on a dev machine.
- Backups: every part is encrypted with age as it streams; never write an unencrypted backup part to disk; the schedule is the server's, never the platform's (ADR-M63 §5).
- `doctor` is read only: every command through the allowlist of `commands.ts`; never add a command that writes; the option is `--env`, never `--env-file`; it prints no secret. Every README "Troubleshooting" row needs an entry in `troubleshooting.ts`.
- `trial:up` / `trial:start` are for developer machines only, never a server; every `docker compose` call passes `-p` and children never inherit the shell's `COMPOSE_PROJECT_NAME`; the passphrase never comes from an argument or an environment variable (ADR-M76). A change of a README "Fresh deployment" step changes `trial/src/up.ts` and `test:fresh-deploy` too.
- Team access: the proxy is never on the `sdlc` network and never sends a CSP; keep the body limit equal to the api's; every throw-away Compose project gets its own `access` subnet (ADR-M67). A host name is required, never only an IP (passkeys); the proxy logs no header and no query string.
- `pnpm github-app:create`: `manifest.json` is the one source of the App's permissions (keep it equal to the README table); the client and webhook secrets are dropped, never stored or printed.
- Logging only through the platform logger (codes, flat IDs and counts); spans never hold headers, query strings or SQL parameter values (ADR-M35). Database pools always have error listeners; api and worker import `./telemetry.js` first. The `otel-collector` has no host port, is never a sandbox egress service and is the only holder of the Langfuse project key.

Dashboard, sign-in, API
- The dashboard reads with `GET` and writes only to the fixed paths of `src/api/writes.ts`; never add another write path, and never mark a business route `@SessionAction` before U07. The guard takes a bearer token or a session cookie, never both. A session writes only with all three CSRF layers (ADR-M54, ADR-M73).
- Never weaken the session cookie attributes; the person's GitHub token is revoked at once and never stored. No inline script or style, no `innerHTML`, no browser storage in the dashboard; the token lives in memory only. Every dashboard read goes through `src/api/client.ts` with a path from `src/api/reads.ts`; server text is shown as text (`cleanText`), never HTML; the GitHub sign-in is a top-level navigation, never a fetch.
- The CLI reads tokens from a hidden prompt or stdin, never an argument; never prints them; refuses `NODE_TLS_REJECT_UNAUTHORIZED=0` and redirects (ADR-M36). A new token appears once; never log it. The saved login is folder 700, file 600; a file others can read is refused. `sdlc doctor` adds no endpoint and sends no request with certificate checks off.
- Admin (ADR-M37): no self-grant or self-disable; the last active tenant admin is never removed; roles are revoked, never deleted; users are addressed by ID in URLs, never by e-mail; GitHub identities by numeric account ID only. Agents (ADR-M31): never deleted, a retired key never reused; the approvers of an activation or retirement are always different people.

Release
- Never rename the job `verify-images` or the environment `npm`; never edit `images.lock` by hand; a version tag never moves. Images are scanned with Trivy before any push. A package bundled into the CLI must have an allowed licence (`ALLOWED_LICENCES`). A new built image goes into the workflow matrix, the overlay, the lock file and `images.sh` together (ADR-M66, RELEASING.md).
- `PLATFORM_VERSION` equals the root `package.json` version. Every CHANGELOG release section from 0.1.1 on has non-empty `### Upgrade notes`.

## Documentation rules
- Design docs in `design/` are APPROVED. Do not change their meaning silently. If code must differ from a design doc: stop, add the question to `design/QUESTIONS.md`, and wait. Approved changes go in a separate PR with a short ADR.
- D-08 and its CSV are generated: edit `scripts/generate-backlog.py`, then run it. Never edit the generated files by hand. Then sync the open GitHub issues: `python3 scripts/create-issues.py --repo hoanghainh1188/agentic-sdlc-framework --update` (try `--dry-run` first).
- Diagrams D9–D13 mirror Mermaid blocks in design docs: if you change one, update the other. After editing a `.mmd`, run `pnpm diagrams:render` and commit the SVG in the same PR (CI only checks it; `diagrams/README.md`).
- Handbook split: policies and generic process chapters are written outside Claude Code. **You own** the handbook parts that describe platform behaviour: Ch.13–16 and Ch.18–20 usage sections (CLI, `/approve` commands, config, troubleshooting) and runbooks (e.g. T11 OpenBao). When a task changes user-visible behaviour, update the matching handbook chapter in the same PR. Never edit template T13 or the policy chapters.
- Keep `CHANGELOG.md` updated for notable changes.
- **Keep this file short** (QUESTIONS #425): a new task adds at most one line to "Commands" and one line per new never/always rule to "Module rules". Its detail goes in its ADR, the deploy README, the runbook or `platform/DEVELOPMENT.md` (tests: one row there per new `pnpm test:*` script, checked by a test).

## Workflow for each task (one task per session, see D-08 section 5)
1. Read the task in D-08 and the related FR / design sections.
2. Propose a plan (files to touch, tests to add, risks). Wait for human approval before coding.
3. Implement on a feature branch named `task/<ID>-<short-name>`. Keep changes inside the approved file list.
4. Tests must cover every acceptance criterion (AC) of the task.
5. Run lint + tests. Open a PR; `.github/pull_request_template.md` (T2, AI disclosure) is filled automatically — complete every section. Put the task ID in the title.
6. If a design doc is missing or contradictory: do not guess. Add the question to `design/QUESTIONS.md` and stop.
7. New technical decisions (library choice, etc.): write a short ADR in `design/`.

## Commands
Run from the repo root. Node.js 24, pnpm 10 (pinned in `package.json` → `packageManager`; `corepack enable` once). Tooling: `design/ADR-M16-monorepo-tooling.md`.
- `pnpm install` — install all workspace packages (dependency install scripts are blocked unless listed in `pnpm.onlyBuiltDependencies`).
- `pnpm build` — compile every package with TypeScript project references (`tsc -b`), then build the dashboard with Vite (`platform/apps/dashboard/dist/web`).
- `pnpm typecheck` — build + type-check the tests in `platform/tests/`.
- `pnpm lint` — ESLint, type-aware, including module boundaries (`core` never imports adapters; adapters import `@sdlc/contracts` only).
- `pnpm format` / `pnpm format:check` — Prettier. Never touches `handbook/`, `design/`, `_review/`, `diagrams/` or Markdown.
- `pnpm test` — Vitest (all `platform/**/*.test.ts` except integration tests). One file: `pnpm test platform/tests/workspace/boundaries.test.ts`.
- `pnpm test:*` — every other suite (database, workflow, Compose, runner, agent, pilot, dashboard, live tests): what it needs and where it runs in `platform/DEVELOPMENT.md` §2–§3. Live tests with a real GitHub App or model are run by the owner only, never in CI.
- `pnpm clean` — remove build output.
- Before a PR: `pnpm build && pnpm typecheck && pnpm lint && pnpm format:check && pnpm test`.
- New package: put it under `platform/apps/`, `platform/packages/` or `platform/packages/adapters/` with the `@sdlc/` scope, and add it to the root `tsconfig.json` references.
- `pnpm diagrams:render [name …]` / `pnpm diagrams:check` — render Mermaid to SVG (needs Docker) / the CI check (`diagrams/README.md`).
- Compose (ADR-M17, `platform/deploy/README.md` "Profiles", "Start and stop"): `pnpm compose:env` (once; never overwrites), `compose:core`, `compose:obs`, `compose:models`, `compose:platform`, `compose:sandbox`, `compose:access`, `compose:down` (volumes kept). Dev stack from scratch: `platform/GETTING-STARTED.md` Step 11b; restart after a break and pilot preparation: Steps 13–14 (point the owner there).
- OpenBao (ADR-M19, ADR-M21, runbook T11): `pnpm openbao:bootstrap init|unseal|configure|root-token|status|<name>-credentials` (each credentials command: runbook T11 §5b–§5n), `pnpm openbao:tls dev|ca|server|check|reload` (ADR-M63, T11 §3c).
- Backups (ADR-M63 §5, T11 §6–§7): `pnpm backup`, `pnpm restore <folder> <age key>` (into an empty stack only).
- Database (ADR-M09): `pnpm db:migrate` / `pnpm db:status` (`SDLC_DB_MIGRATION_URL`, owner role `platform`; processes connect as `platform_app`).
- Dev mode without Compose: `pnpm api:start`, `pnpm worker:start` (ADR-M26, ADR-M27; refused with `NODE_ENV=production`).
- Operator commands on the server: `pnpm sdlc ops bootstrap|token|audit verify|tenant-admin|role|ai-record|agent|run kill|retention report|eval start` (`SDLC_DB_URL`, actor `system`; ADR-M26, ADR-M37; deploy README "Fresh deployment" step 8). A token is printed once: owner's terminal only.
- User CLI (ADR-M36, handbook Ch.19 §19.8c, `platform/USER-GUIDE.md`): `sdlc help|login|logout|whoami|token|audit verify|intent|spec|plan (submit|list|show|draft)|gate|escalation|run|evidence|ai-record|cost report|metrics gates|metrics agents (V13, ADR-M79: a role in both the cost and metrics read lists; a run's model = its `model_selected` run event, else the most costly model of its cost records)|trial report|next|doctor|admin …`, all through the API, all with `--json`.
- Sandbox images (ADR-M25, T11 §5g): `pnpm sandbox-image:build node24`.
- Evaluation harness (L02, ADR-M78, `platform/DEVELOPMENT.md` §3): `pnpm eval --out <folder outside the repo> [--config] [--configurations] [--tasks] [--n]`, `pnpm eval --check`, `pnpm eval:report --out <folder>`, `pnpm eval:pairs --out <folder> --a <id> --b <id>` (`purge-diffs`); kept diffs stay in `<out>/diffs/` (700/600), never in a result or report; developer machines only, never in CI; results hold numbers and codes only; never a `:cloud` model; the hidden tests and `solution.patch` never reach the agent.
- Deployment helpers: `pnpm doctor [--env <file>] [--json]` (deploy README "Doctor"), `pnpm access:tls …` (ADR-M67, T11 §3d), `pnpm github-app:create --out <file outside the repo>` (deploy README "Create the GitHub App"; owner's terminal only).
- Trial on a developer machine (`TRIAL.md`, ADR-M76, T11 §3.1b): `pnpm trial:up --settings <file outside the repo>`, `pnpm trial:start`, `pnpm trial:down [--wipe]`.
- Releases (`RELEASING.md`, ADR-M66, ADR-M72): `pnpm images mode|get|export`, `pnpm release:lock <run-id>`, `pnpm cli:pack` / `pnpm cli:pack-check`. Order: version PR → `release-images` `push: true` (Harry) → lock file PR → tag (Harry) → `release.yml`, `npm-publish.yml`.
- CI: `.github/workflows/ci.yml` (A09; jobs, triggers and path filters in `platform/DEVELOPMENT.md` §2). Actions pinned by commit SHA; thresholds in the workflow `env:`. Short checks share the `scan` job; do not add a job for a check under a minute; every job has `timeout-minutes`.

## Current constraints
- At most 2 sessions at the same time (a docs PR session counts as one).
- One task per session; each parallel session works in its own git worktree.
- State (2026-10-13): **v0.3.0 is released** (V13, L02, V10, H01). Next: the milestone EVAL (QUESTIONS #450: L04–L08) after v0.3.0 and before EXT, then EXT starts with X09 and L01 comes early in v0.4.0 (QUESTIONS #424); U07 waits for trial users (Later); H04, H05, H07 and A10 PR 3 are in Server, and the first real agent run on the company server needs the runner in its own VM or on rootless Docker (QUESTIONS #455). The trial M-E is run by the community (`TRIAL.md`; no trial report yet). Bugs from trial reports always come first. Parked: A10 PR 3 (the company server), K02. The platform keeps the two-person rule (no single-person mode). History of releases: `CHANGELOG.md`; plan: `ROADMAP.md`, D-08.
- Open docs follow-ups: align D-02 §3 and handbook Ch.2 §2.5 on who owns the project AI record (QUESTIONS #103); align template T13 with the plan schema v1 (handbook authors, never in Claude Code).
- Conflicts with `main` on a branch under review: merge `origin/main` into the branch. Never rebase or force-push it.
- `design/QUESTIONS.md` and ADR numbers: each session gets its own block when it is queued and uses only numbers from that block (history: `design/README.md` "Number blocks"; update both places). Held now: none. H01 used #455–#456 and ADR-M80. V13 used #430–#434 and ADR-M79; L02 used #435–#439, #445–#447 and ADR-M78; the plan review used #450; L04 used #460–#464 and ADR-M81; the coordinator used #465 (dashboard first in L05, L06); L05 uses #470–#475 and ADR-M82. **Next free: QUESTIONS #476–#479, ADR-M83.**
- Development uses throw-away OpenBao keys only. The real OpenBao initialisation on the internal server waits until the three key holders are named and the company CA's certificate is issued (QUESTIONS #20, task A10 PR 3; runbook T11 §3c) (remove this line when both are done).

## Decisions (see design/D-02 section 11)
- Q1 first agent: OpenHands · Q2 first Git host: GitHub (GitLab later, same interface) · Q3 language: TypeScript (Node.js) · Q5 repo language: English
- Secret manager: OpenBao (MPL-2.0, Vault-compatible API) · Host: internal server, modest spec
- G7 self-approval rule: intent creator cannot approve G7 · GitHub events: polling in v0.1 (ADR-M11) · SeaweedFS + Valkey (ADR-M12) · Evidence retention 180 days
- Q4 pilot repo: A → C → B. Step A = sample repo `pilot-order-inventory` (Vue + NestJS + PostgreSQL), spec: `design/D-09-sample-pilot-repo.md`
