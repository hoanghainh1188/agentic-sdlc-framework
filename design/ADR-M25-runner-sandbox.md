# ADR-M25. Runner: sandbox egress, image, workspace, Docker access, clean-up

| Item | Value |
|---|---|
| Status | **Proposed** (task C04, session 1, PR for review) |
| Date | 2026-09-27 |
| Decided by | Harry (C04 plan approved 2026-09-27; QUESTIONS #44, #52, #53, #54, #59) |
| Related | D-02 FR-30, FR-33, FR-34, FR-50; D-03 sections 4, 5.1, 6.5, 7.2, 8, 8.2, 9, 10, 10.1, 13 (version 1.6); D-05 section 6.4; D-08 tasks C04, C05, C06, C08, C09, C11, R01; ADR-M10, ADR-M17, ADR-M19, ADR-M21, ADR-M22, ADR-M23, ADR-M24 |

## 1. Context

Task C04 builds the runner: it receives a Run Contract, creates one sandbox per run, and removes it afterwards. The C01 PoC (ADR-M10) proved the hardening flags and found open points:

- A Docker network works on IP level; it cannot allow "GitHub only" by domain (ADR-M10 §4.3).
- The pinned Agent Server image has no project toolchain, and the sandbox cannot install one (QUESTIONS #59).
- The runner needs the Docker socket, which is root-equivalent on the host (D-03 §13).
- Who holds the GitHub App key, and how the single-repository token reaches the runner (QUESTIONS #44).
- How the worker talks to the runner, and where extra runs wait (D-03 §10.1).

C04 is split into three sessions. Session 1 (this ADR, first version) delivers the Docker layer, the hardening, the egress layout, the slot pool, the run claim and the run event types. Session 2 adds the token handoff, the clone and the full provisioning flow. Session 3 adds the runner image, the Compose profile `sandbox`, restart clean-up and the per-project sandbox image.

## 2. Decision

### 2.1. GitHub is reached by the runner, never by the sandbox (QUESTIONS #52)

- The runner clones the repository before the sandbox starts (session 2). C05/C08 push `agent/INT-…` from the runner, with an explicit refspec, after G5.
- The sandbox holds no GitHub credential at all. It cannot push to `main` (N6 is stronger than branch protection alone), and the kill switch (C11) has one credential fewer to revoke.
- Consequence for C08: D-03 §4, diagram D11 and the D-02 §5 flow show "agent pushes branch". C08 updates them (backlog note, D-08 1.3).

### 2.2. Egress: one internal Docker network per run

D-03 §9 (version 1.6): the sandbox reaches **LiteLLM and the package proxy only**.

- Each run gets its own network `sdlc-run-<run_id>`: bridge, `internal: true`, no IPv6, not attachable. Docker gives an internal network no route out, and its DNS resolves only containers attached to it.
- The sandbox joins that network only.
- The runner attaches exactly the services the contract allows, under their aliases (`litellm`, `npm-proxy`), and detaches them at clean-up.
- Two runs never share a network, so two sandboxes (maybe of two tenants) cannot reach each other.
- The contract's `egress_allowlist` holds `alias:port` entries. The runner maps each entry to a configured service. An entry it cannot enforce (an internet host such as `github.com`, an unknown alias, a wrong port) refuses the run: `provisioning_failed` with reason `egress_not_enforceable`. The runner never opens more than it was asked, and never silently less.
- No firewall rules and no domain-filtering proxy are needed. The same layout works on Docker Desktop (development) and Linux (CI, server).

Tested live (`pnpm test:runner`) from inside a sandbox: LiteLLM and the package proxy are reachable; the following are not: an internet IP, `api.github.com`, `host.docker.internal`, the network gateway (a service on the host), a stub OpenBao on the platform network (by name and alias), the LiteLLM container by its own name, and another run's sandbox (by name and by IP). There is no default route.

### 2.3. Names, labels and the workspace

- Names come from the run ID (a lowercase UUID): container `sdlc-sandbox-<id>`, network `sdlc-run-<id>`, volume `sdlc-ws-<id>`. Labels: `sdlc.managed-by=sdlc-runner`, `sdlc.runner-instance`, `sdlc.run-id`, `sdlc.tenant-id`.
- The workspace is a **per-run Docker volume** mounted at `/workspace`. A tmpfs (ADR-M10) cannot receive an archive before the start.
- The runner uploads the working copy as a tar archive into the created (not yet started) container, through the Docker archive API with `copyUIDGID`. Every entry belongs to the sandbox user 10001. The runner's own tar writer fixes owners, modes and times, so nothing from the runner's host leaks into the archive.
- **Image contract:** the project image must own `/workspace` as `10001:10001`. Docker copies that owner into the run's empty volume when the sandbox is created; the archive cannot change the owner of the volume root (found in the live test). The session 3 images do this in their Dockerfile.
- Creation order: volume → network → attach services → container → archive → start. A failure at any step removes everything created so far.

### 2.4. Sandbox hardening

Built by one function (`buildSandboxSpec`), from ADR-M10 §2.4:

| Setting | Value |
|---|---|
| Image | Project image pinned by digest (§2.9) |
| User | `10001:10001` |
| Root filesystem | Read-only |
| tmpfs | `/tmp` (`exec`, needed by the Agent Server), `/home/openhands` (`noexec`); `nosuid,nodev`, size from settings |
| Capabilities | All dropped; `no-new-privileges` (so `sudo` in the image cannot work) |
| Limits | Memory (swap = memory, so no extra swap), CPUs, processes: runner settings. Defaults 2 GiB, 1.5 CPUs, 512 |
| Mounts | The run's workspace volume only. No bind mount, no Docker socket |
| Ports | None published |
| Restart | Never; `init` process on |
| Environment | Allowlist: `SESSION_API_KEY` and `OH_SECRET_KEY` (random per run), fixed Agent Server flags, `NPM_CONFIG_REGISTRY` |

The sandbox never receives a provider key, the LiteLLM master key, an OpenBao address or token, or a GitHub token (FR-33, FR-50, §2.1). The only model credential is the run's LiteLLM virtual key, which C05 passes to the Agent Server through its API.

### 2.5. The runner's Docker access (D-03 §13)

- Own client on `node:http` over the Unix socket, no dependencies (like ADR-M21, ADR-M23). API version 1.44 (Docker Engine 25 or later).
- **Endpoint allowlist:** ping, image inspect/pull, containers (list, create, inspect, start, wait, logs, archive upload, remove), networks (list, create, inspect, connect, disconnect, remove), volumes (list, create, remove). No exec, build, commit, swarm, plugins or system calls. Anything else is refused before it reaches the socket.
- **Guard:** every container and network definition is checked again just before the socket, as an allowlist of keys. Refused: any unknown option (so `Privileged`, `Binds`, `PidMode`, `CapAdd`, `Devices`, `PortBindings`… can never slip through), a bind mount, a second mount, a writable root, kept capabilities, extra swap, a missing limit, a restart policy, an image without digest, a user other than 10001, an environment variable outside the allowlist, a command override, and a network that is not the run's own internal network.
- Errors never contain Docker's own text (it can echo request data); only the method, the status code or a Node error code.
- **Session 3:** in Compose the runner reaches Docker through **docker-socket-proxy** (Tecnativa, Apache-2.0, pinned), which allows only the container, network, volume and image endpoint groups.
- **Residual risk:** whoever controls the runner process can still ask Docker for a privileged container; the guard and the proxy limit mistakes, not a compromised runner. On the internal server the runner should run in a separate VM or with rootless Docker (D-03 §10.1). This belongs to A10 (infrastructure operator).

### 2.6. Settings

Deployment settings come from the environment (`SDLC_RUNNER_*`), not from the project configuration: they describe the Docker host. They choose sizes and reachable services; nothing can loosen §2.4.

| Setting | Default | Notes |
|---|---|---|
| `SDLC_RUNNER_DOCKER_SOCKET` | `/var/run/docker.sock` | Absolute path; in Compose the socket proxy |
| `SDLC_RUNNER_INSTANCE` | `sdlc` | Label value; separates runner deployments on one Docker host |
| `SDLC_RUNNER_MAX_SANDBOXES` | `1` | 1–16. D-03 §10.1: 1–2 on the internal server |
| `SDLC_RUNNER_SANDBOX_MEMORY_MB`, `_CPUS`, `_PIDS`, `_TMP_MB` | 2048, 1.5, 512, 512 | ADR-M10 §2.5 |
| `SDLC_RUNNER_EGRESS_SERVICES` | none | `alias=container:port,…`, for example `litellm=sdlc-litellm-1:4000,npm-proxy=sdlc-npm-proxy-1:4873` |
| `SDLC_RUNNER_NPM_REGISTRY` | none | For example `http://npm-proxy:4873/`; its host and port must be an egress service |

### 2.7. Worker ↔ runner, and where extra runs wait (QUESTIONS #53)

- The runner is a Temporal worker on the task queue `sdlc-runner`. One long-running activity per run sends heartbeats while the sandbox lives (session 3 wiring, with B07/C06).
- The limit is the activity slot count of that worker (`maxConcurrentActivityTaskExecutions` = `SDLC_RUNNER_MAX_SANDBOXES`), so extra runs wait in Temporal, as D-03 §10.1 says.
- Inside the process, a **slot pool** (FIFO) is the backstop: at most `SDLC_RUNNER_MAX_SANDBOXES` sandboxes exist at once, and a failing run always frees its slot.
- A contract can expire while its run waits (15 minutes by default). The runner refuses it (`expired`, ADR-M22); the workflow then sets that run to `cancelled` with `contract_expired` and issues a new attempt (C06).

### 2.8. Claim, clean-up, run events

- **Claim (QUESTIONS #35):** after the contract is verified, the runner moves the run `queued → provisioning` with one conditional update (`RunRepository.claimForProvisioning`) and checks the row count. Zero rows → no sandbox. Tested with concurrent claims on PostgreSQL: exactly one wins.
- **Clean-up (`teardownSandbox`):** remove the container, detach the shared services, remove the network, remove the workspace volume. Idempotent (objects already gone are skipped), every step runs even when one fails, and the first error is reported at the end. Used after success and failure (session 2), and for orphans (session 3).
- **Restart (session 3):** at start, the runner removes every object with its instance label. Runs still in `provisioning` or `running` become `failed` with `runner_restarted`; their outputs are lost. A periodic sweep removes objects of runs already in a final state.
- **Run events** (coded payloads only, ADR-M22 §2.5): `workspace_prepared {base_sha, duration_ms}`, `sandbox_created {image_sha256}`, `sandbox_ready {duration_ms}`, `provisioning_failed {reason}`, `sandbox_removed {reason, duration_ms}`. Reasons are codes: `egress_not_enforceable`, `image_unavailable`, `docker_error`; `finished`, `failed`, `provisioning_failed`, `killed`, `orphan`.

### 2.9. Sandbox image per project (QUESTIONS #59 option A, #54)

- Project configuration `sandbox.image`: a reference **pinned by digest** (`[registry/]name[:tag]@sha256:<64 hex>`); a tag alone is refused. Default: the pinned Agent Server base of ADR-M10 §2.1 (no project toolchain). The default `config_hash` changes.
- Images are built on the pinned Agent Server base plus the project toolchain. Dockerfiles live in `platform/sandbox-images/<toolchain>/` (session 3, first: Node 24 and pnpm for the sample repo). CI builds them and scans them with Trivy for vulnerabilities and licences, with the same rules as ADR-M10 §2.1.
- **Registry for the MVP (QUESTIONS #54):** a local registry on the server, `registry:2` (distribution, Apache-2.0, pinned by digest), or a build on the server. Images are always referenced by digest. GHCR is not used for now: private packages on GitHub Free have a small free storage quota, and the ~860 MB Agent Server image would likely exceed it. **GHCR is the option after the GitHub Team upgrade.**
- The runner pulls a missing image by digest and refuses to start when the pull fails (`image_unavailable`).

### 2.10. Package proxy (QUESTIONS #59 option C)

- **Verdaccio** (MIT), pinned by digest, as the Compose service `npm-proxy` in a new profile `sandbox` (session 3). Its only uplink is registry.npmjs.org; publishing is disabled; packages are cached in a volume. It sits on the platform network (for its uplink) and is attached to each run's network by the runner.
- The sandbox gets `NPM_CONFIG_REGISTRY` from the runner settings; pnpm reads it. Installs should use the lockfile (`pnpm install --frozen-lockfile`) so the proxy serves only reviewed versions.
- Later, only when a project needs them: PyPI through **devpi-server** (MIT), Maven through **Reposilite** (Apache-2.0). Each is one more egress service.

### 2.11. The GitHub token (QUESTIONS #44, session 2)

- The worker issues the single-repository installation token (`GitHostAdapter.issueShortLivedToken`, ADR-M23) and hands it to the runner as an **OpenBao response-wrapped token**: single use, time to live equal to the contract validity. Only the wrapping token travels with the envelope (Temporal keeps activity inputs in its history, so a raw token would be stored in PostgreSQL).
- The runner unwraps it once and keeps the token in memory only. If someone else unwrapped it first, the unwrap fails and the runner refuses the run.
- The token reaches git through `GIT_CONFIG_*` environment variables of the git process (an `http.extraHeader`), never through process arguments, `.git/config` or the sandbox.
- `runner.hcl` loses `kv/data/shared/github-app`; `worker.hcl` gets `sys/wrapping/wrap`; `@sdlc/secrets` gets `wrap` and `unwrap`.

## 3. Rules and where they live

| Rule | Source | Where |
|---|---|---|
| No provider key, no OpenBao access, no GitHub token in the sandbox | FR-33, FR-50, QUESTIONS #52 | Code: environment allowlist, network layout, guard. Never configurable |
| Branch `agent/INT-…`; never push to the default branch | FR-30, CLAUDE.md | Code: contract schema (ADR-M22), runner refspec (C08) |
| Sandbox egress: LiteLLM and the package proxy | D-03 §9 v1.6 | Runner setting `SDLC_RUNNER_EGRESS_SERVICES`; enforced by the network layout |
| Concurrent sandboxes, default 1 | D-03 §10.1 | Runner setting `SDLC_RUNNER_MAX_SANDBOXES` |
| Sandbox image | QUESTIONS #59 | Project configuration `sandbox.image`, digest required |
| Resource limits, package proxy address | Deployment | Runner settings |
| Contract validity and clock skew | QUESTIONS #33 | Project configuration `run.*` (ADR-M22) |

C04 adds no handbook threshold. Budget, iteration and loop limits belong to C05 and C11 and are already configuration.

## 4. Alternatives not chosen

| Option | Why not |
|---|---|
| Sandbox pushes to GitHub through an egress proxy with a domain allowlist (Envoy, Squid, Smokescreen) | One more service to run; the agent would hold a write token; Squid is GPL. Not needed once the runner pushes (QUESTIONS #52) |
| One shared sandbox network with inter-container traffic off | LiteLLM and the proxy must be reachable on the same bridge, so traffic cannot be off; runs of two tenants would share a network |
| iptables rules in `DOCKER-USER` | Differ between Docker Desktop and Linux; hard to test on a developer machine |
| tmpfs workspace (ADR-M10) | The Docker archive API cannot write into a tmpfs before the start |
| Clone inside a helper container | That container would need GitHub egress, which the per-run network does not have |
| `dockerode` (Apache-2.0) | A dependency for about fifteen endpoints; less control over errors and the endpoint allowlist |
| GHCR for sandbox images now | Storage quota on GitHub Free (QUESTIONS #54). The option after the GitHub Team upgrade |
| One platform image with every toolchain (QUESTIONS #59 option B) | Larger, not fitted to each project |

## 5. Consequences

- D-03 version 1.6: §9 sandbox network, §8 `egress_allowlist` example, §8.2 the runner no longer reads the GitHub App key, §10 new containers of the profile `sandbox`, a note on the §4 flow. D-08 version 1.3: C04 AC1 and a C08 note.
- The Run Contract's `egress_allowlist` now names services as `alias:port` (for example `litellm:4000`, `npm-proxy:4873`). C06 fills it from the deployment settings.
- C05 attaches the runner to the run's network to call the Agent Server (the runner runs in Compose from session 3), and passes the virtual key through the Agent Server API.
- C11 kills a run with `teardownSandbox` plus the key and token revocation.
- A10: separate VM or rootless Docker for the runner on the server.

## Version history

| Version | Date | Author | Notes |
|---|---|---|---|
| 0.1 | 2026-09-27 | Claude (task C04, session 1) | First version |
