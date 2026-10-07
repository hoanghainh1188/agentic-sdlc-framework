# ADR-M54. A read-only web dashboard

| Item | Value |
|---|---|
| Status | **Proposed** (task U01, for review) |
| Date | 2026-10-07 |
| Decided by | Harry (QUESTIONS #255; U01 plan approved 2026-10-07 with the answers to QUESTIONS #260–#263: the four read-only fields, #263 option B, the token in memory only) |
| Related | D-08 task U01 (AC1–AC6); D-02 §4.2 (version 1.4); D-03 §5.1, §9, §11 (version 1.32); ADR-M03 (no web UI in the MVP), ADR-M26 (the API), ADR-M36 (the CLI's API client), ADR-M30 (intent workflow), ADR-M28 (escalations), ADR-M45 (cost report), ADR-M47 (gate metrics), ADR-M48 (Evidence Packs); handbook Ch.19 §19.8e; QUESTIONS #255, #260–#264 |

## 1. Context

The MVP has no web UI (ADR-M03): people use the CLI, comments and reviews on GitHub, and the Temporal and Langfuse UIs. During the trial M-E, Person A, Person B and the coordinator need an overview that the CLI gives only one command at a time: which intents wait where and for whom, which escalations are close to their SLA, what the trial costs, and how long the gates wait (the measures of `design/M-E-TRIAL-PLAN.md` §7.1).

Harry decided (QUESTIONS #255, 2026-10-07): a **read-only** dashboard, started in parallel with the trial M-E (which does not wait for it), signed in with the existing personal API tokens, with four groups of screens. Actions in a web UI, and the full MVP+1 interface scope, still come from the trial data after M-E (D-08 E07 note).

## 2. Decision

### 2.1. Read only, through the existing API

- The dashboard calls **only `GET` endpoints of the API** that the CLI already uses. It adds no write path, no form that changes state, no endpoint. Every decision stays in comments, reviews and the CLI.
- The API applies the same rules as for the CLI: no role on the project → 404, another role → 403, tenant-admin endpoints for tenant admins only. The dashboard hides what a person cannot open, but the API decides.
- Four read-only fields were missing for the screens Harry asked for. They are added to **existing GET responses**, never as new endpoints (§2.4).

### 2.2. Where it lives

- A new app, `platform/apps/dashboard` (`@sdlc/dashboard`), built to static files (PR 2).
- `sdlc-api` serves the built files under `/dashboard/`, on its own origin: `127.0.0.1:8090` in Compose. No new host port, no CORS, no second process.
  - Setting `SDLC_API_DASHBOARD_DIR`: an absolute folder, or `off` (the default outside the image; no dashboard routes).
  - The api reads the folder **once at start-up**: at most 200 files and 10 MB, only `.html`, `.js`, `.css`, `.woff2`, `.svg`, no symbolic links, and `index.html` must exist; otherwise the api does not start. A request is answered from that list by its path as a key, never by reading a path from the request.
  - The routes sit outside the API's guard: they serve the same public files to everyone. The API's routes keep their guard.
- **For 127.0.0.1 only** (Harry, U01 plan): on a developer machine or on the server itself, as the API is today. Exposing the dashboard (and the API) to other machines needs TLS, a reverse proxy and a review of the token handling; that is out of scope here.

### 2.3. Security in the browser

- **Content-Security-Policy** on every `/dashboard/` answer: `default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`. No inline script or style, no third-party origin: every asset, the fonts included, is served by the platform. Also `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY`, `Cross-Origin-Opener-Policy` and `Cross-Origin-Resource-Policy: same-origin`, a `Permissions-Policy` that turns off camera, microphone and location.
- **Caching:** `index.html` `no-store`; hashed files under `assets/` cached for a year (`immutable`), with an ETag.
- **The token** (Harry, U01 plan): a person pastes their personal token (`sdlc_pat_…`) into a password field; the dashboard checks it with `GET /v1/me` and keeps it **in memory only**: never in a URL, `localStorage`, `sessionStorage`, a cookie or a log. A reload or "Sign out" forgets it; signing out does not revoke the token (the CLI's `sdlc logout` does).
- **CSRF:** the token travels only in the `Authorization` header and every call is a `GET`, so another site cannot make the browser act. A static test refuses any other method and any `fetch` outside the one API client (PR 2).
- **Server text** (titles, descriptions, names) is checked with the CLI's zod schemas, cleaned of control and bidirectional characters like the CLI's (ADR-M36), and always rendered as text, never as HTML.

### 2.4. The four fields (QUESTIONS #260–#263)

| # | Field | Where | What |
|---|---|---|---|
| 260 | `gate_entered_at` | intent body (list and show) | When the intent last entered `current_gate` (the column the workflow already keeps, FR-12). The dashboard shows the waiting time from it |
| 261 | `waiting_for` | `GET /v1/intents/:intent` only | `{ gate, mode, roles, approvals_needed }`: who the current gate waits for, **as the intent workflow resolves it**; null when nothing is certain |
| 262 | `project.repo_full_name` | intent body | For the links to the issue and the pull request; people with a project role cannot read `/v1/admin/projects` |
| 263 | `owner_role`, `backup_role`, `step_role` | escalation body | The route's roles in the project configuration in force, the same the escalation clock and its notices use (`stepRole`); null when the configuration cannot be loaded |

**`waiting_for` (Harry's condition):** never a second resolution next to the workflow's. The workflow's steps resolved the oversight in six places (`step.ts` for G1–G3, `g4.ts`, `g5.ts`, `g6-verify.ts`, `g7.ts`, `g8.ts`), each with its own facts. They now all call one function, `resolveGateOversight` (core `workflow/oversight.ts`), and the API calls the same function with the same facts (`currentGateWaitingFor`):

- G1–G4, G7: the latest plan's change flags (the plan G3 passed: a new plan sends the intent back to G3, ADR-M40); G3 HITL once G5, G6 or G7 sent the intent back (`returnedFromG5`);
- G5: no change flags, not breached (a breach pauses the intent, so it no longer waits at G5);
- G6: the findings of the last CI reading (unknown → HITL, QUESTIONS #157);
- G8: the latest plan's change flags, production (QUESTIONS #220);
- POLICY at G4 (Low, Medium) has no roles: the platform decides.

**What `waiting_for` says, and what it does not.** It is the oversight of the current gate: who decides it (HITL: the approver roles and how many approvals; HOTL or AUDIT: the roles told, the platform passes it when its conditions hold; POLICY: the platform). It does **not** say whether a platform check holds the gate right now: a failed G4 check, a spec that cannot be read, a plan to submit again, a missing evidence credential at G8, a merge still to come at G7, or a freezing escalation. Those are the workflow's waiting reasons; copying them into the API would be a second resolution, which this ADR refuses. The dashboard therefore labels the field "decided by", shows `freezes_intent` from the escalations, and links to the issue, where the workflow's status comments explain a hold. Exposing the workflow's last waiting reason comes in a later task (Harry, 2026-10-07; §4).

`waiting_for` is null when the intent is not `in_gate`, when the stored configuration is refused (the workflow stops too), and **at G6 before CI passed**: the workflow resolves G6's oversight only after CI passed; before that it waits for CI, not for a person. Tests: a unit test of every special case, a static test that no step calls `oversightMode` itself, and database tests that compare `waiting_for` with what the workflow does in the G4 (POLICY, HITL), G5 → G3, G6 (CI pending, findings unknown) and G7 (dual approval) tests.

`freezes_intent` (whether an escalation freezes its intent) was already in the escalation body (`isFreezing`, core): the dashboard shows it and never re-implements the freeze rule.

### 2.5. The dashboard app (PR 2)

- **Preact 11.0.0** (MIT; the stable `latest` release of 2026-09-30, after its betas and release candidates), TSX checked by `tsc` and ESLint; JSX escapes text. No `dangerouslySetInnerHTML` (lint rule and static test).
- **Vite 8.3.1** (already pinned at the root for Vitest) builds it; no Vite dev server in Compose.
- **No chart library:** small SVG components (wait-time bars per gate, cost split, SLA countdown) built on the colour tokens.
- **Fonts:** IBM Plex Sans and IBM Plex Mono 5.3.0 (OFL-1.1) from `@fontsource`, Latin subset, served by the api, `font-display: swap`.
- **Budget:** under 80 kB of JavaScript gzipped, checked on the build output.
- **Response schemas:** the CLI's zod schemas move into a package both apps import (an app never imports another app).
- **Labels and messages** through `@sdlc/messages` (`dashboard.*` keys), bundled at build time (NFR-08).

### 2.6. Tests and CI

- `pnpm test`: the static route (headers, list only, traversal, the guard), the new fields against the CLI schemas, the shared resolution; in PR 2 the data mapping, the "GET only, one client, no storage" static checks, the catalog keys and the colour contrast.
- `pnpm test:db`: the new fields through the API; `waiting_for` against the workflow.
- `pnpm test:dashboard` (PR 2): Playwright 1.63.0 (Apache-2.0) with Chromium against a stub API: sign-in, every screen, sign-out forgets the token, keyboard use; screenshots at 375, 768 and 1440 px in both themes. It runs in the existing `sandbox-image` job (weekly, manual, and when `platform/apps/dashboard/**` changes): no new job (Actions minutes).

## 3. Alternatives considered

| Option | Why not |
|---|---|
| A separate dashboard process or port | A second origin needs CORS and a new port; nothing to gain on 127.0.0.1 |
| `@fastify/static` | A runtime dependency in the api for a dozen files; the fixed list read at start-up is smaller and never reads a path from a request |
| Lit 3.3.3 (BSD-3) | Fine, but its templates are not type-checked; Preact with TSX is |
| A token in `sessionStorage` | Survives a reload, but any script running in the page could read it; memory only (Harry) |
| Re-deriving `waiting_for` with `PolicyEngine.oversightMode` in the API | Could disagree with the workflow (G3 after a return, G6 findings, G8 production); refused by Harry |
| New read endpoints | Not needed: the fields fit the existing responses (QUESTIONS #260–#263) |

## 4. Consequences and gaps

- People see the state of the trial in one page, without a new write path or a new port.
- Every refactored workflow step resolves oversight exactly as before; `pnpm test:db` and `pnpm test:workflow` pass unchanged.
- **Gaps:**
  - the token stays in the browser's memory while the tab is open; anyone at the unlocked screen can read the pages (sign out, lock the screen);
  - a role or a configuration changed after an escalation was raised: the roles shown are those of the configuration in force, as the clock uses them, not those at the raise;
  - `plan-check.ts` and `spec-check.ts` still resolve the oversight of G3 and G2 for their notice audiences without the shared function (QUESTIONS #264); `waiting_for` does not depend on them;
  - `waiting_for` names who decides the current gate, not whether a platform check holds it (§2.4); the workflow's last waiting reason (for example `g4_refused`, `plan_resubmit_needed`, `evidence_unavailable`) is not in the API. Harry decided (2026-10-07) that a later task exposes it, read from what the workflow recorded; the coordinator adds the task to the backlog and gives it a question number (the U01 block #260–#264 is used up);
  - the dashboard does not refresh by itself in PR 2 beyond a manual "refresh" (no polling of the API every few seconds).

## Version history

| Version | Date | Author | Notes |
|---|---|---|---|
| 0.2 | 2026-10-07 | Claude (task U01, PR 1) | After the code review: what `waiting_for` does not say (§2.4); Harry: a later task exposes the workflow's last waiting reason (§4) |
| 0.1 | 2026-10-07 | Claude (task U01, PR 1) | First version: read only, served by the api under `/dashboard/`, 127.0.0.1 only, CSP, the token in memory, the four fields, one oversight resolution for the workflow and `waiting_for`; PR 2's app and tests |
