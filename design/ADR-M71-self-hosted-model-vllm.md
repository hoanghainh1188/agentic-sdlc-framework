# ADR-M71. A self-hosted model service (vLLM) on the platform server's GPU

| Item | Value |
|---|---|
| Status | **Accepted** (Harry, 2026-10-24, L01 plan: QUESTIONS #546–#550) |
| Date | 2026-10-24 |
| Decided by | Harry (L01 plan approved on 2026-10-24; the separate GPU host split off to L01 PR 2, QUESTIONS #546) |
| Related | D-08 L01 AC1–AC4, L03; D-02 NFR-01; D-03 §10, §10.1; D-07 §3, §4, §9; ADR-M10 §3 (models), ADR-M17 (Compose), ADR-M24 (LiteLLM keys from OpenBao), ADR-M78 (evaluation harness, L02); design/QUESTIONS.md #362, #424, #546–#550 |

## 1. Context

Many clients classify their data as `client_restricted`: it must never leave the company (D-07 §4). The routing rule already exists: a `client_restricted` intent may use `self_hosted` models only (`allowedModels`, the mandatory rule `routing_restricted_self_hosted`). So far the only self-hosted model is Ollama on a developer machine, which is never allowed for client data. A self-hosted model service on company hardware is a condition to sell (QUESTIONS #362).

L02 measured local models on a laptop (D-07 §9): a 20B model resolves about two of three small tasks; a model of about 30B or more did not fit. The company has no GPU yet. This ADR records how the platform runs vLLM (Apache-2.0) when a GPU exists, so that L03 and a rented GPU can measure larger models with the same stack.

## 2. Decision

### 2.1. The Compose profile `models-local` (QUESTIONS #546, #549)

- A service `vllm` in a new, **optional** profile `models-local`, off by default (R041). Image `vllm/vllm-openai:v0.31.0`, pinned by tag and digest (R038). Start: `pnpm compose:models-local` (profiles `core`, `models` and `models-local`).
- **The GPU is in the platform server** (this PR). A separate GPU host is L01 PR 2 (§4).
- The GPU is reserved through `deploy.resources.reservations.devices` (driver `nvidia`, `SDLC_VLLM_GPU_COUNT`, default 1). The same count is vLLM's `--tensor-parallel-size`.
- **Network.** `vllm` is only on a new **internal** network `models` (`<project>-models`; no route to the internet). LiteLLM joins `models` always, so LiteLLM's networks do not depend on the profile (as the api joins `access`, ADR-M67 §2.6). Nothing else is on `models`. `vllm` has **no host port**. So only LiteLLM can call it, and vLLM's own API needs no key (QUESTIONS #546: vLLM's `--api-key` does not cover every route, so the network is the boundary).
- **Health check.** `GET /health` on 127.0.0.1:8000 inside the container, with a start period of 15 minutes (loading the weights takes time).
- **Concurrency limit** (AC1, QUESTIONS #549): two layers with the same value `SDLC_VLLM_MAX_NUM_SEQS` (default 4).
  - vLLM `--max-num-seqs`: the most requests in one batch on the GPU.
  - LiteLLM `max_parallel_requests` on the deployment: LiteLLM refuses a request beyond the limit at once, instead of queueing it at vLLM until the agent's timeout.
- **Other settings** from `.env`, each with a default: `SDLC_VLLM_MAX_MODEL_LEN` (32768, the context length the agents use), `SDLC_VLLM_GPU_MEMORY_UTILIZATION` (0.90), `SDLC_VLLM_TOOL_PARSER` (`qwen3_coder`; tool calls are needed by the coding agents), `SDLC_VLLM_SHM_SIZE` (8gb).
- **Hardening.** All capabilities dropped, `no-new-privileges`. vLLM does not log prompts by default (`--enable-log-requests` is off); the platform never turns it on (R031). Usage statistics are off (`VLLM_NO_USAGE_STATS=1`, `DO_NOT_TRACK=1`).

### 2.2. The model and its weights (QUESTIONS #547)

- The model is a setting, not code: `SDLC_VLLM_MODEL` (a Hugging Face repository) and `SDLC_VLLM_MODEL_REVISION` (a commit hash is recommended; default `main`). The default is `Qwen/Qwen3-Coder-30B-A3B-Instruct` (Apache-2.0): a 30B-class model, the size L02 could not measure. L03 decides which model the company uses.
- `SDLC_VLLM_SERVED_NAME` is the name LiteLLM and the agent register see (`model_ref`). It must carry the model's version (QUESTIONS #93), for example `qwen3-coder-30b-a3b-instruct-2507`.
- **Weights are downloaded once, by an operator**, into the volume `vllm-models`: `pnpm models-local:pull` runs the one-shot service `vllm-pull` (same image, profile `models-local-pull`, on the `sdlc` network, which has internet access). Only public models: no Hugging Face token is stored.
- `vllm` mounts `vllm-models` **read-only** and runs with `HF_HUB_OFFLINE=1`: it never downloads anything, and it cannot change the weights.

### 2.3. The LiteLLM entry (AC2, QUESTIONS #548)

- The provider entry `kv/litellm/providers/vllm` in OpenBao, written by the operator (runbook T11 §5d.1), with two fields that are not secrets: `api_base` (`http://vllm:8000/v1`) and `model` (= `SDLC_VLLM_SERVED_NAME`). The model appears in LiteLLM only when this entry exists, as for every provider (ADR-M24).
- The entry in `litellm/config.ctmpl`: `model_name` = the field `model`, `litellm_params.model` = `hosted_vllm/<model>`, `max_parallel_requests` from the sidecar's `SDLC_VLLM_MAX_NUM_SEQS` (the template fails if it is not a number), and `model_info.provider_type: self_hosted`.
- **Internal cost per token above 0**, so budgets keep working (D-07 §3): USD 0.0000001 per input token and USD 0.0000004 per output token, the same [Proposal] placeholder as the Ollama entry, until L03 gives the GPU cost per token. A static test checks that both are above 0.
- Every call still goes through LiteLLM with the run's virtual key and its seven labels (R027). The routing does not change: G4 gives a `client_restricted` intent only `self_hosted` models (D-07 §4).

### 2.4. Tests (AC4, QUESTIONS #550)

- Static (`pnpm test`): the profile, the pinned image, the GPU reservation, the internal network, no port, the health check, the limits, offline mode and the read-only weights; the template entry (self-hosted, cost above 0, the limit), and the test template equal to it.
- Live, no GPU (`pnpm test:litellm`): the test template has the same `vllm` entry; the provider entry points at the existing stub model, which speaks the same OpenAI-style API as vLLM. The test checks that LiteLLM lists the model as `self_hosted`, that a `client_restricted` intent routes only to it, that a run key with the seven labels calls it, and that the spend is recorded with `provider_type` `self_hosted` and a cost above 0, and that the key's budget stops it.
- Real model, owner only (`pnpm test:agent-api` with `SDLC_AGENT_API_MODEL` and `SDLC_AGENT_API_DATA_CLASS`): the real agent run end to end with the vLLM model (on a GPU) or the Ollama model on a developer machine, for a `client_restricted` intent.
- vLLM itself is not run in CI (no GPU).

## 3. Consequences

- D-03 §10.1 no longer says "API models only, no GPU": the GPU is optional, the profile is off by default, and the server without a GPU runs as before.
- The `.env` of an existing stack needs nothing: every new setting has a default. LiteLLM joins the new network `models` at the next `up`.
- The GPU host needs the NVIDIA driver and the NVIDIA Container Toolkit (deploy README "Self-hosted model").
- The internal cost is a placeholder until L03. The [GPU sizing note](L03-gpu-sizing-note.md) §7 estimates that the real cost per token is probably several times higher at low use; it needs a measurement on a GPU before the template changes.

## 4. Later: a separate GPU host (L01 PR 2, QUESTIONS #546)

vLLM's `--api-key` does not protect every route (vLLM documents that `/invocations` stays open), and LiteLLM v1.104.0 cannot present a client certificate. So a separate GPU host needs mutual TLS between the two machines: on the platform server, a small pinned nginx link on the network `models` (alias `vllm`) calls vLLM on the GPU host with a client certificate from the company CA; vLLM requires it (`--ssl-cert-reqs 2`). The LiteLLM entry does not change. It comes with a live mutual-TLS test.

## 5. Alternatives not chosen

- **Ollama on the server**: made for one user on a desktop; no batching of many requests; vLLM is the serving engine D-07 §3 chose.
- **vLLM downloads the weights at start** (QUESTIONS #547 b): it would need internet access every time it runs next to client data.
- **The internal cost in OpenBao fields** (QUESTIONS #548 b): a cost is not a secret, and a fixed value in the template is checked by a test.
- **Only the vLLM limit** (QUESTIONS #549 b): requests over the limit would wait at vLLM until the agent's own timeout.

## Version history

| Version | Date | Author | Notes |
|---|---|---|---|
| 1.0 | 2026-10-24 | Claude (task L01 PR 1), accepted by Harry in the L01 plan | First version (QUESTIONS #546–#550) |
