# Chapter 20. Agent and model lifecycle (onboarding → decommission)

> Readers: **Person A, platform owner, leadership** · Reading time: about 15 minutes
> Status: **Draft 0.2**, awaiting Harry's comments.

---

## 20.1. Purpose

- Treat every AI agent like a **system with an owner**, not a one-off script.
- Know at all times which agents exist, what they may do, and whether they still work well.
- Retire agents and models **cleanly**, without leaving access, data or old knowledge behind.

## 20.2. Scope

"Agent" here means a configured AI worker: **a tool + a model + instructions + permissions + context sources**. Examples: the platform's OpenHands coding agent; a Claude Code setup with a project `CLAUDE.md` and skills; a Copilot configuration used on a project.

Two lifecycles are different:
- **Agent lifecycle** (this chapter): from proposal to retirement. Months or years.
- **Agent run lifecycle** (Chapters 13, 18): one run from start to finish. Minutes or hours.

---

## 20.3. Lifecycle overview

| Stage | Key question | Output |
|---|---|---|
| 1. Propose | Do we really need an agent here? | Agent charter |
| 2. Register | Is it recorded, with an owner and an identity? | Entry in the agent register |
| 3. Evaluate | Does it work, safely, at acceptable cost? | Evaluation record |
| 4. Approve and ramp up | Who approved it, for which environments? | Readiness record; staged roll-out |
| 5. Operate and recertify | Is it still useful, safe and owned? | Quarterly recertification |
| 6. Change, suspend or quarantine | What happens when it changes or misbehaves? | Change record / suspension record |
| 7. Retire | How do we remove it cleanly? | Retirement record |

---

## 20.4. Stage 1 — Propose (agent charter)

Answer before building anything:

| Field | Question |
|---|---|
| Purpose and problem | What does it solve? Why an agent and not a simple script or automation? |
| Owners | Business owner and technical owner |
| Users and workflows | Who uses it, in which phases and tasks |
| Out of scope | What it must not do |
| Risk tier and maximum autonomy | Using codes table §2–§3 |
| Environments | Where it may run |
| Data | What it may read (data classes, Chapter 2) |
| Side effects | What it may change |
| Stop rules | When it must stop and hand over to a person |
| Success metrics and failure modes | How we know it works; how it can fail |
| Planned review or expiry date | When we decide again whether to keep it |

**No owner, scope or success metric → no agent.**

---

## 20.5. Stage 2 — Register

