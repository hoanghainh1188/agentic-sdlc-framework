// The evaluation report (task L02, design/ADR-M78 §2.5, §2.6): the statistics against values
// computed by hand, the report from synthetic results (numbers only, a difference called only when
// the data shows it), the Pareto chart, and the blind pairwise review (kept diffs are private and
// can be purged; the choices file holds codes only).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { t } from '@sdlc/messages';
import { afterEach, describe, expect, it } from 'vitest';

import {
  appendChoice,
  bootstrapMean,
  bradleyTerry,
  buildReport,
  diffPath,
  mcnemarExact,
  passAtK,
  passHatK,
  pendingPairs,
  purgeDiffs,
  readChoices,
  readDiff,
  renderMarkdown,
  renderParetoSvg,
  seededRandom,
  writeDiff,
  type RunResult,
} from '../../eval/src/index.js';

const dirs: string[] = [];
const temp = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-eval-report-'));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('pass@k and pass^k', () => {
  it.each([
    [5, 2, 1, 0.4],
    [5, 2, 2, 0.7],
    [5, 0, 3, 0],
    [5, 4, 2, 1],
    [5, 5, 5, 1],
  ])('pass@k with n=%i, c=%i, k=%i is %f', (n, c, k, value) => {
    expect(passAtK(n, c, k)).toBeCloseTo(value, 10);
  });

  it.each([
    [5, 2, 2, 0.1],
    [5, 5, 5, 1],
    [5, 4, 5, 0],
    [5, 3, 1, 0.6],
  ])('pass^k with n=%i, c=%i, k=%i is %f', (n, c, k, value) => {
    expect(passHatK(n, c, k)).toBeCloseTo(value, 10);
  });

  it('pass@1 equals pass^1 (the plain resolve rate)', () => {
    expect(passAtK(7, 3, 1)).toBeCloseTo(passHatK(7, 3, 1), 12);
  });

  it.each([
    [5, 6, 1],
    [5, 2, 0],
    [5, 2, 6],
    [5.5, 2, 1],
  ])('refuses n=%f, c=%f, k=%f', (n, c, k) => {
    expect(() => passAtK(n, c, k)).toThrow(RangeError);
  });
});

describe('McNemar exact test', () => {
  it.each([
    [0, 0, 1],
    [0, 5, 0.0625],
    [0, 6, 0.03125],
    [6, 0, 0.03125],
    [3, 3, 1],
    [1, 9, 0.021484375],
  ])('b=%i, c=%i gives p=%f', (b, c, p) => {
    expect(mcnemarExact(b, c)).toBeCloseTo(p, 10);
  });
});

describe('bootstrap interval over tasks', () => {
  it('is the value itself for one task, and for equal values', () => {
    expect(bootstrapMean([0.4])).toEqual({ estimate: 0.4, low: 0.4, high: 0.4 });
    expect(bootstrapMean([0.6, 0.6, 0.6])).toEqual({ estimate: 0.6, low: 0.6, high: 0.6 });
  });

  it('holds the estimate, stays in range, and repeats with the same seed', () => {
    const values = [0, 0.2, 0.4, 1, 1, 0.8, 0.6, 0];
    const one = bootstrapMean(values, { seed: 7 });
    expect(one.estimate).toBeCloseTo(0.5, 10);
    expect(one.low).toBeLessThanOrEqual(one.estimate);
    expect(one.high).toBeGreaterThanOrEqual(one.estimate);
    expect(one.low).toBeGreaterThanOrEqual(0);
    expect(one.high).toBeLessThanOrEqual(1);
    expect(bootstrapMean(values, { seed: 7 })).toEqual(one);
    expect(() => bootstrapMean([])).toThrow(RangeError);
  });

  it('the generator repeats and stays in [0, 1)', () => {
    const a = seededRandom(3);
    const b = seededRandom(3);
    for (let i = 0; i < 100; i++) {
      const x = a();
      expect(x).toBe(b());
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
    }
  });
});

