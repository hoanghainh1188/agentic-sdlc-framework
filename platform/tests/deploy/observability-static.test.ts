// A08 (design/ADR-M35 §2.4) and condition 1 of the plan approval: the OpenTelemetry Collector has
// no host port and is never reachable from a run's network (sandbox egress stays LiteLLM and the
// npm proxy, ADR-M25); tracing is off unless SDLC_OTEL_ENDPOINT is set.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import { deployDir, loadCompose, readDeployFile } from './compose';

const compose = loadCompose() as ReturnType<typeof loadCompose> & {
  services: Record<string, { networks?: string[]; read_only?: boolean; cap_drop?: string[] }>;
};
const collector = compose.services['otel-collector']!;

describe('otel-collector service', () => {
  it('is in the profile observability only, built from its own pinned Dockerfile', () => {
    expect(collector.profiles).toEqual(['observability']);
    expect(collector.image).toBe('sdlc-otel-collector:0.161.0');
    const dockerfile = readDeployFile('otel-collector/Dockerfile');
    const froms = [...dockerfile.matchAll(/^FROM (\S+)/gm)].map((m) => m[1]!);
    expect(froms).toHaveLength(2);
    for (const from of froms) expect(from).toMatch(/:\d+\.\d+\.\d+@sha256:[0-9a-f]{64}$/);
    expect(froms[0]).toContain('otel/opentelemetry-collector:0.161.0@');
    expect(dockerfile).toMatch(/^USER 10001:10001$/m);
  });

  it('publishes no port on the host', () => {
    expect(collector.ports).toBeUndefined();
  });

  it('is on the Compose network sdlc only, never on a run network', () => {
    expect(collector.networks).toEqual(['sdlc']);
  });

  it('is never a sandbox egress service', () => {
    for (const [name, s] of Object.entries(compose.services)) {
      for (const [key, value] of Object.entries(s.environment ?? {})) {
        if (/EGRESS/.test(key)) expect(String(value), `${name} ${key}`).not.toMatch(/otel/i);
      }
    }
  });

  it('runs hardened, with a health check', () => {
    expect(collector.read_only).toBe(true);
    expect(collector.cap_drop).toEqual(['ALL']);
    expect(collector.healthcheck?.test).toEqual([
      'CMD',
      'wget',
      '-q',
      '-O',
      '/dev/null',
      'http://127.0.0.1:13133/',
    ]);
  });

  it('holds the Langfuse project key; no other platform service has one in its environment', () => {
    expect(collector.environment).toEqual({
      LANGFUSE_PUBLIC_KEY:
        '${LANGFUSE_INIT_PROJECT_PUBLIC_KEY:?set LANGFUSE_INIT_PROJECT_PUBLIC_KEY in .env}',
      LANGFUSE_SECRET_KEY:
        '${LANGFUSE_INIT_PROJECT_SECRET_KEY:?set LANGFUSE_INIT_PROJECT_SECRET_KEY in .env}',
    });
    for (const name of ['litellm', 'litellm-agent', 'sdlc-api', 'sdlc-runner']) {
      expect(JSON.stringify(compose.services[name]?.environment ?? {}), name).not.toMatch(
        /LANGFUSE/,
      );
    }
    // E08 (ADR-M53): the worker has the Langfuse purge settings (URLs, bucket, age), never a key:
    // its own key comes from OpenBao (kv/worker/langfuse).
    const worker = compose.services['sdlc-worker']?.environment ?? {};
    for (const [key, value] of Object.entries(worker)) {
      if (!/LANGFUSE/.test(key)) continue;
      expect(key).toMatch(
        /^SDLC_WORKER_LANGFUSE_(URL|PROJECT_ID|CLICKHOUSE_URL|RAW_URL|RAW_BUCKET|RAW_MAX_AGE_HOURS)$/,
      );
      expect(String(value)).not.toMatch(/KEY|SECRET|PASSWORD/);
    }
  });
});

describe('collector configuration', () => {
  const config = parse(readDeployFile('otel-collector/config.yaml')) as {
    receivers: { otlp: { protocols: Record<string, { endpoint: string }> } };
    extensions: { health_check: { endpoint: string } };
    exporters: Record<string, { traces_endpoint: string; headers: Record<string, string> }>;
    service: { pipelines: Record<string, { exporters: string[] }> };
  };

  it('receives OTLP over HTTP only and sends traces to Langfuse v4', () => {
    expect(Object.keys(config.receivers.otlp.protocols)).toEqual(['http']);
    expect(config.extensions.health_check.endpoint).toBe('127.0.0.1:13133');
    const exporter = config.exporters['otlp_http/langfuse']!;
    expect(exporter.traces_endpoint).toBe('http://langfuse-web:3000/api/public/otel/v1/traces');
    expect(exporter.headers).toEqual({
      Authorization: 'Basic ${env:LANGFUSE_OTLP_AUTH}',
      'x-langfuse-ingestion-version': '4',
    });
    expect(Object.keys(config.service.pipelines)).toEqual(['traces']);
  });
});

