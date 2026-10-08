// K01 spike: answer time of WeKnora's knowledge chat (agent off, web search off) with the spike's chat model.
// 8 questions (4 ja, 4 en) on the bilingual corpus. Records time to first answer token, total time, and whether the
// references include the gold document. Writes results/answers-<model>.json (numbers only, no text).
import { writeFileSync } from 'node:fs';
import { docId } from './corpus.mjs';
import { QUESTIONS } from './score.mjs';
import { API, call, login } from './wk.mjs';

const MODEL = process.env.K01_CHAT_MODEL ?? 'gpt-oss-20b';
const PICK = ['Q01', 'Q06', 'Q09', 'Q11', 'Q14', 'Q16', 'Q20', 'Q22'];

const a = await login('a');
const kb = (await call('GET', '/knowledge-bases', { token: a.token })).json.data.find(
  (k) => k.name === 'k01-bilingual',
);
const rows = [];
for (const q of QUESTIONS.filter((x) => PICK.includes(x.id))) {
  const session = (await call('POST', '/sessions', { token: a.token, body: { title: 'k01' } })).json
    .data.id;
  const t0 = performance.now();
  const res = await fetch(`${API}/knowledge-chat/${session}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${a.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query: q.q,
      knowledge_base_ids: [kb.id],
      agent_enabled: false,
      web_search_enabled: false,
    }),
  });
  let first = null;
  let refs = [];
  let answerChars = 0;
  const decoder = new TextDecoder();
  let buf = '';
  for await (const part of res.body) {
    buf += decoder.decode(part, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line.startsWith('data:')) continue;
      let ev;
      try {
        ev = JSON.parse(line.slice(5));
      } catch {
        continue;
      }
      if (ev.response_type === 'answer' && ev.content) {
        first ??= performance.now() - t0;
        answerChars += ev.content.length;
      }
      if (ev.response_type === 'references')
        refs = ev.knowledge_references ?? ev.data?.references ?? ev.data ?? [];
    }
  }
  const total = performance.now() - t0;
  const refDocs = (Array.isArray(refs) ? refs : []).map((r) =>
    docId(r.knowledge_filename ?? r.knowledge_title ?? ''),
  );
  rows.push({
    id: q.id,
    lang: q.lang,
    status: res.status,
    first_token_s: first && Number((first / 1000).toFixed(1)),
    total_s: Number((total / 1000).toFixed(1)),
    answer_chars: answerChars,
    gold_in_references: refDocs.some((d) => q.docs.includes(d)),
  });
  console.log(JSON.stringify(rows.at(-1)));
}
const t = rows.map((r) => r.total_s).sort((x, y) => x - y);
const out = {
  model: MODEL,
  n: rows.length,
  total_s_p50: t[Math.floor(t.length / 2)],
  total_s_max: t.at(-1),
  gold_in_references: rows.filter((r) => r.gold_in_references).length,
  rows,
};
writeFileSync(
  new URL(`./results/answers-${MODEL}.json`, import.meta.url),
  JSON.stringify(out, null, 2) + '\n',
);
