# L03. GPU sizing note for leadership

| Item | Value |
|---|---|
| Status | **Proposal**, for Harry's approval (task L03, QUESTIONS #561–#563) |
| Date | 2026-10-24 |
| Audience | Leadership. No GPU knowledge needed. |
| Related | D-08 L03 AC1; D-07 §4, §9; ADR-M71 (vLLM, L01); ADR-M78 (evaluation harness, L02); QUESTIONS #362, #447, #548 |

Tag used below: **[Proposal]** = our suggestion or estimate, not measured and not approved. **[Measured]** = a number from L02.

## 1. The short answer

1. **We cannot yet say which model size meets the quality bar.** L02 measured a 20B model and an 8B model on a laptop. It did not measure any model of about 30B or more. That measurement needs a GPU. So this note gives a sizing and a decision rule, not a final choice.
2. **Rent one GPU for 1–2 days to measure; do not buy yet.** Cost [Proposal]: about USD 50–150. Use only the fictional sample repository, never client data.
3. **If a 30B-class model passes the bar, plan for one GPU with 48 GB (tight) or 80 GB (comfortable).** Monthly cost [Proposal]: about USD 600–1,200, rented or bought.
4. **Do not run real `client_restricted` work on rented hardware** until a lawyer and the client agree (section 6). For these clients, the realistic route is a GPU the company owns, or a dedicated rented server under a contract the client accepts.
5. **The internal cost per token in ADR-M71 is probably too low.** At low use, the GPU may cost several times more per token than the placeholder. It needs a measurement (section 7).

## 2. What L02 measured, and what it did not

**[Measured]** (D-07 §9, task set version 1: 8 small tasks, one developer laptop with 24 GB of memory):

