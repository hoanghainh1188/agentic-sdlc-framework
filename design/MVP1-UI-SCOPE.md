# Web UI scope: the dashboard's actions

| Item | Value |
|---|---|
| Version | 1.1 |
| Date | 2026-10-10 |
| Status | **Proposed** (task V11, design only). Harry chose the main options on 2026-10-10 (QUESTIONS #375–#379). This is a plan, not approved scope: D-02 §4.2, D-03, D-05 and ADR-M54 do not change, and no backlog task is added, until Harry approves this document (section 8). It is revised once `design/M-E-REPORT.md` exists (section 9) |
| Readers | Harry, the trial teams, Claude Code |
| Related documents | D-02 §3, §4.2, FR-11, FR-16, FR-17; D-03 §5.1, §9, §12 (ADR-M03); D-05 §6.3; ADR-M54 (the read-only dashboard); ADR-M41 (G7); ADR-M42 (kill switch); ADR-M28 (escalations); D-08 V03, V09, V11; QUESTIONS #255, #355, #358, #375–#379; handbook codes table §5 (2+N) |

---

## 1. Purpose

- Say which **actions** the web dashboard adds after the read-only dashboard (U01, U02), and in which order.
- Say **who** may use each action. The answer is always the API's existing checks and the project's `access.*` roles.
- Fix what the dashboard **never** does.
- Design the **security of writes from a browser**: sign-in, session, CSRF, re-authentication, the two-person rule, audit, CSP, and the change that team access (V09) brings.
- List the design changes and implementation tasks that follow **after** Harry approves this plan, not before.

Words used here:
- **Action**: a request that changes state (`POST`, `PUT`, `PATCH`, `DELETE`).
- **Step-up**: a second proof of who you are, asked just before a sensitive action.
- **Session**: a sign-in that the server remembers for a limited time, through a cookie.

## 2. What exists today

- The read-only dashboard at `/dashboard/` on the api's own origin, 127.0.0.1 only (ADR-M54). A person pastes a personal token (`sdlc_pat_…`); the page keeps it in memory and calls `GET` endpoints only.
- Every decision is made in GitHub comments and reviews, or with the CLI (`sdlc gate …`, `sdlc escalation …`, `sdlc run kill`).
- The API already has every write endpoint this plan needs. They run the same core handlers as the comment commands (`decideGate`, the escalation services, `requestRunKill`). The API authenticates with a bearer token only (`auth.guard.ts`) and rate-limits per token and, for failed sign-ins, per address.

## 3. The actions

### 3.1. Rule for every action

- The dashboard calls an **existing API endpoint**. It adds no business endpoint and no second write path. (Sign-in, session and passkey endpoints are new; they change no business state. Section 5.)
- The API decides. The page may hide a button that the API would refuse (it reads `waiting_for` and `/v1/me`), but hiding is a convenience, never a check.
- A refusal is shown with its catalog text and code (for example `producer`, `role_missing`, `already_approved`, or a frozen intent). The page never offers a way around it.

### 3.2. Wave 1: decisions and containment (QUESTIONS #377)

| # | Action | API endpoint, core handler | Who may use it (the API decides) | Step-up |
|---|---|---|---|---|
| W1 | Kill a run | `POST /v1/runs/:run/kill`, `requestRunKill` (ADR-M42) | `access.kill_roles` (Person A, Person B, governance always; never `viewer`, rule M25). The producer may kill: killing is containment, not approval | No: containment must be fast |
| W2 | Approve a gate: G1, G2, G3, G4 (High), G5 (HITL), G6, G8 | `POST /v1/intents/:intent/gates/:gate/decisions`, `decideGate` | The gate's role from the oversight matrix (handbook codes table §4); never a producer of the change (FR-11); dual approval needs two different people (FR-16); the approval is bound to the input hash, scope and expiry (FR-17) | Yes |
| W3 | Reject a gate, with a reason code and an optional `https://` link | same | same; a G4 rejection only while an L1 proposal waits (ADR-M64) | Yes |
| W4 | Request changes at a gate (not G7), with a reason code and an optional link | same | same | Yes |
| W5 | Acknowledge an escalation | `POST /v1/escalations/:code/ack` | The owner role, the backup role from the backup step, or governance; never a producer (ADR-M28) | No |
| W6 | Decide an escalation: resume, modify, roll back, terminate, escalate; a budget increase only with an amount | `POST /v1/escalations/:code/decisions` | same; the decision is bound to the escalation's subject hash | Yes |

### 3.3. Wave 2: starting work

| # | Action | API endpoint | Who may use it | Step-up |
|---|---|---|---|---|
| W7 | Create an intent, then link its spec (the two calls of `sdlc intent create --spec`, U03) | `POST /v1/intents`, `POST /v1/intents/:intent/specs` | `access.*` create roles (never `viewer`, M16); `access.spec_link_roles` (M23) | No |
| W8 | Submit the plan file of an intent | `POST /v1/intents/:intent/plans` | `access.plan_submit_roles` (M24); the submitter never approves G3 | No |
| W9 | Build an evidence pack. The L1 proposal download stays in the CLI (§5.10): the page shows the `sdlc evidence proposal` command | `POST /v1/intents/:intent/evidence-packs` | `access.evidence_build_roles`, `access.evidence_read_roles` (M30); tenant admins | No |

### 3.4. Wave 3: administration

| # | Action | API endpoint | Who may use it | Step-up |
|---|---|---|---|---|
| W10 | Projects, users, GitHub identities (numeric ID), project roles, tenant admins | `/v1/admin/projects|users|tenant-admins` | Tenant admins; never a self-grant; Person A ≠ Person B (M21) | Yes |
| W11 | Project configuration upload (validated, with the difference to the stored version) | `PUT /v1/admin/projects/:project/config` | Tenant admins, the project's `admin` | Yes |
| W12 | Agent register and its approvals | `/v1/admin/agents` | The approver table of ADR-M37 §2.8 | Yes |
| W13 | Project AI record; evidence holds; project archive | `PUT /v1/projects/:project/ai-record`; `/v1/intents/:intent/evidence-hold`; `POST …/archive` | `access.ai_record_write_roles` (M19); `access.evidence_hold_roles` (M32); tenant admins | Yes |

API tokens stay in the CLI: a new token is shown once, and showing it in a browser page adds risk for little gain.

### 3.5. Reads that support the actions

These are reads, built from existing `GET` answers:
- "My work" for Person A and "Waiting for my decision" for Person B: the intents whose `waiting_for` names one of the person's roles, nearest deadline first.
- The **confirmation step** before a decision: what the decision is bound to (spec and plan hashes, the run proposal, the evidence pack's release hash) and the current gate input hash (section 5.6).
- Light refresh: the page asks the API again every 30 seconds while it is visible. Server-sent events stay Later.

## 4. Never in the dashboard

These follow the platform's rules. The trial data does not change them.

| Never | Why |
|---|---|
| Merge a pull request | People merge on GitHub; the platform never merges (D-02 §5, ADR-M41) |
| Approve G7 | G7 approvals are GitHub reviews of the pushed commit; the API refuses it (`g7_use_pr_review`) |
| Request changes at G7 | The feedback for the next run is the review or comment on GitHub; the API refuses it (`g7_feedback_on_git_host`, QUESTIONS #190). The page links to the pull request instead |
| Edit or delete audit records, gate decisions, cost records or any append-only row | D-05 §7.2 |
| Enter secrets: provider keys, OpenBao key shares, root tokens, GitHub App keys | They stay in the Terminal and runbook T11 |
| Raise autonomy, give oneself a role, approve one's own output | Separation of duties (FR-11, M21) |
| Get around a refusal | The page shows why; it has no override |
| Show or create an API token | Section 3.4 |

## 5. Security design for writes from a browser

### 5.1. Sign-in: GitHub OAuth through the platform's GitHub App (QUESTIONS #375)

- The person picks the tenant (its slug) and selects "Sign in with GitHub". The api redirects the browser to GitHub with the App's client ID, a random `state` (32 bytes, kept server-side with the tenant and an expiry of 10 minutes) and PKCE (S256).
- **Login CSRF:** the flow is bound to the browser that started it. With the redirect, the api sets a short-lived **pre-login cookie** `__Host-sdlc_oauth` (`HttpOnly`, `Secure`, `SameSite=Lax`, `Path=/`, about 10 minutes) that holds the hash of `state` and the PKCE verifier (or a handle to them, kept server-side). The callback needs **both**: the `state` in the URL must match the cookie's hash, and the code is exchanged only with that browser's verifier. A callback opened in another browser, or a link made by someone else with their own code, fails. The cookie is deleted at the callback, whatever the result.
- **Why `SameSite=Lax` here:** the redirect back from `github.com` to the callback is a cross-site top-level navigation. A `Strict` cookie is not sent on it, so the callback could never see the cookie. `Lax` is sent on a top-level `GET` navigation and never on a cross-site `POST`, image or `fetch`. The session cookie (§5.2) stays `Strict`.
- GitHub sends the browser back to the api's callback. The api checks `state`, exchanges the code, reads the person's **numeric GitHub account ID** (`GET /user`), then **drops the GitHub user token at once**: the platform never keeps it and never acts on GitHub as the person.
- The api finds the user by (tenant, `github`, numeric ID) among the **linked** identities in `user_identities`, and checks that the user is active. No match → refused, with the same message whatever the cause (no account, unlinked, disabled).
- The browser does the redirects, so the server still needs no inbound connection from the internet. The api only calls GitHub outbound, as it already does.
- **Needs a change of V03 and the App:** V03 drops the App's client secret today. The OAuth exchange needs it, stored in OpenBao (`kv/api/github-oauth`, readable by the `api` AppRole only), plus the callback URL in the App's settings. An existing App gets a new client secret in the GitHub UI, entered by the owner in the macOS Terminal, never in a chat tool.
- The personal-token sign-in of ADR-M54 stays for **read-only** use when GitHub sign-in is not configured. Actions always need a GitHub session.
- Company single sign-on (OIDC) stays Later (D-02 §4.2).

### 5.2. Session

- After sign-in the api creates a **new session with a new random ID and secret**. It never reuses or upgrades a cookie that existed before the sign-in (no session fixation): any session cookie the browser sent is ignored and its row, if any, revoked.
- The session is **server-side**. A new table `web_sessions` holds: ID, `tenant_id`, `user_id`, the SHA-256 of the session secret and of its CSRF token, created, last seen, idle expiry, absolute expiry, revoked. Never the secret itself. It is not an append-only table (D-05 change, section 7).
- The cookie: `__Host-sdlc_session`, `HttpOnly`, `Secure`, `SameSite=Strict`, `Path=/`, no `Domain`. Browsers accept `Secure` cookies on `http://localhost`.
- Timeouts (config): idle 30 minutes, absolute 8 hours.
- Revoked at sign-out, when the user is disabled, when their GitHub identity is unlinked, and by a tenant admin.
- **Sign out everywhere:** a person can revoke all their own sessions at once (every browser, every device); a tenant admin can do it for a person. Audit `web_session.ended` with the reason code `all`. A role change needs no revocation: the API checks roles on every request.
- The api's guard accepts **either** a bearer token (CLI, unchanged) **or** a session cookie. A request with both is refused.
- Audit: `web_session.started` and `web_session.ended` (IDs and a reason code only).

### 5.3. CSRF

Three layers, every one required on every action with a session cookie:
1. `SameSite=Strict` on the session cookie.
2. A **CSRF token** bound to the session, sent in the header `X-SDLC-CSRF`. The page gets it from `GET /v1/web/session` and keeps it in memory only.
3. An **origin check**: `Origin` must equal the configured public origin (`SDLC_API_PUBLIC_ORIGIN`), and `Sec-Fetch-Site` must be `same-origin` when the browser sends it.

Also: request bodies must be `application/json` (no form posts), and actions answer no-store. Bearer requests skip these checks: no browser sends a bearer header by itself.

### 5.4. Re-authentication before a decision: passkeys (QUESTIONS #376)

- A **passkey** (WebAuthn) per person and device. It is local, phishing-resistant and needs no outside service.
- **Step-up per action:** the page asks the api for a challenge for one action. The api makes a **random** challenge (32 bytes from a secure random source; never derived from the request) and **stores it server-side with the action it is bound to**: the session, the action, the intent or escalation, the gate, the decision and the expected input hash (section 5.6). The challenge lives a short time (about 2 minutes) and is **used once**.
- The person confirms with the passkey; the decision request carries the assertion. The api loads the stored challenge, checks that the request is exactly the stored action (same session, action, subject, gate, decision and hash), verifies the assertion, and marks the challenge used in the same transaction as the decision. Any difference, an expired or used challenge, or another session → refused. A passkey confirmation is therefore valid for **this one decision only**.
- Step-up is required for the actions marked "Yes" in section 3, and never for a kill or an acknowledgement.
- **Registering a passkey** needs a GitHub sign-in done in the last 5 minutes, writes `passkey.registered` to the audit log and posts nothing elsewhere. A person can list and remove their passkeys; a tenant admin can remove them (`passkey.revoked`). A new table `webauthn_credentials` holds the credential ID, the public key, the counter, `tenant_id`, `user_id`, created, revoked; no free-text name.
- WebAuthn cannot use an IP address as its site name. On a developer machine the dashboard must be opened at `http://localhost:8090`, not `http://127.0.0.1:8090`. Behind V09 the site name is the proxy's host name.
- A person with no passkey can still read and kill. To decide, they register a passkey first, or use the CLI or a comment as today.

### 5.5. The two-person rule: shown by the page, enforced by the API

- The same endpoints and core handlers decide (`decideGate`, the escalation services). The browser has **no rule set of its own**.
- The page shows who the gate waits for (`waiting_for`), whether the person holds that role, and the platform's refusal when they are a producer. Example: Person A who created the intent sees "Waits for Person B; you created this intent and cannot approve G7" (G7 is a link to GitHub anyway).
- Dual approval: the page shows "1 of 2 approvals"; the API refuses the same person twice.
- Tests (section 8): the producer, a wrong role and a second approval by the same person are refused **through the dashboard**, as N5 does through comments and the CLI.

### 5.6. Binding the decision to what the person saw (QUESTIONS #378)

- New **optional** field on gate decisions: `expected_input_sha256`. The page sends the gate input hash it showed in the confirmation step; when the gate input changed in between, the API answers **409** and records nothing. The CLI may send it too; it stays optional there.
- The page needs the current gate input hash: one new read-only field on the intent's existing `GET` answer (for example `gate_input_sha256`), resolved by the workflow's own function as `waiting_for` is (ADR-M54 §2.4). No new endpoint.
- The approval binding of FR-17 (hash, scope, expiry) is unchanged.

### 5.7. Audit actor (QUESTIONS #378)

- The actor is the person's user ID, as today (`actor_type: human`).
- A new source code **`web`**: in `gate_decisions.source` (today the API writes `cli` for every API decision) and in the kill source (today `api`). A D-05 change (section 7).
- The session ID and the passkey credential ID are never written to an append-only table.

### 5.8. Content-Security-Policy and headers

- The CSP of ADR-M54 §2.3 stays **unchanged**: `connect-src 'self'` covers the API calls; WebAuthn needs no CSP change; actions are `fetch` calls, so `form-action 'none'` stays.
- The GitHub redirect is a top-level navigation answered by the api (`302`), not a form or a script.
- No inline script or style, no third-party origin; every label from the message catalog; server text rendered as text, never HTML (unchanged).
- Rate limits: the existing per-token limit applies per session; a separate limit per address on sign-in, callback and passkey endpoints.

### 5.9. Where the browser may write (QUESTIONS #377)

- Actions are **off by default** (`SDLC_API_DASHBOARD_ACTIONS=off`).
- They may be turned on only on **loopback** (`http://localhost`) or **behind the V09 `access` profile** (a TLS reverse proxy). The api refuses to start with actions on when `SDLC_API_PUBLIC_ORIGIN` is missing, or is plain `http://` on a host other than `localhost`.

### 5.10. Known limits and risks

| Risk | What the plan does |
|---|---|
| **Safari and `Secure` cookies on `http://localhost`.** Chrome and Firefox treat `http://localhost` as a secure context and keep `Secure` and `__Host-` cookies there; Safari (WebKit) may not, so sign-in on `localhost` could fail in Safari | U05 tests the sign-in and the session in Safari, Chrome and Firefox on `http://localhost`. If Safari refuses the cookies, it is a **known limit**, written in the handbook: on `localhost` use Chrome or Firefox; Safari works behind the V09 HTTPS origin. The cookie rules are never weakened for it (no cookie without `Secure`) |
| **The L1 proposal through a browser.** A browser download lands in the person's Downloads folder with the usual permissions, and may be synced or scanned by other tools; the CLI checks the hash again and writes the file with mode 600 (ADR-M64). The patch is client code | The download **stays in the CLI only**. The page shows the run, the hash and the size, and the exact `sdlc evidence proposal <INT> --run <id> --output <file>` command; no download link |

## 6. What changes with V09 (team access)

V09 (ADR-M67, not done yet) publishes the API and the dashboard on one LAN port through a TLS reverse proxy. For actions:

| Topic | On loopback | Behind V09 |
|---|---|---|
| Public origin | `http://localhost:8090` | `https://<proxy host>` |
| Cookie | `__Host-…; Secure` (localhost counts as secure in Chrome and Firefox; Safari: §5.10) | same, over TLS; the proxy adds HSTS |
| Origin check | `localhost` | the proxy's origin only |
| GitHub callback URL | `http://localhost:8090/…` | `https://<proxy host>/…` (one App can list both) |
| Passkey site name | `localhost` | the proxy's host name; passkeys registered on localhost do not work there |
| Rate limits | api only | the proxy's per-client limits too |
| Client address | direct | the proxy's forwarded address, trusted from the proxy only |

V09 keeps the token only in the `Authorization` header for the CLI; the dashboard moves to the session cookie for actions.

## 7. Design changes after approval (not in this PR)

One design PR, after Harry approves this document. Nothing in it is applied now.

| Document | Change |
|---|---|
| D-02 §4.2 | "Actions in a web UI stay Later" → the dashboard's actions of sections 3.2–3.4, in waves, with the rules of section 5 |
| D-03 §5.1, §9, §12 (ADR-M03 note) | The dashboard row gains actions and sessions; ADR-M03 notes that the dashboard is a second way to decide, through the same handlers |
| D-05 | Tables `web_sessions`, `webauthn_credentials`, the pending passkey challenges (random, with their bound action, short-lived, used once); source code `web`; audit actions `web_session.*`, `passkey.*` |
| ADR-M54 | A pointer: the read-only decision stays; actions are decided in ADR-M73 |
| **ADR-M73** (new, QUESTIONS #379) | Dashboard actions: GitHub sign-in, sessions, CSRF, passkeys (and the WebAuthn library), `expected_input_sha256`, settings, alternatives considered |
| D-08 V03 | The App keeps its client secret in OpenBao and lists the callback URLs |
| Handbook Ch.19 (usage) | Signing in, passkeys, the actions |

## 8. Implementation tasks (proposed, added to `scripts/generate-backlog.py` only after approval)

| ID | Task | Size | Depends on | Main acceptance criteria |
|---|---|---|---|---|
| U04 | Design PR: ADR-M73, D-02 §4.2, D-03, D-05, D-08 V03 | S | this plan approved | Harry approves each change |
| U05 | GitHub sign-in and server-side sessions | M | U04, V03 change | OAuth with `state`, PKCE and the pre-login cookie (login CSRF); a new session ID at sign-in; sign out everywhere; sign-in tested in Safari, Chrome and Firefox on `localhost`; the GitHub user token dropped; match by numeric ID among linked identities; `web_sessions` (hashes only); guard takes bearer or cookie; revocation; audit; tests: tenant isolation, unlinked or disabled user refused |
| U06 | CSRF, origin check, passkeys and step-up | M | U05 | Three CSRF layers; WebAuthn registration and per-action assertions against a random, stored, single-use challenge bound to the action; `webauthn_credentials`; tests: a request from another origin, without the CSRF token, or with a reused assertion is refused |
| U07 | Wave 1 in the dashboard: kill, gate decisions, escalations | M | U06 | Confirmation step with the input hash; `expected_input_sha256` (409); source `web`; Playwright tests: producer, wrong role and the same person twice refused through the page (N5), G7 only as a link; screenshots at 375, 768, 1440 px, light and dark |
| U08 | Wave 2: create an intent with its spec, submit a plan, evidence packs | M | U07 | The U03 flow (a refused link keeps the intent); refusals from the catalog; the proposal download stays in the CLI (§5.10) |
| U09 | Wave 3: administration | L | U07 | Self-grant and Person A = Person B refused; config upload shows the difference before saving |

Teams on other machines also need V09. The milestone of U04–U09 (UX toward v0.2.0, or Later) is decided when the tasks are added.

## 9. How the trial data will change this plan (AC5)

`design/M-E-REPORT.md` does not exist yet. The trial teams record, in the manual log (M-E plan §7.2), an **interface** column: for each step done by comment or CLI, which action of section 3 they would have used, or what was missing, and why. When the report exists, version 1.1 of this document:

- **orders the waves** by how often each action was asked for and by the time lost without it; an action nobody asked for moves to a later wave or out;
- **checks sign-in**: if teams could not use GitHub sign-in (for example their GitHub accounts are not linked, or GitHub is blocked), section 5.1 is reconsidered (company OIDC earlier, or token-to-session);
- **checks step-up**: if passkeys stop people from deciding, the step-up method is reconsidered, never removed for approvals;
- **adds reads** the teams missed (section 3.5);
- keeps sections 4 and 5.5 unchanged: the trial does not change what the dashboard never does or the two-person rule.

## 10. Decisions taken for this plan

| QUESTIONS | Decision (Harry, 2026-10-10) |
|---|---|
| #375 | Sign-in with GitHub OAuth through the platform's App; matched by numeric GitHub ID; sessions server-side |
| #376 | Step-up with a passkey (WebAuthn) before every decision |
| #377 | Wave 1 = kill, gate decisions, escalations; writes only on loopback or behind V09 |
| #378 | Source code `web`; optional `expected_input_sha256` on gate decisions |
| #379 | A new ADR-M73 for the dashboard's actions; ADR-M54 stays the read-only record |

## Version history

| Version | Date | Author | Notes |
|---|---|---|---|
| 0.1 | 2026-10-07 | Claude (coordinator) | Draft for the trial: candidate functions by role, what never goes in the interface, conditions for actions, proposed order |
| 0.2 | 2026-10-10 | Claude (coordinator), approved by Harry | Wording only: "MVP" retired; v0.1.0 is the "v0.1 baseline", unscheduled work is "Later"; meaning unchanged (QUESTIONS #360) |
| 1.0 | 2026-10-10 | Claude (task V11) | The plan of the dashboard's actions: three waves through the existing endpoints, what never goes in, the security design for writes (GitHub sign-in, sessions, CSRF, passkey step-up, the two-person rule, audit source `web`, `expected_input_sha256`, CSP unchanged), V09, the design changes and tasks after approval, how the trial data changes it (QUESTIONS #375–#379). Proposed: nothing changes before Harry approves it |
| 1.1 | 2026-10-10 | Claude (task V11), after Harry's review of PR #280 | Still proposed. §5.1 login CSRF: the pre-login cookie `__Host-sdlc_oauth` (`SameSite=Lax`, about 10 minutes) with the hash of `state` and the PKCE verifier, both needed at the callback; why Lax. §5.2 a new session ID at sign-in (no fixation), "sign out everywhere". §5.4 the passkey challenge is random, stored with its action, short-lived and used once (not derived). §5.10 known limits: Safari and `Secure` cookies on `localhost` (tested in U05), the L1 proposal download stays in the CLI (W9) |
