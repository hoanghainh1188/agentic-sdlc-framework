// Structured logging hook of the Cost Controller (task A08 connects the platform logger).
// Fields are primitives with safe values only: IDs, codes, counts, amounts. Never a key.

export type CostLogEvent =
  | 'cost.tenant_budget_unset'
  | 'cost.run_key_issued'
  | 'cost.run_key_revoked'
  | 'cost.sync_done'
  | 'cost.sync_skipped';

export type CostLogFields = Readonly<Record<string, string | number | boolean>>;

export interface CostLogger {
  log(level: 'info' | 'warn' | 'error', event: CostLogEvent, fields: CostLogFields): void;
}

export const silentCostLogger: CostLogger = { log: () => undefined };
