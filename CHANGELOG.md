# Changelog

## [1.3.0-review] — 2026-09-24

### Approved
- Codes table v1.0 (Harry). Ch.1 v0.4: changes requested.
- Ch.1, Ch.2, Ch.3 approved as v1.0 (Harry). Ch.4, Ch.5, Ch.6 approved as v1.0. Ch.8, Ch.9 approved as v1.0. Part I complete (Ch.7 pending legal review). Ch.10–12 approved. Codes table v1.1 (forced-HITL list for G3); v1.2 (dual approval at G7 for sensitive change types). Ch.13–15 awaiting Harry's comments. Ch.2: tool owners and disciplinary rules still open.

### Added / changed
- Repository history starts with one initial commit on GitHub (Harry); tag `design-v1.0` on that commit. Earlier local history and the `design-pre-handbook` tag are not published.
- Repository: `harryforge/agentic-sdlc-framework` (renamed from `agentic-sdlc-fw`), personal account, risk accepted (Harry). GETTING-STARTED commands use the real repository.
- `platform/GETTING-STARTED.md` rewritten: preparation, push with both tags, 44 issues, Claude Code check session, standard task loop and prompt, order after A01, handbook-change flow, how to send handbook comments. `create-issues.py` labels 12 tasks `handbook-dependent`.
- Decision (Harry): code the whole backlog now, accept rework after the handbook is approved. Handbook-dependent rules kept in config; changes flow handbook → design → backlog → code.
- Handbook status clarified (Harry): version 1.0, **not yet approved as a whole**; chapter approvals are interim. Design and code may change after the handbook is approved.
- **Design version 1.0 approved** (Harry, 2026-09-24), tag `design-v1.0`. **Coding resumed**, starting with A01.
- Design aligned with the handbook: D-02 (2+N users, oversight matrix, FR-14…19, FR-34…36, FR-43…44, MVP+1 list), D-03 (oversight resolution, approvals, binding, escalation, kill switch, new state machine, ADR-M13…M15), D-05 (new enums and tables: project_ai_records, agents, escalations), D-08 (44 tasks: new B11, B12, C10, C11), D-09 (L0–L2; N5 rewritten; N7–N10). Diagrams d10, d12, d13 regenerated. 
- Part III templates drafted: T1, T3–T10, T12–T18 (v0.1); T11 outline (content by Claude Code in A03/A10). T6 now also covers the agent charter and register; T7 also contains the project AI record.
- Review 04 decisions applied: O1 (Rule 9 split: supervised assistants vs autonomous agents), O2/O3 (single SLA source and single incident process), O4 (Ch.1 links to 0.4). Versions: codes 1.3, Ch.1 1.1, Ch.2 1.2, Ch.3 1.1, Ch.6 1.1, Ch.9 1.1, Ch.13 0.2.
- Consistency review (`_review/04`): Person A/B everywhere; leftover citation lines removed; [Proposal] tags removed from approved chapters; codes table §2.1 aligned with Ch.4 §4.7; Ch.4 §4.11 approvers aligned. Open items O1–O4.
- Part 0 drafted: 0.2 glossary (about 60 terms with Japanese reference terms), 0.3 what Agentic SDLC is, 0.4 core principles (14). Ch.20 v0.2 (recertification every 3 months; register in repo). Ch.13–20 awaiting Harry's comments.
- Ch.16 v0.2 (separate client consent for AI on production logs/data), Ch.18 v0.2 (recovery runbook per project; drills per release cycle for High+), Ch.2 v1.1 (AI record field).
- Ch.19 v0.1 approval queues (blocking vs deferred, routing, decision packets, batching, approval binding, metrics). Ch.20 v0.1 agent and model lifecycle (charter, register, evaluation, readiness and ramp-up, recertification, change/suspend/quarantine, retirement and data disposition). Part II drafted in full.
- Ch.16 v0.1 (agents in operations, remediation record, fast lane, maintenance contracts), Ch.17 v0.1 (generated/reviewed/approved, checks by artifact type, typical AI weaknesses, DoD, AI debt), Ch.18 v0.1 (run limits, critical-timeout recovery, last known good, rollback kinds, no-auto-rollback cases, verification, recovery runbook, drills).
- Ch.13 v0.1 (G4 checks, coding-agent rules, G5 pause triggers, manual equivalents today), Ch.14 v0.1 (independent verification, check groups, G6 criteria and failure handling), Ch.15 v0.1 (G7 review depth incl. dual approval, release record, G8, 2-week observation, learning).
- Part II started: Ch.10 v0.1 (steps vs gates, lifecycle, Agile/Waterfall/hybrid, Sprint 0), Ch.11 v0.1 (intent vs prompt, Intent Record, spec qualities, G1/G2, Japanese client tips), Ch.12 v0.1 (options, ADR, task plan, forced-HITL list for G3).
- Handbook no longer mentions the internal reference documents (Harry): [Doc] tags, source columns, internal references and Appendix E removed; old-code conversion moved to `_review/03`. Writing style v0.3.
- Ch.7 v0.9 provisionally approved (legal review pending; ISO 42001 certification decided later). Ch.8 v0.2 (PQC observation window 2 weeks). Ch.9 v0.2.
- Ch.7 v0.1 compliance: Vietnam AI Law (134/2025/QH15) and PDPL (91/2025/QH15 + Decree 356), Japan AI Promotion Act, AI Guidelines for Business Ver 1.2, APPI, METI contract checklist; ISO 42001, NIST AI RMF, OWASP Agentic; coverage map.
- Ch.8 v0.1 metrics, budget, cost (PQC north-star, 12-metric minimum set, governance metrics, early warning, total delivery cost, budgets, baseline/scale gate, reporting).
- Ch.9 v0.1 adoption roadmap (5 steps, readiness assessment, pilots, questions before production, skills, communication, degradation).
- Ch.5 v0.2 / Ch.6 v0.2: confirmed one-person project rules, resolution SLAs, two-tier governance.
- Ch.4 v0.1 autonomy, oversight, permissions (levels, modes, common actions, forbidden actions, veto, overrides, raising/lowering).
- Ch.5 v0.1 2+N team (permissions matrix, SoD by phase, disagreements, few-people compensating controls, hats, RACI, accountability).
- Ch.6 v0.1 governance (2 tiers), escalation (triggers, response levels named Observe…Incident, package, routing, SLA), no-response rules, safe resume, incidents, rule changes, exceptions, break-glass.
- Ch.1 v0.5: evidence on speed (Peng 2023, METR 2025, DORA 2025), expected benefits, costs, Digital Foundry reference targets.
- Ch.2 v0.2: approved tools Claude + GitHub Copilot; unknown client terms → `client_restricted`; always disclose AI use to clients.
- Ch.3 v0.2: audit log ≥ 2 years; access review every 3 months; same-day removal; client data deleted at project end.
- Ch.3 v0.1 security guardrails and client data: threats, 5 layers, agent hard rules, prompt-injection defence, human rules, client data, incidents, project checklist.
- Ch.2 v0.1 AI usage policy: 9 rules, data classes, project AI record, approved tool list (to confirm), incidents.

