# T14 Release record

> Status: **Draft 0.1**, awaiting approval

| Item | Value |
|---|---|
| Use when | Every release to production, or every delivery to a client who deploys it |
| Filled by | Person A (release / operations agents may draft) |
| Stored in | `docs/releases/REL-YYYY-NNNN.md` or the release ticket |
| Gate | G8 |
| Rules | [Chapter 15](../02-playbook/ch15-p5-release.md) |

---

## Template

```markdown
# REL-YYYY-NNNN — <release name>

## 1. What is released
| Field | Value |
|---|---|
| Intents included | INT-…, INT-… |
| Spec versions | |
| Source commit | |
| Artifact identity (digest / package version) | |
| Environments | staging → production (or: delivered to client) |
| Risk tier (highest in this release) | |

## 2. Evidence
| Item | Link / result |
|---|---|
| Test report | |
| Security report (no unresolved critical finding) | |
| Review decisions (G7), incl. second approver where required | |

## 3. Deployment plan
- Stages: test → staging → (canary / shadow) → production
- Date / window:
- Monitoring dashboard:
- Data migrations and how they were validated:

## 4. Rollback
| Field | Value |
|---|---|
| Rollback target (last known good version) | |
| Rollback command / procedure | |
| Tested? (required for High+) | yes / no — date |
| If rollback is not possible: forward fix / compensation plan | |

## 5. AI disclosure for the client
<Short note: which parts AI helped with; that people reviewed and tested them. Japanese version if needed.>

## 6. G8 decision
| Role | Name | Decision | Date |
|---|---|---|---|
| Person B | | | |
| Business / security owner (Critical) | | | |

## 7. After release (observation window: 2 weeks)
| Item | Result |
|---|---|
| Incidents / rollbacks / serious defects | |
| Outcome vs success metrics in the Intent Record | |
| Counted as production-qualified (PQC)? | yes / no |
| Lessons (gates, rework, agent assumptions) | |
| Follow-up intents | |
```

---

## Version history

| Version | Date | Author | Notes |
|---|---|---|---|
| 0.0 | 2026-09-24 | — | Skeleton |
| 0.1 | 2026-09-24 | Claude (draft) | First content |
