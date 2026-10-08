# Platform design documents

| Code | Document | Status | Approved on |
|---|---|---|---|
| D-01 | [Build vs buy](D-01-build-vs-buy.md) | ✅ Approved | 2026-10-08 (0.7) |
| D-02 | [MVP scope](D-02-mvp-scope.md) | ✅ Approved | 2026-10-08 (1.6) |
| D-03 | [MVP architecture](D-03-mvp-architecture.md) | ✅ Approved | 2026-09-24 |
| D-04 | Physical design and stack | ➖ Merged into D-03 (sections 8–11) and D-07 for the MVP | |
| D-05 | [MVP data model](D-05-data-model.md) | ✅ Approved | 2026-09-24 |
| D-06 | Platform evaluation and metrics | ⬜ After the MVP (uses M-E data) | |
| D-07 | [LLM model and token management](D-07-model-and-token-management.md) | ✅ Approved | 2026-09-24 |
| D-08 | [MVP backlog](D-08-mvp-backlog.md) · [CSV](D-08-backlog.csv) | ✅ Approved | 2026-09-24 |
| D-09 | [Sample pilot repo: orders / inventory](D-09-sample-pilot-repo.md) | ✅ Approved | 2026-09-24 |
| — | [Open questions raised while coding](QUESTIONS.md) | In use | |
| — | [MVP done: the definition-of-done check](MVP-DONE.md) (task E07): each D-02 §10 criterion with the test that proves it, open items, numbers | Draft | |
| — | [Positioning](POSITIONING.md): what the framework offers and to whom, compared with the alternatives; risks, what to confirm; the business model (open for everyone, services only) | Draft; §7 decided 2026-10-08 | |
| — | [MVP+1 user interface scope](MVP1-UI-SCOPE.md): candidate functions by role, what never goes in the interface, conditions for actions, proposed order; checked against the M-E data | Draft | |
| — | [M-E trial plan](M-E-TRIAL-PLAN.md): tasks T01–T10 on the sample repo, prerequisites, roles, order, what is measured, the data report, stop rules | Approved (Harry, 2026-10-06) | |
| ADR-M09 | [Database access and migration tooling](ADR-M09-database-tooling.md) (task A06) | Proposed | |
| ADR-M10 | [OpenHands Agent Server: result of the C01 PoC](ADR-M10-openhands-agent-server.md) (task C01) | Proposed | |
| ADR-M16 | [Monorepo tooling](ADR-M16-monorepo-tooling.md) (task A01) | ✅ Accepted | 2026-09-25 |
| ADR-M17 | [Docker Compose infrastructure](ADR-M17-compose-infrastructure.md) (task A02) | Proposed | |
| ADR-M18 | [Project configuration package and message catalog](ADR-M18-config-and-message-catalog.md) (task A05) | Proposed | |
| ADR-M19 | [OpenBao bootstrap: tool, policy layout, token handling](ADR-M19-openbao-bootstrap.md) (task A03) | Proposed | |
| ADR-M20 | [Registry: intents, gate decisions, POLICY, void links, reason codes](ADR-M20-registry.md) (task B02) | Proposed | |
| ADR-M21 | [OpenBao client for the platform processes](ADR-M21-openbao-client.md) (task A04) | Proposed | |
| ADR-M22 | [Run Contract: schema, signed form, verification, run events](ADR-M22-run-contract.md) (task C02) | Proposed | |
| ADR-M23 | [GitHub adapter: HTTP client, App authentication, polling cursor, webhook check](ADR-M23-github-adapter.md) (task B05) | Proposed | |
| ADR-M24 | [LiteLLM adapter, keys from OpenBao, Cost Controller (part 1)](ADR-M24-litellm-cost-controller.md) (task C03) | Proposed | |
| ADR-M25 | [Runner: sandbox egress, image, workspace, Docker access, clean-up](ADR-M25-runner-sandbox.md) (task C04) | Proposed | |
| ADR-M26 | [API app (NestJS), personal API tokens, admin bootstrap, gate commands](ADR-M26-api-app.md) (task B03) | Proposed | |
| ADR-M27 | [GitHub poller and comment commands](ADR-M27-github-poller.md) (task B06) | Proposed | |
| ADR-M28 | [Escalations: routing, durable clocks in the database, freeze](ADR-M28-escalations.md) (task B11; partly supersedes ADR-M14) | Proposed | |
| ADR-M29 | [OpenHands adapter: driving the agent in the sandbox](ADR-M29-openhands-adapter.md) (task C05) | Proposed | |
| ADR-M30 | [Intent workflow on Temporal: a thin loop over the database](ADR-M30-intent-workflow.md) (task B07) | Proposed | |
| ADR-M31 | [Agent register: table, lifecycle, operator commands, the check before a run](ADR-M31-agent-register.md) (task C10) | Proposed | |
| ADR-M32 | [Project AI record: codes only, version history, who writes it, the G1 check](ADR-M32-project-ai-record.md) (task B12) | Proposed | |
| ADR-M33 | [Gate G4: the checks, the run proposal, and the handoff to the runner](ADR-M33-gate-g4.md) (task C06) | Proposed | |
| ADR-M34 | [Gate G5: the run's changes, the budget during the run, and the G5 decision](ADR-M34-gate-g5.md) (task C07) | Proposed | |
| ADR-M35 | [Observability: structured logs, OpenTelemetry traces, one OTLP pipeline to Langfuse](ADR-M35-observability.md) (task A08) | Proposed | |
| ADR-M36 | [CLI: API client and credentials](ADR-M36-cli-api-client.md) (task B04) | Proposed | |
| ADR-M37 | [Admin onboarding: tenant admins, projects, users, identities, roles, configuration](ADR-M37-admin-onboarding.md) (task B13) | Proposed | |
| ADR-M39 | [Spec linking and the spec hash check](ADR-M39-spec-linking.md) (task B08) | Proposed | |
| ADR-M40 | [Plan submission and the G3 approval](ADR-M40-plan-submission.md) (task B09) | Proposed | |
| ADR-M41 | [Gate G7: review and merge](ADR-M41-gate-g7.md) (task E01) | Proposed | |
| ADR-M42 | [The kill switch and loop detection](ADR-M42-kill-switch.md) (task C11) | Proposed | |
| ADR-M45 | [The cost report](ADR-M45-cost-report.md) (task E04) | Proposed | |
| ADR-M47 | [Gate waiting-time metrics](ADR-M47-gate-metrics.md) (task E06) | Proposed | |
| ADR-M48 | [Evidence Builder and the readable Evidence Pack](ADR-M48-evidence-builder.md) (task E02) | Proposed | |
| ADR-M49 | [Gate G8: release approval, sealing the Evidence Pack, closing the intent](ADR-M49-gate-g8.md) (task E03) | Proposed | |
| ADR-M51 | [Evidence retention: object lock, the purge, holds, archived projects](ADR-M51-evidence-retention.md) (task E05) | Proposed | |
| ADR-M52 | [SeaweedFS internal access: loopback binding and keys made at each start](ADR-M52-seaweedfs-internal-access.md) (task A12) | Proposed | |
| ADR-M53 | [Purge a project's data from Langfuse](ADR-M53-langfuse-purge.md) (task E08) | Proposed | |
| ADR-M54 | [A read-only web dashboard](ADR-M54-read-only-dashboard.md) (task U01) | Proposed | |
| ADR-M59 | [WeKnora for document knowledge: result of the K01 spike](ADR-M59-weknora-spike.md) (task K01) | Proposed | |
| ADR-M61 | [The structure of a spec, and G2 needs acceptance criteria](ADR-M61-spec-structure.md) (task S01) | Proposed | |
| ADR-M62 | [`sdlc plan draft`: a plan file draft from Spec Kit tasks or a BMAD story](ADR-M62-plan-draft.md) (task S02) | Proposed | |

**Version 1.0 (approved 2026-09-24, tag `design-v1.0`)**: D-02, D-03, D-05, D-08, D-09 aligned with the handbook (2+N roles, L0–L4, oversight matrix, forced HITL at G3, dual approval at G7, approval binding, escalation with SLA, project AI record, agent register, kill switch, retention). D-01 and D-07 unchanged.

Approved documents were translated into English on 2026-09-24. Content is unchanged; small consistency fixes are listed in each document's version history.

D-08 and its CSV are generated by `scripts/generate-backlog.py`. Edit the data in the script, not the generated files.

Content planned after the MVP:

| Content | Section of the earlier internal draft | Target |
|---|---|---|
| Full logical architecture, gate details | Ch.4 (except 4.14) | Extend D-03 |
| Physical design, vector DB | Ch.5 | Extend D-03 / D-07 |
| Platform evaluation, rubrics, scorecards | Ch.7, 6.11 | D-06 |
| AI-native competency framework | 8.6–8.8, Appendix B | Handbook (later) |
| Schemas, policies, sample code | Appendix A | platform/ |
