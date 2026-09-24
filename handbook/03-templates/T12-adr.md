# T12 Architecture Decision Record (ADR)

> Status: **Draft 0.1**, awaiting approval

| Item | Value |
|---|---|
| Use when | Every significant design decision (always when the change is on the G3 forced-HITL list) |
| Filled by | Person A (agents may draft options) |
| Stored in | `docs/adr/ADR-NNNN-<short-title>.md` |
| Gate | G3 |
| Rules | [Chapter 12](../02-playbook/ch12-p2-analysis-and-design.md) |

---

## Template

```markdown
# ADR-NNNN — <decision title>

| Field | Value |
|---|---|
| Status | proposed / approved / superseded by ADR-NNNN |
| Intent / spec | INT-YYYY-NNNN, spec vN |
| Risk tier | |
| Forced-HITL change? | yes / no — which: migration · breaking contract · new service boundary · security boundary · system of record · production infrastructure · core business rule |
| Date | |

## Context
<Why a decision is needed. Constraints and quality attributes that matter.>

## Options considered
| Option | Summary | Trade-offs | Risks / failure modes |
|---|---|---|---|
| A | | | |
| B | | | |
| C (optional) | | | |

## Decision
<Selected option and why. Not chosen by majority of agents.>

## Rejected options and why

## Assumptions and unknowns
| Assumption / unknown | Impact if wrong | How we will check |
|---|---|---|

## Impact
| Area | Impact |
|---|---|
| Security (data, access, boundaries) | |
| Operations (monitoring, performance, cost) | |
| Data and migration | |
| Interfaces / compatibility | |

## Rollback strategy
<How to undo. If rollback is not possible: forward fix, compensation or data recovery plan.>

## Approvals
| Role | Name | Decision | Date |
|---|---|---|---|
| Person A (owner) | | | |
| Person B (approver, G3) | | | |
| Security owner (if needed) | | | |
```

---

## Version history

| Version | Date | Author | Notes |
|---|---|---|---|
| 0.0 | 2026-09-24 | — | Skeleton |
| 0.1 | 2026-09-24 | Claude (draft) | First content |
