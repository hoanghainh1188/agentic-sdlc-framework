// Audit actions and their declared payload fields (ADR-M09 section 2.8).
//
// The audit log is never deleted and is kept at least 2 years (D-05 section 10, FR-44), so data
// written there can never be erased. Payloads therefore hold **only IDs, codes, hashes and
// versions**: never personal data, client data, free text, config text or record contents.
// `append` accepts only the fields declared here for the action, each with a strict format, and
// the canonical payload must fit in `MAX_AUDIT_PAYLOAD_BYTES`.
//
// Adding an action: add it below with the smallest set of fields that makes the event
// traceable, and a test. Reviewers check that no field can carry personal or client data.
// A field whose kind ends with `?` is optional (ADR-M20): it may be left out, never set to null;
// when present it follows the same format rule.
import { isUsd } from '../cost/money.js';
import { DbError } from '../db/errors.js';
import { isUuid } from '../db/tenant-id.js';

/**
 * - `uuid`: a platform ID (lowercase UUID)
 * - `sha256`: a lowercase hex SHA-256 digest
 * - `version`: a positive integer
 * - `code`: a short code such as `G3`, `INT-2026-0001` or an enum value (no spaces, max 64)
 * - `codes`: a list of 1 to `MAX_AUDIT_CODES` codes (B13: the warning codes of `config.changed`)
 * - `decimal`: an amount of money in USD as a decimal string with at most 6 decimals (C07)
 * - `count`: a count or a duration in seconds, an integer of 0 or more (E03, `intent.closed`)
 */
export type AuditFieldKind = 'uuid' | 'sha256' | 'version' | 'code' | 'codes' | 'decimal' | 'count';

/** A declared field: its kind, with a trailing `?` when the field is optional. */
export type AuditFieldSpec = AuditFieldKind | `${AuditFieldKind}?`;

export interface AuditActionSpec {
  /** Entity the event is about; null for events without one. `entity_id` is then null too. */
  readonly entityType: string | null;
  readonly fields: Readonly<Record<string, AuditFieldSpec>>;
}

