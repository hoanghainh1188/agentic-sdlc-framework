// U01 AC1, AC6 (design/ADR-M54 §2.1): the dashboard needs no new endpoint. Every path it reads is
// an existing GET route of the API, found in the controllers' decorators.
import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { repoRoot } from '../workspace/helpers';

const root = repoRoot();
const apiSrc = path.join(root, 'platform/apps/api/src');

function controllers(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return controllers(full);
    return entry.name.endsWith('.controller.ts') ? [full] : [];
  });
}

/** `GET` routes as patterns, `:param` → one segment. */
function getRoutes(): RegExp[] {
  return controllers(apiSrc).flatMap((file) => {
    const text = fs.readFileSync(file, 'utf8');
    const base = /@Controller\('([^']*)'\)/.exec(text)?.[1] ?? '';
    return [...text.matchAll(/@Get\((?:'([^']*)')?\)/g)].map((m) => {
      const full = `/${[base, m[1] ?? ''].filter((p) => p !== '').join('/')}`;
      return new RegExp(`^${full.replace(/:[a-z_]+/g, '[^/]+')}$`);
    });
  });
}

/** The paths the dashboard reads (`apiPath('…')` in src/api/reads.ts), with `${…}` as one segment. */
function dashboardPaths(): string[] {
  const reads = fs.readFileSync(
    path.join(root, 'platform/apps/dashboard/src/api/reads.ts'),
    'utf8',
  );
  return [...reads.matchAll(/apiPath\(\s*[`']([^`']+)[`']/g)].map((m) =>
    m[1]!.replace(/\$\{[^}]+\}/g, 'X'),
  );
}

describe('the dashboard reads existing GET endpoints only', () => {
  it('finds the API routes and the dashboard reads', () => {
    expect(getRoutes().length).toBeGreaterThan(20);
    expect(dashboardPaths()).toEqual(
      expect.arrayContaining([
        '/v1/me',
        '/v1/intents',
        '/v1/intents/X',
        '/v1/escalations',
        '/v1/cost/report',
        '/v1/metrics/gates',
        '/v1/admin/audit/verify',
      ]),
    );
  });

  it('every path it reads is a GET route of the API', () => {
    const routes = getRoutes();
    for (const p of dashboardPaths()) {
      expect(
        routes.some((r) => r.test(p)),
        p,
      ).toBe(true);
    }
  });
});
