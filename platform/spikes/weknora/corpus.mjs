// K01 spike: build the two corpora from a local checkout of the public fictional pilot repo.
// Nothing is copied into this repository: the files go to $K01_STATE_DIR/corpus/<name>/.
//   bilingual: specs T01–T10 as they are (Japanese and English lines), README.md, AGENTS.md (English).
//   split:     specs with the English translation lines removed (Japanese only), README.md, AGENTS.md.
// Usage: node corpus.mjs <pilot checkout>
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const CJK = /[぀-ヿ一-鿿]/;

/** Japanese-only version of a bilingual spec: drop translation lines, keep the Japanese half of "JA / EN" lines. */
export function japaneseOnly(text) {
  const out = [];
  // CJK outside code spans and 「」 quotes: English lines may quote Japanese values.
  const ownCjk = (s) =>
    CJK.test(
      s
        .replace(/`[^`]*`/g, '')
        .replace(/「[^」]*」/g, '')
        .replace(/[受付出荷済]+/g, ''),
    );
  for (const line of text.split('\n')) {
    if (/[A-Za-z]{2,}(\s+[A-Za-z]{2,}){2,}/.test(line) && !ownCjk(line)) continue; // an English line
    const m = line.match(/^(.*?\S)\s*\/\s+(.*)$/);
    if (m && CJK.test(m[1]) && !ownCjk(m[2])) {
      out.push(m[1]);
      continue;
    }
    out.push(line);
  }
  return out.join('\n');
}

export function stateDir() {
  return process.env.K01_STATE_DIR ?? join(process.env.TMPDIR ?? '/tmp', 'k01-weknora');
}

export function docId(file) {
  return file.replace(/\.md$/, '').replace(/^(T\d\d)-.*/, '$1');
}

function main() {
  const pilot = process.argv[2];
  if (!pilot) throw new Error('usage: node corpus.mjs <pilot checkout>');
  const specs = readdirSync(join(pilot, 'docs/specs'))
    .filter((f) => /^T\d\d-.*\.md$/.test(f))
    .sort();
  for (const name of ['bilingual', 'split']) {
    const dir = join(stateDir(), 'corpus', name);
    mkdirSync(dir, { recursive: true });
    for (const f of specs) {
      const text = readFileSync(join(pilot, 'docs/specs', f), 'utf8');
      writeFileSync(join(dir, f), name === 'split' ? japaneseOnly(text) : text);
    }
    for (const f of ['README.md', 'AGENTS.md'])
      writeFileSync(join(dir, f), readFileSync(join(pilot, f), 'utf8'));
  }
  // Every evidence string must exist in its gold document in both corpora.
  const qs = JSON.parse(
    readFileSync(new URL('./questions.json', import.meta.url), 'utf8'),
  ).questions;
  const norm = (s) => s.replace(/\s+/g, '');
  let bad = 0;
  for (const name of ['bilingual', 'split']) {
    const dir = join(stateDir(), 'corpus', name);
    const files = readdirSync(dir);
    for (const q of qs) {
      const ok = files.some(
        (f) =>
          q.docs.includes(docId(f)) &&
          q.evidence.some((e) => norm(readFileSync(join(dir, f), 'utf8')).includes(norm(e))),
      );
      if (!ok) {
        bad++;
        console.error(`evidence missing: ${name} ${q.id}`);
      }
    }
  }
  console.log(
    `corpus ready: ${specs.length} specs + README + AGENTS, evidence check ${bad === 0 ? 'ok' : `${bad} missing`}`,
  );
  if (bad) process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) main();
