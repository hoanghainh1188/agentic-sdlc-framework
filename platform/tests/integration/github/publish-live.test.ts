// Optional live test of the C08 push and pull request against the TEST GitHub App on the TEST
// repository (D-08 C08 AC1, AC3; design/ADR-M38 §2.2–§2.4; QUESTIONS #57, #123). Never in CI: it
// runs only when both variables are set on a developer machine (run it in a terminal, not through
// a chat tool), with the same settings file as `live.test.ts`:
//
//   SDLC_GITHUB_LIVE_TEST=1
//   SDLC_GITHUB_TEST_APP_FILE=/path/outside/the/repo/github-test-app.json
//
// The test App needs Contents and Pull requests "Read and write" (GETTING-STARTED Step 11). The
// test repository is public: everything this test writes is a fixed, fictional text.
//
// 1. With a single-repository `contents: write` token, the runner's own code clones without a
//    working tree and pushes one commit to a throw-away `agent/INT-9999-…` branch.
// 2. The adapter finds no pull request, opens one, and finds it again; it shows the pushed commit.
// 3. QUESTIONS #57: the App submits a `COMMENT` review on the pull request; the poller must see it
//    (`review_submitted`). The test also prints whether the pull request's `updated_at` changed.
// 4. AC3, N6: the runner's guard refuses `main`; then a direct push of the same commit to `main`
//    with the write token must be refused by branch protection. The test checks first that GitHub
//    reports `main` as protected, and stops before pushing if it does not.
// 5. Clean-up: the pull request is closed and the branch deleted.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { GitHubAdapter } from '@sdlc/adapter-git-github';
import { INITIAL_EVENT_CURSOR, type RepoRef, type SecretReader } from '@sdlc/contracts';
import { describe, expect, it } from 'vitest';

import {
  authEnv,
  cloneForPush,
  pushCommit,
  remoteBranchHead,
  runnerSettingsFromEnv,
} from '../../../apps/runner/src/index.js';
import { repoRoot } from '../../workspace/helpers';

const execFileAsync = promisify(execFile);
const API = 'https://api.github.com';

const enabled =
  process.env.SDLC_GITHUB_LIVE_TEST === '1' && Boolean(process.env.SDLC_GITHUB_TEST_APP_FILE);

