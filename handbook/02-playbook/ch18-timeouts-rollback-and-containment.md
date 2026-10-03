# Chapter 18. Timeouts, rollback and containment

> Readers: **developers, Person A, Person B**, operators · Reading time: about 15 minutes
> Status: **Draft 0.3**, awaiting Harry's comments. §18.8b and §18.8c (platform usage) are owned by Claude Code.

---

## 18.1. Purpose

- Stop runaway agents early.
- When something goes wrong, **take the agent's power away first**, then recover safely.
- Never make things worse by rolling back blindly.

## 18.2. Scope

Agent runs (P3), releases (P5) and production operations (P6). Escalation and "nobody answers" rules are in Chapter 6; this chapter covers what happens to the **system**.

---

## 18.3. Three kinds of limit

| Limit | Applies to | When reached |
|---|---|---|
| **Run limits** | One agent run: iterations, retries, tool calls, delegation depth, parallel agents, cost, time, "no progress" window, repeated identical actions | Stop the run; keep its state; classify as stalled or over budget; Person A decides (G5) |
| **Approval timeouts** | Human gates and escalations | Chapter 6 §6.5: reminder → backup → leadership; the agent stays frozen |
| **Critical timeout** | A situation that must be resolved within a fixed time (for example an incident, a canary breaching thresholds, an unanswered Critical escalation) | The recovery sequence in 18.4 |

Default run limits are set per project (Chapter 8 §8.9, task plan T13). A run that repeats itself **without making progress** is stopped even if it is under budget.

---

## 18.4. Recovery sequence after a critical timeout

```text
1. Freeze the agent and block new actions
2. Revoke its temporary credentials (always, if security may be involved)
3. Preserve evidence
4. Identify the last known good version
5. Check the rollback is safe (pre-checks)
6. Roll back, or contain
7. Verify: artifact, runtime, business
8. Recovered → the agent stays paused until a person reviews
   Failed    → contain and open an incident
```

**The agent loses the power to act first; an independent controller or a person decides on rollback.**

### Preserve evidence before changing anything

Keep: the current and target versions, the agent's actions and tool calls, policy decisions, alerts, configuration, traffic state, credential events. **Never delete logs or overwrite an artifact under investigation.** Rollback restores service; it must not hide the cause.

### Last known good version

Do not roll back to "the previous version" by habit. Choose the last version that:
- passed its required tests;
- ran stably for a minimum time;
- has a verified identity (commit, digest);
- is compatible with the current data schema and dependencies;
- has a tested rollback path;
- was not itself marked faulty.

If no such version exists → **contain** instead of guessing.

### Pre-checks

- The target version exists and matches its digest.
- The environment is the right one.
- No incompatible database migration is in the way.
- The target's dependencies and configuration are still available.
- There is capacity to run it.
- Rolling back will not lose or corrupt valid new data.
- No person has locked the system for an incident.

---

## 18.5. Kinds of rollback

| Kind | Example |
|---|---|
| Code rollback | Redeploy the previous build |
| Configuration rollback | Restore the previous config |
| Traffic rollback | Move traffic back from the canary / new version |
| Schema rollback | Only with a tested backward migration |
| Data restore | From backup — a human decision |
| Compensating action | Undo an external effect with a new action (for example a correcting entry) |
| Forward fix | Fix forward when going back is unsafe |
| Containment | Stop traffic, isolate the workload, keep a safe state |

**Not everything can be rolled back.** One-way migrations and external side effects need a forward fix, reconciliation or compensation, planned **before** release (Chapter 12, ADR rollback strategy).

---

## 18.6. Never roll back automatically when

- no version is confirmed as safe;
- the data schema changed incompatibly;
- data corruption is suspected;
- a compromise or supply-chain attack is suspected;
- rollback could lose valid new data;
- the previous version has also been withdrawn;
- the system has external effects that cannot be undone.

In these cases the automatic actions are only: **pause, revoke, isolate, preserve evidence**. A person (incident commander) decides the recovery.

---

## 18.7. Verifying the recovery

