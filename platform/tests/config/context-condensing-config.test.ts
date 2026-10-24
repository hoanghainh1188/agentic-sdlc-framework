// Context condensing settings (X11 AC2, design/ADR-M29 §2.10, QUESTIONS #551–#554):
// `run.context_condensing` is off by default; `summarize` needs a context size for at least one
// model and fewer kept events than the maximum (rule M35, an error).
import { formatIssue, MAX_CONTEXT_TOKENS, MIN_CONTEXT_TOKENS } from '@sdlc/config';
import { describe, expect, it } from 'vitest';

import { keysAndPaths, loadErrors, loadValid } from './helpers';

const condensing = (lines: string) =>
  `run:\n  context_condensing:\n${lines
    .split('\n')
    .map((line) => `    ${line}`)
    .join('\n')}\n`;

describe('run.context_condensing', () => {
  it('is off by default, with OpenHands values for small models and no context size', () => {
    const { config, warnings } = loadValid();
    expect(config.run.context_condensing).toEqual({
      mode: 'off',
      max_events: 120,
      keep_first: 2,
      model_context_tokens: {},
    });
    expect(warnings).toEqual([]);
  });

  it('accepts summarize with the context size of a model', () => {
    const { config } = loadValid(
      condensing('mode: summarize\nmodel_context_tokens:\n  gpt-oss-20b: 32768'),
    );
    expect(config.run.context_condensing.mode).toBe('summarize');
    expect(config.run.context_condensing.model_context_tokens).toEqual({ 'gpt-oss-20b': 32768 });
  });

  it('accepts model names as the Run Contract writes them (slash, colon, at sign)', () => {
    const { config } = loadValid(
      condensing('mode: summarize\nmodel_context_tokens:\n  "org/model:7b@v2": 8192'),
    );
    expect(Object.keys(config.run.context_condensing.model_context_tokens)).toEqual([
      'org/model:7b@v2',
    ]);
  });

  it('refuses summarize when no context size is known (rule M35)', () => {
    const errors = loadErrors(condensing('mode: summarize'));
    expect(keysAndPaths(errors)).toEqual([
      ['config.rule.condensing_context_unknown', 'run.context_condensing.model_context_tokens'],
    ]);
    expect(formatIssue(errors[0]!)).toBe(
      "run.context_condensing.model_context_tokens: context condensing needs the context size of the run's model; without one it is never on (rule M35, D-08 X11).",
    );
  });

  it('refuses summarize that keeps as many events at the start as its maximum (rule M35)', () => {
    const errors = loadErrors(
      condensing(
        'mode: summarize\nmax_events: 10\nkeep_first: 10\nmodel_context_tokens:\n  m: 8192',
      ),
    );
    expect(keysAndPaths(errors)).toEqual([
      ['config.rule.condensing_keep_first', 'run.context_condensing.keep_first'],
    ]);
    expect(formatIssue(errors[0]!)).toBe(
      'run.context_condensing.keep_first: context condensing must keep at most 9 events at the start, fewer than run.context_condensing.max_events (rule M35).',
    );
  });

  it('checks nothing more while off: sizes may be listed before condensing is turned on', () => {
    expect(
      loadValid(condensing('max_events: 10\nkeep_first: 10\nmodel_context_tokens:\n  m: 8192'))
        .config.run.context_condensing.mode,
    ).toBe('off');
  });

  it('refuses unknown modes, out-of-range numbers and bad model names (schema)', () => {
    expect([MIN_CONTEXT_TOKENS, MAX_CONTEXT_TOKENS]).toEqual([4096, 2_000_000]);
    const pathOf = (yaml: string) => keysAndPaths(loadErrors(condensing(yaml)))[0]?.[1];
    expect(pathOf('mode: truncate')).toBe('run.context_condensing.mode');
    expect(pathOf('max_events: 9')).toBe('run.context_condensing.max_events');
    expect(pathOf('max_events: 1001')).toBe('run.context_condensing.max_events');
    expect(pathOf('keep_first: 51')).toBe('run.context_condensing.keep_first');
    expect(pathOf('model_context_tokens:\n  m: 4095')).toMatch(
      /^run\.context_condensing\.model_context_tokens/,
    );
    expect(pathOf('model_context_tokens:\n  m: 2000001')).toMatch(
      /^run\.context_condensing\.model_context_tokens/,
    );
    expect(pathOf('model_context_tokens:\n  "bad name": 8192')).toMatch(
      /^run\.context_condensing\.model_context_tokens/,
    );
  });
});