describe('Bradley-Terry ranking', () => {
  it('ranks the configuration people prefer higher, and sums to 1', () => {
    const s = bradleyTerry([
      { a: 'x', b: 'y', winner: 'a' },
      { a: 'x', b: 'y', winner: 'a' },
      { a: 'y', b: 'x', winner: 'b' },
      { a: 'y', b: 'z', winner: 'a' },
      { a: 'x', b: 'z', winner: 'a' },
    ]);
    expect(s.get('x')!).toBeGreaterThan(s.get('y')!);
    expect(s.get('y')!).toBeGreaterThan(s.get('z')!);
    expect([...s.values()].reduce((a, b) => a + b, 0)).toBeCloseTo(1, 9);
    // The virtual tie keeps a configuration that never won above 0.
    expect(s.get('z')!).toBeGreaterThan(0);
  });

  it('gives equal strengths for ties only, and nothing for no choice', () => {
    const s = bradleyTerry([{ a: 'x', b: 'y', winner: 'tie' }]);
    expect(s.get('x')).toBeCloseTo(0.5, 9);
    expect(s.get('y')).toBeCloseTo(0.5, 9);
    expect(bradleyTerry([]).size).toBe(0);
    expect(() => bradleyTerry([{ a: 'x', b: 'x', winner: 'a' }])).toThrow(RangeError);
  });
});

function run(
  configuration: string,
  task: string,
  n: number,
  resolved: boolean,
  over: Partial<RunResult> = {},
): RunResult {
  return {
    schema: 1,
    task_set: 1,
    task,
    configuration,
    model: `${configuration}-model`,
    agent_version: '1.0.0',
    instructions_sha256: 'a'.repeat(64),
    run: n,
    outcome: 'finished',
    status: 'succeeded',
    stop_reason: null,
    applied: true,
    resolved,
    fail_to_pass_passed: resolved,
    pass_to_pass_passed: true,
    ci_passed: resolved,
    scope_breach: false,
    out_of_plan_files: 0,
    lint_findings: 0,
    diff_files: 1,
    diff_lines_added: 2,
    diff_lines_removed: 1,
    seconds: 60 * n,
    iterations: 5,
    model_calls: 5,
    input_tokens: 1000,
    output_tokens: 100,
    cached_input_tokens: 0,
    cost_usd: '0.001000',
    ...over,
  };
}

/** `strong` resolves every run of 8 tasks; `weak` resolves none: a difference the data shows. */
function results(): RunResult[] {
  const out: RunResult[] = [];
  for (const task of ['t-a', 't-b', 't-c', 't-d', 't-e', 't-f', 't-g', 't-h']) {
    for (let n = 1; n <= 3; n++) {
      out.push(run('strong', task, n, true));
      out.push(run('weak', task, n, false, { status: 'stopped_timeout', cost_usd: '0.000500' }));
    }
  }
  return out;
}

describe('the report (AC3, AC4)', () => {
  it('summarises each configuration with exact money and the pass measures', () => {
    const report = buildReport(results(), 1);
    const strong = report.configurations.find((c) => c.configuration === 'strong')!;
    const weak = report.configurations.find((c) => c.configuration === 'weak')!;
    expect(strong).toMatchObject({
      tasks: 8,
      runs: 24,
      k: 3,
      passAt1: 1,
      passAtK: 1,
      passHatK: 1,
      ciFirstTry: 1,
      stopped: 0,
      medianSeconds: 120,
      totalCostUsd: '0.024000',
      costPerResolvedUsd: '0.001000',
    });
    expect(strong.resolved).toEqual({ estimate: 1, low: 1, high: 1 });
    expect(weak).toMatchObject({
      passAtK: 0,
      stopped: 24,
      totalCostUsd: '0.012000',
      costPerResolvedUsd: null,
    });
  });

  it('calls a difference only when the data shows it (intervals apart and p < 0.05)', () => {
    const [c] = buildReport(results(), 1).comparisons;
    expect(c).toMatchObject({
      a: 'strong',
      b: 'weak',
      pairs: 24,
      onlyA: 24,
      onlyB: 0,
      better: 'strong',
    });
    expect(c!.pValue).toBeLessThan(0.05);
    // Two runs of one task: not enough to call anything.
    const few = buildReport([run('x', 't', 1, true), run('y', 't', 1, false)], 1).comparisons[0]!;
    expect(few).toMatchObject({ pairs: 1, onlyA: 1, better: null });
  });

  it('reads only the requested task set version', () => {
    const other = results().map((r) => ({ ...r, task_set: 2 }));
    expect(buildReport(other, 1).configurations).toEqual([]);
  });

  it('renders Markdown with catalog labels, the per-task rows and the ranking', () => {
    const report = buildReport(results(), 1, [
      { a: 'strong', b: 'weak', winner: 'a' },
      { a: 'weak', b: 'strong', winner: 'b' },
    ]);
    const md = renderMarkdown(report);
    expect(md).toContain(t('eval.report.title', { version: 1 }));
    expect(md).toContain('| strong | strong-model | 24 | 100% (100%–100%) |');
    expect(md).toContain('| t-a | weak | 0 / 3 |');
    expect(md).toContain(t('eval.report.ranking_note', { choices: 2 }));
    expect(md.indexOf('- strong:')).toBeLessThan(md.indexOf('- weak:'));
    expect(renderMarkdown(buildReport(results(), 1))).toContain(t('eval.report.no_pairs'));
  });

  it('draws one point per configuration and escapes names in the chart', () => {
    const svg = renderParetoSvg(buildReport(results(), 1));
    expect(svg.match(/<circle /g)).toHaveLength(2);
    expect(svg.startsWith('<svg ')).toBe(true);
    expect(svg).toContain(t('eval.report.chart_x'));
    const odd = renderParetoSvg(buildReport([run('a-b', 't', 1, true)], 1));
    expect(odd).not.toMatch(/<script/);
  });
});

