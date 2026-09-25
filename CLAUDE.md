# CLAUDE.md — Agentic SDLC Framework

> Status: **CODING RESUMED** (Harry, 2026-09-24). Design version 1.0 approved (tag `design-v1.0`).
> Work through `design/D-08-mvp-backlog.md` in dependency order, starting with **A01**. One task per session; open questions go to `design/QUESTIONS.md`.
> Direction: project reference docs → handbook → platform. The platform follows the handbook.
> **The handbook is not yet approved as a whole.** Decision (Harry, 2026-09-24): **code the whole backlog now and accept rework later.**
> - Keep code easy to change where it depends on handbook rules: policy, oversight matrix, roles, SLAs, thresholds belong in **config**, not hard-coded.
> - When an approved handbook change affects the platform: update the design doc first, add a change task to the backlog (`scripts/generate-backlog.py`), then change the code. Never change code silently to follow an unapproved handbook draft.
> Order: M-A → M-B → M-0 (sample repo, separate repo, right before M-C) → M-C → M-D. Task IDs: A, B, R (M-0), C, E (M-D).

## What this repo is
Repository name: `agentic-sdlc-framework`.
The **Agentic SDLC Framework = Handbook + Platform**, in one repo:
- `handbook/` — the process for humans (policies, 6 phases, 8 gates, roles, templates, runbooks). It defines *what must happen*.
- `platform/` — a self-hosted system that *enforces* the handbook: runs AI coding agents through 8 human/automatic gates (G1–G8),
  records evidence and an append-only audit log, and tracks token cost per tenant/project/intent/run.
- `design/` — approved design docs that connect the two.
Internal use first; will be sold to customers later → multi-tenant from day one.
Handbook and platform must stay consistent: same codes, same names for gates, autonomy levels and roles.

## Read these first
- MVP scope and requirements (FR/NFR, acceptance criteria): @design/D-02-mvp-scope.md
- MVP architecture, interfaces, Run Contract, code layout: @design/D-03-mvp-architecture.md
- Data model, enums, append-only tables, audit hash chain: @design/D-05-data-model.md
- MVP backlog (tasks, dependencies, acceptance criteria): @design/D-08-mvp-backlog.md
- Build vs buy decisions (what we reuse, what we build): @design/D-01-build-vs-buy.md
- Model gateway and token/cost control: @design/D-07-model-and-token-management.md
- Canonical codes (phases, autonomy L0–L4, oversight modes, gates G1–G8 × risk, 2+N roles): @handbook/00-introduction/05-codes.md

## Language
- Everything in this repo is English: docs, code, identifiers, commit messages, code comments.
- User-facing messages (CLI output, PR/issue comments, Evidence Pack Markdown) are English by default and **must go through a message catalog** (i18n keys), so Vietnamese and Japanese can be added later (D-02 NFR-08). Never hard-code user-facing strings.
- Write plain English for non-native readers: @handbook/00-introduction/06-writing-style.md
- The handbook must **not** mention the internal reference documents used to design it ("Bản chất…", `Digital_Foundry.pdf`, draft v1.0). State rules directly; cite only external sources and other repo documents.

## Repo layout
- `platform/apps/` — api (NestJS), worker (Temporal, G1–G8 workflow + GitHub poller), runner (sandbox + OpenHands), cli
- `platform/packages/` — core modules, contracts, adapters (git-github, agent-openhands, model-litellm, evidence-s3, policy-simple), config, secrets
- MVP is a modular monolith: keep module boundaries; core must not import adapters directly (use interfaces).
- `platform/deploy/` — docker-compose, OpenBao bootstrap, backup scripts. `platform/tests/integration/` — scenarios N1–N6, tasks T01–T10 (D-09).
- `design/` — approved design docs (D-xx) + `README.md` (index) + `QUESTIONS.md`. `handbook/` — process handbook for humans. `diagrams/` — Mermaid sources + SVG.
- `scripts/` — `create-issues.py` (GitHub issues from the backlog), `generate-backlog.py` (single source for D-08 + CSV). `platform/GETTING-STARTED.md` — human setup guide.
- `_review/` — historical review notes in Vietnamese; not a source of requirements. Ignore unless asked.

## Hard rules (always)
- Use only the canonical codes in the codes table (v1.3): phases P1–P6, gates G1–G8, autonomy **L0–L4**, oversight **HITL / HOTL / AUDIT**, risk tiers, PRI-0…3, Stage A/B/C. Never reintroduce old codes (G0–G12, S0–S9, "Level 0–3"). L0–L4 always has the **source** meaning (L0 Assist … L4 High-impact autonomy), never the draft v1.0 meaning.
- The design follows the codes table. If a design doc and the codes table disagree, the codes table wins; raise it in `design/QUESTIONS.md`.
- Every table has `tenant_id`; every query filters by tenant.
- Every LLM call goes through the LiteLLM gateway with labels: tenant, project, intent_id, run_id, gate, agent, data_class.
- Agents never hold real provider keys, never push to the default branch, never deploy to production.
- Separation of duties (2+N): the producer (human or agent) never approves its own output; Person B approves G3, G7, G8. Enforce by capabilities (producer agent has no merge tool).
- Append-only tables (audit_log, gate_decisions, run_events, cost_records): never add UPDATE/DELETE paths; DB triggers + grants enforce it. Audit uses a per-tenant hash chain (RFC 8785 canonical JSON + SHA-256).
- Evidence retention: default 180 days (configurable). Purge deletes SeaweedFS objects only; keep DB rows + hashes; respect `retention_hold`; log `evidence.purged`.
- Git host, agent, policy engine and model provider are behind interfaces. Do not hard-code one vendor in core logic.
- No secrets in the repo. All secrets live in OpenBao (Vault-compatible API); processes use AppRole + short-lived tokens. Sandboxes never access OpenBao.
- Run Contracts are signed via OpenBao Transit (Ed25519); the signing key never leaves OpenBao.
- GitHub events are read by polling (GitHub App + API) in the MVP; webhooks come later. Both must feed the same event handler.
- Object storage: SeaweedFS (S3 API). Cache/rate limit: Valkey. Do not introduce MinIO or Redis (license/maintenance reasons).
- Target host is a modest internal server: keep concurrent sandboxes configurable (default 1–2); heavy observability stack is an optional Compose profile.
- Every FR in D-02 gets automated tests matching its acceptance criteria.

