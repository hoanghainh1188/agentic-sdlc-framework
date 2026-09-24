# T15 Remediation record

> Status: **Draft 0.1**, awaiting approval

| Item | Value |
|---|---|
| Use when | Every proposed fix in operations (P6), whether proposed by an agent or a person |
| Filled by | Operations agent drafts; Person A completes |
| Stored in | Attached to the incident (T9) or the new intent (T1) |
| Related | Production changes still go through G1–G8 (fast lane for urgent fixes) |
| Rules | [Chapter 16](../02-playbook/ch16-p6-operations.md) |

---

## Template

```markdown
# REM-YYYY-NNNN — <short title>

| Field | Value |
|---|---|
| System / environment | |
| Related incident / alert | |
| Proposed by | agent <id> / person <name> |
| Urgency | emergency / urgent (fast lane) / normal |

| Section | Content |
|---|---|
| Symptom | What is observed |
| Hypothesis | Likely cause |
| Evidence | Logs, traces, metrics, diffs (links) |
| Proposed action | Fix / rollback / config change / workaround |
| Expected effect | What should change, and how we will see it |
| Risk | What could go wrong |
| Rollback | How to undo the action |
| Verification | How we confirm it worked |

## Decision
| Decision | By | Date | Path |
|---|---|---|---|
| approve / reject / more analysis | | | fast lane / normal intent / containment (Ch.18) |
```

---

## Version history

| Version | Date | Author | Notes |
|---|---|---|---|
| 0.0 | 2026-09-24 | — | Skeleton |
| 0.1 | 2026-09-24 | Claude (draft) | First content |
