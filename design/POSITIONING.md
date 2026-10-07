# Positioning: what the framework offers, and to whom

| Item | Value |
|---|---|
| Version | 0.1 |
| Date | 2026-10-07 |
| Status | **Draft** (coordinator, from a discussion with Harry). Hypotheses to test with the trial M-E and with real clients; not approved |
| Readers | Harry, leadership |
| Related documents | D-01 (build vs buy, the alternatives), D-02 §2 (MVP goal), `design/M-E-TRIAL-PLAN.md`, `design/MVP1-UI-SCOPE.md`, handbook Ch.1, Ch.9 |

---

## 1. Purpose

- Say what the framework offers that other ways of using AI coding agents do not, and to whom.
- List the risks of that position and what must be measured to confirm it.
- Prepare the decisions that follow from it (business model, scope, what to measure in M-E).

Everything here is an assessment **[Proposal]** built from the design documents and the MVP. There is no market data or trial data yet.

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
| The process is too heavy | People work around a process that slows them down; the value disappears | M-E: human minutes per task, waiting time per gate (`sdlc metrics gates`) |
| Agent quality | If the agent succeeds only on very small tasks, the value shrinks to "records for small tasks" | M-E: the share of tasks done right the first time, or after one request for changes |
| Large vendors move fast | Git hosts and cloud providers add agent governance | Keep the lasting advantages: self-hosting, several Git hosts and models, a process for client delivery; review this document every three months |
| The licence and the business model | Under MIT anyone may use and resell the code, so selling the software itself is not a model | Decide the business model (section 7) before the repository is made public |

## 7. Business models to decide

The code is MIT (2026-10-07). Models that fit an open licence:

| Model | Offer | Notes |
|---|---|---|
| Services | Setting up and running the platform for a company (managed hosting), migration of its process | Revenue from operations, not licences |
| Consulting and training | The handbook as a method: readiness assessment (T17), rollout (ROLLOUT-GUIDE), training of Person A and Person B roles | The handbook is the main asset |
| Certification | An "AI-governed delivery" assessment that a client can ask its suppliers for | Needs a recognised standard and independent assessors |
| Open core | MIT core; commercial enterprise parts (single sign-on, a web interface with actions, several servers, support) | Requires a clear line between the core and the commercial parts |

This is Harry's decision, ideally before the repository is public.

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
