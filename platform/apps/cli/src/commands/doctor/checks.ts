// The checks of `adlc doctor` (task V07 AC2): pure functions from the facts `doctor.ts` gathered
// to one result per check, each with a catalog text and, when it is not ok, the fix to run. No
// check ever sees the token: the facts hold the API address, the API's answers and the dates only.
import type { Me } from '@sdlc/api-schemas';
import type { MessageKey, MessageParams } from '@sdlc/messages';

import type { CredentialsProblem } from '../../credentials/store.js';
import type { UrlProblem } from '../../credentials/settings.js';

export type CheckStatus = 'ok' | 'warning' | 'failed' | 'skipped';

export const CHECK_IDS = [
  'cli.tls_verification',
  'cli.credentials_file',
  'cli.api_url',
  'cli.api_reachable',
  'cli.api_ready',
  'cli.login',
  'cli.token_expiry',
  'cli.roles',
  'cli.version',
] as const;
export type CheckId = (typeof CHECK_IDS)[number];

export interface Text {
  readonly key: MessageKey;
  readonly params?: MessageParams;
}

export interface CheckResult {
  readonly id: CheckId;
  readonly status: CheckStatus;
  readonly text: Text;
  /** What to do; set for `warning` and `failed`. */
  readonly fix?: Text;
}

/** Why a request to the API did not give an answer the check can use. */
export type ProbeFailure =
  'tls' | 'refused' | 'dns' | 'timeout' | 'network' | 'redirect' | 'http' | 'malformed';

export type Probe =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly failure: ProbeFailure;
      readonly status?: number;
      /** Node's TLS error code (for example `UNABLE_TO_VERIFY_LEAF_SIGNATURE`); never a message. */
      readonly tlsCode?: string;
    };

export type LoginFact =
  | { readonly source: 'none' }
  | { readonly source: 'env' | 'saved'; readonly apiUrl: string }
  | { readonly source: 'env'; readonly problem: 'env_incomplete' | 'env_token_invalid' }
  | { readonly source: 'env'; readonly problem: 'url'; readonly url: UrlProblem }
  | {
      readonly source: 'saved';
      readonly problem: 'credentials';
      readonly credentials: CredentialsProblem;
      readonly path: string;
    };

export type Answer<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly failure: ProbeFailure; readonly status?: number };

export interface DoctorFacts {
  readonly tlsVerificationOff: boolean;
  readonly login?: LoginFact;
  readonly live?: Probe;
  readonly ready?: Probe;
  readonly me?: Answer<Me>;
  /** `expires_at` of the token of this request; null when the API does not list it. */
  readonly tokenExpiresAt?: Answer<string | null>;
  readonly cliVersion: string;
  readonly now: Date;
}

/** A personal token this close to its end gets a warning (days). */
export const TOKEN_WARNING_DAYS = 14;
const DAY_MS = 86_400_000;

const URL_PROBLEM_KEYS: Readonly<Record<UrlProblem, MessageKey>> = {
  invalid: 'cli.api_url.invalid',
  insecure: 'cli.api_url.insecure',
  credentials: 'cli.api_url.credentials',
  query: 'cli.api_url.query',
};

const CREDENTIALS_PROBLEM_KEYS: Readonly<Record<CredentialsProblem, MessageKey>> = {
  no_config_dir: 'cli.credentials.no_config_dir',
  unsafe_mode: 'cli.credentials.unsafe_mode',
  not_a_file: 'cli.credentials.not_a_file',
  not_owner: 'cli.credentials.not_owner',
  malformed: 'cli.credentials.malformed',
};

const FAILURE_KEYS: Readonly<Record<ProbeFailure, MessageKey>> = {
  tls: 'cli.doctor.failure.tls',
  refused: 'cli.doctor.failure.refused',
  dns: 'cli.doctor.failure.dns',
  timeout: 'cli.doctor.failure.timeout',
  network: 'cli.doctor.failure.network',
  redirect: 'cli.doctor.failure.redirect',
  http: 'cli.doctor.failure.http',
  malformed: 'cli.doctor.failure.malformed',
};

const ok = (id: CheckId, key: MessageKey, params?: MessageParams): CheckResult => ({
  id,
  status: 'ok',
  text: { key, ...(params ? { params } : {}) },
});
const bad = (id: CheckId, status: 'warning' | 'failed', text: Text, fix: Text): CheckResult => ({
  id,
  status,
  text,
  fix,
});
const skip = (id: CheckId, key: MessageKey): CheckResult => ({
  id,
  status: 'skipped',
  text: { key },
});

