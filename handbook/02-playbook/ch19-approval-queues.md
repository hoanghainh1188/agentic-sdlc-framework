# Chapter 19. Approval queues and avoiding review bottlenecks

> Readers: **Person A, Person B, PM/BrSE** · Reading time: about 10 minutes
> Status: **Draft 0.1**, awaiting Harry's comments.

---

## 19.1. Purpose

- Keep human approvals **meaningful** without letting them stop all work.
- When agents produce more, the bottleneck moves to review. This chapter keeps that queue short.

## 19.2. Scope

All HITL gates and escalations (codes table §4; Chapter 6).

---

## 19.3. Principles

1. **Only block what needs blocking.** Low-risk, reversible work does not wait for a person (HOTL or AUDIT).
2. **Waiting must not stop independent work.** While an approval is pending, the agent continues with work that does not depend on it.
3. **An approval is not a blank cheque.** It is bound to the exact version, scope, environment and expiry.
4. **The queue is measured like any other system.**

---

## 19.4. Blocking and deferred approvals

| Type | Used for | What the agent does while waiting |
|---|---|---|
| **Blocking** | Deleting data, production deploys, merging security changes, payments, access changes, hard-to-reverse migrations | Stops **before** the protected action |
| **Deferred** | Low-risk or reversible steps: extra tests, documentation, sandbox improvements, draft pull requests | The step is "parked"; independent work continues |

Example:

```text
                     ┌─ waiting for approval ─→ deploy
agent plan ──────────┤
                     ├─ run independent tests
                     ├─ update documentation
                     └─ prepare the rollback plan
```

Only the protected action is locked. Evidence, tests and the rollback plan are ready when the reviewer answers.

---

## 19.5. Keeping the queue short

| Practice | How |
|---|---|
| **Route to the right person** | Decide the approver **before** the request is created: by change type, repository, risk tier, ownership, availability and conflicts of interest. Finding a reviewer must not become a new bottleneck |
| **One decision packet, not raw logs** | Goal, scope, diff or action summary, risk, test and security results, expected effect, rollback plan, and **what changed since the last review** (Chapter 4 §4.5) |
| **Batch similar low-risk requests** | Group similar items into one decision, to reduce context switching |
| **Deadlines and backups** | Every HITL request has a deadline, a backup reviewer and an escalation path (Chapter 6 §6.5) |
| **Share Person B's load** | A backup Person B per project; rotation for HOTL monitoring (Chapter 5) |
| **Fix the cause of rejections** | Many rejections usually mean unclear specs or plans, not bad reviewers |

**No answer never means yes.** Our rule stays: items on the pre-approved safe list may continue; everything else stays frozen until a person decides (Chapter 6 §6.5).

---

## 19.6. Checking an approval is still valid

Just before the protected action runs, check that it matches what was approved:

| Bound to | Example |
|---|---|
| Version or hash of the proposal | Plan v3, spec hash |
| Exact commit or artifact | Commit `abc123`, image digest |
| Environment | Staging, production |
| Scope | Services, files, data affected |
| Expiry | Valid until a given time |

If anything differs → **cancel and ask again**. Three rules always hold:
1. No valid approval → no protected action.
2. A pending approval does not block independent work.
3. What runs is exactly what was approved, or it needs a new approval.

---

## 19.7. Metrics

| Metric | Meaning | Warning |
|---|---|---|
| Approval waiting time (median, 95th percentile) | How fast reviewers respond | Median first review above 2 hours (Chapter 8 §8.7) |
| Queue depth | Requests waiting | Growing week after week |
| Timeout rate | Requests not handled within SLA | Any, for High and Critical |
| Escalation rate | Requests passed to the next level | Rising |
| Rejection rate | Quality of proposals and specs | Rising |
| Rework rounds before approval | Clarity of what is asked | Rising |

---

## 19.8. Before the platform

- Use GitHub review requests and CODEOWNERS for routing; labels for risk tier.
- Person A writes the decision packet in the PR description (template T2).
- The weekly report (T8) lists items waiting longer than their deadline.

---

## 19.8b. Using the platform: gate commands in comments

> **Platform usage section, owned by Claude Code** (CLAUDE.md "Documentation rules"). Written with task B06, 2026-09-27, updated with task B07 (the gate workflow and status comments), and kept in line with the platform code (`design/ADR-M27-github-poller.md`, `design/ADR-M30-intent-workflow.md`). The rest of this chapter is Draft 0.1 and is written outside Claude Code.

