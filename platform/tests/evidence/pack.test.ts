// D-08 E02 (design/ADR-M48): the Evidence Pack's manifest, Markdown file and disclosure note,
// without a database. AC1: every section; AC2: the disclosure note in both formats; AC3: a
// content hash that ignores the build's own fields; AC4: the Markdown from the catalog, with every
// value escaped and no free text (QUESTIONS #216, #217, #219).
import { createHash } from 'node:crypto';

import { canonicalJson } from '@sdlc/config';
import type {
  Agent,
  Escalation,
  EvidenceItem,
  GateDecisionRow,
  Intent,
  Plan,
  Project,
  ProjectAiRecord,
  Run,
  RunEventRow,
  SpecRef,
} from '../../packages/core/src/db/schema.js';
import {
  buildManifestContent,
  contentSha256,
  disclosureFacts,
  disclosureText,
  manifestBytes,
  mdCode,
  mdText,
  renderPackMarkdown,
  type PackSource,
} from '../../packages/core/src/evidence/index.js';
import { describe, expect, it } from 'vitest';

const T = new Date('2026-10-04T01:00:00.000Z');
const TENANT = '11111111-1111-4111-8111-111111111111';
const ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const SHA = (c: string) => c.repeat(64);

const intent = {
  id: ID(1),
  tenant_id: TENANT,
  code: 'INT-2026-0007',
  project_id: ID(2),
  title: 'Secret client title',
  description: 'Client description that must never appear',
  created_by: ID(10),
  risk_tier: 'medium',
  data_class: 'internal',
  max_autonomy: 'L2',
  budget_usd: '5.000000',
  current_gate: 'G8',
  status: 'in_gate',
  issue_number: 12,
  pr_number: 34,
  updated_at: T,
  created_at: T,
  gate_entered_at: T,
  run_budget_usd: null,
} as unknown as Intent;

const project = {
  id: ID(2),
  tenant_id: TENANT,
  slug: 'shop',
  name: 'Shop',
  git_provider: 'github',
  repo_full_name: 'acme/shop',
  default_branch: 'main',
  status: 'active',
  created_at: T,
} as unknown as Project;

const aiRecord = (format: 'standard_note' | 'client_format'): ProjectAiRecord =>
  ({
    project_id: ID(2),
    tenant_id: TENANT,
    version: 3,
    ai_allowed: 'yes',
    allowed_data_classes: ['internal'],
    prod_logs_allowed: 'no',
    disclosure_format: format,
    confirmed_at: '2026-09-01',
    updated_by: ID(10),
    created_at: T,
    record_ref: 'https://docs.example.com/ai-record',
    record_sha256: SHA('c'),
  }) as unknown as ProjectAiRecord;

const run = {
  id: ID(20),
  tenant_id: TENANT,
  intent_id: ID(1),
  plan_id: ID(30),
  attempt: 1,
  agent_id: ID(40),
  agent_version: '2',
  branch: 'agent/INT-2026-0007',
  base_sha: '1'.repeat(40),
  head_sha: 'e'.repeat(40),
  status: 'succeeded',
  stop_reason: null,
  triggered_by: ID(11),
  started_at: T,
  finished_at: T,
  iterations: 7,
  killed_by: null,
  updated_at: T,
  created_at: T,
} as unknown as Run;

const agent = {
  id: ID(40),
  agent_key: 'coder-openhands',
  version: '2',
  model_ref: 'gpt-oss-20b',
} as unknown as Agent;

const event = (type: string, payload: Record<string, unknown>, n: number): RunEventRow => ({
  id: String(n),
  tenant_id: TENANT,
  run_id: ID(20),
  event_type: type,
  payload,
  created_at: T,
});

const decision = (
  n: number,
  gate: string,
  d: string,
  extra: Partial<Record<keyof GateDecisionRow, unknown>> = {},
): GateDecisionRow =>
  ({
    id: ID(100 + n),
    tenant_id: TENANT,
    intent_id: ID(1),
    gate,
    decision: d,
    oversight_mode: 'HITL',
    approver_role: 'person_b',
    actor_type: 'human',
    decided_by: ID(12),
    reason_code: null,
    reason_ref: null,
    input_sha256: SHA('a'),
    scope: null,
    expires_at: null,
    config_hash: SHA('f'),
    source: 'github_review',
    event_source: 'polling',
    waited_seconds: 3600,
    voids_decision_id: null,
    created_at: new Date(T.getTime() + n * 1000),
    ...extra,
  }) as unknown as GateDecisionRow;

const item = {
  id: ID(50),
  tenant_id: TENANT,
  intent_id: ID(1),
  run_id: ID(20),
  kind: 'diff',
  storage_uri: `s3://evidence/diffs/${TENANT}/${ID(1)}/${ID(20)}.patch`,
  sha256: SHA('d'),
  size_bytes: '120',
  purged_at: null,
  created_at: T,
} as unknown as EvidenceItem;