### Decided (Harry)
- Direction: project reference documents → handbook → platform.
- Reference priority: the source document "Bản chất của việc dùng AI để viết SRS, Code, architecture" is the main frame; `Digital_Foundry.pdf` (a 65-page governance / operating model set) supplements it, scaled down for an SME.
- **Platform coding is paused** until the handbook is reconciled. Approved design docs may change.

### Decided (review 02, Q1–Q3)
- Two-dimensional agent control: autonomy L0–L4 (source Framework v1/v2) + oversight HITL / HOTL / AUDIT.
- 2+N team by default; Digital Foundry roles as hats.
- G1–G8 kept; oversight per gate depends on risk tier.

### Decided (Q4–Q6)
- Handbook structure v2 accepted (new Ch.6 governance, Ch.9 adoption roadmap, Ch.18 timeouts/rollback, Ch.19 approval queues, Ch.20 agent lifecycle; templates T12–T18; appendix E).
- Autonomy codes **L0–L4** as in the source (draft v1.0 meanings obsolete).
- Escalation SLAs: Critical 15 min, High 1 h, Medium 1 working day, Low 3 working days.

### Changed
- Handbook chapters renumbered and renamed (Part I Ch.1–9, Part II Ch.10–20); contents v0.2.
- Codes table v0.4; Ch.1 v0.4; diagram D1 redrawn (red / orange / blue by oversight).
- Codes table v0.3 rebuilt accordingly (phases with mandatory artifacts, gate × risk matrix, role hats, Stage A/B/C, PRI-0…3, escalation severity).
- CLAUDE.md and README updated; design docs flagged as outdated until revised.

