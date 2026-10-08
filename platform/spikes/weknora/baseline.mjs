// K01 spike baseline (Harry, 2026-10-08): the same questions without WeKnora. bge-m3 embeddings through the
// spike's LiteLLM, chunks of about the same size as WeKnora's (split at headings and blank lines, ≤ 500 characters),
// cosine similarity, top 5. Writes results/baseline-<chunker>-chunks.json (numbers and ranks only, no text).
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { docId, stateDir } from './corpus.mjs';
import { breakdown, crossLingual, firstHit, QUESTIONS } from './score.mjs';
import { LITELLM, secrets } from './wk.mjs';

const MAX = 500;
// K01_CHUNKS=own (default: this script's chunker) or weknora (the same chunks WeKnora indexed).
const CHUNKS = process.env.K01_CHUNKS ?? 'own';

function chunk(text) {
  const blocks = text
    .split(/\n(?=#{1,6} )|\n\s*\n/)
    .map((b) => b.trim())
    .filter(Boolean);
  const out = [];
  let cur = '';
  for (const b of blocks) {
    if (cur && cur.length + b.length + 1 > MAX) {
      out.push(cur);
      cur = '';
    }
    if (b.length > MAX) {
      for (let i = 0; i < b.length; i += MAX) out.push(b.slice(i, i + MAX));
      continue;
    }
    cur = cur ? `${cur}\n${b}` : b;
  }
  if (cur) out.push(cur);
  return out;
}

async function embed(texts) {
  const res = await fetch(`${LITELLM}/v1/embeddings`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${secrets().K01_LITELLM_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ model: 'bge-m3', input: texts }),
  });
  if (!res.ok) throw new Error(`embeddings: ${res.status}`);
  return (await res.json()).data.map((d) => d.embedding);
}

const cos = (a, b) => {
  let d = 0,
    x = 0,
    y = 0;
  for (let i = 0; i < a.length; i++) {
    d += a[i] * b[i];
    x += a[i] * a[i];
    y += b[i] * b[i];
  }
  return d / Math.sqrt(x * y);
};

const result = {};
for (const corpus of ['bilingual', 'split']) {
  const dir = join(stateDir(), 'corpus', corpus);
  const chunks = [];
  if (CHUNKS === 'weknora') {
    // WeKnora's own chunks (exported from its database by the operator into the state directory).
    for (const c of JSON.parse(readFileSync(join(stateDir(), `chunks-${corpus}.json`), 'utf8')))
      chunks.push({ doc: docId(c.file), text: c.text });
  } else {
    for (const f of readdirSync(dir).sort())
      for (const text of chunk(readFileSync(join(dir, f), 'utf8')))
        chunks.push({ doc: docId(f), text });
  }
  const t0 = performance.now();
  const vecs = [];
  for (let i = 0; i < chunks.length; i += 16)
    vecs.push(...(await embed(chunks.slice(i, i + 16).map((c) => c.text))));
  const indexMs = performance.now() - t0;
  const rows = [];
  for (const q of QUESTIONS) {
    const s = performance.now();
    const [qv] = await embed([q.q]);
    const top = chunks
      .map((c, i) => ({ ...c, score: cos(qv, vecs[i]) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 5);
    rows.push({
      id: q.id,
      lang: q.lang,
      cross: crossLingual(q, corpus),
      rank: firstHit(q, top),
      ms: performance.now() - s,
    });
  }
  result[corpus] = {
    chunker: CHUNKS,
    chunks: chunks.length,
    index_seconds: Number((indexMs / 1000).toFixed(1)),
    ...breakdown(rows),
    ranks: Object.fromEntries(rows.map((r) => [r.id, r.rank])),
  };
  console.log(corpus, JSON.stringify(result[corpus].all));
}
writeFileSync(
  new URL(`./results/baseline-${CHUNKS}-chunks.json`, import.meta.url),
  JSON.stringify(result, null, 2) + '\n',
);