Recovery counts as successful only when all three layers pass, over a **stabilisation window** (a few minutes or a minimum number of requests):

| Layer | Check |
|---|---|
| Artifact | The right version, digest and configuration are running |
| Runtime | Healthy; no crash loop; error rate and latency stable |
| Business | Transactions, data, queues and business rules are correct |

If recovery fails: stay frozen → isolate the faulty workload → remove execution rights → hand over to the incident commander → preserve evidence → manual recovery or forward fix. **Do not keep trying different versions automatically**; each attempt widens the damage and makes investigation harder.

---

## 18.8. Before the platform

Until the platform automates this, each project with a production system keeps a **short recovery runbook** (one page):
- how to stop any running agent and revoke its tokens;
- how to find the last known good version;
- the rollback command(s) and who may run them;
- who is incident commander by severity;
- the client's contact for incidents.

Reviewed at Sprint 0 (Chapter 10 §10.7) and after every incident. Every project with a production system must have one (decision: Harry, 2026-09-24).

---

## 18.8b. Using the platform: escalations, `/ack` and `/decide`

> **Platform usage section, owned by Claude Code** (CLAUDE.md "Documentation rules"). Written with task B11, 2026-09-27, and kept in line with the platform code (`design/ADR-M28-escalations.md`). The rest of this chapter is Draft 0.2 and is written outside Claude Code.

The platform raises an escalation when a run or a gate needs a decision from a person with independent authority (Chapter 6 §6.4). For example, it raises one when a run breaks its budget or its file scope at G5, when a gate is overdue, or when a run is stopped. Each escalation has a code such as `ESC-2026-0001`.

**What happens when an escalation is raised.**

- The platform posts a notice on the intent's GitHub issue. The notice mentions the people who must act, and it states the deadlines in UTC.
- Who receives it first depends on the kind of problem:

  | Route | Owner | Backup |
  |---|---|---|
  | Intent or business scope | Person A | Person B |
  | Code, tests, architecture | Person B | Second approver |
  | Security, data, permissions | Person B | Second approver |
  | Policy or autonomy | Governance | none |

- The producer of the change is never chosen: authority never passes back to them.
- A Critical escalation also tells governance at once. High tells governance, Person A and Person B. Medium tells Person A and Person B. Low tells Person A.
- **The work is frozen** while the escalation is open, if its response level is Pause, Contain or Incident. At Observe and Notify, the work is frozen once the acknowledge deadline is missed.
  - Frozen means that only safe actions continue: read-only work, tests in the sandbox, unpublished drafts, collecting metrics (project setting `escalation.safe_actions`).
  - Stopping a run and revoking its credentials are always possible.
- **An overdue gate** (Chapter 19 §19.8b) raises a Medium escalation at level Notify by default (project setting `oversight.gate_overdue`). The platform closes it itself when the gate is decided.
- **Two clocks run** (Chapter 6 §6.4 SLA): acknowledge, and resolve.
  - If nobody acknowledges, the platform reminds the owner at 75 % of the acknowledge time.
  - Then it moves the escalation to the backup owner, then to governance, with a new acknowledge time at each step.
  - If nobody decides by the resolve deadline, governance takes over. For Critical, the incident process is due (Chapter 6 §6.7).
  - No answer never means "go ahead".

**Commands.** Write the command on the **first line of a new comment** on the intent's issue. You can leave out the escalation code when the intent has only one escalation that is not decided yet.

| Command | Does |
|---|---|
| `/ack ESC-2026-0001` | Acknowledges the escalation: "I have it". The acknowledge clock stops; the resolve clock keeps running. Nothing may follow the code on that line |
| `/decide ESC-2026-0001 resume` | Decides to continue as before. It never raises the budget |
| `/decide ESC-2026-0001 modify` | Decides that the plan or the work must change first |
| `/decide ESC-2026-0001 roll-back` | Decides to roll back |
| `/decide ESC-2026-0001 terminate` | Decides to stop this work |
| `/decide ESC-2026-0001 escalate` | Hands the escalation to governance (not possible for governance itself) |

