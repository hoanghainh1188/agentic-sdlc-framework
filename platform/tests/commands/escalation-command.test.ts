// D-08 B11 AC5 (static part): the `/ack` and `/decide` grammar, their replies from the message
// catalog and the escalation notices (design/ADR-M28 §2.5, §2.7). Live behaviour:
// tests/integration/db/escalation-commands.test.ts.
import { catalogFor, placeholdersOf } from '@sdlc/messages';
import { describe, expect, it } from 'vitest';

import { parseCommentCommand } from '../../packages/core/src/commands/comment-command.js';
import {
  ESCALATION_NOTICE_KEYS,
  renderEscalationNotice,
} from '../../packages/core/src/git-events/escalation-notices.js';
import { renderCommentReply } from '../../packages/core/src/git-events/replies.js';
import { ESCALATION_NOTICE_KINDS } from '@sdlc/contracts';

const en = catalogFor('en')!;

describe('/ack and /decide grammar', () => {
  it.each([
    ['/ack', { kind: 'escalation_ack', code: null }],
    ['/ack ESC-2026-0001', { kind: 'escalation_ack', code: 'ESC-2026-0001' }],
    ['/Ack esc-2026-0012\n\nOn it.', { kind: 'escalation_ack', code: 'ESC-2026-0012' }],
  ])('%j → %o', (body, expected) => {
    expect(parseCommentCommand(body)).toEqual({ verb: 'ack', ...expected });
  });

  it.each([
    ['/decide resume', null, 'resume', null],
    ['/decide ESC-2026-0001 resume', 'ESC-2026-0001', 'resume', null],
    [
      '/decide ESC-2026-0001 roll-back ci_failed the tests broke',
      'ESC-2026-0001',
      'roll_back',
      'ci_failed',
    ],
    ['/decide terminate out_of_scope', null, 'terminate', 'out_of_scope'],
    ['/decide modify\nPlease re-plan AC3.', null, 'modify', null],
    ['/decide escalate', null, 'escalate_further', null],
    ['/decide Escalate-Further budget_exceeded', null, 'escalate_further', 'budget_exceeded'],
  ])('%j → code %s, %s (%s)', (body, code, decision, reasonCode) => {
    expect(parseCommentCommand(body)).toEqual({
      kind: 'escalation_decision',
      verb: 'decide',
      code,
      decision,
      reasonCode,
    });
  });

  it.each([
    ['/ack but I disagree', 'unexpected_text'],
    ['/ack ESC-2026-0001 later', 'unexpected_text'],
    ['/ack ESC-1', 'unexpected_text'],
    ['/decide', 'decision_missing'],
    ['/decide ESC-2026-0001', 'decision_missing'],
    ['/decide approve', 'decision_invalid'],
    ['/decide ESC-2026-0001 ok', 'decision_invalid'],
  ])('%j is refused with %s', (body, problem) => {
    expect(parseCommentCommand(body)).toMatchObject({ kind: 'invalid', problem });
  });

  it('never returns text from the comment, only codes', () => {
    const parsed = parseCommentCommand('/decide resume secret words alice@example.com');
    expect(JSON.stringify(parsed)).not.toMatch(/secret|alice|example/);
  });
});

describe('escalation replies and notices from the catalog', () => {
  it('replies name the command and show the escalation syntax', () => {
    const reply = renderCommentReply(
      'syntax_decision_missing',
      { command: 'decide' },
      'github:comment:1',
    );
    expect(reply).toContain('`/decide` needs a decision');
    expect(reply).toContain('/ack [ESC-YYYY-NNNN]');
    const refused = renderCommentReply(
      'escalation_forbidden',
      { command: 'ack' },
      'github:comment:2',
    );
    expect(refused.startsWith('/ack: nothing was recorded.')).toBe(true);
  });

  it('every notice kind has a catalog text with the same placeholders', () => {
    for (const kind of ESCALATION_NOTICE_KINDS) {
      const key = ESCALATION_NOTICE_KEYS[kind];
      expect(key, kind).toBeDefined();
      expect(en[key!], kind).toBeDefined();
      for (const name of placeholdersOf(en[key!]!)) {
        expect(['code', 'severity', 'level', 'step', 'mentions', 'due', 'resolve_due']).toContain(
          name,
        );
      }
    }
  });

  it('renders a notice with mentions, the deadline in UTC and a marker', () => {
    const body = renderEscalationNotice(
      'raised',
      {
        code: 'ESC-2026-0001',
        severity: 'critical',
        response_level: 'pause',
        current_step: 'owner',
        step_due_at: new Date('2026-09-28T03:15:00Z'),
        resolve_due_at: new Date('2026-09-28T04:00:00Z'),
      },
      'owner',
      ['@bob', '@gina'],
    );
    expect(body).toContain('**Escalation ESC-2026-0001** (critical, response level pause)');
    expect(body).toContain(
      '@bob @gina: acknowledge it with `/ack ESC-2026-0001` by 2026-09-28 03:15 UTC',
    );
    expect(body).toContain('<!-- sdlc-escalation ESC-2026-0001 raised owner -->');
    const nobody = renderEscalationNotice(
      'ack_overdue',
      {
        code: 'ESC-2026-0002',
        severity: 'low',
        response_level: 'notify',
        current_step: 'governance',
        step_due_at: new Date('2026-09-28T03:15:00Z'),
        resolve_due_at: null,
      },
      'governance',
      [],
    );
    expect(nobody).toContain('Nobody holds this role on the project yet');
  });
});
