# AGENTS.md

Instructions for AI coding agents that work in this repo. Read them before you change anything.

## About this repo

- A **fictional** order and inventory system (受注・在庫管理) for a small retail company in Japan. All data is fake.
- `apps/web`: Vue 3, Vite, TypeScript, Vitest. `apps/api`: NestJS 12 (ES modules), TypeORM, PostgreSQL 18, Jest.
- pnpm 10 workspace, Node.js 24. The README explains the features, the business rules and the design decisions.

## Work from the task

- Your task has a spec in `docs/specs/` and a plan (a list of files). Change only the files in the plan.
- Write a test for every acceptance criterion (AC) of the spec.
- If the spec is unclear or contradicts the code, do not guess. Stop and explain the problem in your final message.
- Never edit the spec.

## Commands

Run them in the repo root.

| Command | Use |
|---|---|
| `pnpm install --frozen-lockfile` | Install packages. Always from the lockfile |
| `pnpm lint` | ESLint on the whole repo |
| `pnpm typecheck` | TypeScript check (`tsc`, `vue-tsc`) |
| `pnpm test` | Unit tests of both apps. No database needed |
| `pnpm build` | Production build of both apps |
| `pnpm test:integration` | Api integration tests. Needs PostgreSQL (see below) |

- Packages come from the npm proxy that the sandbox sets in `NPM_CONFIG_REGISTRY`. The sandbox has no other internet access. Never change the registry.
- Add or upgrade a package only when the plan names it. Then commit `pnpm-lock.yaml` with it.

## PostgreSQL and integration tests

- `pnpm test:integration` needs a PostgreSQL server. The sandbox has no PostgreSQL and no Docker today.
- Do not try to install or start PostgreSQL or Docker.
- Still write the integration tests (`*.int-spec.ts`) that the spec needs. Run the unit tests.
- In your final message, say that the integration tests did not run. CI runs them on the pull request.

## Conventions

- TypeScript `strict`. Code, comments, test names and commit messages in English.
- Japanese only in data values (for example the order statuses 受付, 出荷済) and in screen labels when the spec asks for it.
- Api tests:
  - import `describe`, `it`, `expect` and `jest` from `@jest/globals`;
  - never use `jest.mock`; replace dependencies with `Test.createTestingModule` (NestJS testing module);
  - write relative imports with the `.js` extension, as in the source code.
- Unit tests: `*.spec.ts`, no database. Integration tests: `*.int-spec.ts`, real PostgreSQL.
- Schema changes only through a new migration in `apps/api/src/migrations/`. Register new migrations and entities in `apps/api/src/database/`. Never edit an existing migration.
- Api errors use a stable `code` from `ERROR_CODES` (`apps/api/src/common/domain-error.ts`).
- Follow the style of the code around your change.

## Never

- Never push, change Git remotes or Git configuration, or switch to another branch.
- Never change `.github/` (CI, CODEOWNERS, pull request template), `.gitleaks.toml` or `.trivyignore`.
- Never change `AGENTS.md`, and never add other agent instruction files (`CLAUDE.md`, `AGENTS.md` in a subfolder, `.cursorrules`, `.openhands/`, `.agents/`).
- Never add secrets, tokens or passwords. Never add real names, addresses, phone numbers or client data. Test data is fake.
- Never skip, disable or weaken a test or a lint rule to make a check pass.

## When you finish

1. `pnpm lint`, `pnpm typecheck`, `pnpm test` and `pnpm build` pass.
2. Write a short final message: what you changed, which tests you added, and what you could not run or check.
