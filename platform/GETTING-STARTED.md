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
| Developer machine: Git, Node.js LTS, pnpm; Docker from A02; OpenSSL 3.x first in `PATH` from A04 (on macOS not the built-in LibreSSL, see `platform/deploy/README.md`) | A01, A02, A04 | Developer |
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
> - CI (`.github/workflows/ci.yml`, task A09) runs on every pull request, daily on `main` (Tuesday to Sunday, 03:00 JST: security scans; build, tests and database tests when `main` changed) and weekly with every job (Monday 03:00 JST). A push to `main` runs nothing: the pull request already ran every check. To save Actions minutes, open a pull request as a **draft** while you iterate: the heavy jobs (Compose, sandbox image) wait until you mark it ready for review. A red check cannot block the merge on GitHub Free: **never merge a pull request whose `ci-ok` check is red or still running**. A red scheduled run on `main` means something was merged anyway: fix it first.
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

## Step 3. Create milestones, labels and the 49 issues

```bash
# Dry run: shows what would be created, creates nothing
python3 scripts/create-issues.py --repo harryforge/agentic-sdlc-framework --dry-run

# Create: 5 milestones (M-A, M-B, M-0, M-C, M-D), labels, 49 issues
python3 scripts/create-issues.py --repo harryforge/agentic-sdlc-framework
```

- Safe to run again: issues that already exist (same `[ID] ` title prefix) are skipped.
- After D-08 changes (`scripts/generate-backlog.py`), run it with `--update` (first with `--dry-run`): it brings the **open** issues in line with the CSV (title, body, size label). Closed issues are never changed.
- `--only A01,A02` creates only some tasks.
- Tasks `R01–R04` are labelled `repo:pilot`: tracked here, code in the separate repo `pilot-order-inventory`.

Check: 49 issues, each with its milestone, size label and acceptance criteria.

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

## Step 11. Create the GitHub App (dev/test)

The GitHub adapter (B05, ADR-M23) talks to GitHub through a **GitHub App**. Use a **dev/test App** that is installed on a test repository only. Production gets its own App later, with its key in the real OpenBao.

Done once by the repo owner in the browser. Claude must never read or handle the private key.

