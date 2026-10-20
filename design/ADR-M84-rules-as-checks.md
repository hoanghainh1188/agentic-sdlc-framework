# ADR-M84. Rules as checks: a rules register, hooks, lint and tests, a shorter CLAUDE.md

| Item | Value |
|---|---|
| Status | **Proposed** (task W01, PR 1) |
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
