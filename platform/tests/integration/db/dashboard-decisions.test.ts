// D-08 U07 on a live PostgreSQL, through the Nest app and Fastify `inject()` (no port), with a
// software passkey: a gate decision, a kill, an escalation acknowledgement and decision made from
// a dashboard session (design/ADR-M73 §2.4b, §2.6; QUESTIONS #377, #378):
// - a gate decision needs the step-up; it is recorded with source `web` and the person's user ID;
// - a changed gate input is refused with 409 and the step-up stays unused;
// - a kill from a session records the kill source `web`;
// - an escalation decision needs the step-up; the acknowledgement does not;
// - no session, passkey or challenge ID reaches an append-only table.
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { WebSignInProvider } from '../../../packages/contracts/src/index.js';
import { createApp, type ApiDeps } from '../../../apps/api/src/app.js';
import type { WebSignInSettings } from '../../../apps/api/src/settings.js';
import type { Intent } from '../../../packages/core/src/db/schema.js';
import { startRun } from '../../../packages/core/src/workflow/run-lifecycle.js';
import { deriveCsrfToken, startWebSession } from '../../../packages/core/src/web-sessions/index.js';
import { SoftAuthenticator } from '../../passkeys/soft-authenticator.js';
import { atG4, harness, T0, type Harness } from '../g4-harness.js';
import { createTestDatabase, describeDb, type TestDatabase } from './helpers.js';

type App = Awaited<ReturnType<typeof createApp>>;
type Person = 'a' | 'b';
const asApiDb = (db: TestDatabase): ApiDeps['db'] => db.app as unknown as ApiDeps['db'];
const MIN = 60_000;
const ORIGIN = 'http://localhost:8090';

const SETTINGS: WebSignInSettings = {
  publicOrigin: ORIGIN,
  callbackUrl: `${ORIGIN}/v1/auth/github/callback`,
  githubWebUrl: 'https://github.com',
  githubApiUrl: 'https://api.github.com',
  oauthSecretPath: 'api/github-oauth',
  idleMs: 30 * MIN,
  maxAgeMs: 8 * 60 * MIN,
  actions: true,
};

/** Never called: these tests open sessions with `startWebSession` directly. */
const NO_GITHUB: WebSignInProvider = {
  authorizeUrl: () => Promise.reject(new Error('not used')),
  exchangeCode: () => Promise.reject(new Error('not used')),
  accountId: () => Promise.reject(new Error('not used')),
  revokeToken: () => Promise.resolve(),
};

interface Reply {
  readonly statusCode: number;
  readonly body: string;
  json(): Record<string, unknown> & { error?: { code: string } };
}

interface Session {
  readonly id: string;
  readonly secret: string;
  readonly csrf: string;
  readonly key: SoftAuthenticator;
  readonly passkeyId: string;
}

