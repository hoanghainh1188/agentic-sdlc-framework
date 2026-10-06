// Opt-in LIVE test of C09 (D-08 C09 AC1 and AC2 N6 on the real sample repository; never in CI).
// Run it yourself in a terminal (not through a chat tool), on a machine with Docker:
//
//   SDLC_PILOT_LIVE_TEST=1 SDLC_GITHUB_TEST_APP_FILE=<file outside the repo> pnpm test:pilot-live
//
// The platform runs in this process as in `pnpm test:pilot` (throw-away PostgreSQL, the Temporal
// test server, StubOpenBao, the real runner with a node24 sandbox and the stub model as LiteLLM: no
// model key), but every GitHub call goes to the real `harryforge/pilot-order-inventory` through
// the TEST GitHub App (GETTING-STARTED Step 11, Step 14 item 1):
// 1. T01 (Low): G1 by the CLI → G2 and G3 by HOTL → G4 by policy → a real run → a real push to
//    `agent/INT-<year>-0001` → a real pull request (codes only) → the pilot's real `ci-ok` → G6 →
//    G7. Nothing is merged. With unknown code-scanning findings G6 is HITL: Person B approves it.
// 2. N6: `main` is protected (checked first); a push of the agent's commit to `main` with a
//    `contents: write` token is refused by the real branch protection.
// 3. Clean-up: the pull request is closed and the branch deleted (also left-overs of an earlier
//    run, at the start).
// E07 (D-08 E07 AC1), with SDLC_PILOT_LIVE_G8=1: after N6 the test does NOT close the pull request.
// It prints what Person B must do and waits (deterministic poll, SDLC_PILOT_LIVE_MERGE_TIMEOUT_MINUTES,
// default 60) until Person B, with their own GitHub account, approved the pull request and merged
// it on GitHub: a person merges, never the platform or the App. Then G8: the worker builds the
// release pack, Person B approves the release (CLI), the pack is sealed, the intent is `done`, and
// `sdlc audit verify` passes. The merged change is one fixed, fictional line appended to
// `docs/live-test/RUNS.md` (the plan allows `docs/live-test/**` only; never application code).
// Prerequisite (QUESTIONS #230): the plan file `.sdlc/plans/INT-<UTC year>-0001.yaml` on `main`,
// merged once by a person (content: `fixtures/live-plan.yaml`). The intents get no issue, so the
// platform posts no comment on the public repository; the pull request's text is codes only.
// Settings file (JSON, outside the repo): { "client_id", "private_key_file", "repo" }, and for the
// G8 path also "person_b_github_id" (the numeric ID of Person B's account) and "person_b_login".
// Optional: SDLC_SANDBOX_IMAGE (skips the build), SDLC_PILOT_LIVE_CI_TIMEOUT_MINUTES (default 30).
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { GitHubAdapter } from '@sdlc/adapter-git-github';
import type { RepoRef, SecretReader } from '@sdlc/contracts';
import { describe, expect, it } from 'vitest';

import { authEnv, cloneForPush, pushCommit } from '../../../apps/runner/src/index.js';
import { repoRoot } from '../../workspace/helpers';
import { PilotStack, SPECS, waitLong } from './stack.js';

const execFileAsync = promisify(execFile);
const PILOT = 'harryforge/pilot-order-inventory';
/** The plan's only path pattern (`fixtures/live-plan.yaml`): never the application code. */
const LIVE_PATHS = ['docs/live-test/**'];
const LIVE_FILE = 'docs/live-test/RUNS.md';
const withG8 = process.env.SDLC_PILOT_LIVE_G8 === '1';
const enabled =
  process.env.SDLC_PILOT_LIVE_TEST === '1' &&
  Boolean(process.env.SDLC_GITHUB_TEST_APP_FILE) &&
  Boolean(process.env.SDLC_TEMPORAL_TEST_SERVER);

function outsideRepo(file: string): string {
  const resolved = path.resolve(file);
  const root = repoRoot();
  if (resolved === root || resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error(`${resolved} is inside the repository; keep test App files outside it`);
  }
  return resolved;
}

interface LiveSettings {
  client_id: string;
  private_key_file: string;
  repo: string;
  /** E07 live G8: Person B's own GitHub account (numeric ID, as on `GET /users/<login>`). */
  person_b_github_id?: number;
  person_b_login?: string;
}

/** Person B's account from the settings file; the G8 path refuses to start without it. */
function personB(settings: LiveSettings): { gh: number; login: string } {
  const gh = settings.person_b_github_id;
  const login = settings.person_b_login;
  if (!Number.isSafeInteger(gh) || (gh ?? 0) <= 0 || typeof login !== 'string' || login === '') {
    throw new Error(
      'SDLC_PILOT_LIVE_G8=1 needs "person_b_github_id" (a number) and "person_b_login" in the ' +
        'settings file (GETTING-STARTED Step 14)',
    );
  }
  return { gh: gh!, login };
}

