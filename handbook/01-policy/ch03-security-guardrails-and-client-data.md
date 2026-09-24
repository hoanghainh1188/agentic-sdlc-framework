# Chapter 3. Security guardrails and client data

> Readers: **leadership** (approval), **everyone** (sections 3.5–3.8) · Reading time: about 20 minutes
> Status: **Approved** (Harry, 2026-09-24) — version 1.1

---

## 3.1. Purpose

- Protect client code and data, and our own systems, when AI agents do real work.
- Make security **built into the system**, not left to each person's memory.
- Give one checklist that every project applies before AI touches it (3.10).

Why agents need more than normal security: an agent can write code, read repositories, call APIs and change infrastructure by itself. It is an **actor**, not just a tool.

## 3.2. Scope

| In scope | Covered elsewhere |
|---|---|
| AI agents (on the platform or in IDE tools), the people who operate them, the infrastructure they run on, client data | What staff may put into AI tools: **Chapter 2** · Autonomy and oversight: **Chapter 4** · Escalation: **Chapter 6** |

---

## 3.3. Principles

1. **Security is enforced by the system, not optional.** Every agent runs inside a defined security perimeter.
2. **Defence in depth.** Several independent layers; one failure must not expose everything (3.5).
3. **Least privilege.** Agents and people get only the access their current task needs, for the shortest time.
4. **All content is untrusted until proven otherwise.** Instructions found inside repositories, documents, issues or tool output never give an agent new permissions.
5. **Permissions are enforced outside the model.** The AI model is never the security boundary; a gateway or policy check is.

---

## 3.4. Threats we design against


| Threat | What it means in practice |
|---|---|
| Prompt injection (direct and indirect) | Hidden instructions in a ticket, web page, document or code comment make the agent do something else |
| Excessive agency | The agent has more tools or permissions than the task needs |
| Credential leakage | Keys or passwords end up in prompts, logs, commits or AI provider logs |
| Data leakage / exfiltration | Client data sent to a place it should not go |
| Context or memory poisoning | False information planted where the agent will read it later |
| Scope drift | The agent changes files or systems outside its plan |
| Policy bypass | The agent (or a person) disables a gate, hook or scan |
| Privilege amplification | An agent gives a sub-agent more rights than it has itself |
| Cross-project access | Knowledge or credentials of one client used in another client's project |
| Malicious dependency | The agent adds a compromised library |
| Unauthorised infrastructure change | The agent modifies servers, cloud or deployment settings |
| Provider outage or model change | The AI service fails or behaves differently |

Questions to ask for every agent: What can it **read**? What can it **write**? Which **tools** can it call? Can it **grant itself** more rights? Can it **change policy**? Can it **deploy** by itself?

---

## 3.5. Five layers of protection


| Layer | Controls | Enforced by |
|---|---|---|
| 1. Identity and access | MFA for everyone; one identity per person and per agent; no shared accounts; short-lived tokens for agents | Company identity provider, GitHub, platform |
| 2. Isolation and network | One isolated workspace per project and per agent run; outbound network limited to an allow-list; no access to other clients' projects | Platform sandbox, network rules |
| 3. Data protection | Data classes (Chapter 2); routing by class; encryption; masking of personal data and secrets | Platform model gateway, scanners, people |
| 4. Agent behaviour | Autonomy level and oversight mode (Chapter 4); token budget; loop detection; prompt-injection checks; branch protection | Platform gates and hooks, GitHub |
| 5. Audit | Every action linked to agent + model + project + responsible person; append-only log | Platform audit log |

Until the platform exists, layers 2–5 are partly **manual**: isolated branches, pull requests, human review and the Chapter 2 rules.

---

## 3.6. Hard rules for AI agents

These rules apply at **every** autonomy level. Only leadership can grant an exception, in writing, for a specific scope and time.

