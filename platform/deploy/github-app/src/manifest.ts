// The GitHub App manifest (D-08 V03): `manifest.json` next to this folder is the one source of the
// App's permissions. It must equal the README's permission table (platform/deploy/README.md,
// "The GitHub App's settings"); a static test compares them row by row.
// GitHub's manifest flow: https://docs.github.com/apps/sharing-github-apps/registering-a-github-app-from-a-manifest
import fs from 'node:fs';

export type PermissionLevel = 'read' | 'write';

/**
 * The fields of `manifest.json`. `name`, `redirect_url` and `callback_urls` (the dashboard's
 * sign-in callbacks, U05) are added at run time.
 */
export interface BaseManifest {
  readonly url: string;
  readonly description: string;
  readonly public: false;
  readonly hook_attributes: { readonly url: string; readonly active: false };
  readonly default_events: readonly [];
  readonly default_permissions: Readonly<Record<string, PermissionLevel>>;
  readonly request_oauth_on_install: false;
  readonly setup_on_update: false;
}

export interface Manifest extends BaseManifest {
  readonly name: string;
  readonly redirect_url: string;
  readonly callback_urls: readonly string[];
}

/** The path of the api's sign-in callback (U05, ADR-M73 §2.2). */
export const SIGN_IN_CALLBACK_PATH = '/v1/auth/github/callback';

/** The default callback: the dashboard on a developer machine (`SDLC_API_PUBLIC_ORIGIN`). */
export const DEFAULT_CALLBACK_URL = `http://localhost:8090${SIGN_IN_CALLBACK_PATH}`;

/** At most this many callback URLs (GitHub allows 10). */
export const MAX_CALLBACK_URLS = 10;

/**
 * A sign-in callback URL: the api's callback path on an `https://` origin, or plain `http://` on
 * `localhost` only (the same rule as `SDLC_API_PUBLIC_ORIGIN`, ADR-M73 §2.3).
 */
export function isCallbackUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return (
    (url.protocol === 'https:' || (url.protocol === 'http:' && url.hostname === 'localhost')) &&
    url.username === '' &&
    url.password === '' &&
    url.pathname === SIGN_IN_CALLBACK_PATH &&
    url.search === '' &&
    url.hash === '' &&
    url.href === value
  );
}

export class ManifestError extends Error {}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Reads `manifest.json` and refuses anything that would loosen it (webhook on, public, events). */
export function parseManifest(text: string): BaseManifest {
  const raw: unknown = JSON.parse(text);
  if (!isRecord(raw)) throw new ManifestError('not_an_object');
  const hook = raw.hook_attributes;
  const perms = raw.default_permissions;
  if (typeof raw.url !== 'string' || !raw.url.startsWith('https://'))
    throw new ManifestError('url');
  if (typeof raw.description !== 'string') throw new ManifestError('description');
  if (raw.public !== false) throw new ManifestError('public');
  if (!isRecord(hook) || hook.active !== false || typeof hook.url !== 'string')
    throw new ManifestError('hook_attributes');
  if (!Array.isArray(raw.default_events) || raw.default_events.length !== 0)
    throw new ManifestError('default_events');
  if (
    !isRecord(perms) ||
    Object.values(perms).some((level) => level !== 'read' && level !== 'write')
  )
    throw new ManifestError('default_permissions');
  if (raw.request_oauth_on_install !== false || raw.setup_on_update !== false)
    throw new ManifestError('oauth');
  if ('name' in raw || 'redirect_url' in raw || 'callback_urls' in raw || 'setup_url' in raw)
    throw new ManifestError('runtime_fields');
  return raw as unknown as BaseManifest;
}

export function loadManifest(file: string): BaseManifest {
  return parseManifest(fs.readFileSync(file, 'utf8'));
}

export function buildManifest(
  base: BaseManifest,
  name: string,
  redirectUrl: string,
  callbackUrls: readonly string[],
): Manifest {
  return { ...base, name, redirect_url: redirectUrl, callback_urls: [...callbackUrls] };
}

/** An organization login: letters, digits and single hyphens, at most 39 characters. */
export const isOrgLogin = (org: string): boolean =>
  /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/.test(org);

/** A GitHub App name: at most 34 characters (GitHub's limit), a safe set of characters. */
export const isAppName = (name: string): boolean => /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,33}$/.test(name);

/** The page on GitHub that takes the manifest: the user's account, or an organization's. */
export function newAppUrl(githubUrl: string, org: string | undefined, state: string): string {
  const base = org
    ? `${githubUrl}/organizations/${encodeURIComponent(org)}/settings/apps/new`
    : `${githubUrl}/settings/apps/new`;
  return `${base}?state=${encodeURIComponent(state)}`;
}