export const AUDIT_ACTIONS = {
  /** A tenant was created by the one-time bootstrap (B03, ADR-M26). Never its slug or name. */
  'tenant.created': { entityType: 'tenant', fields: {} },
  /** A user was created (B03 bootstrap). Never the name or e-mail address. */
  'user.created': { entityType: 'user', fields: {} },
  /** A personal API token was issued (B03). Never the token or its hash; the token ID is the entity. */
  'api_token.issued': { entityType: 'api_token', fields: { user_id: 'uuid' } },
  /** A personal API token was revoked (B03). Written once, on the first revocation. */
  'api_token.revoked': { entityType: 'api_token', fields: { user_id: 'uuid' } },
  /**
   * A project configuration was created or replaced (FR-14, ADR-M13). Never the config text.
   * B13 (ADR-M37): `override_sha256` (the stored YAML), the `cause` (`upload`, `defaults_changed`)
   * and the loosening warnings as `<warning>:<path>` codes, with their count (D-08 B13 AC4).
   */
  'config.changed': {
    entityType: 'project',
    fields: {
      version: 'version',
      config_hash: 'sha256',
      override_sha256: 'sha256?',
      cause: 'code?',
      warning_count: 'version?',
      warnings: 'codes?',
    },
  },
  /** A project was created (B13). Never its slug, name or repository. */
  'project.created': { entityType: 'project', fields: { git_provider: 'code' } },
  /** A project's name, repository or default branch changed (B13). Never the values. */
  'project.updated': { entityType: 'project', fields: {} },
  /**
   * A project was archived (B13). Its evidence files are purged after the archive grace period by
   * the retention loop (E05, FR-44, ADR-M51); its time starts that period.
   */
  'project.archived': { entityType: 'project', fields: {} },
  /**
   * The retention loop purged every evidence file of an archived project that is not held (E05,
   * FR-44, ADR-M51): counts of rows. Written once per project. `langfuse` is `manual` in the MVP:
   * the project's traces in Langfuse are deleted by hand (runbook T11 §5j, QUESTIONS #238).
   */
  /**
   * The retention loop, in `purge` mode, scheduled the purge of an archived project (E05, ADR-M51
   * §2.6): its evidence is purged `grace_days` after the later of this event and the archive.
   * Written once per archive, so a project archived before the purge was turned on still gets the
   * whole grace period, visible in the audit log.
   */
  'project.purge_scheduled': { entityType: 'project', fields: { grace_days: 'count' } },
  'project.purged': {
    entityType: 'project',
    fields: { intents: 'count', purged: 'count', held: 'count', langfuse: 'code' },
  },
  /** A user's name or e-mail address changed (B13). Never the values. */
  'user.updated': { entityType: 'user', fields: {} },
  /** A user was disabled: their tokens stop working at once (B13). */
  'user.disabled': { entityType: 'user', fields: {} },
  /** A disabled user was enabled again (B13). */
  'user.enabled': { entityType: 'user', fields: {} },
  /**
   * A Git host account was linked to a user (B13 AC3, QUESTIONS #45). Never the account ID or
   * login: the identity row is the entity.
   */
  'identity.linked': { entityType: 'identity', fields: { user_id: 'uuid', provider: 'code' } },
  /** A Git host account was unlinked (B13). */
  'identity.unlinked': { entityType: 'identity', fields: { user_id: 'uuid', provider: 'code' } },
  /** A project role was granted (B13, FR-11). The binding is the entity. */
  'role.granted': {
    entityType: 'role_binding',
    fields: { user_id: 'uuid', project_id: 'uuid', role: 'code' },
  },
  /** A project role was revoked (B13): `revoked_at` was set; the binding stays as history. */
  'role.revoked': {
    entityType: 'role_binding',
    fields: { user_id: 'uuid', project_id: 'uuid', role: 'code' },
  },
  /** A tenant role was granted (B13, QUESTIONS #150). */
  'tenant_role.granted': {
    entityType: 'tenant_role_binding',
    fields: { user_id: 'uuid', role: 'code' },
  },
  /** A tenant role was revoked (B13). */
  'tenant_role.revoked': {
    entityType: 'tenant_role_binding',
    fields: { user_id: 'uuid', role: 'code' },
  },
  /**
   * A project AI record was created or replaced (FR-19, B12, ADR-M32 §2.2). Codes, the version and
   * the hash of the coded record only; the allowed classes are in the hash and in
   * `project_ai_record_versions`. Never the link or anything from the human record.
   */
  'ai_record.changed': {
    entityType: 'project',
    fields: {
      version: 'version',
      record_sha256: 'sha256',
      ai_allowed: 'code',
      prod_logs_allowed: 'code',
      disclosure_format: 'code',
      consent: 'code',
      updated_by: 'uuid',
    },
  },
  /** An intent was created (FR-01, FR-03). Never the title or description. */
  'intent.created': {
    entityType: 'intent',
    fields: {
      code: 'code',
      project_id: 'uuid',
      risk_tier: 'code',
      data_class: 'code',
      max_autonomy: 'code',
    },
  },
  /** An intent moved to another status or gate. `current_gate` is left out when there is none. */
  'intent.state_changed': {
    entityType: 'intent',
    fields: { status: 'code', current_gate: 'code?' },
  },
  /**
   * A G5 `resume` decision with a budget increase raised the intent budget (task C07, QUESTIONS
   * #133): the amount added, the new intent budget, the run budget of the next runs and the
   * escalation whose decision allowed it.
   */
  'intent.budget_increased': {
    entityType: 'intent',
    fields: {
      escalation_id: 'uuid',
      added_usd: 'decimal',
      budget_usd: 'decimal',
      run_budget_usd: 'decimal',
    },
  },
  /**
   * A spec was linked to an intent (FR-02). Never the path or the content. B08 (ADR-M39): the
   * linked commit and the `cause`: `linked` (a person) or `head_changed` (the platform linked the
   * spec at the head of the default branch because its content changed there).
   */
  'spec.linked': {
    entityType: 'intent',
    fields: {
      spec_ref_id: 'uuid',
      version: 'version',
      content_sha256: 'sha256',
      commit_sha: 'code?',
      cause: 'code?',
    },
  },
  /**
   * The linked spec cannot be read at the head of the default branch (B08, ADR-M39 §2.4): `cause`
   * is `missing`, `not_a_file`, `too_large` or `not_utf8`. Written once per spec version and cause;
   * the intent waits at G2 until a person links a spec that can be read. Never the path.
   */
  'spec.unavailable': {
    entityType: 'intent',
    fields: { spec_ref_id: 'uuid', cause: 'code', head_sha: 'code' },
  },
  /**
   * A plan was submitted for an intent. Never the file list or the summary. B09 (ADR-M40): the
   * commit the plan file was read at.
   */
  'plan.submitted': {
    entityType: 'intent',
    fields: { plan_id: 'uuid', version: 'version', plan_sha256: 'sha256', commit_sha: 'code?' },
  },
  /**
   * The plan file at the head of the default branch is no longer the submitted plan (B09,
   * ADR-M40 §2.4, QUESTIONS #167): `cause` is `changed` or why the file cannot be read (`missing`,
   * `not_a_file`, `too_large`, `not_utf8`). Written once per plan version and cause; G3 or G4 is
   * held until a person submits the plan again. Never the path or the content.
   */
  'plan.resubmit_needed': {
    entityType: 'intent',
    fields: { plan_id: 'uuid', cause: 'code', head_sha: 'code' },
  },
  /** A gate decision was recorded (FR-10, FR-17). Never a free-text reason (ADR-M20). */
  'gate.decided': {
    entityType: 'intent',
    fields: {
      decision_id: 'uuid',
      gate: 'code',
      decision: 'code',
      oversight_mode: 'code',
      input_sha256: 'sha256',
      config_hash: 'sha256',
      approver_role: 'code?',
      reason_code: 'code?',
      voids_decision_id: 'uuid?',
    },
  },
  /** A Run Contract was signed and stored for a new run (D-03 section 8, ADR-M22). */
  'run.contract_issued': {
    entityType: 'run',
    fields: {
      intent_id: 'uuid',
      attempt: 'version',
      contract_sha256: 'sha256',
      key_version: 'version',
    },
  },
  /**
   * The kill switch was used on a run (C11, D-02 FR-34, ADR-M42). The actor is the person (or
   * `system` for an operator). `previous_status` is the run status before; `source` is `api`,
   * `github_comment` or `ops`; `escalation_id` the escalation raised for the review.
   */
  'run.kill_requested': {
    entityType: 'run',
    fields: {
      intent_id: 'uuid',
      previous_status: 'code',
      source: 'code',
      escalation_id: 'uuid?',
    },
  },
  /**
   * G4 computed a new run proposal for the intent (task C06, ADR-M33 §2.3): the terms a G4
   * approval or pass is bound to. `input_sha256` is the G4 input hash; `base_sha` the commit of the
   * default branch the run would start from. Hashes, IDs and codes only; never the model name (it
   * may hold `/` or `@`, ADR-M31 §2.8), which the hash covers.
   */
  'run.proposed': {
    entityType: 'intent',
    fields: {
      input_sha256: 'sha256',
      base_sha: 'code',
      plan_id: 'uuid',
      agent_id: 'uuid',
      agent_version: 'code',
      instructions_sha256: 'sha256',
      autonomy_level: 'code',
    },
  },
  /**
   * A G4 check failed (task C06, ADR-M33 §2.4). The gate decision holds the reason code
   * (`gate_reason_code`); `check` is the exact cause, for example an agent register refusal
   * (`agent_not_active`, `model_not_allowed`) or `spec_changed`.
   */
  'gate.g4_check_failed': {
    entityType: 'intent',
    fields: { decision_id: 'uuid', check: 'code' },
  },
  /**
   * G5 failed for a run (task C07, ADR-M34 §2.8): the exact cause next to the gate decision's
   * reason code: `instructions_changed`, `out_of_scope`, `max_budget`, `spend_at_stop`,
   * `max_iterations`, `max_duration`, `stalled` or `changes_missing`. The run's plan is refused at G3
   * after `out_of_scope` (QUESTIONS #131). Never a path.
   */
  'gate.g5_check_failed': {
    entityType: 'intent',
    fields: { decision_id: 'uuid', check: 'code', run_id: 'uuid' },
  },
  /**
   * The pull request of the intent's agent branch was linked to the intent (C08, ADR-M38 §2.4):
   * the run whose push it shows, its number and the pushed head. Never its title, body or URL.
   */
  'intent.pr_linked': {
    entityType: 'intent',
    fields: { run_id: 'uuid', pr_number: 'version', head_sha: 'code' },
  },
  /**
   * G6 stopped before CI: the run's changes could not be pushed or the pull request not opened
   * (C08, QUESTIONS #156). `reason`: the runner's refusal code (`empty_diff`, `diff_mismatch`,
   * `branch_moved`…) or `publish_attempts` (too many failed attempts).
   */
  'gate.g6_publish_stopped': {
    entityType: 'intent',
    fields: { run_id: 'uuid', reason: 'code', escalation_id: 'uuid' },
  },
  /**
   * A G6 check failed (C08 PR 2, ADR-M38 §2.7): the exact cause next to the decision's reason
   * code: `ci_failed` (a retry), `ci_no_retries` (back to G3), `ci_timeout`, `pr_closed`,
   * `pr_merged`, `branch_moved`, `critical_finding`.
   */
  'gate.g6_check_failed': {
    entityType: 'intent',
    fields: { decision_id: 'uuid?', check: 'code', run_id: 'uuid' },
  },
  /**
   * A G7 check failed (E01, ADR-M41 §2.5): `pr_closed`, `head_changed` (the pull request shows
   * another commit than the platform pushed), `merged_before_approval`, `merged_by_producer`
   * (a bot, a producer of the change or an unknown account merged it).
   */
  'gate.g7_check_failed': {
    entityType: 'intent',
    fields: { decision_id: 'uuid?', check: 'code', run_id: 'uuid', escalation_id: 'uuid?' },
  },
  /**
   * G7 passed (E01 AC5): a person merged the run's pull request with the approved head. The merge
   * commit, never the merger's account.
   */
  'intent.pr_merged': {
    entityType: 'intent',
    fields: { run_id: 'uuid', pr_number: 'version', head_sha: 'code', merge_commit_sha: 'code?' },
  },
  /** The runner refused the Run Contract of a known run; `reason` is a reject reason code. */
  'run.contract_rejected': { entityType: 'run', fields: { reason: 'code' } },
  /** An escalation was raised (FR-18, B11). Codes and IDs only, never the words of the package. */
  'escalation.created': {
    entityType: 'escalation',
    fields: {
      code: 'code',
      intent_id: 'uuid',
      trigger: 'code',
      route: 'code',
      severity: 'code',
      response_level: 'code',
      step: 'code',
      subject_sha256: 'sha256',
      run_id: 'uuid?',
      gate: 'code?',
    },
  },
  /** Nobody but producers holds any role of the route or governance (QUESTIONS #74). */
  'escalation.unrouted': { entityType: 'escalation', fields: { code: 'code' } },
  /** The holder of the current step was reminded (Ch.6 §6.5, QUESTIONS #75). */
  'escalation.reminded': { entityType: 'escalation', fields: { code: 'code', step: 'code' } },
  /** Nobody acknowledged in time: the escalation moved to the next step (Ch.6 §6.5). */
  'escalation.step_changed': {
    entityType: 'escalation',
    fields: { code: 'code', from_step: 'code', to_step: 'code' },
  },
  /** Governance, the last step, did not acknowledge in time either. Recorded once. */
  'escalation.ack_overdue': { entityType: 'escalation', fields: { code: 'code' } },
  /** The resolve deadline passed without a decision; governance takes over. Recorded once. */
  'escalation.resolve_overdue': {
    entityType: 'escalation',
    fields: { code: 'code', from_step: 'code' },
  },
  /** A Critical escalation passed its resolve deadline: the incident process is due (Ch.6 §6.7). */
  'escalation.incident_due': { entityType: 'escalation', fields: { code: 'code' } },
  /** A person acknowledged the escalation (B11 PR 2); `step` is where it was. */
  'escalation.acknowledged': { entityType: 'escalation', fields: { code: 'code', step: 'code' } },
  /** A person decided (T16 §4), bound to the reviewed hash. Never the reason text (a link only). */
  'escalation.decided': {
    entityType: 'escalation',
    fields: {
      code: 'code',
      decision: 'code',
      subject_sha256: 'sha256',
      reason_code: 'code?',
      budget_increase_usd: 'code?',
    },
  },
  /** A person moved the escalation to governance (`escalate_further`). */
  'escalation.escalated_further': {
    entityType: 'escalation',
    fields: { code: 'code', from_step: 'code' },
  },
  /** A decision expired or no longer matched the version acted on (Ch.6 §6.6); `reason` is a code. */
  'escalation.decision_voided': {
    entityType: 'escalation',
    fields: { code: 'code', reason: 'code' },
  },
  /** The escalation was closed; `status` is the status it had before. */
  'escalation.closed': { entityType: 'escalation', fields: { code: 'code', status: 'code' } },
  /**
   * An agent was registered (C10, ADR-M31). Never the model name (it may hold `/` and `@`) or the
   * owner; the instructions hash identifies the instructions version.
   */
  'agent.registered': {
    entityType: 'agent',
    fields: { agent_key: 'code', version: 'code', instructions_sha256: 'sha256' },
  },
  /** An agent got a new version: model, instructions, tools, autonomy or environments (Ch.20 §20.9). */
  'agent.updated': {
    entityType: 'agent',
    fields: { agent_key: 'code', version: 'code', instructions_sha256: 'sha256' },
  },
  /** An agent's status changed. `reason_code` is set for suspend, quarantine and retire. */
  'agent.status_changed': {
    entityType: 'agent',
    fields: { agent_key: 'code', from: 'code', to: 'code', reason_code: 'code?' },
  },
  /**
   * A person approved an agent's activation or retirement (B13 AC7, Ch.20 §20.7, §20.11), in a
   * capacity (`owner`, `person_a`, `person_b`, `governance`). The actor is the approver.
   */
  'agent.approval_recorded': {
    entityType: 'agent',
    fields: { agent_key: 'code', version: 'code', purpose: 'code', capacity: 'code' },
  },
  /** The agent's owner changed (the owner left, Ch.20 §20.8). Never who the owner is. */
  'agent.owner_changed': { entityType: 'agent', fields: { agent_key: 'code' } },
  /** An agent was recertified (Ch.20 §20.8), or certified by its first activation (ADR-M31 §2.6). */
  'agent.recertified': { entityType: 'agent', fields: { agent_key: 'code' } },
  /**
   * A run started with an agent whose recertification is overdue (FR-36: a warning, not a block).
   * Written by the G4 check of C06 (ADR-M31 §2.6).
   */
  'agent.recertification_overdue': {
    entityType: 'agent',
    fields: { agent_key: 'code', run_id: 'uuid?' },
  },
  /**
   * An intent's Evidence Pack was built (E02, ADR-M48). The pack is the entity. Hashes and the
   * version only: never the pack's content, which names the approvers.
   */
  'evidence.pack_built': {
    entityType: 'evidence_pack',
    fields: {
      intent_id: 'uuid',
      version: 'version',
      content_sha256: 'sha256',
      manifest_sha256: 'sha256',
      markdown_sha256: 'sha256',
    },
  },
  /**
   * A stored evidence file failed its re-check while a pack was built (E02, ADR-M33 §2.9 gap 2):
   * `reason` `hash_mismatch`, `size_mismatch`, `missing` or `too_large`. A possible tampering
   * signal. The evidence item is the entity.
   */
  'evidence.check_failed': {
    entityType: 'evidence_item',
    fields: { intent_id: 'uuid', kind: 'code', reason: 'code' },
  },
  /** A stored pack file failed its re-check when it was read (E02): `file` `manifest` or `markdown`. */
  'evidence.pack_check_failed': {
    entityType: 'evidence_pack',
    fields: { intent_id: 'uuid', version: 'version', file: 'code', reason: 'code' },
  },
  /**
   * G8 sealed one version of the intent's Evidence Pack (E03, ADR-M49 §2.4): the version, the
   * content hash and the release hash G8 approved. Never the pack's content.
   */
  'evidence.pack_sealed': {
    entityType: 'evidence_pack',
    fields: {
      intent_id: 'uuid',
      version: 'version',
      content_sha256: 'sha256',
      release_sha256: 'sha256',
    },
  },
  /**
   * The retention loop deleted every stored version of an evidence file (E05, ADR-M51). The intent
   * is the entity. `kind` `proposal`, `diff` or `pack` (with `pack_id` and `pack_version`, both
   * files); `cause` `retention` or `archive`; `versions` how many versions and delete markers were
   * deleted. The row and its hashes stay (D-05 §10.1).
   */
  'evidence.purged': {
    entityType: 'intent',
    fields: {
      item_id: 'uuid?',
      pack_id: 'uuid?',
      pack_version: 'version?',
      kind: 'code',
      sha256: 'sha256',
      markdown_sha256: 'sha256?',
      versions: 'count',
      cause: 'code',
    },
  },
  /**
   * The retention loop deleted the files of a pack version without a row (a build that failed
   * after its upload; E05, ADR-M48 §2.7, ADR-M51). IDs from the file path and counts only.
   */
  'evidence.orphan_swept': {
    entityType: 'intent',
    fields: { pack_id: 'uuid', files: 'count', versions: 'count' },
  },
  /**
   * The daily audit anchor check found anchors that do not match this tenant's chain (E05 PR 2,
   * D-05 §7.4, ADR-M51 §2.9). Once per check run. Counts and the first mismatch's `reason`
   * (`hash_mismatch`, `seq_missing`, `anchor_invalid`, `anchor_versions`) and `seq`; **never a
   * hash**. The tenant is the entity.
   */
  'audit.anchor_mismatch': {
    entityType: 'tenant',
    fields: { checked: 'count', mismatched: 'count', reason: 'code', first_seq: 'count?' },
  },
  /** A person put an intent's evidence on hold (E05, QUESTIONS #235): never purged until released. */
  'evidence.hold_set': { entityType: 'intent', fields: { hold_id: 'uuid' } },
  /** A person released the hold on an intent's evidence (E05, QUESTIONS #235). */
  'evidence.hold_released': { entityType: 'intent', fields: { hold_id: 'uuid' } },
  /**
   * G8 stopped (E03, ADR-M49 §2.5): `check` `evidence_hash_mismatch` or `evidence_missing` (a
   * stored evidence file failed its re-check while the release pack was built). The intent is
   * paused at G8 with a `security` escalation.
   */
  'gate.g8_check_failed': {
    entityType: 'intent',
    fields: { check: 'code', escalation_id: 'uuid' },
  },
  /**
   * G8 passed and the intent is `done` (E03 AC3, ADR-M49 §2.4): the sealed pack and the intent's
   * coded metrics. `lead_time_seconds` from the intent's creation to its close; token sums as digit
   * strings and the cost as a decimal string (as in E04). Never names or text.
   */
  'intent.closed': {
    entityType: 'intent',
    fields: {
      pack_id: 'uuid',
      pack_version: 'version',
      release_sha256: 'sha256',
      lead_time_seconds: 'count',
      runs: 'count',
      g7_change_requests: 'count',
      cost_usd: 'decimal',
      input_tokens: 'code',
      output_tokens: 'code',
    },
  },
} as const satisfies Readonly<Record<string, AuditActionSpec>>;

