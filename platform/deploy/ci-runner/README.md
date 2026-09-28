# Self-hosted CI runner (runbook)

The CI of this repository (`.github/workflows/ci.yml`) can run on our own VM instead of GitHub-hosted runners. Jobs on a self-hosted runner use no GitHub Actions minutes. Decision and risks: [ADR-M34](../../../design/ADR-M34-self-hosted-ci-runner.md).

- The repository variable `CI_RUNNER` chooses the runner for every `ci` job. Not set: GitHub-hosted `ubuntu-24.04`. Set to `sdlc-ci`: this runner.
- `render-diagrams.yml` stays on GitHub-hosted runners: it has a token that can push to pull request branches.
- Who does it: an **organization admin** of `harryforge` (steps 2, 4, 7) and the **VM operator** (steps 1, 3, 5, 6). One person can do both.

## 1. Prepare the VM

| Item | Requirement |
|---|---|
| Operating system | Ubuntu 24.04 LTS, x86_64 |
| Size | 4 vCPU, 8 GB RAM, 40 GB disk (one job at a time) |
| Use | **CI only.** No platform service, no OpenBao, no client data, no other secret |
| Outbound network | HTTPS to the internet: GitHub, Docker Hub, npm, the Semgrep and Trivy registries, `download.docker.com` |
| Internal network | **No route** to the internal server, OpenBao or any client network (firewall rule on the host or hypervisor) |
| Inbound | SSH for the operator only. The runner opens no port: it polls GitHub |
| Snapshot | Take one right after step 3; rebuild from it every month (step 6) |

Why so strict: every pull request runs its own code on this VM, with Docker. Docker control means root on the VM. The VM is the boundary.

## 2. Install

On the VM, from a copy of this directory (for example `scp -r platform/deploy/ci-runner <vm>:`):

```bash
sudo bash ci-runner/setup.sh install
```

This installs Docker from Docker's signed apt repository (the signing key fingerprint is checked), creates the user `ghrunner` (in the `docker` group, no sudo), downloads the runner (pinned version, SHA-256 checked), and installs the job hooks and the daily prune timer. Running it again is safe.

## 3. Register the runner

1. **Organization admin, in your own terminal** (never through a chat tool): create a registration token. It is valid for 1 hour.

   ```bash
   gh api -X POST repos/harryforge/agentic-sdlc-framework/actions/runners/registration-token --jq .token
   ```

2. **On the VM**: paste the token when asked (the input is hidden).

   ```bash
   sudo bash ci-runner/setup.sh register
   ```

   The runner is registered on **this repository only**, with the label `sdlc-ci`, and runs as the systemd service `actions.runner.*`. Never register it for the organization: an organization runner can serve the public repository `pilot-order-inventory`, where anyone can open a pull request.

3. Check that it is online:

   ```bash
   gh api repos/harryforge/agentic-sdlc-framework/actions/runners --jq '.runners[] | [.name, .status, (.labels | map(.name) | join(","))] | @tsv'
   ```

## 4. Switch CI to the runner

Organization admin (or repository admin):

```bash
gh variable set CI_RUNNER --body sdlc-ci --repo harryforge/agentic-sdlc-framework
```

Then start one full run and watch it:

```bash
gh workflow run ci --repo harryforge/agentic-sdlc-framework --ref main
```

Every `ci` job must show the runner's name. The jobs run one after the other (one runner), so a full run takes about 15 minutes.

**Go back** to GitHub-hosted runners at any time, for example while the VM is down (jobs would otherwise wait in the queue):

```bash
gh variable delete CI_RUNNER --repo harryforge/agentic-sdlc-framework
```

## 5. Operate

| What | How |
|---|---|
| State | `sudo bash ci-runner/setup.sh status` |
| Runner logs | `journalctl -u 'actions.runner.*' --since today` and `~ghrunner/actions-runner/_diag/` |
| Clean-up between jobs | Automatic: the hooks remove every container, network and volume before and after each job, and give the workspace back to `ghrunner` |
| Images and build cache | Kept between jobs (fewer Docker Hub pulls); removed daily at 02:00 JST (`sdlc-ci-prune.timer`), or before a job when less than 10 GiB is free |
| Runner updates | The runner updates itself. The version in `setup.sh` is only the first install |
| OS updates | `unattended-upgrades` (security updates); reboot when `/var/run/reboot-required` exists, outside working hours |
| Jobs wait in "Queued" | The runner is offline: `status`, then `sudo systemctl restart 'actions.runner.*'`. If it stays down, delete `CI_RUNNER` (step 4) |

## 6. Monthly rebuild

The runner keeps its files between jobs. A job could leave something behind that the hooks do not remove. Once a month (and after any suspicious run):

1. Delete `CI_RUNNER` (step 4).
2. Remove the runner (step 7), restore the VM from the step 3 snapshot, or install a new VM (steps 1–3).
3. Set `CI_RUNNER` again.

## 7. Remove the runner

1. Organization admin, in your own terminal: delete `CI_RUNNER` (step 4) and create a removal token:

   ```bash
   gh api -X POST repos/harryforge/agentic-sdlc-framework/actions/runners/remove-token --jq .token
   ```

2. On the VM: `sudo bash ci-runner/setup.sh remove` and paste the token.

If the VM is already gone, remove the runner in GitHub: repository **Settings → Actions → Runners**.
