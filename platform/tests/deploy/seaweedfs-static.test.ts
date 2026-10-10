// D-08 task A12 AC4 (design/ADR-M52, QUESTIONS #239, #245, #246): static checks that SeaweedFS's
// filer, volume servers and master stay unreachable from the network, that the S3 gateway's gRPC
// port needs the filer key, and that start.sh fails closed. No Docker needed. The live proof is
// platform/tests/integration/deploy/seaweedfs-access.test.ts (pnpm test:seaweedfs).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import { deployDir, loadCompose, readDeployFile, root } from './compose';

interface NetworkedService {
  command?: string[] | string;
  entrypoint?: string[] | string;
  environment?: Record<string, string>;
  ports?: string[];
  volumes?: string[];
  networks?: unknown;
  network_mode?: string;
}

// Compose's own tags (`!reset` in docker-compose.images.yml, V04) read as plain values.
const COMPOSE_TAGS = {
  merge: true,
  customTags: [{ tag: '!reset', resolve: () => null }],
};

const composeFiles = (): string[] => {
  const files = fs.readdirSync(deployDir).filter((f) => /^docker-compose.*\.ya?ml$/.test(f));
  expect(files).toContain('docker-compose.yml');
  return files;
};

const services = loadCompose().services as Record<string, NetworkedService>;
const seaweedfs = services.seaweedfs!;
const init = services['seaweedfs-init']!;
const startScript = readDeployFile('seaweedfs/start.sh');
// The script without comment lines.
const startCode = startScript
  .split('\n')
  .filter((line) => !line.trim().startsWith('#'))
  .join('\n');

// Every port SeaweedFS 4.48 opens in `weed server` mode with -s3, plus the ones it opens when a
// flag turns them on. Only 8333 (S3 HTTP) may be published.
const INTERNAL_PORTS = [
  '8888', // filer HTTP
  '18888', // filer gRPC
  '9333', // master HTTP
  '19333', // master gRPC
  '8080', // volume HTTP
  '18080', // volume gRPC
  '18333', // S3 gRPC (IAM cache, lifecycle delete): reachable on the network, needs the filer key
  '8181', // Iceberg REST catalog
  '9101', // Lance namespace server
  '8111', // IAM server
];

describe('A12 AC4: SeaweedFS listens on 127.0.0.1 except the S3 API', () => {
  it('runs exactly the reviewed command (any new flag needs this test changed on purpose)', () => {
    expect(seaweedfs.command).toEqual([
      'server',
      '-dir=/data',
      '-ip=127.0.0.1',
      '-ip.bind=127.0.0.1',
      '-s3.ip.bind=0.0.0.0',
      '-master.volumeSizeLimitMB=${SEAWEEDFS_VOLUME_SIZE_LIMIT_MB:-1024}',
      '-volume.max=0',
      '-s3',
      '-s3.port=8333',
      '-s3.port.iceberg=0',
      '-s3.port.lance=0',
    ]);
  });

  it('starts through start.sh, mounted read-only', () => {
    expect(seaweedfs.entrypoint).toEqual(['/bin/sh', '/scripts/start.sh']);
    expect(seaweedfs.volumes).toContain('./seaweedfs/start.sh:/scripts/start.sh:ro');
  });

  it('publishes only the S3 API on the host', () => {
    expect(seaweedfs.ports).toEqual([
      '${SDLC_BIND_ADDR:-127.0.0.1}:${SEAWEEDFS_S3_HOST_PORT:-8333}:8333',
    ]);
  });

  it('no compose file publishes or exposes an internal SeaweedFS port of the seaweedfs container', () => {
    for (const file of composeFiles()) {
      const parsed = parse(readDeployFile(file), COMPOSE_TAGS) as {
        services?: Record<string, NetworkedService & { expose?: unknown[] }>;
      };
      const s = parsed.services?.seaweedfs;
      if (!s) continue;
      expect(s.expose, `${file} exposes seaweedfs ports`).toBeUndefined();
      for (const port of s.ports ?? []) {
        const target = String(port).split(':').at(-1)!.split('/')[0]!;
        expect(INTERNAL_PORTS, `${file} publishes ${target}`).not.toContain(target);
        expect(target).toBe('8333');
      }
    }
  });

  it('seaweedfs-init shares the seaweedfs network namespace and joins no network', () => {
    expect(init.network_mode).toBe('service:seaweedfs');
    expect(init.networks).toBeUndefined();
  });

  it('no other service, in any compose file, joins the seaweedfs namespace or another container namespace', () => {
    for (const file of composeFiles()) {
      const parsed = parse(readDeployFile(file), COMPOSE_TAGS) as {
        services?: Record<string, NetworkedService>;
      };
      const joiners = Object.entries(parsed.services ?? {})
        .filter(([, s]) => /^(service|container):/.test(s.network_mode ?? ''))
        .map(([name]) => name);
      expect(joiners, file).toEqual(file === 'docker-compose.yml' ? ['seaweedfs-init'] : []);
    }
  });

  it('no code, script, config or handbook page reaches the master, filer or volume by the service name', () => {
    // Everything that runs or tells a person what to run. Tests (the live test names these
    // addresses on purpose), design records and the backlog generator (history) are left out.
    const roots = ['platform/deploy', 'platform/apps', 'platform/packages', 'handbook'];
    const skip = new Set(['node_modules', 'dist', '.turbo']);
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (skip.has(entry.name)) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (
          entry.isFile() &&
          /seaweedfs:(8888|18888|9333|19333|8080|18080|18333)\b|-master=seaweedfs/.test(
            fs.readFileSync(full, 'utf8'),
          )
        ) {
          offenders.push(path.relative(root, full));
        }
      }
    };
    for (const r of roots) {
      if (fs.existsSync(path.join(root, r))) walk(path.join(root, r));
    }
    expect(offenders).toEqual([]);
    expect(readDeployFile('seaweedfs/create-buckets.sh')).toContain('-master=127.0.0.1:9333');
    expect(readDeployFile('openbao/bootstrap.sh')).toMatch(/weed shell -master=127\.0\.0\.1:9333/);
  });

  it('keeps the signing keys out of the compose file and .env', () => {
    const compose = readDeployFile('docker-compose.yml');
    expect(compose).not.toMatch(/WEED_JWT|security\.toml:/);
    expect(readDeployFile('.env.example')).not.toMatch(/JWT|SIGNING/i);
  });
});