You can decide a gate by writing a comment on the GitHub issue or pull request of the intent. The platform reads new comments about every 30 seconds (project setting `github.poll_interval_seconds`). The CLI (`sdlc gate …`, task B04) does the same through the API.

**Commands.** Write the command on the **first line of a new comment**:

| Command | Records |
|---|---|
| `/approve G3` | An approval of G3. Nothing may follow the gate on that line |
| `/reject G3 <reason>` | A rejection. The reason is required |
| `/request-changes G3 <reason>` | A request for changes. The reason is required |

- Gates G1, G2 and G3 can be decided by comment today; G7 and G8 come later.
- The reason may start with a reason code: `spec_unclear`, `tests_insufficient`, `security_finding`, `out_of_scope`, `policy_denied`, `budget_exceeded`, `ci_failed`, `ai_record_missing`, `data_class_not_allowed`, `expired`, `input_mismatch`, `scope_mismatch`, `other`. A code other than `other` may stand alone: `/reject G2 spec_unclear` is accepted. `other` alone is not a reason: `/reject G2 other` without text is refused. Without a code, the platform records `other`, and you must write a sentence. Example: `/reject G2 spec_unclear AC2 does not say which warehouse`.
- The reason text stays in your comment. The platform stores only the reason code and a link to the comment, because its records are kept for years and can never be edited. Write the reason so that it can stay on GitHub, and do not put personal or client data in it.
- Only new comments count. **Editing a comment never changes a decision.** To change your mind, write a new comment.
- Text on later lines, quoted text (`> /approve G3`) and commands inside code blocks are not read.

**Who may decide.**

- Your GitHub account must be linked to your platform user. The link uses the numeric account ID, so renaming your GitHub login does not break it. Ask the platform admin to link it.
- You need the gate's role on the project, for example Person A for G1 and Person B for G3 (codes table §4). The producer of a change never approves it.
- Bots and automation accounts never decide.
- The intent must be linked to the issue or pull request. One issue (or pull request) has at most one open intent; the platform refuses a second one until the first is closed.
- **You can decide only the gate the intent is waiting at.** The last status comment shows it. A command for another gate gets a reply, and nothing is recorded.

**Answers.**

- **A successful command gets no reply of its own.** The platform posts a **status comment** on the issue when the intent's status changes (FR-22). It confirms your decision: it names who decided and mentions the people who act next.

  | Status comment | When |
  |---|---|
  | Submitted, waits at G1 | The intent was created |
  | G*n* approved, waits at the next gate | The gate had the approvals it needs, bound to the current spec or plan |
  | Rejected at G*n* (reason code) | Someone rejected the gate; the intent is closed |
  | Changes requested at G*n* (reason code) | Someone asked for changes; the intent stays at the gate |

- The status comment comes a little later than your command: the platform moves the intent, then posts on the next poll (about 30 seconds).
- **A request for changes** keeps the intent at the gate. Approvals written before it no longer count. Update the gate's input (a new spec version for G2, a new plan for G3), then approve again; an approval of an older spec or plan no longer counts either.
- **No gate passes by silence.** At G1–G3 the intent waits until a person with the gate's role approves. While an escalation freezes the intent, it does not move on, even with the approvals; it continues once the escalation is decided (Chapter 18 §18.8b).
- A command that the platform cannot read or refuses gets a reply that says why and shows the syntax. Nothing is recorded in that case: fix the command and write a new comment.
- If the platform itself fails while handling your command, it tries again on the next polls. After a few failed attempts it gives up and replies that it could not record the command. Nothing is recorded; write the command again later, and tell the platform operator.

---

## 19.9. Roles and approval points

| What | Who |
|---|---|
| Routing rules per project | Person A proposes; Person B agrees; recorded in the project AI record |
| Backup reviewer | Named by leadership per project |
| Safe list of actions that may continue while waiting | Leadership (Chapter 6 §6.5) |

---

## 19.10. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Reviewers approve quickly to clear the queue | Decision packet; approval time and rejection rate watched; Person B's load shared |
| Stale approvals used for changed work | Binding to version, scope, environment, expiry; re-check before acting |
| Everything classified as "needs approval" | Oversight by risk tier; review the classification monthly |

---

## 19.11. References

**Related documents**
- Handbook: codes table §4; Chapters 4, 5, 6, 8, 17; templates T2, T8.

---

## Version history

| Version | Date | Author | Notes |
|---|---|---|---|
| 0.0 | 2026-09-24 | — | Skeleton |
| 0.1 | 2026-09-24 | Claude (draft) | First content |
