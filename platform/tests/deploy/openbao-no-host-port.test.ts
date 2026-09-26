// D-08 task A11 AC4 (design/QUESTIONS.md #27): OpenBao is reachable only on the Compose network.
// No compose file or override in the repo may publish 8200 (API) or 8210 (key-holder listener)
// on the host again, and the openbao service publishes no port at all.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  parse,
  type DocumentOptions,
  type ParseOptions,
  type SchemaOptions,
  type ToJSOptions,
} from 'yaml';

import { parseEnvFile, readDeployFile, root } from './compose';

const OPENBAO_PORTS = [8200, 8210];
const SKIP_DIRS = new Set(['node_modules', '.git', '.claude', 'dist', '.pnpm-store']);
const COMPOSE_FILE = /(compose|override)[^/]*\.ya?ml$/i;

// Compose tags: `!override` keeps its value, so a port list under it is still checked.
// `!reset` values are read as written (an empty list publishes nothing).
const COMPOSE_YAML: ParseOptions & DocumentOptions & SchemaOptions & ToJSOptions = {
  merge: true,
  customTags: [
    { tag: '!override', collection: 'seq', resolve: (v) => v },
    { tag: '!override', collection: 'map', resolve: (v) => v },
    { tag: '!reset', collection: 'seq', resolve: (v) => v },
    { tag: '!reset', collection: 'map', resolve: (v) => v },
    { tag: '!reset', resolve: () => null },
  ],
};

type PortEntry = string | number | { target?: unknown; published?: unknown };

/** Every compose or override file on disk (tracked, untracked or Git-ignored). */
function composeFiles(dir: string = root): string[] {
  const found: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) found.push(...composeFiles(full));
    } else if (COMPOSE_FILE.test(entry.name)) {
      found.push(full);
    }
  }
  return found;
}

/** Replaces ${VAR:-default} / ${VAR-default} by the default and ${VAR} by nothing. */
function interpolateDefaults(text: string): string {
  return text.replace(
    /\$\{[A-Za-z_]\w*(?::?-([^}]*))?\}/g,
    (_, fallback?: string) => fallback ?? '',
  );
}

/** "8200", "8190-8210" → [8200] / [8190, 8210] (inclusive range); anything else → undefined. */
function portRange(text: string): [number, number] | undefined {
  const m = /^(\d+)(?:-(\d+))?$/.exec(text.trim());
  if (!m) return undefined;
  return [Number(m[1]), Number(m[2] ?? m[1])];
}

const inRange = (range: [number, number] | undefined): boolean =>
  range !== undefined && OPENBAO_PORTS.some((p) => p >= range[0] && p <= range[1]);

/**
 * True when a `ports:` entry publishes 8200 or 8210, as the container port or the host port.
 * Short syntax: [host_ip:][host[-range]:]container[-range][/proto], also "[::1]:8200:8200".
 * Long syntax: { target, published }.
 */
export function publishesOpenBaoPort(entry: PortEntry): boolean {
  if (typeof entry === 'number') return inRange([entry, entry]);
  if (typeof entry === 'object' && entry !== null) {
    return [entry.target, entry.published].some(
      (v) =>
        (typeof v === 'string' || typeof v === 'number') &&
        inRange(portRange(interpolateDefaults(String(v)))),
    );
  }
  const text = interpolateDefaults(entry).replace(/\/(tcp|udp|sctp)$/i, '');
  const withoutIpv6 = text.replace(/^\[[^\]]*\]:/, '');
  const parts = withoutIpv6.split(':');
  const container = parts.at(-1)!;
  const host = parts.length >= 2 ? parts.at(-2)! : '';
  return inRange(portRange(container)) || inRange(portRange(host));
}

interface ServiceLike {
  ports?: PortEntry[];
  network_mode?: string;
}

describe('A11: OpenBao publishes no port on the host (QUESTIONS #27)', () => {
  const files = composeFiles();

  it('finds the compose files of the repo (deploy and spikes)', () => {
    const rel = files.map((f) => path.relative(root, f).split(path.sep).join('/'));
    expect(rel).toEqual(expect.arrayContaining(['platform/deploy/docker-compose.yml']));
    expect(rel.some((f) => f.startsWith('platform/spikes/'))).toBe(true);
  });

  it('no compose or override file publishes 8200 or 8210', () => {
    for (const file of files) {
      const doc = parse(fs.readFileSync(file, 'utf8'), COMPOSE_YAML) as {
        services?: Record<string, ServiceLike | null>;
      } | null;
      for (const [name, service] of Object.entries(doc?.services ?? {})) {
        for (const port of service?.ports ?? []) {
          expect(
            publishesOpenBaoPort(port),
            `${path.relative(root, file)}: ${name}: ${JSON.stringify(port)}`,
          ).toBe(false);
        }
        if (name === 'openbao') {
          expect(service?.ports, `${file}: openbao publishes ports`).toBeUndefined();
          expect(service?.network_mode, `${file}: openbao uses the host network`).toBeUndefined();
        }
      }
    }
  });

  it('.env.example has no OPENBAO_HOST_PORT', () => {
    expect(parseEnvFile(readDeployFile('.env.example')).has('OPENBAO_HOST_PORT')).toBe(false);
    expect(readDeployFile('docker-compose.yml')).not.toMatch(/OPENBAO_HOST_PORT/);
  });

  it('reads ports under compose !override and !reset tags', () => {
    const doc = parse(
      'services:\n  a:\n    ports: !override\n      - "8200:8200"\n  b:\n    ports: !reset []\n',
      COMPOSE_YAML,
    ) as { services: Record<string, ServiceLike> };
    expect(doc.services['a']?.ports?.some(publishesOpenBaoPort)).toBe(true);
    expect(doc.services['b']?.ports?.some(publishesOpenBaoPort) ?? false).toBe(false);
  });

  describe('the detector catches every port syntax', () => {
    it.each<PortEntry>([
      '8200',
      8200,
      '8210:8210',
      '127.0.0.1:8200:8200',
      '${SDLC_BIND_ADDR:-127.0.0.1}:${OPENBAO_HOST_PORT:-8200}:8200',
      '127.0.0.1:18200:8200/tcp',
      '0.0.0.0:8200:9999',
      '[::1]:8210:8210',
      '8190-8215:8190-8215',
      '127.0.0.1::8200',
      { target: 8200 },
      { target: 9999, published: '8210' },
      { target: 80, published: '${X:-8200}' },
    ])('flags %j', (entry) => {
      expect(publishesOpenBaoPort(entry)).toBe(true);
    });

    it.each<PortEntry>([
      '${SDLC_BIND_ADDR:-127.0.0.1}:${LITELLM_HOST_PORT:-4000}:4000',
      '5432:5432',
      '127.0.0.1:18201:8201',
      '8211-8220:8211-8220',
      { target: 3000, published: '3000' },
      82000,
    ])('does not flag %j', (entry) => {
      expect(publishesOpenBaoPort(entry)).toBe(false);
    });
  });
});
