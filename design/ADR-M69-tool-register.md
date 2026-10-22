# ADR-M69. Tools for agents: the tool register, MCP tools in a run, what is recorded

| Item | Value |
|---|---|
| Status | **Accepted** (repository owner, 2026-10-22: version 0.4, aligned with ADR-M87, with the D-03, D-05 and ADR-M80 changes; QUESTIONS #531 = b, #532 = a) |
| Date | 2026-10-21 |
| Decided by | The repository owner (X02 plan approved on 2026-10-21 with three choices: one tool container per run, the `tool:` prefix, one summary event per tool and run; QUESTIONS #516–#518) |
| Related | D-08 tasks X02, X04 (the first tool), X01, X03 (a second agent); D-02 FR-33, FR-36, NFR-03, NFR-05; D-01 §5.6 (MCP gateway); D-03 §8 (Run Contract), §9 (security); D-05 §5, §6.1, §6.4; D-07 §4 (data classes and models); ADR-M22 (contract), ADR-M25 (sandbox and egress), ADR-M29 (agent adapter), ADR-M31 (agent register), ADR-M33 (G4), ADR-M37 §2.8 (agent approvals), ADR-M40 (plan file and its tools), ADR-M42 (kill switch), ADR-M80 (threat model), ADR-M86 (evaluation fingerprints), ADR-M87 (the MCP gateway); design/QUESTIONS.md #361, #516–#520, #529–#532 |

## 1. Context

An agent run has three tools today: `file_editor`, `task_tracker` and `terminal` (`AGENT_TOOLS` in `@sdlc/contracts`). They are part of the agent itself (OpenHands) and work inside the sandbox only. The repository owner chose "tools for agents" as a direction of milestone EXT (QUESTIONS #361, 2026-10-10). The first tool is a read-only search of the project's documents (task X04).

A tool that is not part of the agent brings new risks:

- It can **read client data** (an index of the project's documents) and may need a **credential** to do so. The sandbox must never hold that credential (R028, R031, R034).
- It is **software from someone else**: an image, a version, a supply chain (ASI04).
- Its answers are **text an attacker may control** (a document in the repository), and the agent reads them (ASI01, ASI06).
- It must be **stoppable** with the run: the kill switch revokes everything within 5 minutes (FR-34, ADR-M42).
- Every use must be **recorded** without storing the query or the answer (R030, R031).

MCP (Model Context Protocol) is the common way for agents to call tools. OpenHands, Aider and OpenCode each support MCP in some form (to confirm per agent: §5, QUESTIONS #519). The platform uses MCP as the interface between the agent and a tool, so a tool works with any agent adapter that supports MCP (NFR-05).

This ADR is design only. X04 builds the register and the first tool.

## 2. Decision

### 2.1. Tool codes (D2, QUESTIONS #517)

- The three **built-in tools** keep their codes: `file_editor`, `task_tracker`, `terminal`. Nothing changes for them.
- A **register tool** has the code `tool:<tool_key>`, for example `tool:project-docs`. `tool_key` is `^[a-z][a-z0-9-]{1,62}$`, unique per tenant, never reused (like `agent_key`).
- Both kinds live in the same `text[]` columns that exist today: `agents.allowed_tools`, `plans.allowed_tools`, the contract's `allowed_tools`, `evaluation_configurations.allowed_tools`. The prefix tells them apart. No column changes type.
- The plan file lists them in `tools:` like today (ADR-M40), for example `tools: [file_editor, terminal, tool:project-docs]`.

### 2.2. The tool register (AC1)

A tool belongs to the **tenant**, like an agent (ADR-M31). New table `tools` (D-05 §6.1):

| Column | Meaning |
|---|---|
| `tool_key`, `version` | Identity and version label. Any change of the configuration is a new version |
| `status` | New enum `tool_status`: `proposed`, `active`, `suspended`, `quarantined`, `retired`, with the same moves as `agent_status` (ADR-M31 §2.3) |
| `owner_id` | Technical owner (a user of the tenant) |
| `transport` | `http` (MCP over Streamable HTTP, a container of its own: §2.4) or `stdio` (a process inside the sandbox: §2.5) |
| `image_ref`, `image_digest` | For `http`: the image name and its `sha256:` digest. Required; a tag alone is refused (R038) |
| `permissions` | Codes from a fixed catalogue in `@sdlc/contracts`. The first one is `read_documents` (X04). Each permission has fixed **call rules** in the same catalogue: the tool names it allows and the limits on their arguments, which the run's gateway enforces (§2.4; QUESTIONS #530). A new permission or a new rule needs an ADR. No rule comes from a tenant |
| `allowed_data_classes` | The `data_class` values the tool may see. Never `prohibited`. `client_restricted` only when the tool sends nothing outside the server (D-07 §4) |
| `backing_services` | `alias:port` entries the tool container may reach (§2.4), for example the index store. Empty for most tools |
| `model_ref` | Null, or the gateway model name the tool calls (for example an embedding model). It must follow the data class rules of D-07 §4 |
| `last_recertified_at`, `updated_at` | As for agents |

- Codes, IDs, hashes and dates only. No free text. Rows are **never deleted** (no DELETE grant); a retired tool stays as a tombstone.
- The configuration changes only while `proposed` or `suspended`, and only with a new `version` (as ADR-M31 §2.3). A new image digest is a new version.
- A CHECK refuses an `active` tool without an image digest (for `http`) or without a certification date.
- **Approval** (handbook Ch.20 applies to tools the same way as to agents): append-only table `tool_approvals`, the same shape as `agent_approvals` (ADR-M37 §2.8). Activation needs the **owner** and **Person B**, or **governance**. "Holds the role" means the same as for agents: on any active project of the tenant. One approval per person and per capacity in a round, so the approvers are different people.
- Recertification: project configuration `tools.recertification_months`, default 3, never more than 3 (the same rule as M18 for agents). An overdue tool gives a warning; it does not block a run.
- Commands: `sdlc admin tool register|update|activate|approve|suspend|quarantine|retire|owner|recertify|show|list`, through the API for tenant admins, like `sdlc admin agent …`.
- Audit events: `tool.registered`, `tool.updated`, `tool.status_changed`, `tool.owner_changed`, `tool.approval_recorded`, `tool.recertified`, `tool.recertification_overdue` (keys, versions, codes, hashes; never the image name, which may hold `/` or `@`).

### 2.3. When a run gets a tool (AC2)

A run gets a register tool **only when all of these allow it**:

1. The **plan** lists `tool:<key>` in the task's `tools` (ADR-M40).
2. The **agent** in the register lists `tool:<key>` in its `allowed_tools` (a change of that list is a new agent version, ADR-M31).
3. The **tool** is `active` in the register, and the intent's `data_class` is in its `allowed_data_classes`.
4. The **agent adapter** supports the tool's transport (`AgentAdapter` declares the transports it supports; §5).
5. The **Run Contract** names the tool, its version and its digest (§2.6), and the runner verifies the contract.

G4 checks 1–4 as a new step after check 6 (`checkAgentForRun`), with one function `checkToolsForRun`. Refusals, in this order:

| Code | When |
|---|---|
| `tool_not_found` | No tool with this key in the tenant |
| `tool_not_allowed_for_agent` | The plan lists the tool, but the agent does not |
| `tool_not_active` | The tool's status is not `active` |
| `tool_data_class_not_allowed` | The intent's data class is not in the tool's list |
| `tool_transport_not_supported` | The agent adapter does not support the tool's transport |

- G4 then records `fail` with the new reason code `tool_not_runnable` (`gate_reason_code`) and the exact code in the audit event, once per cause (as ADR-M33 §2.4).
- **Built-in tools keep today's rule**: the run gets the agent's tools among the plan's. A register tool is different on purpose: when the plan asks for it and the run cannot have it, G4 fails instead of dropping it, because the plan was approved with that tool.
- The tool's version is **not** pinned in the agent row. The run uses the tool's active version at G4, and the contract records it. The evaluation fingerprint `tools_sha256` (ADR-M86) hashes the tool codes only today. X04 extends it to each register tool's key, version and digest, so a new tool version makes an old evaluation "changed" for the agent's approval.

### 2.4. How an `http` tool runs (D1, QUESTIONS #516)

**One container per tool and per run.** Never one container shared by runs: a tool that reads documents reads client data, and a shared container would serve several projects and tenants at once.

- **Name and image.** `sdlc-tool-<run_id>-<tool_key>`, from `image_ref@image_digest`. The runner creates it through the Docker socket proxy and a new guard rule `assertSafeToolSpec` in `docker/guard.ts`: the same hardening as a sandbox (non-root user, read-only root, no capability, no privileged mode, no bind mount, memory, CPU and process limits, the run's labels), an allowlist of environment names (no secret values), and one fixed command from the image.
- **One gateway per run** (ADR-M87; QUESTIONS #529). A run with at least one register tool gets one MCP gateway container, `sdlc-gw-<run_id>`, from agentgateway, pinned by digest in project configuration `tools.gateway.image`. A run with no register tool gets no gateway. The sandbox reaches **every** register tool only through this gateway. The gateway checks each call: the per-run key, the tool name, the argument rules of the tool's permissions, and the cap `max_calls`. A new guard rule `assertSafeGatewaySpec` gives it the sandbox hardening, one fixed command, an allowlist of environment names and its configuration file only. Never a gateway of our own (D-01 §5.6).
- **The gateway's configuration** is **generated by the runner from the signed contract**, never written by hand: the targets (one per tool grant), the tool names and argument rules of each grant's permissions (CEL, from the catalogue in `@sdlc/contracts`), the caps, and the SHA-256 of the per-run key. Its stats port is off (`statsAddr: off`). The runner writes the file with the archive upload it already uses, before the gateway starts. A contract that the runner cannot turn into a gateway configuration is refused (§2.6).
- **Networks.**
  - The **run network** `sdlc-run-<run_id>` (ADR-M25 §2.2): the sandbox and the gateway, under the alias `tools`. No tool container is on the run network, so the sandbox cannot call a tool directly.
  - A **tool network** `sdlc-tool-<run_id>` (internal, no route out, no bridge address, like the run network): the gateway and the run's tool containers only.
  - A **service network** `sdlc-toolsvc-<run_id>-<tool_key>` (same settings) for each tool that has `backing_services`: that tool container and its backing services only. The gateway, the sandbox and the other tools are not on it, so only the tool reaches its index store (QUESTIONS #531).
  - A tool container never reaches the internet, OpenBao, Docker or LiteLLM's management API. If it calls a model (`model_ref`), LiteLLM is a backing service, and the tool uses its own capped virtual key with the run's labels (`agent` = `tool:<key>`); its cost counts for the run (R027).
- **The credential.** A tool that reads a backing service gets a **short-lived, read-only credential, scoped to the tenant and project**, with a time to live of at most the run's `max_duration_min`:
  - The worker issues it (the worker holds the issuer's admin credential, as it does for virtual keys) and hands it to the runner as a **single-use OpenBao wrapping token** through Temporal (R031).
  - The runner unwraps it and writes it into the tool container as a **file** before the container starts (never an environment value, R034), with the archive upload the runner already uses for sandboxes.
  - The sandbox never sees it. A wrapping token that OpenBao refuses goes to the `security` route, as for GitHub tokens (ADR-M42 §2.5).
- **The sandbox's access to the tools.** A random per-run key (32 bytes, like `SESSION_API_KEY`) goes to the agent's MCP configuration as a header. The **gateway** checks it: its configuration holds only the key's SHA-256, and a call without the key gets HTTP 401. The tool containers do not hold the key; only the gateway can reach them.
- **Order.** Volume → run network → tool network → service networks with their backing services attached → tool containers (credential files) → start the tools and wait until they are healthy → gateway container (configuration file) → start the gateway and wait until it is healthy → sandbox → start the sandbox. A failure at any step removes everything created so far, and the run fails with `provisioning_failed`, reason `tool_unavailable`.
- **Clean-up** removes the gateway, the tool containers, the service networks and the tool network with the sandbox, the run network and the volume (ADR-M25).
- **Sizing.** A tool container and the gateway (about 10 MiB, ADR-M87 §3.3) use memory and CPU while their run lives. Run slots stay the limit (`SDLC_RUNNER_MAX_SANDBOXES`); the container limits come from project configuration `tools.container_limits`. A10 measures the effect.

### 2.5. `stdio` tools

- A `stdio` tool is a program **inside the project's sandbox image**, started by the agent as a child process. Its version is pinned by the sandbox image's digest (config `sandbox.image`).
- It has **no credential and no backing service**: it sees only what the sandbox sees. A tool with a credential or a backing service is always `http`.
- The register row still exists (owner, version, permissions, data classes, approval), with no `image_digest`.
- None is planned now. X04 uses `http`.

### 2.6. The Run Contract (D-03 §8)

- `allowed_tools` keeps its meaning (the run's tool codes), and may now hold `tool:` codes.
- New field `tool_grants`: one entry per register tool, with `tool_key`, `tool_version`, `transport`, `image_digest`, `permissions`, `call_rules_sha256`, `backing_services` and `max_calls`.
  - `max_calls` is the gateway's cap for that tool in the run.
  - `call_rules_sha256` is the SHA-256 of the canonical call rules of the grant's permissions (RFC 8785), from the catalogue in `@sdlc/contracts`. The runner computes it again from its own catalogue and refuses a contract where it differs, so the run gets exactly the rules that were signed (QUESTIONS #530).
- `schema_version` becomes `3` (version `2` is the contract with `agent_adapter`, X03). The runner accepts versions 2 and 3. A version 2 contract has no register tools.
- The runner **refuses** a contract when a grant is not in `allowed_tools`, an `http` grant has no digest, a backing service is not one it can enforce (an unknown alias, a wrong port, an internet host), `call_rules_sha256` differs from its catalogue, or it cannot generate the gateway's configuration from the grants: `contract_rejected` with reason `tool_not_enforceable`. The runner never opens more than the contract asks for.

### 2.7. What is recorded (D3, QUESTIONS #518; AC3)

**One summary event per tool and per run**, not one event per call. A run can call a search tool many times, and `run_events` is append-only and kept for at least 2 years.

New run event types (D-05 §6.4), codes, IDs, hashes and counts only:

| Event | When | Payload |
|---|---|---|
| `tool_started` | The tool container is healthy | `tool_key`, `tool_version`, `image_digest` |
| `tool_used` | Once per tool at the end of the run, also after a kill or a failure | `tool_key`, `calls`, `failed_calls`, `refused_calls` |
| `tool_refused` | The first call refused by the gateway for a reason, once per reason | A code: `max_calls`, `tool_not_allowed`, `argument_refused` (with `tool_key`), or `key_refused` (no `tool_key`: the gateway refuses before it reads the tool) |
| `tool_failed` | The container stopped or became unhealthy during the run | `tool_key`, a code |
| `tool_credential_revoked`, `tool_credential_revoke_failed` | After the revocation at the end of the run or at a kill | `tool_key`, a code on failure |

- **Never recorded**: the query, the arguments, the answer, a document name or path, the credential, the per-run key.
- **Where the counts come from** (ADR-M87 §5). The gateway writes one JSON log line per request, with the MCP method, the target, the tool name, the status and a reason code, never arguments or answers. At the end of the run (also after a kill or a failure, before the gateway is removed) the runner reads these lines through the Docker logs endpoint it already uses and keeps only codes and counts: `calls` (calls that reached a tool), `refused_calls` (refused by the gateway), `failed_calls` (a tool error status). The gateway sits outside the sandbox, so these counts are better evidence than the agent's own events. The tool's own counts are not trusted.
- **No hash of the calls** (QUESTIONS #532). The gateway's logs hold no arguments or answers, so the runner cannot compute a hash of the calls outside the sandbox. A hash computed from the agent's event stream would come from inside the sandbox, which the agent controls. `tool_used` therefore has counts only.
- **Loop detection** still reads the agent's event stream (ADR-M42 §2.7). Repeated identical tool calls count like other tool calls.
- **Caps.** `max_calls` per tool and run, from project configuration `tools.max_calls_per_run` (default 100), enforced by the gateway. Calls over the cap are refused (`tool_refused`, `max_calls`); the run goes on without the tool. A call refused by tool name also uses one call of the cap (ADR-M87 §4).
- **The Evidence Pack** lists each tool the run used: key, version, digest and the counts of `tool_used`. It never holds answers.

### 2.8. Kill switch and the end of a run

- The worker revokes the run's tool credentials **at the kill signal**, with the virtual key (`revokeKilledRunKey`), and again when the run ends (`finishRun`, `abandonRun`). Revoking twice is harmless.
- The runner removes the **gateway first**: that cuts every tool of the run at once. Then it stops and removes the tool containers with the sandbox. A killed run therefore loses its tools within the same 5 minutes (FR-34).
- A tool container or a gateway never outlives its run. Gateways, tool containers, tool networks and service networks carry the same labels as sandboxes, so the runner's restart clean-up and orphan sweep (ADR-M25, `reconcileOnStart`, `sweepOrphans`) remove them too.

### 2.9. Where the rules live

| Rule | Where |
|---|---|
| Only active, approved tools with a pinned digest run; plan ∩ agent ∩ register ∩ contract; a sandbox never holds a tool credential; one container per tool and run; every call goes through the run's gateway; the gateway's configuration is generated from the contract; never record queries or answers | Code: safety invariants, not tuning values |
| The call rules of each permission | `@sdlc/contracts`, beside the permission catalogue; a new rule needs an ADR |
| The gateway image | Config `tools.gateway.image` (by digest) |
| Recertification age (at most 3 months) | Config `tools.recertification_months` |
| Calls per tool and run | Config `tools.max_calls_per_run` |
| Container limits of a tool | Config `tools.container_limits` |
| Who approves a tool | Code, from handbook Ch.20 (the same capacities as agents) |
| The permission catalogue | `@sdlc/contracts`; a new permission needs an ADR |

## 3. Changes in other documents (AC4)

Approved with this ADR (2026-10-22):

- **D-03 §8**: the contract fields `allowed_tools` (may hold `tool:` codes) and `tool_grants` (with `call_rules_sha256`); `schema_version` 3.
- **D-03 §9**: a new row "Tools for agents".
- **D-05 §5**: enums `tool_status` and the reason code `tool_not_runnable`. **D-05 §6.1**: tables `tools` and `tool_approvals`. **D-05 §6.4**: the run event types of §2.7.
- **ADR-M80**: a section on tools for ASI01, ASI02, ASI03, ASI04, ASI06 and ASI07, as ADR-M80 asks of the EXT tasks; the gateway is the call-level control for ASI02 (ADR-M87 §5).

Built later, not in this pull request: handbook Ch.20 (registering a tool) and Ch.19 (the plan's tools), with X04.

## 4. Alternatives not chosen

- **One tool service shared by all runs**, attached to each run network like LiteLLM. Rejected (QUESTIONS #516): it would hold the data of several projects and tenants at once, and one bad run could reach another run's answers.
- **Every tool as `stdio` inside the sandbox.** Rejected: the credential would be inside the sandbox, which an agent controls.
- **One run event per tool call.** Rejected (QUESTIONS #518): append-only rows kept for at least 2 years, for counts that a summary gives. The words of D-08 X02 AC3 ("a run event per tool use") are read as "per tool used by a run".
- **The tool's version pinned in the agent's row.** Rejected: every tool update would need a new agent version and new approvals. The contract and the evaluation fingerprint record the exact version instead.
- **No gateway: the register, G4 and the contract alone** (version 0.1 of this ADR). Replaced (QUESTIONS #520, #529): those decide which tools a run gets, but nothing checked each call. Task X14 compared self-hosted open-source MCP gateways (ADR-M87, accepted 2026-10-22); agentgateway, one instance per run, is used from X04 (§2.4).
- **One tool network for the gateway, the tools and their backing services** (ADR-M87 §5 as written). Not chosen (QUESTIONS #531): the gateway is someone else's software and would reach every index store of the run, and one tool would reach another tool's backing services.
- **A hash of the calls from the agent's event stream.** Not chosen (QUESTIONS #532): it comes from inside the sandbox, so it is not evidence.

## 5. Consequences and open items

- **Agent support for MCP (QUESTIONS #519).** The OpenHands adapter does not configure MCP servers today. X04 starts by confirming (and stops and asks if it cannot) that the OpenHands Agent Server takes a per-run MCP server over HTTP with a header key, and adds one entry to the adapter: the gateway at `http://tools:<port>/mcp` with the per-run key. X01 compares the MCP support of Aider and OpenCode. Until an adapter supports a transport, G4 refuses tools of that transport (`tool_transport_not_supported`).
- The guard gets two new rules (`assertSafeToolSpec`, `assertSafeGatewaySpec`), the runner a new provisioning step, the contract a new schema version.
- Each tool adds a container per run, and a run with tools adds one gateway: A10 measures memory and CPU with a tool and the gateway.
- One more third-party image to pin, scan and follow (agentgateway; R038, R089). X04 pins a release whose image scan passes.
- The gateway's argument rules read the JSON-RPC body (ADR-M87 §4). X04 tests them with batches, bodies over the buffer limit and bodies that do not parse: each is refused.
- A tool's answers are untrusted input for the agent, like the repository's files. The agent's limits do not change: the same tools, the same network, the same diff check at G5 and review at G7 (ADR-M80, the tools section).
- A tool that calls a model has its own virtual key and cost. Its data class rules are those of D-07 §4: `client_restricted` only with a self-hosted model.

## Version history

| Version | Date | Author | Notes |
|---|---|---|---|
| 0.1 | 2026-10-21 | Claude (task X02) | First version: tool codes, the register, G4 checks, one container per tool and run, contract v2, summary events, kill switch. QUESTIONS #516–#520 |
| 0.2 | 2026-10-22 | Claude (task X02) | Answers to QUESTIONS #519 (X04 checks MCP in OpenHands first) and #520 (task X14 researches an MCP gateway before X04, ADR-M87) |
| 0.3 | 2026-10-22 | Claude (task X14) | §4: reference to the result of X14 (ADR-M87, accepted). No change of meaning |
| 0.4 | 2026-10-22 | Claude (task X04) | Aligned with ADR-M87 §5: one agentgateway per run (§2.4), call rules per permission (§2.2), `call_rules_sha256` and `schema_version` 3 (§2.6), counts from the gateway's logs and no hash of the calls (§2.7), the gateway removed first at a kill (§2.8); a service network per tool (QUESTIONS #531, #532) |
| 1.0 | 2026-10-22 | Repository owner | Accepted (version 0.4), with D-03 1.44 and 1.46, D-05 1.54 and 1.56, ADR-M80 0.5 and 0.6; QUESTIONS #531 (a service network per tool) and #532 (counts only, no hash of the calls) |
