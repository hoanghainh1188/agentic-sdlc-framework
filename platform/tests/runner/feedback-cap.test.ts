// D-08 E01 AC4 (QUESTIONS #179): the runner cleans and caps the feedback text before the agent's
// prompt: control and bidirectional characters removed, at most REVIEW_FEEDBACK_MAX_CHARS, never a
// half surrogate pair at the cut.
import { describe, expect, it } from 'vitest';

import { capFeedback, REVIEW_FEEDBACK_MAX_CHARS } from '../../apps/runner/src/index.js';

describe('capFeedback (E01 PR 2)', () => {
  it('keeps short text, line feeds and tabs; removes control and bidi characters', () => {
    expect(capFeedback('a\r\nb\tc\u0007d‮e⁦f')).toEqual({
      text: 'a\nb\tc d e f',
      truncated: false,
    });
  });

  it('cuts long text at the cap and says so', () => {
    const capped = capFeedback('x'.repeat(REVIEW_FEEDBACK_MAX_CHARS + 500));
    expect(capped.truncated).toBe(true);
    expect(capped.text.length).toBeLessThanOrEqual(REVIEW_FEEDBACK_MAX_CHARS);
    expect(capped.text).toMatch(/\[The platform cut the feedback here\.\]$/);
  });

  it('never ends on half of a surrogate pair', () => {
    const capped = capFeedback('😀'.repeat(REVIEW_FEEDBACK_MAX_CHARS));
    const beforeNote = capped.text.split('\n[The platform')[0]!;
    expect(/[\uD800-\uDBFF]$/.test(beforeNote)).toBe(false);
  });
});
