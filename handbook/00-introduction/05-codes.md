# 0.5 Canonical codes

Every code has exactly one meaning across the whole repo.

> Status: **Approved** (Harry, 2026-09-24) — version 1.3 The design docs in `design/` still use the old codes and will be updated after the handbook is agreed.

---

## 1. Six phases (P1–P6)

The 6 phases cover the whole software lifecycle. Each phase has mandatory records.

| Code | Phase | Covers | Mandatory artifacts | Japanese (reference) |
|---|---|---|---|---|
| P1 | Requirements | 1. Intent and discovery · 2. Specification | **Intent Record** · Specification (functional, non-functional, interfaces, data, errors, security, observability, rollback criteria, acceptance tests) | 要件定義 |
| P2 | Analysis and design | 3. Architecture and design · 4. Planning and decomposition | **ADR** · task plan (input, output, owner agent, tool permissions, dependencies, definition of done, budget, timeout, required evidence, escalation condition) | 基本設計・詳細設計 |
| P3 | Coding | 5. Implementation | Changes on an isolated branch, each linked to a requirement; tests or a recorded reason; artifact lineage | 開発・製造 |
| P4 | Testing | 6. Verification | Independent verification evidence (tests, static analysis, security and dependency scans, agent behaviour evaluation, human review) | テスト |
| P5 | Release | 7. Release and deployment | **Release record** (release id, artifact digest, source commit, spec version, test and security evidence, approvals, deployment policy, rollback target and command, dashboard) | リリース |
| P6 | Operations and maintenance | 8. Operations and maintenance | **Remediation record** (symptom, hypothesis, evidence, proposed action, expected effect, risk, rollback, verification) | 運用・保守 |

- Pre-sales and project hand-over (transition) happen around the SDLC; they are not phases.

---

## 2. Two dimensions of agent control

Agent control has **two separate dimensions**.

| Dimension | Question it answers | Codes |
|---|---|---|
| **Autonomy level** | *What* is the agent allowed to do? | L0–L4 |
| **Oversight mode** | *How* are humans involved in a given action or gate? | HITL, HOTL, AUDIT |

### 2.1. Autonomy levels (L0–L4)

| Code | Name | What the agent may do | Examples |
|---|---|---|---|
| L0 | Assist | Propose only | Summaries, suggestions, draft documents |
| L1 | Execute in sandbox | Execute with **no side effects** outside an isolated environment | Write code, run tests in a sandbox |
| L2 | Controlled change | Create changes that pass through gates | Open a PR, deploy to staging |
| L3 | Bounded autonomy | Handle bounded tasks by itself, inside a predefined policy | Canary, low-risk remediation, rollback |
| L4 | High-impact autonomy | Only in special, explicitly approved scopes | Important production changes |

- Autonomy is tied to the **risk budget**, not fixed per agent: the same agent may get L2 for documents but only L0–L1 for a production database.

**Never allowed** for an agent, at any level, with no override: bypassing or disabling audit, logging, monitoring, gates, hooks or scans · exfiltrating secrets or client data · changing its own permissions, policies or autonomy level · approving an artifact it created · acting outside its risk budget or run contract.

**Allowed only when explicitly granted for that exact scope** by a HITL decision: deleting data · incompatible schema changes · IAM or security-boundary changes · production deploys with a large blast radius.

Details: Chapter 4 §4.7.

### 2.2. Oversight modes

| Code | Meaning | Human's position | Use for | Required building blocks |
|---|---|---|---|---|
| **HITL** | Human in the loop | Inside the decision chain: **no valid output without a human decision** | Actions that are high-impact or hard to reverse | Approval gate, reviewer assignment, decision packet, SLA, approve / reject / request changes, separation of duties, audit, timeout, escalation |
| **HOTL** | Human on the loop | Above the chain: the agent acts within policy; a human monitors and can pause, block, override or roll back | Medium-risk actions that are observable and recoverable | Bounded autonomy, real-time telemetry, policy thresholds, anomaly detection, kill switch, pause/resume, grant revocation, automatic containment, human alerts, post-run audit |
| **AUDIT** | Audit only | After the fact: sampled review | Repetitive, low-risk, easy-to-check and easy-to-undo work | Complete audit trail, sampling plan, ability to revert |

