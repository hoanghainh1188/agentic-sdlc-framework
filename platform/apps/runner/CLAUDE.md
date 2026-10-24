# CLAUDE.md — Runner, sandbox, agent

Rules for `platform/apps/runner`, the agent and model adapters (`platform/packages/adapters/agent-openhands`, `agent-opencode`, `model-litellm`), their shared helpers (`platform/packages/agent-kit`), the sandbox images and their tests. The root `CLAUDE.md` still applies. Never break a rule here; the detail is in the linked ADR. Each rule ends with its IDs in `design/RULES.md` (ADR-M84).

## Rules
- Never add a sandbox environment variable, mount, capability or network outside `docker/guard.ts`. Sandbox egress = LiteLLM and the package proxy only; GitHub is reached by the runner, never by the sandbox (ADR-M25). The socket proxy allowlist equals `ALLOWED_ENDPOINTS`. [R061]
- Trust `sdlc.*` labels only on objects with this runner's instance label; one runner process per instance label. [R062]
- The runner talks to Docker only through its own client (endpoint allowlist); the GitHub App key comes only from OpenBao `kv/shared/github-app`, readable by the api and worker AppRoles, never the runner (ADR-M23, ADR-M25). [R063]
- Sandbox output is untrusted: changed files, diffs and heads are recomputed outside the sandbox with hardened git. Never push what the sandbox committed, never write the change to a working tree, never force-push; push `agent/INT-…` with an explicit refspec (ADR-M29 §2.5, ADR-M38). [R064]
- Built-in tools only `file_editor`, `task_tracker`, `terminal`; register tools (`tool:<key>`) only as the contract grants them and only through the run's MCP gateway, whose configuration is generated from the contract and holds only the key's hash; tool and gateway containers only through `assertSafeToolSpec` / `assertSafeGatewaySpec`, never on the sandbox's network but the gateway (ADR-M69, ADR-M87); the model must be in `allowed_models`; AGENTS.md from the workspace, never public or user skills. Every edit of an agent's instructions file or model is a new agent version (ADR-M29, ADR-M31). Never activate an agent through `sdlc ops`. [R065]
- Plan text and review feedback go to the agent only in nonce-delimited blocks, framed as data, cleaned and capped (ADR-M40 §2.7, ADR-M41 §2.7). [R066]
- Recognise a LiteLLM budget block by 422 **and** error type `budget_exceeded`, never by 429 alone (ADR-M24). Money is a decimal string, never a float. `listSpend` never returns part of a range as all of it. [R067]
- GitHub tokens are single-repository and revoked by the runner right after use (ADR-M42 §2.4). [R068]
- A register tool reaches only the backing services of `SDLC_RUNNER_TOOL_SERVICES`, on its own service network (the tool and its services, never the gateway, the sandbox or another tool); its credential is a file in its own runtime volume, never an environment value; `knowledge_read` comes from the tool's own log, IDs and hashes only (ADR-M69 §2.4, ADR-M89). [R137]

## Commands
Run from the repo root.
- Sandbox images (ADR-M25, T11 §5g): `pnpm sandbox-image:build node24`; OpenCode (X03, ADR-M88): `NODE24=<node24 by digest> pnpm sandbox-image:build node24-opencode`. The first tool (X04 PR 3b, ADR-M89): `pnpm tool-image:build project-docs`.
