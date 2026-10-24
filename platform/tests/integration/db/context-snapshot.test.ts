// D-08 X07 AC1–AC4 on a live PostgreSQL (design/ADR-M90, QUESTIONS #557 a): a run whose agent
// opened files and whose `read_documents` tool returned documents (`knowledge_read`) gets one
// context snapshot at the end; the database accepts the evidence kind (migration 0041) and the run
// event (`run_event_payload_is_coded`); the Evidence Pack lists the snapshot's hash and counts.
// No path, query or text reaches a table. The file reads of a real agent: `pnpm test:agent`.
import { describe, expect, it } from 'vitest';

import { recordContextSnapshot } from '../../../apps/runner/src/index.js';
import { buildEvidencePack } from '../../../packages/core/src/evidence/build.js';
import { g7World } from './g7-world.js';
import { describeDb } from './helpers.js';
import { MemoryEvidenceStore, sha256 } from './memory-evidence-store.js';

const SECRET_PATH = 'apps/api/src/secret-client-module.ts';
const INDEX = '66666666-6666-4666-8666-666666666666';
const LIST = 'c'.repeat(64);

describeDb('X07: the context snapshot on PostgreSQL', () => {
  const w = g7World();

  describe('a run that read files and searched documents', () => {
    it('records the snapshot as evidence and a run event, and the pack lists it (AC1–AC4)', async () => {
      const scope = w.t.f.scope;
      const intent = await w.toG7();
      const [run] = await scope.runs.listForIntent(intent.id);
      const runId = run!.id;
      const store = new MemoryEvidenceStore();
      await scope.runEvents.append(runId, 'agent_started', {
        max_iterations: 30,
        max_duration_min: 60,
      });
      // What the tool returned, as the runner records it from the tool's log (X04 PR 3b).
      await scope.runEvents.append(runId, 'knowledge_read', {
        tool_key: 'project-docs',
        index_id: INDEX,
        list_sha256: LIST,
        documents: 2,
        chunks: 5,
      });

      const runnerScope = scope as unknown as Parameters<typeof recordContextSnapshot>[0];
      await recordContextSnapshot(runnerScope, store, runId, {
        paths: [SECRET_PATH, 'README.md'],
        outside: 0,
        unattributed: 1,
      });

      const event = (await scope.runEvents.list(runId)).find(
        (e) => e.event_type === 'context_snapshot',
      );
      const items = (await scope.evidenceItems.listForIntent(intent.id)).filter(
        (i) => i.kind === 'context_snapshot',
      );
      expect(items).toHaveLength(1);
      const content = store.text(items[0]!.storage_uri);
      expect(event?.payload).toEqual({
        snapshot_sha256: sha256(Buffer.from(content)),
        source: 'agent_log',
        files: 2,
        files_outside: 0,
        unattributed_calls: 1,
        document_tools: 1,
        documents: 2,
      });
      expect(JSON.parse(content)).toMatchObject({
        run_id: runId,
        documents: [{ tool_key: 'project-docs', list_sha256: LIST, documents: 2 }],
        files: { source: 'agent_log', path_sha256: expect.any(Array) as unknown },
      });
      expect(content).not.toContain('secret-client-module');

      // AC2: the Evidence Pack shows the snapshot's hash and counts for the run.
      const built = await buildEvidencePack(
        scope,
        { type: 'human', userId: w.t.f.users.a },
        intent.code,
        { store, now: () => new Date(), maxItemBytes: 1024 * 1024 },
      );
      const manifest = JSON.parse(store.text(built.pack.manifest_uri)) as {
        runs: { id: string; events: Record<string, unknown> }[];
        evidence_items: { kind: string; sha256: string; check: string }[];
      };
      expect(manifest.runs.find((r) => r.id === runId)?.events.context_snapshot).toEqual(
        event?.payload,
      );
      expect(manifest.evidence_items).toContainEqual(
        expect.objectContaining({ kind: 'context_snapshot', check: 'verified' }),
      );
      const markdown = store.text(built.pack.markdown_uri);
      expect(markdown).toMatch(/context\\?_snapshot/);
      // AC3: no path in any run event or evidence row of the run.
      const rows = JSON.stringify([await scope.runEvents.list(runId), items]);
      expect(rows).not.toContain('secret-client-module');
      expect(rows).not.toContain('README');
    });
  });
});