describeDb('U07: decisions, kills and escalations from a dashboard session', () => {
  let db: TestDatabase;
  let t: Harness;
  let app: App;
  const sessions = {} as Record<Person, Session>;

  const inject = async (
    method: 'GET' | 'POST',
    url: string,
    headers: Record<string, string> = {},
    payload?: unknown,
  ): Promise<Reply> =>
    await app
      .getHttpAdapter()
      .getInstance()
      .inject({
        method,
        url,
        headers,
        ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
      });

  /** The headers of a write from the dashboard page: cookie, CSRF token, same origin. */
  const page = (s: Session): Record<string, string> => ({
    cookie: `__Host-sdlc_session=${s.secret}`,
    'x-sdlc-csrf': s.csrf,
    origin: ORIGIN,
    'sec-fetch-site': 'same-origin',
  });

  /** A session for a person of the fixture, with a registered software passkey. */
  async function open(who: Person): Promise<Session> {
    const userId = t.f.users[who];
    const [identity] = await t.f.scope.userIdentities.listForUser(userId);
    const started = await startWebSession(t.f.scope, {
      userId,
      identityId: identity!.id,
      now: new Date(),
      maxAgeMs: SETTINGS.maxAgeMs,
    });
    const base = {
      id: started.session.id,
      secret: started.secret,
      csrf: deriveCsrfToken(started.secret),
    };
    const key = new SoftAuthenticator({ origin: ORIGIN });
    const headers = page({ ...base, key, passkeyId: '' });
    const options = await inject('POST', '/v1/me/passkeys/registration-options', headers);
    expect(options.statusCode, options.body).toBe(200);
    const body = options.json() as {
      challenge_id: string;
      options: { challenge: string; rp: { id: string } };
    };
    const registered = await inject('POST', '/v1/me/passkeys', headers, {
      challenge_id: body.challenge_id,
      response: key.register(body.options),
    });
    expect(registered.statusCode, registered.body).toBe(201);
    return { ...base, key, passkeyId: String(registered.json().id) };
  }

  /** The page's step-up: a challenge for the exact body, answered by the passkey. */
  async function stepUp(s: Session, request: Record<string, unknown>) {
    const reply = await inject('POST', '/v1/auth/step-up', page(s), request);
    expect(reply.statusCode, reply.body).toBe(200);
    const body = reply.json() as { challenge_id: string; options: { challenge: string } };
    return {
      challengeId: body.challenge_id,
      answer: { challenge_id: body.challenge_id, response: s.key.authenticate(body.options) },
    };
  }

  /** A new Medium intent the workflow moved to G1. */
  async function atG1(): Promise<Intent> {
    const intent = await t.f.newIntent({ riskTier: 'medium' });
    await t.settle(intent);
    const current = await t.reload(intent);
    expect(current).toMatchObject({ status: 'in_gate', current_gate: 'G1' });
    return current;
  }

  /** What a session must never leave in an append-only table. */
  const sessionIds = (): string[] =>
    Object.values(sessions).flatMap((s) => [s.id, s.passkeyId, s.secret, s.csrf]);
  const expectNoSessionIds = (rows: unknown, extra: readonly string[] = []) => {
    const text = JSON.stringify(rows);
    for (const id of [...sessionIds(), ...extra]) expect(text).not.toContain(id);
  };

  beforeAll(async () => {
    db = await createTestDatabase();
    t = await harness(db);
    t.setClock(T0);
    app = await createApp({
      db: asApiDb(db),
      settings: { rateLimitPerMinute: 10_000, authFailuresPerMinute: 1000 },
      now: () => new Date(),
      logger: { error: () => undefined },
      webSignIn: {
        settings: SETTINGS,
        provider: NO_GITHUB,
        limits: { starts: 10_000, callbacks: 10_000, passkeys: 10_000 },
      },
    });
    sessions.a = await open('a');
    sessions.b = await open('b');
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await t?.f.close();
    await db?.drop();
  });

  describe('gate decisions', () => {
    it('with the step-up: recorded with source `web` and the user ID, bound to the gate input', async () => {
      const intent = await atG1();
      const shown = await inject('GET', `/v1/intents/${intent.code}`, page(sessions.a));
      expect(shown.statusCode, shown.body).toBe(200);
      const inputSha256 = shown.json().gate_input_sha256;
      expect(inputSha256).toMatch(/^[0-9a-f]{64}$/);

      const request = { decision: 'approve' };
      const url = `/v1/intents/${intent.code}/gates/G1/decisions`;
      // Without the step-up: refused, nothing recorded.
      const refused = await inject('POST', url, page(sessions.a), {
        ...request,
        expected_input_sha256: inputSha256,
      });
      expect(refused.statusCode, refused.body).toBe(403);
      expect(refused.json().error?.code).toBe('step_up_refused');
      expect(await t.f.scope.gateDecisions.listForIntent(intent.id)).toEqual([]);

      const { challengeId, answer } = await stepUp(sessions.a, {
        action: 'gate.decide',
        intent: intent.code,
        gate: 'G1',
        expected_input_sha256: inputSha256,
        request,
      });
      const decided = await inject('POST', url, page(sessions.a), {
        ...request,
        expected_input_sha256: inputSha256,
        step_up: answer,
      });
      expect(decided.statusCode, decided.body).toBe(201);
      const rows = await t.f.scope.gateDecisions.listForIntent(intent.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        gate: 'G1',
        decision: 'approve',
        source: 'web',
        decided_by: t.f.users.a,
        input_sha256: inputSha256,
      });
      expectNoSessionIds(rows, [challengeId]);
      expectNoSessionIds(await t.f.scope.audit.listForEntity(intent.id), [challengeId]);
    });

    it('a changed gate input: 409, nothing recorded, the step-up stays unused', async () => {
      const intent = await atG1();
      const stale = 'e'.repeat(64);
      const request = { decision: 'approve' };
      const { challengeId, answer } = await stepUp(sessions.a, {
        action: 'gate.decide',
        intent: intent.code,
        gate: 'G1',
        expected_input_sha256: stale,
        request,
      });
      const reply = await inject(
        'POST',
        `/v1/intents/${intent.code}/gates/G1/decisions`,
        page(sessions.a),
        { ...request, expected_input_sha256: stale, step_up: answer },
      );
      expect(reply.statusCode, reply.body).toBe(409);
      expect(reply.json().error?.code).toBe('gate_input_conflict');
      expect(await t.f.scope.gateDecisions.listForIntent(intent.id)).toEqual([]);
      expect((await t.f.scope.passkeyChallenges.getById(challengeId))?.used_at).toBeNull();
    });
  });

  describe('a kill and its escalation', () => {
    it('a kill from a session records the source `web`; acknowledge, then decide with the step-up', async () => {
      const intent = await atG4(t, 'medium');
      expect(await t.settleRuns(intent)).toEqual({ outcome: 'run_prepare' });
      const started = await startRun(t.f.scope, t.runDeps, intent.id);
      if (!started.ok) throw new Error('not started');
      const runId = started.run.runId;

      const killed = await inject('POST', `/v1/runs/${runId}/kill`, page(sessions.b), {});
      expect(killed.statusCode, killed.body).toBe(202);
      const events = await t.f.scope.runEvents.list(runId);
      expect(events.find((e) => e.event_type === 'kill_requested')?.payload).toMatchObject({
        source: 'web',
      });
      const audit = await t.f.scope.audit.listForEntity(runId, ['run.kill_requested']);
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({ actor_id: t.f.users.b, payload: { source: 'web' } });
      expectNoSessionIds([events, audit]);

      const [escalation] = await t.f.scope.escalations.listForIntent(intent.id);
      expect(escalation).toBeDefined();
      const code = escalation!.code;

      // The acknowledgement needs no step-up.
      const acked = await inject('POST', `/v1/escalations/${code}/ack`, page(sessions.b), {});
      expect(acked.statusCode, acked.body).toBe(200);

      const request = { decision: 'resume' };
      const url = `/v1/escalations/${code}/decisions`;
      const refused = await inject('POST', url, page(sessions.b), request);
      expect(refused.statusCode, refused.body).toBe(403);
      expect(refused.json().error?.code).toBe('step_up_refused');
      expect((await t.f.scope.escalations.getByCode(code))?.status).not.toBe('resolved');

      const { challengeId, answer } = await stepUp(sessions.b, {
        action: 'escalation.decide',
        escalation: code,
        request,
      });
      const decided = await inject('POST', url, page(sessions.b), { ...request, step_up: answer });
      expect(decided.statusCode, decided.body).toBe(201);
      expect((await t.f.scope.escalations.getByCode(code))?.status).toBe('resolved');
      expect((await t.f.scope.passkeyChallenges.getById(challengeId))?.used_at).not.toBeNull();
      expectNoSessionIds(await t.f.scope.audit.listForEntity(escalation!.id), [challengeId]);
    });
  });

  it('the append-only tables have no column for a session or a passkey', async () => {
    const { rows } = await sql<{ table_name: string; column_name: string }>`
      SELECT table_name, column_name FROM information_schema.columns
      WHERE table_name IN ('gate_decisions', 'run_events', 'audit_log')
        AND (column_name LIKE '%session%' OR column_name LIKE '%passkey%'
          OR column_name LIKE '%challenge%')`.execute(db.owner);
    expect(rows).toEqual([]);
  });
});
