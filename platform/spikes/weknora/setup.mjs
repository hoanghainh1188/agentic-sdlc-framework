// K01 spike: create the knowledge bases (no per-document summaries) and load the corpora. Writes IDs and timings to $K01_STATE_DIR/ids.json
// and results/ingest.json (numbers only). Tenant A: k01-bilingual, k01-split. Tenant B: k01-decoy (isolation).
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stateDir } from './corpus.mjs';
import { call, login, secrets, sleep } from './wk.mjs';

const DECOY = `# Tenant B only\n\nThe decoy passphrase of tenant B is zebra-orchid-17. 受注のテスト用の別テナントの文書です。\n`;

async function createKb(token, name) {
  const r = await call('POST', '/knowledge-bases', {
    token,
    body: { name, embedding_model_id: 'k01-embed', summary_model_id: 'k01-chat' },
  });
  if (!r.json.data?.id) throw new Error(`create kb ${name}: ${r.status}`);
  return r.json.data.id;
}

async function upload(token, kbId, name, text) {
  const form = new FormData();
  form.append('file', new Blob([text], { type: 'text/markdown' }), name);
  form.append('fileName', name);
  // No per-document LLM summary: on the target host it took 21 minutes for 55 KB (ADR-M59).
  form.append('process_config', JSON.stringify({ summary_enabled: false }));
  const r = await call('POST', `/knowledge-bases/${kbId}/knowledge/file`, { token, form });
  if (!r.json.data?.id)
    throw new Error(`upload ${name}: ${r.status} ${JSON.stringify(r.json).slice(0, 200)}`);
  return r.json.data.id;
}

async function waitParsed(token, kbId, count) {
  const t0 = Date.now();
  for (;;) {
    const r = await call('GET', `/knowledge-bases/${kbId}/knowledge?page=1&page_size=100`, {
      token,
    });
    const items = r.json.data ?? [];
    const states = items.map((k) => k.parse_status);
    if (items.length === count && states.every((s) => s === 'completed' || s === 'failed')) {
      return {
        seconds: (Date.now() - t0) / 1000,
        failed: states.filter((s) => s === 'failed').length,
        map: Object.fromEntries(items.map((k) => [k.id, k.file_name])),
      };
    }
    if (Date.now() - t0 > 30 * 60_000)
      throw new Error(`timeout parsing ${kbId}: ${states.join(',')}`);
    await sleep(3000);
  }
}

// Two test users, one per tenant (WeKnora makes a personal tenant at registration). Already registered: ignored.
for (const u of ['a', 'b']) {
  await call('POST', '/auth/register', {
    body: {
      email: `tenant-${u}@k01.invalid`,
      password: secrets().K01_USER_PASSWORD,
      username: `tenant-${u}`,
    },
  });
}
const a = await login('a');
const b = await login('b');
// Start clean: remove earlier k01-* knowledge bases of both tenants.
for (const t of [a, b]) {
  const r = await call('GET', '/knowledge-bases', { token: t.token });
  for (const kb of r.json.data ?? [])
    if (kb.name.startsWith('k01-'))
      await call('DELETE', `/knowledge-bases/${kb.id}`, { token: t.token });
}
const ids = { tenantA: a.tenantId, tenantB: b.tenantId, kb: {}, docs: {} };
const ingest = {};
for (const name of ['bilingual', 'split']) {
  const kb = await createKb(a.token, `k01-${name}`);
  ids.kb[name] = kb;
  const dir = join(stateDir(), 'corpus', name);
  const files = readdirSync(dir).sort();
  const t0 = Date.now();
  for (const f of files) await upload(a.token, kb, f, readFileSync(join(dir, f), 'utf8'));
  const w = await waitParsed(a.token, kb, files.length);
  ids.docs[name] = w.map;
  ingest[name] = {
    files: files.length,
    bytes: files.reduce((s, f) => s + Buffer.byteLength(readFileSync(join(dir, f))), 0),
    seconds: (Date.now() - t0) / 1000,
    failed: w.failed,
  };
  console.log(
    `${name}: ${files.length} files parsed in ${ingest[name].seconds.toFixed(1)} s, failed ${w.failed}`,
  );
}
ids.kb.decoy = await createKb(b.token, 'k01-decoy');
await upload(b.token, ids.kb.decoy, 'decoy.md', DECOY);
ids.docs.decoy = (await waitParsed(b.token, ids.kb.decoy, 1)).map;
writeFileSync(join(stateDir(), 'ids.json'), JSON.stringify(ids, null, 2));
writeFileSync(
  new URL('./results/ingest.json', import.meta.url),
  JSON.stringify(ingest, null, 2) + '\n',
);
