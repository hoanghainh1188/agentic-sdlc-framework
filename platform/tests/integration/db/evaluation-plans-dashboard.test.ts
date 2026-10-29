// D-08 L05 (PR 5) on PostgreSQL, through the Nest app (design/ADR-M82 §2.7, QUESTIONS #470,
// #477): the four evaluation plan actions a dashboard session may send, with a software passkey.
// - each needs the three CSRF layers; with the actions switch off they are refused;
// - Run now always needs the step-up; a create or change only when it turns a schedule or
//   `on_change` on or raises a budget; archive never; a token never;
// - the step-up is bound to the action, the plan or project and the body: another plan, another
//   body or a used answer is refused;
// - `can_change` tells the page whether to show the actions (QUESTIONS #477).
import { GitHostError } from '@sdlc/contracts';
import { t, type MessageKey } from '@sdlc/messages';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { WebSignInProvider } from '../../../packages/contracts/src/index.js';
import { createApp, type ApiDeps } from '../../../apps/api/src/app.js';
import type { WebSignInSettings } from '../../../apps/api/src/settings.js';
import { issueApiToken } from '../../../packages/core/src/admin/tokens.js';
import { deriveCsrfToken, startWebSession } from '../../../packages/core/src/web-sessions/index.js';
import { SoftAuthenticator } from '../../passkeys/soft-authenticator.js';
import { seedPlanWorld, type PlanWorld } from '../plan-seed.js';
import { tokenIssuedAt } from '../token-clock.js';
import { createTestDatabase, describeDb, type TestDatabase } from './helpers.js';

type App = Awaited<ReturnType<typeof createApp>>;
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
const NO_GITHUB: WebSignInProvider = {
  authorizeUrl: () => Promise.reject(new Error('not used')),
  exchangeCode: () => Promise.reject(new Error('not used')),
  accountId: () => Promise.reject(new Error('not used')),
  revokeToken: () => Promise.resolve(),
};

interface Reply {
  readonly statusCode: number;
  readonly body: string;
  json(): Record<string, unknown> & { error?: { code: string; message: string } };
}
interface Session {
  readonly secret: string;
  readonly csrf: string;
}

