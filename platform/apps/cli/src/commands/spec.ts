// `sdlc spec link|list` over the API (D-08 B08 AC1, D-02 FR-02; ADR-M39 §2.2, handbook Ch.19
// §19.8e). The platform reads the file from the Git host and keeps its SHA-256 only; the content
// stays in the repository. The spec is the file on the default branch: `--commit` is optional and
// must hold the same content as the head (409 `spec_not_on_default_branch`). Who may link:
// project config `access.spec_link_roles` (default Person A and PM / BrSE).
import { t } from '@sdlc/messages';

import { specListSchema } from '../api/schemas.js';
import { parseCommand, segment, withApi } from '../api/session.js';
import { EXIT, type CliContext } from '../context.js';
import { say, toJson } from '../output.js';
import { intentRef } from './intent.js';
import { linkSpec, sayLinked, specLinkBody, structureParams } from './spec-link.js';

export async function runSpec(args: readonly string[], ctx: CliContext): Promise<number> {
  const [command, ...rest] = args;
  if (command === 'link') return link(rest, ctx);
  if (command === 'list') return list(rest, ctx);
  return usage(ctx);
}

async function link(args: readonly string[], ctx: CliContext): Promise<number> {
  const parsed = parseCommand(
    args,
    { path: { type: 'string' }, commit: { type: 'string' }, tool: { type: 'string' } },
    1,
  );
  const ref = parsed ? intentRef(parsed.positionals[0] ?? '') : undefined;
  const values = parsed?.values;
  const body = values
    ? specLinkBody({ path: values.path, commit: values.commit, tool: values.tool })
    : undefined;
  if (!values || ref === undefined || body === undefined) return usage(ctx);
  const json = values.json === true;
  return withApi(ctx, json, async (client) => {
    const spec = await linkSpec(client, ref, body);
    if (json) ctx.stdout(toJson(spec));
    else sayLinked(ctx, spec);
    return EXIT.ok;
  });
}

async function list(args: readonly string[], ctx: CliContext): Promise<number> {
  const parsed = parseCommand(args, {}, 1);
  const ref = parsed ? intentRef(parsed.positionals[0] ?? '') : undefined;
  if (!parsed || ref === undefined) return usage(ctx);
  const json = parsed.values.json === true;
  return withApi(ctx, json, async (client) => {
    const page = await client.get(`/v1/intents/${segment(ref)}/specs`, specListSchema);
    if (json) {
      ctx.stdout(toJson(page));
      return EXIT.ok;
    }
    if (page.items.length === 0) say(ctx, 'cli.spec.none', { intent: page.intent });
    for (const spec of page.items) {
      say(ctx, 'cli.spec.row', {
        version: spec.version,
        path: spec.path,
        commit: spec.commit_sha,
        sha256: spec.content_sha256,
        ...structureParams(spec),
      });
    }
    return EXIT.ok;
  });
}

function usage(ctx: CliContext): number {
  ctx.stderr(t('cli.spec.usage'));
  return EXIT.usage;
}
