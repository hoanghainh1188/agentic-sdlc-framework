// The Evidence Builder (task E02, D-02 FR-40, FR-42, FR-43, D-08 E02, design/ADR-M48).
//
// - On demand (a person through the API) now; E03 calls `buildEvidencePack` with actor `system`
//   at G8 and seals one version.
// - One pack per build, never changed (QUESTIONS #215): the files go to new keys under
//   `evidence/packs/<tenant>/<intent>/<pack id>/` (`If-None-Match: *`), then a row with the next
//   version. A build whose content equals the latest version's returns that version; no build
//   after a version is sealed.
// - Every stored evidence file (proposals, diffs) is read back and its SHA-256 and size checked
//   against its row (ADR-M33 §2.9 gap 2). Any mismatch, missing or oversized file fails the build
//   closed: nothing is stored, and each failure is audited (`evidence.check_failed`).
// - Files are read one at a time, capped at `maxItemBytes`, never logged or kept.
import { createHash, randomUUID } from 'node:crypto';

import { EvidenceError, type EvidenceStore } from '@sdlc/contracts';
import { DEFAULT_LOCALE } from '@sdlc/messages';

import { toCostAmounts, WASTED_RUN_STATUSES } from '../cost/report.js';
import { DbError } from '../db/errors.js';
import type { Agent, EvidenceItem, EvidencePack, RunEventRow } from '../db/schema.js';
import type { TenantScope } from '../db/tenant-scope.js';
import { resolveEvidenceSubject, type EvidenceActor, type EvidenceSubject } from './access.js';
import { EvidencePackError } from './errors.js';
import { renderPackMarkdown } from './markdown.js';
import {
  buildManifestContent,
  contentSha256,
  manifestBytes,
  type PackSource,
  type VerifiedItem,
} from './manifest.js';

export interface EvidenceBuildDeps {
  readonly store: EvidenceStore;
  readonly now: () => Date;
  /** Largest evidence file read back (`SDLC_API_EVIDENCE_MAX_ITEM_MB`). */
  readonly maxItemBytes: number;
  readonly locale?: string;
  readonly newId?: () => string;
}

export interface EvidencePackResult {
  readonly intentCode: string;
  readonly pack: EvidencePack;
  /** False when the content equalled the latest version's: that version is returned. */
  readonly created: boolean;
}

const BUILD_ATTEMPTS = 3;
const ALL_TIME = { from: new Date(0), to: new Date('9999-12-31T00:00:00.000Z') };

const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

function actorFields(actor: EvidenceActor): {
  actorType: 'human' | 'system';
  actorId: string | null;
} {
  return actor.type === 'human'
    ? { actorType: 'human', actorId: actor.userId }
    : { actorType: 'system', actorId: null };
}

type CheckFailure = 'hash_mismatch' | 'size_mismatch' | 'missing' | 'too_large';

const FAILURE_CODE = {
  hash_mismatch: 'evidence_hash_mismatch',
  size_mismatch: 'evidence_hash_mismatch',
  missing: 'evidence_missing',
  too_large: 'evidence_too_large',
} as const;

/** Reads one stored file back and checks it against its row; undefined when it matches. */
async function checkItem(
  store: EvidenceStore,
  item: EvidenceItem,
  maxItemBytes: number,
): Promise<CheckFailure | undefined> {
  const size = Number(item.size_bytes);
  if (size > maxItemBytes) return 'too_large';
  let bytes: Buffer;
  try {
    bytes = await store.get(item.storage_uri, { maxBytes: size });
  } catch (error) {
    if (error instanceof EvidenceError && error.code === 'not_found') return 'missing';
    // Larger than the row says: the object changed.
    if (error instanceof EvidenceError && error.code === 'too_large') return 'size_mismatch';
    throw new EvidencePackError('evidence_unavailable', 'the evidence store cannot be read');
  }
  if (bytes.length !== size) return 'size_mismatch';
  return sha256(bytes) === item.sha256 ? undefined : 'hash_mismatch';
}