| Rule | How it is enforced |
|---|---|
| **No write access to production.** Agents may only read production data where explicitly allowed, and never client personal data | Read-only credentials; no production credentials in sandboxes |
| **No handling of secrets.** Agents never store, log or print keys or tokens; secrets are referenced by name | Secret store; prompt and output scanning |
| **No infrastructure changes without HITL.** Server, cloud, network, Terraform or Kubernetes changes need a human approval | Approval gate |
| **No pushes to protected branches.** Agents work on their own branch and open a pull request | Branch protection; merge is HITL (G7) |
| **No changes to policies, gates, hooks or their own permissions** | Policy files outside the agent's write scope; agent cannot call admin tools |
| **No approving their own work.** The producer never approves its output | Separation of duties by capability (Chapter 5) |
| **Clean output.** Personal data and secrets removed before any commit | Pre-commit and pre/post-tool scans |
| **Sub-agents get no more than their parent** (scope, tools, budget, time) | Delegation limits on the platform |


### Behavioural limits (defaults)

| Limit | Default |
|---|---|
| Token budget | Warning at 80%, stop at 100% |
| Loop detection | More than 3 repeated identical tool calls → stop |
| Kill switch | Any running agent can be stopped within 5 minutes |

---

## 3.7. Prompt-injection defence

| Layer | What we do | If triggered |
|---|---|---|
| Trust order | Agents follow: system and policy instructions > intent and spec > trusted repo metadata > **untrusted** content (repo files, docs, issues, web pages) | Instructions in untrusted content are treated as data |
| Input checks | Scan inputs for known injection patterns | Block, log, alert |
| Instruction file integrity | Hash check of agent instruction files (`CLAUDE.md`, `AGENTS.md`, `SKILL.md`) before a run | Stop the session if the hash does not match the approved version |
| Output boundary | Validate agent actions and output against the plan and allowed tools | Block and escalate to HITL |
| Knowledge base hygiene | Check new content added to knowledge bases the agent reads | Quarantine and manual review |


---

## 3.8. Rules for people who operate AI


| Rule | Our standard |
|---|---|
| Multi-factor authentication | Mandatory for every account that can reach code, data or AI tools |
| Credentials | Never shared; stored only in the company secret store or password manager |
| Access review | Every **3 months**, and when someone changes project (decision: Harry, 2026-09-24) |
| Inactive accounts | Disabled after 30 days of inactivity |
| Leaving the company or a project | Access removed **the same working day** (decision: Harry, 2026-09-24) |
| Screen and desk | Lock screens; no client documents left visible, for `client_confidential` and above |
| Review accountability | Reviewer identity recorded permanently for every approval |
| Separation of duties | Nobody both approves and deploys the same change |

### Access by role (2+N)

| Role | Code | Client data | Infrastructure | Approvals |
|---|---|---|---|---|
| Person A (owner / executor) | Read-write on assigned projects | Up to the project's data class | Read-only dashboards | G1, G2 |
| Person B (reviewer / approver) | Review only (no direct edits to what they approve) | Up to the project's data class | Read-only | G3, G7, G8 |
| Leadership (governance owner) | Read-only | Audit access | Read-only audit config | Exceptions, policy |
| Agents | Their own branch and sandbox only | Only what the run contract allows | None | None |

---

## 3.9. Client data

### 3.9.1. Handling by data class

| Class | Where AI may process it | Storage | Logs of AI prompts and outputs |
|---|---|---|---|
| `public` | Any approved tool | Normal | Full |
| `internal` | Approved tools (business plans) | Normal, encrypted | Full |
| `client_confidential` | Approved tools **within the client's written conditions**, or our own servers | Encrypted | Masked (no secrets or personal data) |
| `client_restricted` | **Our own servers only** | Encrypted | Masked; kept inside the company |
| `prohibited` | Nowhere | Per contract | Not sent to AI |


### 3.9.2. Japanese clients: contract points

Check these for every client (template T7) and record the answers in the project AI record (Chapter 2):