| Model | Resolved | All 5 runs resolve a task (pass^5) | Median time per run |
|---|---|---|---|
| `gpt-oss:20b` | 68% (95% interval 50%–85%), 40 runs | 25% | 56 s |
| `qwen3:8b` | 0% of 13 runs (stopped early, QUESTIONS #447) | not measured | 431 s |

**Not measured:** any model of about 30B or more, any API model, any GPU server, bigger tasks, speed with several requests at once. The intervals are wide: 8 tasks and 5 runs per task are few.

## 3. The quality bar [Proposal]

ADR-M78 does not define a bar. We propose one, so that leadership can judge a measurement. Harry confirms the numbers (QUESTIONS #561).

A model meets the bar on task set version 1 when, over 8 tasks × 5 runs:

- **Resolved: at least 75%.** (The 20B laptop result is 68%.)
- **pass^5: at least 50%.** (The 20B laptop result is 25%.) Half of the tasks must be resolved every time. People will not trust an agent that succeeds only sometimes.
- **At most 1 scope breach in 40 runs.** A scope breach is an agent that changes files outside its plan.

Passing the bar means "worth using on small tasks and worth measuring on a client's own tasks (L07)". It does not prove quality on large work.

## 4. GPU memory and count [Proposal]

GPU memory must hold two things: the **weights** (the model itself) and the **KV cache** (the model's working memory; it grows with the length of the conversation and the number of requests at once). The platform's defaults are 32,768 tokens of context and 4 requests at once (ADR-M71 §2.1). Add about 3–4 GB for the serving software.

These are estimates from parameter count and precision. They are not measured on a GPU. Check them with the real run in section 7.

| Model | Precision | Weights | KV cache (4 × 32k) | Fits on |
|---|---|---|---|---|
| `gpt-oss:20b` class (21B) | 4-bit (its native format) | about 13 GB | about 3 GB | **1 × 24 GB**, comfortable |
| `Qwen3-Coder-30B-A3B` (30.5B; ADR-M71 default) | 8-bit (FP8) | about 31 GB | about 12 GB, or about 6 GB with an 8-bit cache | **1 × 48 GB**: tight (the platform uses 90% of memory, so 43 GB); needs the 8-bit cache or 2 requests at once. **1 × 80 GB**: comfortable |
| Same model | 16-bit (BF16) | about 61 GB | about 12 GB | 1 × 80 GB, very tight. Not recommended |
| Models above about 70B | — | 70 GB or more | more | 2 or more GPUs. Out of scope until a 30B result shows that size matters |

Notes:
- The KV cache figure assumes 48 layers, 4 key-value heads and a head size of 128 for the 30B model. Check it against the model card.
- Several GPUs in one machine split the model (vLLM `--tensor-parallel-size`, already in ADR-M71). We do not need that for the sizes above.
- 8-bit and 4-bit models can score lower than 16-bit. The measurement in section 7 must use the same precision that we would buy for.

## 5. Buy or rent

| | Buy and run ourselves | Rent a GPU server |
|---|---|---|
| Money | A large payment now. About USD 12,000–15,000 for a 48 GB workstation, about USD 30,000–40,000 for a server with an 80 GB card [Proposal; get quotes] | Pay by the hour. 48 GB: about USD 0.7–1.2 per hour. 80 GB: about USD 1.5–3 per hour [Proposal; check providers] |
| Client data | Stays in the company. The only option that clearly fits `client_restricted` | Data is on another company's machine (section 6) |
| Speed to start | Weeks (order, delivery, install) | Hours |
| Fit to our use | Good if the GPU is busy most of the time | Good for a measurement and for rare peaks; expensive if left on 24 hours a day |
| Work for people | Driver, cooling, power, replacement | Small |

**Recommendation [Proposal]:** rent to measure (section 7). Then:
- If the bar is met and `client_restricted` clients are a real part of sales: **buy**, and keep the machine in the company's own rack or office. Choose 48 GB or 80 GB from the measurement.
- If only API models are needed (clients allow it): do not buy a GPU.
- If the bar is not met: say so openly. Agents on a self-hosted model are then not good enough for `client_restricted` work yet. Revisit when a better open model exists.

## 6. The legal question: rented hardware and `client_restricted` data

`client_restricted` means the client forbids the data to leave the company (D-07 §4). A rented GPU server is a computer of another company. We think that makes the provider a **sub-processor** (a third party that handles the client's data for us), and the data would leave the company. Our default [Proposal]: **no real `client_restricted` data on rented hardware** until counsel and the client have both agreed. Rented hardware stays fine for L02 runs on the fictional sample repository.

This is not legal advice. Questions for counsel (QUESTIONS #563):

1. Do our client contracts and data-processing agreements allow a sub-processor at all? Does each client have to approve it first?
2. Does a **dedicated** server (one customer only, rented by the month, in a named country) count differently from a shared cloud GPU?
3. Which countries are allowed for the data (the client's country, our country, other)?
4. What can the provider see? (Disks and memory of a rented machine, support staff, backups.) Which contract terms and audit rights do we need?
5. Does the client's own policy (for example a Japanese client's security rules) forbid a rented machine even with a contract?
6. If the answer is "yes, with conditions": what is the standard text that we send to the client for approval?

The platform already limits the risk in other ways. The vLLM service has no internet route and does not log prompts (ADR-M71 §2.1). That helps on our own hardware. It does not protect data from the owner of a rented machine.

## 7. Cost per month [Proposal]

All prices are estimates from general market knowledge, not quotes. Replace them with real quotes before any purchase.

| Option | Money per month |
|---|---|
| Rent, 48 GB, 24 hours a day (730 h × USD 0.7–1.2) | about USD 500–900 |
| Rent, 80 GB, 24 hours a day (730 h × USD 1.5–3) | about USD 1,100–2,200 |
| Rent, 80 GB, 100 hours a month (measurements, peaks) | about USD 150–300 |
| Buy, 48 GB workstation (USD 12,000–15,000 over 36 months) + power about USD 40 | about USD 370–460 |
| Buy, 80 GB server (USD 30,000–40,000 over 36 months) + power about USD 55 | about USD 890–1,170 |

Buying does not include the operator's time or a spare machine. Add them for a fair comparison.

**Cost per token.** ADR-M71 §2.3 uses a placeholder (USD 0.1 per million input tokens, USD 0.4 per million output tokens). The real value is: monthly cost ÷ tokens produced per month. The tokens per month depend on speed and on how busy the GPU is. Example [Proposal; the speed is an assumption, not measured]: 400 tokens per second for all 4 requests together, counting input and output as one number:

| Monthly cost | GPU busy 10% | GPU busy 30% | GPU busy 60% |
|---|---|---|---|
| USD 600 (48 GB class) | USD 5.7 per million tokens | USD 1.9 | USD 0.95 |
| USD 1,200 (80 GB class) | USD 11.4 per million tokens | USD 3.8 | USD 1.9 |

So the placeholder is likely **several times too low** unless the GPU is busy and fast. Agents read far more tokens than they write, and reading (prompt processing) is much faster than writing. So the real input price per token is probably lower than the blended numbers above, and the output price higher. We cannot split them without a measurement.

The cost per token only keeps budgets honest (D-07 §3). It is not a bill. When the measurement exists, a small change task updates the template (`litellm/config.ctmpl`) and its test.

## 8. Next steps [Proposal]

1. **Harry** confirms the bar (QUESTIONS #561) and asks counsel the questions in section 6 (QUESTIONS #563).
2. **Measurement task (new, call it L03b).** Rent one 80 GB GPU for 1–2 days. Start the L01 stack (`pnpm compose:models-local`) with `Qwen3-Coder-30B-A3B` in FP8 and run `pnpm eval` with the same task set as L02 (8 tasks × 5 runs). Also run `gpt-oss:20b` on the same GPU, so the two models and the laptop are comparable. Record: the bar (section 3), real GPU memory used, requests per second with 4 at once, time per run. Use only the fictional sample repository. The owner runs it (live test, R035).
3. **Decide** with the rule in section 5 and the real numbers. Then update this note to version 1.0, update the cost per token, and update D-07 §9.
4. L01 PR 2 (a separate GPU host with mutual TLS, QUESTIONS #546) matters only if the GPU is not in the platform server.

## 9. Questions for leadership

- Is the quality bar in section 3 right for what you want to sell? (QUESTIONS #561)
- Buy or rent: do you accept "rent to measure, then buy if the bar is met"? (QUESTIONS #562)
- Who asks counsel the questions in section 6, and by when? (QUESTIONS #563)

## Version history

| Version | Date | Author | Notes |
|---|---|---|---|
| 0.1 | 2026-10-24 | Claude (task L03), for Harry's approval | First version. No 30B-class measurement exists yet, so sizing is by arithmetic and every price and speed is a [Proposal] |
