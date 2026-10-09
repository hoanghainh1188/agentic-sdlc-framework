// `sdlc trial report` (task V01, D-08 V01 AC3, AC4, ADR-M65) against a mocked API built with the
// API's presenters (`trial-world.ts`). What it proves: the report holds counts, codes, durations,
// amounts and model names only; no slug, intent code, title, UUID, e-mail, repository or URL ever
// reaches it, also when every free field of every answer carries a marker or an answer gains a
// new field; unknown codes become `other`; a report that fails its check is never printed; the
// requests stay within their limits (4 at a time), failures are tried again and then stop the
// report; the intent limit is reported as `truncated`.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { t } from '@sdlc/messages';
import { describe, expect, it, vi } from 'vitest';

import * as build from '../../apps/cli/src/commands/trial/build.js';
import { trialReportSchema, reportIsSafe } from '../../apps/cli/src/commands/trial/check.js';
import { POOL_SIZE, pool, RETRY_DELAYS_MS } from '../../apps/cli/src/commands/trial/fetch.js';
import { runTrial, trialRange } from '../../apps/cli/src/commands/trial.js';
import { EXIT, type CliContext } from '../../apps/cli/src/index.js';
import { PLATFORM_VERSION } from '../../apps/cli/src/version.js';
import { useHarness } from './harness.js';
import {
  NOW,
  schemaFor,
  SECRET_EMAIL,
  SECRET_REPO,
  SECRET_SLUG,
  TrialWorld,
  type Checkable,
  type Reply,
} from './trial-world.js';

const realBuild = vi.hoisted(() => ({ fn: undefined as unknown as typeof build.buildReport }));

vi.mock('../../apps/cli/src/commands/trial/build.js', async (original) => {
  const real = await original<typeof import('../../apps/cli/src/commands/trial/build.js')>();
  realBuild.fn = real.buildReport;
  return {
    ...real,
    buildReport: vi.fn(real.buildReport),
  };
});

const harness = useHarness();
const fast = (): Promise<void> => Promise.resolve();

interface Run {
  readonly code: number;
  readonly out: string[];
  readonly err: string[];
  readonly urls: URL[];
  readonly maxInFlight: number;
  readonly sleeps: number[];
}

/** Runs the command against the world; `edit` may change an answer (or replace it). */
async function run(
  world: TrialWorld,
  args: readonly string[] = ['--json'],
  edit?: (url: URL, reply: Reply) => Reply,
): Promise<Run> {
  const h = await harness();
  const urls: URL[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const sleeps: number[] = [];
  const fetch = (async (input: URL | string) => {
    const url = new URL(String(input));
    urls.push(url);
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 0));
    inFlight -= 1;
    const reply = edit ? edit(url, world.reply(url)) : world.reply(url);
    const text = reply.raw ?? (reply.body === undefined ? null : JSON.stringify(reply.body));
    return new Response(text, {
      status: reply.status,
      headers: { 'content-type': reply.raw === undefined ? 'application/json' : 'text/html' },
    });
  }) as typeof globalThis.fetch;
  const ctx: CliContext = { ...h.ctx, api: { ...h.ctx.api!, fetch } };
  const code = await runTrial(['report', ...args], ctx, {
    now: () => NOW,
    sleep: (ms) => {
      sleeps.push(ms);
      return fast();
    },
  });
  return { code, out: h.out, err: h.err, urls, maxInFlight, sleeps };
}

const report = (r: Run): ReturnType<typeof trialReportSchema.parse> =>
  trialReportSchema.parse(JSON.parse(r.out.join('\n')));

