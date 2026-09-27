// `sdlc admin ai-record set|show`: the project AI record (task B12, handbook Ch.2 §2.5, template
// T7, design/ADR-M32 §2.4). Operator commands, run on the server with SDLC_DB_URL (`platform_app`),
// like `sdlc admin agent`. There is no user login: the audit event uses actor `system`, and the
// change is recorded on behalf of `--on-behalf-of`, who must hold a write role on the project
// (config `access.ai_record_write_roles`). The API (`PUT /v1/projects/:project/ai-record`) is the
// path with a logged-in user; B04 adds `sdlc ai-record` over it.
import { parseArgs } from 'node:util';

import {
  AiRecordError,
  aiRecordErrorMessage,
  consentOf,
  saveAiRecord,
  type ProjectAiRecord,
  type TenantScope,
} from '@sdlc/core';
import type { AiAllowed, DataClass, DisclosureFormat, ProdLogsAllowed } from '@sdlc/contracts';
import { t } from '@sdlc/messages';

import { EXIT, type CliContext } from '../context.js';

type Values = Record<string, string | boolean | undefined>;

const BASE = {
  tenant: { type: 'string' },
  project: { type: 'string' },
  json: { type: 'boolean', default: false },
} as const;

const SPECS = {
  set: {
    ...BASE,
    'on-behalf-of': { type: 'string' },
    'expected-version': { type: 'string' },
    'ai-allowed': { type: 'string' },
    classes: { type: 'string' },
    'prod-logs': { type: 'string' },
    disclosure: { type: 'string' },
    'confirmed-at': { type: 'string' },
    'record-ref': { type: 'string' },
  },
  show: BASE,
} as const;
type Command = keyof typeof SPECS;

const REQUIRED: Readonly<Record<Command, readonly string[]>> = {
  set: [
    'tenant',
    'project',
    'on-behalf-of',
    'expected-version',
    'ai-allowed',
    'classes',
    'prod-logs',
    'disclosure',
  ],
  show: ['tenant', 'project'],
};

/** Parses `args` (after `admin ai-record`). Undefined: print the usage. */
export function parseAiRecordCommand(
  args: readonly string[],
): { command: Command; values: Values } | undefined {
  const [first, ...rest] = args;
  if (first === undefined || !Object.hasOwn(SPECS, first)) return undefined;
  const command = first as Command;
  try {
    const { values } = parseArgs({
      args: [...rest],
      options: SPECS[command],
      strict: true,
      allowPositionals: false,
    });
    const found = values as Values;
    if (!REQUIRED[command].every((key) => typeof found[key] === 'string')) return undefined;
    if (command === 'set' && !/^\d{1,9}$/.test(String(found['expected-version']))) {
      return undefined;
    }
    return { command, values: found };
  } catch {
    return undefined;
  }
}

/** Runs an AI record command against the tenant scope. Returns the exit code. */
export async function runAiRecordCommand(
  scope: TenantScope,
  command: Command,
  values: Values,
  ctx: CliContext,
): Promise<number> {
  const slug = String(values.project);
  const project = await scope.projects.getBySlug(slug);
  if (!project) {
    ctx.stderr(t('cli.admin.agent.project_not_found', { slug }));
    return EXIT.usage;
  }
  if (command === 'show') {
    const record = await scope.projectAiRecords.get(project.id);
    if (!record) {
      ctx.stderr(t('cli.admin.ai_record.none', { slug }));
      return EXIT.failed;
    }
    return print(record, slug, values, ctx, 'show');
  }
  const user = await scope.users.getByEmail(String(values['on-behalf-of']));
  if (!user) {
    ctx.stderr(t('cli.admin.user_not_found'));
    return EXIT.usage;
  }
  try {
    const saved = await saveAiRecord(scope, project.id, {
      expectedVersion: Number(values['expected-version']),
      aiAllowed: String(values['ai-allowed']) as AiAllowed,
      allowedDataClasses: list(String(values.classes)) as DataClass[],
      prodLogsAllowed: String(values['prod-logs']) as ProdLogsAllowed,
      disclosureFormat: String(values.disclosure) as DisclosureFormat,
      confirmedAt: typeof values['confirmed-at'] === 'string' ? values['confirmed-at'] : null,
      recordRef: typeof values['record-ref'] === 'string' ? values['record-ref'] : null,
      updatedBy: user.id,
      actorType: 'system',
    });
    return print(saved, slug, values, ctx, 'saved');
  } catch (error) {
    if (error instanceof AiRecordError) {
      ctx.stderr(aiRecordErrorMessage(error));
      return error.code === 'invalid_input' ? EXIT.usage : EXIT.failed;
    }
    throw error;
  }
}

/** `none` or an empty value: no classes. Otherwise a comma-separated list. */
function list(value: string): string[] {
  if (value === 'none') return [];
  return value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item !== '');
}

function print(
  record: ProjectAiRecord,
  slug: string,
  values: Values,
  ctx: CliContext,
  kind: 'show' | 'saved',
): number {
  const described = {
    project: slug,
    version: record.version,
    ai_allowed: record.ai_allowed,
    allowed_data_classes: record.allowed_data_classes,
    prod_logs_allowed: record.prod_logs_allowed,
    disclosure_format: record.disclosure_format,
    confirmed_at: record.confirmed_at,
    consent: consentOf(record.confirmed_at),
    record_ref: record.record_ref,
    record_sha256: record.record_sha256,
    updated_by: record.updated_by,
  };
  if (values.json === true) {
    ctx.stdout(JSON.stringify(described, null, 2));
    return EXIT.ok;
  }
  const params = {
    project: slug,
    version: String(record.version),
    ai_allowed: record.ai_allowed,
    classes: record.allowed_data_classes.join(',') || '-',
    prod_logs: record.prod_logs_allowed,
    disclosure: record.disclosure_format,
    confirmed_at: record.confirmed_at ?? '-',
    consent: described.consent,
    record_ref: record.record_ref ?? '-',
    record_sha256: record.record_sha256,
    updated_by: record.updated_by,
  };
  ctx.stdout(
    t(kind === 'show' ? 'cli.admin.ai_record.detail' : 'cli.admin.ai_record.saved', params),
  );
  return EXIT.ok;
}
