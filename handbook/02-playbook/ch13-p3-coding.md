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

> Written by Claude Code together with the platform code. This version covers gate G4 (task C06, session 1). Starting a run, reading G5 decisions, handling G5 escalations, adding budget, stopping a run and reading the run record come with the next tasks.

### 13.10.1. Which agent runs

- Each project names **one registered agent** in its configuration: `run.agent_key` (the key of `sdlc admin agent register`). Without it, G4 fails with reason code `agent_not_runnable`.
- The run uses the agent's pinned model, its registered tools and the caps of the configuration (`budget.default_run_usd`, `run.default_max_iterations`, `run.default_max_duration_minutes`).

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
| 7 | The intent budget is not used up | G4 fails: `budget_exceeded` |

- When G4 fails, the platform posts one comment on the intent's issue with the reason code and mentions Person A. **The intent stays at G4.** Fix the cause (for example register a new agent version after an edit of `AGENTS.md`, or update the AI record); the platform checks G4 again on its own.
- The run starts from the **latest commit of the default branch**.

### 13.10.3. Approving G4 (High risk)

- At High risk, G4 waits for Person A. The platform posts the **run proposal**: the agent and the start commit.
- Decide with a comment on the intent's issue: `/approve G4`, `/reject G4 <reason>` or `/request-changes G4 <reason>`. The API accepts the same decisions.
- The approval covers exactly that proposal. A new commit on the default branch, a new agent version or a changed spec or plan makes a **new proposal**: the platform voids the earlier approval and posts the new proposal to approve.
- A rejection at G4 closes the intent.
- At Low and Medium risk nobody approves G4: the platform passes it when every check holds.

### 13.10.4. Recertification warning

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
