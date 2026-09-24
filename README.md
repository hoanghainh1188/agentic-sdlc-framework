# Agentic SDLC Framework

**Agentic SDLC Framework = Handbook + Platform.** Both parts work together and live in one repo:

| Part | What it is | For |
|---|---|---|
| **Handbook** (`handbook/`) | Policies, the 6-phase process, 8 gates, roles, responsibilities, templates, checklists, runbooks | People: leadership, PM/BrSE, developers, testers |
| **Platform** (`platform/`) | Self-hosted software that **enforces** the handbook: runs AI agents through 8 gates, stores evidence and an audit log, measures tokens | The delivery team, every day |

The handbook says **what must happen and why**. The platform **makes sure it happens**. The design documents (`design/`) connect the two.

Direction of dependency: **project reference documents → handbook → platform**.

Built for small and medium software companies working for Japanese clients. Internal use first, then offered to clients.

| Item | Value |
|---|---|
| Repository | `agentic-sdlc-framework` |
| Language | English (see [writing style](handbook/00-introduction/06-writing-style.md)) |
| Handbook status | Version 1.0, all parts written. **Not yet approved as a whole**; chapter approvals are interim (see handbook contents) |
| Repository | `github.com/harryforge/agentic-sdlc-framework` (private). Hosted under a **personal account** — risk accepted by Harry, 2026-09-24 |
| Platform status | Design version 1.0 approved (2026-09-24, tag `design-v1.0`). **Coding the whole backlog now**, starting with A01; rework accepted after the handbook is approved |
| Current work | Review of the handbook as a whole (Ch.13–20, Part 0 and templates still awaiting comments) |
| Change log | [CHANGELOG.md](CHANGELOG.md) |
| Instructions for Claude Code | [CLAUDE.md](CLAUDE.md) |

An "AI agent" is an AI assistant that can carry out several steps in a row by itself (read code, change code, run tests…).

---

## 1. What the framework does (one sentence)

> AI takes part in every stage of software development, but every task must pass **8 gates** (G1–G8), defined by the handbook and enforced by the platform, with **the right human approvers**, **evidence**, an **audit log that cannot be altered**, and **token / cost measured** per client, project and task.

![Overview: 6 phases and 8 gates](diagrams/svg/d1-overview-6-phases.svg)

Red: always approved by a person (HITL). Orange: oversight depends on risk. Blue: automatic policy check. Details: [codes table §4](handbook/00-introduction/05-codes.md).

---

## 2. Key decisions

| Topic | Decision | Document |
|---|---|---|
| Approach | Build the platform ourselves (option C). Platform first, then trial, then adjust | D-01, D-02 |
| Codes | 6 phases P1–P6 · autonomy L0–L4 + oversight HITL/HOTL/AUDIT · 8 gates G1–G8 with risk-based oversight · 2+N team | [Codes table](handbook/00-introduction/05-codes.md) (v0.3, draft) |
| Architecture | Modular monolith in TypeScript: `api` (NestJS), `worker` (Temporal), `runner`, `cli` | D-03 |
| First agent | OpenHands (Agent Server called over REST) | D-02, D-03 |
| Git host | GitHub first (GitLab later). Events read by **polling** in the MVP | D-02, D-03 |
| Models | Both API and self-hosted models, through **LiteLLM**. The MVP uses API models only | D-07 |
| Hosting | Fully self-hosted with Docker Compose on **one internal server** | D-03 |
| Reused components | PostgreSQL, Temporal, LiteLLM, Langfuse, **SeaweedFS**, **Valkey**, **OpenBao** | D-01 |
| Secrets | OpenBao; unseal key split into 3 shares, any 2 open it | D-03 sections 8, 10.2 |
| Approvals | Via the `sdlc` CLI and GitHub comments (`/approve G3`). No web UI in the MVP | D-02 |
| Separation of duties | 2+N: Person A owns and executes, Person B approves G3/G7/G8; the producer never approves its own output | Codes table §5 (D-02 FR-11 to be revised) |
| Data | Multi-tenant from day one. Per-tenant audit hash chain. Evidence Packs kept 6 months | D-05 |
| Language | Everything in English. User-facing messages through a message catalog (Vietnamese / Japanese can be added) | D-02 NFR-08 |
| Test repo | Sample repo `pilot-order-inventory` (Vue + NestJS + PostgreSQL), separate repo | D-09 |

---

## 3. Roadmap

### Handbook

| Part | Content | Written where | Status |
|---|---|---|---|
| Part 0 | Contents, glossary, principles, codes, writing style | Outside Claude Code | 🟨 Codes v0.4, contents v0.2, style done |
| Part I | Policy for leadership (Ch.1–9) | Outside Claude Code | 🟨 Ch.1 draft |
| Part II | Playbook for the 6 phases (Ch.10–20) | General process: outside Claude Code. Platform usage: Claude Code, in the same PR as the code | ⬜ |
| Part III | Templates, checklists, runbooks (T1–T18) | Drafted outside Claude Code; runbooks written by Claude Code | 🟨 T2 done |

### Platform

| Milestone | Content | Status |
|---|---|---|
| M-A | Foundation: monorepo, Docker Compose, OpenBao, database, audit, CI, backups | ⬜ |
| M-B | Intent + G1–G3 | ⬜ |
| M-0 | Sample repo (right before M-C) | ⬜ |
| M-C | Run + OpenHands + G4–G6 | ⬜ |
| M-D | G7–G8 + Evidence Pack + cost report | ⬜ |
| M-E | Trial of T01–T10 on the sample repo; collect data | ⬜ |
| M-F | Adjust, then trial on a real internal tool | ⬜ |

