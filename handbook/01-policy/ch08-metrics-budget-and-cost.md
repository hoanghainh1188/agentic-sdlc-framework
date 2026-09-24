# Chapter 8. Metrics, budget and cost

> Readers: **leadership** (approval), PM/BrSE, Person A and Person B · Reading time: about 20 minutes
> Status: **Approved** (Harry, 2026-09-24) — version 1.0.

---

## 8.1. Purpose

- Know whether AI really helps: **faster, at the same or better quality, at an acceptable cost**.
- Spot problems **before** they become incidents.
- Give leadership numbers to decide on budget, autonomy and rollout.

## 8.2. Scope

All projects using AI agents or AI tools. Platform-specific cost controls are designed in `design/D-07`.

---

## 8.3. Principles

1. **Measure outcomes, not activity.** Lines of code, commits, PRs, tokens and tool calls can all go up while quality goes down. Never use them alone.
2. **One unit of value: the production-qualified change** (8.4).
3. **Measure the starting point first.** Collect 4–6 weeks of baseline before comparing.
4. **Break numbers down** by task type, risk tier, project, agent/model and autonomy level. An average hides the truth: an agent may succeed 90% of the time on documentation and 35% on database migrations.
5. **Read metrics together.** A low override rate is not always good — it may mean nobody is watching. Read it with defect escape, rollback and audit coverage.
6. **Do not reward a single composite score.** Keep the components visible so that teams do not optimise the wrong thing.

---

## 8.4. The north-star: production-qualified changes (PQC)

A change counts as **production-qualified** when:
- the required build and tests pass;
- security and policy gates pass;
- no significant rework was needed;
- it was merged or deployed;
- it caused no rollback, incident or serious defect during the observation window.

```text
PQC rate = changes that pass all gates to production / all changes proposed by agents
```

Follow the whole funnel, not just "PR merged":

```text
task received → classified → plan → code proposed → tests passed → review accepted
→ merged → deployed → production-qualified → no incident after the observation window
```

Observation window: **2 weeks** after release (decision: Harry, 2026-09-24).

---

## 8.5. Minimum metric set

Start with these 12. Each one is broken down as in 8.3 (4).

| # | Metric | How it is measured | Data source (before → with the platform) |
|---|---|---|---|
| 1 | PQC rate | 8.4 | Manual tally from GitHub + defect tracker → platform |
| 2 | First-pass qualification | Changes that pass every gate on the first try / all changes | CI history → platform |
| 3 | Lead time for changes | Median, first commit → production | GitHub + release records |
| 4 | Deployment frequency | Production releases per week | Release records |
| 5 | Change failure rate | Releases causing an incident, rollback or hotfix / all releases | Incident records (T9) |
| 6 | Defect escape rate | Defects found after release / all changes | Defect tracker (client-reported defects counted separately) |
| 7 | Rollback rate | Releases reverted / all releases | Release records |
| 8 | Human intervention minutes per task | Time people spend reviewing, fixing and guiding per task | Self-reported in the weekly report (T8) → platform |
| 9 | Escalation quality | Escalations that were justified and sent to the right person / all escalations | Escalation records (T16) |
| 10 | PQC per dollar | PQC / total delivery cost (8.8) | Cost sheet → platform |
| 11 | PQC per reviewer-hour | PQC / hours spent by reviewers | T8 → platform |
| 12 | Audit and evidence coverage | Gates with machine-readable evidence / all required gates | PR template compliance → platform |

The platform collects most of these automatically. Until then, Person A fills in the weekly pilot report (T8).

---

## 8.6. Governance and safety metrics

These are pass/fail, not trends.

| Metric | Target |
|---|---|
| HITL compliance: every HITL action has a logged approval | **100%** |
| HOTL alerts handled within SLA | **100%** |
| Audit completeness (model, user, gate recorded) | **100%** |
| Critical security findings released | **0** |
| Self-approvals; unauthorised production changes; ability to change the audit log | **0** |
| Quality-gate pass rate | ≥ 90% (Stage A), ≥ 95% (Stage B), ≥ 99% (Stage C) |

---

## 8.7. Early warning

A warning is raised before things break. Thresholds:

| Signal | Warning when | Action |
|---|---|---|
| Change failure rate | Above **15%** over 2 weeks, or rising 3 periods in a row | Governance alert; review gates G6/G7 |
| Lead time | Up **50%** or more within 2 sprints (or 4 weeks) | Look for the bottleneck (often review) |
| Deployment frequency | Down **30%** or more against the 4-week average | Check backlog and pipeline |
| Agent rework rate | Above **20%** of agent changes needing significant rework | Review the agent's instructions (AGENTS.md / SKILL.md) and the specs it receives |
| Human intervention rate | Above **5%** of agent actions | Check task selection and specs |
| Loop frequency | More than **2%** of sessions hit loop detection | Check tools and instructions |
| Tokens per accepted change | Up **25%** or more | Check context size, retries, model routing |
| Review time | Median first review above **2 hours** | Person B overloaded → Chapter 19 |
| Cost variance | P95 / median cost per task type rising | Look for runaway runs |

Response by level:

