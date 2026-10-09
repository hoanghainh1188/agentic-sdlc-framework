# Try the platform: the community trial

The platform is built and tested, but no team has used it on a project yet. **We ask you to try it** on a fictional sample project and tell us what you found. Your report decides what changes next: gates that are too heavy, budgets, rules, messages, the user interface (milestone M-F, `design/D-02-mvp-scope.md` §13.3).

- **What you do:** deploy the platform on your own machine, take a few sample tasks through the 8 gates (G1–G8) with an AI agent, and send a short report as a GitHub issue.
- **What you need:** a machine with Docker, two GitHub accounts (one for the person who asks for the change, one for the person who reviews it), and an AI model: a local one with Ollama, or an API key.
- **What it costs:** your time (about one day to set up, half a day per task, mostly waiting) and, with an API model, a few US dollars of tokens. The platform caps the spend of each task.
- **No real data.** The sample project is fictional. Never use client code or real personal data in the trial.

> **Status (2026-10-09):** the report command `sdlc trial report` comes with the first release, **v0.1.0** (task V01). Start the trial from that release or later.

The full plan behind this page, with every measure and rule: [`design/M-E-TRIAL-PLAN.md`](design/M-E-TRIAL-PLAN.md).

---

## 1. What you need

| Item | Minimum | Notes |
|---|---|---|
| Machine | macOS or Linux with Docker Engine or Docker Desktop, Docker Compose v2.24+ | Windows: use WSL 2 (not tested) |
| Memory | **16 GB** with an API model; **32 GB** with the local model | The platform uses about 3 GB, each agent sandbox up to 2 GB. The local model `gpt-oss:20b` needs about 14 GB more; on a 24 GB machine it swapped |
| Disk | About 30 GB free | Images (about 10 GB), the sandbox image (about 3 GB), the local model (about 13 GB) |
| Tools | Node.js 24, pnpm 10 (`corepack enable`), OpenSSL 3, Git | [Requirements](platform/deploy/README.md#requirements) |
| GitHub | **Two accounts** (Person A and Person B) | See section 2 |
| A model | Ollama with `gpt-oss:20b`, **or** an Anthropic API key with a spend limit | Section 4 |

## 2. Who does what (two people)

The platform's main rule is that the person who makes a change never approves it (separation of duties). The trial measures exactly that, so it needs two roles:

| Role | In the trial |
|---|---|
| **Person A** (the intent owner) | Creates the intents, links the specs, writes the plans, approves G1 and G2 |
| **Person B** (the independent reviewer) | Approves the plan (G3), reviews and merges the agent's pull request (G7), approves the release (G8) |

Best: two people. If you are alone, you may use a second GitHub account for Person B, but **say so in the report**: your waiting times then mean something else, and we count them apart. The platform has no single-person mode, and will not get one (`design/QUESTIONS.md` #341).

## 3. Set up

### 3.1. The sample project

1. **Fork** [`harryforge/pilot-order-inventory`](https://github.com/harryforge/pilot-order-inventory) to the account of Person A (or an organisation you own). It is a small order and inventory application (Vue, NestJS, PostgreSQL) with ten task specs in `docs/specs/` (T01–T10).
2. In the fork, turn on **Actions** (forks start with Actions off).
3. Protect `main` (Settings → Branches): require a pull request, **1 approval**, and the status check **`ci-ok`**; no direct pushes. Add Person B as a collaborator with write access.

### 3.2. The platform

1. Clone this repository and check out the release: `git checkout v0.1.0` (or later). Then `corepack enable` and `pnpm install`.
2. Create **your own GitHub App** and install it on your fork only: [Create the GitHub App](platform/deploy/README.md#create-the-github-app-operator). Keep its private key in a file outside every repository, readable only by you (`chmod 600 <file>`).
3. Clone **your fork** somewhere on the machine (the agent's instructions are read from `AGENTS.md` on its `main` branch).
4. Choose a model (section 4). For the local model: `ollama pull gpt-oss:20b` first. For an API model: put the key alone in a file, `chmod 600`.
5. Copy [`platform/deploy/trial/trial-settings.example.yaml`](platform/deploy/trial/trial-settings.example.yaml) to a place **outside the repository**, and fill it in: your fork and its clone, the App's client ID and key file, the model, and Person A and Person B (e-mail, GitHub login and numeric ID, and a config folder each).
6. Run the whole set-up in one command, in a terminal:
   ```bash
   pnpm trial:up --settings ~/trial-settings.yaml
   ```
   It follows [Fresh deployment](platform/deploy/README.md#fresh-deployment-operator), steps 2–13, for you, in 20 to 40 minutes: OpenBao with throw-away keys, every credential, the database, the platform (`core models platform sandbox`), the tenant (Person A is its admin), the project with Person A and Person B, the sandbox image, the agent, the trial settings of [M-E-TRIAL-PLAN §6](design/M-E-TRIAL-PLAN.md#6-project-configuration-for-the-trial) and the AI record (data class `internal`). At the end, Person A and Person B are each logged in, in their own config folder. Run Person B's commands as `XDG_CONFIG_HOME=<Person B's folder> pnpm sdlc …`.

What `trial:up` refuses and keeps safe:

- It refuses a machine with another stack of the platform (`platform/deploy/.env` or `sdlc_*` volumes), `NODE_ENV=production`, no Docker, too little memory, a key file others can read, or an existing login in a config folder. It never removes or overwrites them.
- The OpenBao key shares and root token are **throw-away and kept in memory only**: never in a file, a log or the terminal. So **the trial stack cannot be started again after a reboot** or `pnpm trial:down` (`design/QUESTIONS.md` #345). Then remove it with `pnpm trial:down --wipe --settings ~/trial-settings.yaml` and run `pnpm trial:up` again; your intents are lost. Plan a task so that the machine does not restart in the middle.
- The same applies when `trial:up` stops with an error: remove the stack with `--wipe`, fix the cause it names, and run it again.
- `pnpm trial:down` stops the stack; `--wipe` removes its volumes, its env file and the two logins, after you type the project name (`sdlc-trial`). It never touches another Compose project.

The stack is for the trial only. It can never hold client data. For a server, follow [Fresh deployment](platform/deploy/README.md#fresh-deployment-operator) by hand, with real key holders (runbook T11).

**By hand instead (the fallback).** Follow [Fresh deployment](platform/deploy/README.md#fresh-deployment-operator), steps 1–14, with these values:

- tenant: any slug, for example `trial`; project: `pilot`, repository: your fork;
- users: Person A and Person B, each linked to their GitHub account (numeric ID), with the roles `person_a` and `person_b`; the operator (you) is the tenant admin;
- step 11 (the agent): the model of section 4, the instructions file `AGENTS.md` of your fork;
- step 12 (the configuration): add the trial settings of [M-E-TRIAL-PLAN §6](design/M-E-TRIAL-PLAN.md#6-project-configuration-for-the-trial), at least `verification.required_checks: [ci-ok]` and `oversight.hotl_block_window` of 1 working hour;
- step 13 (the AI record): data class `internal` (the project is fictional).

Steps that print or ask for keys, tokens or key shares: run them **yourself, in a terminal**. Never paste their output into a chat tool, an issue or a report.

## 4. Choose a model

With `pnpm trial:up`, choose the model in the settings file (`model.provider`): it stores the key or the Ollama address in OpenBao for you. By hand, follow the links in the table.

| Model | How | Notes |
|---|---|---|
| **Local:** `gpt-oss:20b` with Ollama | `ollama pull gpt-oss:20b` (a local tag, never a `:cloud` model), then store its address in OpenBao: [runbook T11 §5d](handbook/03-templates/T11-openbao-runbook.md#5d-litellm-keys-compose-profile-models), "a local Ollama model". Gateway name `gpt-oss-20b` | No API cost; slower; the quality is not that of an API model. Leave the profile `observability` off on a small machine |
| **API:** Claude Haiku | Store the key at `kv/litellm/providers/anthropic` ([T11 §5d](handbook/03-templates/T11-openbao-runbook.md#5d-litellm-keys-compose-profile-models), step 2). Gateway name `claude-haiku-4-5-20251001` | Set a spend limit at the provider first. The platform caps each task (USD 10 by default) and each run (USD 2) |

Every model call goes through the platform's gateway (LiteLLM); the agent never sees your key.

## 5. Run the tasks

Read [platform/USER-GUIDE.md](platform/USER-GUIDE.md) first: it takes one intent from G1 to G8, step by step, with the commands of each role.

| Order | Task (spec in your fork's `docs/specs/`) | Risk | What should happen |
|---|---|---|---|
| 1 | **T01** Japanese labels on the product list | Low | The full path G1 → G8: the agent writes the change, Person B reviews and merges it, Person B approves the release |
| 2 | **T09** Multiple warehouses | High | The agent only **proposes**: no branch, no pull request. Person A downloads the proposal (`sdlc evidence proposal <INT> --output <file>`) and ends the intent (`sdlc gate reject G4 <INT> --reason-code other`) |
| 3 | **T10** Delete orders older than 5 years | Critical | The platform **refuses** to run the agent: the intent is `blocked` at G4 |
| More (optional) | T02–T08 | Low, Medium | Each one like T01. Medium risk makes G2 and G3 human decisions |

For each task: create the intent on its own GitHub issue in your fork, link the spec, write the plan file and merge it through a pull request, then let the gates run (USER-GUIDE §3). While you work, keep a short **log** per task: the minutes each step took, whether the agent's change met the spec, and anything that was unclear, slow or broken.

Stop and report at once if you see a `security` escalation, if `sdlc audit verify` fails, or if anything looks like real client data.

## 6. Send your report

1. Make the report (counts and codes only; your project, intents, people and repository are not in it):
   ```bash
   pnpm sdlc trial report --json > trial-report.json
   ```
   Read the file before you send it.
2. Open an issue in this repository with the template **"Trial report"**: paste the JSON, your log, the model you used, your machine, and the problems you found (one issue per bug is even better: link them).
3. Never paste tokens, keys, `.env` values or client data into an issue. A security problem goes through [SECURITY.md](SECURITY.md), never into a public issue.

Thank you. When enough reports have arrived (for example from three teams), we publish a summary (`design/M-E-REPORT.md`) and adjust gates, budgets and rules from it.

## 7. Help

- Something does not work: [platform/deploy/README.md, Troubleshooting](platform/deploy/README.md#troubleshooting) and [USER-GUIDE §5](platform/USER-GUIDE.md#5-when-something-goes-wrong).
- A bug: open an issue with the bug template; say that you were in the trial.
- A word or a code you do not know: the [glossary](handbook/00-introduction/02-glossary.md) and the [codes table](handbook/00-introduction/05-codes.md).
