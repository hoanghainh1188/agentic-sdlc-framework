# CLAUDE.md — Evaluation harness

Rules for `platform/eval` (the evaluation harness on developer machines, L02) and its tests. The root `CLAUDE.md` still applies. Never break a rule here; the detail is in the linked ADR. Each rule ends with its IDs in `design/RULES.md` (ADR-M84).

## Commands
Run from the repo root.
- Evaluation harness (L02, ADR-M78, `platform/DEVELOPMENT.md` §3): `pnpm eval --out <folder outside the repo> [--config] [--configurations] [--tasks] [--n]`, `pnpm eval --check`, `pnpm eval:report --out <folder>`, `pnpm eval:pairs --out <folder> --a <id> --b <id>` (`purge-diffs`); kept diffs stay in `<out>/diffs/` (700/600), never in a result or report; developer machines only, never in CI; results hold numbers and codes only; never a `:cloud` model; the hidden tests and `solution.patch` never reach the agent.
