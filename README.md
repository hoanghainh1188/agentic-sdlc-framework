# Agentic SDLC Framework

**A way to let AI coding agents take part in software delivery without giving up control.** The framework has two parts that work together:

| Part | What it is | For |
|---|---|---|
| **Handbook** (`handbook/`) | Policies, a 6-phase process, 8 gates, roles, templates, checklists and runbooks | People: leadership, PM / BrSE, developers, reviewers, testers |
| **Platform** (`platform/`) | Self-hosted software that **enforces** the handbook: it runs AI agents through the 8 gates, keeps evidence and an audit log, and measures tokens and cost | The delivery team, every day |

The handbook says **what must happen and why**. The platform **makes sure it happens**. The design documents (`design/`) connect the two.

Built for small and medium software companies, including those working for Japanese clients. Everything is in plain English, written for non-native readers; the platform's messages go through a catalog, so Vietnamese and Japanese can be added.

---

## 1. In one sentence

> AI takes part in every stage of software development, but every task passes **8 gates** (G1–G8) with **the right human approvers**, **evidence**, an **audit log that cannot be altered**, and **token and cost measured** per client, project and task.

![Overview: 6 phases and 8 gates](diagrams/svg/d1-overview-6-phases.svg)

Red: always approved by a person (HITL, human in the loop). Orange: oversight depends on risk. Blue: an automatic policy check. Details: [codes table §4](handbook/00-introduction/05-codes.md).

## 2. Status

| Part | State |
|---|---|
| Platform | **MVP built.** A task goes through every gate, G1 to G8, in automated end-to-end tests on the sample repository's shape, and every requirement has its tests ([MVP definition of done](design/MVP-DONE.md)). A read-only web dashboard is included |
| Next step | **Trial M-E:** ten sample tasks on the sample repository with a real team, to measure gate waiting times, cost and rework ([trial plan](design/M-E-TRIAL-PLAN.md)) |
| Before production use | TLS and backups on the target server, and one run with a commercial API model ([open items](design/MVP-DONE.md)) |
| Handbook | Version 1.0, all parts written; approval of the whole handbook is in progress |

## 3. Where to start

| You are | Read |
|---|---|
| **Leadership** deciding whether to adopt | This page, then handbook Part I: [Ch.1 summary](handbook/01-policy/ch01-executive-summary.md) and [Ch.9 adoption roadmap](handbook/01-policy/ch09-adoption-roadmap.md) |
| **Bringing a project team onto the platform** (tech lead, leadership) | [platform/ROLLOUT-GUIDE.md](platform/ROLLOUT-GUIDE.md): where each role starts, the rollout phase by phase, the first week, common mistakes |
| **A team member** (Person A, Person B, PM / BrSE) | [platform/USER-GUIDE.md](platform/USER-GUIDE.md): one task from G1 to G8, by role, with the commands and what to do when something goes wrong |
| **Installing the platform** (operator) | [platform/deploy/README.md](platform/deploy/README.md), "Fresh deployment": from an empty checkout to the first task with Docker Compose; runbook [T11](handbook/03-templates/T11-openbao-runbook.md) |
| **Working on the platform's code** | [CONTRIBUTING.md](CONTRIBUTING.md) and [platform/GETTING-STARTED.md](platform/GETTING-STARTED.md) |
| **Working on the handbook** | [CONTRIBUTING.md](CONTRIBUTING.md), the [contents](handbook/00-introduction/01-contents.md) and the [writing style](handbook/00-introduction/06-writing-style.md) |

## 4. How it works

**A task goes through eight gates.** A person describes the change (G1), links a specification (G2) and a plan that says which files may change (G3). The platform checks the agent, its permissions and the budget (G4), runs the agent in an isolated sandbox, checks that it stayed inside the plan and the budget (G5), pushes the change and waits for CI and security scans (G6). A reviewer reviews and merges the pull request (G7), then approves the release with its evidence (G8).

**The oversight of each gate depends on the risk.** Low-risk work passes some gates automatically when their conditions hold, and a person can still block it for a few hours. High-risk work lets the agent only write a proposal. Critical work never runs an agent.

**People, in a "2+N" team:**

| Role | Does |
|---|---|
| **Person A**, the owner | Creates the work, writes specifications and plans, follows the agent |
| **Person B**, the independent reviewer | Approves plans, reviews and merges pull requests, approves releases |
| **Second approver** | A second approval for sensitive changes (migration, payment, personal data…) and Critical risk |
| **PM / BrSE** | Records the client's consent to AI use and the disclosure note |
| **Governance** (leadership) | Decides escalations nobody else answered |
| **N agents** | Write code inside the limits they were given |