describe('SDLC_OTEL_ENDPOINT', () => {
  it('is empty by default for the api, the worker and the LiteLLM sidecar', () => {
    for (const name of ['sdlc-api', 'sdlc-worker', 'litellm-agent']) {
      expect(compose.services[name]?.environment?.SDLC_OTEL_ENDPOINT, name).toBe(
        '${SDLC_OTEL_ENDPOINT:-}',
      );
    }
  });

  it('turns on LiteLLM langfuse_otel in the template only when set', () => {
    const template = readDeployFile('litellm/config.ctmpl');
    const blocks = [
      ...template.matchAll(/\{\{- with env "SDLC_OTEL_ENDPOINT" \}\}([\s\S]*?)\{\{- end \}\}/g),
    ];
    expect(blocks.map((b) => b[1]).join('')).toContain('callbacks: ["langfuse_otel"]');
    expect(template.match(/langfuse_otel"\]/g)).toHaveLength(1);
    expect(template).not.toMatch(/LANGFUSE_(PUBLIC|SECRET)_KEY/);
  });

  describe('up.sh', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-up-otel-'));
    afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));
    // A fake `docker` that prints the endpoint it was given (stderr: the first call is captured by
    // `$(...)`), then stops the script.
    fs.writeFileSync(
      path.join(tmp, 'docker'),
      [
        '#!/bin/sh',
        // E08: `docker volume ls` (Langfuse's ClickHouse volume) answers FAKE_VOLUME.
        'if [ "$1" = volume ]; then [ -n "${FAKE_VOLUME:-}" ] && echo "$FAKE_VOLUME"; exit 0; fi',
        'echo "otel=${SDLC_OTEL_ENDPOINT:-unset} langfuse=${SDLC_WORKER_LANGFUSE_URL:-unset}" >&2',
        'exit 3',
        '',
      ].join('\n'),
      { mode: 0o755 },
    );
    const run = (profiles: string[], envFile: string, env: Record<string, string> = {}) => {
      const file = path.join(tmp, 'env');
      fs.writeFileSync(file, envFile);
      return spawnSync('sh', [path.join(deployDir, 'scripts/up.sh'), ...profiles], {
        encoding: 'utf8',
        env: { PATH: `${tmp}:/usr/bin:/bin`, SDLC_ENV_FILE: file, ...env },
      }).stderr;
    };

    it('points at the collector when observability is in the same call', () => {
      expect(run(['core', 'observability', 'platform'], 'SDLC_OTEL_ENDPOINT=\n')).toContain(
        'otel=http://otel-collector:4318',
      );
    });

    it('stays off without observability', () => {
      expect(run(['core', 'platform'], 'SDLC_OTEL_ENDPOINT=\n')).toContain('otel=unset');
    });

    it("E08: turns the worker's Langfuse purge on with observability, keeps a set value", () => {
      expect(run(['core', 'observability', 'platform'], '')).toContain(
        'langfuse=http://langfuse-web:3000',
      );
      expect(run(['core', 'platform'], '')).toContain('langfuse=unset');
      expect(
        run(['core', 'observability'], 'SDLC_WORKER_LANGFUSE_URL=http://file:3000\n'),
      ).toContain('langfuse=unset');
      expect(run(['core', 'observability'], '', { SDLC_WORKER_LANGFUSE_URL: 'off' })).toContain(
        'langfuse=off',
      );
    });

    it("E08: keeps the Langfuse purge on when Langfuse's ClickHouse volume exists", () => {
      const out = run(['core', 'platform'], 'COMPOSE_PROJECT_NAME=sdlc\n', {
        FAKE_VOLUME: 'sdlc_clickhouse-data',
      });
      expect(out).toContain('langfuse=http://langfuse-web:3000');
      // The project's own ClickHouse volume, by its Compose labels.
      const upScript = fs.readFileSync(path.join(deployDir, 'scripts/up.sh'), 'utf8');
      expect(upScript).toContain('--filter "label=com.docker.compose.project=${project:-deploy}"');
      expect(upScript).toContain('--filter label=com.docker.compose.volume=clickhouse-data');
      // Without the volume it stays off; an explicit value always wins.
      expect(run(['core', 'platform'], 'COMPOSE_PROJECT_NAME=sdlc\n')).toContain('langfuse=unset');
      expect(
        run(['core', 'platform'], 'SDLC_WORKER_LANGFUSE_URL=off\n', {
          FAKE_VOLUME: 'sdlc_clickhouse-data',
        }),
      ).toContain('langfuse=unset');
    });

    it('keeps a value from the environment or the env file', () => {
      expect(
        run(['core', 'observability'], '', { SDLC_OTEL_ENDPOINT: 'http://other:4318' }),
      ).toContain('otel=http://other:4318');
      expect(run(['core', 'observability'], 'SDLC_OTEL_ENDPOINT=http://file:4318\n')).toContain(
        'otel=unset',
      );
    });
  });
});
