# T9 AI incident record

> Status: **Draft 0.1**, awaiting approval

| Item | Value |
|---|---|
| Use when | Any AI incident or security incident (report within 15 minutes; record the same day) |
| Filled by | Person A; completed with Person B (and leadership for Critical / High) |
| Stored in | `docs/incidents/INC-YYYY-NNNN.md` (restricted access if it contains sensitive details) |
| Related | Escalation (T16); lowering autonomy (Ch.4 §4.10) |
| Rules | [Chapter 6 §6.7](../01-policy/ch06-governance-escalation-and-incidents.md), [Chapter 3 §3.11](../01-policy/ch03-security-guardrails-and-client-data.md) |

---

## Template

```markdown
# INC-YYYY-NNNN — <short title>

## 1. Summary
| Field | Value |
|---|---|
| Reported by / at | |
| Severity | Critical / High / Medium / Low |
| Type | wrong or invented output delivered · agent outside permissions · prompt injection · data sent to the wrong place · model misuse · runaway cost · other |
| Project / client | |
| Clients affected | |
| Status | open / contained / resolved / closed |

## 2. Timeline
| Time | Event | Who |
|---|---|---|
| | Detected | |
| | Reported (≤ 15 min) | |
| | Contained (agent stopped ≤ 5 min; tokens revoked) | |
| | Client notified (if required) | |
| | Resolved | |

## 3. Impact
<What was accessed, changed or delivered. Data involved (class). Business impact.>

## 4. AI details
| Field | Value |
|---|---|
| Agent / tool and version | |
| Model and version | |
| Input context (what it read) | |
| Output / action and why it was wrong | |

## 5. Root cause
<Why it happened. Use "5 whys" if helpful.>

## 6. Which gate failed to catch it
| Gate or control | Why it did not stop the problem |
|---|---|

## 7. Actions
| Action | Type (fix / rule / gate / training / autonomy change) | Owner | Due |
|---|---|---|---|
| | | | |
| Proposed new guardrail: | | | |

## 8. Review (blameless, within 48 hours)
| Participants | Date | Main lessons |
|---|---|---|
```

---

## Version history

| Version | Date | Author | Notes |
|---|---|---|---|
| 0.0 | 2026-09-24 | — | Skeleton |
| 0.1 | 2026-09-24 | Claude (draft) | First content |
