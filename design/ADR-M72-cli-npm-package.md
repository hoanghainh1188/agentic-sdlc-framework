# ADR-M72. The CLI on npm: one bundled file, published from a tag with provenance

| Item | Value |
|---|---|
| Status | **Proposed** (task V05) |
| Date | 2026-10-10 |
| Decided by | Harry (V05 plan approved 2026-10-10; QUESTIONS #365–#367 answered in the proposal) |
| Related | D-08 task V05; QUESTIONS #357, #364, #365–#367; ADR-M16 (monorepo tooling); ADR-M36 (the CLI's API client); `platform/USER-GUIDE.md` §2; task V12 (the release process) |

## 1. Context

Until v0.1.0 the `sdlc` command ran only from a checkout of this repository, after `pnpm install && pnpm build` (USER-GUIDE §2). A community trial team or a reviewer who only needs the CLI should not have to clone the platform, install pnpm and compile every package. QUESTIONS #357 chose npm, under the free name `agentic-sdlc-cli`, published from a release tag with provenance.

The CLI (`@sdlc/cli`, private) depends on four workspace packages (`@sdlc/api-schemas`, `@sdlc/contracts`, `@sdlc/core`, `@sdlc/messages`), and through `@sdlc/core` on `@sdlc/config`, `kysely`, `pg`, `yaml` and `zod`. The workspace packages are not published, and publishing them would make five public packages to version and support.

## 2. Decision

### 2.1 One bundled file

`pnpm cli:pack` (`platform/tools/cli-package/build.mjs`) compiles the CLI (`tsc -b`) and bundles `dist/main.js` with every package it uses into **one CommonJS file**, `bin/sdlc.cjs`, with **Rolldown** (MIT, pinned exactly). The published package has no dependencies.

- **Rolldown, not esbuild or tsup:** it is already in the lockfile (Vite 8 uses it), so the choice adds no new package to the supply chain. esbuild stays the fallback if Rolldown's output ever breaks the CLI.
- **CommonJS:** the CLI and the workspace packages compile to CommonJS today; the bundle keeps that, so `require` calls of `pg` and Node's built-in modules need no shim.
- **No source map, no minifying:** a source map would hold the build machine's paths; an unminified bundle stays readable for anyone who audits it. The region comments hold paths relative to the repository only.
- `pg-native` and `pg-cloudflare` stay out: `pg` loads them only inside guarded `require` calls, and the CLI never needs them.
- `@sdlc/config` reads its shipped defaults from `<__dirname>/../defaults/project-config.default.yaml`. The bundle lives in `bin/` and the file is copied to `defaults/`, so the same path works in the package without a code change.
- **The `ops …` commands are included** (QUESTIONS #366): the package is the same CLI as a checkout. The operator commands still need the server and `SDLC_DB_URL`; they bring `pg` and `kysely` (most of the size: about 3 MB unpacked, 0.6 MB packed).
- The build refuses a root `package.json` version that differs from `PLATFORM_VERSION`, and any bundled package whose licence is not MIT, ISC, Apache-2.0, BSD-2-Clause, BSD-3-Clause or 0BSD (D-02 NFR-04). It writes `THIRD-PARTY-NOTICES` with every bundled package's name, version, licence and licence text.

### 2.2 What the package holds

Exactly: `bin/sdlc.cjs`, `defaults/project-config.default.yaml`, `THIRD-PARTY-NOTICES`, `LICENSE`, `README.md` (`platform/apps/cli/npm/README.md`) and `package.json` (from `platform/apps/cli/npm/package.template.json`, with the release version). The template is not named `package.json`, so it is never a workspace package.

`pnpm cli:pack-check` (`platform/tools/cli-package/check.mjs`) runs on every pull request (CI job `checks`) and before every publish:

1. `npm pack --dry-run`: the file list must equal the list above;
2. no packed file may hold the checkout's absolute path, a `/Users/…` or `/home/…` path, a `sourceMappingURL`, an API token (`sdlc_pat_…`) or a private key;
3. the tarball is installed with `npm install -g --prefix` into an empty temporary folder, run from there with an empty home folder: `sdlc --version` must print the version, `sdlc` alone must print the usage text and exit 2.

### 2.3 Published only from a tag, with trusted publishing

`.github/workflows/npm-publish.yml` runs only on a pushed tag `v*`, which a person makes. It runs in the GitHub environment `npm` (Harry as required reviewer), checks that the tag equals `v<package.json version>`, runs `pnpm cli:pack-check`, keeps the checked tarball as an artifact, and runs `npm publish --provenance --access public` from the built folder.

npm **trusted publishing** (OpenID Connect, `id-token: write`) proves the workflow to npm: no npm token lives in the repository or in its secrets, and every version carries npm provenance (which commit and workflow built it). `actions/setup-node` gets no `registry-url`, so no `.npmrc` expects a token.

**The first version** (QUESTIONS #365): npm lets a package's owner add a trusted publisher only to a package that exists. So the first version is published once by Harry, by hand, from the tarball the tag workflow checked and kept (2FA, no provenance for that version); then Harry adds the trusted publisher (repository `hoanghainh1188/agentic-sdlc-framework`, workflow `npm-publish.yml`, environment `npm`) and sets "Require two-factor authentication and disallow tokens". Every later version goes through the workflow. The steps are in `platform/GETTING-STARTED.md`, "Publishing the CLI on npm".

Task V12 may fold this job into the release workflow; V04 (images on GHCR) has its own job.

## 3. Consequences

- `npm install -g agentic-sdlc-cli` gives `sdlc` on Node.js 24 without a checkout (USER-GUIDE §2). `pnpm sdlc` from a checkout stays for developers and operators.
- `sdlc --version` (and `-V`) prints `PLATFORM_VERSION` in both.
- Each release that changes the CLI or a package it bundles publishes a new npm version; the version follows the platform's release (QUESTIONS #364), even when the CLI did not change.
- A dependency update reaches npm users only with the next release.
- The package is public: the pack check and Gitleaks (CI `scan`) are the guards against shipping anything private.

## 4. Alternatives not taken

- **Publish every workspace package** (`@sdlc/core`…): five public packages to support, and the `@sdlc` scope may not be free on npm.
- **A single executable (Node SEA) or a container image:** larger downloads, one per platform; npm is what Node.js users expect.
- **A long-lived npm token in the repository secrets:** a stolen token could publish anything at any time; trusted publishing has no secret to steal.

## Version history

| Version | Date | Author | Notes |
|---|---|---|---|
| 0.1 | 2026-10-10 | Claude (task V05) | First version |