## Documentation rules
- Design docs in `design/` are APPROVED. Do not change their meaning silently. If code must differ from a design doc: stop, add the question to `design/QUESTIONS.md`, and wait. Approved changes go in a separate PR with a short ADR.
- D-08 and its CSV are generated: edit `scripts/generate-backlog.py`, then run it. Never edit the generated files by hand.
- Diagrams D9–D13 mirror Mermaid blocks in design docs: if you change one, update the other.
- Handbook split: policies and generic process chapters are written outside Claude Code. **You own** the handbook parts that describe platform behaviour: Ch.13–16 and Ch.18–20 usage sections (CLI, `/approve` commands, config, troubleshooting) and runbooks (e.g. T11 OpenBao). When a task changes user-visible behaviour, update the matching handbook chapter in the same PR.
- Keep `CHANGELOG.md` updated for notable changes. Fill the `## Commands` section below once commands exist (A01, A02).

## Workflow for each task (one task per session, see D-08 section 5)
1. Read the task in D-08 and the related FR / design sections.
2. Propose a plan (files to touch, tests to add, risks). Wait for human approval before coding.
3. Implement on a feature branch named `task/<ID>-<short-name>`. Keep changes inside the approved file list.
4. Tests must cover every acceptance criterion (AC) of the task.
5. Run lint + tests. Open a PR; `.github/pull_request_template.md` (T2, AI disclosure) is filled automatically — complete every section. Put the task ID in the title.
6. If a design doc is missing or contradictory: do not guess. Add the question to `design/QUESTIONS.md` and stop.
7. New technical decisions (library choice, etc.): write a short ADR in `design/`.

## Commands
Run from the repo root. Node.js 24, pnpm 10 (pinned in `package.json` → `packageManager`; `corepack enable` once). Tooling: `design/ADR-M16-monorepo-tooling.md`.
- `pnpm install` — install all workspace packages (dependency install scripts are blocked unless listed in `pnpm.onlyBuiltDependencies`).
- `pnpm build` — compile every package with TypeScript project references (`tsc -b`).
- `pnpm typecheck` — build + type-check the tests in `platform/tests/`.
- `pnpm lint` — ESLint, type-aware, including module boundaries (`core` never imports adapters; adapters import `@sdlc/contracts` only).
- `pnpm format` / `pnpm format:check` — Prettier. Never touches `handbook/`, `design/`, `_review/`, `diagrams/` or Markdown.
- `pnpm test` — Vitest (all `platform/**/*.test.ts` except integration tests). One file: `pnpm test platform/tests/workspace/boundaries.test.ts`.
- `pnpm test:integration` — Vitest for `platform/tests/integration/**` only; needs the Compose `core` profile running (CI job `compose`).
- `pnpm clean` — remove build output.
- Before a PR: `pnpm build && pnpm typecheck && pnpm lint && pnpm format:check && pnpm test`.
- New package: put it under `platform/apps/`, `platform/packages/` or `platform/packages/adapters/` with the `@sdlc/` scope, and add it to the root `tsconfig.json` references.
- Docker Compose commands: added in A02.
- CI: `.github/workflows/ci.yml` (A09) runs the checks above, Gitleaks, Semgrep and Trivy, and the Compose `core` integration job. Actions are pinned by commit SHA; thresholds live in the workflow `env:`.

## Current constraints
- At most 2 sessions at the same time (a docs PR session counts as one).
- One task per session; each parallel session works in its own git worktree.
- A09 runs in parallel with A02, after the docs PR (`docs/fix-inconsistencies`) is merged.
- A03 waits until the three OpenBao key holders are named (remove this line once they are named).

## Decisions (see design/D-02 section 11)
- Q1 first agent: OpenHands · Q2 first Git host: GitHub (GitLab later, same interface) · Q3 language: TypeScript (Node.js) · Q5 repo language: English
- Secret manager: OpenBao (MPL-2.0, Vault-compatible API) · Host: internal server, modest spec
- G7 self-approval rule: intent creator cannot approve G7 · GitHub events: polling in MVP (ADR-M11) · SeaweedFS + Valkey (ADR-M12) · Evidence retention 180 days
- Q4 pilot repo: A → C → B. Step A = sample repo `pilot-order-inventory` (Vue + NestJS + PostgreSQL), spec: @design/D-09-sample-pilot-repo.md