- "Without telemetry, a kill switch and grant revocation, it is only autonomous execution, not controlled HOTL."
- Decide by the **action**, not by the agent: is it reversible, what is the blast radius, is the data sensitive, is the evidence sufficient, who is accountable if it is wrong?

---

## 3. Risk tiers

| Tier | Typical signs | Maximum autonomy (proposal) |
|---|---|---|
| Low | Reversible, small blast radius, no sensitive data | L2 (L3 for selected tasks from maturity Stage B) |
| Medium | Reversible with effort; limited blast radius | L2 |
| High | Hard to reverse, sensitive data, architecture or security impact | L1 (sandbox output is a proposal; a human takes it forward) |
| Critical | Irreversible, data loss possible, production-critical, legal exposure | L0 |

Risk factors to score: impact · reversibility · data sensitivity · number of systems affected · degree of architecture change · possibility of data loss · external exposure · dependence on uncertain judgement · criticality of the production target.

Business priority (see 6.2) is **one input** to the risk tier, not a separate control axis.

---

## 4. Eight gates (G1–G8) with risk-based oversight

G1–G8 are **lifecycle checkpoints**; the **oversight mode of each gate depends on the risk tier**.

| Gate | Phase | Question | Low | Medium | High | Critical | Approver (2+N, see §5) |
|---|---|---|---|---|---|---|---|
| G1 Intent / Scope / Risk | P1 | What problem, what scope, what risk? | HITL | HITL | HITL | HITL | Person A (owner) confirms goal, scope, risk |
| G2 Specification | P1 | Is the spec complete, consistent, unambiguous, verifiable? | HOTL | HITL | HITL | HITL | Person A; Person B for High+ |
| G3 Plan / Architecture | P2 | Is the design and plan appropriate? | HOTL | HITL | HITL | HITL | **Person B** approves design / important changes |
| G4 Execution boundary | P3 | What may the agent do, with which permissions and budget? | Policy check | Policy check | HITL | HITL | Automatic policy; a human only for elevated permissions and High+ |
| G5 Scope drift / budget | P3 | Is the agent staying inside plan and budget? | HOTL | HOTL | HOTL → HITL on breach | HITL | Person A (task owner) on alerts |
| G6 Independent verification | P4 | Is there independent evidence? | Automated + AUDIT | Automated + HOTL | Automated + HITL | Automated + HITL | Checks; security findings go to HITL at any tier |
| G7 Review / Merge | P5 | Do we accept the change into a protected branch? | HITL | HITL | HITL | HITL + second approver | **Person B** (never the producer) |
| G8 Release / Learning | P5 | Should it go live? | Production: HITL · non-production: HOTL | Production: HITL | Production: HITL | HITL + business/security approval | **Person B** (+ business/security owner for Critical) |

- Every merge into a protected branch is HITL, at every risk tier.
- **G3 is always HITL** (Person B), whatever the risk tier, when the change involves: a database migration or data-model change; a breaking API or event contract; a new service boundary; a security-boundary or access change; a change of system of record; a production infrastructure change; a change to a core business rule (invariant). Details: Chapter 12.
- **G7 needs two approvers** (Person B + a second approver), whatever the risk tier, for: data migrations, payment functions, personal data, production infrastructure, breaking changes, safety-related functions. Details: Chapter 15.
- Three things are never skipped: permission before dangerous actions, independent verification, human approval of high-risk effects.

---

## 5. Team model: 2+N

The default team is **2+N**. Other roles are "hats" that these people wear.

| Member | Responsibilities | Veto |
|---|---|---|
| **Person A** — Owner / Executor | Defines intent, designs, resolves ambiguity, prepares or coordinates changes | Scope, design, business intent |
| **Person B** — Independent Reviewer / Approver | Checks independently, settles disagreements, approves or rejects merge and release | Quality, evidence, release |
| **Agents 1..N** | Planning, coding, testing, security, documentation, operations | Only the blocking rights given by policy; never grant themselves permissions |