async function verifyItems(
  scope: TenantScope,
  actor: EvidenceActor,
  intentId: string,
  items: readonly EvidenceItem[],
  deps: EvidenceBuildDeps,
): Promise<VerifiedItem[]> {
  const failures: { item: EvidenceItem; reason: CheckFailure }[] = [];
  const verified: VerifiedItem[] = [];
  for (const item of items) {
    if (item.purged_at !== null) {
      verified.push({ item, check: 'purged' });
      continue;
    }
    const reason = await checkItem(deps.store, item, deps.maxItemBytes);
    if (reason) failures.push({ item, reason });
    else verified.push({ item, check: 'verified' });
  }
  if (failures.length === 0) return verified;
  // An oversized row is a setting, not tampering: only real mismatches are audited.
  const audited = failures.filter((failure) => failure.reason !== 'too_large');
  await scope.transaction(async (tx) => {
    for (const { item, reason } of audited) {
      await tx.audit.append({
        action: 'evidence.check_failed',
        ...actorFields(actor),
        entityId: item.id,
        occurredAt: deps.now(),
        payload: { intent_id: intentId, kind: item.kind, reason },
      });
    }
  });
  const first = failures[0]!;
  throw new EvidencePackError(
    FAILURE_CODE[first.reason],
    `evidence item ${first.item.id}: ${first.reason}`,
  );
}

async function loadSource(
  scope: TenantScope,
  actor: EvidenceActor,
  { intent, project }: EvidenceSubject,
  deps: EvidenceBuildDeps,
): Promise<PackSource> {
  const aiRecord = await scope.projectAiRecords.get(project.id);
  if (!aiRecord) throw new EvidencePackError('ai_record_missing', 'the project has no AI record');
  const [specs, plans, runs, decisions, escalations, items, sums] = await Promise.all([
    scope.specRefs.list(intent.id),
    scope.plans.list(intent.id),
    scope.runs.listForIntent(intent.id),
    scope.gateDecisions.listForIntent(intent.id),
    scope.escalations.listForIntent(intent.id),
    scope.evidenceItems.listForIntent(intent.id),
    scope.costRecords.reportTotals({
      ...ALL_TIME,
      intentId: intent.id,
      wastedStatuses: WASTED_RUN_STATUSES,
    }),
  ]);
  const runEvents = new Map<string, readonly RunEventRow[]>();
  const agents = new Map<string, Agent>();
  for (const run of runs) {
    runEvents.set(run.id, await scope.runEvents.list(run.id));
    if (!agents.has(run.agent_id)) {
      const agent = await scope.agents.getById(run.agent_id);
      if (agent) agents.set(agent.id, agent);
    }
  }
  const verified = await verifyItems(scope, actor, intent.id, items, deps);
  return {
    intent,
    project,
    aiRecord,
    specs,
    plans,
    runs,
    runEvents,
    agents,
    decisions,
    escalations,
    items: verified,
    cost: toCostAmounts(sums),
  };
}

/** Display names of the people who decided at the gates, read now (QUESTIONS #216). */
async function approverNames(scope: TenantScope, source: PackSource): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  for (const id of new Set(source.decisions.flatMap((d) => (d.decided_by ? [d.decided_by] : [])))) {
    const user = await scope.users.getById(id);
    if (user) names.set(id, user.display_name);
  }
  return names;
}

async function storePack(
  scope: TenantScope,
  actor: EvidenceActor,
  source: PackSource,
  content: Record<string, unknown>,
  contentHash: string,
  deps: EvidenceBuildDeps,
): Promise<EvidencePack> {
  const { intent } = source;
  const locale = deps.locale ?? DEFAULT_LOCALE;
  const names = await approverNames(scope, source);
  const builtBy = actor.type === 'human' ? actor.userId : null;
  const latest = await scope.evidencePacks.latest(intent.id);
  const build = {
    packId: (deps.newId ?? randomUUID)(),
    version: (latest?.version ?? 0) + 1,
    builtAt: deps.now(),
    builtBy,
    contentSha256: contentHash,
  };
  const manifest = manifestBytes(content, build);
  const markdown = Buffer.from(renderPackMarkdown({ source, build, names, locale }), 'utf8');
  const base = `${intent.id}/${build.packId}`;
  const [storedManifest, storedMarkdown] = await Promise.all([
    deps.store.put(scope.tenantId, `${base}/manifest.json`, manifest, 'application/json'),
    deps.store.put(scope.tenantId, `${base}/pack.md`, markdown, 'text/markdown'),
  ]).catch(() => {
    throw new EvidencePackError('evidence_unavailable', 'the pack files could not be stored');
  });
  return scope.transaction(async (tx) => {
    const pack = await tx.evidencePacks.record({
      id: build.packId,
      intentId: intent.id,
      version: build.version,
      contentSha256: contentHash,
      manifest: storedManifest,
      markdown: storedMarkdown,
      locale,
      disclosureFormat: source.aiRecord.disclosure_format,
      itemCount: source.items.length,
      builtBy,
    });
    await tx.audit.append({
      action: 'evidence.pack_built',
      ...actorFields(actor),
      entityId: pack.id,
      occurredAt: build.builtAt,
      payload: {
        intent_id: intent.id,
        version: pack.version,
        content_sha256: contentHash,
        manifest_sha256: storedManifest.sha256,
        markdown_sha256: storedMarkdown.sha256,
      },
    });
    return pack;
  });
}

