# Chapter 4. Autonomy levels, oversight modes and permissions

> Readers: **leadership** (approval), PM/BrSE, Person A and Person B on every project · Reading time: about 20 minutes
> Status: **Approved** (Harry, 2026-09-24) — version 1.0.
> Codes used here are defined in the [codes table](../00-introduction/05-codes.md) (§2–§4).

---

## 4.1. Purpose

- Decide **how much the AI may do** and **how people stay in control**, in a way that is the same on every project.
- Give AI more freedom **only where we can check it**, and take freedom back quickly when something goes wrong.

## 4.2. Scope

- Every AI agent and AI tool used for company or client work (Chapter 2 lists the approved tools).
- Every phase P1–P6 and every gate G1–G8.

---

## 4.3. Two separate questions

| Question | Answer | Codes |
|---|---|---|
| **What may the agent do?** | Its **autonomy level** | L0–L4 |
| **How are people involved in this action or gate?** | The **oversight mode** | HITL, HOTL, AUDIT |

Keep the two apart. A high autonomy level does not remove human oversight, and strict oversight does not stop the agent from doing useful work inside a sandbox.


---

## 4.4. Autonomy levels

| Level | Name | The agent may | The agent may not | Our use |
|---|---|---|---|---|
| **L0** | Assist | Suggest, summarise, draft, analyse | Change anything | Always allowed |
| **L1** | Execute in sandbox | Run code, tests and tools **inside an isolated workspace**, with no effect outside it | Push, open PRs, touch shared systems | Allowed |
| **L2** | Controlled change | Create changes that go through gates: push its own branch, open a PR, deploy to a test / staging environment | Merge, deploy to production | Allowed; **the pilot ceiling** |
| **L3** | Bounded autonomy | Handle bounded tasks inside a predefined policy: canary, low-risk remediation, rollback | Anything outside the policy | Only for **named task types**, from maturity Stage B, approved by leadership |
| **L4** | High-impact autonomy | Important production changes in a special, explicitly approved scope | — | **Not used** until leadership decides otherwise |

- Autonomy is tied to the **risk budget**, not to the agent. The same agent may work at L2 on documentation and at L0 on a production database.
- The platform grants the level **per run**, through the run contract; the agent cannot raise its own level.

### Maximum level by risk tier

| Risk tier | Maximum level |
|---|---|
| Low | L2 (L3 for named task types from Stage B) |
| Medium | L2 |
| High | L1 — the sandbox result is a **proposal**; a person takes it forward |
| Critical | L0 — the agent only advises and prepares plans or dry runs |

How to set the risk tier: score the task on impact, reversibility, data sensitivity, number of systems affected, degree of architecture change, possibility of data loss, external exposure, dependence on uncertain judgement, and criticality of the production target. Person A proposes the tier at G1; Person B can raise it at any time.

---

## 4.5. Oversight modes

### HITL — human in the loop

- **No valid result without a human decision.** The agent proposes; a person approves, changes or rejects **before** the action happens.
- A HITL decision is only real if the person has **evidence, time and the right to say no**. Clicking "Approve" out of habit is not HITL.
- The reviewer receives a **decision packet**: intent, risk, scope, diff, context sources, evidence, unresolved conflicts, cost, rollback plan, and the agent's recommendation.

### HOTL — human on the loop

- The agent acts **within policy**; a person watches and can pause, block, override or roll back.
- A dashboard alone is **not** HOTL. HOTL needs: fast enough visibility with context; clear escalation thresholds; the right to pause, revoke, roll back or override; alerts that are not ignored; an audit log; a runbook and response times.
- Without telemetry, a kill switch and the ability to revoke the agent's access, it is "autonomous execution", not controlled HOTL.

### AUDIT — audit only

- The agent acts; a person reviews **samples afterwards**.
- Only for repetitive, low-risk work that is easy to check and easy to undo (formatting, boilerplate, documentation updates, dependency updates in a sandbox).
- Needs a complete audit trail, a sampling plan and the ability to revert.
- Default sampling: **20%** in Stage A, 10% in Stage B, 5% in Stage C.

---

## 4.6. Choosing the oversight mode

Decide by the **action**, not by the agent. Ask:

- Is the action reversible?
- What is the blast radius?
- Is the data sensitive?
- Is the confidence and evidence sufficient?
- Who is accountable if it is wrong?

Simple rules:

| Situation | Mode |
|---|---|
| Hard to reverse, or the cost of a mistake is very high | **HITL** |
| Routine, can be rolled back, needs to scale | **HOTL** |
| The agent and a validator (test, scanner, reviewer agent) disagree on something critical | Switch to **HITL** |
| Risk rises or a policy is breached during a run | HOTL **escalates** to HITL |

In practice most projects run a **hybrid**: HOTL for day-to-day execution, HITL at approval gates, and HITL whenever there is an escalation, a disagreement or a change in risk.

### Common actions

