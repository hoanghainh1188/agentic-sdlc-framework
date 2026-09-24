# Chapter 6. Governance, escalation and incidents

> Readers: **leadership** (approval), PM/BrSE, Person A and Person B · Reading time: about 20 minutes
> Status: **Approved** (Harry, 2026-09-24) — version 1.1

---

## 6.1. Purpose

- Keep AI use under control **between** gates: who watches, who decides, how fast, and what happens when nobody answers.
- Handle incidents and changes to the rules in a predictable way.
- Keep governance **light enough for a small company**.

## 6.2. Scope

All projects using AI agents; all AI-related incidents; all changes to this handbook's policies, gates and autonomy levels. Security incidents also follow Chapter 3 §3.11.

---

## 6.3. Governance structure: two tiers

For our size we use **two** tiers (decision: Harry, 2026-09-24):

| Tier | Who | When | Decides | Looks at |
|---|---|---|---|---|
| **Leadership review** | Leadership (governance owner), handbook owner, one Person B in rotation | **Monthly**, and within 24 hours after any Critical incident | Policy changes, exceptions, raising autonomy, maturity stage, tool list, budget | Metrics (Chapter 8), incidents, overrides and exceptions, escalations past SLA, requests to raise autonomy |
| **Project stand-up** | Person A, Person B, PM/BrSE | Daily or weekly, by project size | Day-to-day agent operation, rework, lowering autonomy, escalations within the project's authority | Gate queue, alerts, budget, blocked work |

- Flow: policies and decisions go **down**; metrics, evidence, risks and escalations go **up**.
- Every quarter, the leadership review also re-reads Chapters 2 and 3 against recent cases.

### Policies that must exist


| Policy | Where |
|---|---|
| Approved tools, model usage, prompt and context privacy | Chapter 2 |
| Identity and access, least privilege, credential lifecycle | Chapter 3 |
| Data classification | Chapters 2 and 3 |
| Human approval, autonomy | Chapter 4 |
| Separation of duties | Chapter 5 |
| Escalation, incident response, change management, exceptions | This chapter |
| Retention and audit | Chapter 3 §3.9.3 |
| Artifact provenance | Part II (Chapters 10–17) |

---

## 6.4. Escalation

An escalation hands a decision to a person with **independent authority** — never back to the agent or the person who started the change.

### What triggers an escalation


| Trigger | Examples | Default response |
|---|---|---|
| Risky action | Production deploy, data deletion, permission change, sending data outside | HITL required |
| Uncertainty | Low confidence, missing facts, several reasonable solutions | Ask, or escalate |
| Out of scope | Tool, repository, data or budget outside the allow-list | Block or escalate |
| Disagreement | Validator and monitor give opposite results | Freeze |
| Unusual behaviour | Tool calls unlike the baseline, repeated errors, unusual data access | Pause + security review |
| Accumulated risk | Too many tool calls, too long, too costly | Pause |
| Time | Nobody acknowledged, or not resolved within SLA | Escalate to the next level |

Do not rely on the agent's own confidence alone.

### Response levels

| Level | What happens |
|---|---|
| **Observe** | Log only |
| **Notify** | The agent continues; Person A gets an alert or digest |
| **Pause** | No new actions; wait for a reviewer |
| **Contain** | Deny the action, revoke temporary credentials, isolate the session or roll back |
| **Incident** | Hand over to Person B or leadership; preserve logs; start the incident process (6.7) |

- Irreversible, permission-related or production-related actions **skip Notify** and go straight to Pause or Contain.
- These levels are named, not numbered, to avoid confusion with autonomy levels L0–L4.

### Escalation package

Every escalation carries enough information that the person does not have to start from scratch:

- task, agent, session, time; original goal and scope;
- the action waiting or just done; tools, resources and permissions involved;
- the trigger, reason and severity; confidence or conflicting hypotheses;
- the diff, command or payload; tests, scans and evidence so far;
- expected impact and whether it can be rolled back;
- the agent's recommendation (approve / modify / reject);
- deadline and next owner.

