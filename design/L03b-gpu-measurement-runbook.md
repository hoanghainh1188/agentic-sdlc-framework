# L03b. Runbook: measure a 30B-class model on one rented GPU

| Item | Value |
|---|---|
| Status | **Proposal**, for Harry's approval (task L03b, QUESTIONS #566, #567) |
| Date | 2026-10-24 |
| Who | The owner (Harry) runs it. Claude prepared it and reads the results afterwards. |
| Related | [L03 GPU sizing note](L03-gpu-sizing-note.md) §3, §4, §7, §8 step 2; ADR-M71 (vLLM); ADR-M78 §2.4 (the `vllm` provider); D-07 §9; `platform/eval/CLAUDE.md` |

Tags: **[Proposal]** = our estimate, not measured. **[External]** = a fact about a provider or a product that you must check on the day.

## 1. What this measures, and what it does not

Question: does a 30B-class open model meet the quality bar of the L03 note, and how much GPU does it need? The result decides if the company buys a GPU for `client_restricted` clients.

| # | Measure | How | Compared with |
|---|---|---|---|
| 1 | Resolved rate, pass^5, scope breaches | `pnpm eval` on task set v1 (8 tasks × 5 runs) for each model | The bar [Proposal]: resolved ≥ 75%, pass^5 ≥ 50%, at most 1 scope breach in 40 runs. The laptop: 68%, 25% |
| 2 | GPU memory | vLLM's start-up log (weights, free memory, KV-cache size) and a **fit test** at a smaller memory share (section 7) | L03 note §4 estimates: weights about 31 GB (30B, FP8) and 13 GB (20B), KV cache about 12 GB and 3 GB for 4 × 32k |
| 3 | Tokens per second with 4 requests at once | `platform/eval/gpu/throughput.mjs` | The 400 tokens per second assumed in L03 note §7 |
| 4 | Time per run | `pnpm eval` results | The laptop: 56 s median for the 20B model |

Not measured: bigger tasks, API models, a second GPU, 16-bit weights. `nvidia-smi` memory is **not** the need: vLLM reserves a share of the card (default 90%) whatever the model needs. That is why measure 2 uses the log and the fit test.

**Data.** Only the fictional sample repository `pilot-order-inventory` and generated text. Never client data, never a real key. The machine is thrown away at the end. No secret is needed: vLLM has no key, the weights are public, LiteLLM's keys are random values of the run.

## 2. What to rent [Proposal; check on the day]

| Item | Value |
|---|---|
| GPU | **One** with 80 GB: NVIDIA A100 80 GB or H100 80 GB. Not two smaller cards |
| Image | Ubuntu 22.04 or 24.04 with the NVIDIA driver and Docker. If the provider offers a "CUDA 12.8 or newer" image, take it **[External: vLLM v0.31.0 sets the minimum; check its release notes]** |
| CPU, memory | 8 cores or more, 64 GB RAM or more (the weights pass through RAM when they load) |
| Disk | 200 GB (image about 10 GB, FP8 weights about 31 GB, 20B weights about 14 GB, Docker layers, the npm cache, the sandbox image) |
| Network | Internet access, with a fast link to Hugging Face and Docker Hub |
| Access | SSH with a key; a user in the `docker` group |
| Billing | Hourly. Set a hard spend limit in the provider's console **before** you start (section 8) |

