# Review 02 — Handbook vs project reference documents

| Item | Value |
|---|---|
| Date | 2026-09-24 |
| Reviewer | Claude |
| Scope | Handbook (current skeleton, codes table, Ch.1) and approved design docs, checked against the two project reference documents |
| Rules (Harry, 2026-09-24) | Direction: reference docs → handbook → platform. The source document "Bản chất…" is the **main frame**; Digital Foundry **supplements** it, **scaled down for an SME**. Coding paused |

---

## 0. Summary

1. **Our handbook and design are based on only part of the main source.** Draft v1.0 (the basis of everything so far) maps 34 Q&A topics, roughly the first two thirds of the source file (up to line ~30,600 of 45,449). The last third was never used. It contains the source's **own consolidated framework** (v1 → v2 → v3), HITL/HOTL, the 2+N team model, separation of duties, escalation and SLA, critical timeout and rollback, agent lifecycle and decommission, deferred approval queues, large-team problems, cost control and measurement.
2. **Digital Foundry was not used at all.** The file is not a PDF: it is a ZIP export of a 65-page set of 9 governance / operating-model documents (Vietnamese), with page images and extracted text.
3. **Several core concepts in the handbook conflict with the sources**: autonomy levels, human oversight modes, team roles, gate granularity, lifecycle phases. Section 3 lists them with a proposed resolution under Harry's rules.
4. **Consequence for the platform**: the approved design (tag `design-v1.0`) will need changes in the autonomy model, gate logic, roles/permissions and escalation. Section 5 lists them. Coding is paused, so the cost of change is still low.

---

## 1. Sources

### 1.1. "Bản chất của việc dùng AI để viết SRS, Code, architecture" (main frame)

- Markdown export of a long Q&A session. 45,449 lines, about 60 top-level questions.
- Structure, in order:

| Part | Lines (approx.) | Content | Used so far? |
|---|---|---|---|
| A | 1–9,700 | Nature of AI in SE, AI/human boundary, intent vs prompt, control plane, sprint gates, artifact control, audit, intent/run management, overall system, control/execution planes, signed run contract, practical purpose | ✅ via draft v1.0 |
| B | 9,700–17,900 | Reference architecture, gate design, workflow step vs gate, platform components, context layer (vector DB, filtering), other considerations | ✅ via draft v1.0 |
| C | 17,900–30,600 | Skills in the AI era, competency framework, rubrics (intent, verification, agent workflow, prompt), knowledge management, log/history control | ✅ via draft v1.0 (mostly moved out of the handbook) |
| D | 30,600–32,300 | **Veto rights AI vs human, separation of duties in the 2+N team, HITL vs HOTL, escalation for HOTL, no-response SLA, automatic rollback on critical timeout** | ❌ |
| E | 32,300–33,300 | **Agentic SDLC Framework (v1)**: goals, principles, architecture, human and agent roles, four-eyes rule, risk and autonomy (L0–L4), 8-stage lifecycle with mandatory artifacts, timeout/rollback/containment, evaluation, conflict resolution, governance | ❌ |
| F | 33,300–35,800 | Control-plane layers, existing platforms, technical solution, serious build plan, context layer additions | ❌ (partly overlaps D-01/D-03 by coincidence) |
| G | 35,800–37,570 | **Framework v2** (11 layers L1–L11, integration contracts, event backbone, phases 0–6, Definition of Done) + **gap review** | ❌ |
| H | 37,570–38,860 | **Platform v3** (26 sections: work item traceability, protocol, identity/delegation, data governance, supply chain, anti-runaway, break-glass, release/rollback, simulation, human factors, portfolio, anti-gaming, decommission, roadmap P0–P5) | ❌ |
| I | 38,860–41,180 | **Agent and model lifecycle**, decommission, memory after decommission | ❌ |
| J | 41,180–42,740 | **HITL/HOTL flows**, decision boundary, approval-gate bottleneck, **deferred approval queue** | ❌ |
| K | 42,740–45,449 | **Large-team problems**, throughput paradox, **cost control at scale**, context lake sync, write-write conflicts, **measuring adoption effectiveness** | ❌ |

