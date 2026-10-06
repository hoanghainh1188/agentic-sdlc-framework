// The pool's error listeners (fix/db-pool-error-listener): a connection that fails outside a
// query never crashes the process, and the hook gets a code only, never the message or the client.
import { EventEmitter } from 'node:events';

import type pg from 'pg';
import { afterEach, describe, expect, it } from 'vitest';

import {
  connectionErrorCode,
  createPool,
  logIdleDbErrors,
} from '../../packages/core/src/db/connection.js';
import { createJsonLogger } from '../../packages/core/src/observability/logger.js';

const URL_WITH_PASSWORD = 'postgres://platform_app:hunter2-marker@127.0.0.1:1/platform';

function failure(code?: string): Error {
  const error = new Error(`terminating connection; ${URL_WITH_PASSWORD}`);
  if (code !== undefined) Object.assign(error, { code });
  return error;
}

const pools: pg.Pool[] = [];
function pool(onIdleError?: (code: string) => void): pg.Pool {
  const created = createPool({
    connectionString: URL_WITH_PASSWORD,
    ...(onIdleError ? { onIdleError } : {}),
  });
  pools.push(created);
  return created;
}

/** A client as the pool hands it out: `connect` is emitted once it is connected. */
function connectedClient(target: pg.Pool): EventEmitter {
  const client = new EventEmitter();
  target.emit('connect', client);
  return client;
}

afterEach(async () => {
  await Promise.all(pools.splice(0).map((p) => p.end()));
});

describe('createPool error listeners', () => {
  it('a pool error (idle client) does not throw and is not reported twice', () => {
    const codes: string[] = [];
    const target = pool((code) => codes.push(code));
    expect(() => target.emit('error', failure('57P01'), {})).not.toThrow();
    expect(codes).toEqual([]);
  });

  it('a client error reports the SQLSTATE only', () => {
    const codes: unknown[] = [];
    const client = connectedClient(pool((...args: unknown[]) => codes.push(...args)));
    expect(() => client.emit('error', failure('57P01'))).not.toThrow();
    expect(codes).toEqual(['57P01']);
  });

  it('without a hook, neither event throws', () => {
    const target = pool();
    const client = connectedClient(target);
    expect(() => target.emit('error', failure('57P01'), client)).not.toThrow();
    expect(() => client.emit('error', failure('ECONNRESET'))).not.toThrow();
  });

  it('a hook that throws does not throw from the listener', () => {
    const client = connectedClient(
      pool(() => {
        throw new Error('hook failed');
      }),
    );
    expect(() => client.emit('error', failure('57P01'))).not.toThrow();
  });
});

describe('connectionErrorCode', () => {
  it('keeps SQLSTATE and Node codes, maps anything else to unknown', () => {
    expect(connectionErrorCode(failure('57P01'))).toBe('57P01');
    expect(connectionErrorCode(failure('ECONNRESET'))).toBe('ECONNRESET');
    expect(connectionErrorCode(failure())).toBe('unknown');
    expect(connectionErrorCode(failure(URL_WITH_PASSWORD))).toBe('unknown');
    expect(connectionErrorCode(failure('x'.repeat(33)))).toBe('unknown');
    expect(connectionErrorCode(null)).toBe('unknown');
    expect(connectionErrorCode('57P01')).toBe('unknown');
  });
});

describe('logIdleDbErrors', () => {
  it('writes one warning line with the code, never the message', () => {
    const lines: string[] = [];
    const logger = createJsonLogger({
      write: (line) => lines.push(line),
      now: () => new Date('2026-10-06T00:00:00Z'),
    });
    const client = connectedClient(pool(logIdleDbErrors(logger)));
    client.emit('error', failure('57P01'));
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toEqual({
      time: '2026-10-06T00:00:00.000Z',
      level: 'warn',
      event: 'db.idle_client_error',
      code: '57P01',
    });
    expect(lines[0]).not.toContain('hunter2-marker');
  });
});
