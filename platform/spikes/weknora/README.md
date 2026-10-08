# Spike K01: WeKnora on the pilot's documents

This is a **spike**, not product code. It may be thrown away. The result is
[`design/ADR-M59-weknora-spike.md`](../../../design/ADR-M59-weknora-spike.md).
Nothing in `platform/apps` or `platform/packages` may import it.

The repository holds scripts, the question set and the numbers only. The documents, WeKnora's own
configuration, the secrets, the chunks and the packet captures stay in `$K01_STATE_DIR`
(default `$TMPDIR/k01-weknora`), outside the repository.

## What it contains

| File | Purpose |
|---|---|
| `compose.spike.yaml` | Throw-away Compose project `k01-weknora`: WeKnora v0.8.2 (app, docreader), PostgreSQL with pgvector, Qdrant, Valkey, LiteLLM; one internal network; a gateway on 127.0.0.1:32080 (API) and :32040 (LiteLLM); packet capture in the app and docreader namespaces |
| `litellm.spike.yaml`, `builtin_models.yaml` | Every model call of WeKnora goes through LiteLLM to the host's Ollama (`gpt-oss:20b`, `qwen2.5:7b`, `bge-m3`; local tags only) |
| `up.sh`, `down.sh` | Start (images run by digest, throw-away secrets mode 600); remove the project and only its own volumes |
| `corpus.mjs` | Builds two corpora from a checkout of the public pilot repo: `bilingual` (as is) and `split` (specs in Japanese only) |
| `questions.json` | 24 questions (12 Japanese, 12 English), written by AI, with the gold document and an evidence string |
| `setup.mjs` | Two tenants; knowledge bases `k01-bilingual`, `k01-split` (tenant A) and `k01-decoy` (tenant B); upload without LLM summaries |
| `eval.mjs`, `baseline.mjs`, `score.mjs` | WeKnora retrieval (`K01_MODE=hybrid|vector`); the baseline (bge-m3 + cosine, `K01_CHUNKS=own|weknora`); scoring |
| `answers.mjs` | Answer time of WeKnora's knowledge chat (agent and web search off) |
| `isolation.mjs` | Tenant isolation over REST, and WeKnora's built-in MCP endpoints (scope, tool allowlist, revocation) |
| `stats.sh`, `scan.sh` | `docker stats` sampling; Trivy 0.74.0 (the CI's version) on the images |
| `results/` | The numbers (JSON). No document text, no tokens |

## Run it

Needs Docker, Node.js 24, and Ollama on the host with `gpt-oss:20b` and `bge-m3` (never a `:cloud` model).
Never on a machine where the platform's dev stack must keep running: the spike competes for memory.

```bash
git clone --depth 1 https://github.com/harryforge/pilot-order-inventory.git "$TMPDIR/pilot"
platform/spikes/weknora/up.sh
node platform/spikes/weknora/corpus.mjs "$TMPDIR/pilot"
node platform/spikes/weknora/setup.mjs
K01_MODE=vector node platform/spikes/weknora/eval.mjs
node platform/spikes/weknora/baseline.mjs
node platform/spikes/weknora/isolation.mjs
platform/spikes/weknora/down.sh
```

`setup.mjs` registers the two test users `tenant-a@k01.invalid` and `tenant-b@k01.invalid` (one tenant each) with the
throw-away password from `up.sh`.
