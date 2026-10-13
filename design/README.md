# Platform design documents

| Code | Document | Status | Approved on |
|---|---|---|---|
| D-01 | [Build vs buy](D-01-build-vs-buy.md) | ✅ Approved | 2026-10-08 (0.7) |
| D-02 | [Scope (v0.1 baseline)](D-02-mvp-scope.md) | ✅ Approved | 2026-10-08 (1.6) |
| D-03 | [Architecture](D-03-mvp-architecture.md) | ✅ Approved | 2026-09-24 |
| D-04 | Physical design and stack | ➖ Merged into D-03 (sections 8–11) and D-07 for v0.1 | |
| D-05 | [Data model](D-05-data-model.md) | ✅ Approved | 2026-09-24 |
| D-06 | Platform evaluation and metrics | ⬜ After v0.1 (uses M-E data) | |
| D-07 | [LLM model and token management](D-07-model-and-token-management.md) | ✅ Approved | 2026-09-24 |
| D-08 | [backlog](D-08-mvp-backlog.md) · [CSV](D-08-backlog.csv) | ✅ Approved | 2026-09-24 |
| D-09 | [Sample pilot repo: orders / inventory](D-09-sample-pilot-repo.md) | ✅ Approved | 2026-09-24 |
| — | [Open questions raised while coding](QUESTIONS.md) | In use | |
| — | [v0.1 baseline: definition of done](MVP-DONE.md) (task E07): each D-02 §10 criterion with the test that proves it, open items, numbers | Draft | |
| — | [Positioning](POSITIONING.md): what the framework offers and to whom, compared with the alternatives; risks, what to confirm; the business model (open for everyone, services only) | Draft; §7 decided 2026-10-08 | |
| — | [Web UI scope](MVP1-UI-SCOPE.md): the plan of the dashboard's actions (waves, what never goes in, the security of writes from a browser, tasks after approval); revised with the M-E data | Approved (V11) | |
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
| ADR-M38 | [Gate G6: the push, the pull request and CI](ADR-M38-gate-g6.md) (task C08) | Proposed | |
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
| ADR-M59 | [WeKnora for document knowledge: result of the K01 spike](ADR-M59-weknora-spike.md) (task K01) | Proposed; decision taken: option A, K02 deferred (QUESTIONS #300) | 2026-10-08 (the decision) |
| ADR-M61 | [The structure of a spec, and G2 needs acceptance criteria](ADR-M61-spec-structure.md) (task S01) | Proposed | |
| ADR-M62 | [`sdlc plan draft`: a plan file draft from Spec Kit tasks or a BMAD story](ADR-M62-plan-draft.md) (task S02) | Proposed | |
| ADR-M63 | [OpenBao TLS everywhere, and backups](ADR-M63-openbao-tls-and-backups.md) (task A10) | Proposed | |
| ADR-M64 | [Taking an L1 proposal forward: the download and the end of the intent](ADR-M64-l1-proposal-hand-over.md) (task C13) | Proposed | |
| ADR-M65 | [The trial report: an anonymous summary built from the existing reads](ADR-M65-trial-report.md) (task V01) | Proposed | |
| ADR-M66 | [The platform's images on GHCR for each release](ADR-M66-ghcr-images.md) (task V04) | Proposed | |
| ADR-M67 | [Team access from other machines: a TLS reverse proxy](ADR-M67-team-access.md) (task V09) | Accepted | 2026-10-12 |
| ADR-M72 | [The CLI on npm: one bundled file, published from a tag with provenance](ADR-M72-cli-npm-package.md) (task V05) | Proposed | |
| ADR-M73 | [Actions in the web dashboard: GitHub sign-in, sessions, CSRF, passkey step-up](ADR-M73-dashboard-actions.md) (task V11; built by U05–U09) | Accepted | |
| ADR-M76 | [The trial stack's key file: age with a passphrase, through the library `age-encryption`](ADR-M76-trial-key-file.md) (task V08) | Accepted | |
| ADR-M79 | [The agent efficiency report](ADR-M79-agent-metrics.md) (task V13) | Proposed | |


## Number blocks (QUESTIONS and ADR numbers)

Each session gets its own block of QUESTIONS numbers and, if it needs one, an ADR number, when it is queued. It uses only the numbers it was given. `CLAUDE.md` ("Current constraints") lists the next free numbers and the blocks held now. This section keeps the full history (moved from `CLAUDE.md` on 2026-10-12, QUESTIONS #424, #425). When a block or an ADR number is assigned or used, update both places.

- `design/QUESTIONS.md` numbers: each session gets its own block when it is queued and uses only numbers from that block. Taken: B01 #16–#19, A03 #20, docs #21, B02 #22–#26 (used #22), A04 #27–#31, C02 #32–#36 (used #32–#35), A11 #37–#41, B05 #42–#46 (used #42–#45), C03 #47–#51 (used none), C04 #52–#56 (used #52–#54 so far), docs #57, docs #58–#62 (used #58–#59), B03 #63–#67, B06 #68–#72 (used #68), B11 #73–#77, C05 #78–#82, C05 session 2 #83–#87, B07 #88–#92, C10 #93–#97, B07 session 2 #98–#102 (used #98), B12 #103–#107 (used #103–#106), C06 #108–#112 (used #108–#112), R01 #113–#117 (used none), R02 #118–#122 (used none), R03 #123–#124 (used #123–#124), R04 #125–#129 (used #125–#126), C07 #130–#134 (used #130–#134), A08 #135–#139 (used none), test maintenance #140–#144 (used #140), B04 #145–#149 (used none), B13 #150–#154, C08 #155–#159 (used #155–#159), B08 #160–#164 (used #160–#164), B09 #165–#169 (used #165–#169), C11 #170–#174 (unused), E01 #175–#179 (used #175–#179), C11 #180–#184 (used #180–#184), B10 #185–#189 (used none), E01 PR 2 #190–#194 (used #190–#191), E04 #195–#199 (used #195–#197), C11 PR 2 #200–#204 (used none), E06 #205–#209 (used #205–#207), B09 PR 2 #210–#214 (used #210–#212), E02 #215–#219 (used #215–#219), E03 #220–#224 (used #220–#222), C12 #225–#229 (used #225), C09 #230–#234 (used #230), E05 #235–#239 (used #235–#239), E05 PR 2 #240–#244, A12 #245–#249 (used #245–#246), E08 #250–#254 (used #250–#253), coordinator #255 (used #255: the read-only dashboard), U01 #260–#264 (used #260–#264), U02 #265–#269 (used #265), #177 PR 1 #270–#274 (used none), #177 PR 2 #275–#279 (used none), untar test #280–#284 (used none), coordinator #285 (BMAD / Spec Kit and WeKnora before M-E), S01 #290–#294, S02 #295–#299, K01 #300–#304, K02 #305–#309, docs review #310–#324 (used none), A10 #325–#329 (used #325–#329), A10 ClickHouse #330–#334 (used #330), C13 #335–#339 (used #335–#337), V01 #340–#344 (used #340–#342), V02 #345–#349 (used #345–#346), V03 #350–#354 (used #350–#351), coordinator #355–#359 (used #355–#358), coordinator #360–#364 (used #360–#364), V05 + V06 #365–#369, V04 #370–#374 (used #370–#371), V11 #375–#379 (used #375–#379), V11 design #380–#384 (used #380), V12 #390–#394 (used #390), U05 #385–#389 (used #385–#389), backlog X11–X13 #395–#399 (used #395), V07 #400–#404 (used #400–#404), V09 #405–#409 (used #405–#409), U06 #410–#414 (used #410–#414), V08 #415–#419 (used #415–#419). coordinator #420–#424 (used #420–#424). slim CLAUDE.md #425–#429 (used #425–#426), V13 #430–#434 (used #430–#434), L02 #435–#439. coordinator #440–#444 (used #440). Next free block: #445–#449 (then #450–#454, …).
- ADR numbers (`design/ADR-Mnn-*.md`): assigned the same way, when a session is queued; a session that needs an ADR uses only its assigned number. Taken: up to ADR-M24 (C03); ADR-M25 assigned to C04; ADR-M26 assigned to B03; ADR-M27 assigned to B06; ADR-M28 assigned to B11, ADR-M29 assigned to C05, ADR-M30 assigned to B07, ADR-M31 assigned to C10, ADR-M32 used by B12, ADR-M33 assigned to C06, ADR-M34 used by C07, ADR-M35 used by A08, ADR-M36 used by B04, ADR-M37 assigned to B13, ADR-M38 used by C08, ADR-M39 used by B08, ADR-M40 used by B09, ADR-M41 used by E01, ADR-M42 used by C11, ADR-M43 reserved for B10 (not used), ADR-M44 reserved for E01 PR 2 (not used), ADR-M45 used by E04, ADR-M46 assigned to C11 PR 2 (unused), ADR-M47 used by E06, ADR-M48 used by E02, ADR-M49 used by E03, ADR-M50 assigned to C09 (unused), ADR-M51 used by E05, ADR-M52 used by A12, ADR-M53 used by E08, ADR-M54 assigned to U01 (the read-only dashboard), ADR-M55 assigned to U02 (unused), ADR-M56 and M57 assigned to #177 PR 1 and PR 2 (unused), ADR-M58 to the untar test (unused), ADR-M59 to K01, ADR-M60 to K02, ADR-M61 to S01, ADR-M62 to S02, ADR-M63 to A10 (OpenBao TLS and backups), ADR-M64 to C13 (the L1 proposal), ADR-M65 to V01 (`sdlc trial report`), ADR-M66 used by V04 (images on GHCR), ADR-M67 to V09 (team access), ADR-M68 to X01 (second agent), ADR-M69 to X02 (tool register, MCP), ADR-M70 to X09 (Git hosts), ADR-M71 to L01 (vLLM), ADR-M72 to V05 (the CLI on npm), ADR-M73 used by V11 (the dashboard's actions, built by U05–U09), ADR-M74 to X12 (agent memory), ADR-M75 to U05 (if it needs one), ADR-M76 used by V08 (the trial key file), ADR-M77 held for U06 (U06 PR 1 used none). ADR-M78 to L02 (the evaluation harness, QUESTIONS #422). ADR-M79 used by V13 (the agent efficiency report). Next free: ADR-M80 (then M81, …).

**Version 1.0 (approved 2026-09-24, tag `design-v1.0`)**: D-02, D-03, D-05, D-08, D-09 aligned with the handbook (2+N roles, L0–L4, oversight matrix, forced HITL at G3, dual approval at G7, approval binding, escalation with SLA, project AI record, agent register, kill switch, retention). D-01 and D-07 unchanged.

Approved documents were translated into English on 2026-09-24. Content is unchanged; small consistency fixes are listed in each document's version history.

D-08 and its CSV are generated by `scripts/generate-backlog.py`. Edit the data in the script, not the generated files.

Content planned after v0.1:

| Content | Section of the earlier internal draft | Target |
|---|---|---|
| Full logical architecture, gate details | Ch.4 (except 4.14) | Extend D-03 |
| Physical design, vector DB | Ch.5 | Extend D-03 / D-07 |
| Platform evaluation, rubrics, scorecards | Ch.7, 6.11 | D-06 |
| AI-native competency framework | 8.6–8.8, Appendix B | Handbook (later) |
| Schemas, policies, sample code | Appendix A | platform/ |
