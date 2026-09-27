// D-08 C10: the agent register's formats, status moves and recertification clock (handbook Ch.20,
// design/ADR-M31). Pure functions; the database part is in tests/integration/db/agents.test.ts.
import { AGENT_STATUSES } from '@sdlc/contracts';
import { t } from '@sdlc/messages';
import { describe, expect, it } from 'vitest';

import {
  AGENT_REGISTER_ERROR_MESSAGES,
  AgentRegisterError,
  agentRegisterErrorMessage,
} from '../../packages/core/src/agents/errors.js';
import {
  addMonths,
  AGENT_CHANGEABLE_STATUSES,
  AGENT_STATUS_MOVES,
  checkEnvironments,
  checkMaxAutonomy,
  checkModelRef,
  checkTools,
  instructionsSha256,
  isCalendarDay,
  parseInstructionsRef,
  recertificationStatus,
} from '../../packages/core/src/agents/rules.js';

const field = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (error) {
    if (error instanceof AgentRegisterError) return error.field;
    throw error;
  }
  return undefined;
};

describe('status moves (AC1, handbook Ch.20 §20.3–§20.10)', () => {
  it('lists every status', () => {
    expect(Object.keys(AGENT_STATUS_MOVES).sort()).toEqual([...AGENT_STATUSES].sort());
  });

  it('allows exactly the moves of the lifecycle; retired is final', () => {
    expect(AGENT_STATUS_MOVES).toEqual({
      proposed: ['active', 'retired'],
      active: ['suspended', 'quarantined', 'retired'],
      suspended: ['active', 'quarantined', 'retired'],
      quarantined: ['suspended', 'retired'],
      retired: [],
    });
  });

  it('never reactivates a quarantined agent directly (reviewed as suspended first)', () => {
    expect(AGENT_STATUS_MOVES.quarantined).not.toContain('active');
  });

  it('changes the configuration only while proposed or suspended (Ch.20 §20.9)', () => {
    expect(AGENT_CHANGEABLE_STATUSES).toEqual(['proposed', 'suspended']);
  });
});

describe('formats', () => {
  it('model_ref is a gateway model name that names its version (ADR-M31 §2.4)', () => {
    for (const ok of ['claude-haiku-4-5-20251001', 'gpt-oss-20b', 'anthropic/claude-haiku-4-5']) {
      expect(() => checkModelRef(ok)).not.toThrow();
    }
    for (const bad of ['claude-haiku', 'gpt-oss', 'claude-latest-4', 'model with space', '']) {
      expect(
        field(() => checkModelRef(bad)),
        bad,
      ).toBe('model_ref');
    }
  });

  it('instructions_ref is a relative repository path and a version label', () => {
    expect(parseInstructionsRef('AGENTS.md@v5')).toEqual({ path: 'AGENTS.md', label: 'v5' });
    expect(parseInstructionsRef('docs/agents/coder.md@2026-09')).toEqual({
      path: 'docs/agents/coder.md',
      label: '2026-09',
    });
    for (const bad of [
      'AGENTS.md',
      '/etc/passwd@v1',
      '../AGENTS.md@v1',
      'docs/../AGENTS.md@v1',
      './AGENTS.md@v1',
      'docs//AGENTS.md@v1',
      'AGENTS.md@',
      'AGENTS md@v1',
    ]) {
      expect(
        field(() => parseInstructionsRef(bad)),
        bad,
      ).toBe('instructions_ref');
    }
  });

  it('tools are codes; the list is sorted and unique', () => {
    expect(checkTools(['terminal', 'file_editor', 'terminal'])).toEqual([
      'file_editor',
      'terminal',
    ]);
    expect(field(() => checkTools(['rm -rf']))).toBe('allowed_tools');
  });

  it('autonomy at most L2 in the MVP (D-02 FR-03)', () => {
    expect(checkMaxAutonomy('L0')).toBe('L0');
    expect(checkMaxAutonomy('L2')).toBe('L2');
    for (const bad of ['L3', 'L4', 'high']) {
      expect(
        field(() => checkMaxAutonomy(bad)),
        bad,
      ).toBe('max_autonomy');
    }
  });

  it('environments come from template T6', () => {
    expect(checkEnvironments(['staging', 'sandbox', 'sandbox'])).toEqual(['sandbox', 'staging']);
    expect(field(() => checkEnvironments(['laptop']))).toBe('approved_environments');
  });

  it('instructionsSha256 is SHA-256 hex of the bytes (AC3)', () => {
    expect(instructionsSha256('')).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
    expect(instructionsSha256(Buffer.from('# AGENTS\n'))).toBe(instructionsSha256('# AGENTS\n'));
  });

  it('isCalendarDay accepts real days only', () => {
    expect(isCalendarDay('2026-02-28')).toBe(true);
    expect(isCalendarDay('2026-02-29')).toBe(false);
    expect(isCalendarDay('2026-9-1')).toBe(false);
  });
});

describe('recertification clock (AC4, handbook Ch.20 §20.8)', () => {
  it('adds calendar months, clamped to the end of the month', () => {
    expect(addMonths('2026-06-27', 3)).toBe('2026-09-27');
    expect(addMonths('2026-11-30', 3)).toBe('2027-02-28');
    expect(addMonths('2027-11-30', 3)).toBe('2028-02-29');
    expect(addMonths('2026-10-31', 1)).toBe('2026-11-30');
  });

  it('is not overdue on the due day, overdue the day after', () => {
    const dueDay = new Date('2026-09-27T23:59:59.000Z');
    expect(recertificationStatus('2026-06-27', 3, dueDay)).toEqual({
      dueOn: '2026-09-27',
      overdue: false,
    });
    expect(recertificationStatus('2026-06-27', 3, new Date('2026-09-28T00:00:00.000Z'))).toEqual({
      dueOn: '2026-09-27',
      overdue: true,
    });
  });

  it('uses the months from configuration', () => {
    const now = new Date('2026-09-01T00:00:00.000Z');
    expect(recertificationStatus('2026-07-15', 1, now).overdue).toBe(true);
    expect(recertificationStatus('2026-07-15', 2, now).overdue).toBe(false);
  });

  it('a never certified agent is overdue', () => {
    expect(recertificationStatus(null, 3, new Date())).toEqual({ dueOn: null, overdue: true });
  });
});

describe('messages (NFR-08)', () => {
  it('every refusal has a catalog text with no placeholder left', () => {
    for (const [code, key] of Object.entries(AGENT_REGISTER_ERROR_MESSAGES)) {
      const error = new AgentRegisterError(code as AgentRegisterError['code'], 'x', 'version');
      const text = agentRegisterErrorMessage(error, 'coder-openhands');
      expect(text, key).toBe(t(key, { key: 'coder-openhands', field: 'version' }));
      expect(text, key).not.toMatch(/\{[a-z_]+\}/);
    }
  });
});
