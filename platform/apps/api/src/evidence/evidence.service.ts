// Evidence Packs of an intent (task E02, D-02 FR-40, FR-42, FR-43, ADR-M48). Building reads every
// stored evidence file back and checks its hash (fail closed), then stores the manifest and the
// Markdown file under `evidence/packs/` with the api's own SeaweedFS identity (`api-evidence`).
// Access: `access.evidence_build_roles` / `access.evidence_read_roles`, tenant admins always;
// no role → 404, another role → 403. Without an evidence store (no credential, or dev mode
// without OpenBao): access is checked first, then `evidence_unavailable` (503).
import {
  buildEvidencePack,
  EvidencePackError,
  getEvidencePack,
  listEvidencePacks,
  readEvidencePackFile,
  resolveEvidenceSubject,
  type EvidenceAccess,
} from '@sdlc/core';
import type { EvidenceStore } from '@sdlc/contracts';

import type { Principal } from '../auth/principal.js';
import { presentPack } from './present.js';
import type { PackFile } from './schemas.js';

export interface EvidenceServiceDeps {
  readonly store: EvidenceStore | undefined;
  readonly maxItemBytes: number;
  readonly now: () => Date;
}

export class EvidenceService {
  constructor(private readonly deps: EvidenceServiceDeps) {}

  private async store(p: Principal, ref: string, access: EvidenceAccess): Promise<EvidenceStore> {
    if (this.deps.store) return this.deps.store;
    await resolveEvidenceSubject(p.scope, { type: 'human', userId: p.userId }, ref, access);
    throw new EvidencePackError('evidence_unavailable', 'no evidence store in this process');
  }

  async build(
    p: Principal,
    ref: string,
  ): Promise<{ created: boolean; body: Record<string, unknown> }> {
    const store = await this.store(p, ref, 'build');
    const result = await buildEvidencePack(p.scope, { type: 'human', userId: p.userId }, ref, {
      store,
      now: this.deps.now,
      maxItemBytes: this.deps.maxItemBytes,
    });
    return {
      created: result.created,
      body: { pack: presentPack(result.intentCode, result.pack), created: result.created },
    };
  }

  async list(p: Principal, ref: string): Promise<Record<string, unknown>> {
    const { intentCode, packs } = await listEvidencePacks(
      p.scope,
      { type: 'human', userId: p.userId },
      ref,
    );
    return { intent: intentCode, packs: packs.map((pack) => presentPack(intentCode, pack)) };
  }

  async show(p: Principal, ref: string, version: number): Promise<Record<string, unknown>> {
    const { intentCode, pack } = await getEvidencePack(
      p.scope,
      { type: 'human', userId: p.userId },
      ref,
      version,
    );
    return { pack: presentPack(intentCode, pack) };
  }

  async file(
    p: Principal,
    ref: string,
    version: number,
    file: PackFile,
  ): Promise<Record<string, unknown>> {
    const store = await this.store(p, ref, 'read');
    const { pack, content } = await readEvidencePackFile(
      p.scope,
      { type: 'human', userId: p.userId },
      ref,
      file,
      { store, now: this.deps.now },
      version,
    );
    return {
      file: {
        intent_id: pack.intent_id,
        version: pack.version,
        name: file === 'manifest' ? 'manifest.json' : 'pack.md',
        media_type: file === 'manifest' ? 'application/json' : 'text/markdown',
        sha256: file === 'manifest' ? pack.manifest_sha256 : pack.markdown_sha256,
        size_bytes: content.length,
        content: content.toString('utf8'),
      },
    };
  }
}
