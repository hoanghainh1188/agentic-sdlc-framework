# Platform

The code and guides of the Agentic SDLC Framework platform: the system that runs AI coding agents through the eight gates G1–G8 and keeps the evidence, the audit log and the cost. The MVP is a **modular monolith** (`design/D-03`, ADR-M01).

## Guides

| You want to | Read |
|---|---|
| Understand the platform quickly | [PLATFORM-IN-5-MINUTES.md](PLATFORM-IN-5-MINUTES.md) |
| Follow one feature from idea to release | [TUTORIAL-FIRST-FEATURE.md](TUTORIAL-FIRST-FEATURE.md) |
| Use the platform (install `sdlc`, log in, take a task through G1–G8) | [USER-GUIDE.md](USER-GUIDE.md) |
| Bring a project team onto the platform | [ROLLOUT-GUIDE.md](ROLLOUT-GUIDE.md) |
| Install the platform on a server (operator) | [deploy/README.md](deploy/README.md) "Fresh deployment"; runbook `handbook/03-templates/T11-openbao-runbook.md` |
| Develop the platform itself | [GETTING-STARTED.md](GETTING-STARTED.md), `CLAUDE.md` |

## Layout

```text
platform/
├── apps/             # api (NestJS), worker (Temporal, GitHub poller), runner (sandboxes, agent), cli (sdlc), dashboard (read only)
├── packages/         # core, contracts, config, messages, secrets, telemetry, api-schemas, workflow-client
│   └── adapters/     # git-github, agent-openhands, model-litellm, evidence-s3, policy-simple, traces-langfuse
├── deploy/           # docker-compose.yml and its profiles, OpenBao bootstrap, scripts
├── sandbox-images/   # the sandbox images per toolchain (node24)
├── tests/            # unit tests by area; integration/ (database, workflow, pilot scenarios)
├── spikes/           # throw-away experiments (OpenHands, WeKnora) and their results
├── tools/            # ESLint rules (module boundaries)
└── docs-images/      # screenshots used by the guides
```

Details: `design/D-03` section 11. The commands (`pnpm build`, `pnpm test`, …) are listed in `CLAUDE.md`, section "Commands".
