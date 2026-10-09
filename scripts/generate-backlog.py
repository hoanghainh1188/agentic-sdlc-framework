#!/usr/bin/env python3
"""
Single source of truth for the MVP backlog.
Edit the task list below, then run from the repo root:
    python3 scripts/generate-backlog.py
It regenerates design/D-08-mvp-backlog.md and design/D-08-backlog.csv.
"""
import csv
import functools
T=[]
def t(id,ms,title,size,deps,fr,area,ac,note=""):
    T.append(dict(id=id,ms=ms,title=title,size=size,deps=deps,fr=fr,area=area,ac=ac,note=note))
t("A01","M-A","Initialise the TypeScript monorepo","S",[],"NFR-05, NFR-07",
 "package.json, pnpm-workspace.yaml, tsconfig*, platform/apps/*, platform/packages/*, lint config",
 ["`pnpm install`, `pnpm build`, `pnpm lint`, `pnpm test` pass on the empty repo",
  "Structure apps/ (api, worker, runner, cli) and packages/ (core, contracts, adapters/*, config) as in D-03 section 11",
  "Lint fails when `packages/core` imports `packages/adapters/*` directly"])
t("A02","M-A","Docker Compose: core + observability infrastructure","M",["A01"],"NFR-01",
 "platform/deploy/docker-compose.yml, platform/deploy/*.env.example, README",
 ["Profile `core`: postgres (separate DBs for platform, temporal, litellm), temporal + temporal-ui, litellm + valkey, seaweedfs (S3 API), openbao",
  "Profile `observability`: langfuse web/worker + clickhouse (+ langfuse DB); Langfuse shares seaweedfs and valkey",
  "Every container has a healthcheck; `docker compose --profile core up` becomes healthy",
  "No real secrets in the repo; only `.env.example` files"],
 "Temporal uses PostgreSQL; no Elasticsearch (D-03 10.1)")
t("A03","M-A","OpenBao bootstrap script","M",["A02"],"NFR-03","platform/deploy/openbao/*",
 ["Initialise with Shamir 3-of-2; print the key shares **once** to the screen, never to a file",
  "Enable KV v2, Transit with Ed25519 key `run-contract`, AppRoles for api / worker / runner / cost-controller",
  "Policies: each AppRole reads only its own secrets (test: runner cannot read the LiteLLM master key)",
  "Re-running the script does not break existing configuration"],
 "Per D-03 sections 8.1, 8.2, 10.2")
t("A04","M-A","Secrets package: OpenBao client","S",["A03"],"NFR-03","platform/packages/secrets/*",
 ["AppRole login, automatic token renewal, KV read, Transit sign and verify",
  "Integration test against OpenBao in Compose","Never log secret values"])
t("A05","M-A","Config package: project configuration","S",["A01"],"FR-14, NFR-08","platform/packages/config/*",
 ["Read YAML config for: the gate × risk oversight matrix, SLA table, forced-HITL (G3) and dual-approval (G7) change flags, retry counts, default budgets, loop threshold, `evidence_retention_days` (default 180), policy rules",
  "Validate the schema; reject configs that loosen mandatory rules (G1, G7, production G8 must stay HITL); clear error messages from the message catalog",
  "Compute a stable `config_hash` (SHA-256) for the same content"])
t("A06","M-A","Database: migration tool + tenant tables","M",["A02"],"NFR-02, FR-19","platform/packages/core/db/*, migrations",
 ["Choose the ORM / migration tool; record the decision in `design/ADR-M09.md` (requirement: raw SQL supported)",
  "Migrations for: tenants, projects, project_configs, project_ai_records, users, user_identities, role_bindings (2+N roles), api_tokens, git_event_cursors (D-05)",
  "The data access layer **requires** a tenant",
  "Cross-tenant test: tenant A cannot read tenant B data"])
t("A07","M-A","Append-only audit log + hash chain","M",["A06"],"FR-41",
 "platform/packages/core/audit/*, migrations, platform/apps/cli (verify command)",
 ["Triggers block UPDATE/DELETE; the application DB user has no update/delete privilege",
  "Per-tenant hash chain: JCS (RFC 8785) + SHA-256; per-tenant advisory lock",
  "Two concurrent writers never corrupt `seq` / `prev_hash` (test)",
  "`sdlc audit verify` detects a modified record (test by editing directly as an admin user)"],
 "Per D-05 section 7")
t("A08","M-A","Structured logging + OpenTelemetry","S",["A01","A02"],"NFR-06",
 "platform/packages/core/observability/*, LiteLLM config",
 ["JSON logs include `tenant_id`, `intent_id`, `run_id` when available",
  "OpenTelemetry traces for api and worker",
  "LiteLLM sends traces to Langfuse when the observability profile is on"])
t("A09","M-A","CI for the platform repo","S",["A01"],"NFR-07",".github/workflows/*",
 ["Lint, type check and unit tests on every PR",
  "Integration test job running the Compose core profile",
  "Gitleaks, Semgrep, Trivy run and block critical findings"])
t("A10","M-A","Resource measurement + backup / restore drill + internal CA / TLS","M",["A03","A07","A11"],"—",
 "platform/deploy/backup/*, platform/deploy/openbao/tls.sh, handbook/03-templates/T11-openbao-runbook.md",
 ["Internal CA + TLS on OpenBao 8200 (QUESTIONS #20): script creates the CA (5 years) and the server certificate (1 year); the CA key is kept offline; renewal steps and a 30-day reminder in T11; clients verify the CA",
  "Backup script: OpenBao snapshot (Raft), PostgreSQL dump, to storage off the server",
  "Restore drill succeeds on a test machine; OpenBao unsealed with 2 shares",
  "Record RAM/CPU/disk usage for the core and observability profiles",
  "Runbook T11 written in full"],
 "Three PRs (ADR-M63, QUESTIONS #325–#327): PR 1 = TLS on 8200 everywhere (AC1; a throw-away CA on development machines and in CI, `pnpm openbao:tls`, renewal without unsealing); PR 2 = backup and restore scripts, encrypted with age to a target folder, and a live restore drill with throw-away keys (AC2, AC3); PR 3 = with the infrastructure operator and the three key holders on the internal server (the company CA, AC4, AC5). Done together with the infrastructure operator. Also before the real server: the runner in its own VM or rootless Docker (ADR-M25 §2.5); done: ClickHouse's `langfuse` user has no access management, a loopback-only `sdlc_admin` makes `sdlc_purge` (ADR-M63 §6, QUESTIONS #330)")
t("A11","M-A","Stop publishing the OpenBao port on the host","S",["A04"],"—",
 "platform/deploy/docker-compose.yml, platform/deploy/.env.example, platform/deploy/README.md, platform/tests/integration/*, design/ADR-M19",
 ["The openbao service publishes no port on the host (QUESTIONS #27, option A); OPENBAO_HOST_PORT removed",
  "The live tests (compose-up, openbao bootstrap, secrets-client) reach OpenBao through a container on the Compose network",
  "The \"KNOWN GAP\" live test becomes: an AppRole login from the host is not possible (no listener on the host)",
  "A static test fails if any compose file publishes 8200 or 8210 again",
  "ADR-M19 §2.5 and the deploy README describe the real behaviour; runbook T11 shows `docker compose exec` for admin work"],
 "Small. Must be merged before A10 (TLS on the same listener)")
