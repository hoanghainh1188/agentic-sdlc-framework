# Spike C01: control the OpenHands Agent Server from Node.js

This is a **spike**, not product code. It may be thrown away. The result is
[`design/ADR-M10-openhands-agent-server.md`](../../../design/ADR-M10-openhands-agent-server.md).
Nothing in `platform/apps` or `platform/packages` may import it (a test checks this).

## What it contains

| File | Purpose |
|---|---|
| `src/agent-server-client.ts` | REST client: start, status, interrupt, events, git changes, bash |
| `src/litellm-admin.ts` | Per-run LiteLLM virtual key: create, info, delete, spend logs |
| `src/sandbox.ts` | `docker run` arguments with hardening, relay, inspect, stats, listening ports |
| `src/poc-run.ts` | One run from key to clean-up; loop check and time cap while polling |
| `src/loop-detector.ts`, `src/status-map.ts` | FR-35 check; Agent Server status → D-05 `run_status` |
| `src/stub-model.ts`, `src/stub-script.ts` | Scripted OpenAI-compatible model, so no provider key is needed |
| `src/tcp-relay.ts` | Forwards 127.0.0.1 to a sandbox on the internal network |
| `compose.poc.yaml`, `litellm.poc.yaml` | Spike override for the core stack: model list, stub model, internal network |

## Run the live PoC

Unit tests run in `pnpm test`. The live test needs Docker and is skipped unless `SDLC_OPENHANDS_POC=1`.

1. Start the core stack: `pnpm compose:env` (once), then `pnpm compose:core`.
2. Optional real-model run: add `POC_ANTHROPIC_API_KEY=<key>` to `platform/deploy/.env`. The file
   is Git-ignored. The key goes to LiteLLM only, never to the sandbox.
3. Start the spike override (LiteLLM with the spike model list, the stub model, the internal
   network `sdlc-poc-sandbox`):

   ```bash
   docker compose -f platform/deploy/docker-compose.yml -f platform/spikes/openhands/compose.poc.yaml --env-file platform/deploy/.env --profile core --profile poc up -d --wait litellm poc-stub-model
   ```

4. Pull the pinned image once (about 860 MB compressed, 3 GB on disk):

   ```bash
   docker pull ghcr.io/openhands/agent-server:1.48.0-python-slim@sha256:8fcfab2dedb4b41b6aef219b9fa9b1f2588033fad3d998ae6aa11fe8c4fcf8b7
   ```

5. Run the live test. It writes a JSON report (default: `c01-poc-report.json` in the OS temp
   directory, or `SDLC_POC_REPORT`). `SDLC_DEPLOY_ENV_FILE` points at another `.env` if needed.

   ```bash
   SDLC_OPENHANDS_POC=1 pnpm exec vitest run platform/spikes/openhands/test/poc.live.test.ts
   ```

6. Restore the product LiteLLM configuration: `pnpm compose:core`. Remove the stub model with
   `docker rm -f sdlc-poc-stub-model-1`.

The real-model run is **deferred** until a company API key exists (ADR-M10 §3, QUESTIONS.md #15); it
must pass before C05 is done. It is capped at USD 1.00 by the virtual key budget, and it sends only the fixture
workspace (a README and one new file) to the model.
