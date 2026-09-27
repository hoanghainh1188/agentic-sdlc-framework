// D-08 B12 AC3: production logs and data for operations tasks come from the project AI record
// (handbook Ch.2 §2.5, template T7), through the policy engine interface.
import type { ProjectAiFacts } from '@sdlc/contracts';
import { describe, expect, it } from 'vitest';

import { engineFor } from './helpers';

const record = (change: Partial<ProjectAiFacts> = {}): ProjectAiFacts => ({
  version: 3,
  recordSha256: 'b'.repeat(64),
  aiAllowed: 'yes',
  allowedDataClasses: ['internal'],
  prodLogsAllowed: 'yes_masked',
  disclosureFormat: 'standard_note',
  consent: 'confirmed',
  ...change,
});

describe('productionDataAccess (AC3)', () => {
  const engine = engineFor();

  it.each<[string, ProjectAiFacts | null, 'none' | 'masked']>([
    ['no record', null, 'none'],
    ['masked production data allowed and confirmed', record(), 'masked'],
    ['with conditions', record({ aiAllowed: 'yes_with_conditions' }), 'masked'],
    ['production data not allowed', record({ prodLogsAllowed: 'no' }), 'none'],
    ['AI use not allowed', record({ aiAllowed: 'no' }), 'none'],
    ['consent unknown', record({ consent: 'unknown' }), 'none'],
  ])('%s → %s', (_name, aiRecord, expected) => {
    expect(engine.productionDataAccess({ aiRecord })).toBe(expected);
  });

  it('does not depend on the project configuration', () => {
    const tightened = engineFor('access:\n  ai_record_write_roles: [pm_brse]\n');
    expect(tightened.productionDataAccess({ aiRecord: record() })).toBe('masked');
  });
});