export type AuditAction = keyof typeof AUDIT_ACTIONS;

type FieldValue<K> = K extends 'version' | 'version?' | 'count' | 'count?'
  ? number
  : K extends 'codes' | 'codes?'
    ? readonly string[]
    : string;
type Fields<A extends AuditAction> = (typeof AUDIT_ACTIONS)[A]['fields'];
type OptionalKeys<A extends AuditAction> = {
  [F in keyof Fields<A>]: Fields<A>[F] extends `${string}?` ? F : never;
}[keyof Fields<A>];

export type AuditPayload<A extends AuditAction> = {
  readonly [F in Exclude<keyof Fields<A>, OptionalKeys<A>>]: FieldValue<Fields<A>[F]>;
} & {
  readonly [F in OptionalKeys<A>]?: FieldValue<Fields<A>[F]>;
};

/** Upper bound of the canonical JSON payload, in UTF-8 bytes. */
export const MAX_AUDIT_PAYLOAD_BYTES = 2048;

/** Most codes in one `codes` field. */
export const MAX_AUDIT_CODES = 16;

const SHA256 = /^[0-9a-f]{64}$/;
const CODE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;

function isValidField(kind: AuditFieldKind, value: unknown): boolean {
  switch (kind) {
    case 'uuid':
      return isUuid(value);
    case 'sha256':
      return typeof value === 'string' && SHA256.test(value);
    case 'version':
      return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
    case 'code':
      return typeof value === 'string' && CODE.test(value);
    case 'codes':
      return (
        Array.isArray(value) &&
        value.length >= 1 &&
        value.length <= MAX_AUDIT_CODES &&
        value.every((item) => typeof item === 'string' && CODE.test(item))
      );
    case 'decimal':
      return isUsd(value);
    case 'count':
      return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
  }
}

