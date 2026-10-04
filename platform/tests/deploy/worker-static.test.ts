// B06: the sdlc-worker service in docker-compose.yml (design/ADR-M27 section 2.5). No port, no
// secret in its environment; the database password and the GitHub App key come from OpenBao with
// the AppRole "worker"; hardened container like sdlc-api.
import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { deployDir, loadCompose, readDeployFile, root } from './compose';

interface WorkerService {
  image: string;
  profiles: string[];
  build: { context: string; dockerfile: string };
  environment: Record<string, string>;
  ports?: string[];
  volumes: string[];
  read_only: boolean;
  cap_drop: string[];
  cap_add?: string[];
  privileged?: boolean;
  user?: string;
  security_opt: string[];
  healthcheck: { test: string[] };
}

const compose = loadCompose();
const worker = compose.services['sdlc-worker'] as unknown as WorkerService;

describe('sdlc-worker service', () => {
  it('is in the platform profile only, built from the worker Dockerfile, tagged with the package version', () => {
    expect(worker.profiles).toEqual(['platform']);
    expect(worker.build).toEqual({
      context: '../..',
      dockerfile: 'platform/apps/worker/Dockerfile',
    });
    const pkg = JSON.parse(
      fs.readFileSync(path.join(root, 'platform/apps/worker/package.json'), 'utf8'),
    ) as { version: string };
    expect(worker.image).toBe(`sdlc-worker:${pkg.version}`);
  });

  it('publishes no port and has no secret in its environment', () => {
    expect(worker.ports).toBeUndefined();
    for (const name of Object.keys(worker.environment)) {
      expect(name, name).not.toMatch(/PASSWORD|SECRET_ID$|TOKEN|DEV_DB_URL|DEV_MODE|KEY/);
    }
    expect(worker.environment).toMatchObject({
      SDLC_OPENBAO_ROLE_ID_FILE: '/run/sdlc/approle/role_id',
      SDLC_OPENBAO_SECRET_ID_FILE: '/run/sdlc/approle/secret_id',
    });
    expect(worker.volumes).toEqual([
      'worker-approle:/run/sdlc/approle',
      // C06 session 2a (ADR-M33 §2.5): the second AppRole, cost-controller; files, not values.
      'worker-cost-approle:/run/sdlc/cost-approle',
    ]);
    expect(worker.environment).toMatchObject({
      SDLC_WORKER_COST_ROLE_ID_FILE: '/run/sdlc/cost-approle/role_id',
      SDLC_WORKER_COST_SECRET_ID_FILE: '/run/sdlc/cost-approle/secret_id',
    });
    expect(readDeployFile('docker-compose.yml')).toMatch(/^ {2}worker-approle:$/m);
    expect(readDeployFile('docker-compose.yml')).toMatch(/^ {2}worker-cost-approle:$/m);
  });

  it('runs hardened: read-only root file system, no capabilities, no privilege gain', () => {
    expect(worker.read_only).toBe(true);
    expect(worker.cap_drop).toEqual(['ALL']);
    expect(worker.cap_add).toBeUndefined();
    expect(worker.privileged).toBeUndefined();
    expect(worker.user).toBeUndefined(); // the image's USER node applies
    expect(worker.security_opt).toEqual(['no-new-privileges:true']);
    expect(worker.healthcheck.test).toEqual(['CMD', 'node', '/app/dist/healthcheck.js']);
    const text = readDeployFile('docker-compose.yml');
    const start = text.indexOf('\n  sdlc-worker:\n');
    const rest = text.slice(start + 1);
    const next = rest.slice(1).search(/\n {2}[a-z][a-z0-9-]*:\n/);
    const block = next === -1 ? rest : rest.slice(0, next + 1);
    expect(block).not.toMatch(/cap_add|privileged|pid:|network_mode|docker\.sock/);
  });

  it('bootstrap.sh delivers the worker credentials through the shared helper', () => {
    const bootstrap = fs.readFileSync(path.join(deployDir, 'openbao/bootstrap.sh'), 'utf8');
    expect(bootstrap).toMatch(/^ {2}worker-credentials\) cmd_worker_credentials ;;$/m);
    expect(bootstrap).toMatch(
      /^cmd_worker_credentials\(\) \{\n {2}platform_credentials worker sdlc-worker\n {2}cost_controller_credentials\n\}$/m,
    );
    expect(bootstrap).toContain(
      'deliver_approle cost-controller sdlc-worker /run/sdlc/cost-approle platform',
    );
  });

  it('E03: builds release packs with its own SeaweedFS identity from OpenBao (worker-evidence-credentials)', () => {
    expect(worker.environment).toMatchObject({
      SDLC_WORKER_EVIDENCE_URL: 'http://seaweedfs:8333',
      SDLC_WORKER_EVIDENCE_BUCKET: 'evidence',
    });
    const depends = (compose.services['sdlc-worker'] as { depends_on: Record<string, unknown> })
      .depends_on;
    expect(depends['seaweedfs-init']).toEqual({ condition: 'service_completed_successfully' });
    const bootstrap = fs.readFileSync(path.join(deployDir, 'openbao/bootstrap.sh'), 'utf8');
    expect(bootstrap).toMatch(
      /^ {2}worker-evidence-credentials\) cmd_worker_evidence_credentials ;;$/m,
    );
    expect(bootstrap).toMatch(
      /^cmd_worker_evidence_credentials\(\) \{ pack_evidence_credentials worker sdlcwrkev sdlc-worker; \}$/m,
    );
  });

  it('E05: runs the evidence retention loop in report mode by default with its own purge identity', () => {
    expect(worker.environment).toMatchObject({
      SDLC_WORKER_RETENTION_URL: 'http://seaweedfs:8333',
      SDLC_WORKER_RETENTION_BUCKET: 'evidence',
      SDLC_WORKER_RETENTION_MODE: '${SDLC_WORKER_RETENTION_MODE:-report}',
      SDLC_WORKER_RETENTION_ARCHIVE_GRACE_DAYS: '${SDLC_WORKER_RETENTION_ARCHIVE_GRACE_DAYS:-7}',
    });
    const bootstrap = fs.readFileSync(path.join(deployDir, 'openbao/bootstrap.sh'), 'utf8');
    expect(bootstrap).toMatch(/^ {2}worker-purge-credentials\) cmd_worker_purge_credentials ;;$/m);
    expect(bootstrap).toMatch(
      /^cmd_worker_purge_credentials\(\) \{ s3_credentials worker purge sdlcwrkpg "\$PURGE_ACTIONS" sdlc-worker; \}$/m,
    );
    // Delete (Write), bypass, legal hold and lock on the three evidence prefixes, list the bucket;
    // never Read, never another prefix or bucket.
    const actions =
      /^PURGE_ACTIONS=''\n[\s\S]*?^PURGE_ACTIONS="List:evidence\$PURGE_ACTIONS"$/m.exec(
        bootstrap,
      )?.[0];
    expect(actions).toContain('for prefix in proposals diffs packs; do');
    expect(actions).toContain(
      'for action in Write BypassGovernanceRetention PutObjectLegalHold PutObjectRetention GetObjectRetention; do',
    );
    expect(actions).not.toMatch(/Read[:\s]|Admin/);
  });

  it('E05: the bucket evidence is locked GOVERNANCE for 180 days by seaweedfs-init', () => {
    const init = compose.services['seaweedfs-init'] as unknown as {
      environment: Record<string, string>;
    };
    expect(init.environment.SEAWEEDFS_LOCKED_BUCKETS).toBe('evidence:GOVERNANCE:180');
    const script = readDeployFile('seaweedfs/create-buckets.sh');
    expect(script).toContain('s3.bucket.lock -name $bucket -enable');
    // The admin keys reach curl on stdin, never as arguments.
    expect(script).toContain('curl -sS -f -K - --aws-sigv4');
    expect(script).not.toMatch(/--user\s/);
  });

  it('the worker AppRole policy reads its own KV path and the GitHub App key, nothing else of other processes', () => {
    const policy = fs.readFileSync(
      path.join(deployDir, 'openbao/bootstrap/policies/worker.hcl'),
      'utf8',
    );
    const paths = [...policy.matchAll(/^path "([^"]+)"/gm)].map((m) => m[1]);
    expect(paths).toContain('kv/data/worker/*');
    expect(paths).toContain('kv/data/shared/github-app');
    expect(paths.filter((p) => p!.startsWith('kv/'))).toEqual([
      'kv/data/worker/*',
      'kv/data/shared/github-app',
    ]);
  });

  it('the Dockerfile runs as node and bakes in no secret', () => {
    const dockerfile = fs.readFileSync(path.join(root, 'platform/apps/worker/Dockerfile'), 'utf8');
    expect(dockerfile).toMatch(/^USER node$/m);
    expect(dockerfile).toContain('pnpm --filter @sdlc/worker deploy --legacy --prod /out');
    expect(dockerfile).not.toMatch(/ARG .*(PASSWORD|TOKEN|SECRET)|ENV .*(PASSWORD|TOKEN|SECRET)/);
  });
});
