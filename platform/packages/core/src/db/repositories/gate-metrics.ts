// Gate waiting-time metrics (task E06, D-02 FR-12, D-08 E06, design/ADR-M47). Read only: three
// grouped queries per (project, gate), always for one tenant, with `tenant_id = <tenant>` on every
// table occurrence (D-05 D2, the tenant guard).
//
// - Finished waits: people's decisions (`approve`, `reject`, `request_changes`) with
//   `waited_seconds` (B07 session 2: the time since the intent entered the gate, wall clock).
//   Each one is "first round" or "after changes": after changes when a request for changes at the
//   same gate was recorded earlier in the same visit (QUESTIONS #205). A visit starts where the
//   clock of `waited_seconds` (`gate_entered_at`) starts. Visits and order come from
//   the audit chain (`seq`), as for the gate rules (ADR-M30 §2.4); the range reads the decision's
//   `gate.decided` event time (the registry clock, ADR-M30 §2.9).
// - Auto passes: the platform's `pass` in HOTL or AUDIT mode at G1–G3, G7 and G8. The automatic
//   gates (G4 POLICY, G5, G6) never waited for a person.
// - Open: intents `in_gate` now, with the earliest `gate_entered_at`.
import type { GateCheckMode, GateCode, RiskTier } from '@sdlc/contracts';
import { sql, type ExpressionBuilder } from 'kysely';

import type { Database } from '../schema.js';
import { TenantRepository } from './base.js';

/** Decisions a person makes at a gate: the end of a wait (FR-12). */
export const WAIT_DECISIONS = ['approve', 'reject', 'request_changes'] as const;
/** Modes in which the platform passes a gate a person could otherwise decide. */
export const AUTO_PASS_MODES = ['HOTL', 'AUDIT'] as const satisfies readonly GateCheckMode[];
/** Gates whose system decisions are checks, not a skipped human decision (QUESTIONS #205). */
export const AUTOMATIC_GATES = ['G4', 'G5', 'G6'] as const satisfies readonly GateCode[];

/** Which decisions and intents the metrics read. */
export interface GateMetricsFilter {
  readonly projectId?: string;
  readonly gate?: GateCode;
  readonly riskTier?: RiskTier;
}

export interface GateWaitQuery extends GateMetricsFilter {
  readonly from: Date;
  readonly to: Date;
  /** Decisions only: the oversight mode recorded with the decision. */
  readonly mode?: GateCheckMode;
}

/** Statistics of one group of finished waits, in whole seconds. */
export interface WaitStatsRow {
  readonly project: string;
  readonly gate: GateCode;
  readonly afterChanges: boolean;
  readonly count: number;
  readonly avgSeconds: number;
  readonly maxSeconds: number;
  readonly p50Seconds: number;
  readonly p90Seconds: number;
}

export interface AutoPassRow {
  readonly project: string;
  readonly gate: GateCode;
  readonly count: number;
}

export interface OpenWaitRow {
  readonly project: string;
  readonly gate: GateCode;
  readonly count: number;
  /** The earliest `gate_entered_at` of the group. */
  readonly oldestEnteredAt: Date;
}

type DecisionDb = Database & {
  d: Database['gate_decisions'];
  i: Database['intents'];
  p: Database['projects'];
  own: Database['audit_log'];
};
type DecisionEb = ExpressionBuilder<DecisionDb, 'd' | 'i' | 'p' | 'own'>;