t("A12","M-A","Close the unauthenticated SeaweedFS filer and volume access","S",["A02"],"NFR-03",
 "platform/deploy/docker-compose.yml, platform/deploy/seaweedfs/*, platform/tests/integration/*, handbook/03-templates/T11-openbao-runbook.md",
 ["No process other than SeaweedFS itself can read, write or delete evidence through the filer API (port 8888), the volume servers or the master without authentication (for example filer and volume JWT signing in `security.toml`, or ports bound to the container only); the S3 API with the per-process identities keeps working",
  "Live test on the pinned SeaweedFS: from another container on the `sdlc` network, a filer GET, an HTTP DELETE and a direct volume read of an evidence object are refused, and a locked version (E05 object lock, legal hold) cannot be deleted by any path except the purge identity's S3 bypass",
  "Admin work (`weed shell`) runs only inside the seaweedfs container (`docker compose exec`); runbook T11 updated; no secret is printed",
  "A static test fails if a compose change makes the filer, volume or master ports reachable without authentication again"],
 "Found by E05 (QUESTIONS #239, ADR-M51 gap 5): today every container on the `sdlc` network (api, worker, runner, LiteLLM, Langfuse, Temporal) can read or delete all evidence through the filer at seaweedfs:8888 with no authentication, bypassing object lock and legal hold; sandboxes are not on that network. Must be done before the trial M-E, before any real client data, so E07 depends on it")
t("B01","M-B","Policy engine: autonomy, oversight, approvers","M",["A05"],"FR-03, FR-11, FR-14, FR-15, FR-16",
 "platform/packages/contracts (interface), platform/packages/adapters/policy-simple/*",
 ["`maxAutonomy`: critical→L0, high→L1, medium/low→L2 (configurable, never above L2 in the MVP); `client_restricted` only allows self-hosted models",
  "`oversightMode`: resolves HITL/HOTL/AUDIT from the matrix; forced HITL at G3 for flagged changes; G7 always HITL with 2 approvals when flagged or Critical; G8 production always HITL",
  "`canApprove`: approver must hold the gate's role; producers (commit authors, run starter) and agents never count; dual approval needs two different people",
  "`checkScope` (changed files vs plan patterns) and `isForbidden` (handbook Ch.4 §4.7 actions)",
  "Unit tests for every rule, including the matrix edge cases"])
t("B02","M-B","Registry: intents, spec_refs, plans, gate_decisions","M",["A06","A07","B01"],"FR-01, FR-03, FR-10, FR-17",
 "platform/packages/core/registry/*, migrations",
 ["Create intents with code `INT-YYYY-NNNN`, unique per tenant, status `draft`",
  "`max_autonomy` computed by policy at creation; `plans.change_flags` stored",
  "`gate_decisions` append-only, with `oversight_mode`, `approver_role`, bound `input_sha256`, `scope`, `expires_at`; `void` decisions for invalid approvals",
  "Every change is written to the audit log"])
t("B03","M-B","API app (NestJS) + authentication","M",["A04","A06"],"FR-20, NFR-08","platform/apps/api/*",
 ["Authentication with personal API tokens (stored as hashes) issued by an admin",
  "Tenant resolved from the token; every request carries the tenant",
  "Endpoints: intents (create, show, list), gates (approve, reject, request_changes)",
  "Error messages come from the message catalog (English by default)"])
t("B04","M-B","CLI `sdlc`","S",["B03"],"FR-20, NFR-08","platform/apps/cli/*",
 ["`sdlc login`, `sdlc intent create|show|list`, `sdlc gate approve|reject <G> <INT>`",
  "Human-readable output from the message catalog; `--json` mode",
  "Command tests against a mocked API",
  "`sdlc escalation list|show|ack|decide` against the B11 API endpoints (QUESTIONS #77, ADR-M28 §2.7)",
  "`sdlc ai-record show|set` against `GET` / `PUT /v1/projects/:project/ai-record` (B12, QUESTIONS #103, ADR-M32 §2.4)"],
 "The escalation commands need the B11 API (B11 PR 2); the AI record commands need the B12 API")
t("B05","M-B","GitHub adapter (part 1): App, events, comments","M",["A04"],"—",
 "platform/packages/adapters/git-github/*",
 ["GitHub App authentication with the private key from OpenBao; short-lived installation tokens",
  "Read new events (comments, reviews, CI status) by **polling** the GitHub API, with a `since` cursor stored in the DB; webhook signature check kept ready for later",
  "Comment on issues/PRs; read a file at a commit",
  "Implements the `GitHostAdapter` interface exactly (D-03 section 7.1)"])
t("B06","M-B","Event receiver (polling) + comment commands","M",["B03","B05"],"FR-21",
 "platform/apps/worker (poller), platform/packages/core/commands/*",
 ["The poller runs on a schedule (configurable, default 30 seconds) per project; no event processed twice",
  "Accepts `/approve G3`, `/reject G3 <reason>`, `/request-changes G3 <reason>`",
  "Maps the GitHub account (numeric ID) → platform user; checks roles",
  "Bad syntax or missing permission → a reply comment with the reason"],
 "Webhooks are enabled once public infrastructure exists (ADR-M11). One command handler for both polling and webhooks")
t("B07","M-B","Temporal worker + workflow G1–G3","L",["B02","B06","B11"],"FR-10, FR-12, FR-14, FR-17, FR-22",
 "platform/apps/worker/*",
 ["Workflow follows the D-03 state machine: Draft → G1 → G2 → G3",
  "Oversight resolved per gate (B01); HOTL gates pass only when conditions hold and notify the owner; no gate passes by silence",
  "Approvals bound to version, scope and expiry; re-checked before moving on; mismatch or expiry → `void` and re-evaluate",
  "Overdue gates raise escalations (B11); waiting time recorded",
  "Worker restart mid-way → the workflow continues in the right state (test)"],
 "Can be split into 2 sessions: workflow skeleton, then oversight and binding")
t("B08","M-B","Spec linking + hash check","S",["B05","B07"],"FR-02","platform/packages/core/registry/spec*",
 ["Link a spec by path + commit; fetch content from GitHub; store SHA-256",
  "Before G3 and before running the agent: re-check the hash; different → back to G2 (scenario N4)"])
t("B09","M-B","Plan submission + G3 approval","S",["B07"],"—","platform/packages/core/registry/plan*, CLI",
 ["The plan is a file `.sdlc/plans/INT-....yaml` in the repo (files / path patterns, summary)",
  "The platform reads it, hashes it, stores `plans`; the tech lead approves G3",
  "Plan changed after approval → G3 must be approved again"],
 "Two PRs (ADR-M40, QUESTIONS #165–#169): PR 1 = plan file schema, submission (API, `sdlc plan`, config `access.plan_submit_roles`, rule M24), the re-check at G3 and G4 (a changed file holds the gate until a person submits it again), the submitter never approves G3, the run's tools from the plan; PR 2 (after C08) = the runner reads the plan file at the plan's commit for the agent's prompt and checks its hash")
t("B11","M-B","Escalation module","M",["B02","B05"],"FR-18",
 "platform/packages/core/escalation/*, platform/apps/worker (clock loop), platform/apps/api, comment commands",
 ["`escalations` table (D-05); create from triggers with severity, response level and decision packet",
  "Routing: owner by type (intent → Person A; technical/security → Person B; policy → governance) and a backup owner",
  "Acknowledge and resolve clocks from the SLA table, stored in the database and advanced by the worker loop (QUESTIONS #73, ADR-M28); no ack → remind → backup → governance",
  "While open: only safe-list actions continue; everything else frozen; authority never passes back to the producer",
  "Acknowledge and decide via the API or `/ack`, `/decide` comments (CLI in B04); decisions bound to version, scope, expiry; every step audited"],
 "Two PRs: PR 1 = table, config, routing, clocks, freeze; PR 2 = comment commands, API, notices. Supersedes ADR-M14 in part: B07 adds no second timer")
