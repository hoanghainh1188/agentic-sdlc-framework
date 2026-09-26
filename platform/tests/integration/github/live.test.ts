// Optional live test of the GitHub adapter against a TEST GitHub App on a TEST repository
// (D-08 B05, design/ADR-M23 §2.7). Never in CI: it runs only when both variables are set on a
// developer machine, and a static test checks that the CI workflow sets neither.
//
//   SDLC_GITHUB_LIVE_TEST=1
//   SDLC_GITHUB_TEST_APP_FILE=/path/outside/the/repo/github-test-app.json
//
// The JSON file (mode 600, outside the repository) holds:
//   { "client_id": "Iv…", "private_key_file": "/path/outside/the/repo/test-app.pem",
//     "repo": "owner/name", "issue": 1, "file_path": "README.md", "commit_sha": "<40 hex>" }
// Production code never reads the key from a file: here the file only feeds an in-memory
// `SecretReader`, like OpenBao would.
import fs from 'node:fs';
import path from 'node:path';

import { GitHubAdapter } from '@sdlc/adapter-git-github';
import { INITIAL_EVENT_CURSOR, type SecretReader } from '@sdlc/contracts';
import { describe, expect, it } from 'vitest';

import { repoRoot } from '../../workspace/helpers';

const enabled =
  process.env.SDLC_GITHUB_LIVE_TEST === '1' && Boolean(process.env.SDLC_GITHUB_TEST_APP_FILE);

interface LiveSettings {
  client_id: string;
  private_key_file: string;
  repo: string;
  issue: number;
  file_path: string;
  commit_sha: string;
}

function outsideRepo(file: string): string {
  const resolved = path.resolve(file);
  const root = repoRoot();
  if (resolved === root || resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error(`${resolved} is inside the repository; keep test App files outside it`);
  }
  return resolved;
}

function settings(): LiveSettings {
  const file = outsideRepo(process.env.SDLC_GITHUB_TEST_APP_FILE!);
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as LiveSettings;
  outsideRepo(parsed.private_key_file);
  return parsed;
}

describe.skipIf(!enabled)('GitHub adapter, live (test App only)', () => {
  it('issues a one-repo token, posts a comment, polls it back and reads a file', async () => {
    const s = settings();
    const [owner = '', name = ''] = s.repo.split('/');
    const ref = { owner, name };
    const pem = fs.readFileSync(outsideRepo(s.private_key_file), 'utf8');
    const secrets: SecretReader = {
      read: () =>
        Promise.resolve({
          version: 1,
          data: { client_id: { reveal: () => s.client_id }, private_key: { reveal: () => pem } },
        }),
    };
    const adapter = new GitHubAdapter({ secrets });

    const token = await adapter.issueShortLivedToken(ref, { permissions: { contents: 'read' } });
    expect(token.repo).toEqual(ref);
    expect(token.permissions).toEqual({ contents: 'read' });

    let { next } = await adapter.listEventsSince(ref, INITIAL_EVENT_CURSOR);
    const marker = `B05 live test ${new Date().toISOString()}`;
    await adapter.createIssueComment(ref, s.issue, marker);
    let found = false;
    for (let i = 0; i < 10 && !found; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 3000));
      const res = await adapter.listEventsSince(ref, next);
      next = res.next;
      found = res.events.some((e) => e.kind === 'comment_created' && e.body === marker);
    }
    expect(found).toBe(true);

    const content = await adapter.getFileAtCommit(ref, s.file_path, s.commit_sha);
    expect(content.length).toBeGreaterThan(0);
  }, 60_000);
});
