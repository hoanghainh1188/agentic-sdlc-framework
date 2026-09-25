# ADR-M16. Monorepo tooling

| Item | Value |
|---|---|
| Status | **Accepted** (Harry, 2026-09-25) |
| Date | 2026-09-25 |
| Decided by | Harry (plan approved 2026-09-25) |
| Related | D-03 section 11 (code layout), AP4 and AP7, D-08 task A01, NFR-04 (licences) |

## 1. Context

Task A01 creates the TypeScript monorepo for the platform. We need tools for workspaces, build, lint, format and tests. We also need a way to **enforce module boundaries**: `packages/core` must not import `packages/adapters/*` (D-03 AP4, D-08 A01 AC3).

The repo also holds the handbook and the design documents. Tools must **never reformat those documents**.

## 2. Decision

| Need | Choice | Version | Licence |
|---|---|---|---|
| Runtime | Node.js LTS | 24 (`engines`, `.nvmrc`) | MIT |
| Workspaces, package manager | pnpm, pinned with `packageManager` (corepack) | 10.34.5 | MIT |
| Language, build | TypeScript, project references (`tsc -b`) | 6.0.3 | Apache-2.0 |
| Lint | ESLint (flat config) + typescript-eslint (type-aware rules) | 10.11.0 / 8.70.1 | MIT / MIT |
| Format | Prettier + eslint-config-prettier | 3.9.9 / 10.1.8 | MIT / MIT |
| Test | Vitest (with Vite as its peer dependency) | 5.0.1 / 8.3.1 | MIT / MIT |

All licences allow commercial use and redistribution (NFR-04).

### 2.1. Workspace layout

- The workspace root is the repo root: `package.json`, `pnpm-workspace.yaml`, `tsconfig.json`.
- Packages: `platform/apps/*`, `platform/packages/*`, `platform/packages/adapters/*`.
- Package scope: `@sdlc/`. Adapters are named `@sdlc/adapter-<name>` (for example `@sdlc/adapter-git-github`).

### 2.2. Module format: CommonJS (open to change)

- TypeScript uses `module` and `moduleResolution` `NodeNext`. Packages have no `"type": "module"`, so the output is **CommonJS**.
- Why: least friction with NestJS (decorators, the Nest CLI) and with the Temporal worker. Both are added in M-B.
- **Open to change.** Moving to ESM later means adding `"type": "module"` per package and fixing import paths. Revisit when a dependency needs ESM, or after M-B.

### 2.3. TypeScript version

- TypeScript is pinned to **6.0.x**. TypeScript 7 exists, but typescript-eslint 8.70 supports only TypeScript `>=4.8.4 <6.1.0`.
- Revisit when typescript-eslint supports TypeScript 7.

### 2.4. pnpm build scripts

pnpm 10 does not run dependency install scripts unless the package is listed in `pnpm.onlyBuiltDependencies`.

| Package | Allowed | Reason |
|---|---|---|
| _(none)_ | — | No current dependency needs an install script. Vite 8 uses rolldown instead of esbuild; native binaries (rolldown, lightningcss, fsevents) come as prebuilt platform packages |

- The list is set explicitly to `[]`, so any new install script stays blocked until it is reviewed.
- To allow a package: add it to the list **and** to this table with the reason, in the same PR.

### 2.5. Module boundaries

| From | May import (workspace packages) | Rule |
|---|---|---|
| `@sdlc/core` | Anything except `@sdlc/adapter-*` | D-08 A01 AC3 |
| `@sdlc/adapter-*` | `@sdlc/contracts` only | Decided by Harry in the A01 plan |
| Apps (`@sdlc/api`, `worker`, `runner`, `cli`) | Anything | Apps wire adapters into core |

Enforcement:

- A small **local ESLint rule** (`platform/tools/eslint-rules/module-boundaries.mjs`), configured in `eslint.config.mjs`. `pnpm lint` fails on a violation.
- The rule maps every import to the workspace package it lands in: `@sdlc/...` by name, relative paths by resolving them (case-insensitive, because macOS and Windows file systems are). It checks static imports, re-exports, dynamic `import()`, `import('x').Type` and `require`.
- In core and adapters, a dynamic `import()` or `require` must use a static string. A computed name (for example ``import(`@sdlc/${name}`)``) cannot be checked, so lint rejects it there. Apps are not restricted.
- Why not ESLint's built-in `no-restricted-imports`: it matches the import text only. It cannot tell that a relative path such as `../../../core/src/index.js` lands in another package.
- Tests (`platform/tests/workspace/boundaries.test.ts`) cover each import form, relative paths, and the package manifests (`dependencies` must follow the same rules).
- If rules grow (layers, more packages), consider `dependency-cruiser` (MIT) instead.

### 2.6. Documents are never touched by tools

- `.prettierignore` and the ESLint `ignores` exclude `handbook/`, `design/`, `_review/`, `diagrams/`, and all Markdown files.
- They also exclude `.github/` and `scripts/` for now. CI (A09) may bring `.github/` workflows into formatting later.
- A test (`platform/tests/workspace/ignores.test.ts`) checks that every file in those folders, and every root Markdown file, is ignored by both tools.

## 3. Alternatives not chosen

| Option | Why not |
|---|---|
| npm or Yarn workspaces | pnpm has a strict `node_modules` layout (no undeclared dependencies) and blocks install scripts by default |
| Nx, Turborepo | More tooling than the MVP needs. `tsc -b` already builds in dependency order |
| Biome (lint + format) | Fast, but weaker type-aware rules and no simple way to express our boundary rules |
| Jest | Vitest is faster and needs no extra TypeScript transformer. Note for B03: NestJS needs `emitDecoratorMetadata`; Vitest then needs `unplugin-swc` (MIT) |
| eslint-plugin-boundaries, dependency-cruiser | Extra dependency for two rules. Kept as an option (2.5) |

## 4. Consequences

- `pnpm install`, `pnpm build`, `pnpm lint`, `pnpm test` work from a fresh clone.
- New packages must be added to the root `tsconfig.json` references. A test fails if one is missing.
- A new adapter automatically falls under the adapter rule, because its name starts with `@sdlc/adapter-`.

## Version history

| Version | Date | Author | Notes |
|---|---|---|---|
| 0.1 | 2026-09-25 | Claude (task A01) | First version |
| 0.2 | 2026-09-25 | Harry | Accepted with PR #46 |
