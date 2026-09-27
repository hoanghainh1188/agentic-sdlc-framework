// Optional live test of the GitHub poller (D-08 B06, design/ADR-M27 §2.7) against the TEST GitHub
// App on the TEST repository and a throw-away PostgreSQL. Never in CI: it needs the same two
// variables as the B05 live test (a static test checks that no CI workflow sets them) and a test
// database. The repository owner runs it in a terminal, never through a chat tool:
//
//   SDLC_GITHUB_LIVE_TEST=1 SDLC_GITHUB_TEST_APP_FILE=~/.config/sdlc-secrets/github-test-app.json \
//   SDLC_TEST_DB_DIR=platform/tests/integration/github pnpm test:db
//
// The App posts `/approve G9` on the test issue. Its author is the App, a bot, so the poller must
// record the receipt `ignored_bot`, record no decision and post no reply (QUESTIONS #45: bots never
// decide, and the platform never answers itself).
import fs from 'node:fs';
import path from 'node:path';

import { GitHubAdapter } from '@sdlc/adapter-git-github';
import { createSimplePolicyEngine } from '@sdlc/adapter-policy-simple';
import type { SecretReader } from '@sdlc/contracts';
import { sql } from 'kysely';
import { afterAll, describe, expect, it } from 'vitest';

import { parseTenantId } from '../../../packages/core/src/db/tenant-id.js';
import { pollProject } from '../../../packages/core/src/git-events/poll-project.js';
import { Registry } from '../../../packages/core/src/registry/registry.js';
import { repoRoot } from '../../workspace/helpers';
import { createTestDatabase, type TestDatabase } from '../db/helpers.js';

const enabled =
  process.env.SDLC_GITHUB_LIVE_TEST === '1' &&
  Boolean(process.env.SDLC_GITHUB_TEST_APP_FILE) &&
  Boolean(process.env.SDLC_TEST_DATABASE_URL);

interface LiveSettings {
  client_id: string;
  private_key_file: string;
  repo: string;
  issue: number;
}

function outsideRepo(file: string): string {
  const resolved = path.resolve(file);
  const root = repoRoot();
  if (resolved === root || resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error(`${resolved} is inside the repository; keep test App files outside it`);
  }
  return resolved;
}

describe.skipIf(!enabled)('GitHub poller, live (test App only)', () => {
  let db: TestDatabase | undefined;

  afterAll(async () => {
    await db?.drop();
  });

  it('polls the App’s own command comment, records ignored_bot, decides nothing, replies nothing', async () => {
    const s = JSON.parse(
      fs.readFileSync(outsideRepo(process.env.SDLC_GITHUB_TEST_APP_FILE!), 'utf8'),
    ) as LiveSettings;
    const pem = fs.readFileSync(outsideRepo(s.private_key_file), 'utf8');
    // The key stays in memory, as if OpenBao had returned it (production reads OpenBao only).
    const secrets: SecretReader = {
      read: () =>
        Promise.resolve({
          version: 1,
          data: { client_id: { reveal: () => s.client_id }, private_key: { reveal: () => pem } },
        }),
    };
    const gitHost = new GitHubAdapter({ secrets });
    const [owner = '', name = ''] = s.repo.split('/');

    db = await createTestDatabase();
    const tenant = await db.app.system.createTenant({ slug: 'live', name: 'Live' });
    const tenantId = parseTenantId(tenant.id);
    const project = await db.app.forTenant(tenantId).projects.create({
      slug: 'pilot',
      name: 'Pilot',
      git_provider: 'github',
      repo_full_name: s.repo,
    });
    const target = { tenantId, projectId: project.id, repoFullName: s.repo };
    const registry = new Registry({
      policyFactory: (config) => createSimplePolicyEngine({ config }),
    });
    const deps = { db: db.app, gitHost, registry };

    expect((await pollProject(deps, target)).status).toBe('polled'); // no history
    await gitHost.createIssueComment({ owner, name }, s.issue, '/approve G9');

    let receipt: Record<string, unknown> | undefined;
    for (let i = 0; i < 10 && !receipt; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 3000));
      await pollProject(deps, target);
      receipt = (
        await sql<Record<string, unknown>>`SELECT * FROM git_event_receipts`.execute(db.owner)
      ).rows[0];
    }
    expect(receipt).toMatchObject({ outcome: 'ignored_bot', reply_code: null });
    const decisions = await sql`SELECT id FROM gate_decisions`.execute(db.owner);
    expect(decisions.rows).toEqual([]);
    // One more poll: the App posted nothing in answer, so no new command comment appears.
    await pollProject(deps, target);
    const receipts = await sql`SELECT id FROM git_event_receipts`.execute(db.owner);
    expect(receipts.rows).toHaveLength(1);
  }, 90_000);
});
