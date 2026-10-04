// D-08 E01 AC4 (QUESTIONS #179, #190): the feedback of a `/request-changes G7` comment is its reason
// text: the rest of the command line after the gate and the optional reason code, then the lines
// below. A comment that is not that command (edited since) gives none.
import { describe, expect, it } from 'vitest';

import { requestChangesReason } from '../../packages/core/src/commands/comment-command.js';

describe('requestChangesReason (E01 PR 2)', () => {
  it.each([
    ['/request-changes G7 fix the totals', 'fix the totals'],
    ['/request-changes g7 tests_insufficient add a test', 'add a test'],
    ['/request-changes G7 tests-insufficient\nline two\nline three', 'line two\nline three'],
    ['\n\n/request-changes G7 other round down\nper rate', 'round down\nper rate'],
    ['/request-changes G7 spec_unclear', ''],
  ])('%j → %j', (body, reason) => {
    expect(requestChangesReason(body, 'G7')).toBe(reason);
  });

  it.each([
    'please /request-changes G7 fix',
    '/request-changes G6 fix it',
    '/reject G7 tests_insufficient',
    '/approve G7',
    '/request-changes G7',
    '',
  ])('%j → null', (body) => {
    expect(requestChangesReason(body, 'G7')).toBeNull();
  });
});