- After the decision you may add a reason code and a sentence, for example `/decide ESC-2026-0001 resume budget_exceeded The estimate was too low`.
- The sentence stays in your comment. The platform stores only codes and a link to the comment, because escalations are kept for at least 2 years (Chapter 3 §3.9.3).
- The CLI does the same through the API (log in first, Chapter 19 §19.8c):

  | Command | Does |
  |---|---|
  | `sdlc escalation list [--intent INT-…] [--status open\|acknowledged\|resolved\|closed]` | Lists the escalations of the intents you can read |
  | `sdlc escalation show ESC-2026-0001` | Shows one escalation: clocks, owners, decision |
  | `sdlc escalation ack ESC-2026-0001` | Same as `/ack` |
  | `sdlc escalation decide ESC-2026-0001 <resume\|modify\|roll-back\|terminate\|escalate> [--reason-code <code>] [--reason-ref <https://…>]` | Same as `/decide` |
  | `… decide … resume --actions run_start,budget_increase --budget-increase-usd 2.5` | Names the actions the decision allows; a budget increase only this way (comments never raise a budget) |

  The API behind it: `GET /v1/escalations[/<code>]`, `POST /v1/escalations/<code>/ack`, `POST /v1/escalations/<code>/decisions`.

**Who may act.**

- The owner may act at any time.
- The backup owner may act once the escalation has reached the backup step.
- Governance may act at any time.
- A producer of the change never acts, and neither do bots.
- Your GitHub account must be linked to your platform user (by its numeric account ID, as for gate commands, §19.8b).

**What a decision allows** (Chapter 6 §6.6).

- A decision is bound to the version that was reviewed, to the actions it allows, and to an expiry (project setting `oversight.approval_expiry`, 7 days by default).
  - `resume` allows the run to continue or start again, and the next gate.
  - **More budget** is allowed only when the decision names it with an amount, through the API or the CLI (`budget_increase` in `actions`, with `budget_increase_usd`). The amount is recorded in the decision and in the audit log. A comment never raises a budget.
  - `modify` allows moving through the gates again.
  - `roll-back` and `terminate` allow no protected action.
- Just before acting, the platform checks the decision again. If the decision has expired, or the plan or input changed, the decision is voided and the escalation waits for a new decision.
- The platform closes the escalation after it has acted on the decision.

**A G5 breach: resume with more budget** (Chapter 13 §13.10.5). When a run stopped at its cost limit, Person A can let the next run spend more. Names in `actions` replace the defaults, so name **both** actions:

```http
POST /v1/escalations/ESC-2026-0001/decisions
Content-Type: application/json

{
  "decision": "resume",
  "actions": ["run_start", "budget_increase"],
  "budget_increase_usd": "2.5",
  "reason_code": "budget_exceeded"
}
```

- The CLI does the same: `sdlc escalation decide ESC-2026-0001 resume --actions run_start,budget_increase --budget-increase-usd 2.5`.
- The intent budget grows by the amount, and the run budget of the intent's next runs becomes the stopped run's limit plus the amount. Both only go up. The run's real limit is still the smallest of the run budget, what is left of the intent budget and what is left of the tenant's month.
- The intent goes back to G4; the new run starts after G4. A G4 that needs Person A's approval (High risk) shows the new limit in its proposal.
- A decision with `budget_increase` but without `run_start` allows no new run: the intent keeps waiting. Decide again with both actions.

**Answers.** A successful command gets no reply. A command that the platform cannot read or refuses gets a reply that says why. Nothing is recorded in that case.

## 18.8c. Using the platform: logs and traces of a run

> **Platform usage section, owned by Claude Code** (CLAUDE.md "Documentation rules"). Written with task A08, 2026-09-30 (`design/ADR-M35-observability.md`).

Before you change anything after a timeout or a stopped run (§18.4), find what the platform recorded. You need two things: the run's ID (`run_id`, a UUID) and the intent code.

**Logs.** Every platform process (`sdlc-api`, `sdlc-worker`, `sdlc-runner`) writes one JSON line per event. Read them with `docker compose -f platform/deploy/docker-compose.yml --env-file platform/deploy/.env logs <service>`.

