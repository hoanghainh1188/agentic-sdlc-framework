# T1 Intent Record

> Status: **Draft 0.1**, awaiting approval

| Item | Value |
|---|---|
| Use when | Every new task, change request or incident follow-up that AI agents will work on |
| Filled by | Person A (agents may draft; Person A owns) |
| Stored in | `docs/intents/INT-YYYY-NNNN.md` in the repository (or the platform registry) |
| Gate | G1 (approval of this record) |
| Rules | [Chapter 11](../02-playbook/ch11-p1-requirements.md) |

---

## Template

```markdown
# INT-YYYY-NNNN — <short title>

| Field | Value |
|---|---|
| Intent ID / version | INT-YYYY-NNNN / v1 |
| Project / client | |
| Requested by / date | |
| Decision owner | <name> (Person A) |
| Independent reviewer | <name> (Person B) |
| Type | feature / defect / change request / incident follow-up |
| Risk tier | Low / Medium / High / Critical — reason: |
| Data class of client material | public / internal / client_confidential / client_restricted / prohibited |
| Token budget | |
| Related documents | 要件定義書, tickets, meeting notes (links) |

## 1. Problem
<What is wrong or missing today.>

## 2. Desired outcome
<What will be true when we are done. Observable.>

## 3. Business rationale
<Why it matters now.>

## 4. Scope
| In scope | Out of scope (non-goals) |
|---|---|
| | |

## 5. Business rules and invariants
- <Rule that must always hold.>

## 6. Constraints
- Technical:
- Legal / contractual:
- Performance / security:

## 7. Assumptions
| # | Assumption | Status (confirmed / to confirm) | Confirmed by |
|---|---|---|---|

## 8. Edge cases
- 

## 9. Success metrics
- <Measurable.>

## 10. Known risks
- 

## 11. Agent authority
| Agents may | Agents may not | Stop and ask a person when |
|---|---|---|
| | | |

## 12. Key terms (with the client's Japanese wording)
| Term (EN) | 原文 (JP) | Meaning agreed with the client |
|---|---|---|

## 13. Open questions for the client (Q&A)
| # | Question | Asked on | Answer | Answered by |
|---|---|---|---|---|

## 14. G1 decision
| Decision | By | Date | Evidence (email / minutes) |
|---|---|---|---|
| approve / reject / request changes | | | |
```

## Check before submitting to G1

- [ ] Every field filled, or marked "not applicable" with a reason
- [ ] Out-of-scope items written down
- [ ] Risk tier and data class set **before** any AI read client material
- [ ] Client confirmation attached for scope and key terms
- [ ] No open question that blocks the specification

---

## Version history

| Version | Date | Author | Notes |
|---|---|---|---|
| 0.0 | 2026-09-24 | — | Skeleton |
| 0.1 | 2026-09-24 | Claude (draft) | First content |
