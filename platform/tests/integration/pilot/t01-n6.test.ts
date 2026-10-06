// D-08 C09 AC1 and AC2 (N6) on the sample repository's shape (see stack.ts), run with
// `pnpm test:pilot` (CI job `sandbox-image`):
// - AC1 (D-09 T01, Low): `/approve G1` by comment → G2 and G3 pass by HOTL (the pilot's T01 spec
//   and a T13 plan whose task text is the stub model's script) → G4 by policy → the real runner
//   runs the agent in a node24 sandbox → G5 passes (HOTL) → after the block window the runner
//   pushes `agent/INT-…` and the platform opens the pull request → `ci-ok` passes → G6 passes
//   (AUDIT at Low) → G7.
// - AC2 N6: the push went to the agent branch only; a push to `main` with a write token is
//   refused by the Git host's protection, and the runner's own guard refuses `main`.
// - E07 AC1 (D-02 §10 items 1–4 and 6): the same intent goes on through G7 (Person B's review of
//   the pushed commit, then Person B merges on the Git host: the platform never merges), G8 (the
//   worker builds the release pack, Person B approves the release on the CLI), the sealed pack
//   and `done`; then `sdlc audit verify` passes, no agent decided any gate, and every model call
//   the stub model counted has one labelled cost record (the run-end sync, C12).
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { pushCommit } from '../../../apps/runner/src/index.js';
import type { Intent } from '../../../packages/core/src/db/schema.js';
import { describeDb } from '../db/helpers.js';
import { OWNER, REPO, REPO_PATH } from '../workflow/g1-g3/stack.js';
import {
  NOTES_FILE,
  PilotStack,
  sha256,
  SPECS,
  STUB_PRICE_USD,
  T01_PATHS,
  waitLong,
} from './stack.js';

const execFileAsync = promisify(execFile);
const enabled = process.env.SDLC_PILOT_TEST === '1' && !!process.env.SDLC_TEMPORAL_TEST_SERVER;
const describePilot = enabled ? describeDb : describe.skip;

