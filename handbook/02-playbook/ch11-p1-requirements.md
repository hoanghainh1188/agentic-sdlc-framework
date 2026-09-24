# Chapter 11. P1 — Requirements (G1, G2)

> Readers: **PM/BrSE, Person A**, Person B (for G2 on High+ risk) · Reading time: about 20 minutes
> Status: **Approved** (Harry, 2026-09-24) — version 1.0.

---

## 11.1. Purpose

- Turn a vague request into an **intent** that people agree on and a **specification** that can be tested.
- Stop agents from building the wrong thing well.
- Keep the client's meaning intact across Japanese, English and Vietnamese.

## 11.2. Scope

From the first request (client request, change request, issue, incident follow-up) until G2 passes.

---

## 11.3. Intent is not a prompt

| | Prompt | Intent |
|---|---|---|
| Scope | One request or conversation turn | The whole objective of the task or feature |
| Content | Instructions, format, examples | Purpose, outcomes, constraints, trade-offs, authority, stop rules |
| Lifetime | One session | The whole lifecycle of the task |
| When something is missing | The model guesses or asks | The intent gives the principles to decide |
| Controlled by | Words | Specification + policy + permissions + approval gates |
| Owned by | Whoever writes it | Person A (with the client, via PM/BrSE) |

**Intent belongs to people; prompts belong to the workflow.** Several agents may get different prompts (analyst, architect, coder, tester, reviewer), but they must share **one intent** and **one specification**. Otherwise the tester checks something different from what the analyst understood.

### Six questions: is it an intent yet?

1. Does it say **why** the task matters?
2. Does it define success with **observable** criteria?
3. Does it say what must **not** be sacrificed?
4. Does it say what the agent **may and may not** do?
5. Does it say **when to stop and ask** (ambiguity, rising risk)?
6. Does it say which **evidence** is needed before the task is done?

If it only says "do X and return format Y", it is a prompt, not an intent.

---

## 11.4. Roles

| Role | In P1 |
|---|---|
| PM / BrSE | Receives the request; clarifies with the client in Japanese; keeps the Q&A list; confirms client consent for AI (Chapter 2) |
| Person A | Owns the intent and the risk tier; approves G1; approves G2 for Low/Medium risk |
| Person B | Checks that the scope is clear and valid; approves G2 for High and Critical risk |
| Agents | Summarise, translate, find gaps and conflicts, draft the Intent Record and the specification; never approve |
| Client | Confirms meaning and acceptance criteria (through PM/BrSE) |

---

## 11.5. Steps

### Step 1 — Take in the request

- Record the requester, the business owner, the affected systems, and the type (feature, defect, change, incident follow-up).
- Give the task an identity (issue number or intent ID).
- Set the **data class** of the client material (Chapter 2) **before** any AI reads it. Unknown client terms → `client_restricted`.

### Step 2 — Classify the risk

- Score the task on: impact, reversibility, data sensitivity, number of systems affected, architecture change, possibility of data loss, external exposure, uncertain judgement, criticality of the production target.
- Set the **risk tier** (Low / Medium / High / Critical). This decides the autonomy ceiling and the oversight at every later gate (codes table §3–§4).
- Estimate the token budget (Chapter 8 §8.9).

### Step 3 — Clarify with agents' help

Agents may:
- summarise documents and meetings; translate between Japanese, English and Vietnamese;
- list missing information, ambiguities, conflicting requirements and edge cases;
- identify actors, workflows and business rules;
- draft an **assumption register** and **questions for the client** (質問票 / Q&A list).

People must confirm:
- the goal, the scope and what is **not** in scope;
- success criteria;
- legal, contractual and business constraints;
- who has the authority to decide.

**Japanese client tips** :
- Keep the **original Japanese** wording of key requirements next to the English, in the Intent Record and the spec. Translation errors are a common cause of rework.
- Terms with business meaning (for example 受注, 出荷, 締め日) go into a **glossary** in the spec, with the client's definition.
- An agent's translation is a draft. The PM/BrSE checks every requirement-level translation before it is used.

### Step 4 — Write the Intent Record (template T1)

| Field | Content |
|---|---|
| intent_id, version | |
| Problem | What is wrong or missing today |
| Desired outcome | What will be true when we are done |
| Business rationale | Why it matters |
| In scope / out of scope | Explicit lists; non-goals matter as much as goals |
| Stakeholders and decision owner | Who decides what |
| Business rules and invariants | Rules that must always hold |
| Constraints | Technical, legal, contractual, performance |
| Assumptions | With a status: confirmed / to confirm |
| Edge cases | Known unusual situations |
| Success metrics | Observable, measurable |
| Known risks, risk tier, data class | |
| Agent authority | What agents may and may not do; when they must stop and ask |