t("B12","M-B","Project AI record + G1 check","S",["A06","B03"],"FR-19",
 "platform/packages/core/ai-record/*, platform/apps/cli",
 ["CLI to create and update the project AI record (versioned, audited)",
  "G1 fails when the record is missing or the intent's data class is not allowed; unknown consent → only `client_restricted` handling",
  "`prod_logs_allowed` exposed to policy for operations tasks"],
 "Codes only, version history, write roles in config (QUESTIONS #103–#106, ADR-M32). AC1: API endpoints and the operator command `sdlc admin ai-record`; the user CLI over the API comes with B04 (AC5)")
t("B13","M-B","Admin onboarding: projects, users, identities, roles, config","M",["B03","B12"],"FR-11, FR-19",
 "platform/apps/api (admin), platform/apps/cli (sdlc admin …), platform/packages/core (admin services), design/ADR (next free number)",
 ["Decide the tenant-admin model (QUESTIONS from B03, D3: A = new tenant-level role table, B = project `admin` counts as tenant admin); record it in an ADR and D-05",
  "Admin API endpoints and `sdlc admin project|user|identity|role|config`, all through TenantScope; every change audited (IDs, codes, hashes only); roles revoked through revoked_at",
  "GitHub identities in user_identities are linked by the numeric GitHub account ID, never by login (QUESTIONS #45)",
  "Project config upload: validated and hashed by @sdlc/config (mandatory rules; warnings recorded in the config.changed audit event)",
  "Token issuing moves behind the API; `sdlc audit verify` moves behind the API once a tenant admin exists (update CLAUDE.md)",
  "Integration tests: cross-tenant isolation, wrong role refused, audit chain intact",
  "Admin API endpoints for the agent register (C10 has operator commands only, ADR-M31 §2.2), enforcing handbook Ch.20: who approves an agent for use (§20.7) and a change (§20.11), and that Person B or leadership may suspend or quarantine at any time (§20.9)",
  "Before any real project stores a configuration (QUESTIONS #95): a stored configuration whose hash differs only because platform defaults changed is recomputed, saved as a new configuration version with `config.changed` (actor `system`), and used; only a change of the stored YAML itself is refused"],
 "Follows B03 (decision D1). Needed before E07: a real tenant must be set up without direct database access")
t("B10","M-B","Integration tests G1–G3","M",["B08","B09","B11","B12"],"FR-01…03, FR-10…19","platform/tests/integration/*",
 ["Happy path: create intent → G1 → G2 → G3 (Low risk: G2/G3 HOTL pass; Medium: HITL)",
  "N4: spec edited after G2 → back to G2; approval expired → `void` and re-evaluation",
  "N5: a producer's approval is ignored; wrong role cannot approve",
  "N7: escalation not acknowledged → backup → governance; work stays frozen",
  "N8: Low-risk plan flagged `migration` → G3 is HITL",
  "Missing AI record → G1 fails"])
t("R01","M-0","Sample repo: Vue + NestJS + PostgreSQL skeleton","M",[],"D-09","repo pilot-order-inventory",
 ["Structure per D-09 section 5; `docker compose up` works","Sample tests for web and api"],
 "Separate repo, not part of the platform monorepo")
t("R02","M-0","Sample repo: baseline features F1–F6","L",["R01"],"D-09","repo pilot-order-inventory",
 ["F1–F6 per D-09 section 4; fake data","Tests for the stock deduction logic when creating an order"])
t("R03","M-0","Sample repo: CI, security scans, branch protection","S",["R01"],"D-09","repo pilot-order-inventory/.github/*",
 ["CI: lint, type check, tests, build; Gitleaks, Semgrep, Trivy",
  "Branch protection on `main`, CODEOWNERS, PR template per T2"])
t("R04","M-0","Sample repo: specs T01–T10 + AGENTS.md","M",["R02"],"D-09",
 "repo pilot-order-inventory/docs/specs/*, AGENTS.md",
 ["10 bilingual Japanese–English specs with acceptance criteria",
  "AGENTS.md: build/test commands, conventions; format checked against OpenHands"],
 "PM/BrSE writes the specs; AI may draft them")
t("C01","M-C","PoC: control the OpenHands Agent Server from Node.js","S",["A02"],"—",
 "platform/spikes/openhands/*, design/ADR-M10.md",
 ["Run the Agent Server in a container; call REST from Node.js: start, status, stop, fetch logs",
  "Model points at LiteLLM with a virtual key",
  "Record the usable API, the pinned version and limitations in ADR-M10"],
 "Spike: the code may be thrown away; the result is the ADR")
t("C02","M-C","Run Contract: schema, signing, verification","M",["A04","B02"],"—",
 "platform/packages/contracts/run-contract*, migrations (runs, run_contracts, run_events)",
 ["Schema per D-03 section 8; signed via OpenBao Transit",
  "The runner rejects: expired, bad signature, not in the DB",
  "`run_events` is append-only"])
t("C03","M-C","LiteLLM adapter + Cost Controller (part 1)","M",["A04","A06"],"FR-50, FR-51",
 "platform/packages/adapters/model-litellm/*, platform/packages/core/cost/*, migration cost_records",
 ["LiteLLM gets provider keys from OpenBao through an OpenBao Agent sidecar (AppRole `litellm`, read-only kv/litellm/providers/*) rendered to tmpfs; no provider key in .env, the repo or an image on the server; rotation = re-render + restart (QUESTIONS #1)",
  "Create a virtual key per run: cost cap, model list, labels tenant/project/intent/run/gate/agent/data_class",
  "Revoke the key when the run ends",
  "Job syncing spend from LiteLLM → `cost_records` (no duplicates)",
  "Test: over budget → the request is blocked"],
 "LiteLLM requires a database (D-07)")
t("C04","M-C","Runner: provision and clean up sandboxes","L",["C02","B05"],"FR-30, FR-33","platform/apps/runner/*",
 ["One container per run on its own internal network; sandbox egress to LiteLLM and the package proxy only; GitHub is reached by the runner, never by the sandbox (QUESTIONS #52, ADR-M25)",
  "Clone with a short-lived GitHub token; create branch `agent/INT-...`",
  "Limit concurrent runs (default 1–2, configurable); extra runs wait in a queue",
  "The sandbox has no real model-provider key and no OpenBao access (test)",
  "Remove the container and worktree on success or failure"])
t("C05","M-C","OpenHands adapter","M",["C01","C04","C03"],"FR-31, FR-32","platform/packages/adapters/agent-openhands/*",
 ["Implement `AgentAdapter` (D-03 section 7.2) based on the C01 result",
  "Pass spec, plan and AGENTS.md to the agent",
  "Iteration and time caps; exceeded → stop, record `stop_reason`",
  "Collect changed files, logs and the last commit"])
t("C06","M-C","Automatic gate G4","M",["C05","C10","B07"],"FR-36",
 "platform/apps/worker (G4), platform/apps/runner (Temporal activity)",
 ["Checks: agent registered and active, pinned model, instructions hash matches; autonomy within max; contract valid; key capped; sandbox correct; AI record allows the data class",
  "Critical → `blocked`, the agent does not run (T10)",
  "High (L1) → the agent only submits a proposal, pushes no code; stored as evidence `proposal`, the run ends `succeeded_proposal_only` (T09); G4 is HITL for High",
  "Worker → runner handoff (QUESTIONS #53, #55; ADR-M25 §2.7): Temporal task queue `sdlc-runner`, one long-running activity per run with heartbeats; the runner worker's activity slots = `SDLC_RUNNER_MAX_SANDBOXES`, so extra runs wait in Temporal; a contract that expires while waiting → run `cancelled` (`contract_expired`) and a new attempt; a lost heartbeat → the workflow ends the run (test with a worker restart)"],
 "Moved from C04 session 3 (QUESTIONS #55): the runner process, slot pool, restart clean-up and sweep exist; C06 adds the Temporal side. Agent check: call `checkAgentForRun` (C10, ADR-M31 §2.6) with the SHA-256 of the agent's instructions file read at `base_sha` outside the sandbox, and pass its `modelRef` to the adapter (QUESTIONS #79); on the warning `recertification_overdue`, append the audit event `agent.recertification_overdue` and post a notice to the owner on the intent's issue (ADR-M31 §2.7). HOTL block window (B07, QUESTIONS #88, ADR-M30 §2.4b): never start a run while `hotlBlockWindowOpenUntil` (core) returns a time; the workflow wakes the intent when the last window closes")
