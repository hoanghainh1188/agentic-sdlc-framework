# ADR-M88. A second agent adapter: how a run gets its adapter and its image

| Item | Value |
|---|---|
| Status | **Accepted** (repository owner, 2026-10-22, in the X03 plan: D1–D5 as recommended) |
| Date | 2026-10-22 |
| Decided by | The repository owner (X03 plan approved 2026-10-22) |
| Related | D-08 task X03; D-02 NFR-05, FR-31, FR-32, FR-35, FR-36; D-03 §7.2, §8 (version 1.45); D-05 §6.1, §6.9 (version 1.55); ADR-M22 (Run Contract), ADR-M25 (sandbox), ADR-M29 (agent adapter), ADR-M31 (agent register), ADR-M68 (the spike, OpenCode), ADR-M81 (evaluations on the server), ADR-M86 §2.1 (fingerprint); QUESTIONS #522–#528 |

## 1. Context

ADR-M68 chose OpenCode as the second adapter (QUESTIONS #521). Before X03 the platform had one adapter: the runner held one `AgentAdapter` (OpenHands), a project had one `sandbox.image`, and nothing in the agent register, the Run Contract or the image said which agent a run uses. With two adapters, four things must be decided:

1. How the runner learns the adapter of a run.
2. Which image a run starts.
3. How the OpenCode adapter reuses the task message, the git commands and the loop key of the OpenHands adapter, when an adapter may import `@sdlc/contracts` only.
4. Whether the adapter counts in the evaluation evidence of an agent version.

## 2. Decision

### 2.1. The adapter is in the register and in the signed contract (QUESTIONS #526)

- `agents.adapter` (migration `0037-agent-adapter`): `openhands` or `opencode` (`AGENT_ADAPTERS` in `@sdlc/contracts`), default `openhands`. It is configuration: a change is a new version (handbook Ch.20 §20.9, trigger `SDA09`).
- The Run Contract carries it: `agent_adapter`, `schema_version` 2. The issuer copies it from the agent the check before the run returned (ADR-M31 §2.6). A contract of schema 1 is refused as `malformed`: contracts live 15 minutes by default, so only a contract issued just before the upgrade is affected (CHANGELOG "Upgrade notes").
- The evaluation contract carries it too (`schema_version` 3), from `evaluation_runs.adapter`, which an evaluation copies from its configuration at the start. An operator evaluation (L04) runs OpenHands.
- The runner keeps its adapters by code (`AgentAdapters`). Provisioning refuses a contract whose adapter the runner does not have, before the clone (`adapter_unavailable`); `runAgent` drives the run with the contract's adapter only.

### 2.2. One image per adapter (QUESTIONS #522, #528)

- `sandbox.image` stays the OpenHands image, so existing and trial configurations keep working. `sandbox.images.openhands` and `sandbox.images.opencode` are optional, each pinned by digest; an `images.openhands` entry must equal `image` (`config.schema.sandbox_images_conflict`). `sandboxImageFor(sandbox, adapter)` is the one place that picks the image.
- A project without an image for the run's adapter fails provisioning with `image_not_configured`.
- Every sandbox image names its adapter and the agent's version in the labels `sdlc.agent.adapter` and `sdlc.agent.version`. The runner reads the label of the pinned image and refuses a mismatch (`adapter_mismatch`) before it creates anything. An image without the label is an OpenHands image: the default base and the images built before X03 have none. The label is fixed with the image digest, so it is not a runtime object label (rule R062 is about runtime objects).
- The image of the scoring container of an evaluation (ADR-M81 §2.6) stays `sandbox.image`: it holds the project's toolchain, not an agent.
- `doctor` checks an OpenCode image too, named `<project> (opencode)`.

### 2.3. Shared helpers in `@sdlc/agent-kit` (QUESTIONS #527; built in X03 PR 2)

- The task message (with its last rule as a parameter: OpenHands calls its `finish` tool, OpenCode replies with a summary), the git commands of ADR-M29 §2.5, their parsers and the loop key (`canonicalArguments`) move from `adapter-agent-openhands` to a new package `@sdlc/agent-kit`, with no I/O.
- The lint rule allows `@sdlc/adapter-agent-*` to import `@sdlc/agent-kit`; no other adapter, and never the core.

### 2.4. The adapter is part of the evaluation fingerprint (ADR-M86 §2.1)

- `evaluation_configurations.adapter`: the adapter of the configuration's agent at the start. An evaluation counts for an agent version only when a configuration has the version's model, tools, instructions **and** adapter.

### 2.5. The OpenCode image ships later

- X03 builds and scans the OpenCode image in CI and in `pnpm sandbox-image:build`. Its release wiring (the release matrix, the overlay, `images.lock` and `images.sh`, rule R089) is a separate change before the release, because the owner runs the release with `push: true`.

## 3. Alternatives not chosen

| Option | Why not |
|---|---|
| The runner reads the adapter from the `agents` row | A second read outside the signed contract: the agent's row could change between the G4 check and the run; the contract already pins the version |
| The register pins the image per agent version (QUESTIONS #522 b) | The image carries the project's toolchain, which belongs to the project, not to the agent |
| A copy of the helpers in each adapter | Two copies of the task message and the git commands drift apart; the git commands are part of the platform's hardening (R064) |
| A contract of schema 1 read as `openhands` | Two shapes of a signed object to keep; the 15-minute validity makes the refusal cheap |

## 4. Consequences

- Every place that builds a Run Contract or an evaluation contract names the adapter; tests use `openhands`.
- A new adapter later needs: a code in `AGENT_ADAPTERS`, the CHECK of the three columns (a migration), an image with the labels, and an `AgentAdapter` in the runner.
- The X02 proposal's `tool_grants` (D-03 version 1.44, proposed) moves to Run Contract schema 3.

## Version history

| Version | Date | Author | Notes |
|---|---|---|---|
| 0.1 | 2026-10-22 | Claude (task X03, PR 1) | First version, as approved in the X03 plan |
