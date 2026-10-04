// Loop detection settings (C11 PR 2, D-02 FR-35, design/ADR-M42 §2.7, QUESTIONS #184):
// `run.loop_detection.no_progress_window_minutes` is at most 30 (rule M27, an error) and gives a
// warning under 5. The default configuration is unchanged, so stored configuration hashes are too
// (the pinned hash is in hash.test.ts).
import {
  formatIssue,
  MAX_NO_PROGRESS_WINDOW_MINUTES,
  MIN_NO_PROGRESS_WINDOW_MINUTES,
} from '@sdlc/config';
import { describe, expect, it } from 'vitest';

import { keysAndPaths, loadErrors, loadValid } from './helpers';

const window = (minutes: number) =>
  `run:\n  loop_detection:\n    no_progress_window_minutes: ${String(minutes)}\n`;

describe('run.loop_detection.no_progress_window_minutes', () => {
  it('defaults to 15 minutes with a threshold of 3, without a warning', () => {
    const { config, warnings } = loadValid();
    expect(config.run.loop_detection).toEqual({
      identical_tool_calls_max: 3,
      no_progress_window_minutes: 15,
    });
    expect(warnings).toEqual([]);
  });

  it('accepts 5 to 30 minutes without a warning', () => {
    expect([MIN_NO_PROGRESS_WINDOW_MINUTES, MAX_NO_PROGRESS_WINDOW_MINUTES]).toEqual([5, 30]);
    expect(loadValid(window(5)).warnings).toEqual([]);
    expect(loadValid(window(30)).warnings).toEqual([]);
  });

  it('refuses more than 30 minutes (rule M27)', () => {
    const errors = loadErrors(window(31));
    expect(keysAndPaths(errors)).toEqual([
      ['config.rule.loop_window_max', 'run.loop_detection.no_progress_window_minutes'],
    ]);
    expect(formatIssue(errors[0]!)).toBe(
      'run.loop_detection.no_progress_window_minutes: loop detection must stop a run that makes no progress after at most 30 minutes (rule M27, D-02 FR-35).',
    );
  });

  it('warns under 5 minutes: a long silent command may stop a healthy run', () => {
    const { warnings } = loadValid(window(4));
    expect(keysAndPaths(warnings)).toEqual([
      ['config.warning.loop_window_short', 'run.loop_detection.no_progress_window_minutes'],
    ]);
    expect(formatIssue(warnings[0]!)).toBe(
      'run.loop_detection.no_progress_window_minutes: a run that shows no progress for 4 minutes (less than 5) is stopped. A long silent command such as a package install may stop a healthy run. This change must be reviewed.',
    );
  });

  it('refuses 0 and fractions (schema)', () => {
    expect(keysAndPaths(loadErrors(window(0)))[0]?.[1]).toBe(
      'run.loop_detection.no_progress_window_minutes',
    );
  });
});