- Note: the source itself is not internally consistent (it evolved across the conversation). Example: autonomy appears as "Mức 0–3" (Part A), "L0–L4" (Part E) and "autonomy tiers" (Part G). Under the rule "main frame", **the latest consolidated version in the source (Parts E → G → H) should win over earlier answers**. [Proposal]

### 1.2. `Digital_Foundry.pdf` (supplement)

| # | Document | Pages | Relevance for an SME |
|---|---|---|---|
| 01 | Governance model: 3-tier governance, roles, RACI, autonomy (HITL/HOTL/Autonomous), maturity phases A/B/C, KPIs, escalation SLA, incident & change control | 1–6 | High, but must be scaled down (3 tiers → 1–2) |
| 02 | Quality gates + HITL/HOTL framework: hooks (PreToolUse, PostToolUse, TaskCompleted), gates per SDLC stage with pass/fail, by priority P0–P3 | 6–12 | **Very high**: concrete gate matrix |
| 03 | Security guardrails: defence in depth, agent guardrails, human operator guardrails, data protection, infra security, compliance mapping, incident response | 13–21 | High |
| 04 | Delivery process & standards: team structure (11–15 people + ≥12 agents), Intent-to-Agent workflow, Sprint 0, 2-week sprint lifecycle, communication | 21–29 | Medium: team size far too large for us; Sprint 0 and Intent-to-Agent are useful |
| 05 | Transformation roadmap: current vs target state, phases, maturity model, capability building, change management, pilot/rollout, KPIs | 30–37 | High (adoption plan) |
| 06 | Readiness assessment: 7 dimensions, scoring, tiers, go/no-go, degradation protocol | 38–46 | Medium–high (pilot entry criteria) |
| 07 | Role design: 10+ roles with mission → KPI, role boundaries, career path, reskilling, staffing checklist | 47–54 | Medium: use as a role catalogue, not as headcount |
| 08 | ISO/IEC 42001 AIMS mapping | 55–58 | Medium (later, when selling) |
| 09 | Metrics: DORA, SPACE, governance KPIs, agent performance, economics, early warning, reporting cadence | 59–65 | High |

- Digital Foundry assumes a **large delivery organisation** (VP Delivery, Governance Board, 11–15 people and 12+ agents per project). Scaling down is essential. [Proposal] The main source's **2+N team model** (2 humans in control + N agents) is the natural SME baseline; Digital Foundry roles become "hats" that the two humans (and occasional specialists) wear.

---

## 2. Coverage map: sources → handbook

Status: ✅ covered · 🟨 partly · ❌ missing

