// Statistics of the evaluation report (task L02, design/ADR-M78 §2.5, §2.6). Standard formulas,
// implemented here and unit-tested against known values:
// - pass@k, the unbiased estimator of "at least one of k runs passes": 1 − C(n−c, k) / C(n, k);
// - pass^k, "all k runs pass": C(c, k) / C(n, k);
// - a percentile bootstrap interval over tasks, with a seeded generator so a report repeats;
// - McNemar's exact test on paired outcomes (two-sided binomial on the discordant pairs);
// - a Bradley-Terry ranking from blind pairwise choices (the MM algorithm), ties as half a win.

/** C(n, k) as a float (n ≤ a few hundred here). */
function choose(n: number, k: number): number {
  if (k < 0 || k > n) return 0;
  let result = 1;
  for (let i = 1; i <= k; i++) result = (result * (n - k + i)) / i;
  return result;
}

function checkCounts(n: number, c: number, k: number): void {
  if (![n, c, k].every((v) => Number.isInteger(v) && v >= 0) || c > n || k < 1 || k > n) {
    throw new RangeError('stats: need integers with 0 ≤ c ≤ n and 1 ≤ k ≤ n');
  }
}

/** Probability that at least one of k runs passes, from c passes in n runs (unbiased). */
export function passAtK(n: number, c: number, k: number): number {
  checkCounts(n, c, k);
  if (n - c < k) return 1;
  return 1 - choose(n - c, k) / choose(n, k);
}

/** Probability that all k runs pass, from c passes in n runs. */
export function passHatK(n: number, c: number, k: number): number {
  checkCounts(n, c, k);
  return choose(c, k) / choose(n, k);
}

/** A small seeded generator (mulberry32): the same seed gives the same report. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const mean = (values: readonly number[]): number =>
  values.reduce((sum, v) => sum + v, 0) / values.length;

export interface Interval {
  readonly estimate: number;
  readonly low: number;
  readonly high: number;
}

/**
 * The mean of per-task values with a 95% percentile bootstrap interval, resampling tasks with
 * replacement. One task: the interval is the value itself (nothing to resample).
 */
export function bootstrapMean(
  perTask: readonly number[],
  options: { readonly samples?: number; readonly seed?: number } = {},
): Interval {
  if (perTask.length === 0) throw new RangeError('stats: no task');
  const estimate = mean(perTask);
  if (perTask.length === 1) return { estimate, low: estimate, high: estimate };
  const random = seededRandom(options.seed ?? 1);
  const samples = options.samples ?? 2000;
  const means: number[] = [];
  for (let s = 0; s < samples; s++) {
    let sum = 0;
    for (let i = 0; i < perTask.length; i++) {
      sum += perTask[Math.floor(random() * perTask.length)]!;
    }
    means.push(sum / perTask.length);
  }
  means.sort((a, b) => a - b);
  const at = (q: number) => means[Math.min(samples - 1, Math.max(0, Math.floor(q * samples)))]!;
  return { estimate, low: at(0.025), high: at(0.975) };
}

/**
 * McNemar's exact test: `b` pairs where only A passed, `c` where only B passed. Two-sided p-value
 * of the binomial test with p = 0.5 on the b + c discordant pairs (1 when there are none).
 */
export function mcnemarExact(b: number, c: number): number {
  if (![b, c].every((v) => Number.isInteger(v) && v >= 0)) throw new RangeError('stats: counts');
  const n = b + c;
  if (n === 0) return 1;
  let tail = 0;
  for (let i = 0; i <= Math.min(b, c); i++) tail += choose(n, i) / 2 ** n;
  return Math.min(1, 2 * tail);
}

export interface PairChoice {
  readonly a: string;
  readonly b: string;
  readonly winner: 'a' | 'b' | 'tie';
}

/**
 * Bradley-Terry strengths from pairwise choices (MM algorithm), normalised to sum to 1. A tie
 * counts as half a win for each side; every compared pair also gets one virtual tie, so a side
 * that never won keeps a strength above 0 and the ranking stays defined with few choices.
 */
export function bradleyTerry(choices: readonly PairChoice[]): Map<string, number> {
  const items = [...new Set(choices.flatMap((c) => [c.a, c.b]))].sort();
  const wins = new Map(items.map((i) => [i, 0]));
  const games = new Map<string, number>();
  const pairKey = (x: string, y: string) => (x < y ? `${x}\u0000${y}` : `${y}\u0000${x}`);
  const add = (x: string, y: string, wx: number, wy: number) => {
    wins.set(x, wins.get(x)! + wx);
    wins.set(y, wins.get(y)! + wy);
    games.set(pairKey(x, y), (games.get(pairKey(x, y)) ?? 0) + 1);
  };
  for (const c of choices) {
    if (c.a === c.b) throw new RangeError('stats: a pair needs two configurations');
    add(
      c.a,
      c.b,
      c.winner === 'a' ? 1 : c.winner === 'tie' ? 0.5 : 0,
      c.winner === 'b' ? 1 : c.winner === 'tie' ? 0.5 : 0,
    );
  }
  for (const key of [...games.keys()]) {
    const [x, y] = key.split('\u0000') as [string, string];
    add(x, y, 0.5, 0.5);
  }
  let strength = new Map(items.map((i) => [i, 1 / items.length]));
  for (let round = 0; round < 1000; round++) {
    const next = new Map<string, number>();
    for (const i of items) {
      let denominator = 0;
      for (const j of items) {
        if (i === j) continue;
        const n = games.get(pairKey(i, j)) ?? 0;
        if (n > 0) denominator += n / (strength.get(i)! + strength.get(j)!);
      }
      next.set(i, denominator === 0 ? strength.get(i)! : wins.get(i)! / denominator);
    }
    const total = [...next.values()].reduce((s, v) => s + v, 0);
    for (const [i, v] of next) next.set(i, v / total);
    const change = Math.max(...items.map((i) => Math.abs(next.get(i)! - strength.get(i)!)));
    strength = next;
    if (change < 1e-9) break;
  }
  return strength;
}