/** Builds a new version of an intent's Evidence Pack, or returns the latest when nothing changed. */
export async function buildEvidencePack(
  scope: TenantScope,
  actor: EvidenceActor,
  intentCode: string,
  deps: EvidenceBuildDeps,
): Promise<EvidencePackResult> {
  const subject = await resolveEvidenceSubject(scope, actor, intentCode, 'build');
  const { intent } = subject;
  if (await scope.evidencePacks.isSealed(intent.id)) {
    throw new EvidencePackError('pack_sealed', 'a version of the pack is sealed');
  }
  const source = await loadSource(scope, actor, subject, deps);
  const content = buildManifestContent(source);
  const contentHash = contentSha256(content);
  for (let attempt = 1; attempt <= BUILD_ATTEMPTS; attempt += 1) {
    const latest = await scope.evidencePacks.latest(intent.id);
    if (latest && latest.content_sha256 === contentHash) {
      return { intentCode: intent.code, pack: latest, created: false };
    }
    try {
      const pack = await storePack(scope, actor, source, content, contentHash, deps);
      return { intentCode: intent.code, pack, created: true };
    } catch (error) {
      // A concurrent build took the version: try the next one (its files stay unreferenced).
      if (!(error instanceof DbError && error.code === 'conflict')) throw error;
    }
  }
  throw new EvidencePackError('pack_conflict', 'concurrent builds took every version tried');
}

export interface EvidencePackList {
  readonly intentCode: string;
  readonly packs: readonly EvidencePack[];
}

export async function listEvidencePacks(
  scope: TenantScope,
  actor: EvidenceActor,
  intentCode: string,
): Promise<EvidencePackList> {
  const { intent } = await resolveEvidenceSubject(scope, actor, intentCode, 'read');
  return { intentCode: intent.code, packs: await scope.evidencePacks.listForIntent(intent.id) };
}

/** One version; without `version`, the latest. */
export async function getEvidencePack(
  scope: TenantScope,
  actor: EvidenceActor,
  intentCode: string,
  version?: number,
): Promise<EvidencePackResult> {
  const { intent } = await resolveEvidenceSubject(scope, actor, intentCode, 'read');
  const pack =
    version === undefined
      ? await scope.evidencePacks.latest(intent.id)
      : await scope.evidencePacks.getVersion(intent.id, version);
  if (!pack) throw new EvidencePackError('pack_not_found', 'no such pack version');
  return { intentCode: intent.code, pack, created: false };
}

export type EvidencePackFile = 'manifest' | 'markdown';

export interface EvidencePackFileResult {
  readonly pack: EvidencePack;
  readonly content: Buffer;
}

/** Reads a pack file back and re-checks its SHA-256 and size; a mismatch is audited, fail closed. */
export async function readEvidencePackFile(
  scope: TenantScope,
  actor: EvidenceActor,
  intentCode: string,
  file: EvidencePackFile,
  deps: Pick<EvidenceBuildDeps, 'store' | 'now'>,
  version?: number,
): Promise<EvidencePackFileResult> {
  const { pack } = await getEvidencePack(scope, actor, intentCode, version);
  if (pack.purged_at !== null) throw new EvidencePackError('pack_purged', 'the pack was purged');
  const uri = file === 'manifest' ? pack.manifest_uri : pack.markdown_uri;
  const expected = file === 'manifest' ? pack.manifest_sha256 : pack.markdown_sha256;
  const size = Number(file === 'manifest' ? pack.manifest_size_bytes : pack.markdown_size_bytes);
  let reason: CheckFailure | undefined;
  let content: Buffer = Buffer.alloc(0);
  try {
    content = await deps.store.get(uri, { maxBytes: size });
    if (content.length !== size) reason = 'size_mismatch';
    else if (sha256(content) !== expected) reason = 'hash_mismatch';
  } catch (error) {
    if (error instanceof EvidenceError && error.code === 'not_found') reason = 'missing';
    else if (error instanceof EvidenceError && error.code === 'too_large') reason = 'size_mismatch';
    else throw new EvidencePackError('evidence_unavailable', 'the evidence store cannot be read');
  }
  if (reason === undefined) return { pack, content };
  await scope.audit.append({
    action: 'evidence.pack_check_failed',
    ...actorFields(actor),
    entityId: pack.id,
    occurredAt: deps.now(),
    payload: { intent_id: pack.intent_id, version: pack.version, file, reason },
  });
  throw new EvidencePackError(FAILURE_CODE[reason], `evidence pack ${pack.id}: ${reason}`);
}