async function api(token: string, method: string, route: string, body?: unknown) {
  const res = await fetch(`https://api.github.com/${route}`, {
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
  return { status: res.status, json: text ? (JSON.parse(text) as unknown) : {} };
}

describe.skipIf(!enabled)('C09 and E07 live: T01 on the real pilot (test App only)', () => {
  it('T01 goes G1 → G6 on the real pilot, then N6; with SDLC_PILOT_LIVE_G8=1 on to G8', async () => {
    const settings = JSON.parse(
      fs.readFileSync(outsideRepo(process.env.SDLC_GITHUB_TEST_APP_FILE!), 'utf8'),
    ) as LiveSettings;
    if (settings.repo !== PILOT) throw new Error(`the live test runs on ${PILOT} only`);
    const b = withG8 ? personB(settings) : undefined;
    const pem = fs.readFileSync(outsideRepo(settings.private_key_file), 'utf8');
    const secrets: SecretReader = {
      read: () =>
        Promise.resolve({
          version: 1,
          data: {
            client_id: { reveal: () => settings.client_id },
            private_key: { reveal: () => pem },
          },
        }),
    };
    const adapter = new GitHubAdapter({ secrets });
    const [owner = '', name = ''] = PILOT.split('/');
    const ref: RepoRef = { owner, name };
    const code = `INT-${String(new Date().getUTCFullYear())}-0001`;
    const branch = `agent/${code}`;
    const write = await adapter.issueShortLivedToken(ref, {
      permissions: { contents: 'write', pull_requests: 'write' },
    });
    const token = write.token.reveal();

    // The prerequisite: the plan file of the first intent on `main` (QUESTIONS #230).
    const main = await adapter.getBranchHead(ref, 'main');
    const planFile = `.sdlc/plans/${code}.yaml`;
    const plan = await adapter.getFileAtCommit(ref, planFile, main).catch(() => null);
    if (
      plan === null ||
      !plan.includes(`intent_id: ${code}`) ||
      !plan.includes('[stub:live]') ||
      !plan.includes('docs/live-test/**')
    ) {
      throw new Error(
        `${planFile} is missing on ${PILOT} main or has another content (a new year needs a new ` +
          'file): merge platform/tests/integration/pilot/fixtures/live-plan.yaml there with the ' +
          `intent code ${code} (GETTING-STARTED Step 14), then run again`,
      );
    }
    const agentsMd = await adapter.getFileAtCommit(ref, 'AGENTS.md', main);

    const cleanUp = async () => {
      const open = (await api(
        token,
        'GET',
        `repos/${PILOT}/pulls?state=open&head=${owner}:${encodeURIComponent(branch)}`,
      )) as { json: { number: number }[] };
      for (const pr of open.json) {
        await api(token, 'PATCH', `repos/${PILOT}/pulls/${String(pr.number)}`, { state: 'closed' });
      }
      await api(token, 'DELETE', `repos/${PILOT}/git/refs/heads/${branch}`);
    };
    await cleanUp(); // left-overs of an earlier run

    const s = new PilotStack();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-c09-live-'));
    try {
      await s.startPilot({
        live: {
          gitHost: adapter,
          repoFullName: PILOT,
          agentsMd,
          ...(b ? { githubAccounts: { b } } : {}),
        },
      });
      const intent = await s.createIntent('low');
      expect(intent.code, 'a throw-away tenant starts at 0001').toBe(code);
      await s.atGate(intent, 'G1');
      await s.approve('a', 'G1', intent);
      await s.atGate(intent, 'G2');
      await s.cliJson('a', ['spec', 'link', code, '--path', SPECS.T01]);
      await s.cliJson('a', ['plan', 'submit', code]);
      const submitted = await s.scope.plans.latest(intent.id);
      expect(submitted?.planned_files).toEqual(LIVE_PATHS);

      const run = await s.runEnded(intent);
      expect(run).toMatchObject({ status: 'succeeded' });
      const linked = await waitLong(
        () => s.reload(intent),
        (i) => i.pr_number !== null,
      );
      process.stdout.write(`c09-live: pull request #${String(linked.pr_number)} opened\n`);

      // The pilot's real CI; the poller wakes the intent when `ci-ok` completes.
      const minutes = Number(process.env.SDLC_PILOT_LIVE_CI_TIMEOUT_MINUTES ?? '30');
      const deadline = Date.now() + minutes * 60_000;
      let approvedG6 = false;
      for (;;) {
        await s.poll();
        const now = await s.reload(intent);
        if (now.current_gate === 'G7' || now.status !== 'in_gate' || now.current_gate !== 'G6') {
          break;
        }
        if (!approvedG6 && (await s.noticeKinds(intent)).includes('g6_decision')) {
          // Code-scanning findings unknown or above the threshold: HITL, Person B approves.
          await s.approve('b', 'G6', intent);
          approvedG6 = true;
        }
        if (Date.now() > deadline)
          throw new Error(`CI did not finish within ${String(minutes)} min`);
        await new Promise((resolve) => setTimeout(resolve, 15_000));
      }
      const atG7 = await s.reload(intent);
      process.stdout.write(
        `c09-live: ${atG7.status} ${String(atG7.current_gate)}; G6 decisions ${JSON.stringify(
          await s.decisions(intent, 'G6'),
        )}\n`,
      );
      expect(atG7).toMatchObject({ status: 'in_gate', current_gate: 'G7' });

      // N6: the real branch protection refuses a push of the agent's commit to `main`.
      const pushed = (await s.runs(intent))[0]!;
      const protection = (await api(token, 'GET', `repos/${PILOT}/branches/main`)) as {
        json: { protected?: boolean };
      };
      expect(protection.json.protected, 'main must be protected before the N6 push').toBe(true);
      const git = s.runnerSettings.git;
      const repoDir = await cloneForPush(git, { repo: PILOT, token: write.token, dir });
      const home = path.join(dir, 'home');
      fs.mkdirSync(home, { recursive: true });
      const gitEnv = {
        PATH: process.env.PATH,
        HOME: home,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_TERMINAL_PROMPT: '0',
        ...authEnv(git, write.token),
      };
      // The agent's commit must be in the local clone, so a refusal can only come from GitHub.
      await execFileAsync(
        'git',
        ['-C', repoDir, 'fetch', '--quiet', `https://github.com/${PILOT}.git`, branch],
        { env: gitEnv },
      );
      await execFileAsync(
        'git',
        ['-C', repoDir, 'cat-file', '-e', `${pushed.head_sha!}^{commit}`],
        {
          env: gitEnv,
        },
      );
      await expect(
        pushCommit(git, {
          repoDir,
          repo: PILOT,
          branch: 'main',
          commit: pushed.head_sha!,
          token: write.token,
          home,
        }),
      ).rejects.toMatchObject({ reason: 'push_rejected' });
      await expect(
        execFileAsync(
          'git',
          [
            '-C',
            repoDir,
            'push',
            '--quiet',
            `https://github.com/${PILOT}.git`,
            `${pushed.head_sha!}:refs/heads/main`,
          ],
          { env: gitEnv },
        ),
      ).rejects.toThrow(/protected branch/i);
      expect(await adapter.getBranchHead(ref, 'main')).toBe(main);

      if (b) {
        // E07: a person merges on GitHub; the test only waits for it (never merges itself).
        process.stdout.write(
          [
            '',
            `e07-live: Person B (${b.login}), please now, on GitHub:`,
            `  1. review https://github.com/${PILOT}/pull/${String(linked.pr_number)} and approve it;`,
            '  2. merge it (merge commit or squash), with the same account.',
            `e07-live: waiting up to ${process.env.SDLC_PILOT_LIVE_MERGE_TIMEOUT_MINUTES ?? '60'} minutes for the merge…`,
            '',
          ].join('\n'),
        );
        const mergeMinutes = Number(process.env.SDLC_PILOT_LIVE_MERGE_TIMEOUT_MINUTES ?? '60');
        const mergeDeadline = Date.now() + mergeMinutes * 60_000;
        for (;;) {
          await s.poll();
          const now = await s.reload(intent);
          if (now.current_gate !== 'G7' || now.status !== 'in_gate') break;
          if (Date.now() > mergeDeadline) {
            throw new Error(`no merge within ${String(mergeMinutes)} min`);
          }
          await new Promise((resolve) => setTimeout(resolve, 15_000));
        }
        const atG8 = await s.reload(intent);
        process.stdout.write(`e07-live: ${atG8.status} ${String(atG8.current_gate)}\n`);
        expect(atG8, 'Person B must approve, then merge (G7)').toMatchObject({
          status: 'in_gate',
          current_gate: 'G8',
        });
        const merged = await adapter.getBranchHead(ref, 'main');
        expect(await adapter.getFileAtCommit(ref, LIVE_FILE, merged)).toContain('fictional');

        await waitLong(
          () => s.noticeKinds(intent),
          (kinds) => kinds.includes('g8_review_needed'),
        );
        await s.approve('b', 'G8', intent);
        const done = await s.until(intent, 'done');
        expect(done).toMatchObject({ status: 'done', current_gate: 'G8' });
        const sealed = (await s.scope.evidencePacks.listForIntent(intent.id)).filter(
          (p) => p.sealed_at !== null,
        );
        expect(sealed).toHaveLength(1);
        const chain = await s.cliJson<{ ok: boolean }>('admin', ['audit', 'verify']);
        expect(chain.ok).toBe(true);
        process.stdout.write(
          `e07-live: ${intent.code} done; pack version ${String(sealed[0]!.version)} sealed\n`,
        );
      }
    } finally {
      await cleanUp();
      await s.stopPilot();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 3_600_000);
});
