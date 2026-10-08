// K01 spike: shared scoring. A retrieved chunk is a hit when it comes from a gold document and holds an evidence string.
import { readFileSync } from 'node:fs';

export const QUESTIONS = JSON.parse(
  readFileSync(new URL('./questions.json', import.meta.url), 'utf8'),
).questions;
const norm = (s) => s.replace(/\s+/g, '');

/** Rank (1-based) of the first hit among `chunks` ([{doc, text}]), or 0. */
export function firstHit(q, chunks) {
  const i = chunks.findIndex(
    (c) => q.docs.includes(c.doc) && q.evidence.some((e) => norm(c.text).includes(norm(e))),
  );
  return i + 1;
}

/** Cross-lingual: the question's language differs from the gold passage's language in this corpus. */
export function crossLingual(q, corpus) {
  const english = q.docs.every((d) => d === 'README' || d === 'AGENTS');
  const passage = english ? 'en' : corpus === 'split' ? 'ja' : 'both';
  return passage !== 'both' && passage !== q.lang;
}

export function summarise(rows) {
  const n = rows.length;
  const hit = (k) => rows.filter((r) => r.rank > 0 && r.rank <= k).length;
  const ms = rows.map((r) => r.ms).sort((a, b) => a - b);
  const pct = (p) => ms[Math.min(ms.length - 1, Math.floor(p * ms.length))];
  return {
    n,
    hit_at_1: hit(1),
    hit_at_5: hit(5),
    mrr: Number((rows.reduce((s, r) => s + (r.rank ? 1 / r.rank : 0), 0) / n).toFixed(3)),
    ms_p50: Math.round(pct(0.5)),
    ms_p95: Math.round(pct(0.95)),
  };
}

export function breakdown(rows) {
  return {
    all: summarise(rows),
    ja: summarise(rows.filter((r) => r.lang === 'ja')),
    en: summarise(rows.filter((r) => r.lang === 'en')),
    cross_lingual: summarise(rows.filter((r) => r.cross)),
    same_language: summarise(rows.filter((r) => !r.cross)),
  };
}