| Topic | Main source (part) | Digital Foundry (doc) | Handbook today | Status |
|---|---|---|---|---|
| Nature of AI in SE; AI drafts, humans decide | A | — | Ch.1 §1.4 | 🟨 |
| AI/human boundary, what agents may / may not do | A, **E §3** | 01, 03 | Codes §2 (autonomy) | 🟨 |
| Four-eyes rule: creator ≠ verifier ≠ approver | **E §3**, D | 01 RACI | FR-11 only (G1, G7) | 🟨 |
| Risk scoring factors | A, **E §4**, H §7 | 06 | Codes (risk tier table) | 🟨 |
| Autonomy levels | A (0–3), **E (L0–L4)**, G (tiers) | 01 (L1–L3 HITL/HOTL/Auto) | Level 0–3 | ⚠️ conflict |
| Oversight modes HITL / HOTL / audit-only | **D, J** | 01, 02 | — | ❌ |
| Team model 2+N, separation of duties | **D** | 04, 07 | — | ❌ |
| Roles and RACI | **E §3**, E §9 | 01, 07 | Ch.5 (stub) | ❌ |
| Lifecycle stages + mandatory artifacts (Intent Record, ADR…) | **E §5** (8 stages) | 02 (Req → Deploy), 04 | 6 phases P1–P6 | 🟨 |
| Gates | A/B (G0–G12 → G1–G8), **E** | **02 (per stage × priority)** | 8 gates G1–G8 | ⚠️ conflict in granularity |
| Priority classes P0–P3 | — | 02 | — | ❌ |
| Escalation, SLA, no-response handling | **D** | 01 §8 | — | ❌ |
| Critical timeout, rollback, containment | **D, E §6**, H §17 | 02 §3.5 | — | ❌ |
| Deferred approval queue, approval bottlenecks | **J** | — | — | ❌ |
| Conflict resolution between agents / humans | **E §8** | — | — | ❌ |
| Break-glass / emergency operation | H §15 | — | — | ❌ |
| Governance structure and cadence | **E §9** | 01 (3 tiers), 05 §10 | — | ❌ |
| Incident and change control | E, H | 01 §9, 03 §8 | Ch.14 (stub), T9 (stub) | ❌ |
| Security guardrails (agent + human) | A, H §8, §13 | **03** | Ch.3 (stub) | ❌ |
| Data classification and protection | H §10 | 03 §5 | D-05 `data_class` | 🟨 |
| Intent articulation / intent spec | A | 04 (Intent-to-Agent) | T1 (stub) | ❌ |
| Evidence, verification, quality gates | A, B, H §16 | 02 | D-02/D-03 | 🟨 (design only) |
| Metrics (DORA, SPACE, agent, cost, early warning) | K, H §22 | **09** | Ch.1 §1.9 | 🟨 |
| Cost control | K, H §19 | 03 (token budget), 09 §7 | D-07 | 🟨 (design only) |
| Adoption roadmap, maturity, readiness, go/no-go | H §25, G §19 | **05, 06**, 01 §6 | Ch.1 §1.8 | 🟨 |
| Capability building, change management, reskilling | C | 05 §6, 07 §7 | — | ❌ |
| Agent / model lifecycle, decommission | **I**, H §23 | — | — | ❌ |
| Human factors (fatigue, trust) | H §20, J | — | — | ❌ |
| Compliance (ISO 42001, METI…) | — | 08 | Ch.6 (stub) | ❌ |
| Large-team issues, throughput paradox | K | — | — | ❌ (low priority for SME) |

---

## 3. Conflicts and proposed resolution

Rule: main source wins, preferring its **latest consolidated version**; Digital Foundry supplements; scale down for an SME.

