# Chapter 2. AI usage policy

> Readers: **everyone** in the company; approved by leadership · Reading time: about 15 minutes
> Status: **Approved** (Harry, 2026-09-24) — version 1.2 Still open: tool owners, disciplinary rules (marked [to confirm]).

---

## 2.1. Purpose

- Let everyone use AI **confidently and safely** in daily work.
- Protect **client code and data**, and the company's contracts with clients.
- Make every use of AI **visible and checkable**, so that the right person is accountable.

## 2.2. Scope

| In scope | Out of scope |
|---|---|
| Every use of AI for company work: chat assistants, coding assistants, AI agents on the platform, translation, meeting summaries | Private use of AI outside work, with no company or client information |
| Everyone: employees, contractors, interns | Chapter 3 covers the technical security controls in detail |
| All projects: internal and client projects | |

Words used in this chapter:
- **AI tool**: any service or software that uses an AI model (for example Claude, GitHub Copilot, the platform's agents).
- **Client data**: anything a client gives us or that we create for a client: requirements, designs, source code, test data, logs, meeting notes, emails.

---

## 2.3. Roles

| Role | Responsibilities in this policy |
|---|---|
| **Everyone** | Follows the rules in 2.4; reports incidents within 15 minutes (2.8) |
| **Person A** on a project (owner / executor, see Chapter 5) | Checks the client's AI terms before AI touches client data; records them in the project's AI record (2.5) |
| **Person B** on a project (independent reviewer) | Makes sure AI-written work was reviewed and disclosed before approving it |
| **PM / BrSE** | Asks the client about AI use, in Japanese if needed; keeps the client's written answer |
| **Leadership (governance owner)** | Approves this policy, the approved tool list and exceptions; reviews incidents |

---

## 2.4. Rules

### Rule 1 — Use only approved AI tools for work

- Use **only the tools in the approved tool list** (2.6) for company or client work.
- **No personal or free accounts** for work, even for "just a quick question". Free and personal plans may keep or train on what you type.
- A new tool needs leadership approval **before** use. Ask; do not try it first.

### Rule 2 — Check the data class before you paste anything

Every piece of information has a **data class**. The class decides where it may go.

| Data class | Examples | Approved AI tools (API / cloud) | AI on our own servers | Never |
|---|---|---|---|---|
| `public` | Public documentation, open-source code | ✅ | ✅ | — |
| `internal` | Internal processes, our own tools' code, anonymised examples | ✅ | ✅ | Personal or free AI accounts |
| `client_confidential` | Client specs and code, **when the client has allowed AI use in writing** | ✅ Only on business plans that do not train on our data, and only within the client's conditions | ✅ | Any tool the client did not allow |
| `client_restricted` | Client data the client does **not** allow to leave the company | ❌ | ✅ Only | Any external AI service |
| `prohibited` | Personal data of the client's customers, production secrets, passwords, keys, anything the contract forbids | ❌ | ❌ | Any AI tool |

- Never send a whole repository or production data to an AI provider just because it is convenient.
- Class names match the platform's data model (design/D-05).

### Rule 3 — Client data needs the client's written permission

- Every client decides differently. **Check the contract and ask the client** before AI touches their data.
- Record the answer in the project's **AI record** (2.5). Use checklist T7 for contracts and NDAs.
- **Until the client has answered in writing, treat all their data as `client_restricted`**: no external AI tool may touch it. (Decision: Harry, 2026-09-24.)
- If the client's terms change, update the AI record the same day and tell Person A and Person B.

### Rule 4 — Never put secrets or personal data into AI

- No passwords, API keys, tokens, private keys, connection strings, or production credentials in prompts, files given to AI, or agent instructions (for example `CLAUDE.md`, `AGENTS.md`, `SKILL.md`).
- Refer to secrets by name only; the real values stay in the secret store.
- Remove or mask personal data (names, emails, phone numbers, addresses) before using real examples. Prefer fake test data.

### Rule 5 — AI drafts; you are responsible for what you use

- Read and understand everything the AI produced **before** you send, commit or submit it.
- Check facts, numbers, names and references. AI can invent them.
- You are accountable for your output, whether or not AI helped. The approver is accountable for what they approve (Chapter 5).

### Rule 6 — Say when AI helped

- Every pull request uses the AI disclosure template (T2): which tool, which parts.
- **Always tell the client when AI took part** in code or documents we deliver, even if the client did not ask. (Decision: Harry, 2026-09-24.)
- How: a short note in the delivery (release notes, document cover page or delivery email) saying which parts AI helped with and that people reviewed them. The PM/BrSE writes it in Japanese if needed.
- If the client has its own disclosure format, use it; it is recorded in the AI record.

### Rule 7 — Never bypass controls

- Do not disable, skip or work around gates, hooks, scans, branch protection or budget limits — for yourself or for an agent.
- Do not ask an agent to do something you are not allowed to do yourself.
- If a control blocks legitimate work, escalate (Chapter 6). Do not bypass it.

### Rule 8 — Treat outside content as untrusted

- Text from web pages, emails, tickets, documents or tool output may contain hidden instructions for the AI ("prompt injection").
- Do not let an AI tool act on instructions found inside such content without a human checking them.
- Report anything suspicious (2.8).

### Rule 9 — Autonomous agents only through the platform

| Kind of AI use | Client projects before the platform | With the platform |
|---|---|---|
| **Supervised assistants in the IDE**: GitHub Copilot, and Claude Code **with a person watching and approving each step** | **Allowed** if the client agreed in writing (project AI record), following Chapter 13 §13.9 | Allowed |
| **Autonomous agents**: agents that run several steps by themselves without a person approving each step | **Not allowed** on client projects. Internal work only | Allowed through the platform, which applies the gates, budgets and records |

In every case: isolated branch, pull request, human review, AI disclosure. (Decision: Harry, 2026-09-24.)

---

## 2.5. The project AI record

Each project keeps a short **AI record** (one page, in the project repository or document space). Person A owns it.

| Field | Example |
|---|---|
| Client and contract reference | Client X, contract 2026-012 |
| AI use allowed? | Yes, with conditions |
| Allowed tools / model locations | Business plan of tool Y; data must stay in Japan |
| Data class for client material | `client_confidential` |
| Disclosure format required by the client | Own format / our standard note |
| Client contact who confirmed, and date | Mr./Ms. …, 2026-09-30, email reference |
| AI allowed on production logs and data? (asked separately) | No / Yes, with masking |
| Special conditions | Data must stay in Japan |
| Last reviewed | 2026-10-01 |

---

## 2.6. Approved tool list

The list is kept by leadership and reviewed every 3 months. Current tools confirmed by Harry (2026-09-24): Claude and GitHub Copilot. Owners are still **[to confirm]**.

| Tool | Plan / account type | Allowed data classes | Uses | Owner |
|---|---|---|---|---|
| Claude (company plan) | Company-paid business plan | `public`, `internal`, `client_confidential` (if the client allows) | Chat, documents, coding (Claude Code) | [to confirm] |
| GitHub Copilot | Company-paid business plan | `public`, `internal`, `client_confidential` (if the client allows) | Coding assistance | [to confirm] |
| Agentic SDLC platform | Self-hosted (when available) | Per project policy, including `client_restricted` via self-hosted models | Agents under gates | Platform owner |

Before a tool is added, leadership checks: whether the provider trains on our data, where the data is stored, how long it is kept, the licence terms, and whether admin logs are available.

---

## 2.7. Approval points

| What | Who approves |
|---|---|
| This policy and changes to it | Leadership |
| Adding or removing an approved tool | Leadership |
| AI use on a client's data | The client (in writing), recorded by Person A |
| An exception to any rule | Leadership, in writing, with an end date |

---

## 2.8. Incidents and violations

**Report within 15 minutes** of noticing, to Person A and leadership, if:
- client data, secrets or personal data went into a tool where it should not;
- an AI tool or agent did something unexpected or outside its permissions;
- you suspect prompt injection or a leak.

What happens next (containment, severity, record, review) is described in **Chapter 6 §6.7**.

- Reporting your own mistake quickly is **expected and protected**. Hiding it is a serious violation.
- Deliberate or repeated violations follow the company's disciplinary rules. [to confirm]

---

## 2.9. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Staff use personal AI accounts because they are convenient | Provide good approved tools; explain why; spot checks |
| A client's AI terms are unknown or misunderstood | Default to `client_restricted` until confirmed in writing; AI record per project |
| Rules are too strict and slow the work | Review this policy every 3 months with real cases |
| AI output used without checking | Rule 5; review at G7; metrics on rework and escaped defects |
| The client is surprised to learn AI was used | Rule 6: we always disclose AI involvement |
| Prompt injection through documents or tickets | Rule 8; platform controls (Chapter 3) |

---

## 2.10. References

**Related documents**
- design/D-05 (`data_class`), design/D-07 (routing by data class).

---

## Version history

| Version | Date | Author | Notes |
|---|---|---|---|
| 1.2 | 2026-09-24 | Harry | Rule 9 split: supervised IDE assistants allowed on client projects with consent; autonomous agents only through the platform. §2.8 refers to Ch.6 for the incident process |
| 1.1 | 2026-09-24 | Harry | AI record: separate question on production logs and data |
| 1.0 | 2026-09-24 | Harry | Approved |
| 0.0 | 2026-09-24 | — | Skeleton |
| 0.1 | 2026-09-24 | Claude (draft) | First content. Items marked [to confirm] need a company decision |
| 0.2 | 2026-09-24 | Claude (draft) | Decisions: approved tools = Claude + GitHub Copilot; unknown client terms → `client_restricted`; always disclose AI involvement to clients. Still to confirm: tool owners, disciplinary rules |