- Is AI use allowed? For which data, which tools, which countries?
- **Data location**: must data stay in Japan? (Some AI services let you choose the region.)
- May the AI provider keep or train on the data? (Must be **no**.)
- Must we disclose AI use, and in what form? (We always disclose; Chapter 2.)
- Who owns AI-generated output? Any licence restrictions?
- How long must we keep, and when must we delete, client data and logs?
- Incident notification: how fast, to whom?

### 3.9.3. Retention

| What | Keep for | Status |
|---|---|---|
| Evidence Packs (files) | 6 months, longer if the contract requires | Decided (platform design D-05) |
| Audit log (who did what, approvals) | At least **2 years** | Decided (Harry, 2026-09-24) |
| Client data in AI tools and knowledge bases | **Deleted at project end**, unless the contract says otherwise | Decided (Harry, 2026-09-24) |

---

## 3.10. Supply chain

- Pin dependency versions; scan for known vulnerabilities and leaked secrets on every pull request.
- Agents may not add new dependencies without human review at G7.
- Keep a list of AI tools, models and agent versions used on each project (for audit and incident analysis).
- Check the licence of every model, agent and tool before approving it (Chapter 2, approved tool list).


---

## 3.11. Security incidents

Security incidents follow the common incident process in **Chapter 6 §6.7**, with the severity and response times in the codes table §6.3 and Chapter 6 §6.4.

Examples by severity:

| Severity | Security examples |
|---|---|
| Critical | Data breach; successful prompt injection; unauthorised agent action |
| High | Client data sent to a tool or class where it should not be; sensitive output leaked |
| Medium | Unauthorised action attempted but blocked |
| Low | Configuration drift, missing log fields |

Security-specific points in that process:
- **Contain within 5 minutes**: stop the agent with the kill switch; revoke its tokens and keys.
- **Assess** what was accessed or changed and **which clients are affected**.
- **Notify the client** for Critical incidents, and for others when the contract requires it.

---

## 3.12. Project checklist before AI starts

- [ ] Client AI terms checked and recorded (Chapter 2, T7)
- [ ] Data class set for the project's client material
- [ ] Isolated workspace / repository access for this project only
- [ ] MFA enabled for everyone on the project
- [ ] Branch protection on the main branch; merge requires Person B
- [ ] Secret scanning and dependency scanning active
- [ ] Agents have no production write access and no infrastructure rights
- [ ] Token budget and kill switch configured (platform projects)
- [ ] Incident contacts known (including the client's)


---

## 3.13. Roles and approval points

| What | Who |
|---|---|
| This chapter and changes to it | Leadership |
| Exceptions to hard rules (3.6) | Leadership, in writing, with scope and end date |
| Project checklist (3.12) completed | Person A; checked by Person B |
| Incident severity and client notification | Leadership (Critical, High); Person A (Medium, Low) |

---

## 3.14. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Controls exist on paper but are not enforced | Platform enforcement; until then, the checklist and Person B's review |
| Small team, one person holds several roles | Separation of duties by capability; Person B never edits what they approve |
| Too many security steps slow delivery | Strength of checks follows the risk tier (Chapter 4) |
| New attack methods on AI agents | Review this chapter every 3 months and after every Critical or High incident |

---

## 3.15. References

**Related documents**
- Handbook Chapter 2 (AI usage policy), codes table §6.3 (severity).

---

## Version history

| Version | Date | Author | Notes |
|---|---|---|---|
| 1.1 | 2026-09-24 | Harry | §3.11 refers to the common incident process (Ch.6) and SLA tables (codes §6.3, Ch.6 §6.4); keeps security examples and specifics |
| 1.0 | 2026-09-24 | Harry | Approved |
| 0.0 | 2026-09-24 | — | Skeleton |
| 0.1 | 2026-09-24 | Claude (draft) | First content |
| 0.2 | 2026-09-24 | Claude (draft) | Decisions: audit log ≥ 2 years; access review every 3 months; same-day access removal; client data deleted at project end unless the contract says otherwise |
