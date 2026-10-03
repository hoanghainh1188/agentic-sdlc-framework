// The CLI's response schemas against the API's own presenters (B04 AC3, design/ADR-M36 §2.4):
// when a presenter changes in a way the CLI cannot read, this test fails.
import { describe, expect, it } from 'vitest';

import {
  adminConfigSchema,
  adminIdentitySchema,
  adminProjectSchema,
  adminRoleSchema,
  adminTenantRoleSchema,
  adminUserSchema,
  aiRecordSchema,
  chainSchema,
  issuedTokenSchema,
  tokenSchema,
  decisionSchema,
  escalationSchema,
  intentDetailSchema,
  intentSchema,
  meSchema,
} from '../../apps/cli/src/api/schemas.js';
import {
  aiRecordBody,
  chainBody,
  issuedTokenBody,
  tokenBody,
  configBody,
  identityBody,
  projectBody,
  roleBody,
  tenantRoleBody,
  userBody,
  decisionBody,
  escalationBody,
  intentBody,
  intentDetailBody,
  meBody,
} from './fixtures.js';

describe('CLI response schemas match the API presenters', () => {
  it.each([
    ['intent', intentSchema, intentBody()],
    ['intent detail', intentDetailSchema, intentDetailBody()],
    ['gate decision', decisionSchema, decisionBody({ scope: { environment: 'staging' } })],
    ['escalation', escalationSchema, escalationBody()],
    [
      'decided escalation',
      escalationSchema,
      escalationBody({
        status: 'resolved',
        decision: { decision: 'resume', expires_at: '2026-10-04T00:00:00.000Z' },
        decided_at: new Date('2026-10-03T02:00:00.000Z'),
      }),
    ],
    ['AI record', aiRecordSchema, aiRecordBody({ confirmed_at: '2026-10-01' })],
    ['me', meSchema, meBody()],
    ['admin project', adminProjectSchema, projectBody()],
    ['admin user', adminUserSchema, userBody({}, true)],
    ['admin identity', adminIdentitySchema, identityBody({ unlinked_at: new Date() })],
    ['admin role', adminRoleSchema, roleBody()],
    ['admin tenant role', adminTenantRoleSchema, tenantRoleBody()],
    ['admin config', adminConfigSchema, configBody()],
    ['admin config (defaults only)', adminConfigSchema, configBody(0)],
    ['token', tokenSchema, tokenBody({ revoked_at: new Date(), last_used_at: new Date() })],
    ['issued token', issuedTokenSchema, issuedTokenBody(`sdlc_pat_${'k'.repeat(43)}`, true)],
    ['audit chain', chainSchema, chainBody()],
    ['broken audit chain', chainSchema, chainBody(true)],
  ] as const)('%s', (_name, schema, body) => {
    const parsed = schema.safeParse(body);
    expect(parsed.error?.issues).toBeUndefined();
    // Nothing the presenter sends is dropped: the CLI shows the whole body with --json.
    expect(parsed.data).toEqual(body);
  });
});
