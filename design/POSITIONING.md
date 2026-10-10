# Positioning: what the framework offers, and to whom

| Item | Value |
|---|---|
| Version | 0.4 |
| Date | 2026-10-10 |
| Status | **Draft** (coordinator, from a discussion with Harry). Hypotheses to test with the trial M-E and with real clients; not approved, except §7 (decided by Harry, 2026-10-08); 0.4 approved by Harry on 2026-10-10 (wording only: "MVP" retired, v0.1 baseline and Later; meaning unchanged; QUESTIONS #360) |
| Readers | Harry, leadership |
| Related documents | D-01 (build vs buy, the alternatives), D-02 §2 (v0.1 goal), `design/M-E-TRIAL-PLAN.md`, `design/MVP1-UI-SCOPE.md`, handbook Ch.1, Ch.9 |

---

## 1. Purpose

- Say what the framework offers that other ways of using AI coding agents do not, and to whom.
- List the risks of that position and what must be measured to confirm it.
- Prepare the decisions that follow from it (business model, scope, what to measure in M-E).

Everything here is an assessment **[Proposal]** built from the design documents and v0.1. There is no market data or trial data yet.

## 2. What the framework sells

Not "AI writes code": other tools do that as well or better. The framework sells **control and evidence when AI writes code**: the process (handbook), its enforcement (platform) and the record it leaves (Evidence Pack, audit log).

> Let a team use AI agents to write code for client projects, and still show the client who asked for what, who approved what, what the agent was allowed to do and did, what it cost, and that the client's data was used only with consent.

## 3. Compared with the alternatives

| Alternative | Its strength | What the framework adds |
|---|---|---|
| An AI coding assistant (Copilot, Cursor, Claude Code) plus normal pull request review | Cheap, familiar, good code, no new process | Gates before coding (spec, plan, file scope); limits on what the agent may do; a record a client can read; cost per client, project and task |
| GitHub's coding agent with its enterprise AI controls | Built into GitHub; audit and agent session logs | Works outside one Git host; risk-based gates G1–G8; an Evidence Pack per change; a per-project AI record; self-hosted data |
| Cloud agent platforms | Strong infrastructure, little to operate | No dependency on one cloud; client data can stay on the company's own server |
| A written process without a platform | No software cost | Enforcement by the system, not by discipline; a record that cannot be altered |

**What actually differs**, strongest first:

1. **An Evidence Pack and an audit trail per change**, readable by a client.
2. **Separation of duties enforced by the system**: the producer of a change never approves it.
3. **Control of client data**: the project AI record, data classes, the AI disclosure note.
4. **Fully self-hosted**, several model providers, cost measured per client, project and task.
5. **Fit with offshore delivery for Japanese clients**: the BrSE role, bilingual specs, a culture that expects complete records.

## 4. Who needs it

| Segment | Why | Fit |
|---|---|---|
| **Offshore software companies (Vietnam and elsewhere in Asia) working for Japanese clients** | Clients ask whether AI is used, how, and what happens to their data; the company needs an answer backed by records | **Strongest**; the company that builds the framework is one of them |
| Development teams in regulated sectors (finance, health, public sector) | Audit requirements; data must stay inside | Possible, but they expect certifications and a long trust-building period |
| Small product companies | Want AI speed | **Weak**: eight gates feel heavy; an assistant is enough |

## 5. Positioning statement (draft)

> **A process and a self-hosted platform that let software companies use AI agents on client projects while staying in control, measuring the cost, and keeping a record that proves how each change was made.**

## 6. Risks of this position

| Risk | Why it matters | How to watch it |
|---|---|---|
| The process is too heavy | People work around a process that slows them down; the value disappears | M-E: human minutes per task, waiting time per gate (`sdlc metrics gates`); see section 6.1 |
| Agent quality | If the agent succeeds only on very small tasks, the value shrinks to "records for small tasks" | M-E: the share of tasks done right the first time, or after one request for changes |
| Large vendors move fast | Git hosts and cloud providers add agent governance | Keep the lasting advantages: self-hosting, several Git hosts and models, a process for client delivery; review this document every three months |
| The licence and the business model | Under MIT anyone may use and resell the code, so selling the software itself is not a model | Decided: open for everyone, services only (section 7) |

### 6.1. What a Low-risk task costs today

Most of the weight of a Low-risk task is waiting, not approvals.

- **Human steps (6):** the spec and plan files reach `main` through a reviewed pull request; Person A creates the intent, links the spec and submits the plan (three commands; the plan file is named after the intent code, so it can only be written after the intent exists); Person A approves G1; Person B reviews the agent's pull request (G7); a person who is not a producer merges it; Person B approves G8. G1, G7 and production G8 are mandatory rules M1–M3.
- **Waiting:** every HOTL pass opens a block window (default 4 working hours), and the platform waits for it before the next step: after G2 and G3 (before the run), after G5 (before the push), after G6 (before G7). Up to about 12 working hours, before any person answers. The test suites use 1 minute, so they never showed it.

| # | Lighter | Kind of change | Decision |
|---|---|---|---|
| A1 | A shorter block window (1 working hour) | Configuration only | For the trial M-E (`design/M-E-TRIAL-PLAN.md` D7) |
| B1 | A block window per gate, for example none after a G6 AUDIT pass | Design (D-03 §6, ADR-M30), then a task | Only if M-E shows nobody blocks within a window |
| B2 | One CLI command creates the intent and links its spec | A small task (D-08 U03) | Added to the backlog, after M-E |
| B3 | A per-project `release.environment`: a non-production release at Low risk is HOTL at G8 | Design and a task; the codes table already allows it (QUESTIONS #220) | Later |
| C1 | G1 passes on its own at Low risk | Handbook (rule M1) | Not proposed: G1 sets the risk tier every later gate depends on |

G1, G7 and production G8 stay HITL: they are the record the framework sells (who asked, who approved, who released).

## 7. Business model (decided by Harry, 2026-10-08)

**Open for everyone.** The code (MIT, [LICENSE](../LICENSE)) and the documentation (CC BY 4.0, [LICENSE-docs.md](../LICENSE-docs.md)) are open and stay open: never a closed or paid edition of the software or the handbook. If the project earns money later, it comes from services only:

| Service | Offer | Notes |
|---|---|---|
| Deployment and operation | Setting up and running the platform for a company (managed hosting), moving its process onto it | Revenue from operations, not licences |
| Consulting and training | The handbook as a method: readiness assessment (T17), rollout (ROLLOUT-GUIDE), training of the Person A and Person B roles | The handbook is the main asset, and it stays free to read and reuse |
| Support | Help with upgrades, incidents, configuration | |

Not chosen: open core (a commercial enterprise edition), and selling the software. A certification of "AI-governed delivery" is possible later, but needs a recognised standard and independent assessors.

Before the repository is made public, one session does the content review: `_review/`, `CLAUDE.md`, names of people and clients, a Gitleaks scan of the whole history, `SECURITY.md`, `CODE_OF_CONDUCT.md`, issue templates.

## 8. What to confirm, and when

| Question | Evidence | When |
|---|---|---|
| Is the process light enough? | Human minutes per task, gate waiting times | Trial M-E report |
| How much work does the agent really do? | Tasks done right first time; runs per task; wasted cost | Trial M-E report, then with an API model before M-F |
| Is the Evidence Pack useful to a client? | A sample pack read by a Japanese PM or a client contact; their feedback | During or after M-E |
| Will a company pay, and for what? | Conversations with two or three offshore companies or their clients | After M-E |

## Version history

| Version | Date | Author | Notes |
|---|---|---|---|
| 0.1 | 2026-10-07 | Claude (coordinator) | Draft from the discussion with Harry: what the framework sells, the alternatives, segments, a positioning statement, risks, business models, what to confirm |
| 0.2 | 2026-10-07 | Claude (coordinator) | §6.1: what a Low-risk task costs (human steps, block-window waits) and the ways to make it lighter |
| 0.3 | 2026-10-08 | Claude (coordinator), approved by Harry | §7 decided: open for everyone (MIT code, CC BY 4.0 documentation), services only; the content review before going public |
| 0.4 | 2026-10-10 | Claude (coordinator), approved by Harry | Wording only: "MVP" retired; v0.1.0 is the "v0.1 baseline", unscheduled work is "Later"; meaning unchanged (QUESTIONS #360) |
