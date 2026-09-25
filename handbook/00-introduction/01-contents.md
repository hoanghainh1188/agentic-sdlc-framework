# 0.1 Contents and how to read

Structure v2 (accepted by Harry, 2026-09-24).

> **Handbook status: version 1.0 — not yet approved as a whole.** Chapter approvals below are **interim**; the handbook is approved once all parts are reviewed together. Until then, any chapter may still change.

Status per section: ⬜ not written · 🟨 draft · ✅ approved (interim)

## Part 0 — Introduction (everyone)

| Section | File | Status |
|---|---|---|
| 0.1 Contents and how to read | [01-contents.md](01-contents.md) | 🟨 |
| 0.2 Glossary | [02-glossary.md](02-glossary.md) | 🟨 v0.1 |
| 0.3 What Agentic SDLC is | [03-what-is-agentic-sdlc.md](03-what-is-agentic-sdlc.md) | 🟨 v0.1 |
| 0.4 Core principles | [04-core-principles.md](04-core-principles.md) | 🟨 v0.1 |
| 0.5 Canonical codes | [05-codes.md](05-codes.md) | ✅ v1.4 |
| 0.6 Writing style | [06-writing-style.md](06-writing-style.md) | 🟨 |

## Part I — Policy and governance (leadership)

| Chapter | File | Status |
|---|---|---|
| 1. Executive summary | [ch01](../01-policy/ch01-executive-summary.md) | ✅ v1.1 |
| 2. AI usage policy | [ch02](../01-policy/ch02-ai-usage-policy.md) | ✅ v1.2 (2 items open) |
| 3. Security guardrails and client data | [ch03](../01-policy/ch03-security-guardrails-and-client-data.md) | ✅ v1.1 |
| 4. Autonomy levels, oversight modes and permissions | [ch04](../01-policy/ch04-autonomy-oversight-and-permissions.md) | ✅ v1.0 |
| 5. Team model (2+N), roles and accountability | [ch05](../01-policy/ch05-team-roles-and-accountability.md) | ✅ v1.0 |
| 6. Governance, escalation and incidents | [ch06](../01-policy/ch06-governance-escalation-and-incidents.md) | ✅ v1.1 |
| 7. Compliance and reference standards | [ch07](../01-policy/ch07-compliance-and-standards.md) | 🟨 v0.9 provisionally approved, legal review pending |
| 8. Metrics, budget and cost | [ch08](../01-policy/ch08-metrics-budget-and-cost.md) | ✅ v1.0 |
| 9. Adoption roadmap | [ch09](../01-policy/ch09-adoption-roadmap.md) | ✅ v1.1 |

## Part II — Playbook (delivery team)

| Chapter | Phase / gates | File | Status |
|---|---|---|---|
| 10. The framework | 6 phases, 8 gates, oversight by risk | [ch10](../02-playbook/ch10-framework-and-gates.md) | ✅ v1.0 |
| 11. Requirements | P1 · G1, G2 | [ch11](../02-playbook/ch11-p1-requirements.md) | ✅ v1.0 |
| 12. Analysis and design | P2 · G3 | [ch12](../02-playbook/ch12-p2-analysis-and-design.md) | ✅ v1.0 |
| 13. Coding | P3 · G4, G5 | [ch13](../02-playbook/ch13-p3-coding.md) | 🟨 v0.2 (awaiting comments) |
| 14. Testing | P4 · G6 | [ch14](../02-playbook/ch14-p4-testing.md) | 🟨 v0.2 (awaiting comments) |
| 15. Release | P5 · G7, G8 | [ch15](../02-playbook/ch15-p5-release.md) | 🟨 v0.2 (awaiting comments) |
| 16. Operations and maintenance | P6 | [ch16](../02-playbook/ch16-p6-operations.md) | 🟨 v0.2 (awaiting comments) |
| 17. Reviewing AI output | Used at G2, G3, G7 | [ch17](../02-playbook/ch17-reviewing-ai-output.md) | 🟨 v0.1 (awaiting comments) |
| 18. Timeouts, rollback and containment | P3–P6 | [ch18](../02-playbook/ch18-timeouts-rollback-and-containment.md) | 🟨 v0.2 (awaiting comments) |
| 19. Approval queues | All HITL gates | [ch19](../02-playbook/ch19-approval-queues.md) | 🟨 v0.1 (awaiting comments) |
| 20. Agent and model lifecycle | Across phases | [ch20](../02-playbook/ch20-agent-and-model-lifecycle.md) | 🟨 v0.2 (awaiting comments) |

