// The pool after PostgreSQL ends a connection (fix/db-pool-error-listener): `pg_terminate_backend`
// on an idle client and on a checked-out one between two queries. Without the listeners of
// `createPool` Node throws the 'error' event and the test process ends.
import pg from 'pg';
import { afterAll, beforeAll, expect, it } from 'vitest';

import { createPool } from '../../../packages/core/src/db/connection.js';
import { describeDb, urlFor } from './helpers.js';

describeDb('pool error listeners on a live PostgreSQL', () => {
  let admin: pg.Client;
  let pool: pg.Pool;
  const codes: string[] = [];
  let waiters: (() => void)[] = [];

  /** Resolves on the next hook call: a deterministic wait, no sleep. */
  function nextIdleError(): Promise<void> {
    return new Promise((resolve) => waiters.push(resolve));
  }

  beforeAll(async () => {
    admin = new pg.Client({ connectionString: urlFor('postgres') });
    await admin.connect();
    pool = createPool({
      connectionString: urlFor('postgres'),
      maxConnections: 1,
      applicationName: 'sdlc-test-idle-error',
      onIdleError: (code) => {
        codes.push(code);
        const ready = waiters;
        waiters = [];
        for (const resolve of ready) resolve();
      },
    });
  });

  afterAll(async () => {
    await pool.end();
    await admin.end();
  });

  async function terminate(pid: number): Promise<void> {
    const result = await admin.query<{ ok: boolean }>('SELECT pg_terminate_backend($1) AS ok', [
      pid,
    ]);
    expect(result.rows[0]?.ok).toBe(true);
  }

  it('an idle client: reported as 57P01, the pool still answers', async () => {
    const first = await pool.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
    const pid = first.rows[0]!.pid;
    const before = codes.length;
    const reported = nextIdleError();
    await terminate(pid);
    await reported;
    // Reported once: pg-pool repeats an idle client's error on the pool in the same emit.
    expect(codes.slice(before)).toEqual(['57P01']);
    const next = await pool.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
    expect(next.rows[0]!.pid).not.toBe(pid);
  });

  it('a checked-out client between two queries: reported, its next query fails, the pool answers', async () => {
    const client = await pool.connect();
    const pid = (await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!
      .pid;
    const before = codes.length;
    const reported = nextIdleError();
    await terminate(pid);
    await reported;
    // Reported once: pg-pool repeats an idle client's error on the pool in the same emit.
    expect(codes.slice(before)).toEqual(['57P01']);
    await expect(client.query('SELECT 1')).rejects.toThrow();
    client.release(true);
    const next = await pool.query<{ n: number }>('SELECT 1 AS n');
    expect(next.rows[0]!.n).toBe(1);
  });
});
