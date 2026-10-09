// `pnpm github-app:create --out <file> [--org <org>] [--name <name>] [--force]` (D-08 V03): creates
// the platform's GitHub App from `manifest.json` with GitHub's manifest flow, and saves its private
// key to a file outside the repository (mode 600). Run by a person in their own terminal: the key is
// never printed, and the client secret and webhook secret GitHub returns are dropped (QUESTIONS #351).
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { parseArgs } from 'node:util';

import { t, type MessageKey, type MessageParams } from '@sdlc/messages';

import {
  ConversionError,
  convertManifestCode,
  type AppCredentials,
  type ConversionErrorCode,
} from './convert.js';
import { KeyFileError, keyFileRefusal, writeKeyFile, type KeyFileRefusal } from './key-file.js';
import {
  buildManifest,
  isAppName,
  isOrgLogin,
  loadManifest,
  newAppUrl,
  type BaseManifest,
} from './manifest.js';
import { codeFromPaste, formPage, startCallbackServer } from './server.js';

export const EXIT = { ok: 0, failed: 1, usage: 2 } as const;

/** The callback must come within this time (GitHub's code itself lives one hour). */
export const CALLBACK_TIMEOUT_MS = 15 * 60 * 1000;

export interface RunDeps {
  readonly repoRoot: string;
  readonly manifestFile: string;
  readonly githubUrl: string;
  readonly apiUrl: string;
  readonly fetchImpl?: typeof fetch;
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
  readonly timeoutMs?: number;
  /**
   * The fallback prompt (QUESTIONS #350): resolves with what the person pasted, undefined when
   * there is no terminal, and rejects when the person cancels (Ctrl-C). Ends when `signal` aborts.
   */
  readonly readPasted?: (signal: AbortSignal) => Promise<string | undefined>;
  /** Tests only: told the local page's address once the server listens. */
  readonly onListening?: (url: string) => void;
}

type Outcome = { kind: 'code'; code: string } | { kind: 'timeout' } | { kind: 'cancelled' };

const CONVERSION_FAILED: Record<ConversionErrorCode, MessageKey> = {
  unreachable: 'github_app.conversion.unreachable',
  refused: 'github_app.conversion.refused',
  bad_response: 'github_app.conversion.bad_response',
};

const KEY_REFUSAL: Record<KeyFileRefusal, MessageKey> = {
  in_repo: 'github_app.refused.in_repo',
  no_folder: 'github_app.refused.no_folder',
  exists: 'github_app.refused.exists',
  not_a_file: 'github_app.refused.not_a_file',
};

export async function runCreate(argv: readonly string[], deps: RunDeps): Promise<number> {
  const say = (key: MessageKey, params?: MessageParams): void => deps.out(t(key, params));
  const fail = (key: MessageKey, params?: MessageParams): void => deps.err(t(key, params));

  let values: { out?: string; org?: string; name?: string; force?: boolean };
  try {
    ({ values } = parseArgs({
      args: [...argv],
      options: {
        out: { type: 'string' },
        org: { type: 'string' },
        name: { type: 'string' },
        force: { type: 'boolean', default: false },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch {
    fail('github_app.usage');
    return EXIT.usage;
  }
  if (!values.out) {
    fail('github_app.usage');
    return EXIT.usage;
  }
  if (values.org !== undefined && !isOrgLogin(values.org)) {
    fail('github_app.refused.org');
    return EXIT.usage;
  }
  const name = values.name ?? `sdlc-${randomBytes(4).toString('hex')}`;
  if (!isAppName(name)) {
    fail('github_app.refused.name');
    return EXIT.usage;
  }
  const force = values.force === true;
  const keyFile = path.resolve(values.out);
  const refusal = keyFileRefusal(keyFile, deps.repoRoot, force);
  if (refusal) {
    fail(KEY_REFUSAL[refusal], { path: keyFile });
    return EXIT.failed;
  }

  let base: BaseManifest;
  try {
    base = loadManifest(deps.manifestFile);
  } catch {
    fail('github_app.manifest_invalid', { path: deps.manifestFile });
    return EXIT.failed;
  }
  const state = randomBytes(32).toString('base64url');
  const action = newAppUrl(deps.githubUrl, values.org, state);
  const server = await startCallbackServer({
    state,
    formPage: (redirectUrl) =>
      formPage(action, JSON.stringify(buildManifest(base, name, redirectUrl))),
  });
  deps.onListening?.(server.url);
  say('github_app.open', { url: server.url, name });

  const stop = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const races: Promise<Outcome>[] = [
    server.code.then((code) => ({ kind: 'code', code })),
    new Promise<Outcome>((resolve) => {
      timer = setTimeout(() => resolve({ kind: 'timeout' }), deps.timeoutMs ?? CALLBACK_TIMEOUT_MS);
    }),
  ];
  if (deps.readPasted) races.push(pasteLoop(deps.readPasted, state, stop.signal, fail));
  let outcome: Outcome;
  try {
    outcome = await Promise.race(races);
  } finally {
    clearTimeout(timer);
    stop.abort();
    await server.close();
  }
  if (outcome.kind === 'timeout') {
    fail('github_app.timeout');
    return EXIT.failed;
  }
  if (outcome.kind === 'cancelled') {
    fail('github_app.cancelled');
    return EXIT.failed;
  }

  let app: AppCredentials;
  try {
    app = await convertManifestCode(deps.apiUrl, outcome.code, deps.fetchImpl);
  } catch (error) {
    if (!(error instanceof ConversionError)) throw error;
    fail(CONVERSION_FAILED[error.code], { status: error.status ?? 0 });
    return EXIT.failed;
  }
  try {
    writeKeyFile(keyFile, app.pem, deps.repoRoot, force);
  } catch (error) {
    // The App exists on GitHub now: say how to finish by hand, never print the key.
    if (error instanceof KeyFileError) fail(KEY_REFUSAL[error.refusal], { path: keyFile });
    fail('github_app.write_failed', { id: app.id, slug: app.slug });
    return EXIT.failed;
  }
  say('github_app.created', {
    id: app.id,
    client_id: app.clientId,
    path: keyFile,
    install_url: `${deps.githubUrl}/apps/${app.slug}/installations/new`,
  });
  return EXIT.ok;
}

/** Asks for a pasted address until one is valid; resolves only with a code or a cancel. */
async function pasteLoop(
  readPasted: (signal: AbortSignal) => Promise<string | undefined>,
  state: string,
  signal: AbortSignal,
  fail: (key: MessageKey) => void,
): Promise<Outcome> {
  for (;;) {
    let input: string | undefined;
    try {
      input = await readPasted(signal);
    } catch {
      if (signal.aborted) return new Promise<Outcome>(() => undefined);
      return { kind: 'cancelled' };
    }
    // No terminal (or the prompt was ended): wait for the browser's callback only.
    if (input === undefined || signal.aborted) return new Promise<Outcome>(() => undefined);
    const code = codeFromPaste(input, state);
    if (code) return { kind: 'code', code };
    fail('github_app.paste_refused');
  }
}