Chapters 11–16 follow the 9-section structure, plus "Mandatory artifacts", "Tools" and "Metrics".

## Part III — Templates and checklists

| Code | Name | File | Status |
|---|---|---|---|
| T1 | Intent Record | [T1](../03-templates/T1-intent-record.md) | 🟨 v0.1 |
| T2 | Pull request with AI disclosure | [T2](../03-templates/T2-pull-request-ai-disclosure.md) | ✅ |
| T3 | Checklist: reviewing AI-written code | [T3](../03-templates/T3-ai-code-review-checklist.md) | 🟨 v0.1 |
| T4 | Checklist: reviewing AI-written documents | [T4](../03-templates/T4-ai-document-review-checklist.md) | 🟨 v0.1 |
| T5 | Project RACI (2+N) | [T5](../03-templates/T5-project-raci.md) | 🟨 v0.1 |
| T6 | Agent charter, register entry and permissions | [T6](../03-templates/T6-agent-permission-config.md) | 🟨 v0.1 |
| T7 | Contracts, NDAs and the project AI record | [T7](../03-templates/T7-contract-nda-checklist.md) | 🟨 v0.1 |
| T8 | Weekly pilot report | [T8](../03-templates/T8-weekly-pilot-report.md) | 🟨 v0.1 |
| T9 | AI incident record | [T9](../03-templates/T9-ai-incident-record.md) | 🟨 v0.1 |
| T10 | Checklist for the 8 gates | [T10](../03-templates/T10-gate-checklist.md) | 🟨 v0.1 |
| T11 | OpenBao runbook | [T11](../03-templates/T11-openbao-runbook.md) | 🟨 outline (Claude Code, A03/A10) |
| T12 | Architecture Decision Record (ADR) | [T12](../03-templates/T12-adr.md) | 🟨 v0.1 |
| T13 | Task plan for agents | [T13](../03-templates/T13-task-plan.md) | 🟨 v0.1 |
| T14 | Release record | [T14](../03-templates/T14-release-record.md) | 🟨 v0.1 |
| T15 | Remediation record | [T15](../03-templates/T15-remediation-record.md) | 🟨 v0.1 |
| T16 | Escalation record | [T16](../03-templates/T16-escalation-record.md) | 🟨 v0.1 |
| T17 | Readiness assessment checklist | [T17](../03-templates/T17-readiness-assessment.md) | 🟨 v0.1 |
| T18 | Change proposal | [T18](../03-templates/T18-change-proposal.md) | 🟨 v0.1 |

## Appendix

| Code | Name | File |
|---|---|---|
| A | Commonly confused terms | [A](../appendix/A-commonly-confused-terms.md) |
| B | Standards mapping | [B](../appendix/B-standards-mapping.md) |
| C | References | [C](../appendix/C-references.md) |
| D | Presentation outline | [D](../appendix/D-presentation-outline.md) |

## Who reads what

| Reader | Must read | Should read |
|---|---|---|
| Leadership | Part 0, Part I | Ch.10 |
| PM / BrSE (often Person A) | Part 0, Ch.2–6, Ch.10–12, 15, 17, 19 | Ch.1, 8, 9, 16, 18 |
| Developer | Part 0, Ch.2–5, Ch.10, 13, 14, 17, 18 | Ch.15, 16, 20 |
| Reviewer (Person B) | Part 0, Ch.4–6, Ch.10, 17, 19 | Ch.12–15 |
| Tester | Part 0, Ch.2–4, Ch.10, 14, 17 | Ch.11, 13 |

## 9-section structure for process documents

1. Purpose · 2. Scope · 3. Roles and responsibilities · 4. Steps · 5. Inputs / outputs · 6. Approval points · 7. Risks and mitigations · 8. References · 9. Version history

## Version history

| Version | Date | Author | Notes |
|---|---|---|---|
| 0.1 | 2026-09-24 | Claude (draft) | First contents (translated) |
| 0.3 | 2026-09-24 | Claude | Appendix E removed; citation clean-up |
| 0.2 | 2026-09-24 | Claude | Structure v2: new chapters 6, 9, 18, 19, 20; chapters renumbered; templates T12–T18 |
