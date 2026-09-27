// B07 (ADR-M30 §2.1): the api and the worker reach the Compose Temporal on the internal network,
// start after its namespace exists, and the worker image carries the workflow bundle made at build
// time. The test server for `pnpm test:workflow` is pinned by version and SHA-256 (QUESTIONS #92).
import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { loadCompose, root } from './compose';

interface Service {
  environment: Record<string, string>;
  depends_on: Record<string, { condition: string }>;
  ports?: string[];
}

const compose = loadCompose();
const service = (name: string) => compose.services[name] as unknown as Service;

describe('B07: intent workflow deployment', () => {
  it.each([
    ['sdlc-worker', 'SDLC_WORKER'],
    ['sdlc-api', 'SDLC_API'],
  ])('%s reaches Temporal after its namespace exists', (name, prefix) => {
    const s = service(name);
    expect(s.environment[`${prefix}_TEMPORAL_ADDRESS`]).toBe('temporal:7233');
    expect(s.environment[`${prefix}_TEMPORAL_NAMESPACE`]).toBe('${TEMPORAL_NAMESPACE:-default}');
    expect(s.depends_on['temporal-namespace']).toEqual({
      condition: 'service_completed_successfully',
    });
  });

  it('the worker image bundles the workflow code at build time and points to it', () => {
    const dockerfile = fs.readFileSync(path.join(root, 'platform/apps/worker/Dockerfile'), 'utf8');
    expect(dockerfile).toContain('node platform/apps/worker/dist/bundle-workflows.js');
    expect(dockerfile).toContain('ENV SDLC_WORKER_WORKFLOW_BUNDLE=/app/dist/workflow-bundle.js');
    // Install scripts stay blocked (ADR-M16): bundling works without the @swc/core postinstall.
    expect(dockerfile).toContain('pnpm install --frozen-lockfile --ignore-scripts');
  });

  it('the Temporal test server is pinned by version and SHA-256, from the GitHub release', () => {
    const script = fs.readFileSync(
      path.join(root, 'platform/deploy/scripts/temporal-test-server.sh'),
      'utf8',
    );
    expect(script).toMatch(/^VERSION=\d+\.\d+\.\d+$/m);
    expect(script.match(/sha=[0-9a-f]{64}/g)).toHaveLength(4);
    expect(script).toContain('https://github.com/temporalio/sdk-java/releases/download/');
    expect(script).toMatch(
      /^url="https:\/\/github\.com\/temporalio\/sdk-java\/releases\/download\//m,
    );
    expect(script).toContain('SHA-256 mismatch');
  });
});