**Provider.** Any provider that rents an 80 GB GPU by the hour with root access (QUESTIONS #567). Region does not matter: the data is fictional. Use an on-demand machine, not a "spot" one that may be stopped in the middle of the run.

**Expected cost [Proposal].** USD 1.5–3 per hour for the GPU (L03 note §5).

| Step | Hours |
|---|---|
| Set-up, download, first start (sections 3–4) | 1.5 |
| Smoke run and the Qwen evaluation (section 5) | 2–4 |
| Fit tests (section 7) | 0.5 |
| The 20B model: download, start, evaluation (section 6) | 1.5–3 |
| Throughput, collecting results (section 8) | 0.5 |
| **Total** | **6–10 hours, about USD 10–30** |

Worst case: the harness caps each run at 20 minutes, so 40 runs could take 13 hours. Stop rule: **if the Qwen evaluation is not half done after 4 hours, stop it, keep the partial results, and tell Claude** (`pnpm eval` continues where it stopped, so nothing is lost). Hard cap for the whole task: **USD 150** (L03 note §1).

## 3. Set up the machine

Run these on the rented machine, over SSH. Use `tmux` or `screen` so a lost connection does not stop a run.

1. Check the GPU and Docker. Both commands must show the GPU:
   ```bash
   nvidia-smi
   docker run --rm --gpus all ubuntu nvidia-smi
   ```
   If the second fails, install the [NVIDIA Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html) **[External]** and restart Docker.
2. Tools: Git, OpenSSL 3, Node.js 24 and pnpm 10 (`corepack enable`). Check: `node --version`, `openssl version`.
3. The repository (public, MIT), the branch with the `vllm` provider, and its packages:
   ```bash
   git clone https://github.com/hoanghainh1188/governed-adlc-fw.git
   cd governed-adlc-fw
   git checkout main   # after the L03b PRs are merged; else the branch task/L03b-runbook
   corepack enable && pnpm install --frozen-lockfile && pnpm build
   ```
4. The settings file (random values for a throw-away stack; nothing leaves the machine):
   ```bash
   pnpm compose:env
   mkdir -p ~/l03b
   ```
5. The address of vLLM for the harness. `pnpm eval` starts its own LiteLLM in Docker and reaches vLLM through the Docker bridge address (the override file publishes vLLM only there, never on the machine's public address):
   ```bash
   export SDLC_VLLM_EVAL_BIND="$(docker network inspect bridge -f '{{(index .IPAM.Config 0).Gateway}}')"
   echo "$SDLC_VLLM_EVAL_BIND"   # usually 172.17.0.1
   ```
   Export it again in every new shell. Define the command once per shell (a function, so it works in bash and zsh):
   ```bash
   compose() { docker compose -f platform/deploy/docker-compose.yml -f platform/eval/gpu/compose.vllm-port.yml --env-file platform/deploy/.env --profile models-local "$@"; }
   ```

We start **only the `vllm` service** of the L01 stack (profile `models-local`, ADR-M71). The full stack (OpenBao, LiteLLM of the platform, gates) is not needed: the measurement is about the model, and the harness has its own LiteLLM with the same entry shape (`hosted_vllm/…`, `provider_type: self_hosted`).

## 4. Model 1: Qwen3-Coder-30B-A3B (FP8)

1. Pin the weights to a commit, so the result names an exact model:
   ```bash
   curl -s https://huggingface.co/api/models/Qwen/Qwen3-Coder-30B-A3B-Instruct-FP8 | python3 -c 'import sys,json;print(json.load(sys.stdin)["sha"])'
   ```
2. Edit `platform/deploy/.env`. Set these four lines (replace the existing ones; put the commit from step 1 in the first):
   ```text
   SDLC_VLLM_MODEL_REVISION=<the commit>
   SDLC_VLLM_MODEL=Qwen/Qwen3-Coder-30B-A3B-Instruct-FP8
   SDLC_VLLM_SERVED_NAME=qwen3-coder-30b-a3b-instruct-fp8
   SDLC_VLLM_TOOL_PARSER=qwen3_coder
   ```
   Leave the rest at the defaults: 4 requests at once, 32,768 tokens of context, 90% of the GPU. The served name must equal `tag` of the configuration `qwen3-coder-30b-fp8` in `platform/eval/configs/gpu.yaml`.
3. Download the weights (the FP8 repository is about 31 GB), start the GPU sampler **first**, then vLLM:
   ```bash
   pnpm models-local:pull
   nvidia-smi --query-gpu=timestamp,memory.used,memory.total,utilization.gpu --format=csv,noheader,nounits -l 1 > ~/l03b/qwen-gpu.csv &
   echo $! > ~/l03b/sampler.pid
   compose up -d vllm
   ```
4. Wait until it is healthy (5–15 minutes; the first start compiles kernels):
   ```bash
   until [ "$(docker inspect -f '{{.State.Health.Status}}' "$(compose ps -q vllm)")" = healthy ]; do sleep 10; done
   curl -s "http://$SDLC_VLLM_EVAL_BIND:8000/v1/models" | head -c 300
   ```
5. Save the numbers that vLLM logs at start (they hold no prompt; vLLM logs none):
   ```bash
   compose logs vllm 2>&1 | grep -iE "loading took|KV cache|maximum concurrency|available.*memory|torch.compile|CUDA graph" > ~/l03b/qwen-vllm-start.txt
   cat ~/l03b/qwen-vllm-start.txt
   ```
   Note three values: the weights ("Model loading took … GiB"), the KV cache ("GPU KV cache size: … tokens") and the "maximum concurrency for 32,768 tokens" line.

If vLLM does not start, read `compose logs vllm` and send the last 50 lines to Claude. Common causes: the driver is too old for the image, a wrong tool-parser name, not enough free disk.

## 5. Run the evaluation on Model 1

1. Check the task set, then one smoke run (about 10 minutes). Both need the internet once (the sample repository, npm packages):
   ```bash
   pnpm eval --check
   SDLC_EVAL_GPU="<the GPU name, for example NVIDIA H100 80GB>" pnpm eval --out ~/l03b/results --config platform/eval/configs/gpu.yaml --configurations qwen3-coder-30b-fp8 --tasks feat-tax --n 1
   ```
   The smoke run must end with a result file under `~/l03b/results`. It need not resolve the task. If the agent makes no tool call or the run fails at once, stop and send the output to Claude: that is a set-up error, not a quality result.
2. Count the model's tokens before and after the evaluation (this gives the average speed under the real agent load, one request at a time):
   ```bash
   curl -s "http://$SDLC_VLLM_EVAL_BIND:8000/metrics" | grep -E '^vllm:(prompt|generation)_tokens_total' > ~/l03b/qwen-tokens-before.txt; date +%s > ~/l03b/qwen-t0.txt
   ```
3. The full evaluation: 8 tasks × 5 runs. In `tmux`. Delete the smoke result first, so the table has exactly 40 runs:
   ```bash
   rm -rf ~/l03b/results
   SDLC_EVAL_GPU="<the GPU name>" pnpm eval --out ~/l03b/results --config platform/eval/configs/gpu.yaml --configurations qwen3-coder-30b-fp8
   ```
   If it stops, run the same command again: it continues where it stopped.
4. After it ends:
   ```bash
   curl -s "http://$SDLC_VLLM_EVAL_BIND:8000/metrics" | grep -E '^vllm:(prompt|generation)_tokens_total' > ~/l03b/qwen-tokens-after.txt; date +%s > ~/l03b/qwen-t1.txt
   node platform/eval/gpu/throughput.mjs --url "http://$SDLC_VLLM_EVAL_BIND:8000" --model qwen3-coder-30b-a3b-instruct-fp8 > ~/l03b/qwen-throughput.json
   cat ~/l03b/qwen-throughput.json
   kill "$(cat ~/l03b/sampler.pid)"
   ```

## 6. Model 2: gpt-oss:20b class, on the same GPU

vLLM serves one model at a time. Stop it, change the four lines, download and start again. The Qwen weights stay on the disk.

1. ```bash
   compose stop vllm && compose rm -f vllm
   curl -s https://huggingface.co/api/models/openai/gpt-oss-20b | python3 -c 'import sys,json;print(json.load(sys.stdin)["sha"])'
   ```
2. In `platform/deploy/.env`:
   ```text
   SDLC_VLLM_MODEL_REVISION=<the commit>
   SDLC_VLLM_MODEL=openai/gpt-oss-20b
   SDLC_VLLM_SERVED_NAME=gpt-oss-20b
   SDLC_VLLM_TOOL_PARSER=openai
   ```
3. Repeat section 4 steps 3–5 and section 5 steps 2–4 with the names `gpt-oss` instead of `qwen` in the file names, the configuration `gpt-oss-20b-gpu`, and the **same** `--out ~/l03b/results` (without deleting it), so one report holds both models. Start a new sampler (`gpt-oss-gpu.csv`).

Note: `gpt-oss-20b` ships in its own 4-bit format (MXFP4). The L02 laptop run used `reasoning_effort: low`; `gpu.yaml` sets the same. If the agent makes no tool call on vLLM, send the output to Claude: the parser flags may need a change (a harness or settings issue, not a model result).

## 7. Fit test: how small a card would do

The comparison with the L03 note §4 needs the **smallest** memory share at which each model still starts with 4 requests at 32k. For each model, stop vLLM, set `SDLC_VLLM_GPU_MEMORY_UTILIZATION`, start, and read the log. 10 minutes each.

| Model | Share | Equals on an 80 GB card | Stands for | Question |
|---|---|---|---|---|
| Qwen3-Coder-30B FP8 | `0.54` | 43 GB | a 48 GB card at 90% | Does it start? What is "maximum concurrency for 32,768 tokens"? |
| Qwen3-Coder-30B FP8 | `0.40` | 32 GB | (control) | The expected failure: not enough memory for the KV cache |
| gpt-oss-20b | `0.27` | 22 GB | a 24 GB card at 90% | Same two questions |

```bash
compose stop vllm && compose rm -f vllm
SDLC_VLLM_GPU_MEMORY_UTILIZATION=0.54 compose up -d vllm
sleep 240; compose logs --tail 80 vllm 2>&1 | grep -iE "KV cache|maximum concurrency|error|memory" > ~/l03b/fit-qwen-0.54.txt
```

For the fit test, a start that reaches "healthy" with maximum concurrency of 4 or more is a **pass**; an error about KV-cache memory is a **fail**. Do not run the evaluation at the small share: the quality does not depend on it.

## 8. Cost control, results, and deleting the machine

**Before you start:** in the provider's console, set a spend limit or a budget alert of USD 100 and a calendar reminder at 8 hours. A stopped machine still bills its disk; only **deleting** it ends the bill.

**Report and files to bring back.** On the machine:
```bash
pnpm eval:report --out ~/l03b/results
cd ~ && tar czf l03b-results.tgz l03b/results/report.md l03b/results/report.json l03b/*.txt l03b/*.json l03b/*.csv
```
Copy `l03b-results.tgz` to your laptop (`scp`) and give it to Claude. The archive holds numbers and codes only: the report never holds prompts, task text, code or diffs (ADR-M78 §2.4). Do **not** copy `l03b/results/diffs/` (kept diffs for blind pairs; fictional, but not needed).

What Claude does with it: a results table in D-07 §9, the bar check, the memory check against L03 §4, the real cost per token from the GPU price and the measured speed, and L03 note 1.0 for the decision.

**Delete the machine.** In this order:
1. Check the archive is on your laptop and opens.
2. In the provider's console: **terminate / delete** the instance, then delete its **disk or volume**, any snapshot, and any reserved IP. "Stop" or "pause" is not enough.
3. Check the billing page shows no running resource, and look again the next day.
4. If you made an API token or SSH key only for this task, delete it in the console.

## 9. How to read the result [Proposal]

| Outcome | Meaning | Next step |
|---|---|---|
| Qwen3-Coder FP8 meets the bar, and the fit test passes at 43 GB | A 48 GB card is enough, tight | L03 note 1.0: buy a 48 GB or 80 GB GPU for `client_restricted`; quotes first |
| It meets the bar only with the memory of the 80 GB card | Buy the 80 GB class | As above, with the 80 GB price |
| Only `gpt-oss-20b` meets the bar | A 24 GB card may do | As above, with the 24 GB price |
| Neither meets the bar | A self-hosted model is not good enough yet for these tasks | Say so openly; do not buy; revisit when a better open model exists |
| Intervals overlap the bar | 40 runs are few | Report the interval; run `--n 10` on the better model only if the decision depends on it |

The L03 note's counsel questions (rented hardware and client data, §6) stay open and are independent of this run.

## Version history

| Version | Date | Author | Notes |
|---|---|---|---|
| 0.1 | 2026-10-24 | Claude (task L03b PR 2), for Harry's approval | First version |
