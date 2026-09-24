# T16 Escalation record

> Status: **Draft 0.1**, awaiting approval

| Item | Value |
|---|---|
| Use when | Every escalation (from an agent, a gate or a person) |
| Filled by | Whoever raises it (agents fill it automatically on the platform); the receiver completes the decision |
| Stored in | Issue / PR comment, or the platform record |
| Related | Chapter 6 §6.4–§6.6; approval queues (Ch.19) |
| Rules | [Chapter 6](../01-policy/ch06-governance-escalation-and-incidents.md) |

---

## Template

```markdown
# ESC-YYYY-NNNN

## 1. What and why
| Field | Value |
|---|---|
| Task / intent, agent, session | |
| Raised at | |
| Trigger | risky action · uncertainty · out of scope · disagreement · unusual behaviour · accumulated risk · time |
| Severity | Critical / High / Medium / Low |
| Response level | Observe / Notify / Pause / Contain / Incident |

## 2. Decision packet
| Item | Content |
|---|---|
| Original goal and scope | |
| Action waiting or just done | |
| Tools, resources, permissions involved | |
| Diff / command / payload | |
| Evidence so far (tests, scans) | |
| Confidence or conflicting hypotheses | |
| Expected impact; can it be rolled back? | |
| Agent's recommendation | approve / modify / reject |

## 3. Routing and clock
| Field | Value |
|---|---|
| Main owner / backup owner | |
| Acknowledge by (SLA) | |
| Resolve by (SLA) | |
| Acknowledged at / by | |

## 4. Decision (bound to what was reviewed)
| Field | Value |
|---|---|
| Decision | resume / modify / roll back / terminate / escalate further |
| Approved plan version / artifact hash | |
| Scope, allowed actions, expiry | |
| New stop conditions | |
| Decided by / at | |
```

---

## Version history

| Version | Date | Author | Notes |
|---|---|---|---|
| 0.0 | 2026-09-24 | — | Skeleton |
| 0.1 | 2026-09-24 | Claude (draft) | First content |
