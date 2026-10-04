// D-08 C09 AC1 and AC2 (N6) on the sample repository's shape (see stack.ts), run with
// `pnpm test:pilot` (CI job `sandbox-image`):
// - AC1 (D-09 T01, Low): `/approve G1` by comment → G2 and G3 pass by HOTL (the pilot's T01 spec
//   and a T13 plan whose task text is the stub model's script) → G4 by policy → the real runner
//   runs the agent in a node24 sandbox → G5 passes (HOTL) → after the block window the runner
//   pushes `agent/INT-…` and the platform opens the pull request → `ci-ok` passes → G6 passes
//   (AUDIT at Low) → G7.
// - AC2 N6: the push went to the agent branch only; a push to `main` with a write token is
//   refused by the Git host's protection, and the runner's own guard refuses `main`.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { pushCommit } from '../../../apps/runner/src/index.js';
import { describeDb } from '../db/helpers.js';
import { OWNER, REPO } from '../workflow/g1-g3/stack.js';
import { NOTES_FILE, PilotStack, SPECS, T01_PATHS, waitLong } from './stack.js';

const execFileAsync = promisify(execFile);
const enabled = process.env.SDLC_PILOT_TEST === '1' && !!process.env.SDLC_TEMPORAL_TEST_SERVER;
const describePilot = enabled ? describeDb : describe.skip;

describePilot(
  'C09: T01 from G1 to G6 on the pilot shape; N6',
  () => {
    let s: PilotStack;

    beforeAll(async () => {
      s = new PilotStack();
      await s.startPilot();
    }, 1_200_000);
    afterAll(async () => {
      await s?.stopPilot();
    }, 120_000);

    it('AC1: T01 (Low) goes G1 → G6 with a real run, a push and a pull request; then N6', async () => {
      const intent = await s.createIntent('low');
      await s.atGate(intent, 'G1');
      s.comment(intent, '/approve G1', 'a');
      await s.poll();
      await s.atGate(intent, 'G2');

      await s.linkInputs(intent, {
        specPath: SPECS.T01,
        paths: T01_PATHS,
        summary: 'Japanese labels on the product list. [stub:append]',
      });
      const mainBefore = s.repo.head(); // the plan file is on main now
      // G2 and G3 pass by HOTL; G4 waits for the block window, then passes by policy.
      const run = await s.runEnded(intent);
      expect(run).toMatchObject({ status: 'succeeded', stop_reason: null });
      expect(await s.decisions(intent, 'G2')).toEqual([['pass', null, null]]);
      expect(await s.decisions(intent, 'G3')).toEqual([['pass', null, null]]);
      const [g4] = await s.scope.gateDecisions.listForIntent(intent.id, 'G4');
      expect(g4).toMatchObject({ decision: 'pass', oversight_mode: 'POLICY' });

      // G5 passes by HOTL; after its block window the runner pushes and the PR is opened.
      const linked = await waitLong(
        () => s.reload(intent),
        (i) => i.pr_number !== null,
      );
      expect(linked).toMatchObject({ status: 'in_gate', current_gate: 'G6' });
      const pushed = (await s.runs(intent))[0]!;
      const branch = `agent/${intent.code}`;
      expect(s.repo.head(branch)).toBe(pushed.head_sha);
      expect(s.repo.changedPaths(pushed.head_sha!)).toEqual([NOTES_FILE]);
      expect(s.repo.file(pushed.head_sha!, NOTES_FILE)?.toString()).toBe('C09 stub note.\n');
      expect(await s.runEvents(pushed)).toEqual(
        expect.arrayContaining([
          'contract_accepted',
          'agent_started',
          'agent_finished',
          'diff_stored',
          'changes_checked',
          'branch_pushed',
        ]),
      );
      // The pull request: from the agent branch into main, its text from codes only (public repo).
      const [opened] = s.openedPulls();
      expect(opened).toMatchObject({ head: branch, base: 'main' });
      expect(opened!.body).toContain(intent.code);
      expect(opened!.body).not.toContain('C09 stub note');
      expect(opened!.body).not.toContain('Japanese labels');
      // The clone and push tokens were revoked by the runner right after their use (C11).
      expect(s.revokedTokenCount()).toBeGreaterThanOrEqual(2);

      // CI passes: G6 passes (AUDIT at Low) and the intent waits at G7 for the review.
      await s.setCi(intent, 'success');
      await s.until(intent, 'in_gate', 'G7');
      const [g6] = await s.scope.gateDecisions.listForIntent(intent.id, 'G6');
      expect(g6).toMatchObject({ decision: 'pass', oversight_mode: 'AUDIT' });
      // G7's first step reads the (empty) reviews and asks for them.
      const kinds = await waitLong(
        () => s.noticeKinds(intent),
        (list) => list.includes('g7_review_needed'),
      );
      // G6 passed like a HOTL gate (AUDIT samples afterwards); then G7 asks for the reviews.
      expect(kinds).toEqual([
        'submitted',
        'advanced',
        'hotl_passed',
        'hotl_passed',
        'run_started',
        'run_finished',
        'hotl_passed',
        'pr_opened',
        'hotl_passed',
        'g7_review_needed',
      ]);

      // N6: `main` never moved; a push of the agent's commit to `main` is refused.
      expect(s.repo.head()).toBe(mainBefore);
      const token = await s.github
        .adapter()
        .issueShortLivedToken({ owner: OWNER, name: REPO }, { permissions: { contents: 'write' } });
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-c09-n6-'));
      try {
        const auth = Buffer.from(`x-access-token:${token.token.reveal()}`).toString('base64');
        const env = {
          PATH: process.env.PATH,
          HOME: dir,
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_TERMINAL_PROMPT: '0',
          GIT_CONFIG_COUNT: '1',
          GIT_CONFIG_KEY_0: `http.${s.git.origin}/.extraheader`,
          GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${auth}`,
        };
        const remote = `${s.git.origin}/${OWNER}/${REPO}.git`;
        await execFileAsync('git', ['clone', '--quiet', '--branch', branch, remote, 'repo'], {
          cwd: dir,
          env,
        });
        const repoDir = path.join(dir, 'repo');
        // The runner's own guard refuses `main` first…
        fs.mkdirSync(path.join(dir, 'home'));
        await expect(
          pushCommit(s.runnerSettings.git, {
            repoDir,
            repo: `${OWNER}/${REPO}`,
            branch: 'main',
            commit: pushed.head_sha!,
            token: token.token,
            home: path.join(dir, 'home'),
          }),
        ).rejects.toMatchObject({ reason: 'push_rejected' });
        // …and the Git host's protection refuses it when another tool tries.
        await expect(
          execFileAsync(
            'git',
            ['-C', repoDir, 'push', '--quiet', remote, `${pushed.head_sha!}:refs/heads/main`],
            {
              env,
            },
          ),
        ).rejects.toThrow(/protected branch/i);
        expect(s.repo.head()).toBe(mainBefore);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  },
  1_200_000,
);
