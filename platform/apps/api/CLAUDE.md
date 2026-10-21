# CLAUDE.md — API: administration

Rules for `platform/apps/api` and its tests. The rules for sessions, sign-in and the routes a session may write to are in `platform/apps/dashboard/CLAUDE.md`; the gate and workflow rules are in `platform/packages/core/CLAUDE.md`. The root `CLAUDE.md` still applies. Never break a rule here; the detail is in the linked ADR. Each rule ends with its IDs in `design/RULES.md` (ADR-M84).

## Rules
- Admin (ADR-M37): no self-grant or self-disable; the last active tenant admin is never removed; roles are revoked, never deleted; users are addressed by ID in URLs, never by e-mail; GitHub identities by numeric account ID only. Agents (ADR-M31): never deleted, a retired key never reused; the approvers of an activation or retirement are always different people. [R088]
- Agent approvals (ADR-M86): an activation is checked against the evaluation it names for the agent as it is now; `required` refuses without a qualifying one; all approvals of a round name the same evaluation; only the evaluation ID and the result code reach the approval and its audit event, never the fingerprint. [R135]