function source(format: 'standard_note' | 'client_format' = 'standard_note'): PackSource {
  return {
    intent,
    project,
    aiRecord: aiRecord(format),
    specs: [
      {
        id: ID(60),
        intent_id: ID(1),
        version: 1,
        path: 'docs/specs/T01.md',
        commit_sha: '2'.repeat(40),
        content_sha256: SHA('b'),
        source_tool: 'manual',
        created_at: T,
      } as unknown as SpecRef,
    ],
    plans: [
      {
        id: ID(30),
        intent_id: ID(1),
        version: 1,
        planned_files: ['src/**', 'test/**'],
        summary: '',
        plan_sha256: SHA('9'),
        proposed_by_type: 'human',
        change_flags: ['migration'],
        commit_sha: '3'.repeat(40),
        allowed_tools: ['file_editor'],
        submitted_by: ID(10),
        created_at: T,
      } as unknown as Plan,
    ],
    runs: [run],
    runEvents: new Map([
      [
        ID(20),
        [
          event('diff_stored', { sha256: SHA('d'), size_bytes: 120, changed_files: 1 }, 1),
          event('ci_checked', { state: 'failure', critical: 0 }, 2),
          event('ci_checked', { state: 'success', critical: 0 }, 3),
          event('pr_merged', { pr_number: 34, head_sha: 'e'.repeat(40) }, 4),
        ],
      ],
    ]),
    agents: new Map([[ID(40), agent]]),
    decisions: [
      decision(1, 'G1', 'approve', { approver_role: 'person_a', decided_by: ID(10) }),
      decision(2, 'G4', 'pass', { actor_type: 'system', decided_by: null, approver_role: null }),
      decision(3, 'G7', 'approve'),
      decision(4, 'G7', 'approve', { decided_by: ID(13) }),
      decision(5, 'G7', 'void', { voids_decision_id: ID(104), reason_code: 'expired' }),
      decision(6, 'G3', 'request_changes', {
        reason_code: 'spec_unclear',
        reason_ref: 'https://github.com/acme/shop/issues/12#issuecomment-1',
      }),
    ],
    escalations: [
      {
        id: ID(70),
        code: 'ESC-2026-0001',
        run_id: ID(20),
        trigger: 'time',
        route: 'intent',
        severity: 'medium',
        response_level: 'notify',
        status: 'closed',
        packet: { subject_kind: 'gate', reason_code: 'gate_overdue' },
        decision: { decision: 'resume', subject_sha256: SHA('a') },
        decided_by: ID(14),
        created_at: T,
        acknowledged_at: T,
        decided_at: T,
        closed_at: T,
      } as unknown as Escalation,
    ],
    items: [{ item, check: 'verified' }],
    cost: {
      calls: 3,
      inputTokens: '1000',
      outputTokens: '200',
      cachedInputTokens: '50',
      costUsd: '0.012000',
      wastedTokens: '0',
      wastedCostUsd: '0.000000',
    },
  };
}

const build = {
  packId: ID(90),
  version: 2,
  builtAt: T,
  builtBy: ID(10),
  contentSha256: SHA('0'),
};

describe('E02 manifest (AC1, AC3)', () => {
  it('holds every section with codes, IDs, hashes and counts', () => {
    const content = buildManifestContent(source());
    expect(Object.keys(content).sort()).toEqual([
      'ai_record',
      'cost',
      'disclosure',
      'escalations',
      'evidence_items',
      'gate_decisions',
      'intent',
      'plans',
      'runs',
      'schema_version',
      'specs',
    ]);
    expect(content.specs).toEqual([
      {
        version: 1,
        path: 'docs/specs/T01.md',
        commit_sha: '2'.repeat(40),
        content_sha256: SHA('b'),
        source_tool: 'manual',
      },
    ]);
    expect(content.plans).toMatchObject([
      { path: '.sdlc/plans/INT-2026-0007.yaml', path_patterns: 2, change_flags: ['migration'] },
    ]);
    const runs = content.runs as Record<string, unknown>[];
    expect(runs[0]).toMatchObject({ agent_key: 'coder-openhands', model: 'gpt-oss-20b' });
    // The latest record of each kind; `diff_stored` is listed as an evidence item instead.
    expect(runs[0]!.events).toEqual({
      ci_checked: { state: 'success', critical: 0 },
      pr_merged: { pr_number: 34, head_sha: 'e'.repeat(40) },
    });
    expect(content.evidence_items).toEqual([
      expect.objectContaining({
        kind: 'diff',
        sha256: SHA('d'),
        size_bytes: 120,
        check: 'verified',
      }),
    ]);
    const decisions = content.gate_decisions as Record<string, unknown>[];
    expect(decisions.map((d) => [d.gate, d.decision, d.oversight_mode])).toContainEqual([
      'G4',
      'pass',
      'HITL',
    ]);
    expect(content.escalations).toMatchObject([
      { code: 'ESC-2026-0001', reason_code: 'gate_overdue', decision: 'resume' },
    ]);
    expect(content.cost).toMatchObject({ cost_usd: '0.012000', calls: 3 });
  });

  it('never holds free text: no title, description or name', () => {
    const json = canonicalJson(buildManifestContent(source()));
    expect(json).not.toContain('Secret client title');
    expect(json).not.toContain('Client description');
  });

  it('the content hash is stable and ignores the build fields (same content → same version)', () => {
    const content = buildManifestContent(source());
    const hash = contentSha256(content);
    expect(contentSha256(buildManifestContent(source()))).toBe(hash);
    expect(hash).toBe(createHash('sha256').update(canonicalJson(content)).digest('hex'));
    const a = manifestBytes(content, build);
    const b = manifestBytes(content, { ...build, packId: ID(91), version: 3 });
    expect(a.equals(b)).toBe(false);
    expect(JSON.parse(a.toString())).toMatchObject({
      build: { version: 2, content_sha256: SHA('0') },
    });
    // A change of content changes the hash.
    const other = { ...source(), items: [{ item, check: 'purged' as const }] };
    expect(contentSha256(buildManifestContent(other))).not.toBe(hash);
  });
});