| Action | Mode |
|---|---|
| Read code, run unit tests | HOTL |
| Format code, generate boilerplate, update docs | AUDIT |
| Open a pull request | HOTL (Low/Medium risk) or HITL (High+) |
| **Merge into a protected branch** | **HITL** |
| Deploy to a test / staging environment | HOTL with a bounded policy |
| **Deploy to production** | **HITL** |
| Scale a service within predefined limits | HOTL |
| **Change a production data schema** | **HITL** |
| **Infrastructure, IAM or security-boundary change** | **HITL** |
| **Anything that sends data outside the company** | **HITL** (and Chapter 2 rules) |
| Token budget at 80% / 100% | HOTL warning / HITL to continue |

The gate-by-gate defaults for each risk tier are in the codes table §4.

---

## 4.7. Forbidden actions

These are **never** allowed for an agent, at any level, and **no override** exists for them:

- Bypass or disable audit, logging, monitoring, gates, hooks or scans.
- Exfiltrate secrets or client data.
- Change its own permissions, policies or autonomy level.
- Approve an artifact it created.
- Act outside its risk budget or run contract.

These are forbidden **unless explicitly granted for that exact scope** by a HITL decision (Chapter 3, hard rules):

- Delete data; incompatible schema changes; IAM or security-boundary changes; production deploys with a large blast radius.

---

## 4.8. Veto rights

### Three moments to say no

| Moment | What people can do | Used for |
|---|---|---|
| **Before the action** | Approve or deny the proposed action (policy check, then HITL if required) | Production writes, migrations, sending data out, IAM changes, deploys, deletes, irreversible commands |
| **During the action** | Pause, cancel, roll back, revoke the agent's token, disable the agent | Any running agent — approval at the start is not enough |
| **After the action** | Reject the PR, revert the commit, roll back the release, quarantine the artifact, suspend the agent | Problems found late |


### Which concern wins

When checks disagree, a higher concern can block a lower one, never the reverse:

```text
1. Regulatory / safety / security
2. Authorisation / scope
3. Business intent / acceptance
4. Verification evidence
5. Artifact quality
6. Release readiness
7. Cost / speed / convenience
```

Example: code quality PASS, tests PASS, security policy FAIL → **BLOCK**.

---

## 4.9. Overrides

A human override is a **controlled exception**, not a way around every gate.

Every override must record:

| Field | Example |
|---|---|
| Requested by / approved by (two different people) | Person A / leadership |
| Gate or rule being overridden | Dependency scan at G6 |
| Reason and accepted residual risk | Emergency fix for a production outage |
| Scope | One release only |
| Expiry | Date and time |
| Rollback or containment plan | Required |
| Follow-up task to fix the cause | Ticket reference |

- Only people with **exception authority** may approve an override: leadership, or someone leadership names in writing.
- Not accepted as reasons: "approve anyway", "the deadline is too tight", "the agent has run many times without problems".
- Forbidden actions (4.7) cannot be overridden.
- Every override is written to the audit log and reviewed at the next governance meeting (Chapter 6).

---

## 4.10. Raising and lowering autonomy

| Change | Who decides | Conditions |
|---|---|---|
| Move a project or task type to a higher level or lighter oversight | Leadership (governance owner) | Maturity stage conditions met (codes table §6.1); evidence from metrics (Chapter 8) |
| Allow L3 for a named task type | Leadership | Stage B or later; the task type has run at L2 without incidents; kill switch and rollback tested |
| Lower the level or tighten oversight | **Person B or leadership, immediately** | Quality-gate failure, governance breach, incident, or loss of trust |


- Lowering is always allowed and never needs a meeting. Raising always needs evidence.
- Record every change in the project AI record and the audit log.

---

## 4.11. Roles and approval points

| What | Who |
|---|---|
| Risk tier of a task | Proposed by Person A at G1; Person B can raise it |
| Autonomy level for a run | Platform, from policy (risk tier + data class); never the agent |
| HITL approvals at gates | As in the codes table §4 (Person A: G1, G2 up to Medium risk; Person B: G2 and G6 for High+, G3, G7, G8) |
| HOTL monitoring | Person A (agent operator hat), or Person B by rotation |
| Overrides | Exception authority (leadership) |
| Raising autonomy | Leadership |
| Lowering autonomy | Person B or leadership, at any time |

---

## 4.12. Risks and mitigations

| Risk | Mitigation |
|---|---|
| "Rubber-stamp" approvals: HITL in name only | Decision packet; approval time and rejection rate measured; Person B has real authority to refuse |
| HOTL without real monitoring | HOTL only where telemetry, kill switch and revocation exist; otherwise HITL |
| Too many HITL gates create a queue | Oversight follows risk; approval queues (Chapter 19) |
| Autonomy raised too early | Stage entry conditions; lowering is immediate |
| HOTL used to avoid separation of duties | The producer never approves or deploys its own work, in any mode |

---

## 4.13. References

**Related documents**
- Handbook: codes table §2–§4, §6; Chapter 3 (hard rules); Chapter 5 (2+N); Chapter 6 (escalation).

---

## Version history

| Version | Date | Author | Notes |
|---|---|---|---|
| 1.0 | 2026-09-24 | Harry | Approved |
| 0.0 | 2026-09-24 | — | Skeleton |
| 0.1 | 2026-09-24 | Claude (draft) | First content |
