// `sdlc spec link|list` over the API (D-08 B08 AC1, D-02 FR-02; ADR-M39 §2.2, handbook Ch.19
// §19.8e). The platform reads the file from the Git host and keeps its SHA-256 only; the content
// stays in the repository. The spec is the file on the default branch: `--commit` is optional and
// must hold the same content as the head (409 `spec_not_on_default_branch`). Who may link:
// project config `access.spec_link_roles` (default Person A and PM / BrSE).
import { SPEC_SOURCE_TOOLS } from '@sdlc/core';
import { t } from '@sdlc/messages';

import { linkedSpecSchema, specListSchema } from '../api/schemas.js';
import { parseCommand, segment, withApi } from '../api/session.js';
import { EXIT, type CliContext } from '../context.js';
import { say, toJson } from '../output.js';
import { intentRef } from './intent.js';

const COMMIT = /^[0-9a-f]{40}$/;

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
  const path = values?.path;
  const commit = values?.commit;
  const tool = values?.tool;
  if (
    !values ||
    ref === undefined ||
    typeof path !== 'string' ||
    path.length === 0 ||
    path.length > 1024 ||
    (typeof commit === 'string' && !COMMIT.test(commit)) ||
    (typeof tool === 'string' && !(SPEC_SOURCE_TOOLS as readonly string[]).includes(tool))
  ) {
    return usage(ctx);
  }
  const json = values.json === true;
  return withApi(ctx, json, async (client) => {
    const spec = await client.post(`/v1/intents/${segment(ref)}/specs`, linkedSpecSchema, {
      path,
      ...(typeof commit === 'string' ? { commit_sha: commit } : {}),
      ...(typeof tool === 'string' ? { source_tool: tool } : {}),
    });
    if (json) ctx.stdout(toJson(spec));
    else {
      say(ctx, 'cli.spec.linked', {
        intent: spec.intent,
        version: spec.version,
        path: spec.path,
        commit: spec.commit_sha,
        sha256: spec.content_sha256,
        ...structureParams(spec),
      });
      if (!((spec.acceptance_criteria ?? 0) > 0)) {
        say(ctx, 'cli.spec.no_criteria', { intent: spec.intent });
      }
    }
    return EXIT.ok;
  });
}

/** S01 (ADR-M61): the tool, the structure rule and the count; `-` when not known. */
function structureParams(spec: {
  readonly source_tool: string | null;
  readonly structure: string | null;
  readonly acceptance_criteria: number | null;
}): { tool: string; structure: string; criteria: string } {
  return {
    tool: spec.source_tool ?? '-',
    structure: spec.structure ?? '-',
    criteria: spec.acceptance_criteria === null ? '-' : String(spec.acceptance_criteria),
  };
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
