# T3 Checklist: reviewing AI-written code

> Status: **Draft 0.1**, awaiting approval

| Item | Value |
|---|---|
| Use when | Reviewing a pull request where AI wrote part or all of the code |
| Filled by | Person B (reviewer); second approver for sensitive change types |
| Stored in | Copy the relevant items into the PR review comment |
| Gate | G7 (also useful at G6 for High+ risk) |
| Rules | [Chapter 17](../02-playbook/ch17-reviewing-ai-output.md), [Chapter 15](../02-playbook/ch15-p5-release.md) |

---

## 0. Before reading the code

- [ ] PR uses template T2; AI disclosure filled in
- [ ] Links to intent, spec version, ADR and task plan work
- [ ] Verification summary present; evidence tied to **this** commit
- [ ] Review depth chosen: light / full / **dual approval** (migration, payment, personal data, production infrastructure, breaking change, safety function)

## 1. Intent and scope

- [ ] Does what the intent and acceptance criteria say — no more, no less
- [ ] Only files in the plan's `allowed_paths` changed (exceptions explained and approved)
- [ ] No behaviour the spec did not ask for (silent assumptions)

## 2. Correctness

- [ ] Business rules and invariants respected
- [ ] Edge cases and error handling as in the spec
- [ ] No invented APIs, library functions, config keys or numbers
- [ ] No duplicate helpers where existing code already does the job

## 3. Tests

- [ ] Every acceptance criterion has a test that checks **business behaviour**
- [ ] No test deleted, skipped, weakened or rewritten just to pass
- [ ] Negative and edge cases covered for Medium+ risk

## 4. Security

- [ ] No secrets, keys or credentials in code, config or tests
- [ ] Input validation and authorisation present where needed
- [ ] Permissions not widened (IAM, roles, network)
- [ ] New dependencies reviewed (licence, vulnerabilities, maintenance)
- [ ] Security scan: no unresolved critical finding

## 5. Compatibility and operations

- [ ] Backward compatible, or the break was approved at G3
- [ ] Migrations reversible or with an approved forward-fix plan
- [ ] Logging and monitoring adequate; no logging disabled
- [ ] Rollback possible

## 6. Maintainability

- [ ] Readable; follows project conventions
- [ ] Comments and documentation updated where behaviour changed

## Decision

| Decision | Reviewer | Second approver (if required) | Commit reviewed | Date |
|---|---|---|---|---|
| approve / request changes / reject | | | | |

---

## Version history

| Version | Date | Author | Notes |
|---|---|---|---|
| 0.0 | 2026-09-24 | — | Skeleton |
| 0.1 | 2026-09-24 | Claude (draft) | First content |
