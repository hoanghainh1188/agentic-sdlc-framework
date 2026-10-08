// K01 spike: retrieval quality of WeKnora's hybrid search (top 5) on both corpora. Writes results/weknora-<mode>.json
// (numbers and ranks only, no text). The chat model only matters for `answers.mjs`; retrieval uses bge-m3.
import { writeFileSync } from 'node:fs';
import { docId } from './corpus.mjs';
import { breakdown, crossLingual, firstHit, QUESTIONS } from './score.mjs';
import { call, hybridSearch, login } from './wk.mjs';

// K01_MODE=hybrid (default: vector + keyword, fused) or vector (keyword match off).
const MODE = process.env.K01_MODE ?? 'hybrid';
const EXTRA = MODE === 'vector' ? { disable_keywords_match: true } : {};
const a = await login('a');
const kbs = (await call('GET', '/knowledge-bases', { token: a.token })).json.data ?? [];
const result = {};
for (const corpus of ['bilingual', 'split']) {
  const kb = kbs.find((k) => k.name === `k01-${corpus}`);
  if (!kb) throw new Error(`no knowledge base k01-${corpus}`);
  // Warm-up: the first query loads the embedding model.
  await hybridSearch(a.token, kb.id, 'warm up');
  const rows = [];
  for (const q of QUESTIONS) {
    const s = await hybridSearch(a.token, kb.id, q.q, 5, EXTRA);
    if (s.status !== 200) throw new Error(`search ${q.id}: ${s.status}`);
    const top = s.items
      .slice(0, 5)
      .map((i) => ({ doc: docId(i.knowledge_filename ?? ''), text: i.content ?? '' }));
    rows.push({
      id: q.id,
      lang: q.lang,
      cross: crossLingual(q, corpus),
      rank: firstHit(q, top),
      ms: s.ms,
    });
  }
  result[corpus] = {
    mode: MODE,
    ...breakdown(rows),
    ranks: Object.fromEntries(rows.map((r) => [r.id, r.rank])),
  };
  console.log(corpus, JSON.stringify(result[corpus].all));
}
writeFileSync(
  new URL(`./results/weknora-${MODE}.json`, import.meta.url),
  JSON.stringify(result, null, 2) + '\n',
);
