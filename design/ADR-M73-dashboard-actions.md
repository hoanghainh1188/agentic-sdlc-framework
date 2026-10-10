# ADR-M73. Actions in the web dashboard

| Item | Value |
|---|---|
| Status | **Accepted** (Harry, 2026-10-10). Built by tasks U05–U07 (UX) and U08–U09 (Later) |
| Date | 2026-10-10 |
| Decided by | Harry (V11: `design/MVP1-UI-SCOPE.md` 1.0 approved 2026-10-10; QUESTIONS #375–#380) |
| Related | `design/MVP1-UI-SCOPE.md` 1.1 (the plan); ADR-M54 (the read-only dashboard); ADR-M03 (approvals through comments and the CLI); ADR-M26 (the API); ADR-M37 (admin); ADR-M41 (G7); ADR-M42 (kill switch); ADR-M28 (escalations); ADR-M67 (V09, team access, not written yet); D-02 §4.2 (1.10); D-03 §5.1, §9, §12 (1.40); D-05 (1.40); D-08 U05–U09, V03 |

## 1. Context

The dashboard of ADR-M54 is read only: a person pastes a personal token, the page keeps it in memory, and every call is a `GET`. Every decision is made in GitHub comments and reviews, or with the CLI. Harry asked for a plan of the dashboard's actions (QUESTIONS #355, #358). Task V11 wrote it (`design/MVP1-UI-SCOPE.md`), and Harry approved it on 2026-10-10.

Writes from a browser need what the read-only dashboard avoids: a sign-in that is not a pasted token, a session, CSRF protection, a stronger proof before a decision, and an audit trail that names the channel.

## 2. Decision

### 2.1. What the dashboard may do

- Actions in three waves, all through **existing API endpoints and core handlers** (MVP1-UI-SCOPE §3). Wave 1 (U07): kill a run; approve, reject or request changes at a gate, never at G7; acknowledge and decide an escalation. Wave 2 (U08): create an intent with its spec, submit a plan, evidence packs. Wave 3 (U09): administration.
- No new business endpoint. New endpoints only for sign-in, the session and passkeys; they change no intent, gate, run or escalation.
- Never in the dashboard: merging, approving or requesting changes at G7, editing append-only rows, entering secrets, a self-grant, getting around a refusal, showing a new API token (MVP1-UI-SCOPE §4).

### 2.2. Sign-in and session (QUESTIONS #375)

- **GitHub OAuth through the platform's GitHub App** (the same App as the poller), with a random `state` and PKCE kept server-side together with the chosen tenant (10 minutes, used once).
- The api reads the person's **numeric GitHub account ID** and **drops the GitHub user token at once**: never stored, logged or used to act on GitHub.
- The user is the active user with a **linked** identity (tenant, `github`, numeric ID) in `user_identities`. Every other case gets the same refusal.
- The App's **client secret** lives in OpenBao at `kv/api/github-oauth`, readable by the `api` AppRole only. The App lists the callback URLs (localhost, and the V09 origin). This changes V03, which dropped the client secret; U05 does it.
- A **server-side session** in a new table `web_sessions` (D-05): only the SHA-256 of the session secret and of its CSRF token, the tenant, the user, timestamps, the idle expiry (default 30 minutes) and the absolute expiry (default 8 hours), and `revoked_at`. The cookie is `__Host-sdlc_session; HttpOnly; Secure; SameSite=Strict; Path=/`.
- A session is revoked at sign-out, when the user is disabled, when the identity is unlinked, and by a tenant admin. Audit `web_session.started`, `web_session.ended`.
- The guard accepts a bearer token **or** a session cookie, never both. The personal-token sign-in of ADR-M54 stays for read-only use.
- Company single sign-on (OIDC) stays Later.

### 2.3. CSRF and origin (QUESTIONS #377)

- Every write with a session cookie needs all three: `SameSite=Strict`; the session's CSRF token in the header `X-SDLC-CSRF`; `Origin` equal to `SDLC_API_PUBLIC_ORIGIN` (and `Sec-Fetch-Site: same-origin` when the browser sends it). Bodies are `application/json` only.
- Actions are **off by default** (`SDLC_API_DASHBOARD_ACTIONS=off`). They may be turned on only on `http://localhost` or behind the V09 TLS proxy: the api refuses to start with actions on and no public origin, or a plain `http://` origin on another host.
- Bearer requests (CLI) are unchanged.

### 2.4. Passkey step-up (QUESTIONS #376)

- Every gate decision, escalation decision and admin change needs a **passkey assertion** (WebAuthn) made for that one request. The challenge is single-use and bound to the session, the action, the intent or escalation, the gate, the decision and `expected_input_sha256`. A kill and an acknowledgement need none.
- Registering a passkey needs a GitHub sign-in in the last 5 minutes. A new table `webauthn_credentials` (D-05) holds the credential ID, the public key, the counter, the tenant, the user, `created_at`, `revoked_at`; no free text. Audit `passkey.registered`, `passkey.revoked`.
- Library: `@simplewebauthn/server` and `@simplewebauthn/browser` (MIT), pinned exactly by U06 to a version at least two weeks old; the version is recorded here then.
- WebAuthn refuses an IP address as its site name: on a developer machine the dashboard is opened at `http://localhost:8090`.

### 2.5. The two-person rule and the binding (QUESTIONS #378)

- The API decides with the same handlers (`decideGate`, the escalation services, `requestRunKill`). The browser has no rule set; it only hides buttons from `waiting_for` and `/v1/me`, and shows the API's refusal.
- An optional field **`expected_input_sha256`** on gate decisions: a different current input → 409, nothing recorded. The current gate input hash becomes a read-only field of the intent's `GET` answer, resolved by the workflow's own function (as `waiting_for`, ADR-M54 §2.4). FR-17 is unchanged.

### 2.6. Audit

- The actor stays the person's user ID (`human`).
- A new source code **`web`** in `gate_decisions.source` and in the kill source (D-05, migration in U07).
- No session or passkey credential ID in an append-only table.

### 2.7. Unchanged

- The CSP of ADR-M54 §2.3: `connect-src 'self'` covers the calls; WebAuthn needs no CSP change; actions are `fetch` calls, so `form-action 'none'` stays. The GitHub redirect is the api's `302`.
- Server text as text, never HTML; every label from the catalog; rate limits per session as per token, and per address on sign-in, callback and passkey endpoints.

## 3. Alternatives considered

| Option | Why not |
|---|---|
| Keep the pasted personal token, in memory, for writes too | No session control, no step-up, and a long-lived secret in the page; refused by D-08 V11 AC2 |
| Exchange the personal token once for a session cookie | Simpler, but people still paste a long-lived secret; kept only as a fallback idea if GitHub sign-in cannot be used (MVP1-UI-SCOPE §9) |
| Company OIDC first | Not needed for the open project; Later |
| Sessions in Valkey | Lost on restart and outside the tenant guard; PostgreSQL keeps both |
| SameSite alone against CSRF | One layer only |
| "Recent sign-in" as the step-up | GitHub does not force a new password entry, so it proves little |
| Re-typing the personal token as the step-up | A long-lived secret typed often; weaker than a passkey |
| New write endpoints for the dashboard | A second path could drift from the CLI and comment rules |
| Revising ADR-M54 | ADR-M54 stays the record of the read-only decision (QUESTIONS #379) |

## 4. Consequences and gaps

- People decide gates and escalations in the page, with the same rules as the CLI and comments, and the audit shows `web`.
- Two new tables and a few new settings; the GitHub App needs a client secret (one more secret in OpenBao).
- A person without a passkey can read and kill but not decide in the page; they use the CLI or a comment.
- Passkeys registered on `localhost` do not work behind V09 (another site name); people register again there.
- Until V09, only someone on the machine of the stack can use the actions.
- Revised from `design/M-E-REPORT.md` (MVP1-UI-SCOPE §9): the order of the waves, the sign-in, the step-up method (never removed for approvals).

## Version history

| Version | Date | Author | Notes |
|---|---|---|---|
| 1.0 | 2026-10-10 | Claude (task V11, design PR), accepted by Harry | First version, from `design/MVP1-UI-SCOPE.md` 1.0 (QUESTIONS #375–#380) |