**What the platform never does:**

- let the producer of a change approve it (the person who created the task, submitted the plan or allowed the run, and the agent itself);
- merge a pull request or deploy to production: people do;
- give an agent a real model key, access to secrets, or a way to push to the main branch;
- change or delete an audit record.

## 5. What the platform includes

| Area | What it does |
|---|---|
| **Gates G1–G8** | A workflow per task; approvals through GitHub comments (`/approve G3`), GitHub reviews (G7) or the `sdlc` command; each approval bound to the exact version it approved, with an expiry |
| **Agent runs** | OpenHands in a hardened sandbox per run, network limited to the model gateway and a package proxy; iteration, time and cost caps; loop detection; a kill switch that stops a run within minutes |
| **Scope and budget** | Changed files compared with the approved plan; budgets per tenant, task and run, with a warning at 80 % and a stop at 100 % |
| **Evidence** | An Evidence Pack per task (specification, plan, diff, CI, every gate decision, cost, the client AI disclosure note), exportable as Markdown, sealed at release |
| **Audit** | An append-only, hash-chained audit log per tenant, checked by `sdlc audit verify`, with a daily anchor in locked storage |
| **Escalations** | Time limits per severity, a backup owner, then governance; the work stays frozen while nobody answers |
| **Cost** | Every model call through one gateway (LiteLLM) with labels for tenant, project, task and run; cost reports, including wasted cost |
| **Retention** | Evidence kept 180 days by default, longer when configured; holds for disputes; the audit log kept at least two years |
| **Dashboard** | A read-only web page: tasks by gate, who each waits for and why, escalations, cost, gate waiting times, evidence |
| **Multi-tenant** | Every record belongs to a tenant; every query filters by it |

Interfaces keep the platform open to change: the Git host (GitHub today), the agent (OpenHands today), the policy engine and the model provider can each be replaced without changing the core.

## 6. Technology

| Layer | Choice |
|---|---|
| Platform | TypeScript: an API (NestJS), a workflow worker (Temporal), a sandbox runner, the `sdlc` command, the dashboard (Preact) |
| Self-hosted services | PostgreSQL, Temporal, LiteLLM, Langfuse, SeaweedFS (object storage), Valkey, OpenBao (secrets, contract signing) |
| Deployment | Docker Compose on one self-hosted server; no managed cloud service needed |
| Models | API models and self-hosted models, all through the LiteLLM gateway |
| Licences | Every reused component allows commercial use ([build vs buy](design/D-01-build-vs-buy.md)) |

## 7. Repository layout

```text
.
├── handbook/        # The handbook: introduction, policy (Ch.1–9), playbook (Ch.10–20), templates (T1–T18)
├── platform/
│   ├── apps/        # api, worker, runner, cli, dashboard
│   ├── packages/    # core, contracts, config, messages, secrets, telemetry, api-schemas, adapters/*
│   ├── deploy/      # Docker Compose, OpenBao and SeaweedFS set-up
│   ├── tests/       # unit, integration and end-to-end tests
│   ├── USER-GUIDE.md, ROLLOUT-GUIDE.md, GETTING-STARTED.md
├── design/          # Design documents (D-xx), decisions (ADR-Mxx), open questions
├── diagrams/        # Mermaid sources and SVG
└── scripts/         # Backlog and issue tools
```

## 8. Documents

| Topic | Document |
|---|---|
| Codes: phases, gates, autonomy levels, oversight modes, risk tiers, roles | [Codes table](handbook/00-introduction/05-codes.md) |
| Handbook contents | [Contents](handbook/00-introduction/01-contents.md) |
| MVP scope and requirements | [D-02](design/D-02-mvp-scope.md) |
| Architecture | [D-03](design/D-03-mvp-architecture.md) |
| Data model | [D-05](design/D-05-data-model.md) |
| Models, tokens and cost | [D-07](design/D-07-model-and-token-management.md) |
| The sample repository used for tests and the trial | [D-09](design/D-09-sample-pilot-repo.md) |
| What the web interface may offer next | [MVP+1 interface scope (draft)](design/MVP1-UI-SCOPE.md) |
| Every design document and decision | [design/README.md](design/README.md) |
| Diagrams | [diagrams/README.md](diagrams/README.md) |
| Changes | [CHANGELOG.md](CHANGELOG.md) |

## 9. Licence

Proprietary: a company asset, not open source and not published.