- **Separation of duties**: `creator ≠ verifier ≠ approver`. For critical changes: `agent evidence + technical approval + business/security approval`. Enforced by **capabilities**, not only by role names: the producing agent has no merge tool; the reviewing agent has no edit tool.

### 5.1. Role catalogue ("hats")

A person can wear several hats, as long as separation of duties holds.

| Hat | Usually worn by |
|---|---|
| Product owner, Domain expert, Tech lead / architect | Person A |
| Human reviewer, Security/privacy owner | Person B |
| Agent operator (budget, timeout, escalation) | Person A |
| Incident commander | Person B (or leadership for Critical) |
| Governance owner | Leadership |
| Intent Engineer, Agent Engineer, Agentic SA | Person A |
| HITL Reviewer, QC Lead, Security Reviewer | Person B |
| Agent Supervisor (HOTL monitoring) | Person A or B, by rotation |
| AI Governance Officer | Leadership (part-time) |
| Agentic PM / Bridge SE | PM / BrSE (may be Person A) |

---

## 6. Other codes

### 6.1. Maturity stages (A/B/C)

| Stage | Guidance mix HITL / HOTL / AUDIT | Entry conditions |
|---|---|---|
| Stage A — Pilot | ≈ 80 / 15 / 5 % | Default |
| Stage B — Hybrid | ≈ 40 / 45 / 15 % | DORA medium or better; no PRI-0 governance incident; quality-gate pass ≥ 95 %; team trained |
| Stage C — Target | ≈ 15 / 55 / 30 % | DORA high performer; no PRI-0/PRI-1 incident for 8 weeks; quality-gate pass ≥ 99 %; team fully trained |

- Percentages are guidance only; moving stage depends on the conditions, decided by leadership.
- Named "Stage" (not "Phase") to avoid clashing with P1–P6.

### 6.2. Business priority (PRI-0…PRI-3)

| Code | Meaning |
|---|---|
| PRI-0 | Critical: security-sensitive, production-critical |
| PRI-1 | High |
| PRI-2 | Standard feature work |
| PRI-3 | Low: formatting, boilerplate, docs |

Written "PRI-" to avoid clashing with the phase codes P1–P6. Priority feeds the risk tier (§3).

### 6.3. Escalation severity

| Severity | Examples | SLA |
|---|---|---|
| Critical | Production down, data breach, unauthorised agent action | **15 minutes**, to leadership |
| High | HITL bypass, quality regression, data misrouting | **1 hour** |
| Medium | HOTL alert past SLA, incomplete sampling | **1 working day** |
| Low | Documentation, configuration, reporting | **3 working days** |

Medium and Low allow more time because one person often holds several roles.

This table and Chapter 6 §6.4 (which adds resolution times and who to notify) are the **only** places where escalation SLAs are defined.

---

## Version history

| Version | Date | Author | Notes |
|---|---|---|---|
| 0.1 | 2026-09-24 | Claude (draft) | Codes: 4 autonomy levels + 8 gates |
| 0.2 | 2026-09-24 | Claude (draft) | Translated into English |
| 0.3 | 2026-09-24 | Claude (draft) | Rebuilt: phases with mandatory artifacts, autonomy L0–L4 + oversight HITL/HOTL/AUDIT, risk tiers, gate × risk matrix, 2+N team and role hats, maturity stages, priorities, escalation severity |
| 0.4 | 2026-09-24 | Claude | Autonomy codes L0–L4; escalation SLAs confirmed |
| 1.0 | 2026-09-24 | Harry | Approved |
| 1.1 | 2026-09-24 | Harry | Added: 7 kinds of change that always make G3 HITL |
| 1.2 | 2026-09-24 | Harry | Added: change types that always need two approvers at G7 |
| 1.3 | 2026-09-24 | Harry | §2.1 aligned with Ch.4 §4.7; §6.3 marked as the reference for SLAs |