export class GateMetricsRepository extends TenantRepository {
  /** Finished waits per (project, gate, round): count, average, maximum, median and p90. */
  async waitStats(query: GateWaitQuery): Promise<WaitStatsRow[]> {
    const rows = await this.run(
      this.db
        .with('w', () =>
          this.decisions(query)
            .where('d.actor_type', '=', 'human')
            .where('d.decision', 'in', [...WAIT_DECISIONS])
            .where('d.waited_seconds', 'is not', null)
            .select((eb) => [
              'p.slug as project',
              'd.gate as gate',
              'd.waited_seconds as waited',
              this.afterChanges(eb as unknown as DecisionEb).as('after_changes'),
            ]),
        )
        .selectFrom('w')
        .select((eb) => [
          'w.project',
          'w.gate',
          'w.after_changes',
          eb.fn.countAll<string>().as('count'),
          sql<string>`round(avg(${eb.ref('w.waited')}))`.as('avg_seconds'),
          eb.fn.max('w.waited').as('max_seconds'),
          sql<number>`percentile_disc(0.5) within group (order by ${eb.ref('w.waited')})`.as(
            'p50_seconds',
          ),
          sql<number>`percentile_disc(0.9) within group (order by ${eb.ref('w.waited')})`.as(
            'p90_seconds',
          ),
        ])
        .groupBy(['w.project', 'w.gate', 'w.after_changes'])
        .orderBy('w.project')
        .orderBy('w.gate')
        .orderBy('w.after_changes')
        .execute(),
    );
    return rows.map((row) => ({
      project: row.project,
      gate: row.gate,
      afterChanges: row.after_changes === true,
      count: Number(row.count),
      avgSeconds: Number(row.avg_seconds),
      maxSeconds: Number(row.max_seconds),
      p50Seconds: Number(row.p50_seconds),
      p90Seconds: Number(row.p90_seconds),
    }));
  }

  /** The platform's HOTL and AUDIT passes per (project, gate), automatic gates left out. */
  async autoPasses(query: GateWaitQuery): Promise<AutoPassRow[]> {
    const rows = await this.run(
      this.decisions(query)
        .where('d.actor_type', '=', 'system')
        .where('d.decision', '=', 'pass')
        .where('d.oversight_mode', 'in', [...AUTO_PASS_MODES])
        .where('d.gate', 'not in', [...AUTOMATIC_GATES])
        .select((eb) => [
          'p.slug as project',
          'd.gate as gate',
          eb.fn.countAll<string>().as('count'),
        ])
        .groupBy(['p.slug', 'd.gate'])
        .orderBy('p.slug')
        .orderBy('d.gate')
        .execute(),
    );
    return rows.map((row) => ({ project: row.project, gate: row.gate, count: Number(row.count) }));
  }

  /** Intents waiting at a gate now, per (project, gate): how many and since when. */
  async openWaits(filter: GateMetricsFilter): Promise<OpenWaitRow[]> {
    const tenantId = this.tenantId;
    const rows = await this.run(
      this.db
        .selectFrom('intents as i')
        .innerJoin('projects as p', (join) =>
          join
            .onRef('p.tenant_id', '=', 'i.tenant_id')
            .onRef('p.id', '=', 'i.project_id')
            .on('p.tenant_id', '=', tenantId),
        )
        .where('i.tenant_id', '=', tenantId)
        .where('i.status', '=', 'in_gate')
        .where('i.current_gate', 'is not', null)
        .where('i.gate_entered_at', 'is not', null)
        .$if(filter.projectId !== undefined, (qb) =>
          qb.where('i.project_id', '=', filter.projectId ?? ''),
        )
        .$if(filter.gate !== undefined, (qb) => qb.where('i.current_gate', '=', filter.gate!))
        .$if(filter.riskTier !== undefined, (qb) => qb.where('i.risk_tier', '=', filter.riskTier!))
        .select((eb) => [
          'p.slug as project',
          'i.current_gate as gate',
          eb.fn.countAll<string>().as('count'),
          eb.fn.min('i.gate_entered_at').as('oldest'),
        ])
        .groupBy(['p.slug', 'i.current_gate'])
        .orderBy('p.slug')
        .orderBy('i.current_gate')
        .execute(),
    );
    return rows.map((row) => ({
      project: row.project,
      gate: row.gate!,
      count: Number(row.count),
      oldestEnteredAt: toDate(row.oldest),
    }));
  }

