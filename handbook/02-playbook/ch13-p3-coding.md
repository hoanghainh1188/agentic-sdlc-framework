# Chapter 13. P3 — Coding (G4, G5)

> Readers: **developers, Person A** · Reading time: about 15 minutes
> Status: **Draft 0.2**, awaiting Harry's comments.
> Section 13.10 (platform usage) is written by Claude Code together with the platform code.

---

## 13.1. Purpose

- Let agents write code **only inside what G3 approved**: the right files, tools, budget and time.
- Catch scope drift and runaway runs **while** the agent works, not after.

## 13.2. Scope

From an approved plan (G3) until the agent's pull request is ready for verification (P4). Applies to AI agents on the platform and to coding assistants in the IDE (Claude Code, GitHub Copilot).

---

## 13.3. Roles

| Role | In P3 |
|---|---|
| Person A | Starts the runs; operates the agents (agent operator hat); watches budget and alerts (HOTL); decides on G5 escalations |
| Producer agent | Reads the allowed context; edits allowed files on its own branch; writes tests; runs local checks; opens the PR |
| Platform / policy checks | G4 before the run; G5 during and after the run |
| Person B | Not involved in coding; stays independent for G6/G7 |

---

## 13.4. Rules for coding agents

- Read **only** the context the task needs.
- **No production credentials**, ever.
- Never write directly to a protected branch; work on `agent/<task-id>`.
- Every change links to a requirement (acceptance criterion or task in the plan).
- Every generated piece of code has a test, **or** a recorded reason why not.
- Never disable a gate, test, scan, hook or lint rule to make things pass.
- Record new dependencies and generated files (lineage).

Work in small loops:

```text
read the run contract → inspect the repository → propose a local plan
→ implement a small batch → run deterministic checks → inspect the diff
→ update evidence → checkpoint
```

---

## 13.5. Steps

### Step 1 — Gate G4: execution boundary

Before the agent starts, check:

| Check | Pass when |
|---|---|
| Approvals | Intent (G1), spec (G2) and plan (G3) are approved **for these exact versions** |
| Agent | The agent and its version are approved for use (Chapter 20) |
| Autonomy | The level allowed for this risk tier and data class (Chapter 4) |
| Permissions | Only the tools, files and environments in the task plan |
| Environment | Isolated workspace; network limited to what the task needs |
| Budget and time | Token budget, iteration limit, time limit and expiry are set |
| Credentials | Short-lived, for this run only; no real model-provider keys in the sandbox |

- Oversight: automatic policy check for Low and Medium risk; **HITL** for High and Critical risk, and whenever the agent asks for more permissions than the plan.
- High risk runs at **L1**: the result is a proposal, not a pull request (Chapter 4).
- Critical risk: **no agent run** (L0, advice only).

### Step 2 — The agent works

- The agent follows 13.4. Person A watches alerts (HOTL).
- Every tool call is checked against the run's permissions and budget.

### Step 3 — Gate G5: scope and budget

**Pause the agent** and escalate (Chapter 6) when it:
- touches files outside the allowed list;
- wants a tool outside its permissions;
- wants to change an API contract;
- wants to add a sensitive or unreviewed dependency;
- exceeds retries or budget (warning at 80%, stop at 100%);
- finds a conflict with the spec or the design;
- is denied by policy;
- attempts any production action;
- lacks enough context to continue safely.

| Situation | Response |
|---|---|
| Change outside the plan | Stop; back to **G3** (plan must be updated and approved again) |
| Budget at 80% | Warning to Person A (HOTL) |
| Budget at 100% | Stop; Person A decides whether to add budget (HITL) |
| Loop detected (more than 3 identical tool calls) | Stop; Person A reviews the instructions |
| Conflict or missing context | Pause; Person A clarifies intent or spec |

- G5 is checked when the agent finishes a run and at every cost check during the run.

### Step 4 — Hand over to verification

- The agent opens a pull request with template T2 (AI disclosure, task ID, run ID).
- It attaches: the diff, tests, documentation changes, assumptions made, and the list of tool calls.
- High-risk (L1) runs: the output is a **proposal** stored with the task; Person A decides how to take it forward.

---

## 13.6. Mandatory artifacts

| Artifact | Content |
|---|---|
| Branch `agent/<task-id>` | The only place the agent writes |
| Pull request (T2) | Links, AI disclosure, verification checklist |
| Run record | Run contract, tool-call log, policy decisions, budget used, stop reason |
| Assumptions | What the agent assumed that was not in the spec |

---

