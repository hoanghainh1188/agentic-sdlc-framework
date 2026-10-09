# Chapter 15. P5 — Release (G7, G8)

> Readers: **Person B, Person A, PM / BrSE, developers** · Reading time: about 15 minutes
> Status: **Draft 0.2**, awaiting Harry's comments.
> Section 15.10 (platform usage) is written by Claude Code together with the platform code.

---

## 15.1. Purpose

- Accept a change into the product only after an **independent human review** (G7).
- Release to production only with a **known rollback**, an **approval bound to the exact artifact**, and **disclosure to the client** (G8).
- Learn from each release.

## 15.2. Scope

From a verified pull request (G6 passed) until the change is live, observed for the observation window, and the task is closed.

---

## 15.3. Roles

| Role | In P5 |
|---|---|
| Person B | Reviews and merges (G7); approves the production release (G8) |
| Second approver | Required for the changes listed in 15.5, Step 2 |
| Person A | Prepares the release record, rollback plan and release notes; answers review questions |
| PM / BrSE | Writes the AI disclosure note for the client (in Japanese if needed); coordinates the client's acceptance |
| Release / operations agents | Build the package, draft notes, run the release checklist, watch health after release |

---

## 15.4. Principles

1. **Every merge into a protected branch is HITL** — at every risk tier.
2. **The producer never approves.** Neither the producing agent nor Person A (as producer) approves or merges.
3. **Approvals are bound to the exact version** (commit for G7; artifact digest for G8). A new commit after approval needs a new approval.
4. **No release without a tested way back.**
5. **Always tell the client when AI took part** (Chapter 2, Rule 6).

---

## 15.5. Steps

### Step 1 — Prepare the review

Person B receives a **decision packet**: intent, risk tier, scope, diff, spec and ADR links, verification summary and evidence, unresolved issues, cost, rollback plan, the agent's summary and assumptions.

### Step 2 — Gate G7: review and merge

Person B checks:

| Area | Question |
|---|---|
| Intent and domain | Does it do what the intent and spec say, following the business rules? |
| Architecture | Does it follow the ADR and architecture rules? |
| Scope | Nothing outside the approved plan? |
| Compatibility | Backward compatible, or the break was approved at G3? |
| Security | Findings resolved or formally accepted? |
| Quality | Maintainable; tests adequate; no weakened checks |
| Operations | Rollback possible; monitoring in place |

Depth of review by type of change:

| Change type | Review |
|---|---|
| Documentation, formatting, internal refactoring, test-only | **Light review** by Person B (still HITL) |
| Business logic, APIs, persistence, integrations, authentication, configuration | **Full review** by Person B |
| Data migration, payment, personal data, production infrastructure, breaking change, safety-related function | **Dual approval** at **every risk tier**: Person B **and** a second approver (security owner, architect or leadership) — decision: Harry, 2026-09-24 |

Decisions: approve and merge / request changes (back to P3) / reject (back to G3 or G1).

### Step 3 — Prepare the release (template T14)

The **release record** contains: release ID; artifact digest; source commit; spec version; test and security evidence; approvals; deployment policy; rollback target and command; monitoring dashboard; **AI disclosure note for the client**.

Release in stages that fit the risk:

```text
test environment → staging → (shadow or canary where available) → production
```

For projects where we do not deploy (the client deploys), the release record goes with the delivery package and the client decides on production.

### Step 4 — Gate G8: release

**Pass** when:
- the artifact is exactly the one approved at G7 (same commit, same digest);
- required checks passed;
- the rollback is possible and, for High+ risk, tested;
- monitoring is ready;
- data migrations were validated;
- the client disclosure note is ready;
- Person B approves (plus the business or security owner for Critical risk).

- Oversight: **production = HITL** at every tier. Non-production environments = HOTL within a bounded policy.
- An agent never deploys to production by itself.

### Step 5 — After release: observe and learn

- Watch the change for the **observation window of 2 weeks** (Chapter 8 §8.4). No rollback, incident or serious defect in that time → the change counts as **production-qualified**.
- Compare the outcome with the success metrics in the Intent Record.
- Record what went well and what did not: gate waiting times, rework loops, agent assumptions that were wrong.
- Update agent instructions, tests or policies where needed; propose changes through Chapter 6 §6.8.
- Close the task, or open a follow-up intent.

---

## 15.6. Mandatory artifacts