describe('E02 disclosure note (AC2, QUESTIONS #217)', () => {
  it('standard_note: the facts from the data, no client text needed', () => {
    const facts = disclosureFacts(source());
    expect(facts).toEqual({
      format: 'standard_note',
      client_text_required: false,
      record_ref: null,
      agents: ['coder-openhands@2'],
      models: ['gpt-oss-20b'],
      runs_started: 1,
      // Two G7 approvals, one voided.
      g7_approvals: 1,
      ci_state: 'success',
    });
    const text = disclosureText(facts, 'en');
    expect(text).toHaveLength(1);
    expect(text[0]).toContain('coder-openhands@2');
    expect(text[0]).toContain('1 approval');
  });

  it('client_format: the same facts, the pointer to the AI record, client_text_required', () => {
    const facts = disclosureFacts(source('client_format'));
    expect(facts).toMatchObject({
      format: 'client_format',
      client_text_required: true,
      record_ref: 'https://docs.example.com/ai-record',
    });
    const text = disclosureText(facts, 'en');
    expect(text).toHaveLength(2);
    expect(text[1]).toContain('https://docs.example.com/ai-record');
    expect(buildManifestContent(source('client_format')).disclosure).toMatchObject({
      client_text_required: true,
    });
  });
});

describe('E02 Markdown (AC4, QUESTIONS #216)', () => {
  const names = new Map([
    [ID(10), 'Alice'],
    [ID(12), 'Bob | [click](https://evil.example) <img src=x> `code`\u202e'],
  ]);

  it('renders every section from the catalog, with the approvers next to their role', () => {
    const md = renderPackMarkdown({ source: source(), build, names, locale: 'en' });
    for (const heading of [
      '# Evidence Pack INT\\-2026\\-0007 (version 2)',
      '## Intent',
      '## Client AI disclosure',
      '## Specification',
      '## Plan',
      '## Agent runs',
      '## Evidence files',
      '## Checks, CI and review (latest per run)',
      '## Gate decisions',
      '## Escalations',
      '## Tokens and cost (USD)',
    ]) {
      expect(md).toContain(heading);
    }
    expect(md).toContain('Alice (`00000000-0000-4000-8000-000000000010`)');
    expect(md).toContain('the platform');
    expect(md).toContain('`0.012000`');
    expect(md).not.toContain('Secret client title');
  });

  it('escapes names: no link, image, HTML, code span, table cell or bidi control', () => {
    const md = renderPackMarkdown({ source: source(), build, names, locale: 'en' });
    const row = md.split('\n').find((line) => line.includes('Bob'))!;
    expect(row).not.toMatch(/(?<!\\)\]\(/);
    expect(row).not.toMatch(/(?<!\\)<img/);
    expect(row).not.toContain('\u202e');
    expect(row).toContain('Bob \\| \\[click\\]\\(https:');
    // The row keeps the table's 9 columns: an escaped `|` does not split a cell.
    expect(row.split(/(?<!\\)\|/).length - 2).toBe(9);
  });

  it('mdText and mdCode make any value safe', () => {
    expect(mdText('a\nb\u0000c')).toBe('a b c');
    expect(mdText('x'.repeat(500))).toHaveLength(120);
    expect(mdText('x'.repeat(500)).endsWith('…')).toBe(true);
    expect(mdText('a\u061cb\u00adc\u2028d')).toBe('a b c d');
    // A 512-character link stays whole.
    const link = `https://docs.example.com/${'p'.repeat(487)}`;
    expect(mdCode(link)).toBe(`\`${link}\``);
    expect(mdCode('abc')).toBe('`abc`');
    expect(mdCode('a`b')).toBe('a\\`b');
    expect(mdCode('a|b')).toBe('a\\|b');
  });

  it('client_format adds the line that the client text is still needed', () => {
    const md = renderPackMarkdown({ source: source('client_format'), build, names, locale: 'en' });
    expect(md).toContain("The client's own disclosure note is still needed");
    expect(md).toContain('`https://docs.example.com/ai-record`');
  });
});