- Each line has `time`, `level` and `event` (a code such as `runner.run_ended`).
- Lines about a tenant, an intent or a run also carry `tenant_id`, `intent_id` and `run_id`. Filter on them, for example with `grep '"run_id":"<run_id>"'`.
- A line never holds a token, a key, comment text or client data: only codes, IDs and counts. A field that looks like one of these is dropped, and the line counts it in `dropped_fields`.

**Traces** (optional: Compose profile `observability`, which needs more memory).

- Start the profiles together, for example `platform/deploy/scripts/up.sh core models platform observability`. Then the api, the worker and LiteLLM send traces to Langfuse through the OpenTelemetry Collector. Without the profile, nothing is traced.
- Every model call is one trace in Langfuse, tagged with the seven labels: `tenant:`, `project:`, `intent_id:`, `run_id:`, `gate:`, `agent:`, `data_class:`. In Langfuse, filter the traces by the tag `run_id:<run_id>` to see every model call of a run, with its tokens and cost.
- A log line written inside a traced request or activity also carries `trace_id`: search for it in Langfuse to see the whole request.
- **Langfuse holds the prompts and the model's answers.** They are client data: treat Langfuse like the repository of the client project (Chapter 3). Only people who may see the project's code may have a Langfuse account.

---

## 18.9. Drills and metrics

Drill **once per release cycle** for systems with High or Critical risk (decision: Harry, 2026-09-24). Scenarios:
- timeout before deployment; timeout while moving traffic;
- the controller failing in the middle of a rollback;
- missing target version; invalid signature or digest;
- incompatible database migration;
- a health check that falsely reports success;
- rollback that succeeds technically but breaks a business rule;
- two rollbacks at the same time on the same environment.

Track:
- time from timeout to freeze; time to complete rollback;
- rollback success rate; wrong-version rollbacks; repeated rollbacks;
- share of cases that needed manual recovery; data loss and downtime.

---

## 18.10. Roles and approval points

| What | Who |
|---|---|
| Stopping an agent or a run | Person A, Person B, leadership, or the platform automatically |
| Automatic rollback | Only where pre-approved, tested and allowed by 18.6 |
| Any other rollback, data restore, forward fix | Incident commander (Person B; leadership for Critical) |
| Resuming a frozen agent | Person B, after review (Chapter 6 §6.6) |

---

## 18.11. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Rollback destroys new data | Pre-checks; no automatic rollback in the 18.6 cases |
| Evidence lost during recovery | Preserve evidence first; never overwrite artifacts under investigation |
| Endless automatic retries | Retry limits; stop and hand to a person |
| Nobody knows how to roll back | Recovery runbook per project; drills |

---

## 18.12. References

**Related documents**
- Handbook: Chapters 3, 4, 6, 8, 12, 13, 15, 16; templates T13, T14.
- `design/D-03` (run limits, runner).

---

## Version history

| Version | Date | Author | Notes |
|---|---|---|---|
| 0.0 | 2026-09-24 | — | Skeleton |
| 0.1 | 2026-09-24 | Claude (draft) | First content |
| 0.2 | 2026-09-24 | Claude (draft) | Recovery runbook per project; drills each release cycle for High+ systems (Harry) |
| 0.3 | 2026-09-27 | Claude (task B11) | §18.8b platform usage: escalations, `/ack`, `/decide`, freeze, clocks (ADR-M28) |
| 0.4 | 2026-09-27 | Claude (task B07, session 2) | §18.8b: the escalation of an overdue gate, closed by the platform (ADR-M30 §2.9) |
| 0.5 | 2026-09-30 | Claude (task A08) | §18.8c platform usage: logs and traces of a run (ADR-M35) |
| 0.6 | 2026-10-03 | Claude (task B04) | §18.8b: the `sdlc escalation` commands (ADR-M36) |
| 0.7 | 2026-10-03 | Claude (task C07, PR 2) | §18.8b: resume a G5 breach with more budget (the request body, `run_start` and `budget_increase`; ADR-M34 §2.9) |
