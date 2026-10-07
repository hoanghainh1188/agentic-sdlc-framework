# User guide: taking one task through the platform

For **Person A, Person B, the second approver and PM / BrSE** who use the platform for the first time. It walks one task from G1 to G8 and points to the handbook for details. Operators who install the platform read [deploy/README.md](deploy/README.md) instead; developers read [GETTING-STARTED.md](GETTING-STARTED.md). To set up a whole team first (people, roles, repository, agent), see [ROLLOUT-GUIDE.md](ROLLOUT-GUIDE.md).

Version 0.1, 2026-10-06. Written by Claude Code; kept in line with the platform and the handbook usage sections (Ch.13–15, Ch.18–20).

---

## 1. What the platform does for you

You describe a change; an AI agent writes the code in an isolated sandbox; people approve at eight gates; the platform keeps the evidence and the cost.

| Gate | Question | Who decides (default) |
|---|---|---|
| G1 Intent | What problem, what scope, what risk? | Person A |
| G2 Specification | Is the spec complete and clear? | Person A (Person B at High+); at Low risk the platform passes it (HOTL) |
| G3 Plan | Is the plan right? Which files may change? | Person B; at Low risk the platform passes it (HOTL) |
| G4 Execution boundary | May the agent run, with which limits? | The platform (policy); Person A at High risk |
| G5 Scope and budget | Did the run stay in the plan and the budget? | The platform; a person when it did not |
| G6 Verification | Did CI pass? Any security finding? | The platform; Person B when findings or High risk |
| G7 Review and merge | Is the pull request good? | Person B (+ second approver for flagged changes), by a **GitHub review**, then a person **merges** |
| G8 Release | Release it? | Person B (+ second approver at Critical risk) |

Three rules that never change:

- **The producer of a change never approves it.** Whoever creates the intent, submits the plan, allows the run or authored a commit cannot approve G7 or G8 for it.
- **No gate passes by silence.** A gate that waits for you waits until a person with the role decides. HOTL gates pass only when their conditions hold, and you can still block them for a few hours.
- **The platform never merges and never deploys.** People do.

Risk tiers decide how far the agent may go: Low and Medium → it changes code (L2); High → it only writes a proposal (L1); Critical → it never runs (L0). Details: handbook codes table (`handbook/00-introduction/05-codes.md`).

## 2. Before your first task

1. **Account.** A tenant admin creates your platform user, links your GitHub account (by its numeric ID) and gives you your roles on the project. Ask them; you cannot give roles to yourself.
2. **Token and login.** You get a first personal token (`sdlc_pat_…`) from the admin. Keep it in your password manager, never in chat or a ticket.

   ```bash
   sdlc login --api-url https://<platform address>
   sdlc whoami
   sdlc token create --name laptop
   ```

   `sdlc login` asks for the token at a hidden prompt. After `token create`, log in again with your own token and revoke the first one (`sdlc token list`, `sdlc token revoke --id <ID>`). Details: handbook Ch.19 §19.8c.
3. **The project's AI record** must allow the data class of your work (Person A or PM / BrSE writes it once per project: `sdlc ai-record show --project <slug>`). Without it, intents cannot enter G1.

## 3. One task, step by step

The example is task T01 of the sample repo, Low risk. Where Medium or High risk differs, it says so.

### Step 1. Create the intent (Person A)

Open a GitHub issue for the task, then:

```bash
sdlc intent create --project pilot --title "Japanese labels on the product list" \
  --risk low --data-class internal --issue <issue number>
```

You get a code such as `INT-2026-0007`. The platform posts a status comment on the issue: **submitted, waits at G1**. From now on, every status change appears there.

### Step 2. G1 (Person A)

Check the goal, scope and risk, then approve on the issue:

```text
/approve G1
```

(or `sdlc gate approve G1 INT-2026-0007`). Write commands on the **first line of a new comment**; editing a comment never changes a decision.

### Step 3. Link the spec → G2 (Person A, or PM / BrSE)

The spec is a Markdown file **on the default branch** (`main`):

```bash
sdlc spec link INT-2026-0007 --path docs/specs/T01-product-list-japanese-labels.md
```

- **Low risk:** the platform passes G2 by itself (HOTL) and says until when it can be blocked (4 working hours by default).
- **Medium and High:** Person A approves G2 (Person B at High+).
- If the spec on `main` changes later, the intent goes back to G2 by itself.