t("C07","M-C","Gate G5: file scope + budget","M",["C06","C03","B11"],"FR-13, FR-52",
 "platform/apps/worker (G5), platform/packages/core/cost/*",
 ["Files changed outside the plan → stop, back to G3 (N1)",
  "Spend at 80% → warning comment; at 100% → stop and raise an escalation (N3)",
  "Owner decision `resume` with more budget → the run continues (bound, not expired)"],
 "Sandbox outputs are untrusted (ADR-M29 §2.5): recompute the changed files and `head_sha` from the pushed branch outside the sandbox before G5 relies on them; C06 session 2b built the pieces (`exportWorkspace`, `mirrorWorkspace`, `computeProposal` in the runner, ADR-M33 §2.9). A cost cap and an iteration cap both end as `stopped_budget`; tell them apart by `stop_reason` (`max_iterations`); both need a human decision to resume (QUESTIONS #21, #82). Decide whether uncommitted edits of a stopped run are kept as evidence")
t("C08","M-C","Open PR + gate G6 (CI)","M",["C07","B05"],"—",
 "platform/packages/adapters/git-github (PR, checks), platform/apps/worker (G6)",
 ["Open a PR from the agent branch, filling template T2 (intent_id, run_id, AI-written parts)",
  "Read CI status by polling (checks API); fail → rerun the agent within the retry limit; no retries left → back to G3 (N2)",
  "An agent push to `main` is blocked by branch protection (N6)"],
 "The runner, not the sandbox, pushes `agent/INT-...` (QUESTIONS #52, ADR-M25): update the D-03 §4 flow and diagram D11 (and the D-02 §5 flow) in this task. Sandbox outputs are untrusted (ADR-M29 §2.5): the changed files and `head_sha` are recomputed from the pushed branch outside the sandbox (reuse the runner's `exportWorkspace` and hardened git of C06, ADR-M33 §2.9). G5 (C07 PR 2, ADR-M34 §2.8–§2.9, QUESTIONS #134): a run after a G5 `resume` starts from the head of the default branch today; once the runner pushes `agent/INT-...`, the next run of the intent continues from that branch. Wait for the G5 HOTL block window before G6 acts (G5 is a passable gate)")
t("C09","M-C","Integration tests G4–G6 on the sample repo","M",["C08","R04","B10","C11"],"—","platform/tests/integration/*",
 ["T01 runs from G1 to G6 successfully","N1, N2, N3, N6 are blocked correctly","T09 only produces a proposal; T10 is refused",
  "Kill switch and loop detection work on a live run","Unregistered or suspended agent cannot run"])
t("C10","M-C","Agent register","S",["A06"],"FR-36",
 "platform/packages/core/agents/*, migration agents, platform/apps/cli",
 ["`agents` table (D-05); CLI to register, activate, suspend, quarantine, retire",
  "Runs refer to a registered agent; runs blocked for non-active agents",
  "Instructions hash stored and checked before each run",
  "Warning to the owner when the last recertification is older than 3 months"])
t("C11","M-C","Kill switch and loop detection","M",["C04","C05","C03","B11"],"FR-34, FR-35",
 "platform/apps/runner/*, platform/apps/cli, platform/apps/worker",
 ["`sdlc run kill <run>` and a comment command; allowed for Person A, Person B, governance",
  "Stops the sandbox, revokes the GitHub token and the LiteLLM virtual key; run ends `stopped_killed`; opens an escalation; under 5 minutes end to end (test)",
  "Loop detection: more than 3 identical consecutive tool calls, or no progress in the window → `stopped_stalled`"])
t("C12","M-C","Scheduled spend sync","S",["C03","C06"],"FR-51, FR-52, FR-53",
 "platform/apps/worker (schedule), platform/packages/core/cost/*",
 ["The worker calls `CostController.syncSpend` on a schedule (settings `SDLC_WORKER_COST_SYNC_*`: interval, look-back window) and once more shortly after each run ends, as ADR-M24 §2.5 says; nothing is double-counted (`ON CONFLICT (tenant_id, source_ref) DO NOTHING`)",
  "Calls LiteLLM writes to its spend log after a run ended are recorded; a run in progress shows its spend in `sdlc cost report` within one interval",
  "A failed or partial sync is logged with its reason counts and retried on the next pass; it never stops the worker or a run",
  "Tests: `pnpm test` (schedule, window, settings), `pnpm test:db` (late spend log rows recorded once, a running run's spend appears), `pnpm test:litellm` if the gateway path changes"],
 "Found by E04 (QUESTIONS #197, ADR-M45 §2.5): `syncSpend` runs only once, when a run ends (`endRunKey`), so late spend logs are lost and running runs show no cost. Needed for D-02 §10 item 6 (every model call has a cost), so E07 depends on it. Changes the worker: one runner/worker session at a time. E03 (ADR-M49 §4): a cost record synced while an intent waits at G8 changes its pack's release hash and voids its G8 approvals; keep late syncs of a run short after it ends, or exclude records synced after the merge from the release hash (decide in C12)")
t("E01","M-D","Gate G7: review + merge","M",["C08"],"FR-11, FR-16, FR-17",
 "platform/apps/worker (G7), PR review poller",
 ["G7 passes when the PR has valid approvals under branch protection, bound to the reviewed commit",
  "Producers and agents never count as approvers (FR-11)",
  "Dual approval (Person B + second approver) for flagged change types or Critical risk (N9)",
  "`request changes` → back to running the agent",
  "A person merges the PR (MVP: a human, not the platform); the platform records the merge event"],
 "Change flags (B09, ADR-M40 §2.2, QUESTIONS #166): read them from the plan G3 approved or passed (`plans.change_flags` of the plan whose hash G3 passed), never from a later plan; they are declared in the plan file and approved with it at G3")
t("E02","M-D","Evidence Builder + Markdown export","M",["E01"],"FR-40, FR-42, FR-43",
 "platform/packages/core/evidence/*, platform/packages/adapters/evidence-s3/*",
 ["Collects: spec + hash, plan, diff, CI/test/scan results, the 8 gate decisions with oversight modes, escalations, cost summary",
  "Includes the client AI disclosure note (`disclosure_note`) in the project's disclosure format",
  "Stored in SeaweedFS under a tenant prefix; manifest with a hash per item",
  "Exports one readable Markdown file (English by default, via the message catalog)"],
 "Builds on C06 session 2b (ADR-M33 §2.9): `EvidenceStore` (`@sdlc/contracts`), `S3EvidenceStore` and the table `evidence_items` exist; L1 proposals are at `s3://evidence/proposals/…`. Re-check the SHA-256 of every item when the pack is built (the runner's identity can delete under `proposals/`; versioning keeps the content). Packs need their own write identity and prefix; decide object lock with E05 (ADR-M33 §2.9 gap 1)")