describe('A12: start.sh makes four keys at every start and fails closed', () => {
  it('is valid POSIX sh', () => {
    expect(() =>
      execFileSync('sh', ['-n', path.join(deployDir, 'seaweedfs/start.sh')]),
    ).not.toThrow();
  });

  it('stops on any error and checks root and /dev/urandom first', () => {
    expect(startCode).toMatch(/^set -eu$/m);
    expect(startCode).toContain('[ "$(id -u)" = 0 ] || fail');
    expect(startCode).toContain('[ -r /dev/urandom ] || fail');
  });

  it('writes the four sections, each key 32 random bytes checked by length', () => {
    for (const section of [
      '[jwt.signing]',
      '[jwt.signing.read]',
      '[jwt.filer_signing]',
      '[jwt.filer_signing.read]',
    ]) {
      expect(startCode).toContain(section);
    }
    expect(startCode).toContain('head -c 32 /dev/urandom');
    expect(startCode).toContain('[ "${#key}" -eq 64 ] || return 1');
    expect(startCode.match(/="\$\(new_key\)" \|\| fail/g)).toHaveLength(4);
  });

  it('fails on a write, owner or mode error, and checks the file before SeaweedFS starts', () => {
    expect(startCode).toMatch(/umask 077/);
    expect(startCode).toMatch(/\} >"\$tmp" \|\| \{ rm -f "\$tmp"; fail/);
    expect(startCode).toMatch(/chown "\$SEAWEED_USER:\$SEAWEED_USER" "\$tmp" \|\| \{/);
    expect(startCode).toMatch(/chmod 600 "\$tmp" \|\| \{/);
    expect(startCode).toMatch(/mv -f "\$tmp" "\$SECURITY_FILE" \|\| \{/);
    expect(startCode).toContain(
      `[ "$(stat -c '%a %U %G' "$SECURITY_FILE")" = "600 $SEAWEED_USER $SEAWEED_USER" ] ||`,
    );
    expect(startCode).toContain('-eq 4 ] ||');
    // SeaweedFS starts only as the very last step, after every check.
    const lines = startCode.split('\n').filter((l) => l.trim() !== '');
    expect(lines.at(-1)).toBe('exec /entrypoint.sh "$@"');
    expect(startCode.match(/\/entrypoint\.sh/g)).toHaveLength(1);
  });

  it('never prints a key or the file', () => {
    for (const line of startCode.split('\n')) {
      if (/\$\{?\w*key\b/.test(line) && /\b(echo|printf|cat|tee)\b/.test(line)) {
        // Only the writes into the file (redirected as one block) and new_key's result, captured
        // by its caller's command substitution, may name a key.
        expect(line).toMatch(/^\s+printf '(\[jwt\.|%s' "\$key"$)/);
      }
    }
    expect(startCode).toMatch(/^\} >"\$tmp"/m);
    expect(startCode).toMatch(/="\$\(new_key\)"/);
    expect(startCode).not.toMatch(
      /\b(cat|tee|more|less|head|tail)\b[^\n]*(\$SECURITY_FILE|\$tmp|security\.toml)/,
    );
    expect(startCode).not.toMatch(/set -x|set -o xtrace|set -v\b/);
  });

  it('removes its temporary file on any exit before the move, and stale ones from an interrupted start', () => {
    expect(startCode).toContain(`trap 'rm -f "$tmp"' EXIT INT TERM`);
    expect(startCode).toContain('rm -f "$dir"/.security.toml.*');
  });

  it('is executable in the repository', () => {
    const mode = fs.statSync(path.join(root, 'platform/deploy/seaweedfs/start.sh')).mode;
    expect(mode & 0o111).not.toBe(0);
  });
});
