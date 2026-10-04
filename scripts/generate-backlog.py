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
 "platform/deploy/backup/*, platform/deploy/tls/*, handbook/03-templates/T11-openbao-runbook.md",
 ["Internal CA + TLS on OpenBao 8200 (QUESTIONS #20): script creates the CA (5 years) and the server certificate (1 year); the CA key is kept offline; renewal steps and a 30-day reminder in T11; clients verify the CA",
  "Backup script: OpenBao snapshot (Raft), PostgreSQL dump, to storage off the server",
  "Restore drill succeeds on a test machine; OpenBao unsealed with 2 shares",
  "Record RAM/CPU/disk usage for the core and observability profiles",
  "Runbook T11 written in full"],
 "Done together with the infrastructure operator")
t("A11","M-A","Stop publishing the OpenBao port on the host","S",["A04"],"—",
 "platform/deploy/docker-compose.yml, platform/deploy/.env.example, platform/deploy/README.md, platform/tests/integration/*, design/ADR-M19",
 ["The openbao service publishes no port on the host (QUESTIONS #27, option A); OPENBAO_HOST_PORT removed",
  "The live tests (compose-up, openbao bootstrap, secrets-client) reach OpenBao through a container on the Compose network",
  "The \"KNOWN GAP\" live test becomes: an AppRole login from the host is not possible (no listener on the host)",
  "A static test fails if any compose file publishes 8200 or 8210 again",
  "ADR-M19 §2.5 and the deploy README describe the real behaviour; runbook T11 shows `docker compose exec` for admin work"],
 "Small. Must be merged before A10 (TLS on the same listener)")
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
 "Found by E04 (QUESTIONS #197, ADR-M45 §2.5): `syncSpend` runs only once, when a run ends (`endRunKey`), so late spend logs are lost and running runs show no cost. Needed for D-02 §10 item 6 (every model call has a cost), so E07 depends on it. Changes the worker: one runner/worker session at a time")
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
 "Builds on E02 (ADR-M48, QUESTIONS #215, #217): call `buildEvidencePack` (core) with actor `system` and seal ONE version (`evidence_packs.sealed_at`; at most one sealed version per intent; no build after that; add the UPDATE grant on `sealed_at`); bind the G8 approval to that version's `content_sha256`. FR-43: the manifest's `disclosure`; decide whether G8 needs a person to confirm the client note when `client_text_required` is true (`client_format`). Open (ADR-M48 §2.2): how the worker builds the pack at G8 (its own SeaweedFS identity, or another way); the api process holds `api-evidence` today")
t("E04","M-D","Cost report","S",["C03"],"FR-53","platform/apps/cli, platform/packages/core/cost/*",
 ["`sdlc cost report` by tenant / project / intent / time range",
  "Shows tokens in/out, cached tokens, cost, wasted tokens (failed runs)"])
t("E05","M-D","Retention jobs + audit anchoring","S",["E02","A07"],"FR-44",
 "platform/apps/worker (schedules)",
 ["Delete Evidence Pack files older than `evidence_retention_days` (default 180); skip when `retention_hold`",
  "Audit log, gate decisions and escalations kept at least 2 years (no deletion path in the MVP)",
  "Project archive → purge its evidence files and stored client material unless on hold; keep hashes; audit `project.purged`",
  "Daily: write each tenant's latest audit hash to SeaweedFS"],
 "Object lock for evidence (ADR-M33 §2.9 gap 1, Harry's review of PR #112: not in C06): SeaweedFS can lock objects (COMPLIANCE, even the admin cannot delete a locked version), but only on a bucket created with lock enabled, and the lock period is set per bucket or per object, while retention is per project (`evidence_retention_days`) and `retention_hold` must be able to keep an object longer. Decide how they meet (for example a lock per object at write time equal to the project's retention, and legal hold for `retention_hold`) before the purge job deletes anything; the runner's proposal identity can delete under `proposals/` until then Langfuse holds client data: LiteLLM's traces carry prompts and responses (D-05 §2, D-07; ADR-M35 §2.5, §4). Project archive (FR-44) and retention must also purge the project's Langfuse data (traces tagged with its `tenant:` and `project:` labels). E02 (ADR-M48 §2.1, §2.7): `evidence_packs` holds one row per build; purge both files of every unsealed and sealed version past retention (they hold approver names), keep the rows and hashes, set `purged_at` (UPDATE grant on `retention_hold` and `purged_at`); also sweep pack files without a row (a build that failed after its upload). The api identity `api-evidence` can delete under `packs/` until object lock is decided")
t("E06","M-D","Gate waiting-time metrics","S",["B07"],"FR-12","platform/apps/cli",
 ["`sdlc metrics gates`: average / maximum waiting time per gate, per project"])
t("E07","M-D","MVP definition-of-done check","M",["E03","E04","E05","C09","B13","C12"],"D-02 section 10","platform/tests/integration/*, README",
 ["One intent goes through G1 → G8 on the sample repo","All criteria in D-02 section 10 (including 5b–5d) are met",
  "README explains a fresh deployment with Docker Compose",
  "QUESTIONS #81 is resolved: one real run with an API model has passed before the trial M-E"],
 "After the trial M-E: write the MVP+1 user interface scope (web UI, dashboard; D-02 §4.2) from the trial data (who needs which screen, read-only or actions, sign-in), for Harry's approval, before any interface task is added (Harry, 2026-10-04)")
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
MS=[("M-A","Foundation: infrastructure, security, audit"),("M-B","Intent + G1–G3"),("M-0","Sample pilot repo (separate repo, right before M-C)"),("M-C","Run + G4–G6"),("M-D","G7–G8 + evidence + cost")]
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
| ID | `A` = M-A, `B` = M-B, `R` = M-0 (sample repo), `C` = M-C, `E` = M-D (`E` avoids confusion with document codes `D-xx`) |
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
    MD --> ME["M-E Trial"]
    ME --> MF["M-F Adjustment"]
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
| 0.3 | 2026-09-24 | Claude | Translated into English. User-facing messages via a message catalog (NFR-08). E02 adapter name fixed to `evidence-s3` (matches D-03). A06 includes `git_event_cursors` |
""")
open('design/D-08-mvp-backlog.md','w').write("\n".join(o))
with open('design/D-08-backlog.csv','w',newline='',encoding='utf-8') as f:
    c=csv.writer(f); c.writerow(['id','milestone','title','size','depends_on','requirements','area','acceptance_criteria','note'])
    for x in T: c.writerow([x['id'],x['ms'],x['title'],x['size'],";".join(x['deps']),x['fr'],x['area']," | ".join(x['ac']),x['note']])
print(CP)