1. **Test repository.** Private repository `harryforge/pilot-order-inventory` with a README, and one open issue for the live test (issue #1, "Live test issue (GitHub adapter)").
2. **Create the App:** organization settings → Developer settings → GitHub Apps → **New GitHub App** (`https://github.com/organizations/harryforge/settings/apps/new`).

| Field | Value |
|---|---|
| GitHub App name | `harryforge-sdlc-dev` |
| Homepage URL | `https://github.com/harryforge/agentic-sdlc-framework` |
| Callback URL | empty |
| Webhook → Active | **off** (the MVP polls, QUESTIONS #43, ADR-M11) |
| Where can this App be installed | Only on this account |

3. **Repository permissions** (everything else "No access"; no organization or account permissions):

| Permission | Level |
|---|---|
| Contents | Read and write (C08: the runner pushes `agent/*`) |
| Issues | Read and write |
| Pull requests | Read and write (C08: the platform opens the pull request) |
| Code scanning alerts | Read-only (C08: security findings at G6, QUESTIONS #157) |
| Checks | Read-only |
| Commit statuses | Read-only |
| Metadata | Read-only (automatic) |

   Later tasks add only what they need. After a permission change, accept it on the installation (GitHub asks the account owner), or tokens keep the old permissions.

4. **Note the Client ID** (`Iv…`). It is not a secret; the adapter uses it as the JWT issuer (the numeric App ID also works).
5. **Private key:** "Generate a private key", then move it out of Downloads, outside the repository:

```bash
mkdir -p ~/.config/sdlc-secrets && chmod 700 ~/.config/sdlc-secrets
mv ~/Downloads/*.private-key.pem ~/.config/sdlc-secrets/github-app-dev.pem
chmod 600 ~/.config/sdlc-secrets/github-app-dev.pem
```

   Never paste the key into a chat, commit it, or send it by e-mail or chat tools.
6. **Install the App** on `harryforge` → **Only select repositories** → `pilot-order-inventory` only.
7. **Live test** (optional, never in CI). Create `~/.config/sdlc-secrets/github-test-app.json` (mode 600); it holds a **path** to the key, not the key:

```json
{
  "client_id": "Iv…",
  "private_key_file": "/Users/<you>/.config/sdlc-secrets/github-app-dev.pem",
  "repo": "harryforge/pilot-order-inventory",
  "issue": 1,
  "file_path": "README.md",
  "commit_sha": "<40-hex commit on main>"
}
```

```bash
nvm use 24   # the repository needs Node 24
SDLC_GITHUB_LIVE_TEST=1 SDLC_GITHUB_TEST_APP_FILE=~/.config/sdlc-secrets/github-test-app.json \
  pnpm exec vitest run --config vitest.integration.config.ts platform/tests/integration/github
```

   It issues a one-repository token, posts a comment on the issue, polls it back and reads a file.
8. **OpenBao (the worker polls GitHub, B06):** store `client_id` and `private_key` in `kv/shared/github-app` of the development OpenBao. The key is read from the file, never typed. Follow runbook T11 §5b.1, in the macOS Terminal (not through a chat tool). Then deliver the worker's credentials (T11 §5f: `pnpm openbao:bootstrap worker-credentials`) and start it with `pnpm compose:platform`.
9. **Live test of the poller** (optional, never in CI; needs Docker for the throw-away database). The App posts `/approve G9` on the test issue; the poller must ignore it, because the App is a bot, and post no reply:

```bash
SDLC_GITHUB_LIVE_TEST=1 SDLC_GITHUB_TEST_APP_FILE=~/.config/sdlc-secrets/github-test-app.json \
  SDLC_TEST_DB_DIR=platform/tests/integration/github pnpm test:db
```

## Step 12. Start the API and create the first admin (dev)

The API (task B03, [ADR-M26](../design/ADR-M26-api-app.md)) authenticates people with personal API tokens. Run the commands below yourself, in a terminal: they print a token **once**. Never run them through a chat tool, and never paste the token anywhere except your password manager.

1. OpenBao is initialised, unsealed and configured (runbook T11 sections 3 and 4). Deliver the API's credentials, then start it:
   ```bash
   pnpm openbao:bootstrap api-credentials
   pnpm compose:platform
   curl -s http://127.0.0.1:8090/health/ready
   ```
2. Migrate the database (`pnpm db:migrate`), then create your tenant, your user and your first token. `SDLC_DB_URL` is the `platform_app` URL (`platform/deploy/README.md`, "First admin and API tokens"):
   ```bash
   pnpm sdlc ops bootstrap --tenant internal --tenant-name "Internal" --email you@example.com --name "Your Name"
   ```
3. Check the token: `curl -s -H "Authorization: Bearer <token>" http://127.0.0.1:8090/v1/me`.
4. Log in with the CLI (task B04, [ADR-M36](../design/ADR-M36-cli-api-client.md)) and paste the token at the hidden prompt. The login is saved in `~/.config/sdlc/credentials.json`, readable only by you:
   ```bash
   pnpm sdlc login --api-url http://127.0.0.1:8090
   pnpm sdlc whoami
   ```
   Then `pnpm sdlc intent …`, `pnpm sdlc gate …`, `pnpm sdlc escalation …` and `pnpm sdlc ai-record …` work through the API (handbook Ch.19 §19.8c). `pnpm sdlc logout` revokes the token on the server, then deletes the saved login.

5. Set up a project and its team through the API (task B13, [ADR-M37](../design/ADR-M37-admin-onboarding.md), handbook Ch.19 §19.8d). The bootstrap made you a tenant admin. Nobody gives a role to themselves, so add a second person for each role you need; Person A and Person B are always different people:
   ```bash
   pnpm sdlc admin project create --slug pilot --name "Pilot" --repo harryforge/pilot-order-inventory
   pnpm sdlc admin user create --email colleague@example.com --name "Colleague"
   pnpm sdlc admin identity link --user colleague@example.com --github-id <numeric ID> --github-login <login>
   pnpm sdlc admin role grant --project pilot --user colleague@example.com --role person_b
   pnpm sdlc admin config show --project pilot
   ```
   The numeric GitHub ID comes from `gh api users/<login> --jq .id`. Nobody gives a role to themselves through the API: a role for yourself comes from a second tenant admin (`pnpm sdlc admin tenant-admin grant --user <email>`), or from the operator on the server (`pnpm sdlc ops role grant --tenant internal --project pilot --email you@example.com --role person_a`, with `SDLC_DB_URL`).
6. Replace the bootstrap token with your own: `pnpm sdlc token create --name laptop-you`, log in again with it (`pnpm sdlc login`), then revoke the bootstrap token (`pnpm sdlc token list`, `pnpm sdlc token revoke --id <ID>`).

## Step 13. Restart the dev stack after a break (dev)

Use this after a reboot, after Docker Desktop restarted, or when `sdlc-api` and `sdlc-worker` keep restarting with "Cannot reach OpenBao". It assumes Steps 11 and 12 were done once on this machine. Run every command **yourself, in the macOS Terminal**, from the repo root: some ask for key shares or tokens at a hidden prompt, and these never go through a chat tool.

| # | Do | Check |
|---|---|---|
| 1 | Start the infrastructure: `platform/deploy/scripts/up.sh core` | The script ends without an error (it waits until the services are healthy) |
| 2 | `pnpm openbao:bootstrap status` | Says `sealed` after every restart (runbook T11 §4) |
| 3 | `pnpm openbao:bootstrap unseal`: type key shares at the hidden prompt until it is unsealed (on a dev machine you hold all the throw-away shares) | `status` says `unsealed` |
| 4 | Apply new migrations, if `main` has new ones: `SDLC_DB_MIGRATION_URL="postgres://platform:<PLATFORM_DB_PASSWORD>@127.0.0.1:5432/platform" pnpm db:migrate` (the password is in `platform/deploy/.env`) | `pnpm db:status` (same variable) lists no pending migration |
| 5 | Start the rest: `platform/deploy/scripts/up.sh core models platform sandbox` (add `observability` for Langfuse) | The script ends without an error |
| 6 | `curl -s http://127.0.0.1:8090/health/ready` | Ready |
| 7 | `pnpm sdlc whoami` (if the login was removed: `pnpm sdlc login --api-url http://127.0.0.1:8090`) | Shows your user |

Start `core` alone first: `sdlc-api`, `sdlc-worker`, `sdlc-runner` and `litellm-agent` cannot become healthy while OpenBao is sealed, so `up.sh` with those profiles would wait until it times out.

**The credentials commands are NOT needed after a plain restart.** The AppRole secret IDs stay in the services' volumes and live 90 days (`APPROLE_SECRET_ID_TTL`); the processes log in again by themselves. Run a credentials command only in these cases (each one asks for an admin token, runbook T11 §5.1, and prints no secret):

| When | Command (then restart that service) |
|---|---|
| First set-up, or the secret ID is older than 90 days | `pnpm openbao:bootstrap api-credentials` → `sdlc-api`; `worker-credentials` → `sdlc-worker`; `runner-credentials` → `sdlc-runner`; `litellm-credentials` → `litellm-agent` |
| Once after the C08 update (pushes need to read the stored diff), or the evidence key may have leaked | `pnpm openbao:bootstrap runner-evidence-credentials` → `sdlc-runner` |
| Once after the E02 update (Evidence Packs), or the API's evidence key may have leaked | `pnpm openbao:bootstrap api-evidence-credentials` → `sdlc-api` (runbook T11 §5h) |
| A service log says it cannot log in to OpenBao (`invalid secret id`) | That service's credentials command |

Restart one service: `docker compose -f platform/deploy/docker-compose.yml --env-file platform/deploy/.env --profile core --profile models --profile platform --profile sandbox restart <service>`.

To stop everything and keep the data: `pnpm compose:down`. If you do not need the platform for a while, stop it this way: a sealed OpenBao makes `sdlc-api` and `sdlc-worker` restart every minute.

## Step 14. Prepare the pilot repo for live tests (dev)

Live tests run the platform against the real `harryforge/pilot-order-inventory` with the test GitHub App. They never run in CI. Do these once; each line says where the details are.

| # | What | How | Check |
|---|---|---|---|
| 1 | Test App permissions | App settings (Step 11): Contents **read and write**, Pull requests **read and write**, Code scanning alerts **read**, Issues read and write, Checks, Commit statuses and Metadata read. Then accept the new permissions on the installation (organization settings → GitHub Apps → Configure) | `gh api /orgs/harryforge/installations --jq '.installations[]\|select(.app_slug=="harryforge-sdlc-dev")\|.permissions'` |
| 2 | The pilot project, its team and AI record | Step 12 item 5; `pnpm sdlc ai-record set …` (handbook Ch.19 §19.8b). Person A and Person B are two different people with two GitHub accounts | `pnpm sdlc admin config show --project pilot`, `pnpm sdlc ai-record show --project pilot` |
| 3 | The project configuration | `pnpm sdlc admin config show --project pilot` gives the version; write the settings that differ from the defaults into a YAML file outside the repo, then `pnpm sdlc admin config set --project pilot --file <file> --expected-version <version>` (handbook Ch.19 §19.8d). For the pilot: `verification.required_checks: [ci-ok]` (G6 waits only for the pilot's `ci-ok`, handbook Ch.14), `sandbox.image` (Step 14 item 4) and `run.agent_key` (item 5) | `config show` prints the new version and values |
| 4 | The sandbox image | `pnpm sandbox-image:build node24` prints the reference by digest; on Docker Desktop use `platform/sandbox-images/build.sh node24 --no-push` (runbook T11 §5g). Put it in `sandbox.image` | The reference ends in `@sha256:…` |
| 5 | A registered, active agent | `pnpm sdlc admin agent register …`, then the approvals (handbook Ch.20 §20.5b). Its `instructions_ref` points at the pilot's `AGENTS.md` | `pnpm sdlc admin agent show <key>` says `active` |
| 6 | A model | A provider key in OpenBao (runbook T11 §5d), or on a dev machine the local Ollama model `gpt-oss:20b` (QUESTIONS #78). One real run with an API model is needed before the trial M-E (QUESTIONS #81) | `curl -s -H "Authorization: Bearer <master key>" http://127.0.0.1:4000/v1/models` lists it (run in the terminal; never paste the key) |

The live tests (each needs the test App's private key file, kept outside the repo):

```bash
SDLC_GITHUB_LIVE_TEST=1 SDLC_GITHUB_TEST_APP_FILE=<file outside the repo> pnpm exec vitest run --config vitest.integration.config.ts platform/tests/integration/github
SDLC_SANDBOX_LIVE_TEST=1 SDLC_GITHUB_TEST_APP_FILE=<file outside the repo> pnpm test:sandbox-live
pnpm test:agent-real
```

The first includes the publish test (C08: push and pull request on the pilot); the second clones the pilot into a real sandbox; the third runs the agent with the local Ollama model (CLAUDE.md, "OpenHands adapter").

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
