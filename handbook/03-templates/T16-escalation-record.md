# T16 Escalation record

> Status: **Draft 0.2**, awaiting approval

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

## On the platform

The platform keeps each escalation as a record of **codes, IDs, one hash and one link** (task B11, `design/ADR-M28-escalations.md`), because escalation records are kept for at least 2 years (Chapter 3 §3.9.3). The words of sections 1, 2 and 4 (goal, action, payload, evidence, impact, the reason of the decision) stay on the intent's issue or pull request, where they can be edited or deleted. The record links to them. Acknowledge and decide with `/ack` and `/decide` (Chapter 18 §18.8b).

---

## Version history

| Version | Date | Author | Notes |
|---|---|---|---|
| 0.0 | 2026-09-24 | — | Skeleton |
| 0.1 | 2026-09-24 | Claude (draft) | First content |
| 0.2 | 2026-09-27 | Claude (task B11) | "On the platform": the record keeps codes and links; the words stay on the issue |
