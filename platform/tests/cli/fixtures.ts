// API response bodies for the CLI tests (B04 AC3), built with the API's own presenters, so the
// mocked API cannot drift from the real one: a presenter change that breaks the CLI's response
// schemas fails these tests.
import type {
  Escalation,
  GateDecisionRow,
  Intent,
  Plan,
  Project,
  ProjectAiRecord,
  RoleBinding,
  SpecRef,
  TenantRoleBinding,
  User,
  UserIdentity,
} from '../../packages/core/src/index.js';

import {
  presentConfig,
  presentIdentity,
  presentProject,
  presentRoleBinding,
  presentTenantRole,
  presentUser,
} from '../../apps/api/src/admin/present.js';
import { presentAiRecord } from '../../apps/api/src/ai-records/present.js';
import { presentEscalation } from '../../apps/api/src/escalations/present.js';
import {
  presentDecision,
  presentIntent,
  presentPlan,
  presentSpec,
} from '../../apps/api/src/intents/present.js';

export const TENANT = '11111111-1111-4111-8111-111111111111';
export const USER = '22222222-2222-4222-8222-222222222222';
export const PROJECT = { id: '33333333-3333-4333-8333-333333333333', slug: 'pilot' };
const INTENT_ID = '44444444-4444-4444-8444-444444444444';
const AT = new Date('2026-10-03T01:02:03.000Z');
const HASH = 'a'.repeat(64);

export function intentRow(overrides: Partial<Intent> = {}): Intent {
  return {
    id: INTENT_ID,
    tenant_id: TENANT,
    code: 'INT-2026-0007',
    project_id: PROJECT.id,
    title: 'Add Japanese labels',
    description: 'T01',
    created_by: USER,
    risk_tier: 'low',
    data_class: 'internal',
    max_autonomy: 'L2',
    budget_usd: '2.500000',
    current_gate: 'G2',
    gate_entered_at: AT,
    status: 'in_gate',
    issue_number: 12,
    pr_number: null,
    updated_at: AT,
    created_at: AT,
    ...overrides,
  };
}

export function intentBody(overrides: Partial<Intent> = {}): Record<string, unknown> {
  return { ...presentIntent(intentRow(overrides), PROJECT) };
}

export function decisionRow(overrides: Partial<GateDecisionRow> = {}): GateDecisionRow {
  return {
    id: '55555555-5555-4555-8555-555555555555',
    tenant_id: TENANT,
    intent_id: INTENT_ID,
    gate: 'G2',
    decision: 'approve',
    oversight_mode: 'HITL',
    approver_role: 'person_a',
    actor_type: 'human',
    decided_by: USER,
    reason_code: null,
    reason_ref: null,
    input_sha256: HASH,
    scope: null,
    expires_at: new Date('2026-10-10T01:02:03.000Z'),
    config_hash: HASH,
    source: 'cli',
    event_source: null,
    waited_seconds: 60,
    voids_decision_id: null,
    created_at: AT,
    ...overrides,
  };
}

export function decisionBody(overrides: Partial<GateDecisionRow> = {}): Record<string, unknown> {
  return presentDecision(decisionRow(overrides));
}

export function intentDetailBody(): Record<string, unknown> {
  const spec = {
    version: 1,
    path: 'docs/specs/T01.md',
    commit_sha: 'b'.repeat(40),
    content_sha256: HASH,
  } as SpecRef;
  const plan = { version: 2, plan_sha256: HASH, change_flags: ['migration'] } as unknown as Plan;
  return {
    ...presentIntent(intentRow(), PROJECT),
    spec: presentSpec(spec),
    plan: presentPlan(plan),
    decisions: [presentDecision(decisionRow())],
  };
}

