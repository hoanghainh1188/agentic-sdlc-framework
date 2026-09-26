// Run events (design/D-05 section 6.4, D-08 C02 AC3, ADR-M22). Append-only: rows are only
// inserted; the database refuses UPDATE, DELETE and TRUNCATE (triggers and grants). Payloads hold
// the declared coded fields of their event type only (`RUN_EVENT_TYPES`).
import { canonicalJson } from '@sdlc/config';

import {
  checkRunEvent,
  MAX_RUN_EVENT_PAYLOAD_BYTES,
  type RunEventPayload,
  type RunEventType,
} from '../../run-events/types.js';
import { DbError } from '../errors.js';
import type { RunEventRow } from '../schema.js';
import { isUuid } from '../tenant-id.js';
import { TenantRepository } from './base.js';

export class RunEventRepository extends TenantRepository {
  /** Appends one event. Runs inside the caller's transaction when there is one. */
  // async: an invalid event rejects the promise instead of throwing synchronously.
  async append<T extends RunEventType>(
    runId: string,
    eventType: T,
    payload: RunEventPayload<T>,
  ): Promise<RunEventRow> {
    if (!isUuid(runId)) throw new DbError('invalid_value', 'runId must be a UUID');
    const checked = checkRunEvent(eventType, payload);
    const json = canonicalJson(checked);
    if (Buffer.byteLength(json, 'utf8') > MAX_RUN_EVENT_PAYLOAD_BYTES) {
      throw new DbError('invalid_value', `${eventType}: payload is too large`);
    }
    return await this.run(
      this.db
        .insertInto('run_events')
        .values({ tenant_id: this.tenantId, run_id: runId, event_type: eventType, payload: json })
        .returningAll()
        .executeTakeFirstOrThrow(),
    );
  }

  /** Events of one run, oldest first. */
  list(runId: string): Promise<RunEventRow[]> {
    if (!isUuid(runId)) return Promise.resolve([]);
    return this.run(
      this.db
        .selectFrom('run_events')
        .selectAll()
        .where('tenant_id', '=', this.tenantId)
        .where('run_id', '=', runId)
        .orderBy('id')
        .execute(),
    );
  }
}
