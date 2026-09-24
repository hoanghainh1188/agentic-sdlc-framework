# Chapter 12. P2 — Analysis and design (G3)

> Readers: **Person A, Person B, tech leads, developers** · Reading time: about 15 minutes
> Status: **Approved** (Harry, 2026-09-24) — version 1.0.

---

## 12.1. Purpose

- Choose **how** to solve the approved specification, with the trade-offs visible.
- Break the work into **small, checkable tasks** that agents can execute safely.
- Get an independent approval (G3) before any agent changes code.

## 12.2. Scope

From an approved specification (G2) until G3 passes.

---

## 12.3. Roles

| Role | In P2 |
|---|---|
| Person A | Owns the design intent; picks or adjusts the option; writes or accepts the plan |
| Person B | Reviews risk independently; **approves G3** (HITL from Medium risk) |
| Agents | Read the architecture context; propose options and trade-offs; draft the ADR, threat notes and the task plan; never approve |
| Security owner | Consulted when the security boundary, data or access changes |

---

## 12.4. Steps

### Step 1 — Understand the current system

Agents read (within the data-class rules):
- the approved specification;
- the repository and existing architecture documents and ADRs;
- dependencies, operational constraints, security and compliance requirements.

They list the **affected components** and anything unclear.

### Step 2 — Generate options

- Ask for **two or three** independent options, not one answer. Useful viewpoints: architecture, security, reliability, cost/performance, domain fit, and a deliberate critic.
- Each option states: the decision, alternatives considered, trade-offs, assumptions, risks, failure modes, migration plan, rollback plan.
- **Do not choose by majority.** The right option depends on constraints and consequences, not on how many agents prefer it. Person A chooses; Person B challenges.

### Step 3 — Record the decision (ADR, template T12)

| Field | Content |
|---|---|
| Decision and context | What we decided and why it was needed |
| Options and selected option | With the reason |
| Rejected options | With the reason |
| Trade-offs | What we give up |
| Security impact | Data, access, boundaries |
| Operational impact | Monitoring, performance, cost |
| Rollback strategy | How to undo it |
| Approvers | Person B (and others when required) |

Write an ADR for every **significant** decision. Small internal changes may just note the approach in the task plan.

### Step 4 — Plan and break down the work (task plan, template T13)

Each task in the plan has:

| Field | Why |
|---|---|
| Input and output | What the agent starts from and must produce |
| Owner agent | Which agent role does it |
| Tool permissions | Only what the task needs (Chapter 3) |
| Files or path patterns allowed | Used by G5 to detect scope drift |
| Dependencies | Order of work |
| Definition of done | Linked to acceptance criteria |
| Budget and timeout | Tokens, iterations, time (Chapter 8) |
| Required evidence | Tests, scans, documents |
| Escalation condition | When the agent must stop and ask |

A good plan can be **resumed and retried**. Never let an agent change the whole repository without checkpoints.

### Step 5 — Gate G3: design and plan approved

**Full approval (HITL) is required** when the change involves any of:
- a database migration or a change of data model;
- a breaking API or event contract;
- a new service boundary;
- a security-boundary or access change;
- a change of which system owns the data (system of record);
- a production infrastructure change;
- a change to a core business rule (invariant).

**A lighter path (HOTL)** is enough for low-risk work such as: internal refactoring, additive endpoints, documentation, test-only changes.

- Oversight by risk tier: Low → HOTL; Medium, High, Critical → HITL by **Person B**. The list above forces HITL even for Low risk.
- The approval is bound to **the plan version and its hash**. If the plan changes (new files, new tasks), G3 is repeated.
- Evidence: ADR version, impact analysis, assumption register, security notes, the approval record, the plan hash.

---

## 12.5. Mandatory artifacts

| Artifact | Template | When |
|---|---|---|
| ADR | T12 | Every significant decision |
| Task plan | T13 | Every task that agents will execute |
| Impact analysis and security notes | Part of T12 | When data, access or boundaries change |
| Migration and rollback plan | Part of T12 / T13 | When data or interfaces change |

---

## 12.6. Inputs and outputs

| Inputs | Outputs |
|---|---|
| Approved specification (G2), repository, existing ADRs, dependency map, constraints | Approved ADR(s) and task plan (G3); list of allowed files per task; budgets and escalation rules |

---

## 12.7. Approval points

| Gate | Low | Medium | High | Critical |
|---|---|---|---|---|
| G3 | HOTL (HITL if the forced list applies) | HITL, Person B | HITL, Person B | HITL, Person B (+ security owner when relevant) |

---

## 12.8. Tools

| Need | Tool |
|---|---|
| Options, ADR drafts, diagrams | Approved AI tools (Chapter 2) |
| ADR and plan storage | Markdown in the repository (`docs/adr/`, `.sdlc/plans/`) |
| Plan enforcement | Branch protection and review (before the platform); run contract and G5 checks (platform) |

---

## 12.9. Metrics

- Share of plans that pass G3 the first time.
- G5 scope-drift events per task (a sign the plan was too narrow or unclear).
- Tasks returned from P3/P4 to G3.
- Waiting time at G3.

---

## 12.10. Risks and mitigations

| Risk | Mitigation |
|---|---|
| The agent's first idea is accepted without alternatives | Two or three options required for significant decisions |
| Popular option wins over the right one | No majority vote; Person A chooses, Person B challenges |
| Plan too broad; agent changes everything | Allowed files per task; G5 blocks changes outside them |
| Hidden migration or security impact | Forced-HITL list; security owner consulted |
| Plan changes after approval | Approval bound to the plan hash; change → G3 again |

---

## 12.11. References

**Related documents**
- Handbook: codes table §4; Chapters 3, 4, 5, 8, 10, 11, 13; templates T12, T13.
- `design/D-03` (run contract, allowed files), `design/D-05` (plans table).

---

## Version history

| Version | Date | Author | Notes |
|---|---|---|---|
| 1.0 | 2026-09-24 | Harry | Approved |
| 0.0 | 2026-09-24 | — | Skeleton |
| 0.1 | 2026-09-24 | Claude (draft) | First content |