describeDb('L05 PR 5: evaluation plan actions from a dashboard session', () => {
  let db: TestDatabase;
  let app: App;
  let off: App;
  let w: PlanWorld;
  let a: Session;
  let viewer: Session;
  let aToken: string;
  const key = new SoftAuthenticator({ origin: ORIGIN });

  const inject = async (
    target: App,
    method: 'GET' | 'POST',
    url: string,
    headers: Record<string, string> = {},
    payload?: unknown,
  ): Promise<Reply> =>
    await target
      .getHttpAdapter()
      .getInstance()
      .inject({
        method,
        url,
        headers,
        ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
      });
  const page = (s: Session, extra: Record<string, string> = {}) => ({
    cookie: `__Host-sdlc_session=${s.secret}`,
    'x-sdlc-csrf': s.csrf,
    origin: ORIGIN,
    'sec-fetch-site': 'same-origin',
    ...extra,
  });
  const expectError = (reply: Reply, status: number, code: string) => {
    expect(reply.statusCode, reply.body).toBe(status);
    expect(reply.json().error?.code).toBe(code);
    expect(reply.json().error?.message).toBe(t(`api.error.${code}` as MessageKey));
  };

  async function open(userId: string, account: string): Promise<Session> {
    const identity = await w.scope.userIdentities.link({
      user_id: userId,
      provider: 'github',
      external_id: account,
      external_login: `u${account}`,
    });
    const started = await startWebSession(w.scope, {
      userId,
      identityId: identity.id,
      now: new Date(),
      maxAgeMs: SETTINGS.maxAgeMs,
    });
    return { secret: started.secret, csrf: deriveCsrfToken(started.secret) };
  }

  /** The step-up answer for `request` (the body with `decision` and `target`). */
  async function stepUp(s: Session, action: string, request: Record<string, unknown>) {
    const reply = await inject(app, 'POST', '/v1/auth/step-up', page(s), { action, request });
    expect(reply.statusCode, reply.body).toBe(200);
    const body = reply.json() as { challenge_id: string; options: { challenge: string } };
    return { challenge_id: body.challenge_id, response: key.authenticate(body.options) };
  }

  const plan = (over: Record<string, unknown> = {}) => ({
    code: 'weekly',
    data_class: 'internal',
    task_set_version: 1,
    task_ids: null,
    runs_per_task: 1,
    budget_per_run_usd: '1',
    monthly_cap_usd: '5',
    trigger: 'once',
    configurations: [
      { id: 'reg-qwen', agent_key: 'openhands-qwen', max_iterations: 30, max_duration_min: 20 },
    ],
    ...over,
  });

  beforeAll(async () => {
    db = await createTestDatabase();
    w = await seedPlanWorld(db.app, 'dash-plans', new Date());
    aToken = (await issueApiToken(w.scope, { userId: w.users.a, name: 'a', now: tokenIssuedAt() }))
      .token;
    const base = {
      db: db.app as unknown as ApiDeps['db'],
      settings: { rateLimitPerMinute: 10_000, authFailuresPerMinute: 1000 },
      gitHost: {
        getBranchHead: () => Promise.resolve('c'.repeat(40)),
        getFileAtCommit: () => Promise.reject(new GitHostError('not_found')),
      },
    };
    app = await createApp({
      ...base,
      webSignIn: {
        settings: SETTINGS,
        provider: NO_GITHUB,
        limits: { starts: 10_000, callbacks: 10_000, passkeys: 10_000 },
      },
    });
    off = await createApp({
      ...base,
      webSignIn: { settings: { ...SETTINGS, actions: false }, provider: NO_GITHUB },
    });
    a = await open(w.users.a, '3001');
    viewer = await open(w.users.viewer, '3002');
    // Person A's passkey, registered within 5 minutes of the sign-in.
    const options = await inject(app, 'POST', '/v1/me/passkeys/registration-options', page(a));
    const body = options.json() as { challenge_id: string; options: { challenge: string } };
    const registered = await inject(app, 'POST', '/v1/me/passkeys', page(a), {
      challenge_id: body.challenge_id,
      response: key.register(body.options as never),
    });
    expect(registered.statusCode, registered.body).toBe(201);
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await off?.close();
    await db?.drop();
  });

  let planId: string;

  describe('create', () => {
    it('a plan that runs once needs no step-up; can_change tells who may act', async () => {
      const created = await inject(app, 'POST', '/v1/projects/shop/eval-plans', page(a), plan());
      expect(created.statusCode, created.body).toBe(201);
      planId = String(created.json().id);
      expect(created.json().can_change).toBe(true);
      const list = await inject(app, 'GET', '/v1/projects/shop/eval-plans', page(viewer));
      expect(list.json().can_change).toBe(false);
      const show = await inject(app, 'GET', `/v1/eval-plans/${planId}`, page(viewer));
      expect(show.json().can_change).toBe(false);
    });

    it('a schedule needs the step-up, bound to the body and the project', async () => {
      const body = plan({
        code: 'nightly',
        trigger: 'schedule',
        schedule: { every: 'daily', hour: 3 },
      });
      expectError(
        await inject(app, 'POST', '/v1/projects/shop/eval-plans', page(a), body),
        403,
        'step_up_refused',
      );
      // An answer for another body is refused.
      const other = await stepUp(a, 'eval_plan.create', {
        ...plan({ code: 'other' }),
        decision: 'create',
        target: 'shop',
      });
      expectError(
        await inject(app, 'POST', '/v1/projects/shop/eval-plans', page(a), {
          ...body,
          step_up: other,
        }),
        403,
        'step_up_refused',
      );
      const answer = await stepUp(a, 'eval_plan.create', {
        ...body,
        decision: 'create',
        target: 'shop',
      });
      const created = await inject(app, 'POST', '/v1/projects/shop/eval-plans', page(a), {
        ...body,
        step_up: answer,
      });
      expect(created.statusCode, created.body).toBe(201);
    });
  });

  describe('run now and archive', () => {
    it('Run now always needs the step-up; the answer is used once and bound to the plan', async () => {
      expectError(
        await inject(app, 'POST', `/v1/eval-plans/${planId}/runs`, page(a), {}),
        403,
        'step_up_refused',
      );
      const answer = await stepUp(a, 'eval_plan.run', { decision: 'run', target: planId });
      const run = await inject(app, 'POST', `/v1/eval-plans/${planId}/runs`, page(a), {
        step_up: answer,
      });
      expect(run.statusCode, run.body).toBe(202);
      expect(run.json().run_requested_at).not.toBeNull();
      // The same answer a second time: refused.
      expectError(
        await inject(app, 'POST', `/v1/eval-plans/${planId}/runs`, page(a), { step_up: answer }),
        403,
        'step_up_refused',
      );
      // A step-up must name the action's own decision.
      const bad = await inject(app, 'POST', '/v1/auth/step-up', page(a), {
        action: 'eval_plan.run',
        request: { decision: 'create', target: planId },
      });
      expect(bad.statusCode).toBeGreaterThanOrEqual(400);
    });

    it('a token needs no step-up; without the CSRF header or with actions off a session is refused', async () => {
      const tokenRun = await inject(app, 'POST', `/v1/eval-plans/${planId}/runs`, {
        authorization: `Bearer ${aToken}`,
      });
      expect(tokenRun.statusCode, tokenRun.body).toBe(202);
      const noCsrf = page(a);
      delete (noCsrf as Record<string, string>)['x-sdlc-csrf'];
      expectError(
        await inject(app, 'POST', `/v1/eval-plans/${planId}/archive`, noCsrf, {}),
        403,
        'csrf_refused',
      );
      expectError(
        await inject(off, 'POST', `/v1/eval-plans/${planId}/archive`, page(a), {}),
        403,
        'dashboard_actions_off',
      );
    });

    it('a viewer is refused; Person A archives without a step-up', async () => {
      expect(
        (await inject(app, 'POST', `/v1/eval-plans/${planId}/archive`, page(viewer), {}))
          .statusCode,
      ).toBe(403);
      const archived = await inject(app, 'POST', `/v1/eval-plans/${planId}/archive`, page(a), {});
      expect(archived.statusCode, archived.body).toBe(200);
      expect(archived.json()).toMatchObject({ status: 'archived', can_change: false });
    });

    it('unmarked routes stay closed to sessions', async () => {
      expectError(
        await inject(app, 'POST', '/v1/me/tokens', page(a), { name: 'laptop' }),
        403,
        'session_write_not_allowed',
      );
    });
  });
});
