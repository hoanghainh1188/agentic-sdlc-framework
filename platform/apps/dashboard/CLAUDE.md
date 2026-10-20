# CLAUDE.md — Dashboard, sign-in, sessions

Rules for `platform/apps/dashboard`, the sign-in and session code of `platform/apps/api`, and their tests. The root `CLAUDE.md` still applies. Never break a rule here; the detail is in the linked ADR. Each rule ends with its IDs in `design/RULES.md` (ADR-M84).

## Rules
- The dashboard reads with `GET` and writes only to the fixed paths of `src/api/writes.ts`; never add another write path, and never mark a business route `@SessionAction` before U07 except the four evaluation plan actions of L05 (ADR-M82 §2.7: create, change, archive, Run now; Run now always with the passkey step-up). The guard takes a bearer token or a session cookie, never both. A session writes only with all three CSRF layers (ADR-M54, ADR-M73). [R085]
- Never weaken the session cookie attributes; the person's GitHub token is revoked at once and never stored. No inline script or style, no `innerHTML`, no browser storage in the dashboard; the token lives in memory only. Every dashboard read goes through `src/api/client.ts` with a path from `src/api/reads.ts`; server text is shown as text (`cleanText`), never HTML; the GitHub sign-in is a top-level navigation, never a fetch. [R086]
