# ADR-M85. A project's own task set from its merged intents

| Item | Value |
|---|---|
| Status | **Proposed** (task L07, PR 1) |
| Date | 2026-10-20 |
| Decided by | The repository owner (L07 plan approved in the session, 2026-10-20, with answers to QUESTIONS #485–#487) |
| Related | D-08 task L07 (AC1–AC4); ADR-M78 (the harness, the task format, `--check`); ADR-M81 (evaluations on the server, the scoring containers); ADR-M82 (plans, `access.eval_roles`, files read from the default branch); ADR-M39 (specs, `spec_refs`); ADR-M32 (data classes); FR-40, FR-44; D-07 §4; QUESTIONS #450, #474, #485–#487 |

## 1. Context

- Evaluations run today on the sample repository only: task set v1 (8 tasks on `pilot-order-inventory`) or a private set mounted on the server (`SDLC_EVAL_TASKS_DIR`). A manager wants numbers on the project's own code (QUESTIONS #450).
- A merged intent already has what a task needs, as in SWE-bench:
  - the spec (a file on the default branch, `spec_refs`: path and SHA-256, ADR-M39);
  - the commit before the change (the base);
  - the tests the pull request added or changed (the hidden tests);
  - the change itself (the reference solution).
- Four limits shape the design:
  - the platform never pushes to the default branch (R028);
  - the platform never stores client text: no spec, code, diff or test in a table, log, run event, audit event or Temporal (R031);
  - `--check` (ADR-M78 §2.2) runs today on a developer machine only;
  - each evaluation has one base commit (`evaluations.base_sha`), but each task from an intent has its own base.

## 2. Decision

### 2.1. The task card is a file in the project's repository

- A task is a **task card**: the file `.sdlc/eval-tasks/<task-id>.yaml` on the project's default branch. The task set of a project is the set of its approved cards.
- The platform stores the path, the commit and the SHA-256 of the card, never its content (as ADR-M82 §2.3). Code, tests and the spec are always read again from Git.
- A card holds codes, commits, paths and commands only. Its fields (schema 2 of the task format, `platform/eval/src/task.ts`; schema 1 stays valid for task sets v1 and private sets):

| Field | Content |
|---|---|
| `schema` | `2` |
| `id` | The task ID, the same as the file name |
| `intent` | The intent's code (`INT-…`) |
| `base_commit` | The commit before the change (§2.3) |
| `merge_commit` | The commit that merged the pull request |
| `spec` | The spec's path, its commit and its SHA-256 (from `spec_refs`) |
| `hidden_tests` | The test files the pull request added or changed (§2.4) |
| `planned_files` | The files the pull request changed, without the hidden tests |
| `fail_to_pass`, `pass_to_pass`, `ci` | Commands, proposed from the project configuration (§2.4), changed by a person if needed |

- The card has no title or text from the intent. A person may add a short title by hand; the platform never reads it.

### 2.2. How a task is made

1. `sdlc eval task draft <INT-…>` asks the API for the facts of the intent's merged pull request: the two commits, the changed files with their status (added, modified, removed), the test files among them, the spec reference, the proposed commands.
2. The API refuses when (AC4):
   - the intent has no merged pull request;
   - the pull request added or changed no test file (`no_tests`);
   - the base commit is not clear (`base_unclear`, §2.3);
   - the intent's data class is `prohibited`.
3. The CLI writes the card on the person's machine. The card is never sent to the platform.
4. The person commits the card through a normal pull request. A person merges it (the platform never merges).
5. `sdlc eval task register <path>` (or the same action in the API): the platform reads the card from the default branch, checks its format and that the intent belongs to the project, and stores the reference (status `registered`).
6. The check of §2.5 runs. Then a person reviews the task (§2.6).

### 2.3. The base commit and the reference solution (QUESTIONS #485)

- The reference solution is always the Git diff from `base_commit` to `merge_commit`, without the hidden test files. It is computed when needed and never stored.
- The base commit depends on how the pull request was merged:
  - a merge commit or a squash commit: its first parent;
  - a rebase merge: the commit before the first commit of the pull request on the default branch (`merge_commit~<number of commits>`).
- The draft checks that the files of this diff are exactly the pull request's files. If not, it refuses with `base_unclear`, and the person writes the card by hand.

### 2.4. Hidden tests and commands

- A test file is a file whose path matches one of `evaluation.test_globs` in the project configuration. Default: `**/*.test.*`, `**/*.spec.*`, `test/**`.
- A new adapter function of the Git host (`GitHost`) returns the changed files of a pull request with their status. `getChangedFiles` (paths only) stays.
- A removed test file is not a hidden test.
- The commands come from `evaluation.commands` in the project configuration: `fail_to_pass` (a template with the hidden test files), `pass_to_pass` and `ci`. A project without this section gets no proposal, and the person writes the commands in the card.
- The scoring container has no network (ADR-M81 §2.5). A task whose tests need a browser or a database fails its check (`check_failed`) and does not enter the set. The handbook says so.

### 2.5. The check on the server (AC3)

- Every registered task is checked, and every card whose SHA-256 changed is checked again.
- The check runs in the runner on the evaluation queue (`sdlc-runner-eval`, free slots only, ADR-M81 §2.3). It has no agent, no model and no cost.
- The runner clones the project's repository with the GitHub App's short-lived single-repository token, at `merge_commit`. It reads the card at the registered commit and checks its SHA-256, and checks the spec's SHA-256 at the spec commit.
- It scores twice, in the scoring containers of ADR-M81 §2.5 (`NetworkMode: none`):
  1. the base without a change: the `fail_to_pass` commands must fail;
  2. the base with the reference solution: `fail_to_pass`, `pass_to_pass` and `ci` must pass.
- The result is a status and a code (`checked`, or `check_failed` with a reason code such as `passes_without_change`, `solution_fails`, `install_failed`, `card_changed`, `spec_changed`). No output of the tests is kept.

### 2.6. Who reviews a task (AC1)

- A person with a role in `access.eval_roles` (ADR-M82 §2.2) approves or rejects a task after its check passed.
- The reviewer is never a producer of the intent: its creator, the person who started its run, the person who submitted its plan, or an author of the pull request's commits (matched by numeric GitHub account ID, R037). Separation of duties as R029.
- The approval is bound to the card's SHA-256. A changed card needs a new check and a new approval.
- `sdlc eval task approve|reject <task-id>` and `sdlc eval task list`. The dashboard comes later, if managers ask for it.
- Every step is audited with IDs and codes only: `evaluation_task.registered`, `evaluation_task.checked`, `evaluation_task.approved`, `evaluation_task.rejected`, `evaluation_task.gone`.

### 2.7. Data (AC2)

Two new tables, both with `tenant_id`, codes and references only (D-05 §6.8, in PR 3):

| Table | Role |
|---|---|
| `evaluation_tasks` | One task: project, task ID, intent, card path, card commit, card SHA-256, base and merge commits, status (`registered`, `checking`, `checked`, `check_failed`, `approved`, `rejected`, `gone`), the last check code |
| `evaluation_task_decisions` (append-only) | One review decision: task, card SHA-256, `approved` or `rejected`, the reviewer's user ID, a reason code |

- A task belongs to one project and one tenant. Only evaluations of that project use it; it is never copied to another tenant or project.
- The data class of an evaluation on the project's task set is never below the highest data class of the intents its tasks came from. `client_restricted` uses self-hosted models only; `prohibited` never makes a task (ADR-M32, D-07 §4).

### 2.8. Retention and a card that is removed (QUESTIONS #486)

- The platform keeps no client text for a task, so FR-44 retention changes nothing: the rows hold references and hashes, kept like other evaluation rows; evidence purge and holds work as before.
- When a card is removed from the default branch, or its intent's repository is no longer reachable, the task becomes `gone`. A `gone` task never runs again. Its row, decisions and past results stay.

### 2.9. Versions of a project's task set (QUESTIONS #487)

- The version of a project's task set is the commit of the default branch that the evaluation read the cards from, with the list of approved task IDs. Every report names the commit and the task IDs.
- Two evaluations are compared on the tasks they share (as ADR-M78 §2.5, paired by task).

### 2.10. Evaluations on the project's task set

- A plan (ADR-M82) or `ops eval start` can name the task set `project`. The evaluation takes the approved tasks of that project at start.
- The evaluation contract (ADR-M81 §2.2) names the project's repository instead of the sample repository, and each run names the base commit of its task. `evaluations.base_sha` stays for task sets v1 and private sets.
- The runner clones the project's repository like a real run, as in §2.5.

## 3. Pull requests

| PR | Content |
|---|---|
| 1 | This ADR, QUESTIONS #485–#487, D-08 L07 note |
| 2 | Task format schema 2 (`platform/eval/src/task.ts`), the Git host's changed files with status (contract and `git-github`), the configuration sections `evaluation.test_globs` and `evaluation.commands` |
| 3 | Migration, D-05 §6.8, core (draft facts, register, review, producer check, audit), API and CLI (`sdlc eval task draft|register|approve|reject|list`), messages |
| 4 | The check on the server (worker loop, runner job), evaluations on the project's task set, handbook Ch.19, deploy README, CHANGELOG, `platform/DEVELOPMENT.md` |

## 4. Tests (AC1–AC4)

- A task card made from a fixture intent: the commits, hidden tests, planned files and commands (merge, squash and rebase merges).
- Refusals: no test file (`no_tests`), base not clear, no merged pull request, `prohibited`.
- Review: a reviewer with a role approves; `viewer`, a producer, another project and another tenant are refused; an approval is bound to the card's SHA-256.
- Data: no table holds a spec, test, diff or title; another tenant cannot read a task; a removed card makes the task `gone`.
- Check: fails when the hidden tests pass without the change, fails when the solution does not pass, fails on a changed card or spec, passes on the fixture.

## 5. Consequences

- Managers get numbers on their own code, from work the team already reviewed and merged.
- The tasks live in the project's repository and go through the project's normal review. The platform holds references only.
- Tasks that need a browser or a database do not enter the set until the scoring container supports them.
- Evaluations now clone client repositories, not only the sample repository. The same token, egress and data-class rules as real runs apply.

## 6. Alternatives not chosen

| Alternative | Why not |
|---|---|
| Store the task (spec, tests, solution) in the platform | Client text in tables and evidence, against R031; a second copy outside the project's review |
| The platform commits the card | The platform never pushes to the default branch (R028) |
| `--check` on the person's machine | Not the same environment as the scoring on the server; the result could not be trusted |
| Count any changed file under `test/` as a test without configuration | Projects name tests differently; the configuration keeps it explicit |

## Version history

| Version | Date | Author | Notes |
|---|---|---|---|
| 0.1 | 2026-10-20 | Claude (task L07, PR 1) | Proposed |
