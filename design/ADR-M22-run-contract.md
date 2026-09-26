# ADR-M22. Run Contract: schema, signed form, verification, run events

| Item | Value |
|---|---|
| Status | **Proposed** (task C02, PR for review) |
| Date | 2026-09-26 |
| Decided by | Harry (plan approved 2026-09-26; QUESTIONS #32–#34; changes: no `@` in run event values, clock skew setting) |
| Related | D-03 sections 6.5, 8, 8.1, 8.2 (version 1.3); D-05 sections 5, 6.4, 7, 9 (version 1.5); D-08 tasks C02, C04, C06, C11; ADR-M05, ADR-M09, ADR-M18, ADR-M19, ADR-M20, ADR-M21; handbook Ch.13 (G4), template T13; QUESTIONS #13, #22, #32–#34 |

## 1. Context

Task C02 defines the Run Contract of D-03 section 8: the signed permission for one agent run. The worker issues it after G4 (C06). The runner verifies it before it creates the sandbox (C04). C02 also creates the tables `runs`, `run_contracts` and `run_events` (D-05 section 6.4).

Points that D-03 and D-05 did not fix:

- The exact schema, and the exact bytes that are signed.
- How the runner rejects a contract, and in which order it checks.
- What happens to old contracts when the Transit key is rotated.
- How `run_events.payload` stays free of free text. `run_events` is append-only and kept as evidence, so data written there can never be erased (CLAUDE.md, "Current constraints").
- How long a contract is valid (QUESTIONS #33), and whether it lists tools (QUESTIONS #34).
- What `runs.agent_id` refers to before the agent register exists (QUESTIONS #32).

## 2. Decision

### 2.1. Schema (`@sdlc/contracts`, `run-contract.ts`)

| Field | Format | Source |
|---|---|---|
| `schema_version` | `1` | This ADR |
| `run_id`, `intent_id`, `tenant_id`, `project_id` | Lowercase UUID | The issuer generates `run_id` |
| `repo` | `owner/name` | `projects.repo_full_name` |
| `base_sha` | 40 hex characters | Caller (C06) |
| `branch` | `agent/INT-YYYY-NNNN` | The intent code (D-02 FR-30) |
| `plan_id`, `plan_sha256`, `planned_files` | UUID, SHA-256, 1–1000 paths or patterns | The intent's latest plan (G3) |
| `agent_id`, `agent_version`, `instructions_sha256` | UUID, version label, SHA-256 | Agent register (C10), passed by C06 |
| `allowed_tools` | Sorted, unique tool names (may be empty) | Agent's registered tools ∩ tools of the plan task (§2.6) |
| `autonomy_level` | `L1` or `L2` | Caller. L0 never runs an agent (FR-03); L3+ is not in the MVP |
| `max_budget_usd` | Decimal **string**, > 0, at most 6 decimals | Caller (intent budget, `budget.default_run_usd`) |
| `max_iterations`, `max_duration_min` | Positive integers | Caller (C05 adds the defaults, QUESTIONS #13) |
| `loop_threshold` | Positive integer | Config `run.loop_detection.identical_tool_calls_max` |
| `allowed_models` | Sorted, unique, at least one | `PolicyEngine.allowedModels` |
| `egress_allowlist` | Sorted, unique host names (optional `:port`) | Deployment settings (D-03 section 9) |
| `issued_at`, `expires_at` | ISO 8601 UTC with milliseconds | Issuer clock + config `run.contract_validity_minutes` |

- `validateRunContract` checks every field, refuses any extra field and requires `expires_at > issued_at`. It is hand-written: `@sdlc/contracts` has no runtime dependencies.
- Values are strings, integers and arrays only. There is no floating point (D-05 D6), so the canonical bytes do not change after a round trip through PostgreSQL `jsonb`.
- Lists used as sets must be sorted and unique, so the same set always gives the same bytes. The issuer sorts them.
- The envelope that the worker hands to the runner is `{ contract, signature }`, with nothing else.

### 2.2. Signed form and storage

- Signed bytes = the UTF-8 **RFC 8785 canonical JSON** of the contract, without the signature. This is the same `canonicalJson` module as the audit log and `config_hash` (ADR-M18).
- `contract_sha256` = SHA-256 of those bytes.
- The signature is raw Ed25519 (no prehash) by OpenBao Transit with the key `run-contract`. It uses the latest key version, through the `RunContractSigner` interface (A04). The key never leaves OpenBao. Core never imports `@sdlc/secrets`; the worker wires it in.
- `run_contracts` stores:
  - `contract_json`: the unsigned contract;
  - `contract_sha256`;
  - `signature`: the full `vault:v<N>:…` string;
  - `key_version`: taken from the signature prefix. The issuer checks that it equals the version Transit returned, and a CHECK keeps the two equal;
  - `issued_at` and `expires_at`: copied from the contract;
  - `revoked_at` (MVP+).

### 2.3. Issuing (worker)

`issueRunContract(scope, input, { signer, now })`:

1. Load the intent. It must not be `done`, `rejected`, `cancelled` or `blocked`.
2. The requested autonomy must not be above `intents.max_autonomy`. C06 still applies the stricter of the stored and the current value (QUESTIONS #22).
3. The plan must be the intent's latest plan.
4. Build the contract from the project, the plan, the configuration in force and the inputs, then validate it.
5. Sign the contract **before** the database transaction, so that no HTTP call runs while locks are held.
6. In **one transaction**, under the intent lock:
   - check again that the plan is still the latest;
   - number the attempt;
   - insert `runs` (`queued`) and `run_contracts`;
   - append the run event `contract_issued`;
   - append the audit event `run.contract_issued`.

   Everything is written, or nothing.

C02 does not check the agent register: the table comes with C10. **C06 (G4) must check that the agent is registered and active before it issues a contract** (QUESTIONS #32).

### 2.4. Verifying (runner)

`verifyRunContract(db, envelope, { verifier, now })` returns `ok` or a reject reason. It throws only when the check itself cannot run, for example when the database or OpenBao is down. The checks run in this order:

| # | Check | Reject reason |
|---|---|---|
| 1 | Envelope shape, schema, signature format | `malformed` |
| 2 | `verifier.verify(canonical bytes, signature)` with the key version named in the signature | `bad_signature` |
| 3 | A stored contract exists for this tenant and `run_id` | `unknown_contract` |
| 4 | Stored `contract_sha256`, `signature` and `key_version` equal the presented ones | `mismatch` |
| 5 | `now >= issued_at − run.contract_clock_skew_seconds` | `not_yet_valid` |
| 6 | `now < expires_at`, with **no tolerance** | `expired` |
| 7 | `revoked_at` is null | `revoked` |
| 8 | The run is still `queued` | `run_not_startable` |

- The signature is checked before the database, so a forged tenant ID never reaches it.
- Check 4 catches a correctly signed contract that differs from the one the platform stored.
- The clock skew applies only to check 5 (Harry, 2026-09-26). The default is 0 because the worker and the runner run on the same host.
- A decision about a **known** run is recorded:
  - an accepted contract writes the run event `contract_accepted`;
  - a refused contract writes the run event `contract_rejected` and the audit event `run.contract_rejected` (reason code only).
- For an unknown or badly signed contract nothing is written, because there is no trusted run to attach it to.
- Each reason has a catalog message (`run_contract.reject.*`, NFR-08).
- **Key rotation.** A signature always names its key version. The runner checks it with that version's public key: locally with cached public keys, or through Transit. Contracts signed before a rotation therefore stay valid until they expire. Contracts are short-lived, so no minimum key version is needed in the MVP. After a rotation, new contracts use the new version (live test).

### 2.5. Run events: coded payloads only

- `RUN_EVENT_TYPES` in `@sdlc/core` declares the fields of each event type, in the same way as `AUDIT_ACTIONS`. Field kinds:
  - `uuid`, `sha256`, `version`;
  - `count`: a non-negative integer;
  - `code`: letters, digits and `_ . : -`, at most 64 characters, no spaces, no `@`.
- Optional fields end with `?`. The repository refuses unknown types and missing, extra or badly formatted fields. The payload is at most 2048 bytes.
- C02 declares `contract_issued`, `contract_accepted` and `contract_rejected`. Later tasks add their own types (C04 `sandbox_created`, C07 `budget_warning`, and others), each with a test.
- **Database backstop, even against raw SQL:** the CHECK `run_event_payload_is_coded(payload)` accepts only:
  - a flat object with at most 32 keys and at most 2048 bytes;
  - `snake_case` keys;
  - values that are integers, booleans, or strings matching `^[A-Za-z0-9._:/-]{1,128}$`.

  There are no spaces, so sentences do not fit. There is **no `@`**, so e-mail addresses do not fit (Harry, 2026-09-26). If a field ever needs `@`, it gets its own check that refuses e-mail-shaped values.
- `run_events` is append-only: `forbid_mutation()` triggers for UPDATE, DELETE and TRUNCATE (every role, including the owner), and `SELECT, INSERT` only for `platform_app`.
- `event_type` is `snake_case` text, not an enum, so that later tasks do not need a migration for each new type. The code registry is the list.

### 2.6. Allowed tools (QUESTIONS #34)

- Handbook Ch.13 (G4) says the run may use "only the tools, files and environments in the task plan". The glossary and Ch.5 put tools in the run contract.
- `allowed_tools` is the **intersection** of the agent's tools in the register (C10) and the tools listed for the task in the plan (template T13). It is sorted and unique, and may be empty.
- C06 passes both lists. C02 computes the intersection (`allowedTools`).

### 2.7. Tables (migration `0004-runs`)

| Table | Rules |
|---|---|
| `runs` | The `id` comes from the issuer, so the contract can be signed first. `UNIQUE (tenant_id, intent_id, attempt)`. Composite foreign keys to `intents`, `plans` and `users` (`triggered_by`, `killed_by`). `platform_app` may UPDATE only `status`, `stop_reason`, `head_sha`, `started_at`, `finished_at`, `iterations`, `killed_by` and `updated_at`. The trigger `runs_final_status_is_final` refuses every change once the status is final (`SDA05` → `DbError('immutable')`), for every role. `stop_reason` is a code (`^[a-z][a-z0-9_]{0,63}$`), never free text. `killed_by` only with `stopped_killed`. Index `(tenant_id, status)` instead of D-05's `(status)`, because every query filters by tenant |
| `runs.agent_id` | `uuid NOT NULL` **without a foreign key** until C10 adds `(tenant_id, agent_id) → agents` (QUESTIONS #32) |
| `run_contracts` | Primary key `run_id`, foreign key `(tenant_id, run_id)`. `SELECT, INSERT` only: written once. It is **not** append-only in D-05 and has no `forbid_mutation()` trigger, so the E05 purge job (maintenance role, ADR-M09 §2.3) can still clear client paths (`planned_files`). CHECKs: signature format, `key_version` equal to the signature prefix, `run_id` and `tenant_id` equal to the JSON, `expires_at > issued_at`. `revoked_at` has no UPDATE grant yet (MVP+) |
| `run_events` | See §2.5 |

### 2.8. Where the rules live

| Rule | Source | Where |
|---|---|---|
| Contract validity, issue to sandbox start: 15 minutes; warning above 60 | QUESTIONS #33 ([Proposal] pilot default) | Config `run.contract_validity_minutes` |
| Clock skew for "not yet valid": 0 seconds | Harry, 2026-09-26 | Config `run.contract_clock_skew_seconds` |
| Loop threshold | D-02 FR-35; handbook Ch.3 §3.6 | Config `run.loop_detection.identical_tool_calls_max` |
| Budget, iteration and duration caps | D-02 FR-32; D-07 §6 | Inputs from the caller (C06), which reads the config |
| Allowed models | D-07 §4 | `PolicyEngine.allowedModels` (caller) |
| Allowed tools | Handbook Ch.13, T13 | Intersection (§2.6), inputs from C06 |
| Autonomy L1–L2 in a contract | D-02 FR-03, §4.2 | Schema |
| Expiry with no tolerance; reject order; coded payloads | This ADR | Code and CHECKs |

## 3. Consequences

- D-03 version 1.3 (§8: `schema_version`, plan fields and `allowed_tools`; signed form; checks). D-05 version 1.5 (§6.4: coded `run_events` payload, `stop_reason` code, `agent_id` without a foreign key until C10, run index).
- The default `config_hash` changes (two new `run.*` keys).
- C04 moves the run out of `queued` with one conditional update (`… WHERE status = 'queued'`, checking the affected row count) before it starts the sandbox, so one contract starts at most one sandbox (QUESTIONS #35). It then adds its run event types.
- C06 checks the agent register, the stricter autonomy (QUESTIONS #22), the AI record and the budget before it calls `issueRunContract`.
- C10 adds the `agents` foreign key on `runs.agent_id`.
- Revocation (`revoked_at`) and key rotation on a schedule stay MVP+ (D-03 §8).

## Version history

| Version | Date | Author | Notes |
|---|---|---|---|
| 0.1 | 2026-09-26 | Claude (task C02) | First version |
