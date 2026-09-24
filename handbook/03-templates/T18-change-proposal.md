# T18 Change proposal (process / policy / autonomy)

> Status: **Draft 0.1**, awaiting approval

| Item | Value |
|---|---|
| Use when | Changing a policy, a gate or oversight default, an autonomy level, the tool list, or an agent (model, instructions, tools, permissions) |
| Filled by | Anyone proposes; the owner of the area completes the impact assessment |
| Stored in | `docs/changes/CHG-YYYY-NNNN.md` |
| Related | Leadership review (Ch.6 §6.8); agent changes (Ch.20 §20.9) |
| Rules | [Chapter 6 §6.8](../01-policy/ch06-governance-escalation-and-incidents.md), [Chapter 20](../02-playbook/ch20-agent-and-model-lifecycle.md) |

---

Lowering autonomy or tightening a control can take effect **immediately** (Person B or leadership); record it here afterwards. Raising autonomy or loosening a control always follows all steps.

## Template

```markdown
# CHG-YYYY-NNNN — <short title>

## 1. Proposal
| Field | Value |
|---|---|
| Proposed by / date | |
| Type | policy · gate / oversight default · autonomy level · tool list · agent change (model / instructions / tools / permissions / context) |
| What changes | |
| Why (problem, data, incidents) | |
| Scope (projects, agents, people) | |

## 2. Impact assessment
| Area | Impact |
|---|---|
| Risk and security | |
| Compliance and client contracts | |
| Clients (do we need to tell them?) | |
| Platform (code or config change?) | |
| People (training, workload) | |

## 3. Evidence (required for raising autonomy)
| Item | Value |
|---|---|
| Maturity-stage conditions met? | |
| Relevant metrics (PQC, change failure rate, incidents) | |
| Evaluation results (agent changes) | |

## 4. Decision
| Decision | By | Date | Effective from |
|---|---|---|---|
| approve / reject / trial | | | |

## 5. Rollout and communication
- Handbook sections to update:
- Who to tell / train:
- Trial or staged roll-out:
- Review date:
```

---

## Version history

| Version | Date | Author | Notes |
|---|---|---|---|
| 0.0 | 2026-09-24 | — | Skeleton |
| 0.1 | 2026-09-24 | Claude (draft) | First content |