export function escalationBody(overrides: Partial<Escalation> = {}): Record<string, unknown> {
  const row: Escalation = {
    id: '66666666-6666-4666-8666-666666666666',
    tenant_id: TENANT,
    code: 'ESC-2026-0003',
    intent_id: INTENT_ID,
    run_id: null,
    trigger: 'time',
    route: 'intent',
    severity: 'medium',
    response_level: 'notify',
    packet: { subject_kind: 'gate', subject_sha256: HASH, gate: 'G2', reason_code: 'other' },
    producer_ids: [],
    owner_id: USER,
    backup_owner_id: null,
    current_step: 'owner',
    status: 'open',
    ack_due_at: AT,
    step_due_at: AT,
    remind_at: null,
    reminded_step: null,
    ack_missed_at: null,
    governance_overdue_at: null,
    resolve_due_at: null,
    resolve_overdue_at: null,
    next_check_at: AT,
    acknowledged_by: null,
    acknowledged_at: null,
    decision: null,
    decided_by: null,
    decided_at: null,
    closed_at: null,
    updated_at: AT,
    created_at: AT,
    ...overrides,
  };
  return presentEscalation(row, { id: INTENT_ID, code: 'INT-2026-0007' });
}

export function aiRecordBody(overrides: Partial<ProjectAiRecord> = {}): Record<string, unknown> {
  const record = {
    tenant_id: TENANT,
    project_id: PROJECT.id,
    version: 3,
    ai_allowed: 'yes',
    allowed_data_classes: ['public', 'internal'],
    prod_logs_allowed: 'no',
    disclosure_format: 'standard_note',
    confirmed_at: null,
    record_ref: null,
    record_sha256: HASH,
    updated_by: USER,
    updated_at: AT,
    created_at: AT,
    ...overrides,
  } as ProjectAiRecord;
  return presentAiRecord(record, PROJECT);
}

export function meBody(): Record<string, unknown> {
  return {
    user: { id: USER, display_name: 'Harry', email: 'harry@example.test' },
    tenant_id: TENANT,
    token_id: '77777777-7777-4777-8777-777777777777',
    tenant_admin: false,
    roles: [{ project: PROJECT, role: 'person_a' }],
  };
}

// Admin endpoints (B13, ADR-M37).
export const OTHER_USER = '88888888-8888-4888-8888-888888888888';

export function projectBody(overrides: Partial<Project> = {}): Record<string, unknown> {
  return presentProject({
    id: PROJECT.id,
    tenant_id: TENANT,
    slug: PROJECT.slug,
    name: 'Pilot',
    git_provider: 'github',
    repo_full_name: 'harryforge/pilot-order-inventory',
    default_branch: 'main',
    status: 'active',
    created_at: AT,
    ...overrides,
  });
}

export function userBody(
  overrides: Partial<User> = {},
  tenantAdmin = false,
): Record<string, unknown> {
  return presentUser(
    {
      id: OTHER_USER,
      tenant_id: TENANT,
      display_name: 'Bao',
      email: 'bao@example.test',
      status: 'active',
      created_at: AT,
      ...overrides,
    },
    tenantAdmin,
  );
}

export function identityBody(overrides: Partial<UserIdentity> = {}): Record<string, unknown> {
  return presentIdentity({
    id: '99999999-9999-4999-8999-999999999999',
    tenant_id: TENANT,
    user_id: OTHER_USER,
    provider: 'github',
    external_id: '583231',
    external_login: 'octocat',
    unlinked_at: null,
    created_at: AT,
    ...overrides,
  });
}

export function roleBody(overrides: Partial<RoleBinding> = {}): Record<string, unknown> {
  return presentRoleBinding(
    {
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      tenant_id: TENANT,
      user_id: OTHER_USER,
      project_id: PROJECT.id,
      role: 'person_b',
      revoked_at: null,
      created_at: AT,
      ...overrides,
    },
    PROJECT,
  );
}

export function tenantRoleBody(
  overrides: Partial<TenantRoleBinding> = {},
): Record<string, unknown> {
  return presentTenantRole({
    id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    tenant_id: TENANT,
    user_id: OTHER_USER,
    role: 'tenant_admin',
    revoked_at: null,
    created_at: AT,
    ...overrides,
  });
}

export function configBody(version = 1): Record<string, unknown> {
  return presentConfig(
    {
      project: PROJECT,
      version,
      configYaml: version === 0 ? '' : 'budget:\n  warn_percent: 70\n',
      configHash: HASH,
      overrideSha256: version === 0 ? null : 'b'.repeat(64),
      updatedBy: version === 0 ? null : USER,
      updatedAt: version === 0 ? null : AT,
      warnings: [
        {
          key: 'config.warning.mode_loosened',
          path: 'oversight.matrix.G2.medium.mode',
          params: { from: 'HITL', to: 'HOTL' },
        },
      ],
    },
    'en',
  );
}
