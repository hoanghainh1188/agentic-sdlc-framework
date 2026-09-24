# T17 Readiness assessment checklist

> Status: **Draft 0.1**, awaiting approval

| Item | Value |
|---|---|
| Use when | Before a team or project starts using AI agents; again after a serious incident or degradation |
| Filled by | PM or team lead, with the team (about half a day); reviewed by leadership |
| Stored in | `docs/project/readiness-YYYY-MM-DD.md` |
| Related | Chapter 9 §9.6 (Go / Conditional Go / No-Go) |
| Rules | [Chapter 9](../01-policy/ch09-adoption-roadmap.md) |

---

Score each dimension from 1 to 5: 1 = not ready · 2 = partly ready · 3 = minimum ready · 4 = advanced · 5 = exemplary.

## Scoring sheet

| Dimension | Weight | Questions | Evidence | Score (1–5) | Weighted |
|---|---|---|---|---|---|
| D1 People and skills | 20% | Person A and B named? Trained (Ch.9 §9.8)? Backup reviewer? | | | |
| D2 Governance | 20% | AI record filled? Client consent recorded? Gates and oversight agreed? | | | |
| D3 Technical infrastructure | 15% | CI, branch protection, secret and dependency scanning? | | | |
| D4 Process discipline | 15% | Specs with acceptance criteria? PRs reviewed today? | | | |
| D5 Security posture | 15% | MFA, access review, incident contacts, Ch.3 checklist? | | | |
| D6 Knowledge assets | 10% | Requirements, designs, conventions written where agents can read them? | | | |
| D7 Change readiness | 5% | Team willing? Concerns known and addressed? | | | |
| **Overall** | 100% | | | | |

## Result

| Tier | Condition | Decision |
|---|---|---|
| Tier 1 | Overall ≥ 3.5 and no dimension below 3.0 | Go |
| Tier 2 | Overall ≥ 3.0 and at most one dimension below 3.0 | Conditional Go — fix the gap within 4 weeks |
| Tier 3 | Overall below 3.0, or two or more dimensions below 3.0 | No-Go — fix and reassess |

| Result | Gaps to fix | Owner | Due | Reviewed by leadership (name, date) |
|---|---|---|---|---|

---

## Version history

| Version | Date | Author | Notes |
|---|---|---|---|
| 0.0 | 2026-09-24 | — | Skeleton |
| 0.1 | 2026-09-24 | Claude (draft) | First content |
