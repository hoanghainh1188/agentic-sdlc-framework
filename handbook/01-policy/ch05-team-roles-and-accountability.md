# Chapter 5. Team model (2+N), roles and accountability

> Readers: **leadership** (approval), PM/BrSE, every project team · Reading time: about 20 minutes
> Status: **Approved** (Harry, 2026-09-24) — version 1.0.

---

## 5.1. Purpose

- Make sure that **no single person or agent controls the whole chain** from definition to execution, evaluation, approval and release.
- Make it clear **who is accountable** when AI gets something wrong.
- Do this with the few people a small company has on each project.


## 5.2. Scope

Every project where AI agents produce work that we deliver or run: client projects and internal tools.

---

## 5.3. The 2+N team

```text
2 humans in control + N specialised AI agents
```

| Member | Main job | Can veto |
|---|---|---|
| **Person A** — owner / executor | Defines intent and scope, designs, resolves ambiguity, prepares or coordinates changes, operates the agents | Scope, requirements, design, business intent |
| **Person B** — independent reviewer / approver | Checks independently, settles disagreements, approves or rejects merge and release | Evidence, security, merge, release |
| **Agents 1..N** | Planning, coding, testing, security scanning, documentation, operations | Only the blocking rights policy gives them; never grant themselves permissions |

- Two people is the **minimum**, because one person must not validate their own work.
- A person can be Person A on one project and Person B on another. They can never be both on the **same** change.
- The PM/BrSE who talks with the Japanese client is often Person A.

### Choosing Person B

- Not working on the change they review.
- Senior enough to judge the evidence and to say no.
- Named at the start of the project, with a backup for holidays.
- Leadership names Person B for each project (Ch.1, decision 2b).

### Agent roles

| Agent role | Does | Must not |
|---|---|---|
| **Producer** (planner, coder, doc writer) | Reads, edits allow-listed files, runs tests, creates branches, opens PRs, creates evidence | Approve its own PR, merge, deploy to production, change the audit log |
| **Validator** (test, security, reviewer agent) | Runs independent tests and scans, gives a verdict | Edit what it reviews; rewrite the producer's evidence |
| **Release / operations agent** | Prepares packages and rollout plans, watches production, proposes rollback | Release or change production without the required human approval |

---

## 5.4. Who may do what


| Activity | Producer agent | Validator agent | Person A | Person B |
|---|---|---|---|---|
| Read requirements | ✅ | ✅ | ✅ | ✅ |
| Propose a plan | ✅ | May challenge | Approves scope | Reviews |
| Edit code | ✅ within allow-list | ❌ | ✅ if assigned | ❌ while reviewing |
| Run tests | ✅ | ✅ independently | May request | May request |
| Create / change evidence | Creates own | ❌ never edits producer's evidence | May add | ❌ |
| Approve the PR | ❌ | ❌ | ❌ if producer | ✅ as reviewer |
| Merge | ❌ | ❌ | ❌ if producer | ✅ when gates pass |
| Deploy to production | ❌ | ❌ | ❌ by default | ✅ only with release authority |
| Override a policy | ❌ | ❌ | ❌ | Only under the exception policy (Ch.4 §4.9) |
| Raise autonomy | ❌ | ❌ | Proposes | Leadership decides |

### Separation by phase

| Phase | Person A | Agents | Person B |
|---|---|---|---|
| P1 Requirements | Sets goal, scope, non-goals, risk (G1) | Planner clarifies ambiguity and gaps | Checks the scope is clear and valid; approves spec for High+ risk (G2) |
| P2 Analysis and design | Owns the design intent | Architect agent proposes options and trade-offs | Reviews risk independently; approves design (G3) |
| P3 Coding | Operates agents, watches budget and alerts (G5) | Producer edits in sandbox and allow-list; no merge or production credentials | — |
| P4 Testing | — | Test and security validators run independently; never edit what they check | Judges critical evidence (G6 for High+) |
| P5 Release | Prepares release notes and client disclosure | Release agent prepares package and rollout plan | Merges (G7); approves release (G8) |
| P6 Operations | Coordinates the response | Operations agent observes, proposes rollback | Incident commander for critical actions |
| Learning | Proposes improvements | Analyses failures | — (leadership decides autonomy and policy changes) |


---

## 5.5. How separation is enforced

Separation is enforced by **capabilities**, not by role names.

| Level | How | Today (before the platform) | With the platform |
|---|---|---|---|
| Tools | The producer has no merge or deploy tool; the reviewer has no edit tool on what it reviews | GitHub permissions, branch protection, CODEOWNERS | Per-role tool lists in the run contract |
| Environments | Development agents → sandbox; validators → test environment; production only through an approved deployment token | Separate accounts and environments | Sandbox per run; deployment tokens issued after G8 |
| Evidence | Every verdict records evaluator, role, artifact digest, policy version, evidence references, decision, reason, time. The producer cannot edit a validator's verdict; new evidence means a new verdict | PR reviews and CI results kept on GitHub | Append-only evidence and audit log |

---

## 5.6. Settling disagreements

When an agent, a validator or a person disagree:

```text
Disagreement → freeze the state → collect claims and evidence
→ Person B decides → Person A clarifies intent if needed
→ approve / reject / rework / exception
```

| Type of disagreement | Who decides |
|---|---|
| Critical safety or security | **BLOCK** until fixed or a valid exception exists |
| Business intent | Person A |
| Whether the evidence is sufficient | Person B |
| Architecture | Person A + an independent reviewer (Person B or an architect) |
| Policy | Leadership (governance owner) |

- **No majority vote** on critical blockers. Two agents saying PASS and one security validator saying FAIL → **BLOCK**.
- Order of priority when concerns conflict: see Chapter 4 §4.8.