### Added
- `_review/02-handbook-vs-references.md`: coverage map, 9 conflicts, proposed handbook structure v2, platform impact.

## [1.2.0] — 2026-09-24

### Changed
- **The whole repo is now in English** (decision: Harry, 2026-09-24). Docs, handbook, diagrams, templates, scripts, CI.
- File and folder names translated (e.g. `design/D-02-mvp-scope.md`, `handbook/01-policy/`, `platform/GETTING-STARTED.md`). All links updated.
- D-02 NFR-08: everything in English; user-facing messages go through a message catalog so Vietnamese and Japanese can be added later. New decision Q5.
- Autonomy levels are written "Level 0–3".
- Writing style guide rewritten for plain English aimed at non-native readers.
- Approved design docs: translation only, content unchanged. Small consistency fixes: D-02 §11.1 (step C belongs to M-F), D-08 E02 adapter name `evidence-s3`, D-03 principles renamed AP1–AP7.

### Added
- `scripts/generate-backlog.py`: single source for D-08 and its CSV.

### Kept
- `_review/`: historical review notes stay in Vietnamese.

## [1.1.1] — 2026-09-24
- Handbook Ch.1 rewritten in natural Vietnamese; Vietnamese style guide added (superseded by 1.2.0).

## [1.1.0] — 2026-09-24
- `platform/GETTING-STARTED.md` (then `KHOI-DONG.md`): push to GitHub, configure, create issues, first task A01.
- `scripts/create-issues.py`: milestones, labels, 40 issues from D-08 (dry-run, no duplicates).
- Handbook Ch.1 executive summary (draft).

## [1.0.x] — 2026-09-24
- Repo named `agentic-sdlc-framework`. README and CLAUDE.md describe framework = handbook + platform.
- `.github/pull_request_template.md` and template T2.

## [1.0-design] — 2026-09-24
- Harry approved D-01, D-02, D-03, D-05, D-07, D-08, D-09 and diagrams D1, D9–D13. Tag `design-v1.0`.

## [0.13] — 2026-09-24 (review fixes)
- SeaweedFS replaces MinIO (no longer maintained); Valkey replaces Redis (licence).
- GitHub events by polling in the MVP, webhooks later (ADR-M11).
- FR-11: intent creator cannot approve G1 or G7.
- D-05: `actor_type` with `agent`, `succeeded_proposal_only`, evidence `proposal`, `git_event_cursors`, `runs.triggered_by`.
- D-08: M-D tasks renamed `E01…E07`.

## [0.8 – 0.12] — 2026-09-24
- D-03: OpenBao (Vault licence is BSL), internal server of moderate size, unseal key custody (Shamir 3-of-2).
- D-05 data model (17 tables, append-only tables, per-tenant audit hash chain); Evidence Packs kept 6 months; `api_tokens`.
- D-08 MVP backlog (40 tasks, 5 milestones, critical path) + CSV. `design/QUESTIONS.md`.

## [0.1 – 0.7] — 2026-09-24
- Repo skeleton (handbook + design + platform + diagrams), codes table (4 autonomy levels, 8 gates, P1–P6).
- D-01 build vs buy (WeKnora, BMAD, LiteLLM, vLLM); D-07 model and token management; D-02 MVP scope; D-09 sample pilot repo; D-03 MVP architecture.
- Monorepo layout; platform first, trial later.
