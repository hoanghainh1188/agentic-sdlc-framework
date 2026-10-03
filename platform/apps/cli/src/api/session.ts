// Where a user command gets its API address and token (design/ADR-M36 §2.1–§2.3):
// SDLC_API_URL and SDLC_API_TOKEN (for CI, read once) or the saved login of `sdlc login`.
import { parseArgs, type ParseArgsConfig } from 'node:util';

import type { MessageKey } from '@sdlc/messages';

import { EXIT, processApiIo, type ApiIo, type CliContext } from '../context.js';
import {
  CredentialsError,
  readSavedLogin,
  type CredentialsProblem,
  type SavedLogin,
} from '../credentials/store.js';
import { isApiToken, normaliseApiUrl, type UrlProblem } from '../credentials/settings.js';
import { InputAbortedError } from '../credentials/prompt.js';
import { sayError } from '../output.js';
import { ApiCallError, ApiClient } from './client.js';
import { reportApiFailure } from './errors.js';

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

export type Values = Record<string, string | boolean | undefined>;

/** Thrown inside a command to stop with an exit code after printing its own message. */
export class CommandExit extends Error {
  constructor(readonly code: number) {
    super(`exit_${code}`);
  }
}

export function apiIo(ctx: CliContext): ApiIo {
  return ctx.api ?? processApiIo();
}

/**
 * Parses options and exactly `positionals` positional arguments. Every command takes `--json`.
 * Undefined: print the usage.
 */
export function parseCommand(
  args: readonly string[],
  options: NonNullable<ParseArgsConfig['options']>,
  positionals = 0,
): { values: Values; positionals: string[] } | undefined {
  try {
    const parsed = parseArgs({
      args: [...args],
      options: { ...options, json: { type: 'boolean', default: false } },
      strict: true,
      allowPositionals: positionals > 0,
    });
    if (parsed.positionals.length !== positionals) return undefined;
    return { values: parsed.values, positionals: parsed.positionals };
  } catch {
    return undefined;
  }
}

/** Refuses a process that turned TLS verification off (ADR-M36 §2.3). */
export function assertTlsVerified(ctx: CliContext): void {
  if (ctx.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') {
    sayError(ctx, 'cli.tls_disabled');
    throw new CommandExit(EXIT.usage);
  }
}

/** The API address and token: the environment first (CI), then the saved login. */
export async function resolveLogin(ctx: CliContext): Promise<SavedLogin> {
  const envUrl = ctx.env.SDLC_API_URL;
  const envToken = ctx.env.SDLC_API_TOKEN;
  if (envUrl !== undefined || envToken !== undefined) {
    if (envUrl === undefined || envToken === undefined) {
      sayError(ctx, 'cli.env.incomplete');
      throw new CommandExit(EXIT.usage);
    }
    const url = checkedUrl(ctx, envUrl);
    if (!isApiToken(envToken)) {
      sayError(ctx, 'cli.env.token_invalid');
      throw new CommandExit(EXIT.usage);
    }
    return { apiUrl: url, token: envToken };
  }
  const saved = await readSavedLogin(ctx.env);
  if (!saved) {
    sayError(ctx, 'cli.not_logged_in');
    throw new CommandExit(EXIT.usage);
  }
  return saved;
}

/** Normalises an API address, or prints why it is refused and stops (exit 2). */
export function checkedUrl(ctx: CliContext, value: string): string {
  const result = normaliseApiUrl(value);
  if ('url' in result) return result.url;
  sayError(ctx, URL_PROBLEM_KEYS[result.problem]);
  throw new CommandExit(EXIT.usage);
}

export function clientFor(ctx: CliContext, login: SavedLogin): ApiClient {
  return new ApiClient({ apiUrl: login.apiUrl, token: login.token, fetch: apiIo(ctx).fetch });
}

/**
 * Runs a user command: TLS check, login, then `body`. Turns the known failures into their
 * message and exit code; anything else is rethrown (`cli.failed`, exit 3).
 */
export async function withApi(
  ctx: CliContext,
  json: boolean,
  body: (client: ApiClient) => Promise<number>,
): Promise<number> {
  return guarded(ctx, json, async () => {
    assertTlsVerified(ctx);
    return body(clientFor(ctx, await resolveLogin(ctx)));
  });
}

/** Turns the known failures of a user command into their message and exit code. */
export async function guarded(
  ctx: CliContext,
  json: boolean,
  body: () => Promise<number>,
): Promise<number> {
  try {
    return await body();
  } catch (error) {
    if (error instanceof CommandExit) return error.code;
    if (error instanceof ApiCallError) return reportApiFailure(ctx, error, json);
    if (error instanceof CredentialsError) {
      sayError(ctx, CREDENTIALS_PROBLEM_KEYS[error.problem], { path: error.path });
      return EXIT.usage;
    }
    if (error instanceof InputAbortedError) {
      sayError(ctx, 'cli.login.aborted');
      return EXIT.usage;
    }
    throw error;
  }
}

/** Path segment: always encoded; `.`, `..` and empty never pass (the URL would collapse them). */
export function segment(value: string): string {
  if (value === '' || value === '.' || value === '..') throw new Error('invalid_path_segment');
  return encodeURIComponent(value);
}