t("E03","M-D","Gate G8: release approval, close the intent","S",["E02"],"FR-43",
 "platform/apps/worker (G8)",
 ["Person B approves G8 via CLI or comment (plus business/security owner for Critical); bound to the artifact digest",
  "G8 fails without the disclosure note",
  "Seal the Evidence Pack (`sealed_at`), close the intent, record metrics"],
 "Builds on E02 (ADR-M48, QUESTIONS #215, #217): call `buildEvidencePack` (core) with actor `system` and seal ONE version (`evidence_packs.sealed_at`; at most one sealed version per intent; no build after that; add the UPDATE grant on `sealed_at`); bind the G8 approval to that version's `content_sha256`. FR-43: the manifest's `disclosure`; decide whether G8 needs a person to confirm the client note when `client_text_required` is true (`client_format`). Open (ADR-M48 §2.2): how the worker builds the pack at G8 (its own SeaweedFS identity, or another way); the api process holds `api-evidence` today. Done in E03 (ADR-M49): G8 approvals are bound to `release_sha256` (the pack without the G8 parts); the worker builds the release pack with its own identity `worker-evidence`. MVP+1 (QUESTIONS #220, #222): a per-project `release.environment` and the non-production HOTL path at G8 (every G8 is production in the MVP); an explicit PM/BrSE confirmation of the client's own disclosure note")
t("E04","M-D","Cost report","S",["C03"],"FR-53","platform/apps/cli, platform/packages/core/cost/*",
 ["`sdlc cost report` by tenant / project / intent / time range",
  "Shows tokens in/out, cached tokens, cost, wasted tokens (failed runs)"])
t("E05","M-D","Retention jobs + audit anchoring","S",["E02","A07"],"FR-44",
 "platform/apps/worker (schedules)",
 ["Delete Evidence Pack files older than `evidence_retention_days` (default 180); skip held evidence (`evidence_holds`, QUESTIONS #235; `evidence_packs.retention_hold` is not used)",
  "Audit log, gate decisions and escalations kept at least 2 years (no deletion path in the MVP)",
  "Project archive → purge its evidence files and stored client material unless on hold; keep hashes; audit `project.purged`",
  "Daily: write each tenant's latest audit hash to SeaweedFS"],
 "Two PRs (ADR-M51, QUESTIONS #235–#239): PR 1 = object lock on the bucket `evidence` (GOVERNANCE, 180 days, the existing bucket; checked live on SeaweedFS 4.48), the purge identity `worker-purge`, the worker's `RetentionLoop` (`report` by default, the 180-day code minimum, the guard, a re-check under the intent lock, every version deleted, `purged_at` and `evidence.purged` in one transaction), holds (`sdlc admin evidence hold|release`, config `access.evidence_hold_roles`, rule M32), rule M31 (180 ≤ days ≤ 3650), the lock moved for longer retention, the orphan sweep under `packs/`, an archive refused with open intents and purged after `SDLC_WORKER_RETENTION_ARCHIVE_GRACE_DAYS` (7), `sdlc ops retention report` (AC1–AC3); PR 2 = the daily audit anchor in a COMPLIANCE bucket `audit-anchors` with its own identity and the mismatch check (AC4). Not in E05: deleting a project's Langfuse traces (manual runbook step, QUESTIONS #238, task E08); the unauthenticated SeaweedFS filer API that bypasses the lock (gap 5, QUESTIONS #239, task A12 before M-E); an un-archive command (open item, ADR-M51 §2.6)")
t("E06","M-D","Gate waiting-time metrics","S",["B07"],"FR-12","platform/apps/cli",
 ["`sdlc metrics gates`: average / maximum waiting time per gate, per project"])
t("E08","M-D","Purge a project's data from Langfuse","S",["E05"],"FR-44",
 "platform/apps/worker (retention), platform/deploy (Langfuse key in OpenBao), handbook/03-templates/T11-openbao-runbook.md",
 ["Spike on the pinned Langfuse v4 (`events_only`): how to delete a project's traces and observations by their `tenant:` and `project:` labels; record the result in an ADR (the legacy traces API answers 404 in this mode)",
  "The Langfuse project key lives in OpenBao, readable only by the process that purges (today only the otel-collector holds it, in `.env`)",
  "When E05 purges an archived project, its Langfuse data is deleted too; `project.purged` records `langfuse: purged` instead of `manual`; Langfuse data past `evidence_retention_days` is deleted the same way",
  "Live test in `pnpm test:observability`: a project's traces are gone after the purge, another project's traces stay"],
 "Found by E05 (QUESTIONS #238): LiteLLM's traces in Langfuse carry prompts and responses (client data, ADR-M35); OSS self-hosted Langfuse has no automatic retention. Until E08, `project.purged` says `langfuse: manual` and runbook T11 lists the manual steps")
t("E07","M-D","MVP definition-of-done check","M",["E03","E04","E05","C09","B13","C12","A12"],"D-02 section 10","platform/tests/integration/*, README",
 ["One intent goes through G1 → G8 on the sample repo","All criteria in D-02 section 10 (including 5b–5d) are met",
  "README explains a fresh deployment with Docker Compose",
  "QUESTIONS #81 is resolved: one real run with an API model has passed before M-F (the trial M-E runs with the local Ollama model, Harry 2026-10-06)"],
 "After the trial M-E: write the MVP+1 user interface scope (web UI, dashboard; D-02 §4.2) from the trial data (who needs which screen, read-only or actions, sign-in), for Harry's approval, before any interface task is added (Harry, 2026-10-04)")
t("U01","MVP+1","Read-only web dashboard","M",["B11","B13","E02","E04","E06"],"D-02 §4.2, NFR-08",
 "platform/apps/dashboard (or inside platform/apps/api), platform/apps/api (static files only), platform/tests/*, design/ADR-M54",
 ["Read-only: the dashboard uses only existing GET endpoints of the API; no new write path, no form that changes state; a static test fails if it calls anything but GET",
  "Sign-in with an existing personal API token (`sdlc_pat_…`); the same access rules as the API (404 without a role, 403 with another role); the token is never put in a URL, a log or long-lived browser storage; sign-out forgets it",
  "Served on the same origin as `sdlc-api` (127.0.0.1 in Compose); a strict Content-Security-Policy (no inline script, no third-party origin; every asset served by the platform); no new host port",
  "Screens: intents and gates (current gate, who it waits for, waiting time, links to the issue and pull request); open escalations (severity, route, owner role, acknowledge and resolve due times); cost report and gate waiting times per project (E04, E06); an intent's evidence packs and, for tenant admins, the audit check (E02, A07)",
  "Every label and message through the message catalog (NFR-08); server text shown as text, never as HTML; keyboard use and colour contrast checked",
  "Tests: unit tests of the data mapping; API tests that the dashboard needs no new endpoint; an end-to-end smoke test (Playwright) against a test API; screenshots at 375, 768, 1440 px"],
 "QUESTIONS #255 (Harry, 2026-10-07): in parallel with the trial M-E, which does not wait for it. ADR-M54 records the framework and the token handling (for example in memory only). Decisions stay in comments, reviews and the CLI; actions in a web UI and the full MVP+1 interface scope come from the trial data after M-E (E07 note)")
