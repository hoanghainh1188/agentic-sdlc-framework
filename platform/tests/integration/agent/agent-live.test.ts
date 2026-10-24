// D-08 C05 AC1–AC4 live (ADR-M29): the runner drives the real OpenHands Agent Server 1.48.0 in a
// hardened sandbox from the node24 image, with a scripted stub model standing in for LiteLLM on
// the run's network (no provider, no real key). The real-model run is session 2 (QUESTIONS #78).
//
// `pnpm test:agent` (SDLC_AGENT_TEST=1, throw-away PostgreSQL from test-db.sh; CI job
// `sandbox-image`, which builds node24). `SDLC_SANDBOX_IMAGE` (name@sha256:…) skips the build.
// X03 (ADR-M88): `SDLC_AGENT_ADAPTER=opencode` runs the same tests with the OpenCode adapter in
// the node24-opencode image (then `SDLC_SANDBOX_IMAGE` names that image), plus one test of its
// own: the agent raises its own step cap through its server and the run fails (ADR-M68 §6 gap 1).
//
// Test infrastructure through the docker CLI: the stub model, and a relay container that stands in
// for the runner's own container (the runner code attaches it to the run's network, and the test
// process on the host reaches the Agent Server through its port on 127.0.0.1). The sandboxes, the
// network attachment, the agent calls and the clean-up are the runner code under test.
// C07: every run that goes to G5 has its changes computed from the real sandbox (`changesStep`).
// X07: `[stub:reads]` opens two files; the run's context snapshot lists their hashes (ADR-M90).
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { EvidenceStore } from '@sdlc/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  DockerClient,
  driveAgent,
  Runner,
  teardownSandbox,
  type AgentDriveDeps,
} from '../../../apps/runner/src/index.js';
import { createTestDatabase, type TestDatabase } from '../db/helpers.js';
import { docker, dockerSocket, quietly } from '../runner/live-helpers';
import { buildSandboxImage } from '../sandbox-image/helpers';
import {
  ADAPTER,
  agentAdapter,
  changesStep,
  here,
  NODE_IMAGE,
  secret,
  startAgentRun,
  type AgentRunFixture,
} from './helpers';

const enabled = process.env.SDLC_AGENT_TEST === '1' && !!process.env.SDLC_TEST_DATABASE_URL;
const suffix = crypto.randomBytes(4).toString('hex');
const VIRTUAL_KEY = `sk-c05-live-${crypto.randomBytes(12).toString('hex')}`;
const CANARY = `agents-md-canary-${crypto.randomBytes(6).toString('hex')}`;
// X11: the stub's summaries hold this; it must never reach run events or the handed-over log.
const SUMMARY_CANARY = `summary-canary-${crypto.randomBytes(6).toString('hex')}`;
const names = {
  platformNet: `sdlc-c05-platform-${suffix}`,
  stub: `sdlc-c05-litellm-${suffix}`,
  registry: `sdlc-c05-registry-${suffix}`,
};

