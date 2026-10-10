# ADR-M66. The platform's images on GHCR for each release

| Item | Value |
|---|---|
| Status | **Proposed** (task V04) |
| Date | 2026-10-10 |
| Decided by | Harry (V04 plan approved 2026-10-10: images built before the tag, amd64 and arm64, the registry path below; QUESTIONS #370, #371) |
| Related | D-08 tasks V04, V12, O02; QUESTIONS #54, #342, #355, #364, #370, #371; D-03 §10 (version 1.39); ADR-M10 §2.1 (licences), ADR-M25 §2.9 (sandbox images), A09 (`ci.yml`, Trivy); `platform/deploy/README.md` "Verify the published images" |

## 1. Context

Until v0.1.0 every platform image is built on the user's machine: `sdlc-api`, `sdlc-worker`, `sdlc-runner` and `sdlc-otel-collector` by Compose, the sandbox image `node24` by `pnpm sandbox-image:build` into a local registry (QUESTIONS #54: "no GHCR for now"). For the community trial this is slow (the sandbox image alone takes many minutes), needs the whole toolchain, and nobody can check that the image they run is the one the project scanned. QUESTIONS #342 and #355 put the images on GHCR after v0.1.0, in the milestone UX.

## 2. Decision

### 2.1 Registry and names

`ghcr.io/hoanghainh1188/agentic-sdlc-framework/<image>`, five images: `sdlc-api`, `sdlc-worker`, `sdlc-runner`, `sdlc-otel-collector`, `sandbox-node24`. The path under the repository links each package to it (`org.opencontainers.image.source` is set too). GHCR is free for public packages and needs no secret: the workflow logs in with `GITHUB_TOKEN`.

Tags: the version (`0.2.0`) and `sha-<12 characters of the commit>`. **A version tag never moves**: the workflow refuses a version that is already on GHCR. Every consumer uses the **digest**, never a tag (as for every other image of the platform).

### 2.2 Architectures: amd64 and arm64, built natively (QUESTIONS #371)

Many trial users run Docker Desktop on Apple Silicon. Every base image is published for both (OpenHands `agent-server:1.48.0-python-slim`, `node:24.13.0-bookworm-slim`, the OpenTelemetry Collector, busybox; checked 2026-10-10). Each architecture builds on its own runner (`ubuntu-24.04`, `ubuntu-24.04-arm`, free for public repositories): no QEMU emulation, whose `pnpm install` and image size would take most of the 40-minute job limit. One multi-arch index joins the two.

### 2.3 The workflow: scan before the push

`.github/workflows/release-images.yml`, `workflow_dispatch` (a person) and `workflow_call` (V12's release workflow), inputs `version` (must equal the root `package.json`) and `push` (default `false`). Separate from `ci.yml` and from V05's npm job.

1. **check**: the version and, for a push, the ref (`main`, or the tag `v<version>` when V12 calls it).
2. **build** (10 jobs: 5 images × 2 architectures): build into the runner's Docker Engine; **Trivy** scans it with the version and thresholds of `ci.yml` (`HIGH` reported, `CRITICAL` blocks; the sandbox image also blocks the CRITICAL licence category, ADR-M10 §2.1). Only then, with `push: true`, the same build again with the same builder pushes the image **by digest** (no tag). Every layer comes from the cache of the scanned build; only the attestations are added. Nothing unscanned reaches GHCR.
3. **publish** (`push: true`): join the two digests in one index with its tags, sign it, attest it (§2.4).
4. **lock** (`push: true`): write `images.lock.env` (§2.5) as an artifact and in the job summary.

`push: false` builds and scans everything and pushes nothing: the way to test the workflow. Permissions: `contents: read` everywhere; `packages: write` only in build and publish; `id-token: write` and `attestations: write` only in publish. Actions pinned by commit SHA; tools checked by SHA-256.

### 2.4 Signature, SBOM and provenance

- **Signature**: cosign keyless (Sigstore: a short-lived certificate from Fulcio for the workflow's GitHub OIDC identity, recorded in the public Rekor log). No key to keep, rotate or leak. The certificate names the workflow file `release-images.yml` (also when V12 calls it: a reusable workflow signs with its own identity), so `cosign verify --certificate-identity-regexp '^https://github\.com/hoanghainh1188/agentic-sdlc-framework/\.github/workflows/release-images\.yml@' --certificate-oidc-issuer https://token.actions.githubusercontent.com` accepts no other signer.
- **SBOM**: BuildKit's SPDX JSON, attached to each image in the index (`sbom: true`).
- **Provenance**: BuildKit's SLSA provenance (`provenance: mode=max`; the build has no secret and no secret build argument), and a GitHub build provenance attestation (`actions/attest-build-provenance`, pushed to the registry), checked with `gh attestation verify`.

### 2.5 How Compose chooses: the lock file and the release checkout (QUESTIONS #370)

The images of a release are **built before its tag** (option A):

1. The release pull request sets the version (`package.json`, `PLATFORM_VERSION`) and is merged to `main`.
2. Harry runs `release-images` on `main` with `push: true`.
3. A second small pull request copies the workflow's `images.lock.env` over `platform/deploy/images.lock.env`.
4. Harry tags its merge commit `v<version>`.

So the tag holds the digests of its own images. The images were built from the commit before (the lock file is the only difference), which their provenance names. V12 automates this order: its release workflow calls this one before the tag, not on it (V12 AC2 follows this decision).

- `platform/deploy/images.lock.env`: `SDLC_IMAGES_VERSION` and `SDLC_IMAGE_<NAME>` = `ghcr.io/…/<image>@sha256:…` for the five images. Empty until the first release with published images. A static test refuses a partial file, another registry, a tag instead of a digest, or a version ahead of `package.json`.
- `platform/deploy/docker-compose.images.yml`: an overlay that gives the four services Compose builds their published image and removes their `build` (`!reset`, Compose v2.24+, already a requirement).
- `platform/deploy/scripts/images.sh mode` prints `published` only for a **release checkout** with a complete lock file. A release checkout is HEAD exactly at the tag `v$SDLC_IMAGES_VERSION` with no change to a tracked file, or a source archive (no `.git`) whose `package.json` has that version. Everywhere else (`main`, a branch, a changed file) the images are built locally, so a developer always runs the code they have. `SDLC_IMAGES=published|local` overrides it.
- `scripts/up.sh` adds the overlay and the lock entries in the published mode; `pnpm trial:up` takes the sandbox image from the lock file (`images.sh get SANDBOX_NODE24`) instead of building it. The runner pulls it by digest through the socket proxy's `images/create`, as before.
- The local registry of the profile `sandbox` and `pnpm sandbox-image:build` stay: for a project's own sandbox images, and for every checkout that is not a release. This replaces QUESTIONS #54 for release images only.

### 2.6 What the scan changed in the images

The first scan (2026-10-10) found CRITICAL findings in `node:24.13.0-bookworm-slim`: Debian packages with fixes (GnuTLS, Perl) and npm's own `tar`. The runtime stage of `sdlc-api`, `sdlc-worker` and `sdlc-runner` now runs `apt-get upgrade` and removes npm, npx and corepack (the processes run `node` only). One finding has no fix: CVE-2023-45853 (zlib1g, "will not fix" in Debian 12; the flaw is in minizip, which Debian ships apart and no image installs), listed in `.trivyignore` with its reason, for Person B's approval in the V04 pull request. The collector and the sandbox image had no new finding.

## 3. Consequences

- A trial on a release checkout downloads the images (some hundreds of MB, the sandbox image the largest) instead of building them, and can verify them.
- `apt-get upgrade` makes an image depend on the day it was built; a release's images are fixed by digest, so only local builds differ.
- GHCR packages may start **private**: after the first push Harry sets each of the five to public (package settings) once; until then a release checkout fails at the pull with an authentication error.
- An image whose scan fails is never pushed; a release with a new unfixed CRITICAL finding needs a fix or a reviewed ignore entry before it can be published.
- The images run the Debian and Node.js of the release day; a later security fix means a new release (support = the latest release, QUESTIONS #364).
- Deploying a release needs the machine's Docker Engine to reach `ghcr.io` (already in the README's network table).

## 4. Alternatives not chosen

- **Images built on the tag, digests as a release asset (option B):** the tag could not hold its own digests; a release checkout would need a download step and a check of that file.
- **Docker Hub:** a separate account and token; GHCR needs no secret.
- **QEMU for arm64:** one runner, but several times slower for `pnpm install` and the sandbox image.
- **A long-lived cosign key in a repository secret:** a key to keep and rotate, and a secret in a public repository's settings; keyless binds the signature to the workflow.
- **Push by digest, then scan from the registry:** a failed scan would leave an unscanned, untagged image on GHCR.
- **Tags in Compose (`:0.2.0`):** a tag can be moved by the owner; a digest cannot.

## 5. Open items

- V12: the tag-driven release workflow calls this one before the tag (§2.5) and writes the lock file pull request.
- O02 (Server): the upgrade test between two releases uses the published images.
- After the first real push: Harry sets the five packages to public and runs `cosign verify` once from a clean machine.