describe('blind pairwise review (AC7, QUESTIONS #445)', () => {
  const key = (configuration: string, task: string, n: number) => ({
    taskSet: 1,
    configuration,
    task,
    run: n,
  });

  it('keeps diffs private: folders 700, files 600, never inside a result', () => {
    const out = temp();
    writeDiff(out, key('x', 'feat-tax', 1), 'diff --git a/a b/a\n');
    const file = diffPath(out, key('x', 'feat-tax', 1));
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
    expect(fs.statSync(path.join(out, 'diffs')).mode & 0o777).toBe(0o700);
    expect(readDiff(out, key('x', 'feat-tax', 1))).toBe('diff --git a/a b/a\n');
    expect(readDiff(out, key('x', 'feat-tax', 2))).toBeNull();
  });

  it('lists the pairs both configurations have, until they are chosen', () => {
    const out = temp();
    for (const [c, task, n] of [
      ['x', 'feat-tax', 1],
      ['y', 'feat-tax', 1],
      ['x', 'feat-tax', 2],
      ['x', 'bug-a', 1],
      ['y', 'bug-a', 1],
    ] as const) {
      writeDiff(out, key(c, task, n), 'd\n');
    }
    expect(pendingPairs(out, 1, 'x', 'y')).toEqual([
      { task: 'bug-a', run: 1 },
      { task: 'feat-tax', run: 1 },
    ]);
    appendChoice(out, 1, { schema: 1, task: 'bug-a', run: 1, a: 'y', b: 'x', winner: 'tie' });
    expect(pendingPairs(out, 1, 'x', 'y')).toEqual([{ task: 'feat-tax', run: 1 }]);
    expect(readChoices(out, 1)).toEqual([
      { schema: 1, task: 'bug-a', run: 1, a: 'y', b: 'x', winner: 'tie' },
    ]);
  });

  it('refuses a choice record with text or the same configuration twice', () => {
    const out = temp();
    const bad = [
      { schema: 1, task: 'bug-a', run: 1, a: 'x', b: 'x', winner: 'a' },
      { schema: 1, task: 'bug-a', run: 1, a: 'x', b: 'y', winner: 'a', note: 'A is clearer' },
      { schema: 1, task: 'bug-a', run: 0, a: 'x', b: 'y', winner: 'a' },
      { schema: 1, task: 'bug-a', run: 1, a: 'x', b: 'y', winner: 'maybe' },
    ];
    for (const choice of bad) {
      expect(() => appendChoice(out, 1, choice as never)).toThrow(TypeError);
    }
  });

  it('purges every kept diff and says how many', () => {
    const out = temp();
    writeDiff(out, key('x', 'feat-tax', 1), 'd\n');
    writeDiff(out, key('y', 'feat-tax', 1), 'd\n');
    expect(purgeDiffs(out)).toBe(2);
    expect(fs.existsSync(path.join(out, 'diffs'))).toBe(false);
    expect(purgeDiffs(out)).toBe(0);
  });
});