function failureText(failure: ProbeFailure, status?: number, tlsCode?: string): Text {
  return {
    key: FAILURE_KEYS[failure],
    params: { status: status ?? 0, code: tlsCode ?? '-' },
  };
}

/** TLS codes that mean "this machine does not know the CA" (V09: a company or throw-away CA). */
const UNKNOWN_CA = new Set([
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
]);

function failureFix(failure: ProbeFailure, tlsCode?: string): Text {
  // V09 (ADR-M67 §2.8): behind the team access proxy, an unknown CA needs NODE_EXTRA_CA_CERTS.
  if (failure === 'tls' && tlsCode !== undefined && UNKNOWN_CA.has(tlsCode))
    return { key: 'cli.doctor.fix.tls_ca' };
  if (failure === 'tls') return { key: 'cli.doctor.fix.tls' };
  if (failure === 'http' || failure === 'malformed') return { key: 'cli.doctor.fix.operator' };
  return { key: 'cli.doctor.fix.unreachable' };
}

/** Every check, in a fixed order; a check whose input is missing is `skipped` with the reason. */
export function evaluate(facts: DoctorFacts): CheckResult[] {
  const out: CheckResult[] = [];
  if (facts.tlsVerificationOff) {
    out.push(
      bad(
        'cli.tls_verification',
        'failed',
        { key: 'cli.doctor.tls_off' },
        {
          key: 'cli.doctor.fix.tls_off',
        },
      ),
    );
    for (const id of CHECK_IDS.slice(1)) out.push(skip(id, 'cli.doctor.skipped.tls_off'));
    return out;
  }
  out.push(ok('cli.tls_verification', 'cli.doctor.tls_on'));
  out.push(...loginChecks(facts.login));
  const apiUrl =
    facts.login !== undefined && 'apiUrl' in facts.login ? facts.login.apiUrl : undefined;
  if (apiUrl === undefined) {
    for (const id of CHECK_IDS.slice(3)) out.push(skip(id, 'cli.doctor.skipped.no_login'));
    return out;
  }
  out.push(reachable(apiUrl, facts.live));
  if (facts.live?.ok !== true) {
    for (const id of CHECK_IDS.slice(4)) out.push(skip(id, 'cli.doctor.skipped.unreachable'));
    return out;
  }
  out.push(ready(facts.ready));
  out.push(login(facts.me));
  if (facts.me?.ok !== true) {
    for (const id of CHECK_IDS.slice(6)) out.push(skip(id, 'cli.doctor.skipped.no_me'));
    return out;
  }
  const me = facts.me.value;
  out.push(tokenExpiry(me, facts.tokenExpiresAt, facts.now));
  out.push(roles(me));
  out.push(version(facts.cliVersion, me.platform_version));
  return out;
}

function loginChecks(login: LoginFact | undefined): CheckResult[] {
  if (login === undefined || login.source === 'none') {
    return [
      skip('cli.credentials_file', 'cli.doctor.skipped.no_saved_login'),
      bad(
        'cli.api_url',
        'failed',
        { key: 'cli.doctor.not_logged_in' },
        {
          key: 'cli.doctor.fix.login',
        },
      ),
    ];
  }
  if ('problem' in login) {
    if (login.problem === 'credentials') {
      return [
        bad(
          'cli.credentials_file',
          'failed',
          { key: 'cli.doctor.credentials_bad' },
          { key: CREDENTIALS_PROBLEM_KEYS[login.credentials], params: { path: login.path } },
        ),
        skip('cli.api_url', 'cli.doctor.skipped.no_login'),
      ];
    }
    const fix: Text =
      login.problem === 'url'
        ? { key: URL_PROBLEM_KEYS[login.url] }
        : {
            key:
              login.problem === 'env_incomplete' ? 'cli.env.incomplete' : 'cli.env.token_invalid',
          };
    return [
      skip('cli.credentials_file', 'cli.doctor.skipped.env_login'),
      bad('cli.api_url', 'failed', { key: 'cli.doctor.env_bad' }, fix),
    ];
  }
  const file =
    login.source === 'saved'
      ? ok('cli.credentials_file', 'cli.doctor.credentials_ok')
      : skip('cli.credentials_file', 'cli.doctor.skipped.env_login');
  return [
    file,
    ok(
      'cli.api_url',
      login.source === 'saved' ? 'cli.doctor.api_url_saved' : 'cli.doctor.api_url_env',
      { url: login.apiUrl },
    ),
  ];
}

