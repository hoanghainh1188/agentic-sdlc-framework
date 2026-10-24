// Task L03b (design/L03b-gpu-measurement-runbook.md): tokens per second of the `vllm` service with
// N requests at once, and with one request alone. Prints one JSON line with numbers only.
// The prompts are generated, fictional text; nothing is stored. The evaluation itself sends one
// request at a time, so this is the only measurement of concurrent use (the platform's default is 4).
//
//   node platform/eval/gpu/throughput.mjs --url http://172.17.0.1:8000 --model <served name>
//        [--concurrency 4] [--rounds 3] [--prompt-words 3000] [--max-tokens 512]
const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
  args.set(process.argv[i]?.replace(/^--/, ''), process.argv[i + 1]);
}
const url = args.get('url') ?? 'http://172.17.0.1:8000';
const model = args.get('model');
const number = (key, fallback) => {
  const value = Number(args.get(key) ?? fallback);
  if (!Number.isInteger(value) || value < 1) throw new Error(`--${key} must be a positive integer`);
  return value;
};
if (!model) throw new Error('--model <served model name> is required');
const concurrency = number('concurrency', 4);
const rounds = number('rounds', 3);
const promptWords = number('prompt-words', 3000);
const maxTokens = number('max-tokens', 512);

/** A different prompt each time, so the prefix cache cannot make a request look free. */
function prompt(seed) {
  const words = [];
  for (let i = 0; i < promptWords; i++) words.push(`item${String((seed * 7919 + i * 31) % 9973)}`);
  return `Summarise this list of fictional order codes in your own words, at length:\n${words.join(' ')}`;
}

async function one(seed) {
  const response = await fetch(`${url}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt(seed) }],
      max_tokens: maxTokens,
      temperature: 0,
      // Force the length, so every request produces the same number of tokens.
      ignore_eos: true,
    }),
  });
  if (!response.ok) throw new Error(`vLLM answered ${String(response.status)}`);
  const { usage } = await response.json();
  return { prompt: usage.prompt_tokens, completion: usage.completion_tokens };
}

async function round(count, seed) {
  const started = performance.now();
  const results = await Promise.all(Array.from({ length: count }, (_, i) => one(seed + i)));
  const seconds = (performance.now() - started) / 1000;
  const prompt = results.reduce((sum, r) => sum + r.prompt, 0);
  const completion = results.reduce((sum, r) => sum + r.completion, 0);
  return { seconds, prompt, completion };
}

function summary(label, count, list) {
  const seconds = list.reduce((sum, r) => sum + r.seconds, 0);
  const prompt = list.reduce((sum, r) => sum + r.prompt, 0);
  const completion = list.reduce((sum, r) => sum + r.completion, 0);
  return {
    label,
    requests_at_once: count,
    rounds: list.length,
    seconds: Number(seconds.toFixed(1)),
    prompt_tokens: prompt,
    completion_tokens: completion,
    // Output tokens per second over all requests together, and input plus output together.
    completion_tokens_per_second: Number((completion / seconds).toFixed(1)),
    all_tokens_per_second: Number(((prompt + completion) / seconds).toFixed(1)),
  };
}

await round(1, 1); // a warm-up, not counted
const alone = [];
const together = [];
for (let r = 0; r < rounds; r++) {
  alone.push(await round(1, 100 + r));
  together.push(await round(concurrency, 1000 + r * concurrency));
}
process.stdout.write(
  `${JSON.stringify({ model, one_alone: summary('one', 1, alone), many: summary('many', concurrency, together) })}\n`,
);