Template: T16 Escalation record.

### Who receives it

| Situation | First receiver | Decides |
|---|---|---|
| Unclear goal or business scope | Person A | Clarify intent, change scope |
| Code, test or architecture disagreement | Person B (or an independent reviewer) | Approve or require rework |
| Security, data exposure, permission change | Person B + security owner | Block, contain, revoke |
| Production incident | Person B + whoever operates the service | Pause, roll back, resume |
| Policy or autonomy change | Leadership | Change policy; never the agent |


### SLA

| Severity | Acknowledge within | Resolve or contain within | Notify |
|---|---|---|---|
| Critical | **15 minutes** | 1 hour (contain) | Leadership, Person A and B; client per contract |
| High | **1 hour** | Same working day | Leadership, Person A and B |
| Medium | **1 working day** | 3 working days | Person A and B |
| Low | **3 working days** | Next planned work | Person A |

Acknowledge times: codes table §6.3. Resolution times (decision: Harry, 2026-09-24). Two clocks always run: **acknowledgement** and **resolution**. Sending a message is not an acknowledgement.

---

## 6.5. When nobody responds

```text
Escalation created → acknowledgement timer starts
 → acknowledged? yes → owner handles it
 no → reminder → backup owner → leadership
 → still nothing at the resolution deadline?
 → block / roll back / open an incident
```

| Moment | Action | Agent state |
|---|---|---|
| Escalation created | Assign main and backup owner; record the time | Continues **only** actions already on the safe list |
| Acknowledge SLA almost over | Remind the owner on the main and a second channel | Slows down or stops risky actions |
| Acknowledge SLA missed | Move to the backup owner; tell the team lead | Freezes new actions |
| Missed again | Escalate to leadership (incident commander for Critical) | Blocked; session isolated or credentials revoked |
| Critical timeout | Start the incident process | Rolled back, or kept in a safe state (Chapter 18) |


Rules:
- **No answer never means "go ahead".** For sensitive actions the default is **deny or stay frozen**.
- An agent may continue after a timeout **only** for actions classified as safe in advance: read-only work, tests in a sandbox, unpublished drafts, collecting metrics, idempotent low-impact steps.
- An agent must stop for: production deploys, permission or credential changes, deleting or changing important data, sending data outside, changing policy or autonomy, financial or legal commitments, security issues, validator disagreements.
- If Person B does not answer, approval authority **never passes back** to the producing agent or to Person A.
- Automatic steps must be **idempotent**: running them again must not create more rollbacks, incidents or messages.

---

## 6.6. Resuming safely

"Approve" alone is not enough to resume. The decision must be bound to:

- the approved plan version, and the artifact or hash that was reviewed;
- the resource scope and the allowed actions;
- an expiry time, the approver, and new stop conditions.

If the plan, input, code or risk context changes after approval, the approval **expires** and the escalation starts again. Before resuming, the platform re-checks policy (preflight).

---

## 6.7. Incidents

An **AI incident** is any event where AI output or AI actions caused, or nearly caused, harm: wrong or invented information delivered, an agent acting outside its permissions, prompt injection, data sent where it should not go, model misuse, runaway cost.

This is the **single incident process** for the whole handbook. Security examples and security-specific points are in Chapter 3 §3.11; how staff report is in Chapter 2 §2.8.

| Step | What | Who |
|---|---|---|
| 1. Report | Within 15 minutes of noticing (Chapter 2 §2.8) | Anyone |
| 2. Contain | Stop the agent (kill switch **within 5 minutes**), revoke its tokens and keys, preserve evidence (Chapter 18) | Person A or B |
| 3. Classify and assess | Severity (codes table §6.3); what was accessed or changed; which clients are affected | Person B; leadership for Critical/High |
| 3b. Notify | Per the SLA table in §6.4; **the client** for Critical incidents, and for others when the contract requires it | Leadership / PM-BrSE |
| 4. Record | Template T9 | Person A |
| 5. Review | Blameless review within 48 hours | Person A, Person B; leadership for Critical/High |
| 6. Act | Fix, update rules, gates or training; lower autonomy if needed (Chapter 4 §4.10) | As agreed |

