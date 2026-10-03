// `sdlc token create|list|revoke`: the caller's own personal API tokens through the API (task B13
// AC5, ADR-M37 §2.8). A new token is printed once, to stdout; it is never logged and never put in
// an error. `sdlc admin token …` does the same for another user (tenant admins).
import { t } from '@sdlc/messages';

import type { ApiClient } from '../api/client.js';
import {
  issuedTokenSchema,
  tokenListSchema,
  tokenSchema,
  type IssuedTokenView,
  type TokenView,
} from '../api/schemas.js';
import { parseCommand, segment, withApi } from '../api/session.js';
import { EXIT, type CliContext } from '../context.js';
import { say, show, toJson } from '../output.js';

const DAYS = /^[1-9][0-9]{0,2}$/;

export async function runToken(args: readonly string[], ctx: CliContext): Promise<number> {
  const [command, ...rest] = args;
  const options =
    command === 'create'
      ? { name: { type: 'string' }, days: { type: 'string' } }
      : command === 'revoke'
        ? { id: { type: 'string' } }
        : {};
  const parsed =
    command === 'create' || command === 'list' || command === 'revoke'
      ? parseCommand(rest, options as Parameters<typeof parseCommand>[1])
      : undefined;
  const values = parsed?.values;
  if (
    !values ||
    (command === 'create' && (typeof values.name !== 'string' || !daysOk(values.days))) ||
    (command === 'revoke' && typeof values.id !== 'string')
  ) {
    ctx.stderr(t('cli.token.usage'));
    return EXIT.usage;
  }
  const json = values.json === true;
  return withApi(ctx, json, async (client) => {
    if (command === 'create') {
      const issued = await issueToken(client, '/v1/me/tokens', String(values.name), values.days);
      printIssued(ctx, issued, json);
    } else if (command === 'list') {
      printList(ctx, await client.get('/v1/me/tokens', tokenListSchema), json);
    } else {
      const revoked = await client.delete(
        `/v1/me/tokens/${segment(String(values.id))}`,
        tokenSchema,
      );
      printRevoked(ctx, revoked, json);
    }
    return EXIT.ok;
  });
}

export function daysOk(value: unknown): boolean {
  return value === undefined || (typeof value === 'string' && DAYS.test(value));
}

export function issueToken(
  client: ApiClient,
  path: string,
  name: string,
  days: unknown,
): Promise<IssuedTokenView> {
  return client.post(path, issuedTokenSchema, {
    name,
    ...(typeof days === 'string' ? { days: Number(days) } : {}),
  });
}

/** Prints a new token once. For someone else, says that they must replace it (QUESTIONS #152). */
export function printIssued(ctx: CliContext, issued: IssuedTokenView, json: boolean): void {
  if (json) {
    ctx.stdout(toJson(issued));
    return;
  }
  say(ctx, 'cli.token.created', {
    id: issued.id,
    name: issued.name,
    user_id: issued.user_id,
    expires_at: issued.expires_at,
  });
  ctx.stdout(issued.token);
  say(ctx, 'cli.admin.token.shown_once');
  if (issued.for_other_user) say(ctx, 'cli.token.for_other_user');
}

export function printList(ctx: CliContext, list: { items: readonly TokenView[] }, json: boolean) {
  if (json) {
    ctx.stdout(toJson(list));
    return;
  }
  if (list.items.length === 0) say(ctx, 'cli.admin.token.none');
  for (const token of list.items) {
    say(ctx, 'cli.admin.token.line', {
      id: token.id,
      name: token.name,
      expires_at: token.expires_at,
      revoked_at: show(token.revoked_at),
      last_used_at: show(token.last_used_at),
    });
  }
}

export function printRevoked(ctx: CliContext, token: TokenView, json: boolean): void {
  if (json) ctx.stdout(toJson(token));
  else say(ctx, 'cli.admin.token.revoked', { id: token.id });
}