function reachable(apiUrl: string, live: Probe | undefined): CheckResult {
  if (live === undefined) return skip('cli.api_reachable', 'cli.doctor.skipped.no_login');
  if (!live.ok) {
    return bad(
      'cli.api_reachable',
      'failed',
      failureText(live.failure, live.status, live.tlsCode),
      failureFix(live.failure, live.tlsCode),
    );
  }
  // `http://` is accepted on this machine only (loopback); AC2 asks for TLS.
  if (apiUrl.startsWith('http://')) {
    return bad(
      'cli.api_reachable',
      'warning',
      { key: 'cli.doctor.reachable_plain' },
      {
        key: 'cli.doctor.fix.plain_http',
      },
    );
  }
  return ok('cli.api_reachable', 'cli.doctor.reachable_tls');
}

function ready(probe: Probe | undefined): CheckResult {
  if (probe === undefined) return skip('cli.api_ready', 'cli.doctor.skipped.unreachable');
  if (probe.ok) return ok('cli.api_ready', 'cli.doctor.ready');
  if (probe.failure === 'http' && probe.status === 503) {
    return bad(
      'cli.api_ready',
      'warning',
      { key: 'cli.doctor.not_ready' },
      {
        key: 'cli.doctor.fix.operator',
      },
    );
  }
  return bad(
    'cli.api_ready',
    'warning',
    failureText(probe.failure, probe.status, probe.tlsCode),
    failureFix(probe.failure, probe.tlsCode),
  );
}

function login(me: Answer<Me> | undefined): CheckResult {
  if (me === undefined) return skip('cli.login', 'cli.doctor.skipped.unreachable');
  if (me.ok) return ok('cli.login', 'cli.doctor.login_ok', { name: me.value.user.display_name });
  if (me.failure === 'http' && me.status === 401) {
    return bad(
      'cli.login',
      'failed',
      { key: 'cli.doctor.login_refused' },
      {
        key: 'cli.doctor.fix.login',
      },
    );
  }
  return bad('cli.login', 'failed', failureText(me.failure, me.status), failureFix(me.failure));
}

function tokenExpiry(me: Me, answer: Answer<string | null> | undefined, now: Date): CheckResult {
  if (me.auth === 'session' || me.token_id === null) {
    return skip('cli.token_expiry', 'cli.doctor.skipped.session');
  }
  if (answer === undefined || !answer.ok || answer.value === null) {
    return bad(
      'cli.token_expiry',
      'warning',
      { key: 'cli.doctor.token_unknown' },
      {
        key: 'cli.doctor.fix.token_list',
      },
    );
  }
  const end = new Date(answer.value);
  const days = Math.floor((end.getTime() - now.getTime()) / DAY_MS);
  const params = { date: answer.value.slice(0, 10), days: Math.max(days, 0) };
  if (days <= TOKEN_WARNING_DAYS) {
    return bad(
      'cli.token_expiry',
      'warning',
      { key: 'cli.doctor.token_soon', params },
      {
        key: 'cli.doctor.fix.token_renew',
      },
    );
  }
  return ok('cli.token_expiry', 'cli.doctor.token_ok', params);
}

function roles(me: Me): CheckResult {
  const byProject = new Map<string, string[]>();
  for (const binding of me.roles) {
    const project = binding.project.slug ?? binding.project.id;
    byProject.set(project, [...(byProject.get(project) ?? []), binding.role]);
  }
  const list = [...byProject.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([project, held]) => `${project} (${[...held].sort().join(', ')})`)
    .join('; ');
  const admin = me.tenant_admin === true;
  if (list === '' && !admin) {
    return bad(
      'cli.roles',
      'warning',
      { key: 'cli.doctor.no_roles' },
      {
        key: 'cli.doctor.fix.roles',
      },
    );
  }
  return ok('cli.roles', admin ? 'cli.doctor.roles_admin' : 'cli.doctor.roles', {
    roles: list === '' ? '-' : list,
  });
}

/** A release version; anything else from the server is never put into a suggested command. */
const SEMVER = /^\d{1,4}\.\d{1,5}\.\d{1,6}(?:-[0-9A-Za-z.-]{1,32})?$/;

function version(cli: string, api: string | undefined): CheckResult {
  if (api === undefined || !SEMVER.test(api)) {
    return bad(
      'cli.version',
      'warning',
      { key: 'cli.doctor.version_unknown', params: { cli } },
      {
        key: 'cli.doctor.fix.version_unknown',
      },
    );
  }
  if (api !== cli) {
    return bad(
      'cli.version',
      'warning',
      { key: 'cli.doctor.version_differs', params: { cli, api } },
      { key: 'cli.doctor.fix.version', params: { api } },
    );
  }
  return ok('cli.version', 'cli.doctor.version_same', { cli });
}
