// D-08 B05 AC2 on a live PostgreSQL: the polling cursor is stored in `git_event_cursors` (D-05
// §6.1) through the tenant-scoped repository, and after a restart (a new adapter instance, cursor
// read back from the database) no event is returned twice. GitHub is the in-process stub.
import { INITIAL_EVENT_CURSOR, type EventCursor, type GitEvent } from '@sdlc/contracts';
import { afterAll, beforeAll, expect, it } from 'vitest';

import { parseTenantId } from '../../../packages/core/src/db/tenant-id.js';
import type { TenantScope } from '../../../packages/core/src/db/tenant-scope.js';
import { startHarness, type Harness } from '../../git-github/helpers.js';
import { comment, REPO } from '../../git-github/stub-github.js';
import { createTestDatabase, describeDb, type TestDatabase } from './helpers.js';

describeDb('B05 AC2: polling cursor stored in git_event_cursors', () => {
  let t: TestDatabase;
  let h: Harness;
  let scope: TenantScope;
  let projectId: string;
  const comments: ReturnType<typeof comment>[] = [];

  beforeAll(async () => {
    t = await createTestDatabase();
    const tenant = await t.app.system.createTenant({ slug: 'internal', name: 'Internal' });
    scope = t.app.forTenant(parseTenantId(tenant.id));
    const project = await scope.projects.create({
      slug: 'shop',
      name: 'Shop',
      git_provider: 'github',
      repo_full_name: 'acme/shop',
    });
    projectId = project.id;
    h = await startHarness();
    h.stub.on('GET', '/repos/acme/shop', { body: { id: 1 } });
    h.stub.on('GET', '/repos/acme/shop/issues/comments', (req) => ({
      body: comments.filter((c) => Date.parse(c.updated_at) >= Date.parse(req.query.get('since')!)),
    }));
    h.stub.on('GET', '/repos/acme/shop/pulls', { body: [] });
  });

  afterAll(async () => {
    await h?.stub.stop();
    await t?.drop();
  });

  /** One poller cycle as B06 will run it: read the cursor, poll, handle, store `next`. */
  async function cycle(): Promise<GitEvent[]> {
    const stored = await scope.gitEventCursors.get(projectId);
    const cursor = (stored?.cursor ?? INITIAL_EVENT_CURSOR) as EventCursor;
    // A new adapter instance each time: nothing survives in memory, as after a restart.
    const { events, next } = await h.adapter().listEventsSince(REPO, cursor);
    await scope.gitEventCursors.save(projectId, next, h.stub.now);
    return events;
  }

  it('starts without history, then returns each new comment exactly once across restarts', async () => {
    comments.push(comment(1, 3, '2026-09-26T07:00:00Z', 'old'));
    expect(await cycle()).toEqual([]);
    const first = await scope.gitEventCursors.get(projectId);
    expect(first?.cursor).toMatch(/^\{"comments":/);

    comments.push(comment(2, 3, '2026-09-26T08:00:10Z', '/approve G1'));
    expect((await cycle()).map((e) => e.id)).toEqual(['github:comment:2']);
    // Restart: the same comment is still inside GitHub's `since` window, but not returned again.
    expect(await cycle()).toEqual([]);

    comments.push(comment(3, 3, '2026-09-26T08:00:10Z', '/approve G2'));
    expect((await cycle()).map((e) => e.id)).toEqual(['github:comment:3']);
    expect(await cycle()).toEqual([]);
  });

  it('keeps the cursor free of comment text (only times and numeric IDs)', async () => {
    const stored = await scope.gitEventCursors.get(projectId);
    expect(stored?.cursor).not.toContain('approve');
    expect(stored?.cursor).toMatch(/^[{}[\]",:a-z0-9]+$/);
  });
});