| # | Topic | Handbook today | Main source | Digital Foundry | Proposed resolution |
|---|---|---|---|---|---|
| C1 | Autonomy levels | Level 0–3 (from source Part A) | Part E: L0 Assist, L1 Execute in sandbox, L2 Controlled change, L3 Bounded autonomy, L4 High-impact | L1 HITL, L2 HOTL, L3 Autonomous | **Two dimensions** [Proposal]: (a) *autonomy level* = what the agent may do, from Part E (5 levels); (b) *oversight mode* = how humans are involved: HITL / HOTL / audit-only, from Parts D, J (matches Digital Foundry). Needs Harry's decision (Q1) |
| C2 | Team model and roles | PO, tech lead, code owner, QA, release owner | 2+N; roles list in Part E §3 | 10+ roles, 11–15 people | **2+N as the default** (Human A owner/executor, Human B independent reviewer/approver); Part E roles and Digital Foundry roles as a catalogue of "hats" (Q2) |
| C3 | Gate granularity | 8 fixed gates for every task | Gates per lifecycle stage; risk-based strength | Gates per stage × priority (P0/P1 HITL, P2 HOTL, low-risk autonomous) | Keep **G1–G8 as lifecycle checkpoints**, but the **oversight mode of each gate depends on risk/priority**, using Digital Foundry's matrix (Q3) |
| C4 | Lifecycle phases | 6 phases P1–P6 (Harry's project scope) | 8 stages (Intent & discovery, Specification, Architecture & design, Planning & decomposition, Implementation, Verification, Release & deployment, Operations & maintenance) | Pre-sales → Discovery → Delivery → Transition; SDLC Req → Design → Build → Test → Deploy | [Proposal] **Keep the 6 phases** (Harry's defined scope). Map the source's 8 stages into them (Intent + Spec → P1; Architecture + Planning → P2; …). Add Digital Foundry's Pre-sales / Transition as context around the SDLC, not as phases |
| C5 | Name clash | P1–P6 = phases | — | "Phase A/B/C" = maturity; "P0–P3" = priority | [Proposal] Rename in our handbook: maturity **Stage A/B/C**; priority **PRI-0…PRI-3** (or "Critical / High / Normal / Low"), so "P" stays for phases |
| C6 | Risk tier vs priority | Risk tier Low–Critical | Risk score from 9 factors | Priority P0–P3 by business criticality | [Proposal] Keep **risk tier** as the single driver; priority is an input to the risk score |
| C7 | Governance structure | None | Part E §9 governance and responsibility | 3 tiers (Board monthly, Committee bi-weekly, Stand-up daily) | [Proposal] SME: **2 tiers** — Leadership review (monthly) + project stand-up (daily/weekly) |
| C8 | Audit retention | Evidence Packs 6 months (D-05); audit log "never deleted in MVP" | — | Audit logs ≥ 2 years | [Proposal] Keep Evidence Pack files 6 months; state **audit log ≥ 2 years** explicitly |
| C9 | Maturity / autonomy roadmap | Pilot = Level 1–2 only | Phases P0–P5 (v3) | Stage A 80/15/5 %, B 40/45/15 %, C 15/55/30 % (HITL/HOTL/Auto) with entry conditions | [Proposal] Use Digital Foundry's **stage entry conditions** (quality-gate pass rate, no P0 incident, DORA level); the percentages as guidance only |

---

## 4. Proposed handbook structure v2 (for discussion)

Changes against the current skeleton are marked **new** or **changed**.

**Part 0 — Introduction**
- 0.1 Contents · 0.2 Glossary · 0.3 What Agentic SDLC is · 0.4 Core principles
- 0.5 Canonical codes — **changed**: autonomy levels + oversight modes, risk tiers, priorities, maturity stages
- 0.6 Writing style

**Part I — Policy and governance (leadership)**
- Ch.1 Executive summary — **changed** after decisions
- Ch.2 AI usage policy
- Ch.3 Security guardrails and client data — **changed**: agent + human guardrails (DF 03)
- Ch.4 Autonomy, oversight modes and permissions — **changed**: two dimensions, agent may / may not (Part E §3)
- Ch.5 Team model, roles and accountability — **changed**: 2+N, separation of duties, role catalogue, RACI
- Ch.6 Governance, escalation and incidents — **new**: 2-tier cadence, escalation SLA, no-response handling, incident and change control, break-glass
- Ch.7 Compliance and standards — (was Ch.6)
- Ch.8 Metrics, budget and cost — **changed**: DORA/SPACE, agent metrics, cost control, early warning
- Ch.9 Adoption roadmap — **new**: readiness assessment, maturity stages A/B/C with entry conditions, pilot, capability building, change management

**Part II — Playbook (delivery team)**
- Ch.10 The framework: 6 phases, 8 gates, oversight by risk — **changed**
- Ch.11–16: P1 … P6, each with mandatory artifacts from Part E §5 (Intent Record, ADR, …) — **changed**
- Ch.17 Reviewing AI output (creator ≠ verifier ≠ approver)
- Ch.18 Timeouts, rollback and containment — **new**
- Ch.19 Approval queues and avoiding review bottlenecks — **new**
- Ch.20 Agent and model lifecycle (onboarding → decommission) — **new**