| Artifact | Template |
|---|---|
| Approved pull request with review decision | T2 |
| Release record (including rollback and client disclosure) | T14 |
| Post-release note (outcome, lessons) | Part of T14 |

---

## 15.7. Inputs and outputs

| Inputs | Outputs |
|---|---|
| Verified pull request; evidence; ADR; risk tier; rollback plan | Merged change (G7); release in production or delivery to the client (G8); release record; lessons learned; closed task |

---

## 15.8. Approval points

| Gate | Low | Medium | High | Critical |
|---|---|---|---|---|
| G7 | HITL, Person B | HITL, Person B | HITL, Person B | HITL, Person B + second approver |

Dual approval also applies at **any** tier for the change types listed in Step 2.
| G8 (production) | HITL, Person B | HITL, Person B | HITL, Person B | HITL, Person B + business/security owner |
| G8 (non-production) | HOTL | HOTL | HOTL | HITL |

---

## 15.9. Tools

| Need | Tool |
|---|---|
| Review and merge | GitHub PR review, branch protection, CODEOWNERS |
| Release record | Markdown (T14) in the repository or the release ticket |
| Staged release | The project's CI/CD; feature flags or canary where the project has them |
| Client disclosure | Release notes, delivery email or document cover page |

---

## 15.10. Using the platform

> Written by Claude Code together with the platform code (task E01, `design/ADR-M41-gate-g7.md`; task E02, `design/ADR-M48-evidence-builder.md`; task E03, `design/ADR-M49-gate-g8.md`).

### 15.10.1. Gate G7: review and merge

When CI passed at G6 (Chapter 14 §14.10.2), the intent waits at **G7**. The platform posts a comment on the intent's issue: **the pull request waits for review**. It mentions Person B (and the second approver when the plan needs two approvals).

**How to approve.** Review the pull request on GitHub and submit a review:

- **Approve**: an approval of G7.
- **Request changes**: a request for changes at G7.
- A review with comments only changes nothing.

`/approve G7` in a comment or `sdlc gate approve G7` is refused: G7 approvals are GitHub reviews, so GitHub and the platform see the same approvals. `/reject G7 <reason>` (comment or CLI) and `/request-changes G7 <reason>` (comment only, see "Requesting changes") are accepted.

**Which reviews count.** The platform reads the reviews itself; it does not rely on the repository's branch protection count.

- Only a review of the **latest commit the platform pushed** counts. A review of an older commit never counts. A new run (after a request for changes) pushes a new commit, and earlier approvals no longer count (Principle 3).
- The reviewer must be linked to a platform user by their GitHub account (Chapter 19) and hold the gate's role: Person B; for dual approval also the second approver (two different people).
- **Never counted:** the producers of the change (below) and bots.
- A dismissed review, or a later review of the same person, replaces the earlier decision.
- A review by a linked user that cannot count (no role, a producer) gets one reply on the pull request with the reason. Bots and accounts not linked to a platform user get no reply.

<a id="producers"></a>**Producers.** The producer of a change never approves it (FR-11). This is the one list of producers for the platform; other documents link here.

| Gate | Producers: they never approve or merge, and never request changes |
|---|---|
| G7 | The person who created the intent; the person who allowed each of its runs (`triggered_by`: the person who approved G4, which is HITL at High risk; at Low and Medium risk G4 is a policy check and no person allowed the run); the people who submitted its plan files; every platform user who authored a commit of the pull request (mapped by numeric GitHub account ID). The agent and bots never approve anything |
| G8 | The same people **without** the commit authors: the creator, the people who allowed its runs and the plan submitters (D-03 §6, G8 "Who") |

- The creator is a producer only at G7 and G8: they still approve G1, their own request (Person A).
- At G1–G6 the gate's role decides who may approve; Chapter 19 §19.8b.

**Two approvals** (dual approval, §15.5 Step 2) are needed when the plan G3 approved is flagged `migration`, `payment`, `personal_data`, `prod_infrastructure`, `breaking_contract` or `safety_function`, and at Critical risk.

**Merging.** When the approvals are complete, the platform posts **ready to merge** and mentions Person B. **A person merges** the pull request on GitHub; the platform never merges. Then G7 passes: the platform posts **merged**, and the intent waits at **G8** (E03).

Rules for the merge:

- Merge only the commit that was approved. Do not push to `agent/INT-…` yourself.
- The person who merges must be linked to a platform user, and must not be a producer of the change (the same list as above).
- Merge only after the approvals are complete.