t("U02","MVP+1","The workflow's waiting reason in the API; one oversight resolution for notices","S",["U01"],"FR-22, NFR-08",
 "platform/packages/core (workflow, intents), platform/apps/api (intent presenter), platform/apps/dashboard, migrations (if needed), platform/tests/*",
 ["The intent body (`GET /v1/intents` and `GET /v1/intents/:intent`) gains `waiting_reason`: a code for why the intent waits at its current gate (for example a G4 check that failed and its cause, `plan_resubmit_needed`, `spec_unavailable`, `git_host_unavailable`, `evidence_unavailable`, frozen by an escalation, a HOTL block window), or null when it does not wait or the reason is unknown",
  "The reason is read from what the intent workflow recorded in the step's transaction (an existing record, or a new column the step writes under the intent lock and clears when the intent moves); the API never evaluates the gate's checks a second time",
  "Codes only, each with a catalog label (NFR-08); no free text, no client data; a new column, if any, is a migration with a D-05 update",
  "QUESTIONS #264: `plan-check.ts` and `spec-check.ts` resolve their notice audiences with the shared `resolveGateOversight`; a test shows that after a return from G5 the `plan_changed` notice names G3's HITL approvers. Gate decisions do not change",
  "The dashboard shows the reason next to `waiting_for` on the intents board and the intent detail",
  "Tests: `pnpm test:db` for each recorded reason and its clearing; `pnpm test:workflow` unchanged; the presenter checked against the shared zod schemas"],
 "QUESTIONS #265 (Harry, 2026-10-07), ADR-M54 §4: U01's `waiting_for` names who decides, not what holds the intent. The CLI's `sdlc intent show` may print the reason too. Uses QUESTIONS #265–#269; ADR only if the plan needs a new decision (next free number)")
t("U03","MVP+1","One CLI command creates an intent and links its spec","S",["B04","B08"],"FR-20, FR-02, NFR-08",
 "platform/apps/cli (intent create), platform/tests/cli/*, handbook Ch.19 §19.8c",
 ["`sdlc intent create … --spec <path> [--spec-commit <sha>] [--spec-tool <tool>]` creates the intent, then links the spec with the existing API calls (`POST /v1/intents`, then `POST /v1/intents/:intent/specs`); no new endpoint, no change of rules or access checks",
  "When the spec link is refused (for example `spec_not_on_default_branch` or no role in `access.spec_link_roles`), the intent stays created: the output names its code and the refusal, and says to run `sdlc spec link <INT>` again; exit code 1",
  "`--json` returns both results (the intent and the spec, or the refusal code); every label from the message catalog (NFR-08)",
  "Tests against a mocked API: both calls succeed; the link is refused; the create is refused (no link attempted)"],
 "Option B2 of `design/POSITIONING.md` §6.1 (Harry, 2026-10-07): fewer steps for a Low-risk task, after the trial M-E. The plan cannot join this command: its file `.sdlc/plans/<INT>.yaml` is named after the intent code, so it is written and merged after the intent exists. Uses QUESTIONS numbers only if needed (next free block)")
t("S01","Pre-M-E","Read the structure of BMAD / Spec Kit specs; G2 needs acceptance criteria","M",["B08"],"FR-02, D-02 §6.2 G2, NFR-08",
 "platform/packages/core (specs, workflow G2), migrations (if needed), platform/apps/cli (spec), platform/tests/*, handbook Ch.19 §19.8c, design/ADR-M61",
 ["Recognise the structure of a spec by its `source_tool`: `spec-kit` and `bmad` (the formats of pinned versions, named in ADR-M61) and `manual` (a heading for acceptance criteria, also the bilingual `受入基準 / Acceptance criteria` of D-09 §8); an unknown structure falls back to the `manual` rule",
  "When a spec is linked and when the step re-reads it at the head (B08), count its acceptance criteria; store counts and codes only, never the text (a new column of `spec_refs` is a migration with a D-05 update)",
  "G2 passes, HOTL or HITL, only when the linked spec has at least one acceptance criterion; otherwise a system `fail spec_unclear` once per spec version and a notice, and the intent waits at G2 (D-02 §6.2: \"Acceptance criteria present\")",
  "`sdlc spec link` and `sdlc spec list` show the tool and the count; labels from the message catalog",
  "Tests: fixtures of each pinned tool's output, the pilot's specs T01–T10 (all pass), a spec without criteria (G2 waits), a spec whose criteria were removed at the head (back to G2)"],
 "QUESTIONS #285 (Harry, 2026-10-08): before the trial M-E. QUESTIONS #290–#294, ADR-M61. A full conversion into the platform's own spec format stays MVP+1")
t("S02","Pre-M-E","`sdlc plan draft`: a plan file draft from Spec Kit tasks or BMAD stories","M",["S01","B09"],"FR-20, NFR-08",
 "platform/apps/cli (plan draft), platform/packages/core (plan schema reuse), platform/tests/cli/*, handbook Ch.19 §19.8c",
 ["`sdlc plan draft <INT> --from <path> --tool spec-kit|bmad [--output <file>]` reads the tool's task list (Spec Kit `tasks.md`, BMAD story files) from the local working tree and writes `.sdlc/plans/<INT>.yaml` in schema version 1 (template T13): one task per item, with its summary and dependencies",
  "The draft never guesses what a person must decide: `allowed_paths`, `tools` and `change_flags` stay marked for the person to fill, so the draft fails submission until they are filled; it never submits, commits or pushes (QUESTIONS #167)",
  "The draft passes `parsePlanFile` once the marked fields are filled; refused input (platform fields, `**`, `.github/`, `.sdlc/`, agent instruction files) is reported with the same codes as submission",
  "Tests with fixtures of the pinned tools' output (S01's versions); handbook Ch.19 usage"],
 "QUESTIONS #285 (Harry, 2026-10-08): before the trial M-E, lighter plan writing (`design/POSITIONING.md` §6.1). QUESTIONS #295–#299; ADR-M62 only if a new decision is needed")
t("K01","Pre-M-E","Spike: WeKnora on the pilot's documents (go / no-go)","S",["A02"],"D-01 §5.8b, NFR-01, NFR-04",
 "platform/spikes/weknora/* (thrown away), design/ADR-M59",
 ["Run a pinned WeKnora version self-hosted in a throw-away Compose project (never the dev stack), with its own agent, sandbox and memory features off; it calls models only through LiteLLM",
  "Load the pilot's fictional Japanese–English documents (D-09 specs T01–T10, README, AGENTS.md); ask at least 20 questions in Japanese and English and measure retrieval quality (the right passage in the top 5) and answer time",
  "Record resource use (RAM, CPU, disk), the licence and supply chain (images, dependencies, NFR-04), workspace isolation per tenant, and the MCP tools it offers with the ones an agent may use",
  "ADR-M59: the numbers, a go / no-go for K02 and, for go, the integration constraints (egress, tokens, data classes, what is recorded)"],
 "QUESTIONS #285 (Harry, 2026-10-08): before the trial M-E. No client data. QUESTIONS #300–#304, ADR-M59")
t("K02","MVP+1","Agents search the project's documents through WeKnora (MCP)","L",["K01","C04","C05"],"D-01 §5.8b, FR-31, FR-33",
 "platform/deploy (profile `knowledge`), platform/apps/runner (egress, MCP config), platform/packages/adapters/agent-openhands, platform/packages/core (run events), platform/tests/*, design/D-03 §9, design/ADR-M60",
 ["WeKnora runs in a Compose profile `knowledge`, pinned; one workspace per project; its own model calls go through LiteLLM with the seven labels",
  "A run reaches WeKnora only as a new sandbox egress service in `docker/guard.ts` (like LiteLLM and the package proxy), with a per-run read-only credential handed over as a single-use wrapping token; no long-lived key in the sandbox; only the project's workspace",
  "The agent gets only search and read tools over MCP; the data class rules apply (`client_restricted`: only when WeKnora and its model are self-hosted; `prohibited`: never)",
  "A run event records which documents the agent read: IDs and hashes, never text (context snapshot)",
  "D-03 §9 and §10 updated (sandbox egress); tests: the egress probe from a sandbox, a stub-model run that searches, another project's workspace refused"],
 "QUESTIONS #285 (Harry, 2026-10-08): only if ADR-M59 (K01) says go. **Deferred** (QUESTIONS #300, Harry 2026-10-08): K01 found WeKnora no better than a plain bge-m3 + cosine search on the pilot, slow LLM summaries, and a document reader image with 202 critical vulnerabilities and an AGPL-3.0 library; revisit at M-F when a project has Office or PDF documents outside its repository, with the limits of ADR-M59 §5. QUESTIONS #305–#309, ADR-M60. Code index and full context snapshots stay MVP+1")
