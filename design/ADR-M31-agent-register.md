# ADR-M31. Agent register: table, lifecycle, operator commands, the check before a run

| Item | Value |
|---|---|
| Status | **Proposed** (task C10, for review) |
| Date | 2026-09-27 |
| Decided by | Harry (plan approved 2026-09-27: D1 A, D2, D3 and D4 as recommended, with additions) |
| Related | D-02 FR-03, FR-36; D-03 sections 5.2, 8, 9, 12 (ADR-M15); D-05 sections 5, 6.1, 6.4; D-07 §4; D-08 tasks B13, C06, C09 AC5, C10, E07; handbook Ch.20, template T6; ADR-M18, ADR-M22, ADR-M26, ADR-M29; QUESTIONS #32, #65, #79, #93–#95 |

## 1. Context

D-02 FR-36 says a run starts only for an agent that is registered, active, with a pinned model version and an owner, and that the owner is warned when the last recertification is older than 3 months. ADR-M15 keeps a minimal register in the platform database. C02 created `runs.agent_id` without a foreign key until the register exists (QUESTIONS #32). C05 made the adapter refuse a model outside the contract's `allowed_models`, and C06 is to pass the register's pinned model (QUESTIONS #79).

Four points were open in the C10 plan:

- through which interface agents are registered and changed, when there is no user login on the direct-database CLI (B11 moved its CLI to B04 for this reason) and no tenant admin yet (QUESTIONS #65);
- what `model_ref` holds, when #79 needs it to be one of the gateway model names in `allowed_models`;
- which instructions file the hash pins, when an agent row belongs to a tenant and every project has its own `AGENTS.md`;
- how the recertification warning reaches the owner.

## 2. Decision

### 2.1. Table and enum (D-05 §6.1, migration `0008-agents`)

- New enum `agent_status`: `proposed`, `active`, `suspended`, `quarantined`, `retired` (`AGENT_STATUSES` in `@sdlc/contracts`).
- Table `agents` as D-05 §6.1. Every column is a code, an ID, a hash or a date: `agent_key` (unique per tenant), `version`, `model_ref`, `instructions_ref`, `instructions_sha256`, `allowed_tools`, `max_autonomy`, `approved_environments` (`sandbox`, `staging`, `production`), `last_recertified_at`, `owner_id` (composite foreign key to `users`). No free text.
- Rows are never deleted (no DELETE grant). A retired agent stays as a tombstone, so its `agent_key` is never reused (handbook Ch.20 §20.10 step 8).
- A CHECK refuses an `active` agent without a pinned model or a certification date.
- `runs (tenant_id, agent_id) → agents (tenant_id, id)`, `ON DELETE RESTRICT` (QUESTIONS #32). There were no production rows.
- `platform_app` may update the state, owner and configuration columns; never `agent_key` or `tenant_id`.

### 2.2. Operator commands on the server (D1 = A)

- `sdlc admin agent register|update|activate|suspend|quarantine|retire|owner|recertify|show|list`, like `sdlc admin token` (ADR-M26 §2.2): direct database access with `SDLC_DB_URL` (`platform_app`), run on the server. Audit events use `actor_type = system` with no actor ID.
- Agents belong to the tenant, not to a project, and project roles cannot authorise tenant-level work until B13 decides what a tenant admin is (QUESTIONS #65). So C10 adds **no** API endpoints. B13 adds the admin agent endpoints (backlog 1.8, B13 AC7).
- **Known gap, for B13:** the approval rules of handbook Ch.20 are not enforced by the platform yet: who approves an agent for use (§20.7: Person A + technical owner for L0; technical owner + Person B for L1–L2), who approves a change (§20.11), and that Person B or leadership may suspend or quarantine at any time (§20.9). In the MVP the operator records the result and the audit log shows it. B13 moves these commands behind the API with the approver's identity and role checks.

### 2.3. Lifecycle (handbook Ch.20 §20.3–§20.10)

| From | To |
|---|---|
| `proposed` | `active`, `retired` |
| `active` | `suspended`, `quarantined`, `retired` |
| `suspended` | `active`, `quarantined`, `retired` |
| `quarantined` | `suspended`, `retired` |
| `retired` | — (final) |

- A quarantined agent is never reactivated directly: it is reviewed as `suspended` first (§20.9 "review → reactivate or retire").
- Suspend, quarantine and retire need a reason code: `incident`, `quality`, `security`, `no_owner`, `replaced`, `unused`, `provider_end_of_support`, `other` (the triggers of §20.9–§20.10).
- **A change is a new version** (§20.9). The configuration (model, instructions, tools, maximum autonomy, environments) changes only while `proposed` or `suspended`, and only together with a new `version`. To change an active agent: suspend it, update it, activate it again.
- The owner may change in any status but `retired` (for example when the owner leaves, §20.8).
- The rules are checked in core (clear refusal codes) and again by the trigger `agents_changes` (SQLSTATE `SDA09` → `DbError('immutable')`).

### 2.4. `model_ref` is the gateway model name (D2, QUESTIONS #93)

- `model_ref` holds the LiteLLM gateway model name, the name that `ModelGateway.listModels` returns and `allowed_models` lists. The check before a run needs `model_ref ∈ allowed_models` (QUESTIONS #79).
- **Gateway model names include the model version**, for example `claude-haiku-4-5-20251001` or `gpt-oss-20b` (Harry, 2026-09-27). The register refuses a name without a digit, and any name with `latest`.
- The provider's exact model stays pinned in the gateway entry of that name. **Changing the model behind a gateway name counts as a new agent version** (Ch.20 §20.9: a new model version is a change): the operator suspends the agent, registers a new version and activates it again after evaluation.

### 2.5. Instructions hash of the repository's file (D3, QUESTIONS #94)

- `instructions_ref` = `<path in the repository>@<label>`, for example `AGENTS.md@v5` (handbook Ch.20 §20.5, template T6). The path is relative, without `.`, `..` or empty parts.
- Before each run, C06 reads that file at the run's `base_sha` through `GitHostAdapter.getFileAtCommit` (outside the sandbox), hashes it with `instructionsSha256`, and the check compares the hash with `instructions_sha256`.
- **Every edit of `AGENTS.md` in the repository makes runs fail with `instructions_mismatch` until the agent gets a new version** with the new hash. This is on purpose: a change is a new version (Ch.20 §20.9).
- In the MVP an agent row pins one file. A second project with a different `AGENTS.md` fails closed and needs its own agent entry. A per-project pin (a child table) is MVP+1.

### 2.6. The check before a run (FR-36, for C06)

`checkAgentForRun(scope, { agentId, projectId, autonomyLevel, allowedModels, instructionsSha256, now })` in `@sdlc/core`. Refusals, in this order, as `AgentRegisterError` codes:

| Code | When |
|---|---|
| `agent_not_found` | No agent with this ID in the tenant |
| `agent_not_active` | Status is not `active` |
| `autonomy_above_agent` | The run's autonomy is above the agent's `max_autonomy` |
| `environment_not_approved` | `sandbox` is not in `approved_environments` |
| `model_not_pinned` | No `model_ref` (a CHECK already prevents it for active agents) |
| `model_not_allowed` | `model_ref` is not in `allowedModels` |
| `instructions_mismatch` | The hash differs from `instructions_sha256` |

- On success it returns the agent for `issueRunContract` (ID, version, instructions hash, tools) plus `modelRef` (the run's model, #79) and `ownerId`, and the warnings.
- `instructionsPath(agent)` gives the path to read.

### 2.7. Recertification warning (D4)

- The age limit is project configuration `agents.recertification_months`, default 3 (handbook Ch.20 §20.8). New mandatory rule **M18**: never more than 3; a project may lower it.
- `checkAgentForRun` returns the warning `recertification_overdue` when the day is after `last_recertified_at` + the configured months (calendar months, clamped to the end of the month). **The run is not blocked** (FR-36 says "warning").
- C06 turns the warning into the audit event `agent.recertification_overdue` (declared in C10, with the run ID) and a notice to the owner on the intent's issue (backlog 1.8, C06 note). No worker loop in C10.
- `sdlc admin agent list` shows the due day and an `OVERDUE` flag; `--overdue` lists only overdue active agents.
- **Our interpretation (Harry, 2026-09-27):** the first activation of an agent without a certification date sets `last_recertified_at` to that day, and appends `agent.recertified`. Evaluation and approval before activation (§20.6–§20.7) count as the first certification.

### 2.8. Audit events

`agent.registered`, `agent.updated` (key, version, instructions hash), `agent.status_changed` (key, from, to, optional reason code), `agent.owner_changed`, `agent.recertified` (key), `agent.recertification_overdue` (key, optional run ID). Never the model name (it may hold `/` or `@`) and never the owner.

### 2.9. Where the rules live

| Rule | Source | Where |
|---|---|---|
| Recertify every 3 months | Ch.20 §20.8 | Config `agents.recertification_months`; M18 keeps it at 3 or less |
| Only registered, active agents run | D-02 FR-36 | Code: a safety invariant, not a tuning value |
| Status moves | Ch.20 §20.3–§20.10 | Code and trigger |
| Agent autonomy at most L2 in the MVP | D-02 FR-03 | Code (`MVP_MAX_AUTONOMY`, rule M7) |
| Approvers by agent type; who may suspend | Ch.20 §20.7, §20.9, §20.11 | Not enforced yet (§2.2, B13) |

## 3. Alternatives considered

| Alternative | Why not |
|---|---|
| Admin API endpoints now (D1 B or C) | Needs a tenant-admin rule first, which is B13's decision (QUESTIONS #65) |
| `model_ref` = provider model ID (`provider/model@version`) | Cannot be compared with `allowed_models`, which lists gateway names (#79) |
| A per-project instructions table now | Changes D-05 more; one pilot project in the MVP. Fails closed without it |
| A worker loop that posts recertification notices | More code in `apps/worker`, next to B07's area; C06 already sees the agent before each run |

## 4. Consequences

- D-05 version 1.11: §5 `agent_status`; §6.1 `agents` as built; §6.4 the foreign key on `runs.agent_id`.
- `@sdlc/config`: new key `agents.recertification_months`, rule M18; the default `config_hash` changes. Note for B13: adding a default changes the effective `config_hash` of every stored configuration (QUESTIONS #95).
- Backlog 1.8: B13 AC7 (admin agent endpoints, Ch.20 approval rules), C06 note (recertification notice), E07 AC4 (QUESTIONS #81).
- Tests that create runs register an agent first (`platform/tests/integration/agent-seed.ts`).

## Version history

| Version | Date | Author | Notes |
|---|---|---|---|
| 0.1 | 2026-09-27 | Claude (task C10) | First version |
