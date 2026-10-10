# Releasing

How the platform is versioned and released (D-08 task V12, QUESTIONS #364, #370, #390). A release, a tag, an image push and an npm publish are public actions: **only the owner (Harry) starts them**. Claude prepares the pull requests and never pushes a tag, creates a release or runs a workflow with `push: true`.

## 1. Versioning policy

| Rule | What it means |
|---|---|
| [Semantic Versioning](https://semver.org/) `X.Y.Z` | One version for the whole repository: the root `package.json`, `PLATFORM_VERSION` (`platform/apps/cli/src/version.ts`), the images on GHCR and the npm package `agentic-sdlc-cli` |
| Before v1.0 | A **minor** release (`0.2.0`) may break things: a migration, a changed setting, a credentials command to run again. Its "Upgrade notes" say exactly what to do. A **patch** release (`0.1.2`) never needs an upgrade step |
| A patch release `v0.1.x` | When something useful lands and nothing must be done to upgrade (for example v0.1.1: the CLI on npm and `sdlc next`) |
| The next minor `v0.2.0` | When the milestone UX is done, or as soon as a change needs an upgrade step |
| v1.0 | When the platform runs on a team server (milestone Server). From then on only a major release breaks things |
| Support | **The latest release only.** A fix, also a security fix, comes in a new release; older releases get no patches |
| Security advisories | Reported privately ([SECURITY.md](SECURITY.md)); published as a GitHub Security Advisory together with the release that fixes it |
| Tags never move | A tag `vX.Y.Z`, its GitHub Release, its image tags on GHCR and its npm version are never changed or reused. A broken release is fixed by a new one (npm: `npm deprecate`, never unpublish) |

### Upgrade notes

Every CHANGELOG release section from 0.1.1 on has a `### Upgrade notes` list (a test checks it; 0.1.0, the first release, had nothing to upgrade from). It answers, for a running stack:

- the database migrations (`pnpm db:migrate`), or "no migration";
- the credentials commands to run again (`pnpm openbao:bootstrap …-credentials`);
- new, changed or removed settings (`SDLC_*`, project configuration);
- images to pull or rebuild, and the `sdlc` command to update (`npm install -g agentic-sdlc-cli@X.Y.Z`).

"No migration, no changed setting, no credentials command to run again." is a valid list.

## 2. How a release is made

The images are built **before** the tag (QUESTIONS #370), so the tag holds the digests of its own images.

| Step | Who | What |
|---|---|---|
| 1. Version pull request | Claude, merged by the owner | `package.json` and `PLATFORM_VERSION` set to `X.Y.Z`; the CHANGELOG's `[Unreleased]` becomes `## [X.Y.Z] - YYYY-MM-DD` with a short summary and its Upgrade notes; CLAUDE.md "Current constraints" if the state changes |
| 2. The images | 🧑 owner | Actions → **release-images** → Run workflow on `main`, version `X.Y.Z`, `push: true`. Builds, scans, pushes by digest, signs and attests the five images, and writes the artifact `images-lock-X.Y.Z` |
| 3. The lock file pull request | Claude, merged by the owner | `pnpm release:lock <run-id>` copies that run's `images.lock` over `platform/deploy/images.lock`; it refuses a run that is not a successful `release-images` run on `main` or a lock file for another version |
| 4. The tag | 🧑 owner | Tag **the merge commit of step 3** and push it: `git tag vX.Y.Z <commit> && git push origin vX.Y.Z` |
| 5. The release | `release.yml` | Runs the release gate, checks that the commit is on `main`, verifies every image's cosign signature and build provenance attestation (signer: `release-images.yml` on `main`), then creates the GitHub Release from the CHANGELOG section |
| 6. npm | `npm-publish.yml`, 🧑 owner approves | Runs the same release gate, builds and checks the package, waits for the owner's approval of the environment `npm`, publishes with provenance |
| 7. Check | 🧑 owner | The GitHub Release exists; `npm view agentic-sdlc-cli version` shows `X.Y.Z`; on a clean checkout of the tag `pnpm images mode` prints `published` |

The release gate is `platform/tools/release/release-check.mjs`. Both tag workflows run it; it refuses the tag when:

- the tag is not `vX.Y.Z`, or differs from `package.json` or `PLATFORM_VERSION`;
- the CHANGELOG has no `## [X.Y.Z] - YYYY-MM-DD` section, or its Upgrade notes are missing or empty;
- `platform/deploy/images.lock` is for another version, or does not pin all five images by digest on `ghcr.io/hoanghainh1188/agentic-sdlc-framework`.

Try it before you tag: `node platform/tools/release/release-check.mjs tag vX.Y.Z` on the commit you will tag.

## 3. When something fails

| Problem | What to do |
|---|---|
| `release-images` fails (a scan, a push) | Fix it in a pull request and run step 2 again. A version already on GHCR is refused: delete its packages' version on purpose first, or take the next patch version |
| `release.yml` refuses the tag | Nothing was released. Delete the tag (`git push origin :refs/tags/vX.Y.Z`; only before any release or npm publish of it), fix the cause in a pull request, tag again |
| `release.yml` fails after a check passed (a network error) | Re-run the failed jobs. An existing GitHub Release is never changed: a release made by hand stays |
| `npm-publish` fails | Fix the cause, then re-run the workflow. A version is never published twice |
| A released version is broken | Release the fix as the next patch version; `npm deprecate agentic-sdlc-cli@X.Y.Z "<reason>"` |

## 4. Repository settings (owner, once)

- The environment `npm` with the owner as required reviewer, tags `v*` only (GETTING-STARTED, "Publishing the CLI on npm").
- A **tag ruleset** for `v*`: only the owner may create tags; nobody may update or delete them.
- The five GHCR packages are public.
- Never rename `npm-publish.yml` or the environment `npm`: npm's trusted publisher names both (ADR-M72 §2.3).

## Version history

| Version | Date | Author | Notes |
|---|---|---|---|
| 1.0 | 2026-10-10 | Claude (task V12), approved by Harry | First version: the versioning policy, the release steps, `release.yml`, the release gate, `pnpm release:lock` |
