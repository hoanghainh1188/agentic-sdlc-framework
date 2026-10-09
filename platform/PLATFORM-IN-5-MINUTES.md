# The platform in five minutes

For anyone who joins a team that uses the platform. Read this first; then do the [tutorial](TUTORIAL-FIRST-FEATURE.md).

## 1. The idea

You already deliver software in steps: someone asks for a change, someone designs it, someone codes it, someone reviews it, someone releases it. With the platform, **an AI agent does the coding**, and **people stay in charge of every decision around it**. The platform checks each step, keeps the evidence, and stops the agent when it goes outside what people approved.

## 2. What changes for you

Two people stay in control of every project: **Person A**, the intent owner, who asks for the change and follows it, and **Person B**, the independent reviewer and approver, who checks and approves what others produced.

| What you do today | With the platform | Who |
|---|---|---|
| A ticket or a request from the client | An **intent**: the change, its risk and its data class (how sensitive its information is), linked to a GitHub issue | You (Person A) |
| A specification or a ticket description | A **spec**: a Markdown file in the repository, with acceptance criteria | You (Person A, or the BrSE) |
| Deciding which files and modules to touch | A **plan**: a small YAML file that lists the files the agent may change | You write it; Person B approves it |
| Writing the code and the tests | An **agent run**: the agent codes in an isolated sandbox, inside the plan and the budget | The agent; you can stop it |
| Pushing a branch and opening a pull request | Done by the platform, after it checked the agent's changes | The platform |
| CI on the pull request | The same CI, read by the platform | The platform |
| Code review and merge | The **same GitHub review**, by someone who did not produce the change; then a person merges | Person B |
| Release approval | Person B approves the release with an **Evidence Pack**: spec, plan, diff, CI, every decision, cost | Person B |

Your day-to-day tools stay the same: **GitHub issues, comments and reviews**. Two small additions: the `sdlc` command (to create intents, link specs, submit plans) and a read-only **dashboard** that shows what waits for whom.

## 3. Six words to know

| Word | Means |
|---|---|
| **Intent** | One change you want, from request to release. It has a code such as `INT-2026-0007` |
| **Gate** | A checkpoint, G1 to G8. The intent cannot move on until the gate passes |
| **HITL / HOTL / AUDIT** | At a HITL gate a person must decide. At a HOTL gate the platform passes it when its conditions hold, and a person can still block it within the **block window** (4 working hours by default, configurable). At an AUDIT gate the platform passes it and people check samples afterwards |
| **Run** | One session of the agent working on the intent, in a sandbox, with a cap on iterations, time and cost |
| **Escalation** | The platform asking a named person to decide something unexpected (over budget, files outside the plan, a gate waiting too long). The work waits until someone answers |
| **Evidence Pack** | The record of the intent, built and sealed at release, that you can show a client |

More words: the [glossary](../handbook/00-introduction/02-glossary.md).

## 4. The eight gates in one line each

| Gate | The question | Usually decided by |
|---|---|---|
| G1 Intent, scope, risk | Is this the right change, with the right risk? | Person A |
| G2 Specification | Is the spec complete and clear? | Person A (the platform for Low risk) |
| G3 Plan | Is the plan right, and which files may change? | Person B (the platform for Low risk) |
| G4 Execution boundary | May the agent run, with which limits? | The platform (Person A for High risk) |
| G5 Scope and budget | Did the run stay inside the plan and the budget? | The platform |
| G6 Verification | Did CI pass? Any security finding? | The platform (Person B when needed) |
| G7 Review and merge | Is the pull request good? | Person B, by a GitHub review; then a person merges |
| G8 Release | Should it be released? | Person B |

The risk tier changes how far the agent may go: **Low and Medium** risk, the agent changes code; **High** risk, it only writes a proposal; **Critical** risk, it never runs.

## 5. Three rules that never change

1. **Whoever produces a change never approves it** at review and release (G7, G8): the person who created the intent, submitted the plan, allowed a run or authored a commit, and the agent. The creator still approves G1, their own request.
2. **No gate passes by silence.** If nobody decides, the intent waits, and an escalation goes up the chain.
3. **The platform never merges and never deploys.** People do.

## 6. Where to go next

| You want to | Read |
|---|---|
| See one real feature go from idea to release, step by step | [Tutorial: your first feature](TUTORIAL-FIRST-FEATURE.md) |
| Look up a command or what to do when something goes wrong | [User guide](USER-GUIDE.md) |
| Set up the platform for a whole team | [Rollout guide](ROLLOUT-GUIDE.md) |
| Look up a word | [Glossary](../handbook/00-introduction/02-glossary.md) |
| Know the details of a gate or a role | Handbook: [codes table](../handbook/00-introduction/05-codes.md), Ch.5 (roles), Ch.10 (gates) |