## 13.7. Inputs and outputs

| Inputs | Outputs |
|---|---|
| Approved intent, spec, ADR and task plan; repository at a known commit; agent instructions (AGENTS.md) | Source changes, tests, documentation; pull request or proposal; run record |

---

## 13.8. Approval points

| Gate | Low | Medium | High | Critical |
|---|---|---|---|---|
| G4 | Policy check | Policy check | HITL (Person A) | No agent run |
| G5 | HOTL | HOTL | HOTL → HITL on breach | — |

---

## 13.9. Using AI coding assistants today (before the platform)

Until the platform is ready (Chapter 2, Rule 9):
- **Supervised assistants only on client projects**: GitHub Copilot, and Claude Code with the developer watching and approving each step. The client must have agreed in writing.
- **No autonomous agent runs on client projects**; autonomous runs are for internal work only.

Apply the same rules manually:

| Platform control | Manual equivalent now |
|---|---|
| G4 approvals | Do not start before the intent, spec and plan are approved (links in the PR) |
| Isolated workspace | A dedicated branch; no production credentials on the machine used |
| Allowed files | The plan lists them; the reviewer checks the diff against the list |
| Budget | Keep sessions short and focused on one task; note time and cost in the weekly report (T8) |
| Run record | Keep the key prompts and the assistant's summary in the PR description |
| Instructions | Keep `CLAUDE.md` / `AGENTS.md` short, accurate and reviewed like code |

---

## 13.10. Using the platform

> Written by Claude Code together with the platform code. This version covers gate G4, the start and end of a run (task C06) and gate G5 (task C07). Stopping a run and reading the run record come with the next tasks.

### 13.10.1. Which agent runs

