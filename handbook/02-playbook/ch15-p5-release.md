# Chapter 15. P5 — Release (G7, G8)

> Readers: **Person B, Person A, PM/BrSE, developers** · Reading time: about 15 minutes
> Status: **Draft 0.2**, awaiting Harry's comments.
> Section 15.10 (platform usage) is written by Claude Code together with the platform code.

---

## 15.1. Purpose

- Accept a change into the product only after an **independent human review** (G7).
- Release to production only with a **known rollback**, an **approval bound to the exact artifact**, and **disclosure to the client** (G8).
- Learn from each release.

## 15.2. Scope

From a verified pull request (G6 passed) until the change is live, observed for the observation window, and the task is closed.

---

## 15.3. Roles

| Role | In P5 |
|---|---|
| Person B | Reviews and merges (G7); approves the production release (G8) |
| Second approver | Required for the changes listed in 15.5, Step 2 |
| Person A | Prepares the release record, rollback plan and release notes; answers review questions |
| PM / BrSE | Writes the AI disclosure note for the client (in Japanese if needed); coordinates the client's acceptance |
| Release / operations agents | Build the package, draft notes, run the release checklist, watch health after release |

---

## 15.4. Principles

1. **Every merge into a protected branch is HITL** — at every risk tier.
2. **The producer never approves.** Neither the producing agent nor Person A (as producer) approves or merges.
3. **Approvals are bound to the exact version** (commit for G7; artifact digest for G8). A new commit after approval needs a new approval.
4. **No release without a tested way back.**
5. **Always tell the client when AI took part** (Chapter 2, Rule 6).

---

## 15.5. Steps

### Step 1 — Prepare the review

Person B receives a **decision packet**: intent, risk tier, scope, diff, spec and ADR links, verification summary and evidence, unresolved issues, cost, rollback plan, the agent's summary and assumptions.

### Step 2 — Gate G7: review and merge

Person B checks:

| Area | Question |
|---|---|
| Intent and domain | Does it do what the intent and spec say, following the business rules? |
| Architecture | Does it follow the ADR and architecture rules? |
| Scope | Nothing outside the approved plan? |
| Compatibility | Backward compatible, or the break was approved at G3? |
| Security | Findings resolved or formally accepted? |
| Quality | Maintainable; tests adequate; no weakened checks |
| Operations | Rollback possible; monitoring in place |

Depth of review by type of change:

| Change type | Review |
|---|---|
| Documentation, formatting, internal refactoring, test-only | **Light review** by Person B (still HITL) |
| Business logic, APIs, persistence, integrations, authentication, configuration | **Full review** by Person B |
| Data migration, payment, personal data, production infrastructure, breaking change, safety-related function | **Dual approval** at **every risk tier**: Person B **and** a second approver (security owner, architect or leadership) — decision: Harry, 2026-09-24 |

Decisions: approve and merge / request changes (back to P3) / reject (back to G3 or G1).

### Step 3 — Prepare the release (template T14)

The **release record** contains: release ID; artifact digest; source commit; spec version; test and security evidence; approvals; deployment policy; rollback target and command; monitoring dashboard; **AI disclosure note for the client**.

Release in stages that fit the risk:

```text
test environment → staging → (shadow or canary where available) → production
```

For projects where we do not deploy (the client deploys), the release record goes with the delivery package and the client decides on production.

### Step 4 — Gate G8: release

**Pass** when:
- the artifact is exactly the one approved at G7 (same commit, same digest);
- required checks passed;
- the rollback is possible and, for High+ risk, tested;
- monitoring is ready;
- data migrations were validated;
- the client disclosure note is ready;
- Person B approves (plus the business or security owner for Critical risk).

- Oversight: **production = HITL** at every tier. Non-production environments = HOTL within a bounded policy.
- An agent never deploys to production by itself.

### Step 5 — After release: observe and learn

- Watch the change for the **observation window of 2 weeks** (Chapter 8 §8.4). No rollback, incident or serious defect in that time → the change counts as **production-qualified**.
- Compare the outcome with the success metrics in the Intent Record.
- Record what went well and what did not: gate waiting times, rework loops, agent assumptions that were wrong.
- Update agent instructions, tests or policies where needed; propose changes through Chapter 6 §6.8.
- Close the task, or open a follow-up intent.

---

## 15.6. Mandatory artifacts

| Artifact | Template |
|---|---|
| Approved pull request with review decision | T2 |
| Release record (including rollback and client disclosure) | T14 |
| Post-release note (outcome, lessons) | Part of T14 |

---

## 15.7. Inputs and outputs

| Inputs | Outputs |
|---|---|
| Verified pull request; evidence; ADR; risk tier; rollback plan | Merged change (G7); release in production or delivery to the client (G8); release record; lessons learned; closed task |

---

## 15.8. Approval points

| Gate | Low | Medium | High | Critical |
|---|---|---|---|---|
| G7 | HITL, Person B | HITL, Person B | HITL, Person B | HITL, Person B + second approver |

Dual approval also applies at **any** tier for the change types listed in Step 2.
| G8 (production) | HITL, Person B | HITL, Person B | HITL, Person B | HITL, Person B + business/security owner |
| G8 (non-production) | HOTL | HOTL | HOTL | HITL |

---

## 15.9. Tools

| Need | Tool |
|---|---|
| Review and merge | GitHub PR review, branch protection, CODEOWNERS |
| Release record | Markdown (T14) in the repository or the release ticket |
| Staged release | The project's CI/CD; feature flags or canary where the project has them |
| Client disclosure | Release notes, delivery email or document cover page |

---

## 15.10. Using the platform

> To be written by Claude Code together with the platform code: G7 recording from PR reviews, G8 approval by CLI or comment, sealing the evidence pack, closing the intent.

---

## 15.11. Metrics

- Waiting time at G7 and G8 (warning: median first review above 2 hours).
- Change failure rate; rollback rate; defect escape rate.
- PQC rate after the observation window.
- Share of releases with a complete release record and client disclosure (target: 100%).

---

## 15.12. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Rubber-stamp reviews under time pressure | Decision packet; review depth by change type; review time measured |
| New commits slip in after approval | Approval bound to the commit / digest; branch protection "dismiss stale approvals" |
| Release without a working rollback | G8 requires it; tested for High+ risk |
| Client unaware that AI took part | Disclosure note required at G8 |
| Person B becomes a bottleneck | Chapter 19; backup reviewer |

---

## 15.13. References

**Related documents**
- Handbook: codes table §4; Chapters 2, 4, 5, 8, 14, 16, 18, 19; templates T2, T14.
- `design/D-02` (G7, G8 requirements), `design/D-05` (evidence packs).

---

## Version history

| Version | Date | Author | Notes |
|---|---|---|---|
| 0.0 | 2026-09-24 | — | Skeleton |
| 0.1 | 2026-09-24 | Claude (draft) | First content; platform usage section reserved for Claude Code |
| 0.2 | 2026-09-24 | Claude (draft) | Dual approval at G7 for migration, payment, personal data, production infrastructure, breaking change, safety function (Harry) |
