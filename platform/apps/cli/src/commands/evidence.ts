// `sdlc evidence build|list|show|export` over the API (task E02, D-08 E02 AC1–AC4, D-02 FR-40,
// FR-42, FR-43, ADR-M48, handbook Ch.15 §15.10.2, Ch.19 §19.8c). Who: project config
// `access.evidence_build_roles` (build) and `access.evidence_read_roles` (list, show, export);
// tenant admins always; never `viewer` (rule M30).
// `export` checks the file's SHA-256 against the one the platform recorded before it prints or
// saves it, and never overwrites a file: the pack names the approvers, so it is saved readable by
// its owner only (mode 600).
import { createHash } from 'node:crypto';
import fs from 'node:fs';

import { t } from '@sdlc/messages';

import {
  evidenceBuildSchema,
  evidenceFileSchema,
  evidenceListSchema,
  evidenceShowSchema,
  type EvidencePackView,
} from '../api/schemas.js';
import { parseCommand, segment, withApi } from '../api/session.js';
import { EXIT, type CliContext } from '../context.js';
import { clean, say, sayError, show, toJson } from '../output.js';
import { intentRef } from './intent.js';

const VERSION = /^[1-9][0-9]{0,6}$/;

export async function runEvidence(args: readonly string[], ctx: CliContext): Promise<number> {
  const [command, ...rest] = args;
  if (command === 'build') return build(rest, ctx);
  if (command === 'list') return list(rest, ctx);
  if (command === 'show') return showPack(rest, ctx);
  if (command === 'export') return exportPack(rest, ctx);
  return usage(ctx);
}

const base = (ref: string) => `/v1/intents/${segment(ref)}/evidence-packs`;

function printPack(ctx: CliContext, pack: EvidencePackView): void {
  say(ctx, 'cli.evidence.pack', {
    intent: pack.intent,
    version: pack.version,
    built_at: pack.built_at,
    format: pack.disclosure_format,
    items: pack.item_count,
    sealed: show(pack.sealed_at),
  });
  if (pack.release_sha256 !== null) {
    say(ctx, 'cli.evidence.release', { sha256: pack.release_sha256 });
  }
  say(ctx, 'cli.evidence.file', { name: 'manifest.json', sha256: pack.manifest.sha256 });
  say(ctx, 'cli.evidence.file', { name: 'pack.md', sha256: pack.markdown.sha256 });
}

async function build(args: readonly string[], ctx: CliContext): Promise<number> {
  const parsed = parseCommand(args, {}, 1);
  const ref = parsed ? intentRef(parsed.positionals[0] ?? '') : undefined;
  if (!parsed || ref === undefined) return usage(ctx);
  const json = parsed.values.json === true;
  return withApi(ctx, json, async (client) => {
    const body = await client.post(base(ref), evidenceBuildSchema);
    if (json) ctx.stdout(toJson(body));
    else {
      say(ctx, body.created ? 'cli.evidence.built' : 'cli.evidence.unchanged', {
        intent: body.pack.intent,
        version: body.pack.version,
      });
      printPack(ctx, body.pack);
    }
    return EXIT.ok;
  });
}

async function list(args: readonly string[], ctx: CliContext): Promise<number> {
  const parsed = parseCommand(args, {}, 1);
  const ref = parsed ? intentRef(parsed.positionals[0] ?? '') : undefined;
  if (!parsed || ref === undefined) return usage(ctx);
  const json = parsed.values.json === true;
  return withApi(ctx, json, async (client) => {
    const body = await client.get(base(ref), evidenceListSchema);
    if (json) ctx.stdout(toJson(body));
    else if (body.packs.length === 0) say(ctx, 'cli.evidence.none', { intent: body.intent });
    else {
      for (const pack of body.packs) {
        say(ctx, 'cli.evidence.row', {
          version: pack.version,
          built_at: pack.built_at,
          format: pack.disclosure_format,
          items: pack.item_count,
          sealed: show(pack.sealed_at),
          sha256: pack.markdown.sha256,
        });
      }
    }
    return EXIT.ok;
  });
}

/** `--version N`, or the latest version (from the list). */
function versionOption(value: unknown): number | 'latest' | undefined {
  if (value === undefined) return 'latest';
  return typeof value === 'string' && VERSION.test(value) ? Number(value) : undefined;
}

async function showPack(args: readonly string[], ctx: CliContext): Promise<number> {
  const parsed = parseCommand(args, { version: { type: 'string' } }, 1);
  const ref = parsed ? intentRef(parsed.positionals[0] ?? '') : undefined;
  const version = versionOption(parsed?.values.version);
  if (!parsed || ref === undefined || version === undefined) return usage(ctx);
  const json = parsed.values.json === true;
  return withApi(ctx, json, async (client) => {
    const pack =
      version === 'latest'
        ? (await client.get(base(ref), evidenceListSchema)).packs.at(-1)
        : (await client.get(`${base(ref)}/${String(version)}`, evidenceShowSchema)).pack;
    if (!pack) {
      sayError(ctx, 'cli.evidence.none', { intent: ref });
      return EXIT.failed;
    }
    if (json) ctx.stdout(toJson({ pack }));
    else printPack(ctx, pack);
    return EXIT.ok;
  });
}

async function exportPack(args: readonly string[], ctx: CliContext): Promise<number> {
  const parsed = parseCommand(
    args,
    { version: { type: 'string' }, manifest: { type: 'boolean' }, output: { type: 'string' } },
    1,
  );
  const ref = parsed ? intentRef(parsed.positionals[0] ?? '') : undefined;
  const version = versionOption(parsed?.values.version);
  const output = parsed?.values.output;
  if (
    !parsed ||
    ref === undefined ||
    version === undefined ||
    parsed.values.json === true ||
    (output !== undefined && (typeof output !== 'string' || output.length === 0))
  ) {
    return usage(ctx);
  }
  const file = parsed.values.manifest === true ? 'manifest' : 'markdown';
  return withApi(ctx, false, async (client) => {
    let number = version;
    if (number === 'latest') {
      const latest = (await client.get(base(ref), evidenceListSchema)).packs.at(-1);
      if (!latest) {
        sayError(ctx, 'cli.evidence.none', { intent: ref });
        return EXIT.failed;
      }
      number = latest.version;
    }
    const body = await client.get(`${base(ref)}/${String(number)}/${file}`, evidenceFileSchema);
    const bytes = Buffer.from(body.file.content, 'utf8');
    if (createHash('sha256').update(bytes).digest('hex') !== body.file.sha256) {
      sayError(ctx, 'cli.evidence.hash_mismatch', { name: body.file.name });
      return EXIT.failed;
    }
    if (typeof output === 'string') {
      try {
        // `wx`: never overwrite; 600: the pack names the approvers.
        fs.writeFileSync(output, bytes, { flag: 'wx', mode: 0o600 });
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code ?? 'error';
        sayError(ctx, 'cli.evidence.write_failed', { path: clean(output), code: clean(code) });
        return EXIT.failed;
      }
      say(ctx, 'cli.evidence.exported', {
        name: body.file.name,
        version: body.file.version,
        path: clean(output),
        sha256: body.file.sha256,
      });
    } else {
      // The file as the platform stored it, line by line; each line cleaned for the terminal.
      const text = body.file.content.endsWith('\n')
        ? body.file.content.slice(0, -1)
        : body.file.content;
      for (const line of text.split('\n')) ctx.stdout(clean(line));
    }
    return EXIT.ok;
  });
}

function usage(ctx: CliContext): number {
  ctx.stderr(t('cli.evidence.usage'));
  return EXIT.usage;
}
