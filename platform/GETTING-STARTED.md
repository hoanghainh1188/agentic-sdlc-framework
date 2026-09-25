# Getting started: from the zip file to the first task

This guide covers: pushing the repo to GitHub, creating the 44 backlog issues, running tasks with Claude Code, and sending handbook comments.
Done by: the repo owner / tech lead (Harry). Time: about half a day for steps 1–6.

| Current state (2026-09-24) | |
|---|---|
| Design | Version 1.0 approved, tag `design-v1.0` |
| Handbook | Version 1.0, **not yet approved as a whole** |
| Coding | Whole backlog now, starting with A01; rework accepted after the handbook is approved |

---

## Step 0. Prepare before you start

| What | Needed for | Who |
|---|---|---|
| GitHub organisation account with rights to create repositories | Step 1 | Harry |
| GitHub CLI installed and logged in (`gh auth login`) | Step 3 | Harry |
| Claude Code access through the company plan (not a personal account — handbook Ch.2 Rule 1) | Step 4 | Leadership / tool owner |
| Developer machine: Git, Node.js LTS, pnpm; Docker from A02 | A01, A02 | Developer |
| **Three people to hold the OpenBao key shares** | **Before A03** | Leadership |
| Infrastructure operator for the internal server | Before A10 | Leadership |
| Person B for reviewing platform PRs | Every task | Leadership |

Building the platform is **internal work** with no client data, so Claude Code may be used here (handbook Ch.2 Rule 9). The usual rules still apply: own branch, pull request, human review, AI disclosure.

---

## Step 1. Create the repo on GitHub and push

1. Create a **private** repository `agentic-sdlc-framework`. Do not add a README, licence or `.gitignore` (the repo already has them).
   - Current repository: `github.com/harryforge/agentic-sdlc-framework`, organization `harryforge` on the **GitHub Free** plan (Harry, 2026-09-24). Suggested mitigations: two-factor authentication for all members; a second trusted owner; an offline mirror (`git clone --mirror`); move to a company-controlled organization before any client or sales use.
2. Unzip, copy the folder where you want it, and push **one initial commit** (the repository history starts here):

```bash
cd agentic-sdlc-framework
git config --global user.name  "<your name>"      # once per machine; commits fail without it
git config --global user.email "<your email>"
git init
git add .
git commit -m "Initial commit: handbook v1.0 (in review), design v1.0 (approved)"
git branch -M main
git remote add origin git@github.com:harryforge/agentic-sdlc-framework.git
git push -u origin main

# mark the approved design on this first commit
git tag -a design-v1.0 -m "Design version 1.0 approved by Harry (2026-09-24)"
git push origin design-v1.0
```

Check on GitHub:
- [ ] Branch `main` with one commit
- [ ] Tag `design-v1.0`
- [ ] `handbook/`, `design/`, `platform/`, `scripts/`, `CLAUDE.md`, `.github/` are present (`.github/` is a hidden folder: make sure it was copied)

## Step 2. Configure the repo

Do this **after** the first push, so protection does not block it.

> **GitHub Free plan:** branch protection and rulesets are **not available** for private repositories. Until the organization moves to **GitHub Team** (planned), use these compensating controls (in place since 2026-09-24):
> - Merge settings: squash merge only; delete branch after merge (available on Free).
> - Local `pre-push` hook that blocks direct pushes to `main` (`.git/hooks/pre-push`; install it on every machine that pushes). Bypass with `--no-verify` only in an emergency, with Harry's approval.
> - Process: every change through a pull request, reviewed by someone other than its producer (handbook Ch.5).
> - CI (`.github/workflows/ci.yml`, task A09) runs on every pull request, on every push to `main` and nightly. A red check cannot block the merge on GitHub Free: **never merge a pull request whose `ci-ok` check is red or still running**. A red run on `main` means something was merged anyway: fix it first.
> - Security scan exceptions (`.gitleaks.toml`, `.trivyignore`, `.semgrepignore`) change only with a reason, a date and Person B's approval in the pull request.
> After the upgrade: turn on the branch protection below and add Person B to the repository (GitHub does not let authors approve their own pull requests).

