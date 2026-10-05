// The platform logger (D-08 A08 AC1, design/ADR-M35 §2.1–§2.2).
import { describe, expect, it } from 'vitest';

import {
  createJsonLogger,
  currentLogContext,
  MAX_LOG_STRING_LENGTH,
  safeLogFields,
  withLogContext,
  type LogFields,
} from '../../packages/core/src/observability/index.js';

const NOW = new Date('2026-09-30T10:00:00.000Z');

function capture(traceIds?: () => { traceId: string; spanId: string } | undefined) {
  const lines: Record<string, unknown>[] = [];
  const logger = createJsonLogger({
    write: (line) => {
      expect(line.endsWith('\n')).toBe(true);
      lines.push(JSON.parse(line) as Record<string, unknown>);
    },
    now: () => NOW,
    ...(traceIds ? { traceIds } : {}),
  });
  return { logger, lines };
}

describe('createJsonLogger', () => {
  it('writes one JSON line with time, level, event and fields', () => {
    const { logger, lines } = capture();
    logger.log('info', 'worker.started', { tick_ms: 1000, runs: true });
    expect(lines).toEqual([
      {
        time: '2026-09-30T10:00:00.000Z',
        level: 'info',
        event: 'worker.started',
        tick_ms: 1000,
        runs: true,
      },
    ]);
  });

  it('has no ID fields outside a context', () => {
    const { logger, lines } = capture();
    logger.log('warn', 'x.y');
    expect(Object.keys(lines[0] ?? {})).toEqual(['time', 'level', 'event']);
  });

  it('adds tenant_id, intent_id and run_id from the context', async () => {
    const { logger, lines } = capture();
    await withLogContext({ tenantId: 't-1' }, async () => {
      await Promise.resolve();
      withLogContext({ intentId: 'i-1', runId: 'r-1' }, () => logger.log('info', 'a'));
      logger.log('info', 'b');
    });
    logger.log('info', 'c');
    expect(lines[0]).toMatchObject({ tenant_id: 't-1', intent_id: 'i-1', run_id: 'r-1' });
    expect(lines[1]).toMatchObject({ tenant_id: 't-1' });
    expect(lines[1]).not.toHaveProperty('intent_id');
    expect(lines[2]).not.toHaveProperty('tenant_id');
  });

  it('keeps the outer context when an inner value is undefined', () => {
    withLogContext({ tenantId: 't-1', intentId: 'i-1' }, () => {
      withLogContext({ intentId: undefined, runId: 'r-2' }, () => {
        expect(currentLogContext()).toEqual({ tenantId: 't-1', intentId: 'i-1', runId: 'r-2' });
      });
      expect(currentLogContext()).toEqual({ tenantId: 't-1', intentId: 'i-1' });
    });
  });

  it('adds the trace and span IDs when tracing gives them', () => {
    const { logger, lines } = capture(() => ({ traceId: 'a'.repeat(32), spanId: 'b'.repeat(16) }));
    logger.log('info', 'x');
    expect(lines[0]).toMatchObject({ trace_id: 'a'.repeat(32), span_id: 'b'.repeat(16) });
  });

  it('an explicit ID field wins over the context; reserved keys are never replaced', () => {
    const { logger, lines } = capture();
    withLogContext({ tenantId: 't-ctx' }, () =>
      logger.log('info', 'x', { tenant_id: 't-field', level: 'debug', event: 'fake' }),
    );
    expect(lines[0]).toMatchObject({
      tenant_id: 't-field',
      level: 'info',
      event: 'x',
      dropped_fields: 2,
    });
  });
});

describe('safeLogFields', () => {
  it.each([
    'token',
    'installation_token',
    'secret_id',
    'password',
    'Authorization',
    'cookie',
    'api_key',
    'apiKey',
    'private_key',
    'credentials',
    'body',
    'comment_text',
    'prompt',
    'content',
    'headers',
    'url',
    'query',
  ])('drops the field %s', (name) => {
    expect(safeLogFields({ [name]: 'x', code: 'ok' })).toEqual({
      fields: { code: 'ok' },
      dropped: 1,
    });
  });

  it.each(['apiKey', 'accessKey', 'bearer', 'jwt', 'session_id', 'value', 'redirect_uri'])(
    'drops the field %s (word-based)',
    (name) => {
      expect(safeLogFields({ [name]: 'x' }).dropped).toBe(1);
    },
  );

  // Every field name the platform logs today (A08): a guard change that drops one fails here.
  it.each([
    'message',
    'path',
    'ttl_seconds',
    'status',
    'reply_code',
    'context_id',
    'tokens_in',
    'max_budget_usd',
    'limited_by',
    'tenant_id',
    'project_id',
    'intent_id',
    'run_id',
    'escalation_id',
    'tick_ms',
    'escalation_tick_ms',
    'replies_posted',
    'replies_failed',
    'notices_posted',
    'events',
    'outcome',
    'outcomes',
    'operation',
    'permissions',
    'renewable',
    'repo',
    'version',
    'expires_at',
    'attempt',
    'code',
    'error',
    'effect',
    'woken',
    'failed',
    'runs',
    'failed_runs',
    'errors',
    'stop_reason',
    'reason',
    'source',
    'service',
    'tracing',
    // E05 PR 2: the daily audit anchor logs the anchored hash (D-05 §7.4 "operations log").
    'hash',
    'hash_version',
    'seq',
    'date',
  ])('keeps the field %s', (name) => {
    expect(safeLogFields({ [name]: 'v' }).fields).toEqual({ [name]: 'v' });
  });

  it('drops nested values, non-finite numbers and undefined', () => {
    const fields = {
      nested: { a: 1 },
      list: [1],
      nan: Number.NaN,
      inf: Number.POSITIVE_INFINITY,
      none: undefined,
      ok: 1,
    } as unknown as LogFields;
    expect(safeLogFields(fields)).toEqual({ fields: { ok: 1 }, dropped: 5 });
  });

  it('cuts long strings', () => {
    const long = 'x'.repeat(MAX_LOG_STRING_LENGTH + 20);
    expect(safeLogFields({ message: long }).fields.message).toHaveLength(MAX_LOG_STRING_LENGTH);
  });
});
