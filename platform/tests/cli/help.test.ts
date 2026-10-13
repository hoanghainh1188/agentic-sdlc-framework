// A friendlier CLI (task V10, D-08 V10 AC1–AC4): `sdlc help [topic|command]`, `--help` and `-h`
// on every command, one example per command (a test fails on a command without one), the
// next-step line after a command that moves an intent (never in `--json`, never a reason to fail),
// the line that says what to do after a failure, and no colour anywhere (Harry, 2026-10-13).
import { t } from '@sdlc/messages';
import { describe, expect, it } from 'vitest';

import { ApiCallError } from '../../apps/cli/src/api/client.js';
import { fixKey } from '../../apps/cli/src/api/errors.js';
import { intentDetailSchema, meSchema } from '../../apps/cli/src/api/schemas.js';
import { COMMAND_HELP, HELP_TOPICS, commandHelp } from '../../apps/cli/src/commands/help.js';
import { adviceText } from '../../apps/cli/src/commands/next.js';
import { adviseNext } from '../../apps/cli/src/commands/next/advice.js';
import { EXIT, USER_COMMAND_GROUPS } from '../../apps/cli/src/index.js';
import { decisionBody, intentDetailBody, meBody } from './fixtures.js';
import { apiError, useHarness } from './harness.js';

const harness = useHarness();
const CODE = 'INT-2026-0007';
const DECIDE = `POST /v1/intents/${CODE}/gates/G2/decisions`;
const READS = { 'GET /v1/me': meBody(), [`GET /v1/intents/${CODE}`]: intentDetailBody() };
const ok = (body: Record<string, unknown>) => ({ status: 200, body });
// ESC, and the 8-bit CSI: what colour or cursor codes start with.
const hasColour = (text: string): boolean => text.includes('\u001b') || text.includes('\u009b');

describe('AC1, AC4: every command has help and an example', () => {
  it('covers every command group, the API ones, audit and ops', () => {
    expect(Object.keys(COMMAND_HELP).sort()).toEqual(
      [...USER_COMMAND_GROUPS, 'audit', 'ops'].sort(),
    );
  });

  it.each(Object.entries(COMMAND_HELP))('%s: a usage text and one example', (group, keys) => {
    expect(t(keys.usage).trim()).not.toBe('');
    const example = t(keys.example);
    expect(example).toMatch(/^(pnpm )?sdlc /);
    expect(example).toContain(` ${group === 'ai-record' ? 'ai-record' : group}`);
    expect(commandHelp(group)).toBe(
      `${t(keys.usage)}\n\n${t('cli.help.example_header')}\n  ${example}`,
    );
  });

  it('sdlc help lists every command and topic', async () => {
    const h = await harness();
    expect(await h.run(['help'])).toBe(EXIT.ok);
    const text = h.out.join('\n');
    expect(text).toBe(t('cli.help.overview'));
    for (const group of Object.keys(COMMAND_HELP)) expect(text).toContain(group);
    for (const topic of Object.keys(HELP_TOPICS)) expect(text).toContain(topic);
  });

  it.each(Object.entries(HELP_TOPICS))('sdlc help %s prints its guide', async (topic, key) => {
    const h = await harness();
    expect(await h.run(['help', topic])).toBe(EXIT.ok);
    expect(h.out).toEqual([t(key)]);
  });

  it.each([
    [['help', 'intent']],
    [['intent', '--help']],
    [['intent', 'create', '-h']],
    [['intent', 'create', '--project', 'shop', '--help']],
  ])('%j prints the help of the command, with no API call and no login', async (argv) => {
    const h = await harness();
    expect(await h.run(argv)).toBe(EXIT.ok);
    expect(h.out).toEqual([commandHelp('intent')]);
    expect(h.requests).toEqual([]);
  });

  it('works for audit and ops, and sdlc --help prints the overview', async () => {
    for (const group of ['audit', 'ops']) {
      const h = await harness();
      expect(await h.run([group, '--help'])).toBe(EXIT.ok);
      expect(h.out).toEqual([commandHelp(group)]);
    }
    const h = await harness();
    expect(await h.run(['--help'])).toBe(EXIT.ok);
    expect(h.out).toEqual([t('cli.help.overview')]);
  });

  it('refuses an unknown topic or command (exit 2), and sdlc alone still prints the usage', async () => {
    const h = await harness();
    expect(await h.run(['help', 'nope'])).toBe(EXIT.usage);
    expect(h.err).toEqual([t('cli.help.unknown', { subject: 'nope' })]);
    const bare = await harness();
    expect(await bare.run([])).toBe(EXIT.usage);
    expect(bare.err).toEqual([t('cli.usage')]);
    expect(t('cli.usage')).toContain('sdlc help');
  });
});

