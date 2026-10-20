# ADR-M84. Rules as checks: a rules register, hooks, lint and tests, a shorter CLAUDE.md

| Item | Value |
|---|---|
| Status | **Accepted** (repository owner, 2026-10-20, after W01 PR 1–4) |
| Date | 2026-10-20 |
| Decided by | The repository owner (W01 plan approved in the session, 2026-10-20) |
| Related | D-08 task W01 (AC1–AC4); `design/RULES.md`; QUESTIONS #424–#426 (the first slimming of CLAUDE.md), #479; ADR-M16 (tooling, lint) |

## 1. Context

- The root `CLAUDE.md` holds about 190 rules in 131 bullets (about 4,700 words). Claude Code reads it at the start of every session, also for a change to one document.
- A review of every bullet (2026-10-20, `design/RULES.md`) found:
  - 94 rules with a full mechanical check (lint, test, database trigger or grant, runtime guard, CI);
  - 65 rules with a partial check;
  - 27 rules that are text only.
- Every rule about what Claude itself must never run (prune volumes, tags and releases, `npm publish`, force-push, commands that print a secret) is text only. The repository has no `.claude/settings.json` and no hook.
- A rule that is only text depends on a person or a model remembering it. A long file makes each rule easier to miss.

## 2. Decision

### 2.1. A rules register

- `design/RULES.md` lists every rule of the root `CLAUDE.md`: a stable ID, the check that enforces it, its coverage and a proposal.
- A new rule in any `CLAUDE.md` gets a row in the same pull request.
- A rule that looks outdated or wrong goes to `design/QUESTIONS.md`. Its wording changes only after the answer.

### 2.2. A check before text

- Order of preference for a new or existing rule:
  1. a check that fails the build (lint rule, unit test, database trigger or grant, CI step);
  2. a Claude Code hook that refuses a command before it runs (`.claude/settings.json`, `PreToolUse`);
  3. text in a `CLAUDE.md`, only when 1 and 2 are not possible.
- A rule with a full check needs one short line in `CLAUDE.md` (what it protects and the ADR), not the detail.

- As built (PR 3): lint rules and tests for rules that had no full check (IDs in `design/RULES.md`).
  - Lint (`eslint.config.mjs`): no `console.*` in `platform/apps` and `platform/packages` (R084a; `migrate-cli.ts` excepted); no Temporal schedule in the worker (R044c, R053g); `insertInto('audit_log')` only in the audit log repository (R075c). `platform/tests/workspace/lint-rules.test.ts` checks that each rule fires.
  - `migrations.lock.json` holds the SHA-256 of every migration; a new migration adds its line, and an edited one fails `platform/tests/db/migrations-lock.test.ts` (R075b).
  - One list of append-only tables, each with UPDATE/DELETE and TRUNCATE triggers, and no such table outside the list (R030a). The test found `evaluation_run_contracts`, which the list in `CLAUDE.md` did not name.
  - The generated D-08, CSV and ROADMAP equal the script's output (R092); every file of `workflow/` is checked for `oversightMode` (R047a); the routes marked `@SessionAction` are listed by file (R085b); doctor's options and the trial's `COMPOSE_PROJECT_NAME` (R080c, R081c); internal sources and old codes in the documents (R016, R024b).

### 2.3. Hooks

- The hook refuses commands only. It never changes a command and never runs one.
- The hook is a backstop. The owner's permission settings and the rules stay in place.
- The hook script has unit tests.
- The hook never reads or prints a secret value.
- As built (PR 2): `.claude/settings.json` runs `platform/tools/claude-hooks/guard-bash.mjs` before every Bash tool call (`PreToolUse`, matcher `Bash`).
  - The script splits the command at `;`, `&&`, `||`, `|`, `&` and new lines, and checks each part. It skips heredoc bodies and quoted text (a commit message is not a command). It checks the command inside `bash -c "…"` too.
  - It refuses: volume prunes and `down -v` (R039, R078b); tags, `push --tags`, `gh release create|edit|delete|upload`, `gh workflow run … push=true`, `npm|pnpm|yarn publish`, `npm token` (R040); force-push, `push --delete`, `rebase` except `--abort` (R125); a push to `main` or `master` (R028b); `openbao:bootstrap init|unseal|root-token|*-credentials`, `sdlc ops bootstrap|token`, `github-app:create`, `test:*-live` (R035); the SeaweedFS key listing given to `weed` on its line or in its heredoc (R074e).
  - A refusal exits 2 and names the rule in `design/RULES.md`. Input it cannot read, and other tools, are let through.
  - Tests: `platform/tests/workspace/claude-hook.test.ts` (a table of refused and allowed commands, the script with the hook's JSON, the settings file).

### 2.4. Rules by folder

- A rule that applies to one folder moves to a `CLAUDE.md` in that folder. Claude Code reads that file when it works on files there.
- Examples: `platform/apps/runner`, `platform/apps/worker`, `platform/deploy`, `platform/apps/dashboard`.
- The root `CLAUDE.md` keeps:
  - the hard rules that apply everywhere (tenant scope, secrets, separation of duties, the platform never merges, append-only tables);
  - the task workflow and the commands;
  - a pointer to the register.
- A test checks that every rule ID of the register is found in exactly one `CLAUDE.md`, or is marked as enforced by a check.

- As built (PR 4): seven folder files hold the module rules: `platform/packages/core` (workflow, gates, evaluations, evidence, retention, reports, migrations, audit; also for the worker), `platform/apps/runner`, `platform/deploy`, `platform/apps/api`, `platform/apps/dashboard`, `platform/apps/cli` and `platform/eval`.
  - The root `CLAUDE.md` keeps the hard rules, the platform-wide module rules (secrets, logging, release), the workflow, the commands and the constraints, with an index of the folder files. It says to read a folder's file before changing the folder **or its tests**, because Claude Code reads a folder's file only when it opens a file there.
  - Every rule bullet ends with its IDs (`[R043]`); `design/RULES.md` names the file of each ID; `platform/tests/workspace/claude-md.test.ts` checks that each ID is in that file once, that no tag is unknown, that the index lists every folder file, and that the root stays under 3,000 words.
  - The root fell from 4,790 to about 2,860 words (−40 %). The first target (1,800 words) would have meant cutting the hard rules or the commands, which every session needs; the budget is 3,000 instead.

### 2.5. Four pull requests

| PR | Content |
|---|---|
| 1 | The register, this ADR, QUESTIONS for the doubtful rules, two wording fixes |
| 2 | The hook and its tests |
| 3 | Lint rules and tests for the important rules without a check |
| 4 | Rules by folder; the root `CLAUDE.md` shorter |

## 3. Consequences

- Fewer rules depend on memory. A broken rule fails a check instead of a review.
- Each session reads fewer words. The rules for one folder are still read when that folder changes.
- The register must be kept in step with every `CLAUDE.md`. The test of PR 4 enforces this.
- A hook cannot catch every form of a command. It is not a security boundary; the rules and the review stay.

## Version history

| Version | Date | Author | Notes |
|---|---|---|---|
| 0.1 | 2026-10-20 | Claude (task W01, PR 1) | Proposed |
| 0.2 | 2026-10-20 | Claude (task W01, PR 2) | §2.3 as built: the hook |
| 0.3 | 2026-10-20 | Claude (task W01, PR 3) | §2.2 as built: lint rules and tests |
| 0.4 | 2026-10-20 | Claude (task W01, PR 4) | §2.4 as built: rules by folder, ID tags, a word budget |
| 1.0 | 2026-10-20 | Repository owner | Accepted |
