# T2 Pull request with AI disclosure

> Status: **Ready to use** · Readers: developers, code owners, Claude Code
> Live version: [`.github/pull_request_template.md`](../../.github/pull_request_template.md) (GitHub fills it in when a PR is opened).

## Purpose

- Reviewers know **which parts the AI wrote**, so they can focus there.
- Every PR links back to its task / intent, run and design document.
- The PR is part of the evidence for gate G7.

## Required sections

| Section | Why |
|---|---|
| Links: task / intent / run | Trace from requirement to code |
| AI disclosure (none / partly / mostly) + list of files | Review the risky parts |
| Verification checklist | Tests cover every AC, no secrets, no changes outside the plan |
| Points to watch | The author (or AI) flags difficult areas |

## Rules

- A PR without an AI disclosure → the reviewer asks for it before reading the code.
- The "human reviewed every file" box is ticked **only by the reviewer**, when approving. The author or the AI never ticks it (producer ≠ approver, Chapter 5).
- PRs created by the platform's agent: the platform opens the PR and fills this template from codes only: intent, run, agent, model, autonomy, the plan and diff hashes, "AI wrote most / all" and "Only files in the approved plan" (checked at G5). It never ticks "A human reviewed every file" and never writes the intent's title, file paths or text from the agent (handbook Ch.14 §14.10.1; `design/ADR-M38-gate-g6.md` §2.4).

## Version history

| Version | Date | Author | Notes |
|---|---|---|---|
| 0.0 | 2026-09-24 | — | Skeleton |
| 0.1 | 2026-09-24 | Claude (draft) | First content + `.github/pull_request_template.md` |
| 0.2 | 2026-09-24 | Claude (draft) | Translated into English |
| 0.3 | 2026-09-25 | Claude (draft) | Human-review box separated from the AI disclosure; ticked only by the reviewer |
| 0.4 | 2026-10-03 | Claude Code (task C08, PR 1) | Rule: how the platform fills the template for its agent's PRs |