| Setting | Value | Why |
|---|---|---|
| Branch protection on `main` | PR required; at least 1 approval; required status check `ci-ok` (the one summary job of `ci.yml`); no force push; dismiss stale approvals when new commits are pushed | Nobody, including AI, pushes straight to `main`; approval stays bound to what was reviewed |
| Merge method | Squash merge only | 1 PR = 1 commit |
| Delete branch after merge | On | Tidy repo |
| Access | Project members only | Internal asset |
| Secret scanning / push protection (if your plan has it) | On | Blocks leaked secrets |

`.github/CODEOWNERS` (task A09) names Harry as the only owner today. GitHub ignores CODEOWNERS for private repositories on the Free plan; it takes effect after the upgrade. Add Person B then.

## Step 3. Create milestones, labels and the 44 issues

```bash
# Dry run: shows what would be created, creates nothing
python3 scripts/create-issues.py --repo harryforge/agentic-sdlc-framework --dry-run

# Create: 5 milestones (M-A, M-B, M-0, M-C, M-D), labels, 44 issues
python3 scripts/create-issues.py --repo harryforge/agentic-sdlc-framework
```

- Safe to run again: issues whose title already exists are skipped.
- `--only A01,A02` creates only some tasks.
- Tasks `R01–R04` are labelled `repo:pilot`: tracked here, code in the separate repo `pilot-order-inventory`.

Check: 44 issues, each with its milestone, size label and acceptance criteria.

### Tasks most affected by handbook changes

The script labels 12 tasks `handbook-dependent`: B01, B07, B11, B12, C06, C07, C10, C11, E01, E02, E03, E05. They implement rules from handbook chapters still awaiting comments, so they are the most likely to need rework. The list is in `scripts/create-issues.py` (`HANDBOOK_DEPENDENT`).

## Step 4. Prepare Claude Code

1. Install Claude Code following the official guide: https://docs.claude.com/en/docs/claude-code/overview
2. Open a terminal at the **repo root** and start Claude Code. It reads `CLAUDE.md` at the start of every session.
3. Keep the permission prompts on. Do not use any mode that skips permission checks.
4. First session only — ask a check question before giving work:

```text
Read CLAUDE.md and README.md. Summarise in 10 bullets: the current status, the rules you must follow,
the order of work, and what you must do when a document is missing or contradictory. Do not write code.
```

If the summary misses "code the whole backlog, rework accepted", "handbook rules go in config", or "open questions go to `design/QUESTIONS.md`", correct it before continuing.

## Step 5. Run task A01

Paste into Claude Code:

```text
Task: A01 — Initialise the TypeScript monorepo
Issue: #<A01 issue number>

Read: CLAUDE.md, design/D-08-mvp-backlog.md (task A01), design/D-03-mvp-architecture.md section 11.

Step 1 — Plan (do NOT code yet):
- List the files and folders to create.
- Proposed tools: workspace management, lint, format, test, and how to enforce module boundaries
  (packages/core must not import packages/adapters/*). Explain each choice and its licence.
- How each acceptance criterion (AC1–AC3) will be tested.
- Risks or unclear points.
Stop and wait for my approval.

Step 2 — After approval: create branch task/A01-monorepo-init, write code and tests for AC1–AC3.
Step 3 — Run lint, build and tests. Fill in the "Commands" section of CLAUDE.md.
         Summarise the results and open a PR with the template; put "A01" in the title.

If a document is missing or contradictory: add the question to design/QUESTIONS.md and stop.
```

## Step 6. Review the plan and the PR

**Plan (step 1):**
- [ ] Structure matches `platform/apps/{api,worker,runner,cli}` and `platform/packages/{core,contracts,adapters/*,config}`
- [ ] Tools are reasonable; licences allow commercial use
- [ ] An **automatic** check stops `core` importing `adapters` (AC3)

