# MVP done: the definition-of-done check

| Item | Value |
|---|---|
| Version | 0.1 |
| Date | 2026-10-05 |
| Status | **Draft** (task E07). AC4 prepared, waiting for the API-model run (QUESTIONS #81) |
| Readers | Leadership, tech lead, Claude Code |
| Related documents | D-02 §10 (the criteria), D-08 task E07, D-09 §7 and §10, QUESTIONS #81 |

## 1. Purpose

- Show, for each criterion of the MVP definition of done (D-02 §10), **which automated test proves it** and where it runs.
- List what is still open before the trial M-E, and the numbers measured so far.
- A criterion counts as met only when a test proves it. A claim without a test is listed as a gap.

## 2. Criteria and evidence

Where a test runs: **CI** = every pull request that changes its paths, plus the weekly run (`.github/workflows/ci.yml`); **weekly** = the weekly run and manual dispatch only; **owner** = run by the owner in a terminal, never in CI.

| # | Criterion (D-02 §10) | Proven by | Runs | State |
|---|---|---|---|---|
| 1 | One intent goes all the way from G1 to G8 on the sample repo | `platform/tests/integration/pilot/t01-n6.test.ts`: T01 (Low) from G1 to G6 with the real runner, a node24 sandbox, the OpenHands Agent Server and the stub model, on the pilot's shape (`AGENTS.md`, specs, protected `main`); then Person B's review of the pushed commit, Person B's merge on the Git host, G8 with the release pack built by the worker, Person B's release approval, the sealed pack and `done` (`pnpm test:pilot`) | CI (`sandbox-image`) | Met |
| 1 | The same on the real pilot repository | `pilot/pilot-live.test.ts` with `SDLC_PILOT_LIVE_G8=1` (`pnpm test:pilot-live`): the real `harryforge/pilot-order-inventory`, the pilot's real `ci-ok`; the test waits until Person B approves and merges on GitHub, then G8 → `done` | Owner | Prepared; needs the plan file and Person B's account (§4) |
| 2 | The agent never bypasses a human gate | Unit tests of the policy engine (agents never approve, producers refused); `workflow/g1-g3/n4-n5.test.ts` (N5); `db/gate-g7.test.ts` (producer merge, early merge, `/approve G7` refused); `db/gate-g8.test.ts` (producers refused); `pilot/t01-n6.test.ts` (N6: `main` refuses the agent's commit; on the G1 → G8 path: no gate decision by an agent, every HITL decision by a person with the gate's role, no call to a merge endpoint) | CI | Met |
| 3 | The Evidence Pack is complete and readable | `db/evidence-pack.test.ts`, `db/gate-g8.test.ts`; on the G1 → G8 path (`t01-n6`): one sealed version, its manifest lists the spec and its hash, the plan hash, the run, the diff (`verified`), the decisions of G1–G8, the cost and the disclosure note; the Markdown names the intent and every gate, and holds no code or plan text; both files match their stored SHA-256 | CI | Met |
| 4 | `sdlc audit verify` passes | `db/audit-log.test.ts` (a changed record is found); `cli/token-audit.test.ts`; end of the G1 → G8 path: the tenant admin's `sdlc audit verify` → intact, exit 0 (`t01-n6`); the fresh deployment (`fresh-deploy`) | CI, weekly | Met |
| 5 | Over budget and out of file scope are blocked | `pilot/n1-n2-n3.test.ts` (N1 out of scope → G3; N3 warning at 80 %, stop at the cap, escalation); `integration/litellm/litellm-live.test.ts` (run, intent and tenant budgets block at LiteLLM); `db/gate-g5.test.ts` | CI | Met |
| 5b | Separation of duties, forced HITL at G3, dual approval at G7, approval expiry | `workflow/g1-g3/n4-n5.test.ts` (N5; an expired approval is void); `workflow/g1-g3/happy-path.test.ts` (N8: a Low-risk plan flagged `migration` makes G3 HITL); `db/gate-g7.test.ts` ("migration: Person B alone is not enough", N9); `db/gate-g8.test.ts` (Critical: second approver) | CI | Met |
| 5c | An unanswered escalation freezes the work and moves to the backup owner, then governance | `workflow/g1-g3/n7-escalation.test.ts` (N7); `db/escalations.test.ts` | CI | Met |
| 5d | The kill switch stops a run and revokes its credentials within 5 minutes | `pilot/kill-loop.test.ts` (a live run: sandbox, network, volume and key gone; prints `c09:kill_to_clean_up_ms`); `integration/runner/provision.test.ts` (measured on real Docker); `db/kill-switch.test.ts` | CI | Met |
| 6 | Every model call has all labels and a cost | `integration/litellm/litellm-live.test.ts` (the real LiteLLM: seven labels on the key and on every call; spend synced into `cost_records`, nothing twice); `db/cost-sync.test.ts` (C12); on the G1 → G8 path: one cost record per model call, with the run's labels (`t01-n6`); with a real API model: `agent/agent-api.test.ts` (`pnpm test:agent-api`: every LiteLLM spend-log row of the run has the seven labels and a cost above 0, and matches `cost_records`) | CI; owner | Met in CI with the real LiteLLM and a stub model; the API-model check waits for #81 |
| 7 | Everything runs from `docker compose up` following the README | `platform/deploy/README.md`, section "Fresh deployment (operator)"; `integration/deploy/fresh-deploy.test.ts` (`pnpm test:fresh-deploy`) follows it on a throw-away Compose project with every server profile, to the first intent at G1; `platform/tests/deploy/fresh-deploy-readme.test.ts` keeps the README and the code in step | Weekly; CI (static) | Met (development machine with throw-away keys); the server needs A10 |

D-08 E07 AC4 (QUESTIONS #81): **prepared, waiting for the run.** `pnpm test:agent-api` runs one real task with `claude-haiku-4-5-20251001` through the development stack's LiteLLM, with the key from OpenBao (runbook T11 §5d), at most USD 1.00. The owner runs it in a terminal once the key exists; a follow-up pull request adds its numbers to §3 and closes issue #45.

## 3. Numbers measured so far

| What | Value | Source |
|---|---|---|
| Real-model run, local `gpt-oss:20b` (Ollama) | 89–110 s, 3 model calls, about 17 900 tokens in and 157 out, internal cost USD 0.0019 | ADR-M10 §3 (C05) |
| Real run with an API model (Claude Haiku 4.5, see §2) | Not run yet | `pnpm test:agent-api` (QUESTIONS #81) |
| G1 → G8 on the pilot's shape (stub model, two HOTL block windows of one minute) | 4 min 10 s for the whole file (set-up, G1 → G8, N6) on a developer machine (Apple M4 Pro, Docker Desktop); the whole `pnpm test:pilot` (4 files) 6 min 51 s | `pnpm test:pilot`, `t01-n6.test.ts` |
| Kill switch, kill to clean-up | about 1 s on real Docker | `pnpm test:runner` (C11) |
| Fresh deployment, empty env file to first intent at G1 | 60 s on a developer machine with the images already built (OpenBao 17 s, secrets and credentials 8 s, `up.sh` with every server profile 25 s, team, agent, configuration, AI record and first intent 5 s). A cold run builds the platform images first: see the CI row | `pnpm test:fresh-deploy` |
| CI minutes added by E07 | See the pull request of E07 (filled in after its CI run) | `sandbox-image` job (pull requests), `fresh-deploy` job (weekly) |

## 4. Open items

| Item | Owner | Blocks |
|---|---|---|
| QUESTIONS #81: one real run with an API model (`pnpm test:agent-api`) | Owner (the key in OpenBao, T11 §5d) | The trial M-E; issue #45 |
| The live G1 → G8 run on the real pilot (`SDLC_PILOT_LIVE_G8=1 pnpm test:pilot-live`): the plan file merged on the pilot, a second GitHub account for Person B, the dev stack running (GETTING-STARTED Steps 13–14) | Owner | Nothing in the MVP; it is the first real G1 → G8 on GitHub |
| A10: internal CA and TLS on OpenBao, backup and restore drill, resource measurement | Infrastructure operator | The real deployment on the internal server |
| MVP+1 user interface scope (web UI, dashboard; D-02 §4.2), written from the trial data after M-E | Claude, for the owner's approval | Nothing in the MVP (D-08 E07 note) |

## 5. Kept for later

Decisions taken during the MVP that left a known item for a later milestone. Each has its source.

| Item | Source | When |
|---|---|---|
| ClickHouse's `langfuse` user has access management (needed to create `sdlc_purge`), so Langfuse itself could create ClickHouse users. Turn it off after `sdlc_purge` exists, or create the user from a separate admin account | ADR-M53 (E08) | A10, before the real server |
| An un-archive command for projects (today a mistaken archive is undone only during the grace period, by a database change on the server) | ADR-M51 §2.6 (E05) | M-F |
| Whether a retention hold must be released by a different person than the one who set it | ADR-M51 (E05) | M-F |
| Every intent needs a merged pull request with its plan file before G3 (the plan is a file on the protected default branch) | QUESTIONS #230 (C09) | M-F, from the trial's waiting times |
| Redone runs (sent back by G6 or G7) do not count as wasted tokens in the cost report | ADR-M45 §2.3 (E04) | M-F |
| No manual spend-sync command; a gap longer than the catch-up window is only logged (`worker.cost_sync_gap`) | ADR-M24 §3 (C12) | M-F |
| A per-project `release.environment` and the non-production HOTL path at G8; an explicit PM/BrSE confirmation of the client's own disclosure note | QUESTIONS #220, #222 (E03) | MVP+1 |
| The MVP+1 user interface scope (web UI, dashboard), written from the trial data | D-02 §4.2, D-08 E07 note | After M-E |
| Template T13 differs from the plan schema v1 (platform fields, `change_flags`, tool names) | B09 PR 2 (#150) | Handbook authors |
| Who owns the project AI record: D-02 §3 and handbook Ch.2 §2.5 differ | QUESTIONS #103 | Docs follow-up |

## Version history

| Version | Date | Author | Notes |
|---|---|---|---|
| 0.1 | 2026-10-05 | Claude (task E07) | First version: criteria and evidence, numbers so far, open items. AC4 prepared |
| 0.2 | 2026-10-06 | Claude (coordinator), approved by Harry | §5 Kept for later: items decided during the MVP for A10, M-F, MVP+1 and the handbook |
