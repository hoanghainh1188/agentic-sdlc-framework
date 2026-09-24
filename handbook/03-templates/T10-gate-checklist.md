# T10 Checklist for the 8 gates (G1–G8)

> Status: **Draft 0.1**, awaiting approval

| Item | Value |
|---|---|
| Use when | At every gate, by the approver or the person checking an automatic gate |
| Filled by | Gate approver (see codes table §4) |
| Stored in | Gate comment (issue / PR) or the platform record |
| Gate | G1–G8 |
| Rules | [Codes table §4](../00-introduction/05-codes.md), [Chapter 10](../02-playbook/ch10-framework-and-gates.md) |

---

Every gate decision records: **decision · who · when · version or hash of what was reviewed · evidence links · reason** (required for reject, request changes, block).

## G1 — Intent / Scope / Risk (always HITL, Person A)

- [ ] Intent Record (T1) complete: objective, rationale, outcome, in/out of scope, constraints, invariants, owner, escalation rule
- [ ] Risk tier and data class set
- [ ] Client confirmation attached; client AI consent in the project AI record
- [ ] No production access requested without authority

## G2 — Specification (Low: HOTL; Medium: HITL Person A; High+: HITL Person B)

- [ ] Acceptance criteria testable; terms defined; conflicts resolved; non-goals written
- [ ] Every requirement traces to the intent
- [ ] Spec version and hash recorded

## G3 — Plan / Architecture (Low: HOTL; Medium+: HITL Person B; forced HITL list at any tier)

- [ ] ADR (T12) for significant decisions; options and rollback strategy
- [ ] Forced-HITL list checked: migration · breaking contract · new service boundary · security boundary · system of record · production infrastructure · core business rule
- [ ] Task plan (T13): allowed paths, tools, limits, escalation conditions
- [ ] Plan version and hash recorded

## G4 — Execution boundary (policy check; HITL for High+ or extra permissions)

- [ ] G1–G3 approved for these exact versions
- [ ] Agent and version approved for use (agent register)
- [ ] Autonomy level within the risk tier's maximum
- [ ] Only the planned tools, files and environments; isolated workspace
- [ ] Budget, iteration and time limits set; short-lived credentials only

## G5 — Scope drift / budget (HOTL; HITL on breach)

- [ ] Changed files within `allowed_paths`
- [ ] No new tools, contracts or sensitive dependencies without approval
- [ ] Budget below 100% (warning at 80%); no loop detected
- [ ] No conflict with spec or design left unresolved

## G6 — Independent verification (automated + AUDIT / HOTL / HITL by risk; security findings always HITL)

- [ ] Required checks pass on **this** commit
- [ ] No critical finding; accepted findings have an owner and reason
- [ ] Every acceptance criterion traces to a passing test
- [ ] No weakened, skipped or faked tests

## G7 — Review / Merge (always HITL, Person B; dual approval for sensitive change types)

- [ ] Review done with T3 / T4; decision packet complete
- [ ] Producer is not the approver
- [ ] Approval bound to the reviewed commit

## G8 — Release / Learning (production: always HITL, Person B)

- [ ] Release record (T14) complete
- [ ] Artifact identical to what passed G7 (commit, digest)
- [ ] Rollback possible (tested for High+); monitoring ready; migrations validated
- [ ] Client AI disclosure note ready
- [ ] Business / security owner approval for Critical risk

---

## Version history

| Version | Date | Author | Notes |
|---|---|---|---|
| 0.0 | 2026-09-24 | — | Skeleton |
| 0.1 | 2026-09-24 | Claude (draft) | First content |
