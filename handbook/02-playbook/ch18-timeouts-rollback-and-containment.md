# Chapter 18. Timeouts, rollback and containment

> Readers: **developers, Person A, Person B**, operators · Reading time: about 15 minutes
> Status: **Draft 0.2**, awaiting Harry's comments.

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
