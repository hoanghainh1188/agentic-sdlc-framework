// `sdlc doctor [--json]` (task V07 AC2, AC3): checks this machine's login and the API it talks
// to, and says what to fix. Read only: `GET /health/live`, `GET /health/ready`, `GET /v1/me`,
// `GET /v1/me/tokens`; no new endpoint (QUESTIONS #401 adds `platform_version` to `/v1/me`).
// It never prints the token, and works when the API is down or the login is missing (it says so).
// The checks are pure (`doctor/checks.ts`); this module gathers the facts and prints them.
import { t } from '@sdlc/messages';

import { ApiCallError, type ApiClient } from '../api/client.js';
import { meSchema, tokenListSchema } from '../api/schemas.js';
import { apiIo, clientFor, parseCommand } from '../api/session.js';
import { EXIT, type CliContext } from '../context.js';
import { CredentialsError, readSavedLogin, type SavedLogin } from '../credentials/store.js';
import { isApiToken, normaliseApiUrl } from '../credentials/settings.js';
import { say, sayError, toJson } from '../output.js';
import { PLATFORM_VERSION } from '../version.js';
import {
  evaluate,
  type Answer,
  type CheckResult,
  type DoctorFacts,
  type LoginFact,
  type Text,
} from './doctor/checks.js';
import { probeHealth } from './doctor/probe.js';

export async function runDoctor(args: readonly string[], ctx: CliContext): Promise<number> {
  const parsed = parseCommand(args, {});
  if (!parsed) {
    sayError(ctx, 'cli.doctor.usage');
    return EXIT.usage;
  }
  const results = evaluate(await gather(ctx));
  if (parsed.values.json === true) ctx.stdout(toJson(jsonView(results)));
  else print(ctx, results);
  return results.some((r) => r.status === 'failed') ? EXIT.failed : EXIT.ok;
}

async function gather(ctx: CliContext): Promise<DoctorFacts> {
  const base = { cliVersion: PLATFORM_VERSION, now: new Date() };
  // Never send a request with certificate checks off (ADR-M36 §2.3).
  if (ctx.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') return { ...base, tlsVerificationOff: true };
  const { fact, login } = await readLogin(ctx);
  const facts: DoctorFacts = { ...base, tlsVerificationOff: false, login: fact };
  if (!login) return facts;
  const fetchFn = apiIo(ctx).fetch;
  const live = await probeHealth(fetchFn, login.apiUrl, 'live');
  if (!live.ok) return { ...facts, live };
  const ready = await probeHealth(fetchFn, login.apiUrl, 'ready');
  const client = clientFor(ctx, login);
  const me = await answer(() => client.get('/v1/me', meSchema));
  if (!me.ok || me.value.token_id === null) return { ...facts, live, ready, me };
  const tokenId = me.value.token_id;
  const tokenExpiresAt = await answer(() => tokenEnd(client, tokenId));
  return { ...facts, live, ready, me, tokenExpiresAt };
}

/** The login a user command would use (`session.ts` `resolveLogin`), as a fact, never thrown. */
async function readLogin(ctx: CliContext): Promise<{ fact: LoginFact; login?: SavedLogin }> {
  const envUrl = ctx.env.SDLC_API_URL;
  const envToken = ctx.env.SDLC_API_TOKEN;
  if (envUrl !== undefined || envToken !== undefined) {
    if (envUrl === undefined || envToken === undefined) {
      return { fact: { source: 'env', problem: 'env_incomplete' } };
    }
    const url = normaliseApiUrl(envUrl);
    if (!('url' in url)) return { fact: { source: 'env', problem: 'url', url: url.problem } };
    if (!isApiToken(envToken)) return { fact: { source: 'env', problem: 'env_token_invalid' } };
    return {
      fact: { source: 'env', apiUrl: url.url },
      login: { apiUrl: url.url, token: envToken },
    };
  }
  try {
    const saved = await readSavedLogin(ctx.env);
    if (!saved) return { fact: { source: 'none' } };
    return { fact: { source: 'saved', apiUrl: saved.apiUrl }, login: saved };
  } catch (error) {
    if (!(error instanceof CredentialsError)) throw error;
    return {
      fact: {
        source: 'saved',
        problem: 'credentials',
        credentials: error.problem,
        path: error.path,
      },
    };
  }
}

async function tokenEnd(client: ApiClient, tokenId: string): Promise<string | null> {
  const list = await client.get('/v1/me/tokens', tokenListSchema);
  return list.items.find((item) => item.id === tokenId)?.expires_at ?? null;
}

async function answer<T>(call: () => Promise<T>): Promise<Answer<T>> {
  try {
    return { ok: true, value: await call() };
  } catch (error) {
    if (!(error instanceof ApiCallError)) throw error;
    return {
      ok: false,
      failure: error.kind === 'too_large' ? 'malformed' : error.kind,
      ...(error.status === undefined ? {} : { status: error.status }),
    };
  }
}

const STATUS_KEYS = {
  ok: 'cli.doctor.status.ok',
  warning: 'cli.doctor.status.warning',
  failed: 'cli.doctor.status.failed',
  skipped: 'cli.doctor.status.skipped',
} as const;

const render = (text: Text): string => t(text.key, text.params);

function print(ctx: CliContext, results: readonly CheckResult[]): void {
  say(ctx, 'cli.doctor.header', { version: PLATFORM_VERSION });
  for (const r of results) {
    say(ctx, 'cli.doctor.line', {
      status: t(STATUS_KEYS[r.status]),
      id: r.id,
      text: render(r.text),
    });
    if (r.fix) say(ctx, 'cli.doctor.fix_line', { text: render(r.fix) });
  }
  const count = (status: CheckResult['status']) =>
    results.filter((r) => r.status === status).length;
  say(ctx, 'cli.doctor.summary', {
    ok: count('ok'),
    warning: count('warning'),
    failed: count('failed'),
    skipped: count('skipped'),
  });
}

function jsonView(results: readonly CheckResult[]) {
  return {
    cli_version: PLATFORM_VERSION,
    checks: results.map((r) => ({
      id: r.id,
      status: r.status,
      message: render(r.text),
      ...(r.fix ? { fix: render(r.fix) } : {}),
    })),
  };
}
