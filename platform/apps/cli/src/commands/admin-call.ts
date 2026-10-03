// Shared parts of the `sdlc admin …` commands over the API (task B13, ADR-M37 §2.7).
import type { ParseArgsConfig } from 'node:util';

import type { ApiClient } from '../api/client.js';
import { adminUserListSchema } from '../api/schemas.js';
import { CommandExit, type Values } from '../api/session.js';
import { EXIT, type CliContext } from '../context.js';
import { sayError, toJson } from '../output.js';

export interface AdminApiCommand {
  readonly options: NonNullable<ParseArgsConfig['options']>;
  /** Options that must be given. */
  readonly required: readonly string[];
  readonly run: (call: AdminCall) => Promise<number>;
}

export interface AdminCall {
  readonly ctx: CliContext;
  readonly client: ApiClient;
  readonly values: Values;
  readonly json: boolean;
}

/** A string option that `required` already checked. */
export function str(values: Values, name: string): string {
  return String(values[name]);
}

/** An optional string option. */
export function opt(values: Values, name: string): string | undefined {
  const value = values[name];
  return typeof value === 'string' ? value : undefined;
}

/** Prints `body` as JSON, or runs `human`. Returns exit code 0. */
export function output(call: AdminCall, body: unknown, human: () => void): number {
  if (call.json) call.ctx.stdout(toJson(body));
  else human();
  return EXIT.ok;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * The user ID of `--user`: an ID as is, or an e-mail address looked up in the tenant's user list.
 * The address never goes into a URL.
 */
export async function resolveUser(call: AdminCall, value: string): Promise<string> {
  if (UUID.test(value)) return value;
  const users = await call.client.get('/v1/admin/users', adminUserListSchema);
  const wanted = value.trim().toLowerCase();
  const found = users.items.find((user) => user.email.toLowerCase() === wanted);
  if (!found) {
    sayError(call.ctx, 'cli.admin.api.user_unknown');
    throw new CommandExit(EXIT.failed);
  }
  return found.id;
}