### Step 5 — Gate G1: intent approved

**Pass** when the Intent Record has: objective, rationale, desired outcome, in-scope and out-of-scope, constraints, invariants, owner, risk tier, data class, escalation rule — and nothing is contradictory or unowned.

**Fail** when: there is no owner; the scope is too broad; the target system is unclear; production access is asked for without authority; client consent for AI is missing.

- Oversight: **HITL at every risk tier.** Person A approves.
- Evidence: intent version, confirmation from the client (email or meeting minutes), the ambiguity log, the risk classification.

### Step 6 — Write the specification

Agents draft; Person A owns. The specification contains:

- functional requirements and user stories;
- **acceptance criteria**, each testable;
- non-functional requirements (performance, security, availability, observability);
- interface contracts (API, events, files) and the data model;
- state transitions and error handling;
- security requirements; rollback criteria;
- test scenarios; a traceability table (requirement → intent);
- glossary (including Japanese terms).

Check the specification for four qualities:

| Quality | Question |
|---|---|
| Complete | Are edge cases and failure modes covered? |
| Consistent | Do any requirements contradict each other? |
| Unambiguous | Could anything be read two ways? |
| Verifiable | Does every requirement have a test or a pass/fail criterion? |

### Step 7 — Gate G2: specification approved

**Pass** when: every requirement is measurable; every acceptance criterion is testable; terms are defined; conflicts are resolved; non-goals are written down; every requirement links to the intent; the owner approved.

- Oversight by risk: Low → HOTL (Person A approves; Person B may sample); Medium → HITL by Person A; High and Critical → HITL by **Person B**.
- The approval is bound to the **spec version and its hash**. If the spec changes after G2, G2 is repeated.
- Evidence: spec version, review record, traceability table, ambiguity status = resolved.

---

## 11.6. Mandatory artifacts

| Artifact | Template | Stored |
|---|---|---|
| Intent Record | T1 | Repository (`docs/intents/`) or the platform registry |
| Specification | — (project format; must contain the items in Step 6) | Repository (`docs/specs/`) |
| Q&A list with the client | Project format | Project document space |
| Ambiguity and assumption log | Part of T1 | With the Intent Record |

---

## 11.7. Inputs and outputs

| Inputs | Outputs |
|---|---|
| Client request, 要件定義書 or RFP, meeting notes, existing system documents, contracts, the project AI record | Approved Intent Record (G1); approved specification with acceptance criteria and test scenarios (G2) |

---

## 11.8. Approval points

| Gate | Low | Medium | High | Critical |
|---|---|---|---|---|
| G1 | HITL, Person A | HITL, Person A | HITL, Person A | HITL, Person A |
| G2 | HOTL, Person A | HITL, Person A | HITL, Person B | HITL, Person B |

---

## 11.9. Tools

| Need | Tool |
|---|---|
| Summaries, translation, gap finding, drafts | Approved AI tools within the data-class rules (Chapter 2) |
| Specs for agents | Markdown in the repository; spec-driven templates if the team uses them |
| Q&A with the client | The client's preferred format (often Excel); keep a copy linked to the intent |

---

## 11.10. Metrics

- Share of intents that pass G1 the first time.
- Number of client questions per intent, and time to answer.
- Rework caused by misunderstood requirements (found at G3, G6 or by the client).
- Acceptance criteria without a test at G6 (should be zero).

---

## 11.11. Risks and mitigations

| Risk | Mitigation |
|---|---|
| The agent "fills in" missing requirements with guesses | Assumption register; agents must list questions, not invent answers |
| Translation changes the meaning | Original Japanese kept; PM/BrSE checks translations; glossary |
| Specs too vague for agents | Four-quality check at G2; G2 fails if criteria are not testable |
| Spec changes silently after approval | Approval bound to the spec hash; change → G2 again |
| Client data given to AI without consent | Data class set in Step 1; Chapter 2 rules |

---

## 11.12. References

**Related documents**
- Handbook: codes table §1, §3, §4; Chapters 2, 4, 5, 8, 10; templates T1, T7.

---

## Version history

| Version | Date | Author | Notes |
|---|---|---|---|
| 1.0 | 2026-09-24 | Harry | Approved |
| 0.0 | 2026-09-24 | — | Skeleton |
| 0.1 | 2026-09-24 | Claude (draft) | First content |