The incident record must include: classification; root cause; **which gate failed to catch it**; corrective action; prevention plan. For AI-specific incidents also: model and version, input context, analysis of the output, proposed new guardrail.

**Blameless** means: we fix the process first. People are not blamed for mistakes the process let through; hiding a mistake or bypassing a control is different (Chapter 5 §5.10).

---

## 6.8. Changing the rules

Any change to policies, gates, oversight defaults, autonomy levels or the tool list follows these steps:

| Step | Content |
|---|---|
| 1. Proposal | What changes and why (template T18) |
| 2. Impact assessment | Effect on risk, compliance, clients and the platform |
| 3. Review | Leadership review (monthly, or an extra meeting if urgent) |
| 4. Approval | Leadership, before the change takes effect |
| 5. Communication | Update the handbook, tell the teams, train if needed |

- **Lowering** autonomy or tightening a control can happen **immediately** (Person B or leadership) and is reviewed afterwards. **Raising** always follows all five steps.

---

## 6.9. Exceptions and break-glass

### Exceptions

An exception is a temporary, approved permission to depart from a rule. It must never become a permanent shortcut. Each exception records: owner · reason · scope · expiry · mitigation · end condition · approver.

- Approved by leadership; reviewed at every leadership review; expired exceptions are closed, not silently renewed.
- Overrides at gates follow Chapter 4 §4.9.

### Break-glass (emergencies)

When a production emergency needs access or actions outside normal rules:

| Requirement | Our rule |
|---|---|
| Short-lived | Maximum a few hours; expires automatically |
| Limited scope | Named systems and actions only |
| Not transferable | Only the named operator |
| Second approver | Required (leadership or Person B) |
| Creates an incident automatically | Yes |
| Immutable audit | Yes |
| Post-incident review | Mandatory, within 48 hours |
| Can be revoked immediately | Yes |

---

## 6.10. Decision records

Important decisions (gate approvals, overrides, exceptions, autonomy changes, incident decisions) are recorded with: decision id · work item · actor and actor type (human / agent / policy) · time · context digest · evidence · decision · confidence · policy applied · human override (if any) · impact · review date.

On the platform these are stored in the append-only audit log. Before the platform exists: GitHub reviews, the project AI record and the incident records (T9).

---

## 6.11. Roles and approval points

| What | Who |
|---|---|
| Leadership review | Governance owner (leadership) chairs |
| Project stand-up | Person A runs it |
| Escalation decisions | See "Who receives it" (6.4) |
| Incident severity Critical / High | Leadership |
| Rule changes, raising autonomy, exceptions, break-glass | Leadership |
| Lowering autonomy, freezing an agent | Person B or leadership, any time |

---

## 6.12. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Alerts are ignored (alert fatigue) | Few, meaningful triggers; digests for Notify; metrics on acknowledgement time |
| Nobody is available (holidays, one person with many roles) | Backup owner for every escalation; leadership as the last step; default = freeze |
| Governance becomes paperwork | Two tiers only; monthly review based on metrics and real cases |
| Exceptions pile up | Every exception has an expiry and is reviewed monthly |

---

## 6.13. References

**Related documents**
- Handbook: codes table §6.3; Chapters 2–5; Chapter 18; templates T9, T16, T18.

---

## Version history

| Version | Date | Author | Notes |
|---|---|---|---|
| 1.1 | 2026-09-24 | Harry | §6.7 is the single incident process (adds kill switch 5 min, client-impact assessment, client notification) |
| 1.0 | 2026-09-24 | Harry | Approved |
| 0.0 | 2026-09-24 | — | Skeleton |
| 0.1 | 2026-09-24 | Claude (draft) | First content |
| 0.2 | 2026-09-24 | Claude (draft) | Confirmed: two-tier governance (monthly leadership review, daily/weekly project stand-up); resolution SLAs |