**When G7 stops.** The intent is **paused** at G7, and an escalation is raised (Chapter 18):

| Cause | Escalation |
|---|---|
| The pull request was closed without a merge | `technical` |
| Someone else pushed to the branch: the pull request shows another commit | `technical` |
| The pull request was merged before its approvals were complete, with another commit, or by a bot, a producer or an account not linked to a user | `security` |

Acknowledge it, then decide:

| Decision | What happens |
|---|---|
| `resume` | The intent goes back to **G7**, and the platform reads the pull request again. Reopen it or restore the branch first. After an early merge, `resume` accepts the merge: a later approval of the merged commit then counts |
| `modify` or `roll_back` | The intent goes back to **G3**, which is HITL from now on. Revert a merged change on the default branch yourself |
| `terminate` | The intent is closed (`cancelled`). Close the pull request if it is open |

**Rejecting.** `/reject G7 <reason>` takes the intent back to **G3**, HITL from now on; the G3 approvals in force no longer count. The pull request stays open, and the next run continues from its last commit.

**Requesting changes.** A request for changes starts a new run. The intent goes back to **G4**, and the platform posts **changes requested**. The new run starts from the pull request's last commit, and the agent gets your feedback.

How to request changes:

- Submit a GitHub review with **Request changes** on the pull request. Write what to change in the review and in its line comments.
- Or write a comment on the pull request or on the intent's issue: `/request-changes G7 [reason_code] <what to change>`. Lines below the command are part of the feedback.
- `sdlc gate request-changes G7` and the API are refused (`g7_feedback_on_git_host`): the agent reads the feedback from the review or the comment, so write it there.

What the platform does with it:

- The request must come from a person who holds the gate's role and is not a producer, linked to a platform user, like an approval. A request from anyone else is ignored and starts nothing.
- The agent reads only **your** review or comment, the one recorded as the request. Other reviews on the pull request are never read.
- The agent gets at most 8,000 characters of feedback; longer feedback is cut. Write the most important points first.
- The agent is told that the feedback is data written by a person: it cannot change the task, the plan, the files the agent may change, its tools or its rules.
- The feedback is never copied into the platform's records: it stays on GitHub.
- The earlier approvals do not count for the new commit. Review it again.
- There is no limit on the number of rounds; each round needs a person's request, and the intent budget caps the cost.

The new run does not start, and the intent is **paused** at G4 with a `technical` escalation (Chapter 18), when the request no longer holds before the run starts: you dismissed your review or replaced it with an approval, your GitHub account was unlinked, or GitHub could not be read. Acknowledge it, then decide:

| Decision | What happens |
|---|---|
| `resume` | If the pull request is open and still shows the commit the platform pushed, the intent goes back to **G7**: review that commit again (approve, or request changes again). If the pull request shows another commit or is closed, the intent goes to **G4** for a new run |
| `modify` or `roll_back` | The intent goes back to **G3**, which is HITL from now on |
| `terminate` | The intent is closed (`cancelled`) |

**Deadline.** If G7 waits for a person longer than `oversight.hitl_gate_deadline`, an escalation is raised (Chapter 18), until the merge.

**Platform operator:** no new GitHub App permission is needed. The feedback is read with Pull requests: read (reviews, pull request comments) or Issues: read (issue comments); the App already has both.

### 15.10.2. The Evidence Pack

> Written by Claude Code together with the platform code (task E02, `design/ADR-M48-evidence-builder.md`). Sealing the pack at G8: §15.10.3 (task E03).

The **Evidence Pack** of an intent lists what the platform recorded for it, in one place (D-02 FR-40, FR-42, FR-43). Use it for the release record (T14) and to show a client how the change was made and checked.

**What it holds:**

