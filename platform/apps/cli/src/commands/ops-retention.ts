// `sdlc ops retention report --tenant <slug>`: the evidence retention report on the server (task
// E05, design/ADR-M51). Counts only, from the database (SDLC_DB_URL, `platform_app`): per project,
// rows stored, purged, held, open, and due for the purge now. It deletes nothing and reads no
// evidence file; the worker's retention loop does the purge (`SDLC_WORKER_RETENTION_MODE`).
import { parseArgs } from 'node:util';

import { retentionReport, type TenantScope } from '@sdlc/core';
import { t } from '@sdlc/messages';

import { EXIT, type CliContext } from '../context.js';

type Values = Record<string, string | boolean | undefined>;

const SPEC = {
  tenant: { type: 'string' },
  'archive-grace-days': { type: 'string' },
  json: { type: 'boolean', default: false },
} as const;

/** The same default as the worker's `SDLC_WORKER_RETENTION_ARCHIVE_GRACE_DAYS`. */
export const DEFAULT_ARCHIVE_GRACE_DAYS = 7;
/** The report counts at most this many due rows per project. */
const DUE_LIMIT = 10_000;

/** Parses `args` (after `ops retention`). Undefined: print the usage. */
export function parseRetentionCommand(
  args: readonly string[],
): { command: 'report'; values: Values } | undefined {
  const [first, ...rest] = args;
  if (first !== 'report') return undefined;
  try {
    const { values } = parseArgs({
      args: [...rest],
      options: SPEC,
      strict: true,
      allowPositionals: false,
    });
    const found = values as Values;
    if (typeof found.tenant !== 'string') return undefined;
    const grace = found['archive-grace-days'];
    if (grace !== undefined && !/^[0-9]{1,3}$/.test(String(grace))) return undefined;
    return { command: 'report', values: found };
  } catch {
    return undefined;
  }
}

export async function runRetentionCommand(
  scope: TenantScope,
  _command: 'report',
  values: Values,
  ctx: CliContext,
): Promise<number> {
  const grace = values['archive-grace-days'];
  const report = await retentionReport(scope, {
    now: new Date(),
    archiveGraceDays: grace === undefined ? DEFAULT_ARCHIVE_GRACE_DAYS : Number(grace),
    limit: DUE_LIMIT,
  });
  if (values.json === true) {
    ctx.stdout(
      JSON.stringify(
        report.map((r) => ({
          project: r.projectSlug,
          project_id: r.projectId,
          status: r.status,
          retention_days: r.retentionDays,
          archive_purge_due: r.archivePurgeDue,
          stored: r.stored,
          due: r.due,
          held: r.held,
          open: r.open,
          purged: r.purged,
        })),
      ),
    );
    return EXIT.ok;
  }
  if (report.length === 0) ctx.stdout(t('cli.ops.retention.none'));
  for (const r of report) {
    ctx.stdout(
      t('cli.ops.retention.line', {
        project: r.projectSlug,
        status: r.status,
        days: r.retentionDays === null ? '-' : String(r.retentionDays),
        archive: r.archivePurgeDue ? 'yes' : 'no',
        stored: String(r.stored),
        due: String(r.due),
        held: String(r.held),
        open: String(r.open),
        purged: String(r.purged),
      }),
    );
  }
  return EXIT.ok;
}