describe('AC2: the next step after a command that moves an intent', () => {
  const expected = () =>
    t('cli.hint.next', {
      text: adviceText(
        adviseNext(intentDetailSchema.parse(intentDetailBody()), meSchema.parse(meBody())),
      ),
      intent: CODE,
    });

  it('prints one line with the advice of sdlc next after the decision', async () => {
    const h = await harness({
      routes: { [DECIDE]: { status: 201, body: decisionBody() }, ...mapOk(READS) },
    });
    expect(await h.run(['gate', 'approve', 'G2', CODE])).toBe(EXIT.ok);
    expect(h.out.at(-1)).toBe(expected());
    expect(h.out).toHaveLength(2);
  });

  it('never with --json: the body alone, and no read for the hint', async () => {
    const h = await harness({
      routes: { [DECIDE]: { status: 201, body: decisionBody() }, ...mapOk(READS) },
    });
    expect(await h.run(['gate', 'approve', 'G2', CODE, '--json'])).toBe(EXIT.ok);
    expect(() => JSON.parse(h.out.join('\n')) as unknown).not.toThrow();
    expect(h.requests.map((r) => r.method)).toEqual(['POST']);
  });

  it('a failed read leaves the hint out; the command still succeeds', async () => {
    const h = await harness({
      routes: {
        [DECIDE]: { status: 201, body: decisionBody() },
        'GET /v1/me': apiError(500, 'internal'),
      },
    });
    expect(await h.run(['gate', 'approve', 'G2', CODE])).toBe(EXIT.ok);
    expect(h.out).toHaveLength(1);
    expect(h.err).toEqual([]);
  });
});

describe('AC2: what to do after a failure', () => {
  const http = (status: number, reason?: string) =>
    new ApiCallError('http', status, {
      error: { code: 'x', message: 'm', ...(reason === undefined ? {} : { reason }) },
    });

  it.each([
    [new ApiCallError('network'), 'cli.fix.connection'],
    [new ApiCallError('timeout'), 'cli.fix.connection'],
    [new ApiCallError('redirect'), 'cli.fix.connection'],
    [new ApiCallError('malformed'), 'cli.fix.version'],
    [http(400), 'cli.fix.invalid'],
    [http(403), 'cli.fix.forbidden'],
    [http(404), 'cli.fix.not_found'],
    [http(409), 'cli.fix.conflict'],
    [http(422), 'cli.fix.refused'],
    [http(429), 'cli.fix.rate_limited'],
    [http(500), 'cli.fix.unavailable'],
    [http(503), 'cli.fix.unavailable'],
  ])('%s → %s', (error, key) => {
    expect(fixKey(error)).toBe(key);
  });

  it('no line when a rule refused with a reason (the reason explains it), or on an expired login', () => {
    expect(fixKey(http(422, 'role_missing'))).toBeUndefined();
    expect(fixKey(http(401))).toBeUndefined();
  });

  it('prints it after the refusal, never with --json', async () => {
    const routes = { [DECIDE]: apiError(403, 'forbidden') };
    const h = await harness({ routes });
    expect(await h.run(['gate', 'approve', 'G2', CODE])).toBe(EXIT.failed);
    expect(h.err.at(-1)).toBe(t('cli.fix.forbidden'));
    const json = await harness({ routes });
    expect(await json.run(['gate', 'approve', 'G2', CODE, '--json'])).toBe(EXIT.failed);
    expect(json.err.join('\n')).not.toContain(t('cli.fix.forbidden'));
  });
});

describe('AC3: no colour (Harry, 2026-10-13)', () => {
  it('no help text, hint or fix line holds a colour or cursor code', async () => {
    const texts = [
      t('cli.help.overview'),
      ...Object.values(HELP_TOPICS).map((key) => t(key)),
      ...Object.keys(COMMAND_HELP).map((group) => commandHelp(group) ?? ''),
    ];
    for (const text of texts) expect(hasColour(text)).toBe(false);
    const h = await harness({
      tty: true,
      routes: { [DECIDE]: { status: 201, body: decisionBody() }, ...mapOk(READS) },
    });
    expect(await h.run(['gate', 'approve', 'G2', CODE])).toBe(EXIT.ok);
    expect(hasColour([...h.out, ...h.err].join('\n'))).toBe(false);
  });
});

function mapOk(bodies: Record<string, Record<string, unknown>>) {
  return Object.fromEntries(Object.entries(bodies).map(([route, body]) => [route, ok(body)]));
}