### Step 4. Write and submit the plan → G3 (Person A writes, Person B approves)

1. Write `.sdlc/plans/INT-2026-0007.yaml` (template T13):

   ```yaml
   plan:
     intent_id: INT-2026-0007
   tasks:
     - id: T1
       summary: Show Japanese labels on the product list screen
       allowed_paths: [apps/web/src/features/products/**]
       tools: [file_editor, terminal]
   ```

   `allowed_paths` are the only files the agent may change. Add `change_flags` (for example `migration`, `personal_data`) when the change is of that kind: they make G3 a human decision and G7 need two approvals.
2. Open a pull request with the file, let Person B review it, and merge it into `main`.
3. Submit it: `sdlc plan submit INT-2026-0007`.

- **Low risk without flags:** the platform passes G3 (HOTL). **Otherwise:** Person B checks the plan and its change flags, then `/approve G3`. The person who submitted the plan never approves G3.
- If the plan file on `main` changes later, G3 or G4 waits until you submit it again.

### Step 5. G4 and the run (the platform; Person A at High risk)

When G3 is passed and every block window is closed, the platform checks the agent, the limits and the budget, and starts the run. You see **run started** on the issue.

- **High risk:** Person A approves the run first: `/approve G4`. The agent then writes only a **proposal** (no push); the intent pauses for Person A to decide what to do with it.
- **Critical risk:** the platform **blocks** the intent; the agent never runs.
- At 80 % of the run's budget a warning comment appears; at 100 % the run stops.
- To stop a run at any time: `/kill` on the issue, or `sdlc run kill INT-2026-0007` (handbook Ch.18 §18.8d).

### Step 6. G5 and G6 (the platform)

- **G5** compares the changed files with the plan and the cost with the budget. Outside the plan → back to G3. Over the budget or a stalled agent → paused with an escalation (section 5).
- The platform then pushes the change to the branch `agent/INT-2026-0007` and **opens the pull request**.
- **G6** waits for CI (`ci-ok` on the sample repo). CI fails → a new run fixes it, up to 2 times; then back to G3. Security findings, or High risk → Person B approves G6.

### Step 7. G7: review and merge (Person B; the second approver when flagged)

The issue shows **the pull request waits for review**.

1. Review the pull request on GitHub and submit **Approve** or **Request changes**. (`/approve G7` is refused: approvals are GitHub reviews.)
   - **Request changes** starts a new run: the agent reads **your** review and its line comments, and pushes a new commit. Approve again after it.
2. When the platform posts **ready to merge**, a person who is not a producer **merges** the pull request on GitHub. Merge only then, and only the commit that was approved.
3. The platform posts **merged**; the intent waits at G8.

Merging too early, or by a producer or a bot, stops the intent with a security escalation.

### Step 8. G8: the release (Person B; + second approver at Critical)

The platform builds the **Evidence Pack** (spec, plan, diff, CI, every gate decision, cost, the client AI disclosure note) and asks for the release approval.

```bash
sdlc evidence show INT-2026-0007     # what your approval is bound to
sdlc evidence export INT-2026-0007 --output INT-2026-0007.md
sdlc gate approve G8 INT-2026-0007   # or /approve G8 on the issue
```

The platform seals the pack, records the metrics and closes the intent: **released**. The client's AI disclosure note is in the pack; for a client that has its own format, your approval confirms that the note is ready.

## 4. Quick reference

### Comment commands (first line of a new comment on the issue or pull request)

| Command | Use |
|---|---|
| `/approve G<n>` | Approve the gate the intent waits at (not G7) |
| `/reject G<n> [reason_code] <reason>` | Reject. Ends the intent at G1–G3 and G8; back to G3 at G7 |
| `/request-changes G<n> [reason_code] <reason>` | Ask for changes; the intent stays at the gate (at G7: a new run) |
| `/ack ESC-…` / `/decide ESC-… <resume\|modify\|roll-back\|terminate\|escalate>` | Escalations (section 5) |
| `/kill` | Stop the intent's agent run |

Reason codes: `spec_unclear`, `tests_insufficient`, `security_finding`, `out_of_scope`, `policy_denied`, `budget_exceeded`, `ci_failed`, `other`… The platform keeps the code and a link to your comment, never your words: write reasons that can stay on GitHub, with no personal or client data.

