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
- PRs created by the platform's agent: the platform fills in the intent and run ID (task C08 in D-08).

## Version history

| Version | Date | Author | Notes |
|---|---|---|---|
| 0.0 | 2026-09-24 | — | Skeleton |
| 0.1 | 2026-09-24 | Claude (draft) | First content + `.github/pull_request_template.md` |
| 0.2 | 2026-09-24 | Claude (draft) | Translated into English |
