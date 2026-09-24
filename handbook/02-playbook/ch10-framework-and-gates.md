# Chapter 10. The framework: 6 phases, 8 gates, oversight by risk

> Readers: **PM/BrSE, developers, testers, Person A and Person B** · Reading time: about 20 minutes
> Status: **Approved** (Harry, 2026-09-24) — version 1.0.
> Codes: [codes table](../00-introduction/05-codes.md). Policies behind this chapter: Chapters 2–6.

---

## 10.1. Purpose

- Give every project **one common way** to run work with AI agents, from request to production.
- Explain the difference between **doing work** (steps) and **deciding whether work may continue** (gates).
- Show how the same gates apply to Agile, Waterfall and hybrid projects.

## 10.2. Scope

Every task where an AI agent produces or changes something we deliver or run. Chapters 11–16 describe each phase in detail.

---

## 10.3. The big picture

![6 phases and 8 gates](../../diagrams/svg/d1-overview-6-phases.svg)

| Phase | Main question | Gates | Mandatory records |
|---|---|---|---|
| P1 Requirements | What problem, and how do we know it is solved? | G1, G2 | Intent Record (T1), specification |
| P2 Analysis and design | How will we solve it, and in which steps? | G3 | ADR (T12), task plan (T13) |
| P3 Coding | Is the agent doing only what was approved? | G4, G5 | Code on an isolated branch, linked to requirements |
| P4 Testing | Is there independent evidence that it works? | G6 | Test and scan evidence |
| P5 Release | Do we accept it, and should it go live? | G7, G8 | Pull request (T2), release record (T14) |
| P6 Operations | Is it working in production? | — (changes start again at G1) | Remediation record (T15) |

How strictly each gate is checked depends on the task's **risk tier**: see the codes table §4. In short:
- **G1, G7 and G8 for production** are always approved by a person (HITL).
- **G2, G3 and G6** get a lighter check for low-risk work and a full approval for higher risk.
- **G4 and G5** are automatic policy checks; a person steps in when a limit is breached.

---

## 10.4. Steps and gates are different things

| | Step | Gate |
|---|---|---|
| Question | What work needs to be done? | May the work continue, or may this action happen? |
| Nature | An activity that produces something | A decision that allows, blocks, pauses or escalates |
| Done by | Agent, service, CI or a person | Policy check, verifier or approver |
| Result | An artifact or a new state | Allow, deny, pause, approve, or allow with conditions |
| Can be retried? | Usually yes | Only re-evaluated when its inputs or the policy change |
| Audit | Yes | **Always** — every gate decision is recorded |
| Example | "Generate tests", "run the build", "open a PR" | "Tests must pass before merge", "no changes outside the plan" |

Example of steps and their gates:

| Step | Gate before it continues |
|---|---|
| Write the specification | Does it have testable acceptance criteria, and did the owner approve it? |
| Write the design and plan | Does it touch the database, APIs or security boundary? If so, is there a design approval? |
| Run the coding agent | Does the agent have a valid run contract and the right permissions? |
| Write to the repository | Are the branch, files and budget within policy? |
| Run CI | Did tests, scans and checks pass? |
| Open the PR | Is the evidence tied to the right commit? |
| Merge | Did Person B approve **this exact version**? |
| Deploy | Is the artifact the approved one, is rollback ready, did the release owner approve? |

### Rules for gates

1. Name steps with verbs (`CreateSpec`, `RunTests`); name gates as conditions (`SpecApproved`, `PathInScope`).
2. A gate that says **no must actually stop** the action, not just write a log line.
3. An approval is bound to **the exact version** reviewed (commit, file hash, plan version). If the input changes, the gate is evaluated again.
4. Approvals **expire** and can be revoked.
5. Every gate decision records who or what decided, when, on which evidence.
6. Nothing — not the agent, not the workflow engine — may skip a gate.
7. If a gate cannot be evaluated (a system error), the result is **pause**, never "pass".

---

## 10.5. Roles in the flow

| Role | In this flow |
|---|---|
| Person A | Owns the task from intent to release preparation; operates the agents; approves G1 and G2 (Low/Medium) |
| Person B | Independent reviewer; approves G2 (High+), G3, G6 (High+), G7, G8 |
| Agents | Draft, analyse, code, test, document inside their permissions; never approve |
| PM / BrSE | Client communication, Japanese ↔ English, client consent and disclosure |
| Leadership | Exceptions, autonomy changes, Critical incidents |

Details: Chapter 5.

---

## 10.6. The task lifecycle

