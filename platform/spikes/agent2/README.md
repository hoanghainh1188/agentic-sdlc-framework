# Spike X01: a second, open-source coding agent (Aider, OpenCode)

This is a **spike**, not product code. It is thrown away after X01. The result is
[`design/ADR-M68-second-agent-spike.md`](../../../design/ADR-M68-second-agent-spike.md).
Nothing in `platform/apps`, `platform/packages` or `platform/eval` imports it, and it changes none
of them: it imports their code read-only.

The repository holds the scripts, the image definitions and the numbers only. Raw results, Trivy
reports and diffs stay in `$X01_OUT`, outside the repository.

## What it contains

| File | Purpose |
|---|---|
| `images/aider/` | Aider 0.86.2 on the `node24` sandbox image: a pinned CPython 3.12 (uv), a venv resolved at build time from `requirements.in` with a fixed cut-off date and hashes (the lock is not committed: the repository's Trivy scan would block on the findings Aider pins), and `supervisor.mjs`, a small HTTP server on port 8000 that starts, watches and stops Aider (the runner's Docker client has no `exec`) |
| `images/opencode/` | OpenCode 1.18.35 on the `node24` sandbox image: the npm platform binary checked against its sha512 integrity, Debian's ripgrep, `entry.sh` (`opencode serve` on port 8000, the run's `SESSION_API_KEY` as the server password), `opencode.json` |
| `build.sh` | Builds both images FROM `node24` by digest; prints both references by digest |
| `src/opencode-adapter.ts`, `src/aider-adapter.ts`, `src/common.ts` | `AgentAdapter` for each agent. They reuse the OpenHands adapter's task message, git commands and loop keys |
| `agent2.spike.ts` | The driver. It uses the platform's own code: `startAgentRun` → `createSandbox` (the guard, the run network, egress `litellm` and `npm-proxy` only), `driveAgent` (caps, interrupt, loop watch, commit, changes step), the Cost Controller's capped virtual key with the seven labels, and the eval scoring container (`LocalExecutor`) |
| `run.sh` | Starts a throw-away PostgreSQL and runs the driver with `vitest.config.mjs` (never picked up by `pnpm test` or the integration suites) |
| `scan.sh` | Trivy 0.74.0 (the CI's version) on `node24` and both images: vulnerabilities (HIGH, CRITICAL) and licences |
| `summarise.mjs` | Writes `results/` from `$X01_OUT` and the `pnpm eval` folder of the OpenHands baseline |
| `results/` | The numbers (JSON): codes and counts only. No prompt, diff or key |

## Run it

Needs Docker, Node.js 24, and Ollama on the host with `gpt-oss:20b` (never a `:cloud` model). No
secret is involved. Do not run it while the platform's dev stack must keep running: it competes for
memory (Ollama takes about 12.5 GiB).

```bash
platform/sandbox-images/build.sh node24 --no-push          # prints the node24 reference
NODE24=<node24 by digest> platform/spikes/agent2/build.sh   # prints aider=… and opencode=…
export X01_IMAGE_NODE24=<…> X01_IMAGE_AIDER=<…> X01_IMAGE_OPENCODE=<…> X01_OUT="$HOME/.cache/x01-agent2/out"
X01_MODE=checks platform/spikes/agent2/run.sh               # AC1
X01_MODE=compare X01_N=2 platform/spikes/agent2/run.sh      # AC2
pnpm eval --out "$HOME/.cache/x01-agent2/eval" --configurations gpt-oss-20b --tasks feat-sku-rule,bug-order-number --n 2
platform/spikes/agent2/scan.sh                              # AC3
node platform/spikes/agent2/summarise.mjs "$X01_OUT" "$HOME/.cache/x01-agent2/eval"
pnpm exec tsc -p platform/spikes/agent2                     # type check
```
