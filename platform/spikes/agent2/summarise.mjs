// X01 spike (design/ADR-M68): turns the raw results in X01_OUT into the committed summaries in
// results/ (numbers and codes only: no prompt, no diff, no key, no path inside the repository).
//   node platform/spikes/agent2/summarise.mjs <X01_OUT> [<pnpm eval --out folder>]
import fs from 'node:fs';
import path from 'node:path';

const [out, evalOut] = process.argv.slice(2);
if (!out) throw new Error('usage: summarise.mjs <X01_OUT> [<eval out>]');
const here = path.dirname(new URL(import.meta.url).pathname);
const results = path.join(here, 'results');
fs.mkdirSync(results, { recursive: true });
const read = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const save = (name, value) =>
  fs.writeFileSync(path.join(results, name), `${JSON.stringify(value, null, 2)}\n`);
const files = (dir, re) =>
  fs.existsSync(dir)
    ? fs
        .readdirSync(dir)
        .filter((f) => re.test(f))
        .sort()
    : [];

/** An existing summary in results/, so a later run of one agent keeps the other agents' rows. */
const previous = (name) =>
  fs.existsSync(path.join(results, name)) ? read(path.join(results, name)) : null;

// AC1: probes and cap checks, as they are (already counts and codes). New files replace old keys.
const checks = { ...(previous('checks.json') ?? {}) };
for (const f of files(out, /^checks-.*\.json$/))
  checks[f.replace(/\.json$/, '')] = read(path.join(out, f));
if (Object.keys(checks).length) save('checks.json', checks);

// AC2: one row per run, then a mean per agent and task.
const row = (r) => ({
  agent: r.agent,
  task: r.task,
  resolved: r.score ? r.score.applied && r.score.failToPass && r.score.passToPass : null,
  ci: r.score?.ci ?? null,
  outcome: r.outcome,
  stopReason: r.stopReason,
  seconds: r.seconds,
  iterations: r.iterations,
  modelCalls: r.modelCalls,
  inputTokens: r.inputTokens,
  outputTokens: r.outputTokens,
  costUsd: r.costUsd,
  changedFiles: r.changedFiles,
  outOfPlanFiles: r.outOfPlanFiles,
  diffLines: r.diffLines,
  firstProgressSeconds: r.progress?.firstProgressSeconds ?? null,
  maxEvents: r.progress?.maxEvents ?? null,
  maxIdenticalCalls: r.progress?.maxIdentical ?? null,
});
const fresh = files(out, /^compare-.*\.json$/).map((f) => row(read(path.join(out, f))));
// Rows of an agent measured again are replaced; other agents' rows stay.
const measured = new Set(fresh.map((r) => r.agent));
const rows = [
  ...(previous('compare.json')?.runs ?? []).filter((r) => !measured.has(r.agent)),
  ...fresh,
];

// The OpenHands baseline from `pnpm eval` (ADR-M78 result files), same tasks and model.
if (evalOut) {
  for (let i = rows.length - 1; i >= 0; i--) if (rows[i].agent === 'openhands') rows.splice(i, 1);
  const walk = (d) =>
    fs
      .readdirSync(d, { withFileTypes: true })
      .flatMap((e) =>
        e.isDirectory()
          ? e.name === 'diffs'
            ? []
            : walk(path.join(d, e.name))
          : [path.join(d, e.name)],
      );
  for (const f of walk(evalOut).filter((f) => f.endsWith('.json'))) {
    const r = read(f);
    if (r.schema !== 1 || typeof r.task !== 'string') continue;
    rows.push({
      agent: 'openhands',
      task: r.task,
      resolved: r.resolved,
      ci: r.ci_passed,
      outcome: r.outcome,
      stopReason: r.stop_reason,
      seconds: r.seconds,
      iterations: r.iterations,
      modelCalls: r.model_calls,
      inputTokens: r.input_tokens,
      outputTokens: r.output_tokens,
      costUsd: r.cost_usd,
      changedFiles: r.diff_files,
      outOfPlanFiles: r.out_of_plan_files,
      diffLines: r.diff_lines_added + r.diff_lines_removed,
      firstProgressSeconds: null,
      maxEvents: null,
      maxIdenticalCalls: null,
    });
  }
}
if (rows.length) {
  const groups = {};
  for (const r of rows) (groups[`${r.agent} ${r.task}`] ??= []).push(r);
  const mean = (xs) => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : null);
  const summary = Object.entries(groups).map(([key, rs]) => ({
    agent: rs[0].agent,
    task: rs[0].task,
    runs: rs.length,
    resolved: rs.filter((r) => r.resolved).length,
    meanSeconds: mean(rs.map((r) => r.seconds)),
    meanIterations: mean(rs.map((r) => r.iterations)),
    meanModelCalls: mean(rs.map((r) => r.modelCalls)),
    meanInputTokens: mean(rs.map((r) => r.inputTokens)),
    meanOutputTokens: mean(rs.map((r) => r.outputTokens)),
    outcomes: rs.map((r) => r.outcome),
    key,
  }));
  save('compare.json', { model: 'gpt-oss-20b', runs: rows, summary });
}

// AC3: Trivy counts by severity and target class, and the licences it reports.
const trivy = {};
for (const f of files(path.join(out, 'trivy'), /\.json$/)) {
  const report = read(path.join(out, 'trivy', f));
  const vulns = new Map();
  const licences = new Map();
  for (const r of report.Results ?? []) {
    for (const v of r.Vulnerabilities ?? []) {
      vulns.set(`${v.VulnerabilityID} ${v.PkgName}`, {
        id: v.VulnerabilityID,
        pkg: v.PkgName,
        version: v.InstalledVersion,
        fixed: v.FixedVersion ?? null,
        severity: v.Severity,
        type: r.Type,
      });
    }
    for (const l of r.Licenses ?? []) {
      const k = `${l.Name} ${l.Severity}`;
      licences.set(k, {
        licence: l.Name,
        severity: l.Severity,
        packages: (licences.get(k)?.packages ?? 0) + 1,
      });
    }
  }
  trivy[f.replace(/\.json$/, '')] = {
    vulnerabilities: [...vulns.values()].sort((a, b) => a.id.localeCompare(b.id)),
    licences: [...licences.values()].sort((a, b) => a.licence.localeCompare(b.licence)),
  };
}
if (trivy.node24) {
  const base = new Set(trivy.node24.vulnerabilities.map((v) => `${v.id} ${v.pkg}`));
  const baseLic = new Set(trivy.node24.licences.map((l) => l.licence));
  for (const name of Object.keys(trivy).filter((n) => n !== 'node24')) {
    trivy[name].addedVulnerabilities = trivy[name].vulnerabilities.filter(
      (v) => !base.has(`${v.id} ${v.pkg}`),
    );
    trivy[name].addedLicences = trivy[name].licences.filter((l) => !baseLic.has(l.licence));
  }
}
if (Object.keys(trivy).length) save('trivy.json', trivy);
process.stdout.write(`results: ${fs.readdirSync(results).join(', ')}\n`);
