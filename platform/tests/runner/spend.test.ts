// C07 (ADR-M34 §2.6): the runner's spend watch on the run's own key.
import type { RedactedSecret, RunKeySpendReader, SpendInfo } from '@sdlc/contracts';
import { describe, expect, it } from 'vitest';

import { SpendWatch, type BudgetWarning } from '../../apps/runner/src/index.js';

const key = { reveal: () => 'sk-run', toString: () => '[redacted]' } as RedactedSecret;

function watch(answers: (SpendInfo | Error)[], limits = { warnPercent: 80, stopPercent: 100 }) {
  let reads = 0;
  const reader: RunKeySpendReader = {
    readOwnSpend: () => {
      const answer = answers[Math.min(reads, answers.length - 1)]!;
      reads += 1;
      return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
    },
  };
  const warnings: BudgetWarning[] = [];
  const w = new SpendWatch({
    reader,
    key,
    contractCapUsd: '1',
    limits,
    onWarning: (warning) => {
      warnings.push(warning);
      return Promise.resolve();
    },
  });
  return { w, warnings, reads: () => reads };
}

describe('SpendWatch', () => {
  it('warns once at the warning share and stops at the stop share of the key cap', async () => {
    const { w, warnings } = watch([
      { spendUsd: '0.2', maxBudgetUsd: '0.5' },
      { spendUsd: '0.4', maxBudgetUsd: '0.5' },
      { spendUsd: '0.45', maxBudgetUsd: '0.5' },
      { spendUsd: '0.5', maxBudgetUsd: '0.5' },
    ]);
    expect(await w.check()).toBe('ok');
    expect(await w.check()).toBe('ok');
    expect(await w.check()).toBe('ok');
    expect(await w.check()).toBe('stop');
    expect(warnings).toEqual([{ spend_usd: '0.4', max_budget_usd: '0.5', percent: 80 }]);
  });

  it('a warning that cannot be recorded never stops the check', async () => {
    let reads = 0;
    const w = new SpendWatch({
      reader: {
        readOwnSpend: () => {
          reads += 1;
          return Promise.resolve({ spendUsd: '1', maxBudgetUsd: '1' });
        },
      },
      key,
      contractCapUsd: '1',
      limits: { warnPercent: 80, stopPercent: 100 },
      onWarning: () => Promise.reject(new Error('database down')),
    });
    expect(await w.check()).toBe('stop');
    expect(reads).toBe(1);
  });

  it('uses the contract cap when the gateway reports none', async () => {
    const { w } = watch([{ spendUsd: '0.99', maxBudgetUsd: null }]);
    expect(await w.check()).toBe('ok');
    const { w: over } = watch([{ spendUsd: '1', maxBudgetUsd: null }]);
    expect(await over.check()).toBe('stop');
  });

  it('a failed read or a zero cap is unknown, never a stop', async () => {
    expect(await watch([new Error('down')]).w.check()).toBe('unknown');
    expect(await watch([{ spendUsd: '1', maxBudgetUsd: '0' }]).w.check()).toBe('unknown');
  });

  it('settleAfterError: reads again after the wait when the first read is below the stop share', async () => {
    const late = watch([
      { spendUsd: '0.1', maxBudgetUsd: '0.5' },
      { spendUsd: '0.5', maxBudgetUsd: '0.5' },
    ]);
    const waits: number[] = [];
    const sleep = (ms: number) => {
      waits.push(ms);
      return Promise.resolve();
    };
    expect(await late.w.settleAfterError(sleep, 5000)).toBe(true);
    expect(waits).toEqual([5000]);
    expect(late.reads()).toBe(2);

    const now = watch([{ spendUsd: '0.5', maxBudgetUsd: '0.5' }]);
    expect(await now.w.settleAfterError(sleep, 5000)).toBe(true);
    expect(now.reads()).toBe(1); // no wait needed

    const low = watch([{ spendUsd: '0.1', maxBudgetUsd: '0.5' }]);
    expect(await low.w.settleAfterError(sleep, 5000)).toBe(false);
    expect(low.reads()).toBe(2); // exactly one re-read: bounded
  });
});