| Level | Condition | Response |
|---|---|---|
| Watch | One metric breached | Watch for 1 week |
| Warning | Breached for 2+ periods, or several metrics at once | Action plan within **48 hours** |
| Critical | SLA breach or a systemic problem | Emergency response within **24 hours**; consider lowering autonomy (Chapter 4 §4.10) |

---

## 8.8. Cost

### Total delivery cost

Do not judge by cost per token. Count the **whole** delivery cost:

```text
model use + tool calls + sandboxes + CI/CD + security scans
+ human review + rework + incidents and rollbacks
```

| Measure | Meaning |
|---|---|
| **PQC per dollar** | Qualified changes per unit of total cost |
| **PQC per reviewer-hour** | Qualified changes per hour of expert review |
| **Verification tax** | (Assurance + rework cost) / generation cost |
| **Cost variance** | P95 / median cost for the same task type (catches runaway runs) |

Example: the agent writes code 40% cheaper, but review and rework rise 70% → delivery actually costs more.

### Return on investment

```text
Net ROI = value of time saved − (model cost + platform cost + review cost + rework cost + incident cost)
```

Report ROI **per workflow** (bug fixing, test writing, documentation…), not only per team, and only after the baseline exists.

### Reference figures

Velocity multiplier target 1.0 → 1.3 → 1.5+ (Stage A → B → C); cost per story point should fall as velocity rises. Used as reference only (see Chapter 1 §1.6).

---

## 8.9. Budget

### Three levels

| Level | Set by | When exceeded |
|---|---|---|
| Company / client per month | Leadership | Blocked; only self-hosted models remain, if allowed |
| Task (intent) | Person A at G1 | The run stops; Person A asks for more (HITL) |
| Agent run | Platform, from the task budget | Immediate stop, reason recorded |

- Warning at **80%**, stop at **100%** (Chapter 3 §3.6; design/D-07).
- Budgets are **config values**: we start small and adjust from real data.
- [to confirm] Monthly AI budget for the pilot — decided by leadership after 2–4 weeks of trial (Chapter 1).

### Controls that reduce cost without reducing quality


| Control | Idea |
|---|---|
| Clear spec before coding | Rework is the largest waste |
| Deterministic checks first | Format, lint, types, unit tests run **before** any AI reviewer |
| Model routing by difficulty | Small models for simple work; the strongest only for hard work |
| Lean context | Only relevant files and documents, never the whole repository |
| Loop and retry limits | Stop runaway runs early |
| Tool allow-lists | Tools can trigger expensive CI or cloud use |
| Separate queues by priority and cost | Cheap and expensive workflows do not block each other |
| Smarter verification | Run the tests affected by the change first |
| Send only risky diffs to humans | Human review is usually the biggest cost at scale |

---

## 8.10. Baseline, pilot and scale gate

**Baseline** — at least 4–6 weeks **before** rollout: lead time, defect rate, review time, deployment frequency, change failure rate, cost per task, developer satisfaction.

**Pilot rules**:
- Tasks with a clear scope.
- A comparison group, or comparison with history.
- Do not change model, process and team at the same time.
- Track speed **and** quality; note the learning curve.

**Scale gate** — expand only when **all** of these hold:

| Condition |
|---|
| Lead time down |
| PQC rate not down |
| Change failure rate not up |
| Reviewer-hours per PQC not up |
| Cost per PQC trending down |
| Audit coverage at target |
| Developer experience not worse |

---

## 8.11. Reporting

| Report | Frequency | Owner | Audience |
|---|---|---|---|
| Gate queue, alerts, budget use | At each project stand-up | Person A | Project team |
| Weekly pilot report (T8) with the early-warning summary | Weekly | Person A | Person B, PM |
| Leadership dashboard: PQC rate, PQC per dollar, lead time, deployment frequency, change failure rate, defect escape, governance metrics | Monthly (leadership review) | PM / handbook owner | Leadership |
| Developer satisfaction survey (short, anonymous) | Quarterly | Handbook owner | Leadership |


---

## 8.12. Roles and approval points

| What | Who |
|---|---|
| Metric definitions and thresholds | Leadership approves; handbook owner maintains |
| Monthly and per-client AI budgets | Leadership |
| Task budget | Person A at G1 |
| Weekly data | Person A |
| Acting on warnings | Person A and B (Watch/Warning); leadership (Critical) |

---

## 8.13. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Measuring activity instead of value | PQC and the minimum set; no activity metric used alone |
| Gaming the numbers | No single composite score for rewards; governance metrics are pass/fail |
| Too much manual data work before the platform | Only the minimum set; weekly template T8 |
| Numbers too small to mean anything in a small company | Compare against the team's own history; look at trends over months, not single weeks |
| Cost surprises | Three budget levels, automatic stop, cost-variance tracking |

---

## 8.14. References

**Related documents**
- design/D-07 (model gateway, budgets). Handbook Chapters 1, 4, 5, 6, 19; template T8.

---

## Version history

| Version | Date | Author | Notes |
|---|---|---|---|
| 1.0 | 2026-09-24 | Harry | Approved |
| 0.0 | 2026-09-24 | — | Skeleton |
| 0.1 | 2026-09-24 | Claude (draft) | First content |
| 0.2 | 2026-09-24 | Claude (draft) | PQC observation window 2 weeks confirmed; citation clean-up |
