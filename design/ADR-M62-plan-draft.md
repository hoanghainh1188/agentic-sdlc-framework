# ADR-M62. `sdlc plan draft`: a plan file draft from Spec Kit tasks or a BMAD story

| Item | Value |
|---|---|
| Status | **Proposed** (task S02, for review) |
| Date | 2026-10-08 |
| Decided by | Harry (plan approved 2026-10-08, with answers to QUESTIONS #295–#297) |
| Related | D-08 task S02 (AC1–AC4); D-02 §4.1 item 10; ADR-M40 §2.2 (plan schema version 1, unchanged); ADR-M61 §2.2 (pinned Spec Kit v1.1.2, BMAD v6.12.1); `design/POSITIONING.md` §6.1; QUESTIONS #167, #285, #295–#297 |

## 1. Context

- A plan is the file `.sdlc/plans/<intent code>.yaml` (schema version 1, ADR-M40 §2.2), written by a person and submitted with `sdlc plan submit`. Writing it by hand is slow when the team already has a task list from Spec Kit or BMAD (`design/POSITIONING.md` §6.1).
- The platform must never take a plan version by itself (QUESTIONS #167): a person is the accountable producer of every version.
- Some fields decide what the agent may do: each task's `allowed_paths` and `tools`, and the plan's `change_flags` (forced HITL at G3, dual approval at G7). A tool cannot know them.

## 2. Decision

### 2.1. The command and the sources

- `sdlc plan draft <INT-…> --from <file> --tool spec-kit|bmad [--output <file>] [--force] [--json]` reads one local Markdown file (a regular file, at most 256 KiB, strict UTF-8) and writes a plan file draft. **No API call, no Git command**: it never submits, commits or pushes. No new endpoint.
- **Spec Kit `tasks.md`** (v1.1.2, `templates/tasks-template.md`): each `- [ ] T001 [P] [US1] Description` line is one plan task with the ID `T001` and the description as `summary` (the `[P]` and `[USn]` markers removed). `depends_on` comes only from an explicit "(depends on T012, T013)"; phase order is never guessed. A phase's `**Checkpoint**:` becomes the `checkpoint` of its last task.
  - More than 20 items (QUESTIONS #295): one plan task per `##` phase (`Phase3`, or `Group<n>`), the items in `definition_of_done`, dependencies mapped to phases. The file and the output say so; the person may split it again. More than 20 phases → refused (`too_many_tasks`).
- **BMAD story file** (v6.12.1, `bmad-create-story/template.md`): each top-level item of `## Tasks / Subtasks` is one task (`Task1`, `Task2`, …), its subtasks in `definition_of_done`. BMAD names no dependencies, so none are written.
  - An **epics file is refused** (`epics_file`, QUESTIONS #296): one intent is one story.
- Fenced code blocks and HTML comments are skipped, as in S01. A task that still holds template text (`[Entity1]`, `[language]`, `Task 1 (AC: #)`, `Subtask 1.1`, `{{…}}`) is refused (`template_text`); the rule is S01's (`isFilledItem`) plus the BMAD sample tasks.

### 2.2. What a person decides (QUESTIONS #297)

- Each task's `allowed_paths` and `tools`, and `plan.change_flags`, are written as **`null`** under a comment `PERSON MUST FILL` or `PERSON MUST DECIDE`. Submission refuses `null` with the existing reason **`schema_invalid`**; `parse.ts` is unchanged. A placeholder string (`TODO`) is not used: it would be a valid path pattern. `change_flags: []` must be written on purpose.
- Paths a Spec Kit task names (`in apps/api/src/orders/orders.service.ts`) are offered as **comments only**, under `allowed_paths`, at most 20 per task, safe characters only, and only those submission would accept (`patternRefusal`): never `.github/`, `.sdlc/` or an instruction file. BMAD stories get none.
- The output lists the fields to fill (`plan.change_flags`, `tasks[0].allowed_paths`, …) and the next steps: check, fill, commit to the default branch, `sdlc plan submit`.

### 2.3. The file

- Every text value is a JSON string (a valid YAML double-quoted scalar), cleaned of control, line-separator and bidirectional characters and capped at 2,000 characters (the runner's cap per field). Text from the task list cannot start a key, a comment, an anchor or a tag. Comments hold catalog text (`plan.draft.file.*`), schema codes and the suggested paths.
- **Self-check**: before writing, the draft is rendered once more in memory with test values in the marked fields and parsed with `parsePlanFile`. A failure is refused (`draft_check_failed`) with the submission's reason (`plan.refusal.*`). The test values never reach the file (test).
- A draft larger than 64 KiB (the plan file limit, B09 PR 2) is refused (`draft_too_large`).
- **Where**: `--output`, or `.sdlc/plans/<INT-…>.yaml` in the nearest folder, from the current one up, that holds `.git` (a folder, or a worktree's file). This is a check of the folder only, no Git command. None and no `--output` → refused (`no_repository`). An existing file is never replaced without `--force` (`output_exists`).
- Refusals are codes (`plan.draft.refusal.*`), exit 1; usage errors exit 2.

### 2.4. Code

- Core `plans/draft/` (pure: text in, YAML out): `readSpecKitTasks`, `readBmadStory`, `renderDraft`, `draftPlan`. It reuses S01's Markdown reader (`specs/structure.ts`: `markdownLines`, `isFilledItem`).
- CLI `commands/plan-draft.ts`: file access only.

## 3. Consequences

- A person goes from a tool's task list to a submittable plan by filling three kinds of field, and remains its producer (QUESTIONS #167, FR-11).
- A pin upgrade of Spec Kit or BMAD is a code change: compare the template files of ADR-M61 §2.2 and update `platform/tests/plans/fixtures/`. An unknown layout fails closed (`no_tasks`).
- The draft holds the task list's text in the repository, like a hand-written plan. The platform still stores only its hash and codes (ADR-M40).

## 4. Not done here

- Guessing `allowed_paths`, `tools` or `change_flags`.
- Reading BMAD epics files, or several story files into one plan.
- A converter into the platform's own spec format (MVP+1, D-02 §4.2).

## Version history

| Version | Date | Author | Notes |
|---|---|---|---|
| 0.1 | 2026-10-08 | Claude (task S02) | First version (QUESTIONS #295–#297) |