- the intent: code, risk tier, data class, autonomy, status, repository, issue and pull request;
- the spec and the plan: each version's path, commit and SHA-256;
- the agent runs: status, agent and version, model, start and pushed commits, and the latest checks (files in scope, push, CI and security findings, reviews, merge);
- the stored evidence files (the run's diff, L1 proposals): kind, SHA-256 and size. The platform reads each file back and checks its hash before it builds the pack;
- every gate decision G1–G8: decision, oversight mode (HITL, HOTL, AUDIT, POLICY), the role and **the name of the person who decided**, the reason code and link, the waiting time;
- the escalations, and the tokens and cost (with wasted cost);
- the **client AI disclosure note** (Chapter 2 Rule 6), in the project's disclosure format (see below).

**What it never holds:** source code (the diff stays in the pull request), the spec or plan text, comment or review text, the intent's title or description, secrets. Codes, hashes, counts and links only. So it can be sent to a client as it is: the only personal data is the approvers' names.

**Two files per version:**

- `pack.md`: the readable pack (Markdown, English);
- `manifest.json`: the same data with IDs, for tools.

**How to build and read it** (Chapter 19 §19.8c):

| Command | What it does |
|---|---|
| `sdlc evidence build INT-2026-0007` | Builds a new version. If nothing changed since the latest version, you get that version and no new one |
| `sdlc evidence list INT-2026-0007` | Lists the versions |
| `sdlc evidence show INT-2026-0007 [--version 2]` | Shows one version (default: the latest) |
| `sdlc evidence export INT-2026-0007 [--version 2] --output INT-2026-0007-evidence.md` | Saves `pack.md` to a new file. `--manifest` saves `manifest.json` instead. Without `--output`, it prints the file |

- **Who:** Person A, Person B, PM / BrSE, governance and admin may build (project setting `access.evidence_build_roles`). The same and the second approver may read and export (`access.evidence_read_roles`). Tenant admins always may. The viewer role never may.
- **Versions:** every build that finds new data makes a new version; old versions never change. At G8 the platform seals one version (§15.10.3); after that, no new version can be built. `sdlc evidence show` also prints the version's **release SHA-256**: what a G8 approval is bound to.
- **The disclosure note:**
  - **Standard note**: the platform writes it from its data: which agent and model wrote code, in how many runs, that people approved the change at G7, and the CI result.
  - **Client's own format**: the pack gives the same facts and says that the client's format applies. **The PM / BrSE writes that note** from the project AI record (its link is in the pack) and adds it to the delivery. The manifest marks `client_text_required: true`.
- **If a stored evidence file was changed or deleted**, the platform refuses to build the pack (`evidence_hash_mismatch` or `evidence_missing`) and records the failure in the audit log. Treat it as a possible security incident: tell Person B and the platform operator (Chapter 18). The same applies when a saved pack file no longer matches its hash.
- `export` checks the file's SHA-256 before it saves it, and never overwrites an existing file. The file is readable by you only (it names the approvers).
- **Retention** (task E05, `design/ADR-M51-evidence-retention.md`): the pack files are deleted with the intent's other evidence files after the retention period: 180 days by default from the end of the intent, never less (project setting `retention.evidence_retention_days`, Chapter 3). Every version goes, sealed or not; the rows and hashes stay recorded, so `sdlc evidence show` still shows them, and `export` answers `evidence_pack_purged`. In the store, no process can delete an evidence file during its first 180 days; only the platform's retention job may, and only after the retention or after a project archive.
- **Keeping evidence longer (hold):** for a dispute, an incident or a client request, a tenant admin or governance puts the intent's evidence on hold: `sdlc admin evidence hold INT-2026-0007 --ref <https link to the reason>` (Chapter 19 §19.8d). Held evidence is never deleted, also after a project archive, until `sdlc admin evidence release INT-2026-0007`. Agree the hold with Person B, and release it when the matter is closed.
- If the platform cannot reach its evidence store, building and exporting answer `evidence_unavailable`; ask the platform operator (runbook T11 §5h).

### 15.10.3. Gate G8: release

> Written by Claude Code together with the platform code (task E03, `design/ADR-M49-gate-g8.md`).

After a person merged the approved pull request (§15.10.1), the intent waits at **G8**. The platform never deploys: in the MVP the release is the merge plus the delivery to the client, and **every G8 is a production release**, so a person always decides (HITL).

**What the platform does first:** it builds the Evidence Pack (§15.10.2) itself. It reads every stored evidence file back and checks its hash. Then it posts **waits for the release approval** on the intent's issue and mentions Person B (and the second approver at Critical risk).

**Person B checks** (Step 4 above, template T14): the release record, the rollback, the pack (`sdlc evidence show` and `sdlc evidence export`), and the client AI disclosure note. Then:

| Decision | How | What happens |
|---|---|---|
| Approve | `/approve G8` on the intent's issue, or `sdlc gate approve G8 INT-…` | Bound to the pack's **release SHA-256**. When the approvals are complete, the platform seals the pack and closes the intent (`done`): the comment **released** |
| Reject | `/reject G8 <reason>`, or `sdlc gate reject G8 INT-… --reason-code …` | The intent is closed as `rejected`; the pack is not sealed |
| Request changes | `/request-changes G8 <reason>` | The intent stays at G8. The change is already merged: **a fix needs a new intent**. Approvals given before the request no longer count |

- **Who:** Person B; at **Critical** risk Person B **and** the second approver (two different people). The producers of the change never decide G8 ([§15.10.1, Producers](#producers): the commit authors are not G8 producers).
- **Approvals are bound to the evidence.** If anything recorded before G8 changes (a new evidence file, an escalation, a CI result, the cost, the project AI record's disclosure format or link), the pack gets a new release SHA-256 and earlier G8 approvals no longer count: approve again. Another person's G8 approval does not cancel yours.
- **The client's own disclosure format:** the G8 comment says so and links the project AI record. **Approving G8 confirms that the client's note is ready**: the PM / BrSE writes it from the AI record before Person B approves.
- **No project AI record:** the pack has no disclosure note and G8 cannot pass. The platform posts **G8 cannot pass**; save the record (`sdlc ai-record set`, Chapter 2), and G8 checks again.
- **A stored evidence file was changed or deleted:** the platform stops G8, pauses the intent and raises a **security** escalation (Chapter 18). Decide with `/decide resume` (after the file is restored or explained: the platform builds the pack again) or `/decide terminate` (the intent is closed without a release).
- **Deadline:** G8 has the gate deadline of every human gate; when it passes, an escalation is raised (Chapter 6).
- **Frozen:** while an escalation freezes the intent, the platform does not release it.
- **What is recorded:** the sealed pack version (audit `evidence.pack_sealed`) and the intent's metrics at close (`intent.closed`: lead time, runs, G7 requests for changes, tokens and cost). The waiting time at G8 appears in `sdlc metrics gates`.
- If the platform cannot reach its evidence store, the intent waits at G8; ask the platform operator (runbook T11 §5i).

---

## 15.11. Metrics

- Waiting time at G7 and G8 (warning: median first review above 2 hours).
- Change failure rate; rollback rate; defect escape rate.
- PQC rate after the observation window.
- Share of releases with a complete release record and client disclosure (target: 100%).

---

## 15.12. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Rubber-stamp reviews under time pressure | Decision packet; review depth by change type; review time measured |
| New commits slip in after approval | Approval bound to the commit / digest; branch protection "dismiss stale approvals" |
| Release without a working rollback | G8 requires it; tested for High+ risk |
| Client unaware that AI took part | Disclosure note required at G8 |
| Person B becomes a bottleneck | Chapter 19; backup reviewer |

---

## 15.13. References

**Related documents**
- Handbook: codes table §4; Chapters 2, 4, 5, 8, 14, 16, 18, 19; templates T2, T14.
- `design/D-02` (G7, G8 requirements), `design/D-05` (evidence packs).

---

## Version history

| Version | Date | Author | Notes |
|---|---|---|---|
| 0.0 | 2026-09-24 | — | Skeleton |
| 0.1 | 2026-09-24 | Claude (draft) | First content; platform usage section reserved for Claude Code |
| 0.2 | 2026-09-24 | Claude (draft) | Dual approval at G7 for migration, payment, personal data, production infrastructure, breaking change, safety function (Harry) |
| 0.3 | 2026-10-03 | Claude (task E01) | §15.10.1: G7 with the platform (reviews, producers, dual approval, merge, escalations); ADR-M41 |
| 0.4 | 2026-10-04 | Claude (task E01, PR 2) | §15.10.1: a request for changes starts a new run with the reviewer's feedback; requests only by a review or a comment (QUESTIONS #190); the decisions when the feedback is gone (#191); ADR-M41 §2.7 |
| 0.5 | 2026-10-04 | Claude (task E02) | §15.10.2: the Evidence Pack (contents, versions, who, the disclosure note, failed hash checks, export); ADR-M48 |
| 0.6 | 2026-10-04 | Claude (task E03) | §15.10.3: gate G8 (the release pack, who decides, approvals bound to the release SHA-256, the client's own disclosure format, no AI record, a failed evidence check, what is recorded); ADR-M49 |
| 0.7 | 2026-10-04 | Claude (task E05, PR 1) | §15.10.2: retention of the pack files and evidence holds (ADR-M51) |
| 0.8 | 2026-10-09 | Claude (docs review PR C) | §15.10.1: "Producers", the one list of producers at G7 and G8 (commit authors at G7 only, as D-03 §6 and the code); other documents link here |
