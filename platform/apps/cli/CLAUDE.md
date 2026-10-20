# CLAUDE.md — CLI

Rules for `platform/apps/cli` and its tests. The root `CLAUDE.md` still applies. Never break a rule here; the detail is in the linked ADR. Each rule ends with its IDs in `design/RULES.md` (ADR-M84).

## Rules
- The CLI reads tokens from a hidden prompt or stdin, never an argument; never prints them; refuses `NODE_TLS_REJECT_UNAUTHORIZED=0` and redirects (ADR-M36). A new token appears once; never log it. The saved login is folder 700, file 600; a file others can read is refused. `sdlc doctor` adds no endpoint and sends no request with certificate checks off. [R087]
- `sdlc plan draft` is local only: no API call, no Git command, never submits, commits or pushes; never fill the `PERSON MUST` fields by guessing (ADR-M62). [R059]

## Commands
Run from the repo root.
- User CLI (ADR-M36, handbook Ch.19 §19.8c, `platform/USER-GUIDE.md`): `sdlc help|login|logout|whoami|token|audit verify|intent|spec|plan (submit|list|show|draft)|gate|escalation|run|evidence|ai-record|cost report|eval plan|run|list|show (L05, ADR-M82)|report (L06, ADR-M83; `sdlc next` without an intent lists evaluations ended in 7 days)|task draft|register|list|approve|reject (L07, ADR-M85; `draft` writes the card on this machine, never over a file without `--force`)|metrics gates|metrics agents (V13, ADR-M79: a role in both the cost and metrics read lists; a run's model = its `model_selected` run event, else the most costly model of its cost records)|trial report|next|doctor|admin …`, all through the API, all with `--json`.