All 40 tasks: [design/D-08-mvp-backlog.md](design/D-08-mvp-backlog.md).

---

## 4. Repo layout

```text
.
├── README.md                     # This file
├── CLAUDE.md                     # Instructions for Claude Code (rules, per-session workflow)
├── CHANGELOG.md                  # Version history
├── .github/
│   ├── pull_request_template.md  # PR template with AI disclosure (T2)
│   └── workflows/                # CI (currently: render SVG from Mermaid)
├── handbook/                     # HANDBOOK: policies, process, templates (in progress)
│   ├── 00-introduction/          # Contents, glossary, principles, codes, writing style
│   ├── 01-policy/                # Part I: policy and governance (leadership)
│   ├── 02-playbook/              # Part II: 6 phases, gates, review (delivery team)
│   ├── 03-templates/             # Part III: templates, checklists, runbooks
│   └── appendix/
├── platform/                     # PLATFORM: code (none yet)
│   ├── GETTING-STARTED.md        # Set up GitHub, create issues, first Claude Code task
│   ├── apps/                     # api, worker, runner, cli
│   ├── packages/                 # core, contracts, adapters/*, config
│   ├── deploy/                   # docker-compose, OpenBao scripts, backups
│   └── tests/integration/        # Scenarios N1–N6, tasks T01–T10
├── design/                       # Platform design (D-xx), connecting handbook and platform — approved
│   ├── README.md                 # Index + approval status
│   └── QUESTIONS.md              # Questions raised while coding
├── scripts/                      # create-issues.py, generate-backlog.py
├── diagrams/                     # Mermaid sources (src/) and SVG (svg/)
└── _review/                      # Review notes (historical, in Vietnamese); not a source of requirements
```

---

## 5. Main documents

**Handbook**: start from the [contents](handbook/00-introduction/01-contents.md) and the [codes table](handbook/00-introduction/05-codes.md).

**Platform design**:

| Code | Document |
|---|---|
| D-01 | [Build vs buy](design/D-01-build-vs-buy.md) |
| D-02 | [MVP scope (FR/NFR, definition of done)](design/D-02-mvp-scope.md) |
| D-03 | [MVP architecture (interfaces, Run Contract, security, deployment)](design/D-03-mvp-architecture.md) |
| D-05 | [Data model](design/D-05-data-model.md) |
| D-07 | [LLM model and token management](design/D-07-model-and-token-management.md) |
| D-08 | [MVP backlog](design/D-08-mvp-backlog.md) · [CSV for issues](design/D-08-backlog.csv) |
| D-09 | [Sample pilot repo](design/D-09-sample-pilot-repo.md) |

Diagrams: [diagrams/README.md](diagrams/README.md).

---

## 6. Who reads what

| Reader | Read |
|---|---|
| Developer / Claude Code (building the platform) | `CLAUDE.md` → D-08 (current task) → D-02, D-03, D-05 |
| Tech lead / architect | All of `design/` |
| Leadership | This README, handbook Part I (Ch.1–9) |
| PM / BrSE, reviewers, testers | Handbook Part 0, Part II, templates |
| Handbook authors | This README, the codes table, the writing style, D-02 (so the process matches the platform) |

---

## 7. Getting started

**Writing the handbook:** follow the 9-section structure, source tags, the codes table and the writing style (section 8). Handbook changes also go through pull requests.

**Coding the platform:** no code yet. Follow **[platform/GETTING-STARTED.md](platform/GETTING-STARTED.md)**: push to GitHub, create issues, give task A01 to Claude Code. Then:

1. Read `CLAUDE.md`.
2. Take the next task in D-08 (starting with **A01**).
3. Follow the per-session workflow in D-08 section 5.

---

## 8. Conventions

**Writing**
- Plain English for non-native readers. See the [writing style](handbook/00-introduction/06-writing-style.md).
- Short sentences, lists and tables. Explain technical terms on first use.
- Source tags: **[Doc]** internal · **[External]** with a link · **[Proposal]** not yet backed by a source.
- Process documents use the 9-section structure (see the [handbook contents](handbook/00-introduction/01-contents.md)).
- Use only the codes in the [codes table](handbook/00-introduction/05-codes.md). Dates as `YYYY-MM-DD`.

**Handbook ↔ platform consistency**
- Handbook and platform use **the same codes** and **the same names** (gates, autonomy levels, roles).
- A handbook process change that affects the platform → raise it in `design/QUESTIONS.md` or update the relevant D-xx.
- A platform change visible to users → update the matching handbook chapter in the same PR.

**Code**
- Code, identifiers, commits and comments: English.
- User-facing messages (CLI, PR comments): English by default, through a message catalog.

**Diagrams**
- Mermaid sources in `diagrams/src/`, SVG in `diagrams/svg/`. CI renders SVG whenever a `.mmd` changes.

---

## 9. Contributing

1. Branch from `main` (code: `task/<ID>-<short-name>`).
2. Open a pull request using the template (AI disclosure).
3. Handbook changes: separate PR, approved by the handbook owner. Changes to **approved** documents in `design/`: separate PR with the reason; new technical decisions → add an ADR.
4. Record notable changes in `CHANGELOG.md`.

| Role | Person |
|---|---|
| Repo owner / design approver | Harry |
| Handbook owner | _(not decided)_ |
| 3 OpenBao unseal key holders | _(not decided, see D-03 section 10.2)_ |

Licence: internal company asset, not published.
