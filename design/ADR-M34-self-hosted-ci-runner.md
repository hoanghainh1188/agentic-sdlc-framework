# ADR-M34. Self-hosted runner for the platform CI

| Item | Value |
|---|---|
| Status | **Proposed** (PR for review) |
| Date | 2026-09-28 |
| Decided by | Harry (2026-09-28: a dedicated VM, all `ci` jobs, ADR number M34) |
| Related | D-08 task A09 (CI), A10 (internal server); D-03 §10.1 (modest internal server); ADR-M25 §2.5 (a separate VM or rootless Docker for the runner's Docker Engine); QUESTIONS #123 (the pilot repository is public); runbook `platform/deploy/ci-runner/README.md` |

## 1. Context

The `harryforge` organization is on GitHub Free: 2,000 Actions minutes per month for all private repositories. It used them all in September 2026, and every private workflow was blocked. A first change cut the `ci` workflow's minutes by about 45 % (one `scan` job, no run on a push to `main`, gated heavy jobs). At the pace of late September that is still not enough.

Jobs on a self-hosted runner use no GitHub Actions minutes. The CI needs Docker: the database, Compose, runner and sandbox image jobs start throw-away containers, networks and Compose projects.

The internal server is not ready yet (A10 waits for an infrastructure operator).

## 2. Decision

### 2.1. A dedicated VM for all `ci` jobs

- One self-hosted runner on a **dedicated** Ubuntu 24.04 x86_64 VM (4 vCPU, 8 GB, 40 GB). The VM runs CI only: no platform service, no OpenBao, no client data, no secret.
- The VM can reach the internet (GitHub, Docker Hub, npm, scanner databases) and **nothing** on the internal network. The runner opens no port; it polls GitHub.
- The repository variable `CI_RUNNER` chooses the runner for every `ci` job (`runs-on: ${{ vars.CI_RUNNER || 'ubuntu-24.04' }}`). Not set means GitHub-hosted, which is also the way back when the VM is down. The value `sdlc-ci` is the runner's custom label.
- `render-diagrams.yml` stays on GitHub-hosted runners: its token can push to pull request branches, and it uses few minutes.
- One runner, so the jobs of a run execute one after the other. Two runners on one VM would clash on the fixed host ports of the live tests (for example ports +20000).

### 2.2. Trust boundary: the VM

- The runner runs as `ghrunner`, a user without sudo but in the `docker` group. Control of Docker is root on the VM. We do not try to hide this: **the VM is the boundary**.
- Not chosen: rootless Docker. The live tests probe sandbox hardening (internal networks, capabilities, resource limits) as on the target server; rootless Docker changes some of that behaviour. ADR-M25 §2.5 accepts a separate VM instead.
- Who can run code there: only people who can push a branch to this private repository (members of the organization). They can already change the code that CI tests.
- What a compromised job could reach: the VM itself, and the internet. It gets the job's `GITHUB_TOKEN` (read-only contents, valid for the job only). It gets no other credential, because the VM holds none.
- The runner is registered on **this repository only**. An organization-level runner could serve the public repository `pilot-order-inventory` (QUESTIONS #123), where anyone can open a pull request. GitHub Free does not let us limit the default runner group to chosen repositories.

### 2.3. A persistent runner with clean-up hooks, not an ephemeral runner

- Not chosen now: `--ephemeral` (a fresh runner for every job). Each new registration needs a registration token. Minting one automatically means a long-lived GitHub credential (a PAT or a GitHub App key with runner administration) stored on the VM, which is the machine that runs untrusted pull request code.
- Instead, one persistent runner and hooks (`ACTIONS_RUNNER_HOOK_JOB_STARTED` / `_COMPLETED`):
  - before and after every job: remove every container, network and volume, and give the workspace back to `ghrunner` (containers that bind-mount it can leave root-owned files);
  - before a job: fail the job when Docker is down; prune images and build cache when less than 10 GiB is free.
- Images and the build cache stay between jobs, to limit Docker Hub pulls (anonymous rate limit). A daily systemd timer removes them (02:00 JST, before the scheduled CI runs).
- What remains possible: a job can leave files outside the workspace, or re-tag a cached image, and so affect a later job. Mitigations: the monthly rebuild from a snapshot (runbook step 6); Compose images pinned by exact version (digests later, ADR-M17); the VM holds nothing worth stealing.

### 2.4. Installation and tokens

- `platform/deploy/ci-runner/setup.sh` (`install`, `register`, `remove`, `status`): Docker from Docker's signed apt repository (the signing key fingerprint is checked), the runner at a pinned version with its SHA-256 checked, the hooks and the prune timer. The runner then updates itself, as GitHub requires.
- Registration and removal tokens are created by an admin in their own terminal and pasted into the script (hidden input). They are never written to a file, never passed through a chat tool, and expire after one hour.

## 3. Risks

| Risk | Mitigation |
|---|---|
| A pull request compromises the VM | Dedicated VM, no secrets, no route to the internal network, monthly rebuild; only organization members can push branches |
| The VM is down: jobs wait in the queue | Delete `CI_RUNNER`: every job goes back to GitHub-hosted runners at once |
| A job leaves state that changes a later result | Clean-up hooks, daily prune, monthly rebuild |
| The self-hosted environment differs from the hosted image | `setup.sh` installs what `ci.yml` and the test scripts use (Docker with buildx and compose, `jq`, `openssl`, `git`, `zstd`); first full run checked by hand (runbook step 4) |
| One runner makes a full run slower (about 15 minutes) | Accepted; a second VM later if needed |
| Docker Hub rate limit | Images kept between jobs; pulls counted per VM IP |

## 4. Consequences

- Actions minutes for `ci` drop to about zero while `CI_RUNNER` is set. `render-diagrams` and GitHub-hosted fallbacks still use minutes.
- The VM operator follows the runbook `platform/deploy/ci-runner/README.md`.
- When the internal server exists (A10), the runner VM can move to it as a separate VM, with the same rules (§2.1, §2.2).
- Later: ephemeral runners with a just-in-time configuration minted outside the VM, if a place for that credential exists.

## Version history

| Version | Date | Author | Notes |
|---|---|---|---|
| 0.1 | 2026-09-28 | Claude | First version |