---

## 5.7. When there are not enough people

In a small company, some projects have **only one engineer**. Then true separation of duties does not exist, and we **must not pretend it does**.

Use **compensating controls** (decision: Harry, 2026-09-24):

| Control | How we apply it |
|---|---|
| Borrow Person B from another project | **First choice.** Leadership names a reviewer from another team |
| Mandatory automated tests and scans | Always on (G6) |
| Protected branch | Always on; no self-merge |
| Time-delayed merge | The merge waits at least 1 working day, so a second person can look |
| Independent review after the action | A sample of changes reviewed later by someone outside the project |
| Dual authorisation for critical actions | Any Critical-risk action still needs a second person, from anywhere in the company |
| Append-only audit log | Always on |
| Temporary exception with an expiry date | Recorded in the project AI record; reviewed monthly |

- A one-person project is limited to **Low and Medium risk** work with AI agents. High and Critical risk work needs a real Person B. (decision: Harry, 2026-09-24).
- These controls reduce risk; they are **not equal** to full independence.

---

## 5.8. Role catalogue ("hats")

Agentic delivery uses more roles than a small company has people. Treat them as **hats** that Person A, Person B or leadership wear.

| Hat | Worn by |
|---|---|
| Product owner, domain expert, tech lead / architect | Person A |
| Intent engineer (writes intent and spec for agents) | Person A |
| Agent engineer (builds and tunes agents, SKILL.md) | Person A (or a shared platform engineer) |
| Agent operator / agent supervisor (budget, timeouts, alerts) | Person A; Person B by rotation |
| Human reviewer, HITL reviewer, QC lead | Person B |
| Security / privacy owner, security reviewer | Person B, or a shared security person |
| Incident commander | Person B; leadership for Critical |
| Governance owner, AI governance officer | Leadership (part-time) |
| Agentic PM, Bridge SE (client interface, Japanese) | PM / BrSE |


---

## 5.9. RACI

R = does the work · A = accountable for the result · C = consulted · I = informed.

| Activity | Person A | Person B | Agents | Leadership | Client (via PM/BrSE) |
|---|---|---|---|---|---|
| Intent Record and risk tier (G1) | A, R | C | R (draft) | I | C |
| Specification (G2) | A (B for High+) | C / A for High+ | R (draft) | — | C |
| Design and plan (G3) | R | **A** | R (options) | — | I |
| Run agents, watch budget (G4–G5) | A, R | I | R | — | — |
| Verification evidence (G6) | C | **A** | R | — | — |
| Merge (G7) | C | **A, R** | — | — | — |
| Release to production (G8) | R (notes, disclosure) | **A** | R (package) | I (C for Critical) | I |
| Incident handling | R | A (Medium/Low) | R (containment) | A (Critical/High) | I per contract |
| Exceptions and overrides | C | C | — | **A** | I if it affects them |
| Raising autonomy | C (proposes) | C | — | **A** | — |
| Project AI record | A, R | C | — | I | C (gives consent) |


---

## 5.10. Accountability when AI gets it wrong

- **The AI is never accountable.** A named person always is.
- **The person who approved at the gate is accountable for that decision**, based on the evidence available at the time.
- Person A is accountable for the intent, scope and risk tier they set. Person B is accountable for what they approved. Leadership is accountable for exceptions it granted and for the autonomy levels it allowed.
- An approver who was **not given** enough evidence or time is not blamed for missing what they could not see; the process is fixed instead (blameless review, Chapter 6).
- Hiding a mistake, bypassing a control, or approving without looking **is** a personal failure (Chapter 2).

---

## 5.11. Checking that separation works

Track at least:

- self-approval attempts; PRs where producer = reviewer;
- unauthorised tool calls; agents with more permissions than their role;
- critical blockers overridden; overrides and exceptions past their expiry;
- time to settle disagreements; rollbacks after approval;
- artifacts without evidence.

Targets that are **always zero**: self-approvals, unauthorised production changes, ability to change the audit log.

---

## 5.12. Anti-patterns

| Anti-pattern | Why it is dangerous | Fix |
|---|---|---|
| One person coordinates, reviews and releases everything | All responsibility and power in one place | Separate Person A and Person B |
| The coding agent runs its own "security review" | Not independent | A separate, read-only validator |
| The reviewer agent can edit | It can fix or fake evidence | Separate edit and approve capabilities |
| Many agents sharing one token | 2+N only on paper | Separate tokens, roles and tool boundaries |
| The human only clicks "approve" | No real judgement | Decision packet and a real right to reject |
| Majority vote unblocks a critical issue | Security can be outvoted | Non-overridable blockers |
| Overrides without expiry | Exceptions become permanent rights | Scope, expiry, reason, rollback |
| The agent raises its own autonomy after a few passes | No governance | Leadership decides |


---

## 5.13. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Not enough senior people to act as Person B | Share Person B across projects; limit AI use on one-person projects (5.7) |
| Person B becomes a bottleneck | Oversight follows risk; approval queues (Chapter 19); backup reviewer |
| Roles confused when one person wears many hats | Hats listed per project in the AI record; the platform checks SoD at each gate |

---

## 5.14. References

**Related documents**
- Handbook: codes table §5; Chapter 4; Chapter 6.

---

## Version history

| Version | Date | Author | Notes |
|---|---|---|---|
| 1.0 | 2026-09-24 | Harry | Approved |
| 0.0 | 2026-09-24 | — | Skeleton |
| 0.1 | 2026-09-24 | Claude (draft) | First content |
| 0.2 | 2026-09-24 | Claude (draft) | Confirmed: one-person projects (borrowed Person B, 1-day delayed merge, Low/Medium risk only) |
