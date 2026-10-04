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
      for (const gate of ['G1', 'G2', 'G3', 'G4', 'G7', 'G8'] as const) {
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

  it('a HOTL pass says when its block window closes and how to block it', () => {
    const body = renderIntentNotice(
      { id: '16', kind: 'hotl_passed', gate: 'G3', previous_gate: 'G2' },
      { ...view, deciders: [], windowEnd: new Date('2026-09-28T06:00:00Z') },
    );
    expect(body).toContain('the platform passed **G2** (HOTL)');
    expect(body).toContain('now waits at **G3**');
    expect(body).toContain('@bob: until **2026-09-28 06:00 UTC**');
    expect(body).toContain('`/request-changes G2 <reason>`');
  });

  it('C06: a run proposal names the agent and the base commit, and how to decide G4', () => {
    const body = renderIntentNotice(
      { id: '21', kind: 'run_proposed', gate: 'G4', previous_gate: null },
      { ...view, deciders: [], agentKey: 'coder-openhands', baseSha: '1111111111ab' },
    );
    expect(body).toContain('waits at **G4**');
    expect(body).toContain('agent `coder-openhands`, base commit `1111111111ab`');
    expect(body).toContain('@bob: decide with `/approve G4`');
  });

  it('C06: a G4 refusal, a block and the recertification warning name their reason', () => {
    const refused = renderIntentNotice(
      { id: '22', kind: 'g4_refused', gate: 'G4', previous_gate: null },
      { ...view, reasonCode: 'instructions_mismatch' },
    );
    expect(refused).toContain('a G4 check failed (reason code `instructions_mismatch`)');
    const blocked = renderIntentNotice(
      { id: '23', kind: 'blocked', gate: 'G4', previous_gate: 'G4' },
      { ...view, reasonCode: 'policy_denied' },
    );
    expect(blocked).toContain('was blocked at **G4**');
    expect(blocked).toContain('The agent never runs');
    const due = renderIntentNotice(
      { id: '24', kind: 'agent_recertification_due', gate: 'G4', previous_gate: null },
      { ...view, agentKey: 'coder-openhands' },
    );
    expect(due).toContain('agent `coder-openhands`, whose recertification is overdue');
    expect(due).toContain('The run is not blocked');
  });

  it('a return names who sent the gate back and the gate the intent left', () => {
    const body = renderIntentNotice(
      { id: '17', kind: 'returned', gate: 'G3', previous_gate: 'G4' },
      { ...view, reasonCode: 'tests_insufficient' },
    );
    expect(body).toContain('@alice requested changes at **G3** within its block window');
    expect(body).toContain('went back from G4 to **G3**');
    expect(body).toContain('`tests_insufficient`');
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

  it('E03: the G8 review asks Person B to approve the release; the client note only for client_format', () => {
    const notice = { id: '41', kind: 'g8_review_needed', gate: 'G8', previous_gate: 'G8' } as const;
    const standard = renderIntentNotice(notice, { ...view, deciders: [] });
    expect(standard).toContain('`/approve G8`');
    expect(standard).toContain('`/reject G8 <reason>`');
    expect(standard).not.toContain('Client disclosure');
    const client = renderIntentNotice(notice, {
      ...view,
      deciders: [],
      clientRecordRef: 'https://docs.example.com/ai-record',
    });
    expect(client).toContain('Client disclosure');
    expect(client).toContain('https://docs.example.com/ai-record');
  });

  it('E03: release, a request for changes at G8 and terminate at G8 have their own texts', () => {
    expect(intentNoticeKey({ kind: 'released', gate: 'G8' })).toBe('intent.status.released');
    expect(intentNoticeKey({ kind: 'terminated', gate: 'G8' })).toBe('intent.status.g8_terminated');
    const body = renderIntentNotice(
      { id: '42', kind: 'g8_changes_requested', gate: 'G8', previous_gate: 'G8' },
      view,
    );
    expect(body).toContain('a fix needs a new intent');
  });
});