**Part III — Templates**
- Existing T1–T11 + **new**: Intent Record, escalation record, readiness assessment checklist, change proposal

**Appendix**: mapping to Digital Foundry roles; mapping to ISO 42001 (later).

[Proposal] Chapter numbers will shift; the codes table and all links will be updated in one pass.

---

## 5. Impact on the platform design (for later, after the handbook is agreed)

| Area | Current design | Likely change |
|---|---|---|
| Autonomy | `autonomy_level` 0–3 | Autonomy level (per Part E) + `oversight_mode` (HITL / HOTL / audit) per gate and action |
| Gate engine | 8 gates, mostly fixed human/automatic | Gate strength depends on risk (and priority); HOTL gates do not block but raise alerts, sampling |
| Roles | 7 project roles | Human A / Human B + role catalogue; separation of duties enforced by **capability** (producer cannot merge; reviewer cannot edit) |
| Escalation | Reminders only (FR-12) | Escalation chain with SLA, no-response rules, automatic safe action on critical timeout |
| Rollback / containment | Not designed | Critical timeout, containment, rollback categories |
| Approval flow | Synchronous waits | Deferred approval queue for non-blocking work |
| Agent lifecycle | Not designed | Agent/model registry with states up to decommission |
| Hooks | Gate checks in the workflow | Digital Foundry's hook points (PreToolUse, PostToolUse, TaskCompleted) map naturally to agent tool control |
| Retention | Evidence 6 months | + audit log ≥ 2 years |
| Metrics | Tokens, gate waiting time | + DORA/SPACE subset, agent metrics, early warning |

---

## 6. Decisions

| # | Question | Decision (Harry, 2026-09-24) |
|---|---|---|
| Q1 | Autonomy model | **Two dimensions**: autonomy level L0–L4 (source Framework v1/v2) + oversight mode HITL / HOTL / AUDIT |
| Q2 | Team model | **2+N by default**; Digital Foundry roles as a catalogue of hats |
| Q3 | Gates | **Keep G1–G8** as lifecycle checkpoints; oversight per gate depends on the risk tier |
| Q4 | Handbook structure v2 (section 4) | **Accepted** |
| Q5 | Autonomy code names | **L0–L4**, as in the source |
| C8 | Audit retention | **Audit log ≥ 2 years** (Harry, 2026-09-24, via Ch.3) |
| Q6 | Escalation SLAs | **SME values**: Critical 15 min, High 1 h, Medium 1 working day, Low 3 working days |

Applied in `handbook/00-introduction/05-codes.md` v0.4 and in the handbook structure (contents v0.2).

### 6.1. Consequences to carry into the design revision

- FR-11 changes: with 2+N, **Human A confirms G1** (per the main source) and **Human B approves G3, G7, G8**. The rule "the intent creator cannot approve G1" is replaced by "the producer never approves its own output (G7/G8)".
- G7 is HITL for every risk tier (main source: merge into a protected branch is always HITL).
- Autonomy L0–L4 replaces Level 0–3; `oversight_mode` becomes a new field for gates and actions.
- Audit log retention ≥ 2 years; client data in knowledge bases deleted at project end (retention jobs in D-05 to cover this).

---

## 7. How this review was done

- Main source: outline extracted (≈625 headings); Parts D, E, G, H, I, J, K read at section level; key passages read in full (roles, autonomy, 2+N, HITL/HOTL).
- Digital Foundry: all 65 pages of extracted text read at section level; documents 01, 02, 04 read in more detail.
- Draft v1.0 appendix E (topic map) used to confirm which source topics were already covered; keyword checks (HITL, HOTL, 2+N, decommission, deferred approval, critical timeout, Framework v2, Platform v3) all returned zero in the draft.
- **Not yet done**: a line-by-line reading of every section. The next step (writing chapters) will read each relevant source section in full before writing.
