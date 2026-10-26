# ADR-M94. The release on the tag

| Item | Value |
|---|---|
| Status | **Accepted** (Harry, 2026-10-26, QUESTIONS #591–#595); built by task V15 |
| Date | 2026-10-26 |
| Decided by | Harry (QUESTIONS #591–#595, answered 2026-10-26: all five proposals as written) |
| Related | D-08 V04 AC3, V12 AC2, V15, O02; ADR-M66 (images on GHCR; this ADR replaces its §2.5); ADR-M72 §2.3 (npm, trusted publishing); QUESTIONS #370, #390 (replaced), #585 (the upgrade test); `RELEASING.md`; R040, R089 |

## 1. Context

Until v0.6.0 the images of a release are built **before** the tag (QUESTIONS #370, option A), so the tagged commit holds the digests of its own images in `platform/deploy/images.lock` (ADR-M66 §2.5). The price is a long release: seven steps, two of them extra pull requests (the version pull request, then the lock file pull request after `release-images` on `main`), and two waits for CI.

QUESTIONS #591 asks whether a release can start from the tag alone (option B of #370). The questions #592–#594 answer what option B leaves open: where a release checkout finds its digests, what happens when a build fails after the tag, and how npm starts. Harry accepted all five proposals on 2026-10-26.

## 2. Decision

### 2.1 The owner's steps

| Step | Who | What |
|---|---|---|
| 1. Version pull request | Claude, merged by the owner | As today: `package.json`, `PLATFORM_VERSION`, the CHANGELOG section with its Upgrade notes. CI also builds and scans every image of the release on it (§2.5) |
| 1b. The upgrade test | Owner | As today (QUESTIONS #585): Actions → **ci** → Run workflow on the version pull request's branch, job `upgrade` |
| 2. The tag | Owner | `git tag vX.Y.Z <merge commit of step 1> && git push origin vX.Y.Z` |
| 3. npm | Owner | Approve the environment `npm` when `release.yml` is green |
| 4. Check | Owner | The GitHub Release with its asset `images.lock`; `npm view agentic-sdlc-cli version`; on a clean checkout of the tag `pnpm images mode` prints `published` |

The lock file pull request, `pnpm release:lock` and the separate run of `release-images` on `main` are gone. A person still makes every tag and approves every npm publish (R040).

### 2.2 `release.yml` on the tag

Jobs, in order. Each job has only the permissions it needs.

1. **check** (`contents: read`): the release gate `release-check.mjs tag vX.Y.Z` (the tag equals `package.json` and `PLATFORM_VERSION`; the CHANGELOG section with non-empty Upgrade notes). It no longer reads a lock file. The job also checks that the tagged commit is on `main`, and that the repository has **immutable releases** turned on (§2.4).
2. **images**: calls `release-images.yml` (`workflow_call`) with `version: X.Y.Z` and `push: true`. The job grants what the called workflow needs: `packages: write`, `id-token: write`, `attestations: write`. `release-images.yml` builds and scans **all six images on both architectures before the first push** (§2.5), then pushes by digest, scans each pushed digest again from GHCR, joins, tags, signs and attests, as ADR-M66 §2.3–§2.4 describe. Its job `lock` writes the artifact `images-lock-X.Y.Z`, as today.
3. **verify-images** (`packages: read`, `attestations: read`): reads the artifact and runs `verify-images.sh` on its six digests. The signer it accepts is now `release-images.yml` at the exact tag (§2.6).
4. **release** (`contents: write`): creates the GitHub Release from the CHANGELOG section as a **draft**, uploads `images.lock` to it, then publishes it. An immutable release can get no asset after it is published, so the asset goes on first. A published Release for the tag is never changed: the job fails. A draft left by a failed run is deleted and made again (a draft is not public and not immutable).
5. **npm** (`actions: write` only): `gh workflow run npm-publish.yml --ref vX.Y.Z` (§2.3).

A tag or a Release created with `GITHUB_TOKEN` starts no other workflow, but `workflow_dispatch` is the documented exception. That is why npm is started by step 5 and not by `on: release`.

### 2.3 `npm-publish.yml`

- Keeps its file name and the environment `npm`: npm's trusted publisher names both (ADR-M72 §2.3). The trusted publisher on npmjs.com is not registered again.
- Its trigger becomes `workflow_dispatch` (no inputs). The ref of the run is the tag. The tag push no longer starts it.
- Job `verify-images` (read only, before the environment) refuses a ref that is not `refs/tags/vX.Y.Z`, and a tag that has no **published** GitHub Release. It downloads the Release's `images.lock`, runs the release gate, and runs `verify-images.sh` on that file's digests.
- Job `publish` waits for it and for the owner's approval of the environment `npm`, as today. It builds, checks and publishes the package with provenance.
- The owner can also start it by hand (Actions → npm-publish → Run workflow, on the tag). The same checks apply.

Two facts are checked on the first release made this way, and the result is written in `RELEASING.md` §3:

- The environment `npm` (deployment rule: tags `v*` only) accepts a run dispatched on the tag. The rule is checked against the run's ref, which is `refs/tags/vX.Y.Z`.
- npm trusted publishing accepts the dispatched run. npm checks the repository, the workflow file name and the environment, which do not change. Its documentation warns only about a workflow that is called by another one (`workflow_call`): there npm checks the caller's name. `npm-publish.yml` is dispatched, never called, so npm sees its own name.

If npm refuses the run, nothing is published. The owner publishes that version by hand from the tarball the run checked and kept (the way of version 0.1.1, ADR-M72 §2.3), and a question goes to `design/QUESTIONS.md`.

### 2.4 The lock file is a release asset

- The file format does not change: `SDLC_IMAGES_VERSION` and six `SDLC_IMAGE_<NAME>=ghcr.io/hoanghainh1188/agentic-sdlc-framework/<image>@sha256:…` lines.
- The owner turns on **GitHub immutable releases** for the repository once (`RELEASING.md` §4). Then a published Release, its tag and its assets can never change, and GitHub adds a release attestation. So the asset `images.lock` of a release is as fixed as a file in the tagged commit was.
- `platform/deploy/scripts/images.sh` finds the lock file of a **release checkout** (HEAD exactly at the tag `v<package.json version>`, no change to a tracked file):
  1. the file named by `SDLC_IMAGES_LOCK`, when it is set (for a server without access to `github.com`);
  2. otherwise `platform/deploy/.images/vX.Y.Z.lock` (ignored by Git), downloaded once over HTTPS from `https://github.com/hoanghainh1188/agentic-sdlc-framework/releases/download/vX.Y.Z/images.lock`. The repository is public: no token. The script writes the file only when the download is complete.
- Every lock file it reads must be complete: the version equals the tag, six digests, the one registry path. A file that is not complete is refused.
- On a release checkout, a download that fails stops `up.sh` and `pnpm trial:up` with an error. The error names `SDLC_IMAGES_LOCK` and `SDLC_IMAGES=local`. It never silently builds the images locally, because a build of all images takes a long time and hides the problem.
- Outside a release checkout nothing changes: the images are built locally. `SDLC_IMAGES=published|local` still overrides the choice. A source archive uses `SDLC_IMAGES=published` and then downloads the lock file like a release checkout.
- Optional: `pnpm images verify` runs `verify-images.sh` on the lock file when `cosign` and `gh` are installed.
- Removed: the tracked `platform/deploy/images.lock`, `platform/tools/release/lock.mjs`, `pnpm release:lock` and the lock file check of `release-check.mjs`. The static test of the lock file becomes a test of the check in `images.sh`.
- **Older tags** (v0.6.0 and before) keep their own scripts and their tracked lock file, so a checkout of them works as before. The upgrade test (O02) checks out the last release tag with that tag's own scripts, so it works for both kinds of tag.

### 2.5 When a build or a scan fails

1. The version pull request (a change of the root `package.json` version) runs `release-images.yml` with `push: false` from `ci.yml`: every image is built and scanned on both architectures, and nothing is pushed. Most failures appear there, before the tag.
2. On the tag, `release-images.yml` builds and scans all six images on both architectures before the first push. No image of the release is pushed until all twelve build-and-scan jobs have passed. The pushed digest is scanned again from GHCR, as today (ADR-M66 §2.3).
3. A failure **before any push**: nothing was released. The owner deletes the tag, fixes the cause in a pull request and tags again. The tag ruleset's bypass (`RELEASING.md` §3, §4) now needs three things: no GitHub Release, no npm version and no image of that version on GHCR.
4. A failure **after a push**: release the next patch version. A version already on GHCR is refused (tags never move).
5. A failure after the job `images` succeeded (a network error in `verify-images`, `release` or `npm`): re-run the failed jobs. The images are not built again.

### 2.6 The signer

`verify-images.sh` takes the expected tag. It accepts only a cosign certificate and a build provenance attestation whose signer is exactly `https://github.com/hoanghainh1188/agentic-sdlc-framework/.github/workflows/release-images.yml@refs/tags/vX.Y.Z`, with the GitHub OIDC issuer. A called workflow signs with its own identity at the caller's ref, so the identity names `release-images.yml` at the tag, not `release.yml` and not `main`. The deploy README's "Verify the published images" gives the new command. Images of v0.6.0 and before keep their old signer, `@refs/heads/main`, and the README keeps that command for them.

### 2.7 Documents and rules that change (in V15)

- `RELEASING.md` 2.0: §2 with the steps of §2.1, §3 with §2.5, §4 with immutable releases and the new bypass condition.
- `platform/deploy/README.md`: a release checkout downloads its lock file once, or uses `SDLC_IMAGES_LOCK`; the verify command.
- `CLAUDE.md`: the "Commands" line "Releases" (no `pnpm release:lock`, no lock file pull request). R089: "never edit `images.lock` by hand" becomes "the lock file is a release asset, never edited or replaced". `design/RULES.md` follows.
- ADR-M66 §2.5 and ADR-M72 §2.3 point to this ADR. D-08: V15 changes V04 AC3 and V12 AC2.
- The Upgrade notes of the first release made this way: a release checkout needs access to `github.com` once, or `SDLC_IMAGES_LOCK`.

## 3. Consequences

- A release takes three actions of the owner and one pull request instead of seven steps and two pull requests.
- The tagged commit no longer holds its digests. A release checkout needs `github.com` once (or `SDLC_IMAGES_LOCK`). The digests are as fixed as before, because the release is immutable.
- The images are built from the tagged commit itself. Before, they were built from the commit before the lock file pull request.
- A failure after the tag costs the tag (before any push) or a patch version (after a push). The `push: false` run on the version pull request makes this rare.
- Every version pull request runs twelve build-and-scan jobs once more. They run only when the version changes.
- `release.yml` holds `packages: write`, `id-token: write` and `attestations: write`, but only in the job that calls `release-images.yml`.

## 4. Alternatives not chosen

- **Keep option A** (QUESTIONS #370): a long release with two extra pull requests, the reason for this ADR.
- **Pull the image tags `:X.Y.Z` instead of digests:** a tag on GHCR can be moved by the package owner (R038).
- **The npm job inside `release.yml`:** the trusted publisher would have to be registered again (ADR-M72), and npm would check the name `release.yml` for a job in a called workflow.
- **`npm-publish.yml` on `release: published`:** a Release created with `GITHUB_TOKEN` starts no workflow.
- **A personal access token or a GitHub App token to start the workflows:** a long-lived secret in a public repository's settings; `workflow_dispatch` needs none.
- **The lock file committed back to `main` by the workflow:** a commit by a workflow on the protected branch, after the tag, that no person reviewed.

## Version history

| Version | Date | Author | Notes |
|---|---|---|---|
| 1.0 | 2026-10-26 | Claude, accepted by Harry (QUESTIONS #591–#595) | First version |
