# ADR-M99. The repository's name: `governed-adlc-fw`

| Item | Value |
|---|---|
| Status | **Accepted** |
| Date | 2026-10-29 |
| Decided by | Harry (QUESTIONS #626, 2026-10-29) |
| Related | `design/POSITIONING.md` §2; ADR-M66 (images on GHCR), ADR-M72 (the CLI on npm), ADR-M94 (the release on the tag); `RELEASING.md`; rule R089 |

## 1. Context

The repository was called `agentic-sdlc-framework`. The name says what the framework is about (AI agents in the software lifecycle), but not what it offers. `design/POSITIONING.md` §2 says the framework offers **control and evidence when AI writes code**, not "AI writes code". Harry chose a name that says this.

The name is also part of the release chain:

- The images are published at `ghcr.io/hoanghainh1188/<repository>/<image>` (ADR-M66).
- `verify-images.sh` accepts only a cosign certificate whose signer is `https://github.com/hoanghainh1188/<repository>/.github/workflows/release-images.yml@refs/tags/vX.Y.Z`, and a build provenance attestation of that repository (ADR-M94 §2.6).
- npm's trusted publisher of `agentic-sdlc-cli` names the repository and the workflow `npm-publish.yml` (ADR-M72 §2.3).

## 2. Decision

1. The repository becomes **`hoanghainh1188/governed-adlc-fw`**. ADLC: the AI development lifecycle; "governed": every change passes gates, people approve, the record cannot be altered.
2. **Order.** v0.8.0 is released first, under the old name: its tagged commit checks the old signer. The rename pull request is merged after v0.8.0 is published, and the owner renames the repository on GitHub right after the merge. GitHub forwards the old web and git URLs.
3. **Images.** From the next release, the images are published at `ghcr.io/hoanghainh1188/governed-adlc-fw/<image>`. `release-images.yml`, `images.sh`, `release-check.mjs` and `verify-images.sh` use the new name. The images of v0.1.0–v0.8.0 stay where they are, under the old name.
4. **Old releases need nothing extra.** A checkout of a tag runs that tag's own `images.sh` and `verify-images.sh`, with the old path and the old signer; `pnpm test:upgrade` uses the old release's scripts the same way. So the scripts on `main` check only the new name.
5. **npm.** The package keeps the name `agentic-sdlc-cli`, so `npm install -g agentic-sdlc-cli@X.Y.Z` stays the same. Its page points to the new repository. The owner changes the repository of its trusted publisher on npmjs.com before the next npm publish.
6. **History stays as written.** The accepted ADRs (M66, M72, M94), `design/QUESTIONS.md` and the CHANGELOG sections of past releases keep the old name, because they describe what was true then. This ADR replaces the repository name in ADR-M66 §2.1, §2.4 and §2.5, ADR-M72 §2.3 and ADR-M94 §2.4 and §2.6 from the next release on. Current documents and code use the new name.

## 3. Consequences

- Owner's steps, once: merge the rename pull request; rename the repository on GitHub; change the trusted publisher on npmjs.com; after the first release with the new name, set the six new GHCR packages to public (a new package starts private, `RELEASING.md` §4).
- A clone with the old URL keeps working through GitHub's redirect; `git remote set-url origin git@github.com:hoanghainh1188/governed-adlc-fw.git` removes the redirect.
- The local folder of an existing checkout keeps its name until its owner renames it.
- The default server path in the examples becomes `/opt/governed-adlc-fw`. No server uses the old path yet (task A10 PR 3 is not done).

## Version history

| Version | Date | Author | Notes |
|---|---|---|---|
| 1.0 | 2026-10-29 | Claude, approved by Harry | The new name, the order with v0.8.0, the image path and the npm name (QUESTIONS #626) |
