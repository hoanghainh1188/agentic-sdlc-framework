// B03 operator commands on a live PostgreSQL (QUESTIONS.md #58, #63; ADR-M26 section 2.2):
// `sdlc admin bootstrap` creates a tenant, its first user and token once, with audit events;
// `sdlc admin token issue|list|revoke` manage tokens. The raw token is printed once and stored
// only as its SHA-256 hash; audit payloads never hold names, e-mail addresses or tokens.
import { createHash } from 'node:crypto';

import { t } from '@sdlc/messages';
import { sql } from 'kysely';
import { afterAll, beforeAll, expect, it } from 'vitest';

import { EXIT, processContext, runCli, type CliContext } from '../../../apps/cli/src/index.js';
import { parseTenantId } from '../../../packages/core/src/db/tenant-id.js';
import { createTestDatabase, describeDb, urlFor, type TestDatabase } from './helpers.js';

const TOKEN = /sdlc_pat_[A-Za-z0-9_-]{43}/g;

describeDb('B03: sdlc admin on PostgreSQL', () => {
  let db: TestDatabase;

  beforeAll(async () => {
    db = await createTestDatabase();
  }, 60_000);
  afterAll(async () => {
    await db?.drop();
  });

  async function cli(argv: string[]) {
    const out: string[] = [];
    const err: string[] = [];
    const ctx: CliContext = {
      env: { SDLC_DB_URL: urlFor(db.name, 'platform_app') },
      stdout: (line) => out.push(line),
      stderr: (line) => err.push(line),
      connect: processContext().connect,
    };
    const code = await runCli(argv, ctx);
    return { code, out: out.join('\n'), err: err.join('\n') };
  }

  const bootstrapArgs = (slug: string) => [
    'admin',
    'bootstrap',
    '--tenant',
    slug,
    '--tenant-name',
    'Internal',
    '--email',
    'harry@example.com',
    '--name',
    'Harry',
  ];

  it('bootstraps a tenant once; prints the token once; stores only its hash; audits IDs only', async () => {
    const first = await cli(bootstrapArgs('internal'));
    expect(first.code, first.err).toBe(EXIT.ok);
    const tokens = first.out.match(TOKEN) ?? [];
    expect(tokens).toHaveLength(1);
    expect(first.out).toContain(t('cli.admin.token.shown_once'));

    const tenant = await db.app.system.getTenantBySlug('internal');
    const scope = db.app.forTenant(parseTenantId(tenant!.id));
    const user = await scope.users.getByEmail('harry@example.com');
    const stored = await scope.apiTokens.listForUser(user!.id);
    expect(stored).toHaveLength(1);
    expect(stored[0]!.token_hash).toBe(createHash('sha256').update(tokens[0]!).digest('hex'));

    const audit = await sql<{ action: string; payload: unknown; entity_type: string }>`
      SELECT action, payload, entity_type FROM audit_log WHERE tenant_id = ${tenant!.id} ORDER BY seq`.execute(
      db.owner,
    );
    expect(audit.rows.map((r) => r.action)).toEqual([
      'tenant.created',
      'user.created',
      'tenant_role.granted',
      'api_token.issued',
    ]);
    const dump = JSON.stringify(audit.rows);
    for (const secret of [
      'harry@example.com',
      'Harry',
      'Internal',
      tokens[0]!,
      stored[0]!.token_hash,
    ]) {
      expect(dump).not.toContain(secret);
    }
    expect((await scope.audit.verify()).broken).toBeUndefined();

    const again = await cli(bootstrapArgs('internal'));
    expect(again.code).toBe(EXIT.failed);
    expect(again.err).toBe(t('cli.admin.conflict'));
    expect(await scope.users.list()).toHaveLength(1);
  });

  it('issues, lists and revokes tokens', async () => {
    await cli(bootstrapArgs('tokens'));
    const issued = await cli([
      'admin',
      'token',
      'issue',
      '--tenant',
      'tokens',
      '--email',
      'harry@example.com',
      '--name',
      'laptop',
      '--days',
      '30',
      '--json',
    ]);
    expect(issued.code, issued.err).toBe(EXIT.ok);
    const body = JSON.parse(issued.out) as { token: string; token_id: string; expires_at: string };
    expect(body.token).toMatch(/^sdlc_pat_/);

    const listed = await cli([
      'admin',
      'token',
      'list',
      '--tenant',
      'tokens',
      '--email',
      'harry@example.com',
      '--json',
    ]);
    const rows = JSON.parse(listed.out) as { id: string; name: string }[];
    expect(rows.map((r) => r.name).sort()).toEqual(['bootstrap', 'laptop']);
    expect(listed.out).not.toMatch(TOKEN);

    const revoke = ['admin', 'token', 'revoke', '--tenant', 'tokens', '--id', body.token_id];
    expect((await cli(revoke)).code).toBe(EXIT.ok);
    expect((await cli(revoke)).code).toBe(EXIT.ok);
    const unknown = await cli([
      'admin',
      'token',
      'revoke',
      '--tenant',
      'tokens',
      '--id',
      '00000000-0000-4000-8000-000000000000',
    ]);
    expect(unknown.code).toBe(EXIT.failed);
  });

  it('refuses bad input with catalog messages', async () => {
    const tooLong = await cli([
      'admin',
      'token',
      'issue',
      '--tenant',
      'tokens',
      '--email',
      'harry@example.com',
      '--name',
      'x',
      '--days',
      '400',
    ]);
    expect(tooLong.code).toBe(EXIT.usage);
    const noTenant = await cli([
      'admin',
      'token',
      'list',
      '--tenant',
      'nobody',
      '--email',
      'harry@example.com',
    ]);
    expect(noTenant.err).toBe(t('cli.admin.tenant_not_found', { slug: 'nobody' }));
    const badSlug = await cli(bootstrapArgs('Bad Slug'));
    expect(badSlug.code).toBe(EXIT.usage);
  });
});
