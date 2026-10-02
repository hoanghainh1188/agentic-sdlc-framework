// `sdlc ai-record show|set` over the API (D-08 B04 AC5; ADR-M32 §2.4, handbook Ch.19 §19.8b).
// The caller is the accountable person: they need a write role on the project for `set`
// (config `access.ai_record_write_roles`). `--expected-version` is the version read (0 creates
// the record); a stale version is refused (409 `ai_record_version_conflict`).
import { t } from '@sdlc/messages';

import { aiRecordSchema, type AiRecordView } from '../api/schemas.js';
import { parseCommand, segment, withApi } from '../api/session.js';
import { EXIT, type CliContext } from '../context.js';
import { say, show, toJson } from '../output.js';
import {
  AI_RECORD_CONTENT_OPTIONS,
  AI_RECORD_CONTENT_REQUIRED,
  classList,
  EXPECTED_VERSION_PATTERN,
} from './ai-record-flags.js';

const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;

export async function runAiRecord(args: readonly string[], ctx: CliContext): Promise<number> {
  const [command, ...rest] = args;
  if (command !== 'show' && command !== 'set') return usage(ctx);
  const parsed = parseCommand(rest, {
    project: { type: 'string' },
    ...(command === 'set' ? AI_RECORD_CONTENT_OPTIONS : {}),
  });
  const values = parsed?.values;
  const project = values?.project;
  if (!values || typeof project !== 'string' || !SLUG.test(project)) return usage(ctx);
  if (
    command === 'set' &&
    (!AI_RECORD_CONTENT_REQUIRED.every((key) => typeof values[key] === 'string') ||
      !EXPECTED_VERSION_PATTERN.test(String(values['expected-version'])))
  ) {
    return usage(ctx);
  }
  const json = values.json === true;
  const path = `/v1/projects/${segment(project)}/ai-record`;
  return withApi(ctx, json, async (client) => {
    const record =
      command === 'show'
        ? await client.get(path, aiRecordSchema)
        : await client.put(path, aiRecordSchema, {
            expected_version: Number(values['expected-version']),
            ai_allowed: String(values['ai-allowed']),
            allowed_data_classes: classList(String(values.classes)),
            prod_logs_allowed: String(values['prod-logs']),
            disclosure_format: String(values.disclosure),
            confirmed_at:
              typeof values['confirmed-at'] === 'string' ? values['confirmed-at'] : null,
            record_ref: typeof values['record-ref'] === 'string' ? values['record-ref'] : null,
          });
    if (json) ctx.stdout(toJson(record));
    else print(ctx, record, command);
    return EXIT.ok;
  });
}

function print(ctx: CliContext, record: AiRecordView, command: 'show' | 'set'): void {
  const params = {
    project: record.project.slug,
    version: record.version,
    ai_allowed: record.ai_allowed,
    classes: record.allowed_data_classes.join(',') || '-',
    prod_logs: record.prod_logs_allowed,
    disclosure: record.disclosure_format,
    confirmed_at: show(record.confirmed_at),
    consent: record.consent,
    record_ref: show(record.record_ref),
    record_sha256: record.record_sha256,
    updated_by: record.updated_by,
  };
  say(ctx, command === 'show' ? 'cli.admin.ai_record.detail' : 'cli.admin.ai_record.saved', params);
}

function usage(ctx: CliContext): number {
  ctx.stderr(t('cli.ai_record.usage'));
  return EXIT.usage;
}
