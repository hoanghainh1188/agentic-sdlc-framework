// The CLI's response schemas against the API's own presenters (B04 AC3, design/ADR-M36 §2.4):
// when a presenter changes in a way the CLI cannot read, this test fails.
import { PROPOSAL_MAX_BYTES } from '@sdlc/contracts';
import { describe, expect, it } from 'vitest';

import {
  adminConfigSchema,
  agentRoundSchema,
  agentSchema,
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
  linkedSpecSchema,
  planListSchema,
  runListSchema,
  killResultSchema,
  costReportSchema,
  gateMetricsSchema,
  evidenceBuildSchema,
  evidenceListSchema,
  evidenceShowSchema,
  evidenceFileSchema,
  proposalSchema,
  PROPOSAL_BASE64_MAX,
  submittedPlanSchema,
  specListSchema,
  intentSchema,
  meSchema,
} from '../../apps/cli/src/api/schemas.js';
import {
  agentBody,
  roundBody,
  aiRecordBody,
  linkedSpecBody,
  planListBody,
  runListBody,
  proposalBody,
  killBody,
  costReportBody,
  gateMetricsBody,
  evidencePackBody,
  evidenceFileBody,
  submittedPlanBody,
  specListBody,
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
    ['linked spec', linkedSpecSchema, linkedSpecBody()],
    ['spec list', specListSchema, specListBody()],
    ['submitted plan', submittedPlanSchema, submittedPlanBody()],
    ['plan list', planListSchema, planListBody()],
    ['run list', runListSchema, runListBody()],
    ['empty run list', runListSchema, runListBody({}, true)],
    ['kill', killResultSchema, killBody()],
    ['repeated kill', killResultSchema, killBody(true)],
    ['cost report', costReportSchema, costReportBody()],
    ['empty cost report', costReportSchema, costReportBody({ empty: true })],
    ['gate metrics', gateMetricsSchema, gateMetricsBody()],
    ['empty gate metrics', gateMetricsSchema, gateMetricsBody({ empty: true, tenant: true })],
    ['evidence pack build', evidenceBuildSchema, { pack: evidencePackBody(), created: true }],
    ['evidence pack', evidenceShowSchema, { pack: evidencePackBody(2, true) }],
    [
      'evidence pack list',
      evidenceListSchema,
      { intent: 'INT-2026-0007', packs: [evidencePackBody(1), evidencePackBody(2)] },
    ],
    ['evidence pack file', evidenceFileSchema, evidenceFileBody('# Evidence Pack\n')],
    ['L1 proposal', proposalSchema, proposalBody(Buffer.from([0x2b, 0x93, 0xfa, 0x0a]))],
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
    ['agent', agentSchema, agentBody({ status: 'active', last_recertified_at: '2026-01-05' })],
    ['agent round', agentRoundSchema, roundBody()],
    ['completed agent round', agentRoundSchema, roundBody(true)],
  ] as const)('%s', (_name, schema, body) => {
    const parsed = schema.safeParse(body);
    expect(parsed.error?.issues).toBeUndefined();
    // Nothing the presenter sends is dropped: the CLI shows the whole body with --json.
    expect(parsed.data).toEqual(body);
  });
});

describe('C13: the proposal cap', () => {
  it('the schema allows exactly PROPOSAL_MAX_BYTES of @sdlc/contracts in base64', () => {
    expect(PROPOSAL_BASE64_MAX).toBe(Math.ceil(PROPOSAL_MAX_BYTES / 3) * 4);
  });
});
