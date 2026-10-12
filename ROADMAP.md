# Roadmap

Generated from the backlog (`scripts/generate-backlog.py`, the same source as [design/D-08](design/D-08-mvp-backlog.md)); do not edit by hand. The platform grows release by release; **v0.1.0 is the baseline**: the whole G1–G8 flow with evidence, audit and token cost ([what it includes](design/MVP-DONE.md)). Each task gets its own plan before it is built, so the order can change. Ideas and questions: [GitHub Discussions](https://github.com/hoanghainh1188/agentic-sdlc-framework/discussions).

| Milestone | Goal |
|---|---|
| M-E | The trial, run by the community (QUESTIONS #340) |
| UX | Friendlier for users and deployers: v0.1.1, v0.2.0, then v0.3.0 with the dashboard's actions (QUESTIONS #355, #364, #420) |
| EXT | Other agents, tools for agents, document knowledge, other Git hosts: toward v0.4.0 (QUESTIONS #361, #420) |
| Models | Self-hosted models (QUESTIONS #362) |
| Server | A team on a server: toward v1.0 (QUESTIONS #363) |
| Later | Not scheduled yet (was "MVP+1"; U01–U03 were started early there and are done) |
| M-F | Adjust gates, budgets and rules from the trial data, then a trial on a real internal tool (D-02 §13.3) |

## M-E: The trial, run by the community (QUESTIONS #340)

- **V01** The trial M-E by the community: a trial guide, a report template, `sdlc trial report` (done, v0.1.0)
- **V02** `pnpm trial:up`: the whole trial set-up on a developer machine in one command (done, v0.1.0)
- **V03** Create the GitHub App from a manifest (done, v0.1.0)

## UX: Friendlier for users and deployers: v0.1.1, v0.2.0, then v0.3.0 with the dashboard's actions (QUESTIONS #355, #364, #420)

- **V04** Publish the platform's images to GHCR for each release (done, v0.1.1)
- **V05** Install the `sdlc` command with one command (npm package `agentic-sdlc-cli`) (done, v0.1.1)
- **V06** `sdlc next <INT>`: where an intent is and what to do now (done, v0.1.1)
- **V07** `doctor`: check a deployment and a login, and say what to fix (done, v0.2.0)
- **V08** The trial stack survives a reboot (done, v0.2.0)
- **V09** Team access from other machines (TLS reverse proxy) (done, v0.2.0)
- **V10** A friendlier CLI: `sdlc help`, hints, clearer errors
- **V11** Plan the dashboard's actions (design only) (done, v0.1.1)
- **U05** Dashboard sign-in with GitHub and server-side sessions (done, v0.2.0)
- **U06** Dashboard writes: CSRF, origin check, passkey step-up (done, v0.2.0)
- **U07** Dashboard wave 1: kill a run, gate decisions, escalations
- **V12** Release process: SemVer, a tag-driven release workflow, upgrade notes (done, v0.2.0)
- **L02** Model benchmark on the pilot tasks (data for the GPU decision)

## EXT: Other agents, tools for agents, document knowledge, other Git hosts: toward v0.4.0 (QUESTIONS #361, #420)

- **X01** Spike: a second, open-source coding agent (Aider or OpenCode)
- **X02** Design: a tool register and MCP tools for agents
- **X03** A second agent adapter and the agent register's adapter column
- **X04** The tool register and the first tool: search the project's documents
- **X07** A context snapshot for every run
- **X09** Spike: other Git hosts (GitLab, Backlog Git, Bitbucket)
- **X11** Context condensing for agent runs
- **X12** Design: agent memory across runs

## Models: Self-hosted models (QUESTIONS #362)

- **L01** A self-hosted model service (vLLM) on an optional GPU host
- **L03** GPU sizing note for leadership

## Server: A team on a server: toward v1.0 (QUESTIONS #363)

- **A10** Resource measurement + backup / restore drill + internal CA / TLS
- **O01** The runner in its own VM or with rootless Docker
- **O02** A tested upgrade between two releases
- **O03** Operational alerts

## Later: Not scheduled yet (was "MVP+1"; U01–U03 were started early there and are done)

- **U08** Dashboard wave 2: create an intent with its spec, submit a plan, evidence packs
- **U09** Dashboard wave 3: administration
- **X05** Documents outside the repository (Office, PDF, Confluence, Drive, Backlog)
- **X06** A code index for agents (Tree-sitter or SCIP and pgvector)
- **X08** Knowledge for people and the G8 learning loop (design first)
- **X10** An adapter for a second Git host
- **X13** Agent memory

Also later, not yet planned as tasks: webhooks instead of polling, a full policy engine (OPA or Cedar), an incident module, break-glass access, automatic rollback, the recertification workflow, client reports, SSO and Kubernetes, several agents in one intent (D-02 §4.2).
