# ADR-M65. The trial report: an anonymous summary built from the existing reads

| Item | Value |
|---|---|
| Status | **Proposed** (task V01, PR 2) |
| Date | 2026-10-09 |
| Decided by | Harry (V01 PR 2 plan and its risk measures approved 2026-10-09) |
| Related | D-08 task V01; QUESTIONS #340–#342; `TRIAL.md` §6; `design/M-E-TRIAL-PLAN.md` §7.1, §8; ADR-M36 (the CLI's API client), ADR-M45 (cost report), ADR-M47 (gate metrics); handbook Ch.19 §19.8c |

## 1. Context

The trial M-E is run by the community (QUESTIONS #340): teams deploy the platform on their own machines and send what they found as a public GitHub issue. The numbers of `design/M-E-TRIAL-PLAN.md` §7.1 exist already (gate waiting times, cost, runs, decisions, escalations), but they come from several commands, and their answers hold project slugs, intent codes, titles, IDs, a repository name and links. A public report must hold none of them, and a team should not have to clean a file by hand.

## 2. Decision

### 2.1 One command, existing reads only

`sdlc trial report [--project <slug>] [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--max-intents <1-1000>] [--json]` (CLI `commands/trial.ts`). It calls only existing `GET` endpoints, with the same access rules (the whole tenant: a tenant admin; one project: a role in `access.metrics_read_roles` and `access.cost_read_roles`):

| Data | Endpoint |
|---|---|
| Waiting time per gate, auto-passed decisions, open waits | `GET /v1/metrics/gates` |
| Cost per intent and per model, wasted cost | `GET /v1/cost/report?by=intent`, `?by=model` |
| The intents (risk, status, gate, times) | `GET /v1/intents` (pages) |
| Decisions per gate (kind, person or platform) | `GET /v1/intents/:intent` |
| Runs (status, stop reason) | `GET /v1/intents/:intent/runs` |
| Escalations (trigger, route, severity, status) | `GET /v1/escalations?intent=…` |

The range is UTC dates, `from` included, `to` excluded; by default the 90 days that end today; at most 366 days. The report covers the intents **created** in the range, the oldest first, at most 500 (`--max-intents`, up to 1000).

No new endpoint: a report computed on the server (SQL) would be faster, but it is a new read path and a new place where anonymity must hold. If the reports show that the command is too slow, this can change.

### 2.2 Limits of the reads

- At most **4 requests at a time** (a small pool; the three reads of one intent run one after the other).
- Each request has a 15-second timeout (the CLI's default is 30 s).
- A 429, any answer with a 5xx status (also a proxy's HTML error page), a network error or a timeout is tried again **twice** (after 0.5 s and 1.5 s). Other refusals (401, 403, 404…) are not.
- A request that still fails stops the command: **never a report with parts missing**. The other workers finish the request they are in and send no new one. The exit code is the CLI's usual one (ADR-M36 §2.5).
- **Error output holds fixed texts only:** the HTTP status and the kind of failure (`cli.trial.fetch_failed`, `cli.trial.fetch_refused`; with `--json` a coded object), never the API's message, reason or details, which can name an intent or a project, because a team may paste this output into a public issue.
- Limits reached are reported, never hidden: `truncated.intents` (more intents than `--max-intents`, or more than 50 pages), `truncated.escalations` (an intent with 100 escalations or more), `truncated.gates` and `truncated.cost` (the API's own caps).

### 2.3 What the report holds (anonymity)

The report is **built from named fields only**; nothing of an API answer is copied whole, so a field the API adds later never reaches it. Each value goes through one of these:

| Kind | Rule |
|---|---|
| Codes (status, gate, risk, decision, actor, trigger, route, severity) | Must be in the lists of `@sdlc/contracts`; anything else becomes `other` |
| Run stop reasons | Must be one of D-05 §6.4 (`KNOWN_STOP_REASONS`); anything else becomes `other`, because a stop reason is only a code shape and could carry a word |
| Model names | Must be one of the gateway models in `platform/deploy/litellm/config.ctmpl` (`KNOWN_MODELS`, kept equal by a test); anything else is summed under `other`, because an operator's own model name could name the company |
| Projects, intents | `project-1`, `project-2` … (by slug order), `intent-1`, `intent-2` … (oldest first); the mapping stays in memory |
| Times | Durations in seconds (lead time of a finished intent, waits); dates only for the range and the day of the report |
| Amounts | Counts, token sums as digit strings, USD as 6-decimal strings (sums with BigInt, never a float) |

The cost of an intent is its spend within the range; `totals` and `models` are the spend of the whole range (also for intents created before it). So `totals` is not the sum of the intents' costs.

Never in the report: a slug, an intent or escalation code, a title or description, a UUID, a user, an e-mail, a repository, a URL, a reason link.

### 2.4 Fail closed

Before anything is printed, the report is checked with a strict schema (`commands/trial/check.ts`), independent of the building code: an unknown field fails; every code, gate, model name and count key must be a value of the same closed lists (or `other`); the other strings must be `project-N`, `intent-N`, a date, a version, a token sum or a USD amount. So a later change that forgets a list in `build.ts` is still caught. A report that fails is **not printed** (exit 3, message `cli.trial.check_failed`).

The report format is versioned: `schema: "sdlc-trial-report/1"`, with `platform_version` (the root `package.json` version, `x.y.z` with an optional pre-release, kept equal by a test).

### 2.5 Tests

`platform/tests/cli/trial-report.test.ts` against a mocked API built with the API's presenters (`trial-world.ts`):

- the report's content, the paths read, intents before the range left out;
- **markers**: every string field of every answer that the CLI's response schema still accepts gets a unique marker; none reaches the output; the world's slug, repository, e-mail, intent codes, UUIDs, titles and links never do either;
- a new field in an answer and an unknown code (`other`);
- fail closed (a poisoned report prints nothing);
- 500 intents: never more than 4 requests in flight, exactly 3 + 5 + 3 × 500 requests;
- `--max-intents` and `truncated`; a 503 (JSON or an HTML page) tried again; a 503 that stays stops the report; a 403 is not tried again; after a failure the other workers stop; the API's error text never reaches the output;
- bad options; the default range; the known models equal `config.ctmpl`.

## 3. Consequences

- A trial team runs one command and pastes its JSON into the issue template `trial-report`; Claude summarises the reports into `design/M-E-REPORT.md` (M-E-TRIAL-PLAN §8).
- A new model in `config.ctmpl` needs `KNOWN_MODELS` updated (the test fails otherwise); a new stop reason in D-05 needs `KNOWN_STOP_REASONS` updated, or it shows as `other`.
- A new free-text field in an API answer needs no change here: it is never copied.

## 4. Known limits

- **Small numbers.** With one or two intents, counts and durations could hint at who tried the platform. The sample project is fictional and a team chooses to send its report, so this is accepted.
- **Speed.** The command reads 3 answers per intent. At 500 intents that is about 1,500 requests at 4 at a time; fine for a trial. A server-side report is the option if it is not (§2.1).
- The report counts what the API returns now: a purged evidence file or an archived project changes nothing here, since the report reads no evidence.