### CLI commands you will use most

| Command | Use |
|---|---|
| `sdlc intent list` / `sdlc intent show <INT>` | Where is my intent, what waits for whom |
| `sdlc gate approve\|reject\|request-changes <G> <INT>` | Decide a gate (codes only; `--reason-code`) |
| `sdlc spec link` / `sdlc plan submit` | Inputs of G2 and G3 |
| `sdlc escalation list` / `show` / `ack` / `decide` | Escalations |
| `sdlc run list <INT>` / `sdlc run kill <INT>` | Runs, kill switch |
| `sdlc cost report --project <slug>` | Tokens and cost |
| `sdlc metrics gates --project <slug>` | How long gates wait for people |
| `sdlc evidence build\|list\|show\|export <INT>` | The Evidence Pack |

Every command takes `--json`. Exit codes: 0 done, 1 refused, 2 wrong usage, 3 platform unreachable, 4 log in again. Full list: handbook Ch.19 §19.8c.

### The dashboard (read only)

`http://127.0.0.1:8090/dashboard/` on the platform machine shows the board of intents by gate, an intent's decisions and who decides its gate, the open escalations with their deadlines, cost and gate waiting times, and (tenant admins) the audit check. Sign in with your personal API token; it stays in the tab's memory only. The dashboard never decides anything: use comments, reviews and the CLI. Handbook Ch.19 §19.8e.

## 5. When something goes wrong

| You see | What it means | What to do |
|---|---|---|
| **Cannot enter G1** (`ai_record_missing`, `data_class_not_allowed`) | The project's AI record is missing or does not allow the data class | Person A or PM / BrSE fixes the record; the intent enters G1 by itself |
| Your command gets a **reply** instead of a status comment | It was refused (wrong gate, no role, you are a producer, bad syntax) | Read the reason, write a new comment |
| **Plan resubmit needed** | The plan file on `main` is not the one you submitted | `sdlc plan submit <INT>` again (Person B approves G3 again if it was at G4) |
| **Your intent does not move** | The platform holds it | `sdlc intent show <INT>` prints "Held: …" with the reason (and for a failed G4 check, which one); the dashboard shows the same under "What holds it" |
| **Back at G2** (spec changed) | Someone edited the spec on `main` | Approve G2 again (passed by itself at Low risk) |
| **Budget warning** | The run used 80 % of its budget | Nothing yet; at 100 % it stops and escalates |
| **An escalation** (ESC-…) | A run or a gate needs a person: over budget, out of scope, overdue gate, CI timeout, early merge… | The owner named in the notice: `/ack ESC-…`, look at the cause, then `/decide ESC-… <decision>`. Details: handbook Ch.18 §18.8b |
| **The gate is overdue** | Nobody decided within 1 working day | Decide the gate; the escalation closes by itself |
| **CI failed** | The agent's change does not pass `ci-ok` | Nothing: a new run tries again (2 times), then the intent goes back to G3 |
| The intent is **paused** | An escalation is open | Decide the escalation |

The work stays frozen while an escalation waits (except safe actions such as stopping a run). Nobody answering never means "go ahead": the escalation moves to the backup, then to governance.

## 6. Never

- Approve your own work, or merge a pull request whose change you produced.
- Merge before the platform says **ready to merge**, or push to an `agent/INT-…` branch yourself.
- Put a token in a command line, chat, ticket or comment.
- Put personal or client data in comments or reasons: the sample repo is public, and the platform's records are kept for years.
- Edit a comment to change a decision: write a new comment.

## 7. Where to read more

| Topic | Handbook |
|---|---|
| Comment commands, HOTL gates, deadlines, the AI record | Ch.19 §19.8b |
| The `sdlc` command, specs, plans, cost and gate reports | Ch.19 §19.8c |
| Setting up a team (admins) | Ch.19 §19.8d |
| G4, the run, G5 | Ch.13 §13.10 |
| The push, the pull request, G6 | Ch.14 §14.10 |
| G7, the Evidence Pack, G8, retention and holds | Ch.15 §15.10 |
| Escalations, logs, the kill switch, loop detection | Ch.18 §18.8b–§18.8d |
| Registering and approving agents | Ch.20 §20.5b |
| The plan template | `handbook/03-templates/T13-task-plan.md` |
