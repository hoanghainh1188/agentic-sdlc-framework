# Rollout guide: bringing a project team onto the platform

For **whoever leads the rollout** (usually the tech lead, with leadership and the platform operator), and for **everyone on the team** who wants to know where to start. It puts the existing guides in order: what to read, who does what, in which order, and how to check each step. It does not replace them.

Version 0.1, 2026-10-07. Written by Claude Code from the set-up and the trial plan of the sample repository. The policy side (when a team may start, readiness, pilots) is the handbook's: Chapter 9 (adoption roadmap), templates T5 (project RACI) and T17 (readiness assessment). This guide only links to it.

---

## 1. Where to start, by role

| You are | Read first | Your first action | You can skip |
|---|---|---|---|
| **Leadership** | Handbook Ch.1 (summary), Ch.9 (adoption roadmap) | Choose the pilot project and approve the readiness result (section 3, phase 0) | Everything under `platform/` |
| **Platform operator** | `platform/deploy/README.md` "Fresh deployment"; runbook T11 | Install the platform and create the tenant (phase 2) | The handbook's process chapters |
| **Tenant admin** (often the tech lead) | This guide; handbook Ch.19 §19.8d | Create the project, the people and their roles (phase 2) | — |
| **Person A** (owner of the work) | `platform/USER-GUIDE.md`; handbook Ch.5 (roles) | Write specs with acceptance criteria; run the first Low-risk task (phase 4) | Admin and operator sections |
| **Person B** (independent reviewer) | `platform/USER-GUIDE.md` steps 4, 7, 8; handbook Ch.17 (reviewing AI output) | Link your GitHub account and log in (phase 3) | Admin and operator sections |
| **PM / BrSE** | Handbook Ch.2 §2.5 (project AI record), template T7 | Record the client's consent and the allowed data classes (phase 2) | Operator sections |
| **Second approver** | `platform/USER-GUIDE.md` steps 7–8 | Log in; you are asked only for flagged changes and Critical risk | Most of the rest |
| **Developer of the platform** | `platform/GETTING-STARTED.md`, `CLAUDE.md` | — | This guide |

The dashboard (`http://<platform>/dashboard/`, read only) shows everyone what waits for whom; decisions are made in GitHub comments, GitHub reviews and the `sdlc` command (USER-GUIDE).

## 2. The rules to know before you start

These are enforced by the platform; plan the team around them.

- **Person A and Person B are two different people**, each with their own GitHub account. One person cannot hold both roles on a project (rule M21). A team of one cannot use the platform.
- **The producer of a change never approves it**: whoever created the intent, submitted the plan, allowed the run or authored a commit cannot approve G7 or G8 for it.
- **Nobody gives a role to themselves.** The first tenant admin comes from the operator; after that, admins set up the others.
- **The platform never merges and never deploys.** A person merges the pull request on GitHub, after the platform says "ready to merge".
- **No client data before the client agrees in writing** (project AI record, handbook Ch.2). The first pilot uses no client data (handbook Ch.9 §9.7).
- **Secrets never go through chat**: tokens, keys and OpenBao key shares stay in a password manager and a terminal.

## 2b. Several people create intents, several people review

Roles are given per project, and any number of people can hold each role.

- **Creating work.** Everyone with `person_a` creates intents, links specs and submits plans (project configuration `access.intent_create_roles`, `spec_link_roles`, `plan_submit_roles`; by default `person_a`, and `pm_brse` may also link specs). To let the PM / BrSE create intents too, add `pm_brse` to `intent_create_roles`; `viewer` never can (rule M16).
- **Reviewing.** Everyone with `person_b` can decide G3, G7 and G8. When a gate needs one approval, the first valid one counts: the notice on the issue names every holder of the role, so one reviewer's absence does not block the work. **Give `person_b` to at least two people** on each project.
- **More than one approval.** G7 already needs Person B **and** the second approver for flagged changes (migration, payment, personal data, production infrastructure, breaking change, safety function) and at Critical risk; so does G8 at Critical risk. A project can ask for this at more gates or tiers: each cell of the gate × risk matrix has `approvals`, the approvals from different people. A cell never needs more approvals than the roles it lists (rule M12), and when it needs as many as it lists, each role approves once. So two approvals means two roles, for example Person B and the second approver on every High-risk pull request:

  ```yaml
  oversight:
    matrix:
      G7:
        high: { mode: HITL, roles: [person_b, second_approver], approvals: 2 }
  ```

  Two approvals by two Person B holders, without a second role, are not possible. The same person never counts twice, and a producer never counts. Set GitHub's branch protection to the same number of approvals.