export function isAuditAction(action: unknown): action is AuditAction {
  return typeof action === 'string' && Object.hasOwn(AUDIT_ACTIONS, action);
}

/**
 * Checks an event against its declared spec and returns the payload with exactly the declared
 * fields. Throws `DbError('invalid_value')` for an unknown action, a missing, extra or badly
 * formatted field, or a wrong entity.
 */
export function checkAuditEvent(
  action: string,
  entityId: string | null,
  payload: Readonly<Record<string, unknown>>,
): { entityType: string | null; payload: Record<string, unknown> } {
  if (!isAuditAction(action)) throw invalid(`unknown audit action ${JSON.stringify(action)}`);
  const spec: AuditActionSpec = AUDIT_ACTIONS[action];
  if (spec.entityType === null ? entityId !== null : !isUuid(entityId)) {
    throw invalid(`${action}: entity ID must be ${spec.entityType ? 'a UUID' : 'null'}`);
  }
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw invalid(`${action}: payload must be an object`);
  }
  const extra = Object.keys(payload).filter((key) => !Object.hasOwn(spec.fields, key));
  if (extra.length > 0) throw invalid(`${action}: undeclared payload fields ${extra.join(', ')}`);
  const checked: Record<string, unknown> = {};
  for (const [field, declared] of Object.entries(spec.fields)) {
    const optional = declared.endsWith('?');
    const kind = (optional ? declared.slice(0, -1) : declared) as AuditFieldKind;
    const value = payload[field];
    if (optional && value === undefined) continue;
    if (!isValidField(kind, value))
      throw invalid(`${action}: payload field ${field} must be a ${kind}`);
    checked[field] = value;
  }
  return { entityType: spec.entityType, payload: checked };
}

function invalid(message: string): DbError {
  return new DbError('invalid_value', message);
}