describePilot(
  'C09 and E07: T01 from G1 to G8 on the pilot shape; N6',
  () => {
    let s: PilotStack;
    /** The T01 intent of the first test; the E07 test takes it on from G7. */
    let t01: Intent | undefined;

    beforeAll(async () => {
      s = new PilotStack();
      await s.startPilot();
    }, 1_200_000);
    afterAll(async () => {
      await s?.stopPilot();
    }, 120_000);

    it('AC1: T01 (Low) goes G1 → G6 with a real run, a push and a pull request; then N6', async () => {
      const intent = await s.createIntent('low');
      t01 = intent;
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

    it('E07 AC1: the same intent goes on G7 → merge → G8 → done; audit, gates, pack and cost hold', async () => {
      if (!t01) throw new Error('the G1 → G6 test must run first');
      const intent = await s.reload(t01);
      expect(intent).toMatchObject({ status: 'in_gate', current_gate: 'G7' });

      // G7: Person B reviews the pushed commit on GitHub, then merges it as a person.
      await s.review(intent, 'b', 'APPROVED');
      await waitLong(
        () => s.noticeKinds(intent),
        (kinds) => kinds.includes('g7_merge_ready'),
      );
      const mainBefore = s.repo.head()!;
      const merge = await s.mergeAsPerson(intent, 'b');
      expect(s.repo.head()).toBe(merge);
      expect(s.repo.file(merge, NOTES_FILE)?.toString()).toBe('C09 stub note.\n');
      await s.until(intent, 'in_gate', 'G8');
      const [g7] = await s.scope.gateDecisions.listForIntent(intent.id, 'G7');
      expect(g7).toMatchObject({
        decision: 'approve',
        oversight_mode: 'HITL',
        approver_role: 'person_b',
        actor_type: 'human',
        decided_by: s.users.b,
        source: 'github_review',
      });

      // G8: the worker builds the release pack; Person B approves the release on the CLI.
      await waitLong(
        () => s.noticeKinds(intent),
        (kinds) => kinds.includes('g8_review_needed'),
      );
      await s.approve('b', 'G8', intent);
      const done = await s.until(intent, 'done');
      expect(done).toMatchObject({ status: 'done', current_gate: 'G8' });
      expect(s.repo.head()).toBe(merge);
      expect(mainBefore).not.toBe(merge);
      const kinds = await s.noticeKinds(intent);
      const tail = kinds.slice(kinds.indexOf('g7_review_needed'));
      expect(tail.filter((k) => k !== 'hotl_passed')).toEqual([
        'g7_review_needed',
        'g7_merge_ready',
        'merged',
        'g8_review_needed',
        'released',
      ]);

      // Item 2: no agent decided anything; every HITL decision is a person with the gate's role;
      // the platform never called a merge endpoint (only people merge).
      const decisions = await s.scope.gateDecisions.listForIntent(intent.id);
      expect(decisions.map((d) => d.gate)).toEqual(
        expect.arrayContaining(['G1', 'G2', 'G3', 'G4', 'G5', 'G6', 'G7', 'G8']),
      );
      expect(decisions.filter((d) => d.actor_type === 'agent')).toEqual([]);
      for (const d of decisions.filter((x) => x.oversight_mode === 'HITL')) {
        expect(d).toMatchObject({ actor_type: 'human' });
        expect(d.approver_role).not.toBeNull();
        expect(d.decided_by).not.toBeNull();
      }
      expect(s.github.stub.requests.filter((r) => /\/merges?$/.test(r.path))).toEqual([]);
      expect(
        s.github.stub.requestsTo('PUT', `${REPO_PATH}/pulls/${String(intent.pr_number)}/merge`),
      ).toEqual([]);

      // Item 3: one sealed pack version, complete (FR-40, FR-43) and readable (FR-42).
      const packs = await s.scope.evidencePacks.listForIntent(intent.id);
      const sealed = packs.filter((p) => p.sealed_at !== null);
      expect(sealed).toHaveLength(1);
      const pack = sealed[0]!;
      expect(pack.version).toBe(packs.at(-1)!.version);
      const read = (uri: string) => s.bucket.objects.get(uri.slice('s3://evidence/'.length))!;
      const manifestBytes = read(pack.manifest_uri);
      const markdownBytes = read(pack.markdown_uri);
      expect(sha256(manifestBytes)).toBe(pack.manifest_sha256);
      expect(sha256(markdownBytes)).toBe(pack.markdown_sha256);
      const manifest = JSON.parse(manifestBytes.toString()) as {
        specs: { path: string; content_sha256: string }[];
        plans: { plan_sha256: string }[];
        runs: { head_sha: string | null }[];
        evidence_items: { kind: string; check: string }[];
        gate_decisions: { gate: string; decision: string; oversight_mode: string }[];
        cost: { calls: number; cost_usd: string };
        disclosure: Record<string, unknown>;
      };
      expect(manifest.specs[0]).toMatchObject({ path: SPECS.T01 });
      expect(manifest.specs[0]!.content_sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(manifest.plans[0]!.plan_sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(manifest.runs[0]!.head_sha).toBe((await s.runs(intent))[0]!.head_sha);
      expect(manifest.evidence_items).toEqual(
        expect.arrayContaining([expect.objectContaining({ kind: 'diff', check: 'verified' })]),
      );
      expect(new Set(manifest.gate_decisions.map((d) => d.gate))).toEqual(
        new Set(['G1', 'G2', 'G3', 'G4', 'G5', 'G6', 'G7', 'G8']),
      );
      expect(manifest.gate_decisions.every((d) => d.oversight_mode !== '')).toBe(true);
      expect(manifest.disclosure).toMatchObject({ format: 'standard_note' });
      const markdown = markdownBytes.toString();
      expect(markdown).toContain(intent.code);
      for (const gate of ['G1', 'G2', 'G3', 'G4', 'G5', 'G6', 'G7', 'G8']) {
        expect(markdown).toContain(gate);
      }
      // Codes, IDs and hashes only: never the agent's change or the plan's text.
      expect(markdown).not.toContain('C09 stub note');
      expect(markdown).not.toContain('[stub:append]');

      // Item 6: every call the stub model counted has one cost record with the run's labels.
      const [run] = await s.runs(intent);
      const records = await s.scope.costRecords.listForRun(run!.id);
      const calls = await s.modelCallCount();
      expect(calls).toBeGreaterThan(0);
      expect(records).toHaveLength(calls);
      for (const r of records) {
        expect(r).toMatchObject({
          project_id: s.target.projectId,
          intent_id: intent.id,
          run_id: run!.id,
          gate: 'G4',
          agent: 'pilot-coder',
          cost_usd: STUB_PRICE_USD,
        });
      }
      expect(manifest.cost.calls).toBe(calls);
      expect(Number(manifest.cost.cost_usd)).toBeGreaterThan(0);

      // Item 4: the tenant admin's `sdlc audit verify` finds the chain intact (exit 0).
      const chain = await s.cliJson<{ ok: boolean; checked: number; broken: unknown }>('admin', [
        'audit',
        'verify',
      ]);
      expect(chain).toMatchObject({ ok: true, broken: null });
      expect(chain.checked).toBeGreaterThan(50);
    });
  },
  1_200_000,
);