# ---------- rendering ----------
IDX={x['id']:x for x in T}; W={'S':1,'M':2,'L':3}
@functools.lru_cache(None)
def lp(k):
    b=(0,[])
    for d in IDX[k]['deps']:
        c=lp(d)
        if c[0]>b[0]: b=c
    return (b[0]+W[IDX[k]['size']],b[1]+[k])
CP=" → ".join(max((lp(k) for k in IDX),key=lambda x:x[0])[1])
MS=[("M-A","Foundation: infrastructure, security, audit"),("M-B","Intent + G1–G3"),("M-0","Sample pilot repo (separate repo, right before M-C)"),("M-C","Run + G4–G6"),("M-D","G7–G8 + evidence + cost"),("Pre-M-E","Before the trial M-E: spec tools and document knowledge (QUESTIONS #285)"),("MVP+1","Started early: read-only dashboard (QUESTIONS #255); lighter steps")]
o=[];w=o.append
w(f"""# D-08. MVP backlog

| Item | Value |
|---|---|
| Version | 1.0 |
| Date | 2026-09-24 |
| Status | **Approved** (Harry, 2026-09-24) — version 1.0, aligned with the handbook (tag `design-v1.0`) |
| Readers | Tech lead, developers, Claude Code |
| Related documents | D-02 (FR/NFR), D-03 (architecture), D-05 (data), D-07 (tokens), D-09 (sample repo) |
| Attachment | [D-08-backlog.csv](D-08-backlog.csv) (for creating GitHub issues with `scripts/create-issues.py`) |

> Generated from a single data source. Edit the data, then regenerate this file and the CSV together.

---

## 1. Purpose

- Split the MVP into **small tasks, each fitting one Claude Code session**.
- Each task has: dependencies, related requirements (FR/NFR), code area, **acceptance criteria**.
- Serves as the list for GitHub issues and assignments.

## 2. Conventions

| Field | Meaning |
|---|---|
| ID | `A` = M-A, `B` = M-B, `R` = M-0 (sample repo), `C` = M-C, `E` = M-D (`E` avoids confusion with document codes `D-xx`), `U` = user interface (MVP+1, started early), `S` = spec tools and `K` = document knowledge (before the trial M-E) |
| Size | **S** ≈ 1 session · **M** ≈ 1–2 sessions · **L** ≈ split into 2–3 sessions. [Proposal] Relative estimate, not person-hours |
| Depends on | Tasks that must be finished first |
| Acceptance criteria | Conditions for the PR to be approved. Claude Code writes tests for them |

[Proposal] No dates or assignees here. Assignment and deadlines are decided by Harry.

---

## 3. Overview

""")
w("| Milestone | Content | Tasks | Sizes |\n|---|---|---|---|")
for m,d in MS:
    ts=[x for x in T if x['ms']==m]
    sz=" · ".join(f"{k}×{sum(1 for x in ts if x['size']==k)}" for k in "SML" if any(x['size']==k for x in ts))
    w(f"| {m} | {d} | {len(ts)} | {sz} |")
w(f"| **Total** | | **{len(T)}** | |\n")
w(f"""### Order and dependencies between milestones

```mermaid
flowchart LR
    MA["M-A Foundation"] --> MB["M-B Intent + G1–G3"]
    MB --> MC["M-C Run + G4–G6"]
    M0["M-0 Sample repo"] --> MC
    MC --> MD["M-D G7–G8 + evidence"]
    MD --> MP["Pre-M-E S01, S02, K01<br/>spec tools, WeKnora spike (K02 deferred)"]
    MP --> ME["M-E Trial"]
    ME --> MF["M-F Adjustment"]
    MD --> MU["MVP+1 U01 read-only dashboard<br/>(in parallel with M-E)"]
```

- M-0 lives in a **separate repo** (`pilot-order-inventory`). Done at the end of M-B, before C09.
- C01 (OpenHands PoC) can start early, right after A02, to reduce risk.

### Critical path (longest chain) [Proposal]

`{CP}`

- Computed from dependencies and task size (S=1, M=2, L=3). To finish sooner: prioritise tasks on this path and run the others in parallel.

---

## 4. Tasks
""")
for m,d in MS:
    w(f"\n### {m} — {d}\n")
    for x in [y for y in T if y['ms']==m]:
        deps=", ".join(x['deps']) if x['deps'] else "—"
        w(f"#### {x['id']}. {x['title']}\n")
        w(f"| Size | Depends on | Requirements | Code area |\n|---|---|---|---|\n| {x['size']} | {deps} | {x['fr']} | {x['area']} |\n")
        w("**Acceptance criteria**\n")
        for i,a in enumerate(x['ac'],1): w(f"- [ ] AC{i}: {a}")
        if x['note']: w(f"\n> Note: {x['note']}")
        w("")
