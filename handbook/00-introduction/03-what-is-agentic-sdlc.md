# 0.3 What Agentic SDLC is

> Status: **Draft 0.1**, awaiting approval · Readers: everyone · Reading time: about 5 minutes

---

## From AI assistant to AI agent

| | AI assistant | AI agent |
|---|---|---|
| How it works | Answers one question at a time; a person does the work | Carries out a chain of steps by itself: reads, plans, changes files, runs tests, opens a pull request |
| Example | Asking a chatbot to explain an error | Asking an agent to fix a bug and come back with a tested pull request |
| Main risk | A wrong answer that a person may copy | A wrong **action** — on code, data or systems — that nobody checked |

**Agentic SDLC** (agentic software development life cycle) is a way of developing software where **AI agents take part in every phase** — requirements, design, coding, testing, release and operations — **under rules that keep people in control**.

---

## What changes, and what does not

| Changes | Does not change |
|---|---|
| Agents draft specs, designs, code, tests and documents very quickly | People decide what problem to solve and what "done" means |
| People write less routine code; they specify, review, decide and judge risk more | A named person is accountable for every approval |
| Work produces more output, so review can become the bottleneck | Quality is judged by what works in production, not by how much was produced |
| Every AI action can be recorded and measured | Client data and contracts must be respected |

The core idea in one line: **AI drafts; people decide.** AI is very good at pulling information together and producing drafts. It is not accountable for decisions.

---

## How our framework works

Our **Agentic SDLC Framework** has two parts:

| Part | Role |
|---|---|
| **Handbook** (this document) | The rules: policies, the process, roles, templates |
| **Platform** (our internal software) | Makes the rules happen automatically: gates, budgets, records |

Four ideas carry the whole framework:

1. **Six phases, eight gates.** Work moves through P1–P6. At eight gates (G1–G8) the work stops until it is allowed to continue.
2. **Two questions for every AI action.** *What may the agent do?* (autonomy level L0–L4) and *how do people watch it?* (HITL, HOTL, AUDIT). Both depend on the **risk** of the action.
3. **2+N team.** At least two people in control — Person A owns and does the work, Person B checks and approves independently — plus N agents. Nobody approves their own work.
4. **Evidence and measurement.** Every task leaves a record. We measure changes that reach production with good quality, not lines of code.

![6 phases and 8 gates](../../diagrams/svg/d1-overview-6-phases.svg)

---

## Where to go next

| You are | Read |
|---|---|
| New to the framework | [0.4 Core principles](04-core-principles.md), then [Chapter 2 AI usage policy](../01-policy/ch02-ai-usage-policy.md) |
| Leadership | [Chapter 1 Executive summary](../01-policy/ch01-executive-summary.md) and Part I |
| PM / BrSE, developer, tester | [Chapter 10 The framework](../02-playbook/ch10-framework-and-gates.md), then the chapter for your phase |
| Looking up a word or a code | [0.2 Glossary](02-glossary.md), [0.5 Codes](05-codes.md) |

---

## Version history

| Version | Date | Author | Notes |
|---|---|---|---|
| 0.0 | 2026-09-24 | — | Skeleton |
| 0.1 | 2026-09-24 | Claude (draft) | First content |
