# ADR-M104. A simpler release: merge, then approve npm

| Item | Value |
|---|---|
| Status | **Accepted**, version 1.1 |
| Date | 2026-10-31 |
| Decided by | Harry (the three changes approved on 2026-10-31; QUESTIONS #651–#653; 1.1: no `npm` approval, QUESTIONS #654) |
| Related | ADR-M94 (the release on the tag), ADR-M72 (the CLI on npm), O02 (the upgrade test); `RELEASING.md` 3.0; rules R040, R089, R090, R146 |

## 1. Context

Since ADR-M94 a release took five steps from the owner:

1. merge the version pull request that Claude prepared;
2. start the upgrade test by hand on its branch, and wait for it;
3. tag the merge commit and push the tag;
4. approve the environment `npm`;
5. check the result.

Harry's other project, komagu, uses release-please. A release there is one merge and one npm approval. Harry asked for the same here.

release-please writes the CHANGELOG from conventional commits. This repository has a different CHANGELOG: every release section has handwritten **Upgrade notes** (R090). The release gate checks them, and the upgrade test runs the `openbao:bootstrap` commands of their first bullet. The tag also has to stay what ADR-M94 needs:

- `release.yml` runs on `refs/tags/vX.Y.Z`, so that the image signer is `release-images.yml` at that tag;
- a tag never moves;
- immutable releases;
- the environment `npm`.

## 2. Decision

1. **The upgrade test runs by itself on the version pull request** (QUESTIONS #651). CI's job `upgrade` runs when the pull request changes the root `package.json` version (the scan job's `release_version`, the same condition as `release-images`), not only on the weekly and manual runs. The version pull request tests its own upgrade before the merge.
2. **`release-tag.yml` makes the tag** (QUESTIONS #652). It runs on every push to `main`, one run at a time, and calls `platform/tools/release/tag-release.mjs`. The script decides from the state of the repository (the version in `package.json`, the tags `vX.Y.Z`, the runs of `release.yml`), never from the last commit alone:
   - **The version has no tag.** It must be above every tag (a lower version is refused, never released). The release gate runs (`release-check.mjs tag`). The tag `refs/tags/vX.Y.Z` is created through the API (never `git push`) at **the commit that set the version**, found in the history of `package.json`. Then `release.yml` is dispatched on the tag.
   - **The version has a tag, but no run of `release.yml` on it.** The release is dispatched. A run that failed after the tag is therefore fixed by running it again.
   - **Otherwise** nothing happens.

   Deciding from the state matters for two cases. GitHub keeps one pending run per concurrency group and cancels the older pending ones, so the run of the version merge may never happen. A push may also carry several commits. In both cases a later run still tags the version, at its own commit.

   A tag made with `GITHUB_TOKEN` starts no workflow, but a `workflow_dispatch` may; `npm-publish.yml` is already started this way.
   - `release.yml` gains the `workflow_dispatch` trigger. Its first step after the checkout refuses any ref that is not `refs/tags/v*`. Run on the tag, the signer stays `release-images.yml@refs/tags/vX.Y.Z` (ADR-M94 §2.6, `verify-images.sh` unchanged).
   - The tag ruleset `v*` keeps "Restrict updates", "Restrict deletions" and "Block force pushes" and drops **"Restrict creations"** (the owner's setting, `RELEASING.md` §4): a personal repository cannot list GitHub Actions as a bypass actor (Harry, 2026-10-31). A tag still never moves and is never deleted. Who can create a tag: people with write access (today only the owner) and the two jobs with `contents: write`. Before anyone else gets write access, "Restrict creations" goes back on, or a GitHub App of the owner's becomes the bypass actor. The job needs `contents: write` and `actions: write`, in that job only. The workflow test lists it as the second job allowed to write contents.
   - The owner's merge is the release decision. R040 still holds: Claude never tags; the tag follows Harry's merge.
3. **The version pull request is mechanical** (QUESTIONS #653). Each pull request that needs an upgrade step writes its bullet under `[Unreleased]` → `### Upgrade notes` when it is made, while its author knows the step (R146). `pnpm release:prepare X.Y.Z [--tasks …] [--summary …]` refuses without those notes and changes nothing then. Otherwise it:
   - sets `package.json` and `PLATFORM_VERSION`;
   - turns `[Unreleased]` into the dated section and leaves an empty `[Unreleased]`;
   - moves the version in the README, TRIAL and USER-GUIDE;
   - marks the tasks done in `scripts/generate-backlog.py` and runs it;
   - runs the release gate.

   The `CLAUDE.md` state line and a milestone's text stay words a person writes; the script says so. release-please is not used: it cannot write Upgrade notes, and its own CHANGELOG would fight R090 and the upgrade test.

4. **No approval of `npm`** (version 1.1, QUESTIONS #654, Harry, 2026-10-31). The environment `npm` keeps its name and its rule "tags `v*` only", because npm's trusted publisher names the environment (R089). It loses its required reviewer. GitHub lets no workflow approve its own deployment, so "automatic" means no reviewer, which is the owner's setting (`RELEASING.md` §4).
   - **The owner's one decision** is the merge of the version pull request. After it, these run with no person: the release gate, the tag, the images (built, scanned, signed and attested), the immutable Release, the image check in `npm-publish.yml`, then `npm publish`.
   - **What is given up:** a last look before an npm version, which can never be unpublished, only deprecated. A broken release is then fixed by the next patch version (`RELEASING.md` §3).

## 3. Consequences

- The owner's steps: **merge** the version pull request once CI (with `release-images` and `upgrade`) is green, then check the result. Once: turn "Restrict creations" off in the tag ruleset, and remove the required reviewer of the environment `npm`.
- A version pull request runs two long jobs (the image scan and the upgrade test, up to 40 minutes each), as before, but without the manual step.
- If `release-tag.yml` fails before the tag (the gate, a ruleset that still restricts creation), nothing is tagged: re-run it, or the owner tags by hand as before (`RELEASING.md` §2, step 2b, §3). If it fails after the tag, re-running it starts the release. A tag pushed by hand starts `release.yml` itself, and the workflow then finds its run and does nothing.
- A merge that changes the version without a CHANGELOG section is refused by the gate before any tag.
- Tests: `platform/tests/workspace/ci-workflow.test.ts` (the upgrade job's trigger, the second contents writer), `release.test.ts` (`release.yml` on a dispatch refuses a branch; `release-tag.yml` and `tag-release.mjs`: the gate before the tag, the API, the dispatch, no push, no token on disk), `tag-release.test.ts` (the decision from the state, the commit that set the version), `release-prepare.test.ts` (the script on a copy of the files).

## 4. Rejected

- **release-please** (komagu): see §2.3.
- **A personal access token** for the tag (komagu's `RELEASE_PLEASE_TOKEN`): a long-lived secret in the repository settings, when a dispatch with `GITHUB_TOKEN` starts `release.yml` on the tag.
- **Running `release.yml` on the push to `main`:** the images would be signed on `refs/heads/main`, not on the tag, and `verify-images.sh` checks the tag.
- **A workflow that approves the `npm` deployment itself:** GitHub does not let a workflow token approve a deployment, and a personal token for that would be a long-lived secret. Removing the reviewer does the same, openly (§2.4).

## Version history

| Version | Date | Author | Notes |
|---|---|---|---|
| 1.0 | 2026-10-31 | Claude, approved by Harry | The upgrade test on the version pull request, `release-tag.yml`, `pnpm release:prepare` and Upgrade notes by each pull request (QUESTIONS #651–#653) |
| 1.1 | 2026-10-31 | Claude, approved by Harry | §2.2: the tag ruleset drops "Restrict creations" instead of a GitHub Actions bypass (not offered on a personal repository); §2.4: no approval of `npm`; the environment keeps its name and its tag rule, without a reviewer (QUESTIONS #654) |