describe.skipIf(!enabled)(`C05 live: the runner drives the agent (${ADAPTER})`, () => {
  let t: TestDatabase;
  let image: string;
  let client: DockerClient;
  let tenants = 0;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-c05-live-'));

  beforeAll(async () => {
    t = await createTestDatabase();
    image =
      process.env.SDLC_SANDBOX_IMAGE ||
      (await buildSandboxImage(
        names.registry,
        ADAPTER === 'opencode' ? 'node24-opencode' : 'node24',
      ));
    client = new DockerClient({ socketPath: dockerSocket(), timeoutMs: 120_000 });
    docker('pull', '-q', NODE_IMAGE);
    docker('network', 'create', names.platformNet);
    docker(
      'run',
      '-d',
      '--name',
      names.stub,
      '--network',
      names.platformNet,
      '--read-only',
      '--cap-drop',
      'ALL',
      '--user',
      '1000:1000',
      '-e',
      `STUB_EXPECTED_KEY=${VIRTUAL_KEY}`,
      '-e',
      `STUB_AGENTS_CANARY=${CANARY}`,
      '-e',
      `STUB_SUMMARY_CANARY=${SUMMARY_CANARY}`,
      '-v',
      `${path.join(here, 'stub-model.mjs')}:/stub/stub-model.mjs:ro`,
      NODE_IMAGE,
      'node',
      '/stub/stub-model.mjs',
    );
  }, 1_200_000);

  afterAll(async () => {
    quietly('rm', '-f', names.stub, names.registry);
    quietly('network', 'rm', names.platformNet);
    fs.rmSync(tmp, { recursive: true, force: true });
    await t?.drop();
  });

  type Run = AgentRunFixture;

  const start = (
    script: string,
    caps: { maxIterations: number; maxDurationMin: number },
    configYaml?: string,
  ) =>
    startAgentRun({
      ...(configYaml === undefined ? {} : { configYaml }),
      t,
      client,
      image,
      tmp,
      suffix,
      slug: `c05-${String(++tenants)}`,
      litellmContainer: names.stub,
      model: 'stub-model',
      planSummary: `Create hello.txt. ${script}`,
      specText: '# T01\n\n## Acceptance criteria\n\n- Create hello.txt.\n',
      agentsMd: `# Agent instructions\n\nMarker: ${CANARY}\n`,
      caps,
    });

  const request = (r: Run) => ({
    contract: r.envelope.contract,
    sandbox: r.sandbox,
    model: 'stub-model',
    virtualKey: secret(VIRTUAL_KEY),
  });

  const agentEvents = async (r: Run) =>
    (await r.scope.runEvents.list(r.envelope.contract.run_id))
      .map((e) => [e.event_type, e.payload] as const)
      .filter(([type]) => type.startsWith('agent_'));

  const stubLogs = () => docker('logs', names.stub);

  it(
    'edit: the agent writes a file and finishes; the runner commits, collects, cleans up (AC1–AC4)',
    { timeout: 600_000 },
    async () => {
      const r = await start('[stub:edit]', { maxIterations: 30, maxDurationMin: 10 });
      const runId = r.envelope.contract.run_id;
      try {
        // The agent's API refuses callers without the session key: here LiteLLM's container,
        // which is on the run's network (Harry's condition, ADR-M29). OpenCode takes the key as
        // the password of HTTP Basic (user `opencode`).
        const probe = (key: string) => {
          const headers =
            key === ''
              ? {}
              : ADAPTER === 'opencode'
                ? { authorization: `Basic ${Buffer.from(`opencode:${key}`).toString('base64')}` }
                : { 'X-Session-API-Key': key };
          const route = ADAPTER === 'opencode' ? '/session' : '/api/conversations/count';
          return docker(
            'exec',
            names.stub,
            'node',
            '-e',
            `fetch('http://sdlc-sandbox-${runId}:8000${route}',{headers:${JSON.stringify(
              headers,
            )}}).then(r=>console.log(r.status))`,
          );
        };
        expect(probe('')).toBe('401');
        expect(probe('wrong-key-wrong-key-wrong-key-wrong-key')).toBe('401');

        const runner = new Runner(
          {
            db: t.app as unknown as AgentDriveDeps['db'],
            docker: client,
            settings: r.settings,
            verifier: {
              verify: () => Promise.resolve(false),
              publicKey: () => Promise.reject(new Error('unused')),
            },
            unwrapper: { unwrap: () => Promise.reject(new Error('unused')) },
          },
          {},
          { adapters: { [ADAPTER]: agentAdapter() }, agentUrl: () => r.relayUrl },
        );
        // The runner did not provision this fixture run, so it holds no clone: drive the agent
        // with the fixture's clone (C07), then release the run through the runner as runAgent does.
        const puts: { path: string; content: Buffer }[] = [];
        const result = await driveAgent(
          {
            db: t.app as unknown as AgentDriveDeps['db'],
            docker: client,
            settings: r.settings,
            adapter: agentAdapter(),
            agentUrl: () => r.relayUrl,
            ...changesStep(t, client, r, puts),
          },
          request(r),
        ).finally(() => runner.release(r.envelope.contract.tenant_id, runId, 'finished'));

        expect(result).toMatchObject({ outcome: 'finished', status: 'succeeded' });
        expect(result.outputs?.changedFiles).toEqual([{ path: 'hello.txt', status: 'added' }]);
        expect(result.outputs?.headSha).not.toBe(r.repoBase);
        expect(result.outputs?.events.length).toBeGreaterThan(2);
        const run = await r.scope.runs.getById(runId);
        // C08: the sandbox's HEAD is not the pushed head (ADR-M38 §2.2).
        expect(run).toMatchObject({ status: 'succeeded', head_sha: null });
        expect(run?.iterations).toBeGreaterThanOrEqual(1);
        expect((await agentEvents(r)).map(([type]) => type)).toEqual([
          'agent_started',
          'agent_finished',
        ]);
        expect((await agentEvents(r))[1]?.[1]).toMatchObject({
          outcome: 'finished',
          commit: 'committed',
          changed_files: 1,
        });
        // C07: the diff computed from the sandbox's workspace, stored and checked (ADR-M34).
        expect(puts).toHaveLength(1);
        expect(puts[0]!.content.toString()).toContain('hello.txt');
        const checked = (await r.scope.runEvents.list(runId)).find(
          (e) => e.event_type === 'changes_checked',
        );
        expect(checked?.payload).toMatchObject({ changed_files: 1, instruction_files: 0 });

        // AC2: the model saw the spec path, the planned file, the AGENTS.md rule, and the AGENTS.md
        // content (loaded by the agent from the workspace); only the granted tools.
        const logs = stubLogs();
        for (const check of ['spec_path', 'planned_file', 'agents_md_named', 'agents_md_loaded']) {
          expect(logs).toContain(`stub:check:${check}:yes`);
        }
        const tools = /stub:check:tools:(\S+)/.exec(logs)?.[1]?.split(',') ?? [];
        if (ADAPTER === 'opencode') {
          // The tool map of ADR-M68 §4: file_editor and terminal; webfetch, task and the rest off.
          expect(tools).toEqual(expect.arrayContaining(['bash', 'read', 'edit', 'write']));
          for (const off of ['webfetch', 'task', 'skill', 'todowrite']) {
            expect(tools).not.toContain(off);
          }
          // Gap 5: no extra model call for a session title.
          expect(logs).not.toContain(':notools');
        } else {
          expect(tools).toEqual(expect.arrayContaining(['file_editor', 'terminal', 'finish']));
        }
        expect(tools).not.toContain('browser');
        expect(logs).not.toContain('stub:refused:wrong_key');

        // Clean-up: sandbox, network and volume gone; the relay (runner) left the network.
        expect(docker('ps', '-a', '-q', '--filter', `name=sdlc-sandbox-${runId}`)).toBe('');
        expect(docker('network', 'ls', '-q', '--filter', `name=sdlc-run-${runId}`)).toBe('');
        expect(
          docker('inspect', '--format', '{{json .NetworkSettings.Networks}}', r.relay),
        ).not.toContain(`sdlc-run-${runId}`);
        const recorded = JSON.stringify(await r.scope.runEvents.list(runId));
        expect(recorded).not.toContain(VIRTUAL_KEY);
        expect(recorded).not.toContain('hello.txt');
      } finally {
        await teardownSandbox(client, runId).catch(() => undefined);
        quietly('rm', '-f', r.relay);
      }
    },
  );

  it(
    'X07 context: the agent opens files; the snapshot lists their hashes, never the paths (AC1, AC3, AC4)',
    { timeout: 600_000 },
    async () => {
      const r = await start('[stub:reads]', { maxIterations: 30, maxDurationMin: 10 });
      const runId = r.envelope.contract.run_id;
      const stored: { path: string; content: Buffer }[] = [];
      const evidence: EvidenceStore = {
        put: (_tenant, file, content) => {
          stored.push({ path: file, content });
          return Promise.resolve({
            uri: `s3://evidence/diffs/${file}`,
            sha256: crypto.createHash('sha256').update(content).digest('hex'),
            sizeBytes: content.length,
          });
        },
        get: () => Promise.reject(new Error('unused')),
      };
      try {
        const runner = new Runner(
          {
            db: t.app as unknown as AgentDriveDeps['db'],
            docker: client,
            settings: r.settings,
            verifier: {
              verify: () => Promise.resolve(false),
              publicKey: () => Promise.reject(new Error('unused')),
            },
            unwrapper: { unwrap: () => Promise.reject(new Error('unused')) },
          },
          {},
          {
            adapters: { [ADAPTER]: agentAdapter() },
            agentUrl: () => r.relayUrl,
            diffEvidence: evidence,
          },
        );
        // As in the edit test: drive with the fixture's clone, then release as runAgent does,
        // with the files the agent's log shows (X07).
        let result: Awaited<ReturnType<typeof driveAgent>> | undefined;
        try {
          result = await driveAgent(
            {
              db: t.app as unknown as AgentDriveDeps['db'],
              docker: client,
              settings: r.settings,
              adapter: agentAdapter(),
              agentUrl: () => r.relayUrl,
              ...changesStep(t, client, r, []),
            },
            request(r),
          );
        } finally {
          await runner.release(r.envelope.contract.tenant_id, runId, 'finished', result?.reads);
        }
        expect(result).toMatchObject({ outcome: 'finished', status: 'succeeded' });
        expect(result?.reads).toEqual({
          paths: ['README.md', 'docs/specs/T01-labels.md'],
          outside: 0,
          unattributed: 1,
        });

        const sha = (text: string | Buffer) =>
          crypto.createHash('sha256').update(text).digest('hex');
        const snapshot = stored.find((s) => s.path.endsWith(`${runId}.context-snapshot.json`));
        expect(snapshot).toBeDefined();
        const event = (await r.scope.runEvents.list(runId)).find(
          (e) => e.event_type === 'context_snapshot',
        );
        expect(event?.payload).toEqual({
          snapshot_sha256: sha(snapshot!.content),
          source: 'agent_log',
          files: 2,
          files_outside: 0,
          unattributed_calls: 1,
          document_tools: 0,
          documents: 0,
        });
        const parsed = JSON.parse(snapshot!.content.toString('utf8')) as {
          files: { path_sha256: string[] };
          base_sha: string;
        };
        expect(parsed.files.path_sha256).toEqual(
          [sha('README.md'), sha('docs/specs/T01-labels.md')].sort(),
        );
        expect(parsed.base_sha).toBe(r.envelope.contract.base_sha);
        const items = (
          await r.scope.evidenceItems.listForIntent(r.envelope.contract.intent_id)
        ).filter((i) => i.kind === 'context_snapshot');
        expect(items).toHaveLength(1);
        // AC3: no path in the snapshot, the run events or the evidence rows.
        const recorded = JSON.stringify([await r.scope.runEvents.list(runId), items]);
        for (const text of [snapshot!.content.toString('utf8'), recorded]) {
          expect(text).not.toContain('README');
          expect(text).not.toContain('T01-labels');
        }
      } finally {
        await teardownSandbox(client, runId).catch(() => undefined);
        quietly('rm', '-f', r.relay);
      }
    },
  );

  it(
    'iteration cap: the agent stops itself at max_iterations (AC3)',
    { timeout: 600_000 },
    async () => {
      const r = await start('[stub:loop]', { maxIterations: 3, maxDurationMin: 10 });
      const runId = r.envelope.contract.run_id;
      try {
        const result = await driveAgent(
          {
            db: t.app as unknown as AgentDriveDeps['db'],
            docker: client,
            settings: r.settings,
            adapter: agentAdapter(),
            agentUrl: () => r.relayUrl,
            ...changesStep(t, client, r, []),
          },
          request(r),
        );
        expect(result).toMatchObject({ outcome: 'max_iterations', status: 'stopped_budget' });
        expect(await r.scope.runs.getById(runId)).toMatchObject({ stop_reason: 'max_iterations' });
      } finally {
        await teardownSandbox(client, runId).catch(() => undefined);
        quietly('rm', '-f', r.relay);
      }
    },
  );

  it(
    'time cap: the runner interrupts the agent in a slow model call (AC3)',
    { timeout: 600_000 },
    async () => {
      const r = await start('[stub:slow]', { maxIterations: 30, maxDurationMin: 1 });
      const runId = r.envelope.contract.run_id;
      try {
        // One real second counts as one minute, so the one-minute cap ends after about a second
        // while the stub model holds its first reply for 120 s.
        const started = Date.now();
        const result = await driveAgent(
          {
            db: t.app as unknown as AgentDriveDeps['db'],
            docker: client,
            settings: r.settings,
            adapter: agentAdapter(),
            agentUrl: () => r.relayUrl,
            clock: () => started + (Date.now() - started) * 60,
            ...changesStep(t, client, r, []),
          },
          request(r),
        );
        expect(result).toMatchObject({ outcome: 'max_duration', status: 'stopped_timeout' });
        expect(await agentEvents(r)).toContainEqual([
          'agent_stopped',
          { reason: 'max_duration', method: 'interrupt' },
        ]);
        expect(Date.now() - started).toBeLessThan(60_000);
      } finally {
        await teardownSandbox(client, runId).catch(() => undefined);
        quietly('rm', '-f', r.relay);
      }
    },
  );

  it.skipIf(ADAPTER !== 'opencode')(
    'X03 gap 1: the agent raises its own step cap through its server → the run fails, config_changed',
    { timeout: 600_000 },
    async () => {
      const r = await start('[stub:selfconfig]', { maxIterations: 30, maxDurationMin: 10 });
      const runId = r.envelope.contract.run_id;
      try {
        const result = await driveAgent(
          {
            db: t.app as unknown as AgentDriveDeps['db'],
            docker: client,
            settings: r.settings,
            adapter: agentAdapter(),
            agentUrl: () => r.relayUrl,
            ...changesStep(t, client, r, []),
          },
          request(r),
        );
        // The agent's own call to its server goes through (the password is in its shell,
        // QUESTIONS #523): the adapter, not OpenCode, stops the run.
        expect(result.outcome).not.toBe('finished');
        expect(await r.scope.runs.getById(runId)).toMatchObject({
          stop_reason: 'agent_config_changed',
        });
      } finally {
        await teardownSandbox(client, runId).catch(() => undefined);
        quietly('rm', '-f', r.relay);
      }
    },
  );

  // C11 PR 2 (D-02 FR-35, ADR-M42 §2.7) on the real Agent Server.
  const loopConfig = (threshold: number, windowMinutes: number) =>
    `run:\n  loop_detection:\n    identical_tool_calls_max: ${String(threshold)}\n    no_progress_window_minutes: ${String(windowMinutes)}\n`;

  it(
    'C11 PR 2: the same tool call again and again → the runner stops the agent: stopped_stalled, loop_detected',
    { timeout: 600_000 },
    async () => {
      // Threshold 2: the platform stops at the 3rd identical call, before OpenHands' own stuck
      // detector (fixed at 4, ADR-M10 §4.1 item 2) can.
      const r = await start(
        '[stub:repeat]',
        { maxIterations: 20, maxDurationMin: 10 },
        loopConfig(2, 15),
      );
      const runId = r.envelope.contract.run_id;
      expect(r.envelope.contract.loop_threshold).toBe(2);
      try {
        const result = await driveAgent(
          {
            db: t.app as unknown as AgentDriveDeps['db'],
            docker: client,
            settings: r.settings,
            adapter: agentAdapter(),
            agentUrl: () => r.relayUrl,
            ...changesStep(t, client, r, []),
          },
          request(r),
        );
        expect(result).toMatchObject({ outcome: 'loop_detected', status: 'stopped_stalled' });
        expect(await r.scope.runs.getById(runId)).toMatchObject({ stop_reason: 'loop_detected' });
        const events = (await r.scope.runEvents.list(runId)).map((e) => [e.event_type, e.payload]);
        const detected = events.find(([type]) => type === 'loop_detected')?.[1] as
          { identical_calls: number; threshold: number } | undefined;
        expect(detected?.threshold).toBe(2);
        expect(detected?.identical_calls).toBeGreaterThan(2);
        expect(await agentEvents(r)).toContainEqual([
          'agent_stopped',
          { reason: 'loop_detected', method: 'interrupt' },
        ]);
        // Counts only: the command the agent repeated is not in the run events.
        expect(JSON.stringify(events)).not.toContain('"ls"');
      } finally {
        await teardownSandbox(client, runId).catch(() => undefined);
        quietly('rm', '-f', r.relay);
      }
    },
  );

  it(
    'C11 PR 2: the model goes silent → no new Agent Server event for the window → no_progress (no periodic events)',
    { timeout: 600_000 },
    async () => {
      // Real time on purpose (Harry's review, ADR-M42 §2.7): a one-minute window against a
      // five-minute time cap. The run can end `no_progress` only if the Agent Server sent no event
      // of any kind (no heartbeat, no state update) for a whole real minute while the agent waited
      // for the model; otherwise the time cap ends it and the test fails.
      const r = await start(
        '[stub:silent]',
        { maxIterations: 30, maxDurationMin: 5 },
        loopConfig(3, 1),
      );
      const runId = r.envelope.contract.run_id;
      try {
        const started = Date.now();
        const result = await driveAgent(
          {
            db: t.app as unknown as AgentDriveDeps['db'],
            docker: client,
            settings: r.settings,
            adapter: agentAdapter(),
            agentUrl: () => r.relayUrl,
            ...changesStep(t, client, r, []),
          },
          request(r),
        );
        const elapsed = Date.now() - started;
        expect(result).toMatchObject({ outcome: 'no_progress', status: 'stopped_stalled' });
        expect(await r.scope.runs.getById(runId)).toMatchObject({ stop_reason: 'no_progress' });
        expect(await agentEvents(r)).toContainEqual([
          'agent_stopped',
          { reason: 'no_progress', method: 'interrupt' },
        ]);
        const detected = (await r.scope.runEvents.list(runId)).find(
          (e) => e.event_type === 'loop_detected',
        )?.payload;
        expect(detected).toEqual({ identical_calls: 0, threshold: 3, idle_minutes: 1 });
        // At least the whole window passed in real time, well before the time cap.
        expect(elapsed).toBeGreaterThanOrEqual(60_000);
        expect(elapsed).toBeLessThan(3 * 60_000);
      } finally {
        await teardownSandbox(client, runId).catch(() => undefined);
        quietly('rm', '-f', r.relay);
      }
    },
  );

  // X11 (ADR-M29 §2.10, QUESTIONS #551–#554): context condensing, OpenHands only (OpenCode keeps its
  // own behaviour, `unsupported`). The stub's summary request has no tools; it answers with the
  // summary canary, and only with the run's virtual key.
  const condensingConfig = (maxEvents: number, extra = '') =>
    `run:\n${extra}  context_condensing:\n    mode: summarize\n    max_events: ${String(maxEvents)}\n    keep_first: 2\n    model_context_tokens:\n      stub-model: 32768\n`;

  const drive = (r: Run) =>
    driveAgent(
      {
        db: t.app as unknown as AgentDriveDeps['db'],
        docker: client,
        settings: r.settings,
        adapter: agentAdapter(),
        agentUrl: () => r.relayUrl,
        ...changesStep(t, client, r, []),
      },
      request(r),
    );

  const finishedCounts = async (r: Run) =>
    (await agentEvents(r)).find(([type]) => type === 'agent_finished')?.[1] as
      { condensations?: number; events_forgotten?: number } | undefined;

  const noSummary = async (r: Run, outputs?: { events: readonly unknown[] }) => {
    const recorded = JSON.stringify(await r.scope.runEvents.list(r.envelope.contract.run_id));
    expect(recorded).not.toContain(SUMMARY_CANARY);
    expect(recorded).not.toContain(VIRTUAL_KEY);
    if (outputs) expect(JSON.stringify(outputs.events)).not.toContain(SUMMARY_CANARY);
  };

  it.skipIf(ADAPTER !== 'openhands')(
    'X11: past max_events the run model summarizes old events with the run key; the run finishes (AC1–AC3)',
    { timeout: 600_000 },
    async () => {
      const r = await start(
        '[stub:condense]',
        { maxIterations: 30, maxDurationMin: 10 },
        condensingConfig(10),
      );
      const runId = r.envelope.contract.run_id;
      try {
        const result = await drive(r);
        expect(result).toMatchObject({ outcome: 'finished', status: 'succeeded' });
        expect((await agentEvents(r))[0]).toEqual([
          'agent_started',
          { max_iterations: 30, max_duration_min: 10, condensing: 'summarize' },
        ]);
        const counts = await finishedCounts(r);
        expect(counts?.condensations).toBeGreaterThanOrEqual(1);
        expect(counts?.events_forgotten).toBeGreaterThanOrEqual(1);
        // The forgotten events stay in the log, so every step is still counted: the run's
        // iterations are all the tool calls of the log, at least the stub's 14 commands and finish.
        const log = result.outputs?.events ?? [];
        const ids = new Set(log.map((e) => e.id));
        const condensations = log.filter((e) => e.kind === 'Condensation');
        // A later condensation also forgets the summary of the one before (`<id>-summary`), which is
        // in the model's view only, never in the log.
        const forgotten = condensations
          .flatMap((e) => e.forgotten_event_ids as string[])
          .filter((id) => !id.endsWith('-summary'));
        expect(forgotten.length).toBeGreaterThan(0);
        expect(forgotten.every((id) => ids.has(id))).toBe(true);
        const steps = log.filter((e) => e.kind === 'ActionEvent').length;
        expect(steps).toBe(15);
        expect(await r.scope.runs.getById(runId)).toMatchObject({ iterations: steps });
        process.stderr.write(
          `X11 LIVE condense: steps ${String(steps)}, condensations ${String(condensations.length)}, forgotten ${String(forgotten.length)}, stub calls ${String((stubLogs().match(new RegExp(`stub:call:`, 'g')) ?? []).length)}\n`,
        );
        expect(condensations.length).toBe(counts?.condensations);
        expect(condensations[0]).toMatchObject({ summary: null });
        expect(condensations[0]?.summary_sha256).toMatch(/^[0-9a-f]{64}$/);
        const logs = stubLogs();
        expect(logs).toContain(':notools');
        expect(logs).not.toContain('stub:refused:wrong_key');
        await noSummary(r, result.outputs);
      } finally {
        await teardownSandbox(client, runId).catch(() => undefined);
        quietly('rm', '-f', r.relay);
      }
    },
  );

  it.skipIf(ADAPTER !== 'openhands')(
    'X11: a model past its context window → the agent condenses and goes on (AC4)',
    { timeout: 600_000 },
    async () => {
      const r = await start(
        '[stub:reads]',
        { maxIterations: 30, maxDurationMin: 10 },
        condensingConfig(1000),
      );
      const runId = r.envelope.contract.run_id;
      try {
        const result = await drive(r);
        expect(stubLogs()).toContain('stub:refused:context');
        expect(result).toMatchObject({ outcome: 'finished', status: 'succeeded' });
        expect((await finishedCounts(r))?.condensations).toBeGreaterThanOrEqual(1);
        await noSummary(r, result.outputs);
      } finally {
        await teardownSandbox(client, runId).catch(() => undefined);
        quietly('rm', '-f', r.relay);
      }
    },
  );

  it.skipIf(ADAPTER !== 'openhands')(
    'X11: the iteration cap still stops a run with condensing on (AC4)',
    { timeout: 600_000 },
    async () => {
      const r = await start(
        '[stub:condensecap]',
        { maxIterations: 10, maxDurationMin: 10 },
        condensingConfig(10),
      );
      const runId = r.envelope.contract.run_id;
      try {
        const result = await drive(r);
        expect(result).toMatchObject({ outcome: 'max_iterations', status: 'stopped_budget' });
        const run = await r.scope.runs.getById(runId);
        expect(run?.iterations).toBeLessThanOrEqual(10);
        await noSummary(r);
      } finally {
        await teardownSandbox(client, runId).catch(() => undefined);
        quietly('rm', '-f', r.relay);
      }
    },
  );

  it.skipIf(ADAPTER !== 'openhands')(
    'X11: loop detection still sees identical calls after a condensation (AC4)',
    { timeout: 600_000 },
    async () => {
      const r = await start(
        '[stub:condenseloop]',
        { maxIterations: 30, maxDurationMin: 10 },
        condensingConfig(
          10,
          '  loop_detection:\n    identical_tool_calls_max: 2\n    no_progress_window_minutes: 15\n',
        ),
      );
      const runId = r.envelope.contract.run_id;
      try {
        const result = await drive(r);
        expect(result).toMatchObject({ outcome: 'loop_detected', status: 'stopped_stalled' });
        expect((await finishedCounts(r))?.condensations).toBeGreaterThanOrEqual(1);
        await noSummary(r);
      } finally {
        await teardownSandbox(client, runId).catch(() => undefined);
        quietly('rm', '-f', r.relay);
      }
    },
  );
});