  /**
   * Decisions of the tenant with their intent, project and own `gate.decided` audit event, in the
   * range (the event's time) and the filters.
   */
  private decisions(query: GateWaitQuery) {
    const tenantId = this.tenantId;
    return this.db
      .selectFrom('gate_decisions as d')
      .innerJoin('intents as i', (join) =>
        join
          .onRef('i.tenant_id', '=', 'd.tenant_id')
          .onRef('i.id', '=', 'd.intent_id')
          .on('i.tenant_id', '=', tenantId),
      )
      .innerJoin('projects as p', (join) =>
        join
          .onRef('p.tenant_id', '=', 'i.tenant_id')
          .onRef('p.id', '=', 'i.project_id')
          .on('p.tenant_id', '=', tenantId),
      )
      .innerJoin('audit_log as own', (join) =>
        join
          .onRef('own.tenant_id', '=', 'd.tenant_id')
          .onRef('own.entity_id', '=', 'd.intent_id')
          .on('own.tenant_id', '=', tenantId)
          .on('own.action', '=', 'gate.decided')
          .on((eb) =>
            eb(eb.ref('own.payload', '->>').key('decision_id'), '=', eb.cast('d.id', 'text')),
          ),
      )
      .where('d.tenant_id', '=', tenantId)
      .where('own.occurred_at', '>=', query.from)
      .where('own.occurred_at', '<', query.to)
      .$if(query.projectId !== undefined, (qb) =>
        qb.where('i.project_id', '=', query.projectId ?? ''),
      )
      .$if(query.gate !== undefined, (qb) => qb.where('d.gate', '=', query.gate!))
      .$if(query.mode !== undefined, (qb) => qb.where('d.oversight_mode', '=', query.mode!))
      .$if(query.riskTier !== undefined, (qb) => qb.where('i.risk_tier', '=', query.riskTier!));
  }

  /**
   * True when a request for changes at the decision's gate was recorded earlier in the same visit
   * (audit `seq`). A visit starts where `gate_entered_at`, the clock of `waited_seconds`, starts:
   * at the first move into the gate after the last move to another gate (or to no gate). A pause
   * and resume at the same gate does not start a visit; a block recorded while the intent waited
   * at a later gate belongs to no visit of this gate.
   */
  private afterChanges(eb: DecisionEb) {
    const tenantId = this.tenantId;
    const gateText = eb.cast('d.gate', 'text');
    const moves = (alias: 'x' | 'e') =>
      eb
        .selectFrom(`audit_log as ${alias}`)
        .where(`${alias}.tenant_id`, '=', tenantId)
        .whereRef(`${alias}.entity_id`, '=', 'd.intent_id')
        .where(`${alias}.action`, '=', 'intent.state_changed')
        .whereRef(`${alias}.seq`, '<', 'own.seq');
    const exit = moves('x')
      .select((sub) => sub.fn.max('x.seq').as('exit_seq'))
      .where((sub) =>
        sub(sub.ref('x.payload', '->>').key('current_gate'), 'is distinct from', gateText),
      );
    const entry = moves('e')
      .select((sub) => sub.fn.min('e.seq').as('entry_seq'))
      .where((sub) => sub(sub.ref('e.payload', '->>').key('current_gate'), '=', gateText))
      .where((sub) => sub('e.seq', '>', sub.fn.coalesce(exit, sql.lit(0)).$castTo<string>()));
    return eb.exists(
      eb
        .selectFrom('audit_log as c')
        .select(sql.lit(1).as('one'))
        .where('c.tenant_id', '=', tenantId)
        .whereRef('c.entity_id', '=', 'd.intent_id')
        .where('c.action', '=', 'gate.decided')
        .where((sub) => sub(sub.ref('c.payload', '->>').key('gate'), '=', gateText))
        .where((sub) => sub(sub.ref('c.payload', '->>').key('decision'), '=', 'request_changes'))
        .whereRef('c.seq', '<', 'own.seq')
        .where((sub) => sub('c.seq', '>', sub.fn.coalesce(entry, sql.lit(0)).$castTo<string>())),
    );
  }
}

function toDate(value: unknown): Date {
  if (value instanceof Date) return value;
  if (typeof value === 'string' || typeof value === 'number') return new Date(value);
  throw new TypeError('gate metrics: unexpected time value');
}
