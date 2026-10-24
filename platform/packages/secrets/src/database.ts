// Short-lived database logins for a run's tools (task X04 PR 3b, design/ADR-M69 §2.4, ADR-M89,
// QUESTIONS #535, #537, #541). OpenBao's database secrets engine (mount `database/`, connection
// `knowledge-db`) logs in to `knowledge-db` as `kdocs_issuer` and makes one login per tool grant:
//
//   write `database/roles/kdocs-<run_id>` (its only grant: the project's read role)
//   → read `database/creds/kdocs-<run_id>` (a new login with a time to live)
//   … the end of the run, a kill, an abandoned run:
//   → `sys/leases/revoke-prefix/database/creds/kdocs-<run_id>` → delete the role
//
// The run ID alone finds every lease and the role, so no lease ID is kept or travels (R031). The
// worker's policy allows these paths for `kdocs-*` only (`policies/worker.hcl`).
import type { RedactedSecret, RunDatabaseCredentials, RunDatabaseLogin } from '@sdlc/contracts';

import type { Caller } from './client.js';
import { SecretsError } from './errors.js';
import { Redacted } from './redacted.js';

/** The database connection the engine uses (`openbao:bootstrap knowledge-issuer-credentials`). */
export const KNOWLEDGE_DB_CONNECTION = 'knowledge-db';

const RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** A project's read role (`kdocs_p<32 hex>_read`): the only role a run's login may get. */
const READ_ROLE = /^kdocs_p[0-9a-f]{32}_read$/;
/** Logins live at most one day; a run's time cap is far below (configuration `run.*`). */
export const MAX_LOGIN_TTL_SECONDS = 86_400;

/** The OpenBao role of one run. */
export function runDatabaseRole(runId: string): string {
  if (!RUN_ID.test(runId)) throw new SecretsError('secrets.database.invalid_input');
  return `kdocs-${runId}`;
}

/**
 * The login's SQL. `{{name}}`, `{{password}}` and `{{expiration}}` are filled by OpenBao; the role
 * name is checked above, so no input text reaches the statement. The login may only connect and
 * read the project's schema (through the read role); `VALID UNTIL` ends it even if a revocation
 * fails.
 */
export function creationStatements(grantRole: string): string[] {
  if (!READ_ROLE.test(grantRole)) throw new SecretsError('secrets.database.invalid_input');
  return [
    `CREATE ROLE "{{name}}" WITH LOGIN PASSWORD '{{password}}' VALID UNTIL '{{expiration}}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION CONNECTION LIMIT 4 IN ROLE ${grantRole};`,
  ];
}

/** Ends the login's sessions, then drops it. */
export const REVOCATION_STATEMENTS = [
  `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = '{{name}}';`,
  `DROP ROLE IF EXISTS "{{name}}";`,
];

export class DatabaseCredentials implements RunDatabaseCredentials {
  constructor(
    private readonly mount: string,
    private readonly call: Caller,
  ) {}

  async issueRunLogin(input: {
    readonly runId: string;
    readonly grantRole: string;
    readonly ttlSeconds: number;
  }): Promise<RunDatabaseLogin> {
    const role = runDatabaseRole(input.runId);
    const { ttlSeconds } = input;
    if (
      !Number.isSafeInteger(ttlSeconds) ||
      ttlSeconds < 60 ||
      ttlSeconds > MAX_LOGIN_TTL_SECONDS
    ) {
      throw new SecretsError('secrets.database.invalid_input');
    }
    await this.call({
      operation: 'database role',
      method: 'POST',
      path: `${this.mount}/roles/${role}`,
      body: {
        db_name: KNOWLEDGE_DB_CONNECTION,
        creation_statements: creationStatements(input.grantRole),
        revocation_statements: REVOCATION_STATEMENTS,
        default_ttl: ttlSeconds,
        max_ttl: ttlSeconds,
      },
    });
    const res = await this.call({
      operation: 'database creds',
      method: 'GET',
      path: `${this.mount}/creds/${role}`,
    });
    const data = (res.body as { data?: { username?: unknown; password?: unknown } } | undefined)
      ?.data;
    if (typeof data?.username !== 'string' || typeof data.password !== 'string') {
      throw new SecretsError('secrets.openbao.invalid_response', { operation: 'database creds' });
    }
    const username: RedactedSecret = new Redacted(data.username);
    const password: RedactedSecret = new Redacted(data.password);
    return { username, password };
  }

  async revokeRunLogins(runId: string): Promise<void> {
    const role = runDatabaseRole(runId);
    await this.call({
      operation: 'database revoke',
      method: 'POST',
      path: `sys/leases/revoke-prefix/${this.mount}/creds/${role}`,
      body: { sync: true },
    });
    // 404: the role is gone already (a second revocation).
    await this.call({
      operation: 'database role delete',
      method: 'DELETE',
      path: `${this.mount}/roles/${role}`,
      accept: [404],
    });
  }
}