**Pull request:**
- [ ] AI disclosure in the PR template is complete
- [ ] CI passes
- [ ] Locally: `pnpm install && pnpm build && pnpm lint && pnpm test`
- [ ] Add a bad import in `core` on purpose → lint must fail
- [ ] `Commands` section of `CLAUDE.md` filled in
- [ ] Reviewer is not the person who ran Claude Code for this task (2+N)

Then squash-merge and close the issue (see step 8).

## Step 7. The standard loop for every task

```text
pick the next task (step 9 order) → paste the task prompt → review the plan → approve
→ Claude Code codes on task/<ID>-<short-name> → PR → review (checklist handbook T3) → merge → close issue
```

Task prompt template (change the ID, title and sections):

```text
Task: <ID> — <title>
Issue: #<number>
Read: CLAUDE.md, design/D-08-mvp-backlog.md (task <ID>), <design sections listed in the task>.
Step 1 — Plan only; include how each acceptance criterion is tested; list rules that come from the
handbook and confirm they are read from config, not hard-coded. Stop for approval.
Step 2 — Code and tests on branch task/<ID>-<short-name>.
Step 3 — Run lint, build, tests; open a PR with "<ID>" in the title.
If a document is missing or contradictory: add the question to design/QUESTIONS.md and stop.
```

Rules for every task:
- **One task per session.** Start a new session for the next task.
- Tasks sized **L** are split into 2–3 sessions (the task note says how).
- Check `design/QUESTIONS.md` after each session; answer or escalate open questions.
- For `handbook-dependent` tasks, check in review that rules sit in config (oversight matrix, roles, SLAs, thresholds).

## Step 8. After each task

Write on the issue when closing it:
- actual time spent (to recalibrate sizes);
- how many times the plan or PR had to change;
- questions raised (already in `design/QUESTIONS.md`).

This is the framework's first real data: AI used to build the platform itself.

## Step 9. Suggested order after A01

Follow the dependencies in D-08. A practical order:

| # | Tasks | Note |
|---|---|---|
| 1 | A02 Docker Compose → C01 OpenHands PoC | Reduce the biggest technical risk early |
| 2 | A03 OpenBao → A04 secrets client | **Key holders must be named first** |
| 3 | A05 config, A06 database, A07 audit | Base for everything else |
| 4 | A08, A09, A10 | A10 needs the infrastructure operator |
| 5 | M-B: B01 → B02 → … → B11 escalation, B12 AI record → B10 tests | Mostly `handbook-dependent` |
| 6 | M-0: R01–R04 (sample repo) | Right before M-C |
| 7 | M-C: C02 → … → C10 agent register, C11 kill switch → C09 tests | |
| 8 | M-D: E01 → E07 | E07 = MVP definition of done |

## Step 10. When the handbook changes

Coding continues while the handbook is reviewed. When a handbook change is **approved** and affects the platform:

```text
handbook updated (approved) → design doc updated → change task added in scripts/generate-backlog.py
→ python3 scripts/generate-backlog.py → create the new issue (--only <ID>) → Claude Code implements it
```

- Never change code to follow an **unapproved** handbook draft.
- Label the change issues `handbook-dependent` too.

---

## Sending handbook comments

Any format works. To make changes fast, one line per comment is ideal:

| Chapter / section | Comment | Type |
|---|---|---|
| Ch.13 §13.5 Step 3 | "Loop threshold 3 is too strict for test runs; use 5" | change |
| T1 §12 | "Also add a column for the client's document number" | add |
| 0.2 Glossary | "承認者 is fine; for Person A the client says 担当者" | wording |

Types: **change** (a rule is different), **add**, **remove**, **wording** (meaning unchanged), **question**.

What happens next:
1. Claude updates the handbook chapter(s) and lists the effects on design and code.
2. You approve the chapter change.
3. If the platform is affected: step 10.

Still awaiting comments: Ch.13–20, Part 0 (0.2 glossary, 0.3, 0.4), templates T1, T3–T18.

---

## Maintaining the backlog

D-08 and its CSV are generated from `scripts/generate-backlog.py`. Edit the data in the script, then run:

```bash
python3 scripts/generate-backlog.py
```