- **On GitHub,** anyone with access may comment on and review a pull request. G7 counts only the reviews of people who are linked, hold the gate's role, are not producers of the intent, and reviewed the commit the platform pushed. One request for changes from such a person sends the intent back for a new run, even after other approvals.
- **Who may not review what.** By default one person never holds both `person_a` and `person_b` on the same project (`access.conflicting_roles`, rule M21), so the people who create work and the people who review it are two groups. A person can be Person A on one project and Person B on another. Whatever the roles, the producers of an intent (its creator, the plan's submitter, whoever allowed its runs, the authors of its commits) never approve its G7 or G8.

Example: a project team of six.

| Person | Roles | Does |
|---|---|---|
| Tech lead | `person_a`, `admin` | Creates intents, writes plans, manages the project |
| Two senior developers | `person_a` | Each creates intents for their own tasks |
| A senior developer and the QA lead | `person_b` | Decide G3, review and merge (G7), approve releases (G8); one covers for the other |
| BrSE | `pm_brse` | The project AI record, the client disclosure note; may link specs |
| Director | `governance` | Escalations nobody answered |

A team that wants developers to review each other's work on the same project (X creates, Y reviews, then the other way round) needs a change of rule M21: a policy decision, raised in `design/QUESTIONS.md`, not a configuration setting.

## 3. The rollout, phase by phase

Each phase has an owner, a usual duration and a check. Do not start a phase before the check of the previous one passes.

### Phase 0. Decide (leadership, tech lead; about 1 week)

| # | Do | Check |
|---|---|---|
| 0.1 | Choose the project: clear scope, Low or Medium risk work, no client data at first (handbook Ch.9 §9.7) | The project is named in the rollout notes |
| 0.2 | Name the people: Person A, Person B, PM / BrSE, a second approver if flagged changes are likely, governance (leadership) | Template T5 (RACI) filled in |
| 0.3 | Run the readiness assessment with the team (half a day) | Template T17: **Go** or **Conditional Go** (handbook Ch.9 §9.6) |
| 0.4 | Set the budget: per month for the tenant, per intent and per run (defaults: USD 10 per intent, USD 2 per run) | The amounts written down; leadership agrees |
| 0.5 | Choose the model: an API model, or a self-hosted one for `client_restricted` data (D-07) | The model is in the platform's gateway list |

### Phase 1. Prepare the repository (Person A, the repository owner; 1–2 days)

The platform works on a GitHub repository. The sample repository `pilot-order-inventory` is the reference: copy what it does.

| # | Do | Check |
|---|---|---|
| 1.1 | Branch protection on the default branch: no direct push, a pull request, required checks, at least one approval | `main` refuses a direct push |
| 1.2 | CI with **one aggregate required check** that passes only when everything passed (the pilot's `ci-ok`), and security scans (secrets, code, dependencies) | The check appears on every pull request |
| 1.3 | `AGENTS.md` at the repository root: build and test commands, conventions. The agent reads it; the platform pins its hash | The file exists on `main` |
| 1.4 | A folder for specs (for example `docs/specs/`), one Markdown file per change, with acceptance criteria | One example spec merged |
| 1.5 | The pull request template with the AI disclosure (template T2) and `CODEOWNERS` | A test pull request shows the template |
| 1.6 | Install the platform's GitHub App on this repository only (Contents and Pull requests read and write; Issues read and write; Checks, Commit statuses, Code scanning alerts and Metadata read) | The operator sees the installation |

### Phase 2. Set up the platform for the project (operator, tenant admin, PM / BrSE; about 1 day)

| # | Who | Do | Check |
|---|---|---|---|
| 2.1 | Operator | Install the platform, or use the existing one (`platform/deploy/README.md` "Fresh deployment"; on a developer machine `platform/GETTING-STARTED.md` Step 11b) | `curl http://<platform>/health/ready` answers ok |
| 2.2 | Operator | Create the tenant and its first tenant admin (`sdlc ops bootstrap`, run in a terminal; the token is printed once) | The tenant admin logs in: `sdlc whoami` |
| 2.3 | Tenant admin | Create the project (`sdlc admin project create --repo <owner/name>`) | `sdlc admin project show --project <slug>` |
| 2.4 | Tenant admin | Add each person, link their GitHub account by its numeric ID, give the roles of T5 (handbook Ch.19 §19.8d). The admin's own role comes from a second admin or from the operator | `sdlc admin role list --project <slug>`: Person A and Person B are different people |
| 2.5 | PM / BrSE or Person A | Save the project AI record: AI allowed, data classes, production logs, disclosure format, the link to the client's written consent (`sdlc ai-record set`) | `sdlc ai-record show --project <slug>` |
| 2.6 | Operator, tenant admin | Build the sandbox image for the project's toolchain and pin it by digest (`pnpm sandbox-image:build node24`; other toolchains need a new image) | The reference ends in `@sha256:…` |
| 2.7 | Tenant admin, owner, Person B | Register the agent (model, `AGENTS.md`, tools, autonomy at most L2), then the owner and Person B approve it (handbook Ch.20 §20.5b) | `sdlc admin agent show <key>` says `active` |
| 2.8 | Tenant admin | Upload the project configuration: at least `run.agent_key`, `sandbox.image`, `verification.required_checks` (the aggregate check of 1.2); the budgets of 0.4 | `sdlc admin config show --project <slug>` shows the new version |

### Phase 3. Prepare the people (each team member; half a day)

| # | Do | Check |
|---|---|---|
| 3.1 | Read [the platform in five minutes](PLATFORM-IN-5-MINUTES.md) and the [tutorial](TUTORIAL-FIRST-FEATURE.md) (about 20 minutes), then `platform/USER-GUIDE.md` and the handbook chapters of your role (section 1) | — |
| 3.2 | Get a first token from the tenant admin, log in, create your own token and revoke the first one (USER-GUIDE §2) | `sdlc whoami` shows your roles |
| 3.3 | Open the dashboard and sign in with your token | You see the project's (empty) board |
| 3.4 | A 30-minute walk-through together: the eight gates, who decides each, how comment commands work (first line of a new comment), what an escalation is | Everyone can say who approves G3 and G7 on this project |

### Phase 4. Pilot (the whole team; 2–4 weeks)

Run real tasks, one at a time at first. The trial plan of the sample repository (`design/M-E-TRIAL-PLAN.md`) is a worked example.

| # | Do | Check |
|---|---|---|
| 4.1 | First task: **Low risk**, small, clear acceptance criteria. Follow USER-GUIDE §3 from G1 to G8 | The intent ends `done`; its evidence pack is sealed |
| 4.2 | Then Low and Medium tasks one after another; then two at the same time | No platform problem left open between tasks |
| 4.3 | Keep a short manual log per task: minutes of human work per step, whether the result met the spec, problems, notes (M-E plan §7.2) | One row per task |
| 4.4 | Use the stop rules: a `security` escalation, a broken audit chain (`sdlc audit verify`), the budget reached, anything that looks like real client data → stop and tell governance (M-E plan §9) | — |

### Phase 5. Review, then widen (tech lead, leadership; at the end of the pilot)

| # | Do | Check |
|---|---|---|
| 5.1 | Collect the numbers: `sdlc metrics gates --project <slug>` (waiting time per gate), `sdlc cost report --project <slug>` (tokens, cost, wasted cost), the share of pull requests that needed changes (evidence packs) | A short report, like the M-E report (M-E plan §8) |
| 5.2 | Decide what to change: gate deadlines, oversight at a gate, budgets, retries (a configuration change, audited); never the mandatory rules | The new configuration uploaded, or "no change" recorded |
| 5.3 | Decide the next step with leadership: more task types, Medium-risk work, a second project, or client work with written consent (handbook Ch.9 §9.5, gate between steps) | Leadership's decision recorded |

## 4. The first week of a new team (example)

| Day | Morning | Afternoon |
|---|---|---|
| 1 | Phase 0: readiness assessment (T17), roles (T5) | Phase 1: branch protection, the aggregate CI check, `AGENTS.md` |
| 2 | Phase 1: the spec folder, the PR template, the GitHub App | Phase 2: project, people, roles, AI record |
| 3 | Phase 2: sandbox image, agent register and approvals, configuration | Phase 3: everyone logs in; the walk-through |
| 4 | Phase 4: the first Low-risk task, G1 → G4 | The run, G5 → G7 (review and merge) |
| 5 | G8 and the evidence pack; the first manual-log rows | A short retrospective: what was slow, what was unclear |

## 5. Common mistakes when starting

| Mistake | What happens | Avoid it |
|---|---|---|
| One person is both Person A and Person B | The platform refuses the second role | Name two people in phase 0 |
| A GitHub account linked by login, or not at all | That person's `/approve` comments are refused | Link by numeric ID (`gh api users/<login> --jq .id`) |
| No project AI record | Intents wait before G1 (`ai_record_missing`) | Phase 2.5 before the first intent |
| The spec or the plan is not on the default branch | The spec cannot be linked; the plan cannot be submitted | Merge them first: the platform reads `main` |
| The plan file changed after it was submitted | G3 or G4 waits for "plan resubmit needed" | Submit it again with `sdlc plan submit` |
| `verification.required_checks` does not match the repository's CI | G6 waits for a check that never comes, then escalates | Use the aggregate check of phase 1.2 |
| Merging before "ready to merge", or by the producer | A `security` escalation; the intent pauses | Person B merges, after the platform's notice |
| A token pasted into chat or a ticket | Anyone who reads it acts as you | Revoke it (`sdlc token revoke`) and create a new one |
| Nobody answers an escalation | It moves to the backup owner, then to governance; the work stays frozen | Name a backup for each role in T5 |

## 6. Where to read more

| Topic | Where |
|---|---|
| One task from G1 to G8, commands, troubleshooting | `platform/USER-GUIDE.md` |
| Installing the platform | `platform/deploy/README.md` "Fresh deployment"; runbook T11 |
| Setting up a team (admin commands) | Handbook Ch.19 §19.8d |
| When a team may start, readiness, choosing pilots | Handbook Ch.9; templates T17, T5 |
| Roles and separation of duties | Handbook Ch.5; codes table §5 |
| The dashboard | Handbook Ch.19 §19.8e |
| What the web interface may offer later | `design/MVP1-UI-SCOPE.md` |