- Each project names **one registered agent** in its configuration: `run.agent_key` (the key of `sdlc admin agent register`). Without it, G4 fails with reason code `agent_not_runnable`.
- The run uses the agent's pinned model, the agent's registered tools that the approved plan lists (task B09: `tools` of the plan's tasks; none in common → G4 fails with check `plan_tools_not_registered`), and the caps of the configuration (`budget.default_run_usd`, `run.default_max_iterations`, `run.default_max_duration_minutes`).

### 13.10.2. What the platform checks at G4

The platform checks G4 by itself when the intent reaches it, in this order:

| # | Check | When it fails |
|---|---|---|
| 1 | Risk tier and data class allow an agent run (Critical, or autonomy L0: no run) | The intent is **blocked** and closed. The agent never runs |
| 2 | No HOTL block window is still open (Chapter 19 §19.8b) | The platform waits until the window closes |
| 3 | No escalation freezes the intent (Chapter 18) | The platform waits until the escalation is decided |
| 4 | The spec and the plan are the versions G2 and G3 approved | G4 fails: `input_mismatch` |
| 5 | The project AI record allows the intent's data class (Chapter 2 §2.5) | G4 fails: `ai_record_missing` or `data_class_not_allowed` |
| 6 | The agent is registered and active, approved for the sandbox, its model is allowed for the data class, and `AGENTS.md` at the start commit equals the registered version (Chapter 20) | G4 fails: `agent_not_runnable`, `instructions_mismatch` or `autonomy_not_allowed` |
| 6b | The start commit has no other file the agent reads as instructions: `CLAUDE.md`, `GEMINI.md`, `agent.md`, `.cursorrules` at the root, `AGENTS.md` in any folder, or files under `.agents/skills/`, `.openhands/skills/`, `.openhands/microagents/` (names compared without case) | G4 fails: `instructions_unpinned`. Remove the file, or make it part of a new agent version (Chapter 20). A repository too large for the Git host to list in one answer fails the same way for now |
| 7 | The intent budget is not used up | G4 fails: `budget_exceeded` |

- When G4 fails, the platform posts one comment on the intent's issue with the reason code and mentions Person A. **The intent stays at G4.** Fix the cause (for example register a new agent version after an edit of `AGENTS.md`, or update the AI record); the platform checks G4 again on its own.
- The run starts from the **latest commit of the default branch**.

### 13.10.3. Approving G4 (High risk)

- At High risk, G4 waits for Person A. The platform posts the **run proposal**: the agent and the start commit.
- Decide with a comment on the intent's issue: `/approve G4`, `/reject G4 <reason>` or `/request-changes G4 <reason>`. The API accepts the same decisions.
- The approval covers exactly that proposal. A new commit on the default branch, a new agent version or a changed spec or plan makes a **new proposal**: the platform voids the earlier approval and posts the new proposal to approve.
- A rejection at G4 closes the intent.
- At Low and Medium risk nobody approves G4: the platform passes it when every check holds.

### 13.10.4. The run

- When G4 is passed or approved, the platform starts the run by itself and posts a comment: **the run starts**. Nobody needs to do anything.
- Runs wait in a queue when the server already runs as many agents as it allows (usually one). A run that waits so long that its permission expires gets a new permission, a few times. After that, the platform escalates.
- When the run ends, the platform posts a comment and continues:

| The run… | What happens next |
|---|---|
| finished, or stopped at its budget, time or iteration limit | The intent moves to **G5**, where the platform checks the changed files and the budget (§13.10.5). Before that, the platform reads the agent's work out of the sandbox, stores the full diff against the start commit as evidence, and counts the files outside the plan and the agent instruction files. If it cannot, the run counts as failed |
| failed, or the runner was lost | The intent is **paused**, and a technical escalation goes to Person B (Chapter 18). When a person decides `resume`, the intent goes back to G4 and a new run starts after G4 |
| finished at High risk (L1, a proposal only) | The platform stores the proposal and **pauses** the intent. Person A takes the proposal forward (see below) |
| could not start (for example the budget is used up, or the run proposal changed) | The intent is back at **G4**, where the platform decides again |

- **High-risk runs (L1)** never commit or push. When the agent finishes, the platform reads the agent's work out of the sandbox and computes the **proposal** (a patch against the start commit) outside the sandbox. It stores the patch as evidence of the intent and posts a comment: **the proposal is ready**. The comment mentions Person A.
- The proposal is stored where only the platform can read it. Ask the platform operator for the patch of the run. A person then decides how to take it forward, for example as a normal pull request written or reviewed by a person, or as a new intent. The platform does not start another run for this intent by itself.
- The proposal leaves out what the project's ignore rules ignored **at the start commit** (for example `node_modules`, build output, logs). A rule the agent adds hides nothing: the platform uses the start commit's rules and adds every other file.
- **Check changes to `.gitignore` and `.gitattributes` in a proposal first.** They can hide files or change how files are compared, for example when the proposal is applied to a branch later, or in tools that respect them. Do not take such a change forward without a reason you understand.
- The proposal can contain symbolic links, and they can point anywhere. Look at every link before you apply the proposal.
- If the proposal cannot be stored, the run counts as failed: the intent is paused and escalated like any failed run.
- **The budget during a run.** The platform reads what the run has spent, about every 30 seconds. At the warning share of the run's limit (80 % by default, `budget.warn_percent`) it records a warning; at the stop share (100 %, `budget.stop_percent`) it stops the agent, and the run ends as stopped at its budget. The limit is the smallest of the run budget, what is left of the intent budget and what is left of the tenant's month. When the agent ends with an error, the platform reads the spend once more after about 25 seconds (LiteLLM shows the spend about 10 seconds late), so a run that ran out of budget is not reported as a technical failure.

### 13.10.5. Gate G5: scope and budget

When the run ends at G5, the platform checks the run's result by itself, in this order. It uses what it computed outside the sandbox (the diff and the counts of §13.10.4) and the run's spend after the last cost check, never what the agent reports.

| # | Check | When it fails | What happens next |
|---|---|---|---|
| 1 | The run added, changed or removed no file the agent reads as instructions (§13.10.2 check 6b, `AGENTS.md` included) | G5 fails: `instructions_unpinned` | The intent is **paused** at G5. A **security** escalation goes to Person B (Chapter 18) |
| 2 | Every changed file is in the plan G3 approved | G5 fails: `out_of_scope` | The intent goes back to **G3**. No escalation: the G3 approver decides |
| 3 | The run did not reach its cost limit (the runner's stop, or a spend at the stop share found after the run) | G5 fails: `budget_exceeded` | The intent is **paused** at G5. An **intent** escalation goes to Person A |
| 4 | The run did not stop at its iteration limit, its time limit, or because it made no progress | G5 fails: `run_cap_reached` | The intent is **paused** at G5. An **intent** escalation goes to Person A |

- The audit log keeps the exact cause next to the reason code (for example `max_iterations`, `max_duration` or `stalled` for `run_cap_reached`).
- A G5 escalation freezes the intent: its response level is `pause` or higher (configuration `run.g5_breach_escalation`, mandatory rule M22). Its decision is bound to this exact result of this exact run (the run, its contract, its diff, its changed files and the intent's spend). If more spend of the run arrives later, the platform voids the decision, closes the escalation and checks G5 again, which raises a new escalation.
- **When every check holds**, the platform passes G5 (HOTL) and the intent moves to **G6**. Person A is told and can still send the changes back within the block window (Chapter 19 §19.8b): `/request-changes G5 <reason>` starts a new run after G4; `/reject G5 <reason>` closes the intent. A project that makes G5 HITL in its configuration needs a person's `/approve G5`; the person who approved the run at G4 never approves its changes.

**Back to G3 (files outside the plan).** G3 is **HITL at every risk tier** from now on for this intent, and the earlier G3 approval no longer counts. Submit a **new plan**: the plan the run went outside of can never be approved again (`plan_refused`). The run's diff stays as evidence.

**Deciding a G5 escalation** (Chapter 18 §18.8b). Acknowledge it, then decide:

| Decision | What happens |
|---|---|
| `resume` | The intent goes back to **G4**, and a new run starts after G4 **from the latest commit of the default branch**, or, once a run of the intent was pushed (Chapter 14 §14.10.1), from the commit the platform pushed. The stopped run's diff stays as evidence. To give the next runs more budget, decide through the API with a budget increase (Chapter 18 §18.8b); a comment never raises a budget |
| `modify` or `roll_back` | The intent goes back to **G3**, which is HITL from now on. The earlier G3 approval no longer counts; the approver may approve the same plan again, or Person A submits a changed plan |
| `terminate` | The intent is closed (`cancelled`). The run's diff stays as evidence |

### 13.10.6. Recertification warning

- When the agent's last recertification is older than the configured age (3 months, Chapter 20 §20.8), the run is **not** blocked. The platform posts a comment that mentions the agent's owner, and the audit log records the warning with the run.

---

## 13.11. Metrics

- G5 events per task (scope drift, budget, loops), broken down by agent and task type.
- Share of runs stopped by budget or loop detection.
- Agent rework rate (Chapter 8 §8.7; warning above 20%).
- Human intervention minutes per task.

---

## 13.12. Risks and mitigations

| Risk | Mitigation |
|---|---|
| The agent changes more than planned | Allowed files; G5 stops it; back to G3 |
| Runaway cost or endless loops | Budget and loop limits; automatic stop |
| Agent disables checks to make tests pass | Hard rule; checks run independently in P4; reviewers look for it |
| Credentials leak into code or logs | No real credentials in the workspace; secret scanning |
| Instructions files drift or get tampered with | Reviewed like code; integrity check before runs (Chapter 3 §3.7) |

---

## 13.13. References

**Related documents**
- Handbook: codes table §4; Chapters 3, 4, 6, 8, 12, 14, 20; template T2.
- `design/D-03` (run contract, runner, sandbox), `design/D-07` (budgets).

---

## Version history

| Version | Date | Author | Notes |
|---|---|---|---|
| 0.0 | 2026-09-24 | — | Skeleton |
| 0.1 | 2026-09-24 | Claude (draft) | First content; platform usage section reserved for Claude Code |
| 0.2 | 2026-09-24 | Claude (draft) | §13.9 aligned with Ch.2 Rule 9 (supervised assistants only on client projects before the platform) |
| 0.3 | 2026-09-27 | Claude (task C06, session 1) | §13.10 platform usage for G4: the configured agent, the checks, `/approve G4`, the recertification warning |
| 0.4 | 2026-09-27 | Claude (task C06, session 2a) | §13.10.4: the start and end of a run, failed and lost runs, the queue |
| 0.5 | 2026-09-27 | Claude (task C06, session 2b) | §13.10.4: High-risk (L1) runs end with a stored proposal; the intent is paused for Person A; what the proposal leaves out; check `.gitignore`, `.gitattributes` and symbolic links first |
| 0.6 | 2026-10-03 | Claude (task C07, PR 1) | §13.10.2: G4 check 6b (`instructions_unpinned`); §13.10.4: the diff stored at the end of every run, the budget watched during the run |
| 0.7 | 2026-10-03 | Claude (task C07, PR 2) | §13.10.5 (new): gate G5 checks and outcomes, back to G3, deciding a G5 escalation; §13.10.4: the budget warning comment during the run |
| 0.8 | 2026-10-03 | Claude (task C08, PR 1) | §13.10.5: after a push, `resume` starts the new run from the pushed commit (QUESTIONS #134, ADR-M38 §2.6) |
| 0.9 | 2026-10-03 | Claude (task B09, PR 1) | §13.10.1: the run's tools come from the approved plan (ADR-M40 §2.5) |