w("""---

## 5. Handing tasks to Claude Code

### 5.1. Rules for each session [Proposal]

1. **One session = one task** (L tasks are split into 2–3 sessions).
2. Claude Code **reads the task and related docs**, then **proposes a plan**: files to change, tests to add. A human approves the plan before coding.
3. Only change files in the approved plan. Need more → stop and ask.
4. Run lint + tests. Open a PR using template T2, with the task ID (e.g. `A07`).
5. If a design doc is **missing or contradictory** → do not guess. Add the question to `design/QUESTIONS.md` and stop.
6. New technical decisions (library choice…) → write a short ADR in `design/`.

### 5.2. Session opening prompt

```text
Task: A07 — Append-only audit log + hash chain
Read: design/D-08 (task A07), design/D-05 section 7, CLAUDE.md.
Step 1: propose a plan (files to create/change, tests to write, risks). Do not code yet.
Step 2: after I approve, code + tests matching acceptance criteria AC1–AC4.
Step 3: run lint + tests, summarise the results, open a PR with the T2 template.
If a doc is missing or contradictory: add the question to design/QUESTIONS.md and stop.
```

### 5.3. Creating GitHub issues from the CSV

- `D-08-backlog.csv` columns: `id, milestone, title, size, depends_on, requirements, area, acceptance_criteria, note`.
- Use `scripts/create-issues.py` (see `platform/GETTING-STARTED.md`): creates milestones, labels and issues; supports `--dry-run`; never creates duplicates.

---

## 6. Risks

| Risk | Mitigation |
|---|---|
| A task is bigger than one session; Claude Code leaves it half done | Split as noted. Re-assess sizes after M-A |
| The OpenHands Agent Server does not behave as expected | Do C01 early. If it fails → reconsider the agent (the interface allows replacing it) |
| Gaps in the design docs | `design/QUESTIONS.md` + review after every milestone |
| Size estimates are wrong | Record actual time per task; adjust for the next milestone |

---

## Version history

| Version | Date | Author | Notes |
|---|---|---|---|
| 0.1 | 2026-09-24 | Claude (draft) | First version: 40 tasks, 5 milestones |
| 0.2 | 2026-09-24 | Claude (draft) | After review: SeaweedFS, Valkey, GitHub polling, G7 rule, M-D tasks renamed `E01…E07` |
| 1.0 | 2026-09-24 | Claude, approved by Harry | Handbook alignment: B01 oversight/approvers, B07 binding, new B11 escalation, B12 AI record, C10 agent register, C11 kill switch; E01 dual approval; E02/E03 disclosure; E05 retention; tests N7–N9 |
| 1.1 | 2026-09-25 | Claude, approved by Harry | C03: provider keys via an OpenBao Agent sidecar (QUESTIONS #1). A10: internal CA and TLS on OpenBao 8200, size S → M (QUESTIONS #20) |
| 1.2 | 2026-09-25 | Claude, approved by Harry | New task A11: stop publishing the OpenBao port on the host (QUESTIONS #27); A10 now depends on A11 |
| 1.3 | 2026-09-27 | Claude (task C04), approved by Harry | C04 AC1: sandbox egress to LiteLLM and the package proxy only, GitHub through the runner; C08 note: the runner pushes, update the D-03 §4 flow and D11 (QUESTIONS #52, #59, ADR-M25) |
| 1.4 | 2026-09-27 | Claude, approved by Harry | New task B13 (admin onboarding, B03 decision D1); E07 depends on B13 |
| 1.5 | 2026-09-27 | Claude (task C04), approved by Harry | C06 AC4: the `sdlc-runner` task queue and heartbeat activity move from C04 to C06; size S → M (QUESTIONS #55, ADR-M25 §2.7) |
| 1.6 | 2026-09-27 | Claude (task B11), approved by Harry | B11 AC3: clocks in the database, advanced by the worker (QUESTIONS #73, ADR-M28); B11 AC5 and B04 AC4: the escalation CLI moves to B04 (QUESTIONS #77) |
| 1.7 | 2026-09-27 | Claude (task C05), approved by Harry | C07 and C08 notes: sandbox outputs are untrusted, changed files and `head_sha` recomputed from the pushed branch outside the sandbox (ADR-M29 §2.5); C07: iteration cap vs cost cap by `stop_reason`, uncommitted edits of a stopped run (QUESTIONS #82) |
| 1.8 | 2026-09-27 | Claude (task C10), approved by Harry | E07 AC4: QUESTIONS #81 (a real run with an API model before M-E); B13 AC7: admin endpoints for the agent register with the Ch.20 approval rules; B13 AC8: stored configurations after a change of platform defaults (QUESTIONS #95); C06 note: the agent check and the recertification notice (ADR-M31) |
| 1.9 | 2026-09-27 | Claude (task B07, session 2), approved by Harry | C06 note: no run before the last HOTL block window closes (`hotlBlockWindowOpenUntil`; QUESTIONS #88, ADR-M30 §2.4b) |
| 1.10 | 2026-09-27 | Claude (task B12), approved by Harry | B04 AC5: `sdlc ai-record show|set` over the B12 API; B12 note: codes only, version history, write roles, API + operator command (QUESTIONS #103–#106, ADR-M32) |
| 1.11 | 2026-09-27 | Claude (task C06, session 2b), approved by Harry | C07, C08 notes: reuse the runner's workspace export and hardened git; E02 note: builds on `EvidenceStore` and `evidence_items`, re-checks hashes, own identity for packs; E05 note: object lock (per-bucket lock vs per-project retention and `retention_hold`) (ADR-M33 §2.9) |
| 1.12 | 2026-09-30 | Claude (task A08), approved by Harry | E05 note: project archive and retention also purge the project's Langfuse data (prompts and responses are client data; ADR-M35) |
| 1.13 | 2026-10-03 | Claude (task C07, PR 2), approved by Harry | C08 note: after a G5 `resume` the next run continues from the pushed `agent/INT-...` branch; wait for the G5 block window (QUESTIONS #134, ADR-M34 §2.9) |
| 1.14 | 2026-10-03 | Claude (task B09, PR 1), approved by Harry | B09 note: two PRs; E01 note: the change flags of the plan G3 approved (ADR-M40, QUESTIONS #165–#169) |
| 1.15 | 2026-10-04 | Claude, approved by Harry | New task C12: the scheduled spend sync of ADR-M24 §2.5, which was never built (QUESTIONS #197, ADR-M45); E07 depends on C12; E07 note: plan the MVP+1 user interface after M-E |
| 1.16 | 2026-10-04 | Claude (task E02), approved by Harry | E03 note: seal one version of the pack, the disclosure check, how the worker builds the pack (open); E05 note: purge the pack files of every version, keep the rows, sweep unreferenced files (ADR-M48, QUESTIONS #215–#217) |
| 1.17 | 2026-10-04 | Claude (task E03), approved by Harry | E03 note: done (release hash, `worker-evidence`), MVP+1 `release.environment` and the PM/BrSE disclosure confirmation; C12 note: late cost records void G8 approvals; E05 note: the worker identity, pack versions at G8 (ADR-M49, QUESTIONS #220–#222) |
| 1.18 | 2026-10-04 | Claude, approved by Harry | New tasks A12 (close the unauthenticated SeaweedFS filer and volume access, QUESTIONS #239; E07 depends on it) and E08 (purge the Langfuse data of a project, QUESTIONS #238), both found by E05 |
| 1.19 | 2026-10-04 | Claude (task E05, PR 1), approved by Harry | E05 AC1: holds per intent (`evidence_holds`); E05 note: two PRs, the lock, the purge, holds, archive grace, what is not in E05 (ADR-M51, QUESTIONS #235–#239) |
| 1.20 | 2026-10-06 | Claude, approved by Harry | A10 note: the runner VM or rootless Docker, ClickHouse access management (ADR-M25 §2.5, ADR-M53) |
| 1.21 | 2026-10-06 | Claude, approved by Harry | E07 AC4: the API-model run is needed before M-F, not before M-E; the trial M-E runs with the local Ollama model (QUESTIONS #81) |
| 1.22 | 2026-10-07 | Claude, approved by Harry | New milestone MVP+1 (started early) with task U01, a read-only web dashboard, in parallel with the trial M-E (QUESTIONS #255) |
| 1.23 | 2026-10-07 | Claude, approved by Harry | New task U02: the workflow's waiting reason in the API and one oversight resolution for the plan and spec notices (QUESTIONS #264, #265) |
| 1.24 | 2026-10-07 | Claude, approved by Harry | New task U03: one CLI command creates an intent and links its spec (`design/POSITIONING.md` §6.1, option B2) |
| 1.25 | 2026-10-08 | Claude, approved by Harry | New milestone Pre-M-E with tasks S01, S02 (BMAD / Spec Kit structure, plan drafts) and K01, K02 (WeKnora), before the trial M-E (QUESTIONS #285) |
| 1.28 | 2026-10-09 | Claude (task A10), approved by Harry | A10 note: ClickHouse access management done (`sdlc_admin`, ADR-M63 §6, QUESTIONS #330) |
| 1.27 | 2026-10-09 | Claude (task A10, PR 1), approved by Harry | A10 note: three PRs (TLS everywhere, backups and the drill, the server with the operator; ADR-M63, QUESTIONS #325–#327); code area `openbao/tls.sh` |
| 1.26 | 2026-10-08 | Claude, approved by Harry | K02 deferred to MVP+1, revisited at M-F (QUESTIONS #300, ADR-M59); S01, S02, K01 done |
| 0.3 | 2026-09-24 | Claude | Translated into English. User-facing messages via a message catalog (NFR-08). E02 adapter name fixed to `evidence-s3` (matches D-03). A06 includes `git_event_cursors` |
""")
open('design/D-08-mvp-backlog.md','w').write("\n".join(o))
with open('design/D-08-backlog.csv','w',newline='',encoding='utf-8') as f:
    c=csv.writer(f); c.writerow(['id','milestone','title','size','depends_on','requirements','area','acceptance_criteria','note'])
    for x in T: c.writerow([x['id'],x['ms'],x['title'],x['size'],";".join(x['deps']),x['fr'],x['area']," | ".join(x['ac']),x['note']])
print(CP)
