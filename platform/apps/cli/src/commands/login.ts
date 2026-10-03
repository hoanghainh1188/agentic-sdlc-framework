// `sdlc login`, `sdlc logout`, `sdlc whoami` (D-08 B04 AC1, design/ADR-M36 §2.1–§2.2).
// The token is read from a hidden prompt or from standard input, never from an argument, and it
// is checked with `GET /v1/me` before it is saved. It is never printed.
import { t } from '@sdlc/messages';

import { meSchema, type Me } from '../api/schemas.js';
import {
  apiIo,
  assertTlsVerified,
  checkedUrl,
  clientFor,
  CommandExit,
  guarded,
  parseCommand,
  withApi,
} from '../api/session.js';
import { EXIT, type CliContext } from '../context.js';
import { isApiToken } from '../credentials/settings.js';
import { deleteSavedLogin, readSavedLogin, writeSavedLogin } from '../credentials/store.js';
import { say, sayError, show, toJson } from '../output.js';

export async function runLogin(args: readonly string[], ctx: CliContext): Promise<number> {
  const parsed = parseCommand(args, {
    'api-url': { type: 'string' },
    'token-stdin': { type: 'boolean', default: false },
  });
  if (!parsed) {
    ctx.stderr(t('cli.login.usage'));
    return EXIT.usage;
  }
  const { values } = parsed;
  const json = values.json === true;
  return guarded(ctx, json, async () => {
    assertTlsVerified(ctx);
    const given = typeof values['api-url'] === 'string' ? values['api-url'] : undefined;
    const known = given ?? (await readSavedLogin(ctx.env))?.apiUrl;
    if (known === undefined) {
      sayError(ctx, 'cli.login.url_required');
      return EXIT.usage;
    }
    const apiUrl = checkedUrl(ctx, known);
    const token = await readToken(ctx, values['token-stdin'] === true);
    const me = await clientFor(ctx, { apiUrl, token }).get('/v1/me', meSchema);
    const path = await writeSavedLogin(ctx.env, { apiUrl, token });
    if (ctx.env.SDLC_API_TOKEN !== undefined) sayError(ctx, 'cli.login.env_overrides');
    if (json) {
      ctx.stdout(toJson({ api_url: apiUrl, credentials_path: path, ...describeMe(me) }));
    } else {
      say(ctx, 'cli.login.done', {
        name: me.user.display_name,
        email: me.user.email,
        tenant: me.tenant_id,
        api_url: apiUrl,
        path,
      });
      printRoles(ctx, me);
    }
    return EXIT.ok;
  });
}

export async function runLogout(args: readonly string[], ctx: CliContext): Promise<number> {
  const parsed = parseCommand(args, {});
  if (!parsed) {
    ctx.stderr(t('cli.logout.usage'));
    return EXIT.usage;
  }
  const json = parsed.values.json === true;
  return guarded(ctx, json, async () => {
    const deleted = await deleteSavedLogin(ctx.env);
    if (json) ctx.stdout(toJson({ deleted, token_revoked: false }));
    else say(ctx, deleted ? 'cli.logout.done' : 'cli.logout.none');
    return EXIT.ok;
  });
}

export async function runWhoami(args: readonly string[], ctx: CliContext): Promise<number> {
  const parsed = parseCommand(args, {});
  if (!parsed) {
    ctx.stderr(t('cli.whoami.usage'));
    return EXIT.usage;
  }
  const json = parsed.values.json === true;
  return withApi(ctx, json, async (client) => {
    const me = await client.get('/v1/me', meSchema);
    if (json) {
      ctx.stdout(toJson(describeMe(me)));
    } else {
      say(ctx, 'cli.whoami.user', {
        name: me.user.display_name,
        email: me.user.email,
        tenant: me.tenant_id,
      });
      printRoles(ctx, me);
    }
    return EXIT.ok;
  });
}

async function readToken(ctx: CliContext, fromStdin: boolean): Promise<string> {
  const io = apiIo(ctx);
  let token: string;
  if (fromStdin) {
    if (io.stdinIsTTY) {
      // Reading a terminal without raw mode would show the token as it is typed.
      sayError(ctx, 'cli.login.stdin_is_terminal');
      throw new CommandExit(EXIT.usage);
    }
    token = (await io.readStdin()).trim();
  } else if (io.stdinIsTTY) {
    token = (await io.readHiddenLine(t('cli.login.prompt'))).trim();
  } else {
    sayError(ctx, 'cli.login.no_terminal');
    throw new CommandExit(EXIT.usage);
  }
  if (!isApiToken(token)) {
    // The input is never echoed back: it may be a secret pasted in the wrong place.
    sayError(ctx, 'cli.login.token_invalid');
    throw new CommandExit(EXIT.usage);
  }
  return token;
}

/** The `/v1/me` answer without the token ID: what a person needs to know who they are. */
function describeMe(me: Me): Record<string, unknown> {
  return { user: me.user, tenant_id: me.tenant_id, roles: me.roles };
}

function printRoles(ctx: CliContext, me: Me): void {
  if (me.roles.length === 0) {
    say(ctx, 'cli.whoami.no_roles');
    return;
  }
  for (const binding of me.roles) {
    say(ctx, 'cli.whoami.role', { project: show(binding.project.slug), role: binding.role });
  }
}