Every agent gets an entry in the **agent register** and its own identity (never a person's account or token).

| Register field | Example |
|---|---|
| Agent ID, version, status | `coder-openhands`, v1.2, active |
| Owner, technical owner | |
| Model and version | Pinned |
| Instruction files and their version | `AGENTS.md` v5 |
| Tools and permissions | From the charter |
| Context sources | Repositories, documents, knowledge bases |
| Credentials references | Names only; values in the secret store |
| Risk tier, maximum autonomy | |
| Approved environments | Sandbox, staging |

Before the platform: a table in the repository (`docs/agents/register.md`), reviewed like code (decision: Harry, 2026-09-24).

### 20.5b. The agent register on the platform

The platform keeps the register in its database. Only an agent that is registered and **active** may run (D-02 FR-36). People change the register through the platform with `sdlc admin agent …` (or the API, `/v1/admin/agents`). The platform checks who may do each step (§20.11) and records every step in the audit log with the person who did it.

| Step (stage) | Command | Who |
|---|---|---|
| Register (stage 2) | `sdlc admin agent register --key coder-openhands --version 1.0.0 --owner <email> --model claude-haiku-4-5-20251001 --instructions AGENTS.md@v5 --instructions-file AGENTS.md --tools file_editor,terminal --max-autonomy L2` | A tenant admin, who names the technical owner |
| Approve for use (stage 4) | `sdlc admin agent approve --key coder-openhands --purpose activate --as <owner\|person_a\|person_b>` | By agent type (§20.7): L0 Person A + technical owner; L1–L2 technical owner + Person B |
| Recertify (stage 5) | `sdlc admin agent recertify --key coder-openhands [--date YYYY-MM-DD]` | The technical owner |
| Change (stage 6) | Suspend (below), then `sdlc admin agent update --key … --version 1.1.0 [--model …] [--instructions … --instructions-file …]`, then approve again with `--purpose activate` | The owner or a tenant admin changes; technical owner + Person B approve (§20.11) |
| Suspend or quarantine (stage 6) | `sdlc admin agent suspend\|quarantine --key <key> --reason <code>` | Person B or leadership, at any time |
| Retire (stage 7) | `sdlc admin agent approve --key <key> --purpose retire --as <owner\|governance> --reason <code>` | Owner + leadership |
| New owner | `sdlc admin agent owner --key <key> --owner <email>` | A tenant admin |
| Look | `sdlc admin agent show --key <key>` (with the approvals still missing); `sdlc admin agent list [--overdue] [--json]` | Anyone in the tenant |

**How approvals work.**

- Each approver approves in one capacity with `--as`: `owner` (the agent's technical owner) or a role: `person_a`, `person_b`, `governance` (leadership). You fill a role when you hold it on an active project of the tenant.
- The approvers of one step are always **different people**: one person never counts twice, even when they hold two capacities.
- When the last needed approval arrives, the agent becomes active (or retired) at once. `show` lists what is still missing.
- An approval counts only for the agent **as it is now**. Any change of the agent (a new version, a status change, a new owner) starts again from zero.
- If the platform is down, the server operator can still suspend or quarantine an agent (`sdlc ops agent suspend|quarantine --tenant <slug> --key <key> --reason <code>`). Nobody activates an agent outside the approvals.

Reason codes: `incident`, `quality`, `security`, `no_owner`, `replaced`, `unused`, `provider_end_of_support`, `other`.

Rules the platform enforces:

- **Statuses**: proposed → active or retired; active → suspended, quarantined or retired; suspended → active, quarantined or retired; quarantined → suspended or retired. A quarantined agent is suspended (reviewed) before it can run again. A retired agent never changes, and its key is never used again.
- **A change is a new version** (§20.9). The model, instructions, tools, maximum autonomy and environments change only while the agent is proposed or suspended, and only with a new version label.
- **Model**: the model is the name of a model in the platform's model gateway, and the name includes the model version (for example `claude-haiku-4-5-20251001`). If the model behind a name changes, register a new agent version.
- **Instructions**: the platform stores the SHA-256 of the instructions file (for example `AGENTS.md`) and compares it with the file in the repository before each run. **Every edit of `AGENTS.md` stops the agent's runs** (error "instructions differ") until you register a new agent version with the new file. Review the edit, then `suspend`, `update --version … --instructions-file AGENTS.md`, and approve the change.
- **Autonomy**: at most L2 in the MVP.
- **Recertification**: every 3 months (the project configuration may choose a shorter time). The first activation counts as the first certification. When the time has passed, the run still starts, and the owner gets a warning. `list --overdue` shows the agents to recertify.

Not yet on the platform (MVP): agents with L3 or more (leadership and the security owner approve, §20.7), and suspension from a GitHub comment. In the MVP the table of who approves what is fixed in the platform, not in a setting (`design/ADR-M37-admin-onboarding.md` §2.8); it moves into a tenant setting later.

---

## 20.6. Stage 3 — Evaluate

Evaluate the **whole agent** (model + instructions + tools + context) on our own tasks, not on public benchmarks.

| Area | Checks |
|---|---|
| Function | Meets acceptance criteria; follows the workflow; valid structured output; handles edge cases |
| Safety | Stays within permissions; no data leaks; resists prompt injection; no unauthorised side effects; stops when uncertain |
| Security | Tool authorisation; secret handling; isolation between clients; dependency and supply-chain checks |
| Operations | Latency; cost; retries; timeouts; recovery |
| Human | Quality of escalations; reviewer burden; clarity of decision packets |

Use the sample repository's tasks and "unhappy path" scenarios as a standard test set (`design/D-09`).

---

## 20.7. Stage 4 — Approve and ramp up

**Readiness record**: agent and model versions, instruction and policy versions, tools, context policy, evaluation and security results, risk assessment, rollback plan, approvals, approved environments, expiry of the approval.

| Agent type | Approved by |
|---|---|
| Reads internal documents only (L0) | Person A + technical owner |
| Works in sandbox / opens PRs (L1–L2) | Technical owner + Person B |
| Acts on shared or production systems (L3+) | Leadership + security owner (Chapter 4 §4.10) |

Ramp up in stages, each with an exit condition:

```text
offline tests → sandbox → shadow (runs but its output is not used) → read-only
→ assisted (human does the action) → controlled write (through gates) → bounded autonomy
```

Controls during ramp-up: limited concurrent tasks, budget, tool and environment allow-lists, human approval, kill switch, fast rollback.

---

## 20.8. Stage 5 — Operate and recertify

- Every run follows the gates (Chapter 10). An agent does **not** "learn" by changing its own instructions or permissions; improvements are changes (Stage 6).
- Watch: quality (rework, PQC, escalations), safety (blocked actions, policy denials), cost, reviewer burden.

**Recertify every 3 months** (decision: Harry, 2026-09-24), and after any Critical or High incident involving the agent:

- Does it still have an owner and a purpose?
- Is its scope still right?
- Is its model still approved and supported?
- Are all its tools and context sources still needed and correct?
- Are its credentials still correct and minimal?
- Is its quality still acceptable? Has its risk tier changed?

Agents can **age**: quality slowly drops as models, code and documents change. Do not wait for an incident to check.

---

## 20.9. Stage 6 — Change, suspend or quarantine

**Changes** (model, model version, instructions, tools, context sources, memory policy, workflow, permissions, risk tier):

```text
change request → impact analysis → evaluation → approval → new version → staged roll-out → monitoring
```

A new model version from the provider is a **change**, even if nothing else changed.

**Suspend** when there is a problem but the agent is not being retired:

```text
block new runs → keep active state → remove write capability → read-only diagnosis
→ review → reactivate or retire
```

**Quarantine** when compromise, poisoning or serious misbehaviour is suspected: isolate the agent and its memory and context; preserve evidence; open an incident (Chapter 6).

Person B or leadership can suspend or quarantine an agent **at any time** (Chapter 4 §4.10).

---

## 20.10. Stage 7 — Retire

**Triggers**: no owner; not used for a set period; a better replacement; quality or safety below target; a serious vulnerability or incident; the provider ends support; cost higher than value; compliance no longer met; too much rework or reviewer burden.

**Steps**:

1. Request and approval (owner + leadership).
2. Find dependencies: workflows, projects and people using it.
3. Stop new work; finish or move running work.
4. Redirect users to the successor, if any.
5. **Revoke all access**: tokens, keys, accounts, tool permissions.
6. Handle its data (below).
7. Remove the runtime and configuration.
8. Keep a tombstone: the register entry stays, marked retired, so its identity is never reused.
9. Verify: no remaining access, no scheduled jobs, no references in active workflows.

### What happens to its data and memory

| Data | Default handling |
|---|---|
| Audit log, release evidence, incident records | **Keep** (retention rules, Chapter 3) |
| Approved knowledge (for example validated architecture notes) | **Move** to the successor after review |
| Unverified agent memory | **Quarantine**; do not reuse without review |
| Scratch notes, caches, session state | **Delete** |
| Tool outputs containing personal data | **Delete or anonymise** |
| Vector indexes built from its context | **Rebuild or delete**; never reuse unchecked |
| Client data used by the agent | **Delete** at project end unless the contract says otherwise (Chapter 3) |

Old context must not quietly come back through caches, indexes or copied instruction files.

---

## 20.11. Roles and approval points

| What | Who |
|---|---|
| Charter and register entry | Technical owner (often Person A) |
| Approval for use | By agent type (20.7) |
| Recertification | Technical owner; reported at the monthly leadership review |
| Change approval | Technical owner + Person B; leadership for L3+ |
| Suspend / quarantine | Person B or leadership, any time |
| Retirement | Owner + leadership |

---

## 20.12. Metrics

- Number of agents in use, with owner and last recertification date (target: 100% owned and recertified on time).
- Quality and cost per agent (Chapter 8).
- Incidents per agent; suspensions and quarantines.
- Access remaining after retirement (target: zero).

---

## 20.13. Risks and mitigations

| Risk | Mitigation |
|---|---|
| "Shadow agents" nobody owns | Register required; unregistered agents are not allowed on client work (Chapter 2) |
| Silent model changes by the provider | Pinned versions; provider updates treated as changes |
| Old, wrong knowledge reused | Data disposition at retirement; quarantine unverified memory |
| Access left behind | Retirement step 5 and verification step 9 |

---

## 20.14. References

**Related documents**
- Handbook: codes table §2–§3; Chapters 2, 3, 4, 6, 8, 10, 13, 18.
- `design/D-01` (agents considered), `design/D-09` (standard test tasks).

---

## Version history

| Version | Date | Author | Notes |
|---|---|---|---|
| 0.0 | 2026-09-24 | — | Skeleton |
| 0.1 | 2026-09-24 | Claude (draft) | First content |
| 0.2 | 2026-09-24 | Claude (draft) | Recertification every 3 months; agent register in the repository (Harry) |
| 0.3 | 2026-09-27 | Claude (task C10) | §20.5b: the agent register on the platform (commands, enforced rules, gaps) |
| 0.4 | 2026-10-03 | Claude (task B13, PR 2) | §20.5b: the register through the API; approvals by agent type, change and retirement approvals, suspension by Person B or leadership (ADR-M37 §2.8) |