interface LiveSettings {
  client_id: string;
  private_key_file: string;
  repo: string;
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

async function api(
  token: string,
  method: string,
  route: string,
  body?: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${API}/${route}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  return { status: res.status, json: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
}

describe.skipIf(!enabled)('C08 push and pull request, live (test App only)', () => {
  it('pushes an agent branch, opens and finds the PR, sees a review, and main refuses a push (N6)', async () => {
    const s = settings();
    const [owner = '', name = ''] = s.repo.split('/');
    const ref: RepoRef = { owner, name };
    const pem = fs.readFileSync(outsideRepo(s.private_key_file), 'utf8');
    const secrets: SecretReader = {
      read: () =>
        Promise.resolve({
          version: 1,
          data: { client_id: { reveal: () => s.client_id }, private_key: { reveal: () => pem } },
        }),
    };
    const adapter = new GitHubAdapter({ secrets });
    const push = await adapter.issueShortLivedToken(ref, { permissions: { contents: 'write' } });
    expect(push.permissions).toEqual({ contents: 'write' });
    const write = await adapter.issueShortLivedToken(ref, {
      permissions: { contents: 'write', pull_requests: 'write' },
    });

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-c08-live-'));
    const git = runnerSettingsFromEnv({ SDLC_RUNNER_WORK_DIR: dir }).git;
    const branch = `agent/INT-9999-${String(Date.now() % 1_000_000_000).padStart(9, '0')}`;
    let prNumber: number | null = null;
    try {
      const main = await adapter.getBranchHead(ref, 'main');
      const repoDir = await cloneForPush(git, { repo: s.repo, token: push.token, dir });
      const home = path.join(dir, 'home');
      const env = {
        PATH: process.env.PATH,
        HOME: home,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_INDEX_FILE: path.join(dir, 'index'),
        GIT_AUTHOR_NAME: 'sdlc-agent',
        GIT_AUTHOR_EMAIL: 'agent-live-test@agents.sdlc.invalid',
        GIT_COMMITTER_NAME: 'sdlc-agent',
        GIT_COMMITTER_EMAIL: 'agent-live-test@agents.sdlc.invalid',
      };
      const run = async (...args: string[]) =>
        (await execFileAsync('git', ['-C', repoDir, ...args], { env })).stdout.trim();
      await run('read-tree', main);
      const blobFile = path.join(dir, 'blob.md');
      fs.writeFileSync(blobFile, 'Automatic test of the SDLC platform (C08). Fictional.\n');
      const blob = await run('hash-object', '-w', blobFile);
      await run('update-index', '--add', '--cacheinfo', `100644,${blob},sdlc-live-test/C08.md`);
      const tree = await run('write-tree');
      const commit = await run('commit-tree', tree, '-p', main, '-m', 'sdlc: C08 live test');

      // 1. The push with the runner's code.
      await pushCommit(git, { repoDir, repo: s.repo, branch, commit, token: push.token, home });
      expect(await remoteBranchHead(git, { repo: s.repo, branch, token: push.token, home })).toBe(
        commit,
      );

      // 2. The pull request.
      expect(await adapter.findOpenPullRequest(ref, branch, 'main')).toBeNull();
      const pr = await adapter.openPullRequest(ref, {
        head: branch,
        base: 'main',
        title: 'C08 live test (closed at once)',
        body: 'Automatic test of the SDLC platform (task C08). It is closed and deleted at once.',
      });
      prNumber = pr.number;
      expect(pr).toMatchObject({ state: 'open', headSha: commit, headRef: branch });
      expect((await adapter.findOpenPullRequest(ref, branch, 'main'))?.number).toBe(pr.number);

      // 3. QUESTIONS #57: a review, seen by polling.
      let { next } = await adapter.listEventsSince(ref, INITIAL_EVENT_CURSOR);
      const before = await api(write.token.reveal(), 'GET', `repos/${s.repo}/pulls/${pr.number}`);
      await new Promise((resolve) => setTimeout(resolve, 2000));
      const review = await api(
        write.token.reveal(),
        'POST',
        `repos/${s.repo}/pulls/${pr.number}/reviews`,
        {
          event: 'COMMENT',
          body: 'C08 live test review (QUESTIONS #57).',
        },
      );
      expect(review.status).toBe(200);
      const after = await api(write.token.reveal(), 'GET', `repos/${s.repo}/pulls/${pr.number}`);
      process.stdout.write(
        `QUESTIONS #57: a review changed the pull request's updated_at: ${String(
          before.json.updated_at !== after.json.updated_at,
        )}\n`,
      );
      let seen = false;
      for (let i = 0; i < 10 && !seen; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 3000));
        const res = await adapter.listEventsSince(ref, next);
        next = res.next;
        seen = res.events.some((e) => e.kind === 'review_submitted' && e.prNumber === pr.number);
      }
      expect(seen).toBe(true);

      // 4. AC3, N6: `main` refuses the push.
      await expect(
        pushCommit(git, { repoDir, repo: s.repo, branch: 'main', commit, token: push.token, home }),
      ).rejects.toMatchObject({ reason: 'push_rejected' });
      const protection = await api(write.token.reveal(), 'GET', `repos/${s.repo}/branches/main`);
      expect(protection.json.protected, 'main must be protected before the N6 push').toBe(true);
      await expect(
        execFileAsync(
          'git',
          [
            '-C',
            repoDir,
            'push',
            '--quiet',
            `https://github.com/${s.repo}.git`,
            `${commit}:refs/heads/main`,
          ],
          { env: { ...env, GIT_TERMINAL_PROMPT: '0', ...authEnv(git, push.token) } },
        ),
      ).rejects.toThrow();
      expect(await adapter.getBranchHead(ref, 'main')).toBe(main);
    } finally {
      // 5. Clean-up.
      if (prNumber !== null) {
        await api(write.token.reveal(), 'PATCH', `repos/${s.repo}/pulls/${String(prNumber)}`, {
          state: 'closed',
        });
      }
      await api(write.token.reveal(), 'DELETE', `repos/${s.repo}/git/refs/heads/${branch}`);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});
