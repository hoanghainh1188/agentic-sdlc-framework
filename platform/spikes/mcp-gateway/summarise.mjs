// X14 spike (design/ADR-M87): writes results/<gateway>.json from $X14_OUT (codes and counts only).
//   node platform/spikes/mcp-gateway/summarise.mjs "$X14_OUT"
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const out = process.argv[2];
if (!out) throw new Error('usage: summarise.mjs <X14_OUT>');
const here = dirname(fileURLToPath(import.meta.url));
mkdirSync(join(here, 'results'), { recursive: true });

const json = (p) => JSON.parse(readFileSync(p, 'utf8'));
const lines = (p) =>
  existsSync(p) ? readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];

function trivy(name) {
  const p = join(out, 'trivy', `${name}.json`);
  if (!existsSync(p)) return null;
  const counts = { CRITICAL: 0, HIGH: 0, fixable: 0, licences: 0 };
  const ids = new Set();
  for (const r of json(p).Results ?? []) {
    for (const v of r.Vulnerabilities ?? []) {
      if (ids.has(`${v.VulnerabilityID}:${v.PkgName}`)) continue;
      ids.add(`${v.VulnerabilityID}:${v.PkgName}`);
      counts[v.Severity] += 1;
      if (v.FixedVersion) counts.fixable += 1;
    }
    counts.licences += (r.Licenses ?? []).length;
  }
  return counts;
}

for (const gw of ['agentgateway', 'contextforge', 'docker']) {
  const dir = join(out, gw);
  if (!existsSync(dir)) continue;
  const scenarios = Object.fromEntries(
    lines(join(dir, 'client.jsonl')).map(({ scenario, ...rest }) => [scenario, rest]),
  );
  const load = Object.fromEntries(
    lines(join(out, `${gw}-load`, 'client.jsonl')).map(({ scenario, ...rest }) => [scenario, rest]),
  );
  const idle = json(join(dir, 'stats-idle.json'));
  const result = {
    gateway: gw,
    image: json(join(dir, 'image.json')),
    start_ms: json(join(dir, 'leaks.json')).start_ms,
    idle_memory: idle.MemUsage.split(' / ')[0],
    scenarios,
    reached_tool: json(join(dir, 'tool-stats.json')),
    logs: json(join(dir, 'leaks.json')),
    load,
    trivy_high_critical: trivy(gw),
  };
  writeFileSync(join(here, 'results', `${gw}.json`), `${JSON.stringify(result, null, 2)}\n`);
  process.stdout.write(`${gw}: written\n`);
}