```text
Request → classify risk and data → G1 intent → specification → G2
→ design and plan → G3 → G4 execution boundary → agent works (G5 watches)
→ verification → G6 → pull request → G7 merge → release preparation → G8 release
→ operations and learning
```

- **Going back is normal.** G5 out of scope → back to G3. G6 fails too many times → back to G2 or G3. Specification changed after G2 → G2 again. Person B requests changes at G7 → back to the agent.
- **Every production change** — including fixes found in operations — starts again at G1. Small, low-risk changes pass quickly because their gates are light.

---

## 10.7. Running the framework in different project models

The **gates stay the same**; only their **timing** changes.

| Model | Unit of work | When gates happen |
|---|---|---|
| Agile | Sprint (usually 2 weeks) | G1–G3 at sprint planning (per story); G4–G7 during the sprint; G8 per release |
| Waterfall (common with Japanese clients) | Phase: 要件定義 → 設計 → 製造 → テスト → リリース | G1–G2 at the end of requirements; G3 at the end of design; G4–G6 during build and test; G7–G8 at release |
| Hybrid | Milestones containing sprints | G1–G3 per milestone; G4–G7 per sprint; G8 per milestone release |

### Sprint 0: set up before delivering features

Before the first feature sprint of a project that uses agents, run a short **Sprint 0** that delivers no features:

| Step | Content |
|---|---|
| 1 | Team ready: Person A and Person B named, trained (Chapter 9 §9.8) |
| 2 | Project AI record done: client consent, data class (Chapter 2) |
| 3 | Security checklist done (Chapter 3 §3.12) |
| 4 | Oversight defaults agreed per risk tier; metrics collection ready (Chapter 8) |
| 5 | Agent instructions written (AGENTS.md or similar) and checked |
| 6 | A first intent and specification written as examples |
| 7 | A dry run on a small, low-risk task, including one deliberately failing case (for example a change outside the plan must be blocked) |
| Exit | Person A, Person B and leadership agree the project is ready |

### A two-week sprint with agents

| Part | What happens | Gate focus |
|---|---|---|
| Planning | Break down the backlog; set risk tier and budget per task; Person A and B agree scope | G1–G3 |
| Execution | Agents work in parallel inside their permissions; Person A watches alerts (HOTL); Person B reviews High+ changes (HITL) | G4–G7 |
| Review | Integration test on staging; full security scan; documentation check; demo with evidence and cost | G6–G7 |
| Close | Release decision; retrospective including gate waiting times and rework; update agent instructions | G8, learning |

---

## 10.8. Inputs and outputs

| Input | Output |
|---|---|
| Client request, issue, change request, incident | Released change with a complete record: intent, spec, design, plan, code, evidence, approvals, cost |

---

## 10.9. Approval points

The approval point of each gate, by risk tier, is in the codes table §4. The HITL ones need a **decision packet** (Chapter 4 §4.5).

---

## 10.10. Tools

| Need | Before the platform | With the platform |
|---|---|---|
| Records (intent, spec, ADR, plan) | Markdown files in the repository (templates T1, T12, T13) | Intent registry |
| Gates G1–G3, G8 | PR or issue comments, recorded approvals | `sdlc` CLI and `/approve` comments |
| Gates G4–G5 | Branch protection, tool permissions, manual budget watch | Run contract, automatic checks |
| Gate G6 | CI (tests, scans) | CI + evidence pack |
| Gate G7 | GitHub PR review, CODEOWNERS | Same, recorded by the platform |

---

## 10.11. Metrics

Per phase and per gate: waiting time at each HITL gate; rework loops (how often work goes back); share of tasks passing each gate first time; PQC rate (Chapter 8).

---

## 10.12. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Gates become paperwork | Oversight follows risk; low-risk work gets light gates |
| People skip gates under time pressure | Gates enforced by tools; overrides only through Chapter 4 §4.9 |
| Approval queues slow everything | Chapter 19; measure waiting time |
| Steps and gates are mixed up, so nothing really blocks | Rules in 10.4; test gates separately |

---

## 10.13. References

**Related documents**
- Handbook: codes table §1, §4, §5; Chapters 4, 5, 8, 9, 11–19; templates T1, T2, T12–T15.
- `design/D-02`, `design/D-03` (how the platform enforces gates).

---

## Version history

| Version | Date | Author | Notes |
|---|---|---|---|
| 1.0 | 2026-09-24 | Harry | Approved |
| 0.0 | 2026-09-24 | — | Skeleton |
| 0.1 | 2026-09-24 | Claude (draft) | First content |
