# Chapter 17. Reviewing AI output (creator ≠ verifier ≠ approver)

> Readers: **Person B, reviewers, testers, Person A** · Reading time: about 15 minutes
> Status: **Draft 0.1**, awaiting Harry's comments.

---

## 17.1. Purpose

- Make reviews of AI-produced work **real**: with evidence, criteria and the right to refuse.
- Keep "generated", "reviewed" and "approved" clearly separate.
- Catch the typical weaknesses of AI output before they reach the client.

## 17.2. Scope

Every artifact that AI created or materially influenced: requirements and specs, designs and ADRs, code, tests, infrastructure-as-code, documents for clients (including Japanese deliverables), release notes. Used at G2, G3, G6 and G7.

---

## 17.3. Generated, reviewed, approved

| State | Meaning | Recorded |
|---|---|---|
| **Generated** | AI created or materially influenced it | AI disclosure (template T2), tool and model |
| **Reviewed** | A person or an independent verifier checked it **against stated criteria** | Reviewer, scope, criteria, decision, time |
| **Approved** | A person with authority accepted it for the next stage | Approver, gate, version, time |

A typical path: `AI-generated → human-edited → automatically verified → human-reviewed → approved for merge → approved for release`.

Never write "reviewed" without: who, what scope, which criteria, what decision, when.

---

## 17.4. Principles

1. **Separate the creator, the verifier and the approver.** AI is never the only check on something AI produced.
2. **Review against criteria, not impressions.** Use the spec, the ADR and the checklists (T3, T4).
3. **The reviewer gets a decision packet** (Chapter 4 §4.5) and enough time. Reviewing without evidence or time is not a review.
4. **The reviewer can say no** without having to justify it to the producer's schedule.
5. **A fast artifact that needs heavy rework or causes incidents is fake productivity.** Measure it (17.8).

---

## 17.5. What to check, by artifact type

| Artifact | Check at least |
|---|---|
| Requirements / spec | Ambiguity; completeness; consistency; conflicts between stakeholders; testable acceptance criteria; traceability to the intent; owner approval. **Japanese source text kept and translation checked** |
| Architecture / ADR | Constraints covered; quality attributes; security impact; capacity assumptions; failure modes; migration impact; operational burden; cost; fit with the existing repository. Ask for the **assumption register and unknowns**, not just a nice diagram |
| Source code | Build and types; unit and integration tests; contract tests; static analysis; dependencies; secrets; authorisation; performance where relevant; migration and rollback; regressions |
| Tests | Do they test the **business behaviour** in the spec? Were any tests weakened, skipped or mocked away? |
| Infrastructure-as-code | Least privilege; network exposure; secrets referenced, not embedded; drift; cost; plan diff reviewed **before** apply |
| Documents for clients | Facts, numbers and names correct; nothing invented; terminology consistent with the glossary; Japanese checked by the PM/BrSE; AI disclosure included |

### Typical weaknesses of AI output

| Weakness | What to look for |
|---|---|
| Invented facts | References, APIs, library functions, numbers or names that do not exist |
| Confident but wrong | Clear, well-written text that contradicts the spec or the code |
| Silent assumptions | Behaviour the spec never asked for; missing edge cases filled with guesses |
| Scope creep | Changes to files or features outside the plan |
| Weakened checks | Tests changed to match the code; lint rules disabled; errors swallowed |
| Security shortcuts | Hard-coded secrets, broad permissions, missing input validation |
| Plausible duplication | New helpers that duplicate existing ones |

---

## 17.6. Checklist before accepting AI output

| Area | Questions |
|---|---|
| Origin | Which intent or requirement does it serve? Which tool and model produced it? Which context did it use? Is its version clear? |
| Quality | Are there pass/fail criteria? Did independent checks run? Security, dependency and licence checks? Regression and contract tests? |
| Responsibility | Who owns it? Who reviewed it, and do they have the right expertise? Who can approve or reject? |
| Operations | Where will it run? Is there a rollback? Is there monitoring? Can we trace from production back to the requirement and the evidence? |

If these cannot be answered, the artifact is **not ready** for production.

Detailed checklists: T3 (code), T4 (documents).

---

## 17.7. Definition of Done for AI-involved work

In addition to the project's usual definition of done:

- linked to a requirement or intent;
- AI involvement recorded;
- human changes in version control;
- automated verification passed; security and dependency scans passed;
- the right reviewer approved; no unresolved critical finding;
- a rollback plan exists for impactful changes;
- the release artifact is identified exactly (commit, digest);
- monitoring is ready.

---

## 17.8. Metrics ("AI debt")

- Acceptance rate of AI output; share changed during review; rework rate.
- Defect escape rate and rollback rate for AI-produced changes.
- Security findings per change; review time; agent retries.
- Incidents traced to AI-produced artifacts.
- Artifacts missing provenance (target: zero).

---

## 17.9. Roles and approval points

| What | Who |
|---|---|
| Review at G2 (High+), G3, G6 (High+), G7 | Person B (see codes table §4) |
| Second approval for sensitive change types at G7 | Second approver (Chapter 15) |
| Checklists T3, T4 maintained | Handbook owner, with input from reviewers |

---

## 17.10. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Reviewer fatigue as AI output grows | Oversight by risk; deterministic checks first; approval queues (Chapter 19) |
| Trusting well-written output | Review against criteria; typical-weakness list |
| The same model reviews its own output | Independent validators; human approver |
| Reviews without traceability | Reviewer, scope, criteria and decision always recorded |

---

## 17.11. References

**Related documents**
- Handbook: codes table §4; Chapters 4, 5, 11–15, 19; templates T2, T3, T4.

---

## Version history

| Version | Date | Author | Notes |
|---|---|---|---|
| 0.0 | 2026-09-24 | — | Skeleton |
| 0.1 | 2026-09-24 | Claude (draft) | First content |
