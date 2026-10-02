// Condition 2 of the A08 plan approval (design/ADR-M35 §2.5) on a live PostgreSQL: pg spans
// record the SQL text with $n placeholders only, never the parameter values.
import { createRequire } from 'node:module';
import path from 'node:path';

import { InMemorySpanExporter } from '@opentelemetry/sdk-trace-base';
import type pgModule from 'pg';
import { afterAll, beforeAll, expect, it } from 'vitest';

import {
  platformTracer,
  startTracing,
  type Tracing,
} from '../../../packages/telemetry/src/index.js';
import { describeDb, urlFor } from './helpers.js';

describeDb('A08: pg spans hold no parameter values', () => {
  const exporter = new InMemorySpanExporter();
  let tracing: Tracing;

  beforeAll(() => {
    const started = startTracing({ serviceName: 'sdlc-test', endpoint: undefined, exporter });
    if (!started) throw new Error('tracing did not start');
    tracing = started;
  });

  afterAll(async () => {
    await tracing.shutdown();
  });

  it('records the query with placeholders, inside a parent span only', async () => {
    // Required after the instrumentation is registered, as the apps load `pg` after telemetry.ts.
    const pg = createRequire(path.join(process.cwd(), 'package.json'))('pg') as typeof pgModule;
    const client = new pg.Client({ connectionString: urlFor('postgres') });
    await client.connect();
    try {
      // Outside a request or activity: no root span (requireParentSpan).
      await client.query('SELECT $1::text AS outside', ['outside-secret']);
      await platformTracer().startActiveSpan('parent', async (span) => {
        const result = await client.query('SELECT $1::text AS v, $2::int AS n', [
          'param-secret',
          42,
        ]);
        expect(result.rows[0]).toEqual({ v: 'param-secret', n: 42 });
        span.end();
      });
    } finally {
      await client.end();
    }
    await tracing.forceFlush();
    const spans = exporter.getFinishedSpans();
    const query = spans.find((s) => s.name !== 'parent');
    expect(spans.map((s) => s.name)).toHaveLength(2);
    const attributes = JSON.stringify(query?.attributes);
    expect(attributes).toContain('SELECT $1::text AS v, $2::int AS n');
    expect(attributes).not.toContain('param-secret');
    expect(attributes).not.toContain('outside-secret');
    expect(Object.keys(query?.attributes ?? {}).filter((k) => /values|parameter/.test(k))).toEqual(
      [],
    );
  });
});
