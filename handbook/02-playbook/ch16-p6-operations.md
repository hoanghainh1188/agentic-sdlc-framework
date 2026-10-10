# Chapter 16. P6 — Operations and maintenance

> Readers: **developers, Person A, Person B, PM / BrSE** (maintenance contracts) · Reading time: about 15 minutes
> Status: **Draft 0.2**, awaiting Harry's comments.
> Section 16.9 (platform usage) is written by Claude Code together with the platform code.

---

## 16.1. Purpose

- Use agents to **watch, analyse and propose** in production, while people keep control of every production change.
- Feed what we learn in operations back into specs, tests, agent instructions and policies.

## 16.2. Scope

Systems we operate or maintain after release, including maintenance contracts with Japanese clients (保守・運用). There is no separate gate in P6: **every production change starts again at G1** (Chapter 10 §10.6).

---

## 16.3. Roles

| Role | In P6 |
|---|---|
| Operations agent | Watches alerts, groups incidents, analyses logs and traces, compares with the baseline, proposes remediation, prepares patches and rollback plans, tracks drift |
| Person A | Service owner on the project; decides on non-critical actions; opens intents for fixes |
| Person B | Incident commander for Medium and High incidents; approves production changes |
| Leadership | Incident commander for Critical incidents |
| PM / BrSE | Client communication, maintenance-contract SLAs, incident reports to the client |

---

## 16.4. What agents may and may not do in operations

| Agents may (HOTL or AUDIT) | Agents may not, unless explicitly granted (HITL) |
|---|---|
| Triage and group alerts; summarise incidents | Change production data or configuration |
| Read logs, metrics and traces (read-only, masked where needed) | Deploy, restart or scale beyond a predefined policy |
| Compare with the baseline; detect drift | Apply a fix directly to production |
| Draft a remediation record and a patch on a branch | Change permissions, secrets or security settings |
| Prepare a rollback plan | Contact the client |

- An agent never fixes production beyond its risk budget. Bounded remediation (L3) is only allowed for **named task types**, from maturity Stage B, with leadership approval (Chapter 4 §4.4).
- Production data read by agents follows the data classes (Chapter 2). Personal data stays masked.

---

## 16.5. Steps

### Step 1 — Detect and triage

- Alerts go to the operations agent and to Person A.
- The agent groups related alerts, estimates impact and suggests a severity.
- **A person confirms the severity.** Incidents follow Chapter 6 §6.7 and Chapter 3 §3.11 (security).

### Step 2 — Analyse and propose (remediation record, template T15)

Every proposed remediation contains:

| Field | Content |
|---|---|
| Symptom | What is observed |
| Hypothesis | Likely cause |
| Evidence | Logs, traces, metrics, diffs supporting it |
| Proposed action | Fix, rollback, configuration change, workaround |
| Expected effect | What should change, and how we will see it |
| Risk | What could go wrong |
| Rollback | How to undo the action |
| Verification | How we confirm it worked |

### Step 3 — Decide and act

| Situation | Path |
|---|---|
| Emergency, service down | Contain first (Chapter 18); break-glass if needed (Chapter 6 §6.9); then a normal intent for the permanent fix |
| Urgent fix | Fast lane: G1–G3 in one short review; Person B approves; still G6–G8 |
| Normal fix or improvement | Normal intent from G1 |
| Named, pre-approved task type at L3 (Stage B+) | Agent acts within the policy; HOTL; post-run audit |

### Step 4 — Learn

- After each incident and each month: what did the agent get right or wrong?
- Update tests, monitoring, specs, agent instructions or policies (changes through Chapter 6 §6.8).
- Feed recurring issues into the backlog as intents.

---

## 16.6. Maintenance contracts with Japanese clients

- **Ask the client separately** whether AI may be used on **production logs and data**, and record the answer in the project AI record (Chapter 2 §2.5). Many contracts treat them more strictly than source code. Until answered: no AI on production logs or data (decision: Harry, 2026-09-24).
- Align our incident severity and response times with the contract's SLA. When the contract is stricter, **the contract wins**.
- Monthly maintenance reports to the client include AI involvement (Chapter 2, Rule 6).

---

## 16.7. Mandatory artifacts

| Artifact | Template |
|---|---|
| Remediation record | T15 |
| Incident record (when there is an incident) | T9 |
| New intent for each production change | T1 |

---

## 16.8. Inputs, outputs and approval points

| Inputs | Outputs |
|---|---|
| Alerts, logs, metrics, traces, user reports, client tickets | Remediation records, incidents handled, new intents, lessons learned |

Approval points: production changes follow G1–G8 (fast lane for urgent fixes). Containment actions follow Chapter 18.

---

## 16.9. Using the platform

> **Platform usage section, owned by Claude Code** (CLAUDE.md "Documentation rules"). Written 2026-10-09 (docs review E2).

The v0.1 platform has no feature made for operations and maintenance alone. An agent takes part in P6 the same way as in P3 to P5: a **remediation is an intent** (§16.5), with a spec, a plan and the eight gates; the agent never acts in production (§16.4; the agent register allows `sandbox` only, Chapter 20 §20.5b). What the platform gives P6 today:

| Need in P6 | On the platform | Where |
|---|---|---|
| Stop an agent that behaves unexpectedly | The kill switch, within minutes; its escalation | Chapter 18 §18.8d |
| Loops and runs that make no progress | Loop detection stops the run; G5 raises an escalation | Chapter 18 §18.8d, Chapter 13 §13.10.5 |
| What a run did, for an incident review | The run's events and the model-call traces (codes, counts, hashes; the prompts in Langfuse when `observability` is on) | Chapter 18 §18.8c |
| Cost of the agents' work per project or intent | `sdlc cost report` | Chapter 19 §19.8c |
| Evidence of a released change | The sealed Evidence Pack of the intent | Chapter 15 §15.10.2 |
| Production data for an operations task | Only what the project AI record allows (`prod_logs_allowed`); the platform refuses an intent whose data class the record does not allow | Chapter 19 §19.8b, Chapter 2 §2.5 |

Not on the platform yet: the incident module and the remediation record (template T15 stays a document), automatic rollback and containment, and the observation window metrics (D-02 §4.2, Later).

---

## 16.10. Metrics

- Mean time to recover (MTTR); change failure rate.
- Share of agent-proposed remediations accepted without major change.
- Alerts per week that needed a human, and time to acknowledge.
- Incidents caused by AI-produced changes.

---

## 16.11. Risks and mitigations

| Risk | Mitigation |
|---|---|
| The agent acts on production during a stressful incident | Hard rules (Chapter 3); HITL for any production change |
| Wrong diagnosis accepted quickly | Remediation record with evidence; Person B decides for Medium+ |
| Client data in logs sent to external AI | Data class for production data in the AI record; masking |
| Lessons are never applied | Monthly learning step; changes tracked through Chapter 6 |

---

## 16.12. References

**Related documents**
- Handbook: Chapters 2, 3, 4, 6, 10, 18, 20; templates T1, T9, T15.

---

## Version history

| Version | Date | Author | Notes |
|---|---|---|---|
| 0.0 | 2026-09-24 | — | Skeleton |
| 0.1 | 2026-09-24 | Claude (draft) | First content; platform usage section reserved for Claude Code |
| 0.2 | 2026-09-24 | Claude (draft) | Separate client consent for AI on production logs and data (Harry) |
| 0.3 | 2026-10-09 | Claude Code (docs review E2) | §16.9: what the platform gives P6 today (a remediation is an intent; the kill switch, loop detection, run events, the cost report, the Evidence Pack, the AI record) and what is not built yet |
