// B07 (FR-22, ADR-M30 §2.5): the gate status comments are rendered from the message catalog, name
// the deciders and the people who act next, and carry a hidden marker. Posting: integration/db.
import { describe, expect, it } from 'vitest';

import { INTENT_NOTICE_KINDS } from '../../packages/core/src/db/repositories/intent-notices.js';
import {
  intentNoticeKey,
  renderIntentNotice,
} from '../../packages/core/src/git-events/intent-notices.js';
import { t } from '../../packages/messages/src/index.js';

const view = {
  code: 'INT-2026-0007',
  deciders: ['@alice'],
  mentions: ['@bob'],
  reasonCode: null,
};

describe('B07: gate status comments', () => {
  it('every notice kind has a catalog text', () => {
    for (const kind of INTENT_NOTICE_KINDS) {
      for (const gate of ['G1', 'G2', 'G3', 'G4'] as const) {
        expect(t(intentNoticeKey({ kind, gate }))).not.toBe(intentNoticeKey({ kind, gate }));
      }
    }
  });

  it('an advance names the approver, the next gate and who acts next', () => {
    const body = renderIntentNotice(
      { id: '12', kind: 'advanced', gate: 'G3', previous_gate: 'G2' },
      view,
    );
    expect(body).toContain('**INT-2026-0007**: G2 was approved by @alice');
    expect(body).toContain(`**G3** (${t('gate.name.g3')})`);
    expect(body).toContain('@bob: decide with `/approve G3`');
    expect(body).toContain(t('intent.status.footer'));
    expect(body).toContain('<!-- sdlc-status INT-2026-0007 advanced G3 12 -->');
  });

  it('a gate the platform checks (G4) asks nobody to comment', () => {
    const body = renderIntentNotice(
      { id: '13', kind: 'advanced', gate: 'G4', previous_gate: 'G3' },
      { ...view, mentions: [] },
    );
    expect(body).toContain(t('gate.name.g4'));
    expect(body).not.toContain('/approve G4');
  });

  it('a rejection shows the reason code, never text', () => {
    const body = renderIntentNotice(
      { id: '14', kind: 'rejected', gate: 'G1', previous_gate: 'G1' },
      { ...view, reasonCode: 'spec_unclear' },
    );
    expect(body).toContain('`spec_unclear`');
    expect(body).toContain('The intent is closed.');
  });

  it('nobody holding the role is said plainly', () => {
    const body = renderIntentNotice(
      { id: '15', kind: 'submitted', gate: 'G1', previous_gate: null },
      { ...view, deciders: [], mentions: [] },
    );
    expect(body).toContain(t('escalation.notice.nobody'));
  });
});