/** Values that must never be in a report. */
function assertAnonymous(text: string): void {
  for (const secret of [
    SECRET_SLUG,
    SECRET_REPO,
    SECRET_EMAIL,
    'acme',
    'Secret',
    'INT-2026',
    'ESC-2026',
    'https://',
    '@',
    'Weird',
  ]) {
    expect(text).not.toContain(secret);
  }
  expect(text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
}

describe('sdlc trial report (V01, ADR-M65)', () => {
  it('builds the anonymous report from the existing GET endpoints only', async () => {
    const r = await run(new TrialWorld());
    expect(r.code).toBe(EXIT.ok);
    expect(r.urls.every((u) => u.pathname.startsWith('/v1/'))).toBe(true);
    const paths = new Set(r.urls.map((u) => u.pathname.replace(/INT-2026-[0-9]+/, ':intent')));
    expect([...paths].sort()).toEqual(
      [
        '/v1/cost/report',
        '/v1/escalations',
        '/v1/intents',
        '/v1/intents/:intent',
        '/v1/intents/:intent/runs',
        '/v1/metrics/gates',
      ].sort(),
    );
    const body = report(r);
    expect(body.schema).toBe('sdlc-trial-report/1');
    expect(body.platform_version).toBe(PLATFORM_VERSION);
    expect(body.generated_on).toBe('2026-10-09');
    expect(body.range).toEqual({ from: '2026-07-12', to: '2026-10-10' });
    expect(body.projects).toHaveLength(1);
    const project = body.projects[0]!;
    expect(project.id).toBe('project-1');
    expect(project.intents_by_status).toEqual({ done: 1, in_gate: 1 });
    expect(project.gates[0]).toMatchObject({ gate: 'G3', auto_passed: 1, open: { count: 1 } });
    expect(project.escalations).toMatchObject({
      total: 1,
      by_trigger: { time: 1 },
      by_route: { intent: 1 },
    });
    const [first, second] = project.intents;
    expect(first).toMatchObject({
      id: 'intent-1',
      risk: 'low',
      status: 'done',
      gate: null,
      lead_time_seconds: 3600,
      runs: {
        total: 2,
        by_status: { failed: 1, succeeded: 1 },
        by_stop_reason: { agent_error: 1 },
      },
      g7_requests_for_changes: 1,
      escalations: 1,
    });
    expect(first?.decisions).toContainEqual({
      gate: 'G2',
      decision: 'pass',
      actor: 'system',
      count: 1,
    });
    expect(first?.cost?.cost_usd).toBe('0.300000');
    expect(second).toMatchObject({
      id: 'intent-2',
      status: 'in_gate',
      gate: 'G4',
      lead_time_seconds: null,
      cost: null,
    });
    // Model names that are not gateway names are summed under `other`, with exact decimals.
    expect(body.models.map((m) => m.model)).toEqual(['gpt-oss-20b', 'other']);
    expect(body.models[1]).toMatchObject({ calls: 3, cost_usd: '1.100000' });
    expect(body.totals.cost_usd).toBe('0.400001');
    assertAnonymous(r.out.join('\n'));
  });

  it('leaves out intents created before the range', async () => {
    const body = report(await run(new TrialWorld({ old: true })));
    expect(body.projects[0]?.intents).toHaveLength(2);
  });

  it('never prints a marker put in any free field of any answer', async () => {
    let n = 0;
    const markers: string[] = [];
    const r = await run(new TrialWorld(), ['--json'], (url, reply) => {
      const schema = schemaFor(url);
      if (!schema || reply.status !== 200) return reply;
      return {
        ...reply,
        body: markLeaves(reply.body, schema, () => {
          n += 1;
          const marker = `zmark${String(n)}z`;
          markers.push(marker);
          return marker;
        }),
      };
    });
    expect(r.code).toBe(EXIT.ok);
    expect(markers.length).toBeGreaterThan(20);
    const text = r.out.join('\n');
    for (const marker of markers) expect(text).not.toContain(marker);
    assertAnonymous(text);
  });

  it('ignores a new field in an answer and turns an unknown code into other', async () => {
    const r = await run(new TrialWorld(), ['--json'], (url, reply) => {
      if (!/^\/v1\/intents\/[^/]+\/runs$/.test(url.pathname)) return reply;
      const body = reply.body as { items: Record<string, unknown>[] };
      return {
        ...reply,
        body: {
          ...body,
          notes: 'zleakz',
          items: body.items.map((run) => ({ ...run, status: 'brand_new_status', notes: 'zleakz' })),
        },
      };
    });
    expect(r.code).toBe(EXIT.ok);
    expect(r.out.join('\n')).not.toContain('zleakz');
    expect(report(r).projects[0]?.intents[0]?.runs.by_status).toEqual({ other: 2 });
  });

  it('prints nothing when the report fails its check (fail closed)', async () => {
    vi.mocked(build.buildReport).mockImplementationOnce((data, context) => ({
      ...realBuild.fn(data, context),
      platform_version: SECRET_EMAIL,
    }));
    const r = await run(new TrialWorld());
    expect(r.code).toBe(EXIT.error);
    expect(r.out).toEqual([]);
    expect(r.err.join('\n')).toContain(t('cli.trial.check_failed'));
    expect(r.err.join('\n')).not.toContain(SECRET_EMAIL);
  });

  it('keeps to 4 requests at a time and to the request count of the plan (500 intents)', async () => {
    const r = await run(new TrialWorld({ intents: 500 }));
    expect(r.code).toBe(EXIT.ok);
    expect(r.maxInFlight).toBeLessThanOrEqual(POOL_SIZE);
    // 3 summary reads, 5 intent pages, 3 reads per intent.
    expect(r.urls).toHaveLength(3 + 5 + 500 * 3);
    expect(report(r).truncated.intents).toBe(false);
  });

  it('marks the intents it cut at --max-intents, oldest first', async () => {
    const body = report(
      await run(new TrialWorld({ intents: 12 }), ['--json', '--max-intents', '10']),
    );
    expect(body.truncated.intents).toBe(true);
    expect(body.projects[0]?.intents).toHaveLength(10);
    expect(body.projects[0]?.intents.at(-1)?.id).toBe('intent-10');
  });

  it('tries a 503 again and goes on', async () => {
    let fails = 2;
    const r = await run(new TrialWorld(), ['--json'], (url, reply) => {
      if (url.pathname === '/v1/metrics/gates' && fails > 0) {
        fails -= 1;
        return { status: 503, body: { error: { code: 'unavailable', message: 'x' } } };
      }
      return reply;
    });
    expect(r.code).toBe(EXIT.ok);
    expect(r.sleeps).toEqual([...RETRY_DELAYS_MS]);
  });

  it("tries a proxy's HTML 503 again too", async () => {
    let fails = 1;
    const r = await run(new TrialWorld(), ['--json'], (url, reply) => {
      if (url.pathname === '/v1/intents' && fails > 0) {
        fails -= 1;
        return { status: 503, raw: '<html>Service Unavailable</html>' };
      }
      return reply;
    });
    expect(r.code).toBe(EXIT.ok);
    expect(r.sleeps).toEqual([RETRY_DELAYS_MS[0]]);
  });

  it('after one failure the other workers send no new request', async () => {
    const world = new TrialWorld({ intents: 200 });
    const r = await run(world, ['--json'], (url, reply) =>
      url.pathname === '/v1/intents/INT-2026-0003'
        ? { status: 403, body: { error: { code: 'forbidden', message: 'x' } } }
        : reply,
    );
    expect(r.code).toBe(EXIT.failed);
    // 3 summary reads, 2 pages, then at most a few intents' reads before the stop.
    expect(r.urls.length).toBeLessThan(3 + 2 + 3 * 10);
  });

  it('never prints the error text of the API, which can name an intent or a project', async () => {
    for (const json of [[], ['--json']]) {
      const r = await run(new TrialWorld(), json, (url, reply) =>
        /^\/v1\/intents\/[^/]+$/.test(url.pathname)
          ? {
              status: 404,
              body: {
                error: {
                  code: 'secret_code_for_test',
                  message: `intent INT-2026-0001 of ${SECRET_SLUG} not found`,
                  reason_message: SECRET_REPO,
                },
              },
            }
          : reply,
      );
      expect(r.code).toBe(EXIT.failed);
      expect(r.out).toEqual([]);
      const text = r.err.join('\n');
      expect(text).toContain(t('cli.trial.fetch_refused', { status: 404, kind: 'http' }));
      assertAnonymous(text);
      expect(text).not.toContain('secret_code_for_test');
    }
  });

  it('stops without a report when a request still fails', async () => {
    const r = await run(new TrialWorld(), ['--json'], (url, reply) =>
      /^\/v1\/intents\/[^/]+$/.test(url.pathname)
        ? { status: 503, body: { error: { code: 'unavailable', message: 'x' } } }
        : reply,
    );
    expect(r.code).toBe(EXIT.error);
    expect(r.out).toEqual([]);
    expect(r.err.join('\n')).toContain(t('cli.trial.fetch_failed', { tries: 3, status: 503 }));
  });

  it('does not try a refusal again: 403 stops at once, exit 1', async () => {
    const r = await run(new TrialWorld(), ['--json'], (url, reply) =>
      url.pathname === '/v1/metrics/gates'
        ? { status: 403, body: { error: { code: 'forbidden', message: 'x' } } }
        : reply,
    );
    expect(r.code).toBe(EXIT.failed);
    expect(r.sleeps).toEqual([]);
    expect(r.out).toEqual([]);
  });

  it('sends --project to the summary reads and the intent list', async () => {
    const r = await run(new TrialWorld(), ['--json', '--project', SECRET_SLUG]);
    for (const path of ['/v1/metrics/gates', '/v1/cost/report', '/v1/intents']) {
      expect(r.urls.find((u) => u.pathname === path)?.searchParams.get('project')).toBe(
        SECRET_SLUG,
      );
    }
    assertAnonymous(r.out.join('\n'));
  });

  it('prints a summary without --json, and says how to send the report', async () => {
    const r = await run(new TrialWorld(), []);
    expect(r.code).toBe(EXIT.ok);
    expect(r.out[0]).toBe(
      t('cli.trial.header', { version: PLATFORM_VERSION, from: '2026-07-12', to: '2026-10-10' }),
    );
    expect(r.out.at(-1)).toBe(t('cli.trial.send'));
    assertAnonymous(r.out.join('\n'));
  });

  it('says when no intent was created in the range', async () => {
    const r = await run(new TrialWorld({ intents: 0 }), []);
    expect(r.out).toContain(t('cli.trial.empty'));
  });

  it('refuses bad options with the usage (exit 2)', async () => {
    for (const args of [
      ['--from', '2026-13-01'],
      ['--from', '2025-01-01', '--to', '2026-10-01'],
      ['--from', '2026-10-02', '--to', '2026-10-01'],
      ['--max-intents', '0'],
      ['--max-intents', '1001'],
      ['--other'],
    ]) {
      const r = await run(new TrialWorld(), args);
      expect(r.code).toBe(EXIT.usage);
      expect(r.urls).toEqual([]);
    }
  });

  it('the default range is the 90 days that end today', () => {
    expect(trialRange(undefined, undefined, NOW)).toEqual({ from: '2026-07-12', to: '2026-10-10' });
    expect(trialRange('2026-10-01', undefined, NOW)).toEqual({
      from: '2026-10-01',
      to: '2026-10-10',
    });
  });
});

describe('the report check and the helpers', () => {
  it('refuses free text, an e-mail, a URL, a UUID and an unknown field', () => {
    const good = JSON.parse(JSON.stringify(emptyReport())) as Record<string, unknown>;
    expect(reportIsSafe(good)).toBe(true);
    expect(reportIsSafe({ ...good, platform_version: SECRET_EMAIL })).toBe(false);
    expect(reportIsSafe({ ...good, extra: 1 })).toBe(false);
    expect(reportIsSafe({ ...good, models: [{ ...model(), model: 'https://x' }] })).toBe(false);
    expect(reportIsSafe({ ...good, models: [{ ...model(), model: 'Free text' }] })).toBe(false);
    expect(reportIsSafe({ ...good, models: [{ ...model(), model: 'acme-internal-gpt' }] })).toBe(
      false,
    );
    expect(reportIsSafe({ ...good, models: [model()] })).toBe(true);
    expect(reportIsSafe({ ...good, generated_on: '44444444-4444-4444-8444-000000000001' })).toBe(
      false,
    );
  });

  it('known, stopReasonOrOther and modelOrOther', () => {
    expect(build.known(['done'], 'done')).toBe('done');
    expect(build.known(['done'], 'Done!')).toBe('other');
    expect(build.stopReasonOrOther('agent_error')).toBe('agent_error');
    expect(build.stopReasonOrOther('acmesecret')).toBe('other');
    expect(build.stopReasonOrOther('a b')).toBe('other');
    expect(build.modelOrOther('claude-haiku-4-5-20251001')).toBe('claude-haiku-4-5-20251001');
    expect(build.modelOrOther('acme-internal-llm')).toBe('other');
  });

  it('the known models are exactly the gateway models of config.ctmpl', () => {
    const config = readFileSync(
      join(process.cwd(), 'platform/deploy/litellm/config.ctmpl'),
      'utf8',
    );
    const names = [...config.matchAll(/^\s*- model_name: ([^\s]+)\s*$/gm)].map((m) => m[1] ?? '');
    expect([...build.KNOWN_MODELS].sort()).toEqual(names.sort());
  });

  it('pool keeps the order and never runs more than its size', async () => {
    let running = 0;
    let most = 0;
    const out = await pool([1, 2, 3, 4, 5, 6, 7, 8, 9], 3, { failed: false }, async (x) => {
      running += 1;
      most = Math.max(most, running);
      await new Promise((resolve) => setTimeout(resolve, 1));
      running -= 1;
      return x * 2;
    });
    expect(out).toEqual([2, 4, 6, 8, 10, 12, 14, 16, 18]);
    expect(most).toBeLessThanOrEqual(3);
  });

  it('the CLI version is the release version of the root package.json', () => {
    const root = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as {
      version: string;
    };
    expect(PLATFORM_VERSION).toBe(root.version);
  });
});

function model(): Record<string, unknown> {
  return {
    model: 'gpt-oss-20b',
    calls: 0,
    input_tokens: '0',
    output_tokens: '0',
    cached_input_tokens: '0',
    cost_usd: '0.000000',
    wasted_tokens: '0',
    wasted_cost_usd: '0.000000',
  };
}

function emptyReport(): unknown {
  const zero = Object.fromEntries(Object.entries(model()).filter(([key]) => key !== 'model'));
  return {
    schema: 'sdlc-trial-report/1',
    platform_version: '0.1.0',
    generated_on: '2026-10-09',
    range: { from: '2026-07-12', to: '2026-10-10' },
    truncated: { intents: false, escalations: false, gates: false, cost: false },
    totals: zero,
    models: [],
    projects: [],
  };
}

/**
 * Puts a marker in every string leaf of `body` that the CLI schema still accepts with it: free
 * text, slugs, paths… Coded fields refuse it and keep their value (the anonymity test covers them).
 */
function markLeaves(body: unknown, schema: Checkable, marker: () => string): unknown {
  let current = structuredClone(body);
  const visit = (path: (string | number)[], value: unknown): void => {
    const key = path.at(-1);
    // An intent code and a page cursor address other answers; the anonymity test covers codes.
    if (key === 'code' || key === 'next_cursor') return;
    if (typeof value === 'string') {
      const candidate = setAt(current, path, marker());
      if (schema.safeParse(candidate).success) current = candidate;
      return;
    }
    if (Array.isArray(value)) value.forEach((item, i) => visit([...path, i], item));
    else if (value !== null && typeof value === 'object') {
      for (const [key, item] of Object.entries(value)) visit([...path, key], item);
    }
  };
  visit([], body);
  return current;
}

function setAt(root: unknown, path: readonly (string | number)[], value: unknown): unknown {
  if (path.length === 0) return value;
  const [head, ...rest] = path;
  const copy = (Array.isArray(root) ? [...(root as unknown[])] : { ...(root as object) }) as Record<
    string | number,
    unknown
  >;
  copy[head as string | number] = setAt(copy[head as string | number], rest, value);
  return copy;
}
