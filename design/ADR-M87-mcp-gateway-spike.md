# ADR-M87. An open-source MCP gateway in front of a run's tools: result of the X14 spike

| Item | Value |
|---|---|
| Status | **Accepted** (repository owner, 2026-10-22: agentgateway from X04, and argument rules per permission; QUESTIONS #529–#530) |
| Date | 2026-10-22 |
| Decided by | The repository owner (X14 plan approved on 2026-10-22: three gateways, one instance per run inside the run's networks, a stub tool, no product code) |
| Related | D-08 tasks X14, X04, X02; D-02 NFR-03, NFR-04, NFR-05; D-01 §5.4 (policy engine), §5.6 (MCP gateway); ADR-M25 §2.2 (run networks), §2.4 (sandbox hardening); ADR-M69 (tool register, proposed); ADR-M80 (threat model); design/QUESTIONS.md #516–#520, #529–#530 |
| Spike code | `platform/spikes/mcp-gateway/` (may be thrown away; numbers in `results/`) |

## 1. Context

ADR-M69 (proposed) runs each register tool in its own container per run. The register, G4 and the signed Run Contract decide which tools a run gets. Nothing checks each **call**: which tool, with which arguments, how many times. D-01 §5.6 says to use a self-hosted open-source MCP gateway for this, connected to the policy engine, and never to write our own. The repository owner asked for research before X04 builds the first tool (QUESTIONS #520).

The spike answers four questions (D-08 X14):

1. Licence, maintenance, image size, vulnerabilities, and whether **one instance per run** fits inside the run's networks of ADR-M69 §2.4. (AC1)
2. **Call-level policy**: allow or refuse a call by tool name and by argument rules, a per-run key, a call cap, refusals as codes, and no query or answer in the gateway's logs (R031). (AC2)
3. What the gateway **records**, how the runner could read counts from it, and its **memory and CPU** per run. (AC3)
4. A gateway from the first tool (X04), later, or not at all, with the changes to ADR-M69. (AC4)

## 2. Method

- **Candidates** (pinned by version and digest, `platform/spikes/mcp-gateway/`):

| Gateway | Version | Image |
|---|---|---|
| agentgateway (Linux Foundation; Rust) | 1.6.0 (latest stable, 2026-10-02) | `cr.agentgateway.dev/agentgateway@sha256:9d3e6044…2ed90c` |
| IBM ContextForge (`mcp-context-forge`; Python) | 1.1.0 (latest, 2026-10-20) | `ghcr.io/ibm/mcp-context-forge@sha256:7eb21fb9…cff1c` |
| Docker MCP Gateway (Go) | 0.44.1 (2026-09-23; every release is a pre-release) | `docker/mcp-gateway@sha256:b0a3876f…bb16` |

- **Compared on paper only**: Microsoft MCP Gateway (MIT) runs only on Kubernetes, which the target host does not have (the deployment is Docker Compose, `platform/deploy/`). LiteLLM's MCP gateway is already in the stack, but it is one shared instance for all runs, which QUESTIONS #516 refuses for client data.
- **Layout** (`run.sh`), the layout of ADR-M69 §2.4 with a gateway added:
  - run network `x14-run-<id>`: the client (a stand-in for the sandbox) and the gateway (alias `gateway`);
  - tool network `x14-tool-<id>`: the gateway and the tool (alias `tool`);
  - both networks `internal`, with `com.docker.network.bridge.inhibit_ipv4=true` (ADR-M25 §2.2);
  - every container with the sandbox hardening: read-only root, `--cap-drop ALL`, `no-new-privileges`, a process limit, a memory and CPU limit, a non-root user. No Docker socket in any container.
- **The tool** (`tool/server.mjs`): a stub MCP server over Streamable HTTP with two tools, `search_docs(query, limit)` and `delete_docs(id)`. Every answer holds an answer canary; every query holds a query canary. `GET /stats` counts the calls that reached it.
- **The policy under test**, the same for each gateway: only `search_docs`; `limit` at most 20; a random per-run key (32 bytes); at most 5 tool calls per run.
- **Scenarios** (`client/client.mjs`): no key, a wrong key, `initialize`, `tools/list`, an allowed call, a refused tool, a refused argument, calls up to and past the cap, and a direct call to the tool from the run network. Then 2,000 sequential allowed calls (`X14_LOAD`) for latency, CPU time (Docker stats API, before and after) and peak memory.
- **Logs**: the whole gateway log, and for agentgateway its metrics, are searched for the query canary, the answer canary and the per-run key.
- **Trivy** 0.74.0 (the CI's version), HIGH and CRITICAL, vulnerabilities and licences (`scan.sh`).
- Docker Desktop 29.9.2 on macOS (arm64). Numbers are from one machine; A10 measures on the server.

## 3. Results

### 3.1. Fit (AC1)

| | agentgateway 1.6.0 | ContextForge 1.1.0 | Docker MCP Gateway 0.44.1 |
|---|---|---|---|
| Licence | Apache-2.0 | Apache-2.0 | MIT |
| Maintenance | Linux Foundation project; monthly stable releases; 1.x | IBM; releases every 1–3 weeks | Docker; 0.x, every release marked pre-release |
| Image size | 146 MB | 590 MB | 139 MB |
| Trivy HIGH / CRITICAL | 1 HIGH (`ca-certificates-bundle`, fixed in `-r3`) | 1 CRITICAL (`certifi`, GHSA-6q48-6c7w-9gw2, the one already accepted for `node24`) | 42 HIGH, 1 CRITICAL in Go modules (41 have a fix) |
| Trivy licence findings | 3 (glibc, LGPL) | 51 (OS and Python packages, GPL/LGPL) | 10 (GPL) |
| Runs hardened (read-only, no capability, non-root) | Yes, nothing writable | Yes, with a `tmpfs` for `/tmp` (SQLite) and `/app/logs` | Yes, with a `tmpfs` for `/tmp` |
| Needs a database or cache | No | SQLite (in `tmpfs`) at least; Redis only for shared limits | No |
| Configuration | One static YAML file, read at start | An admin API **after** start: log in, register the tool, create a virtual server, create a token | A catalog file and flags |
| One instance per run in the run networks | **Yes** | Yes, but the bootstrap needs HTTP calls on the run network (the runner has no network path to a run, ADR-M25) and the admin API listens on the port the sandbox reaches | Yes, without the Docker socket, only for a `remote` server; plain `http` needs `DOCKER_MCP_ALLOW_INSECURE_REMOTE_URLS=1`. Its usual mode starts tool containers through the Docker socket, which a run must never have |
| Time to answer | 0.4 s | 7.5 s | 0.4 s |
| Idle memory | 8 MiB | 460 MiB | 12 MiB |

All three keep the tool out of the sandbox's reach: from the run network, `tool:8080` does not resolve.

### 3.2. Call-level policy (AC2)

| Check | agentgateway | ContextForge | Docker MCP Gateway |
|---|---|---|---|
| Per-run key: none or wrong | 401 | 401 | 401 |
| Where the key lives | The config file holds `sha256:` of the key only (`apiKey.keys[].keyHash`) | A token that ContextForge signs and stores, scoped to one virtual server; its signing secrets come from environment values | `MCP_GATEWAY_AUTH_TOKEN`, an environment value only |
| Tool not allowed | Not listed; a call gets `-32602` "Unknown tool" (`mcpAuthorization`, CEL) | Not listed (the virtual server has only the allowed tool); a call gets `isError` | Not listed (`--tools`); a call gets `-32602` |
| Argument rule (`limit <= 20`) | **Refused, 403**: an HTTP `authorization` rule in CEL on the JSON-RPC body. A batch, a body over the buffer limit or one that does not parse fails the rule, so it is refused | **Not refused**. SchemaGuard checks only types and required fields; value rules need the OPA or Cedar engine (another container) or a plugin of our own | **Not refused**. Only "interceptors" that run a program per call: code of our own |
| Call cap of 5 | **Refused after 5** (a conditional local rate limit on `mcp.methodName == "tools/call"`, a bucket that never refills). A call refused by tool name also uses one | Refused after 5 per **hour** (rate limiter, units `s`, `m`, `h` only): not a cap per run | **No cap** |
| What reached the tool | 4 allowed calls, 0 of `delete_docs` | 5 allowed calls, 0 of `delete_docs` | 9 calls, 0 of `delete_docs` |
| Query, answer or key in logs | None | None | None |
| Refusals as codes | Yes: `reason` `APIKeyAuth`, `RateLimit`, `MCP`; HTTP status | Partly: log messages in words | Partly: log messages in words |

Two more ContextForge findings:

- **A policy plugin that does not load is skipped, and the gateway serves without it.** With an invalid cap (`5/d`), the rate limiter failed to load and every call went through, although `fail_on_plugin_error: true` was set.
- It has its own HTTP rate limit (about 100 calls a minute per user) that is on by default: in the load test, 1,906 of 2,000 calls got 429.

### 3.3. What is recorded, cost per run (AC3)

| | agentgateway | ContextForge | Docker MCP Gateway |
|---|---|---|---|
| Per-call record | One JSON log line per request: MCP method, target, tool name, status, reason, duration. Never arguments or results | About 70 log lines per call: tool name, argument **names**, header names, the user's e-mail | About 3 lines per call: tool name, "object with N field(s)" |
| Counters | Prometheus on a stats port: `agentgateway_mcp_requests_total` by method and tool | In its database, through its admin API | None |
| How the runner reads counts | The container's logs through the Docker logs endpoint, which the runner's Docker client already allows (`GET /containers/{name}/logs`) | Its admin API: needs a network path or `exec`, which the runner does not have | The container's logs |
| 2,000 calls: p50 / p95 | 0.5 ms / 2.4 ms | 9 ms / 21 ms (and 1,906 refused with 429) | 0.6 ms / 1.4 ms |
| CPU time for 2,000 calls | 0.5 s | 17.5 s | 0.9 s |
| Peak memory | 11 MiB | 500 MiB | 15 MiB |

The agentgateway stats port answers on every address of the container, so the **sandbox can read the counters** too. They hold counts and tool names only, but the product turns the port off (`statsAddr: off`) and reads the logs.

## 4. Decision

**Use agentgateway as a per-run MCP gateway from the first tool (X04)** (QUESTIONS #529, accepted).

**A tool's argument rules are fixed rules per permission in `@sdlc/contracts`** (QUESTIONS #530, option a). The runner turns them into the gateway's rules; no expression from a tenant ever runs, and a new rule needs an ADR, like a new permission. X04 adds the rules of `read_documents`. Never a gateway of our own (D-01 §5.6).

Why:

- It is the only candidate that passed all of AC2 with its own features: the per-run key, tool names, argument rules, a cap per run, refusals as codes, and nothing secret in its logs.
- It fits the run's hardening with nothing writable, no database and a static file. The runner can write that file with the archive upload it already uses, and read the results through the Docker logs endpoint it already has.
- One instance per run costs about 10 MiB and well under a millisecond per call.
- It sits **outside the sandbox**. Its counts are better evidence than the agent's event stream, which comes from inside the sandbox (ADR-M69 §2.7).
- Apache-2.0, a Linux Foundation project with stable 1.x releases.

ContextForge is not chosen: no argument rules without another engine, a cap per hour only, a plugin that fails open, configuration through an admin API that the sandbox can reach, 460 MiB and 7.5 s per run. The Docker MCP Gateway is not chosen: no argument rules and no cap, pre-release only, 42 HIGH findings, the key only as an environment value.

Limits to keep in mind:

- In 1.6.0 the MCP authorization context holds the tool's target and name only, not its arguments. Argument rules use the HTTP `authorization` rule on the JSON-RPC body. A tool's rules must be written for that, and tested in X04 with batches and large bodies.
- A call refused by tool name uses one call of the cap. For X04 this is acceptable: an agent that calls a tool it does not have reaches the cap sooner.
- The image has one HIGH finding with a fix. X04 pins a release where the image scan passes, as for every image we depend on (R038, R089).
- The gateway checks calls; it does not replace the register, G4 or the contract. Those still decide which tools a run gets. The gateway's configuration is **generated from the contract**, never written by hand.

## 5. Changes this implies for ADR-M69 (for X04, after the decision)

- **§2.4, layout.** One gateway container per run, `sdlc-gw-<run_id>`, from a pinned image (project configuration `tools.gateway.image`, by digest). It is on the run network under the alias `tools`, and on the tool network. A tool container is **only on the tool network**: the sandbox reaches tools only through the gateway. New guard rule `assertSafeGatewaySpec` (the sandbox hardening, one command, no environment values except an allowlist, the configuration file only).
- **§2.4, the per-run key.** The gateway checks the key, not each tool. Its configuration holds only the key's SHA-256. The key goes to the agent's MCP configuration as today.
- **§2.4, order.** Volume → run network → tool network → backing services → tool containers → tools healthy → gateway configuration (archive upload) → gateway healthy → sandbox. A gateway that does not become healthy fails the run with `provisioning_failed`, reason `tool_unavailable`.
- **§2.6, the contract.** `tool_grants[].max_calls` becomes the gateway's cap. A new field per grant, `call_rules_sha256`, binds the argument rules (QUESTIONS #530). The runner refuses a contract it cannot turn into a gateway configuration: `contract_rejected`, `tool_not_enforceable`.
- **§2.7, counts.** `tool_used` counts (`calls`, `refused_calls`) come from the gateway's log lines, read through the Docker logs endpoint at the end of the run, codes only. `failed_calls` comes from the status in the same lines; `response_bytes` only if the log carries a size (X04 checks it, else a custom log field). The agent's event stream stays the source for loop detection. `tool_refused` gets the gateway's reason code (`max_calls`, `tool_not_allowed`, `argument_refused`, `key_refused`).
- **§2.8, kill switch.** Removing the gateway container cuts every tool at once; the runner removes it first.
- **§5.** A10 measures the gateway on the server; ADR-M80 (tools section) gets the gateway as the control for ASI02 (tool misuse) at the call level.

X04 makes these edits in ADR-M69 (with D-03 §8 and D-05 where they apply), before its code. The X14 pull request adds only a reference in ADR-M69 §4.

## 6. Consequences

- One more container per run that uses a tool (about 10 MiB). Runs with no register tool get no gateway.
- One more third-party image to pin, scan and follow (R038, R089).
- If the decision is "later" or "not at all", X04 goes on with ADR-M69 as proposed, and the call cap stays the runner's count from the agent's event stream.

## Version history

| Version | Date | Author | Notes |
|---|---|---|---|
| 0.1 | 2026-10-22 | Claude (task X14) | First version: agentgateway 1.6.0, ContextForge 1.1.0 and Docker MCP Gateway 0.44.1 compared inside the run's networks; proposal: agentgateway from X04. QUESTIONS #529–#530 |
| 1.0 | 2026-10-22 | Repository owner | Accepted: agentgateway from X04 (#529); argument rules per permission in `@sdlc/contracts` (#530, option a) |
