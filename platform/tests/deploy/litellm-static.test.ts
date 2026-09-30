// D-08 C03 AC1 (static part, no Docker): LiteLLM gets its keys from OpenBao through the OpenBao
// Agent sidecar (QUESTIONS #1 option B, design/ADR-M24). No provider key in .env, the repo, an
// image or LiteLLM's environment; the master key has one source. Live checks:
// platform/tests/integration/litellm/litellm-live.test.ts.
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse } from 'yaml';
import { afterAll, describe, expect, it } from 'vitest';

import {
  deployDir,
  loadCompose,
  parseEnvFile,
  readDeployFile,
  root,
  servicesInProfile,
} from './compose';

interface FullService {
  image?: string;
  profiles?: string[];
  environment?: Record<string, string>;
  volumes?: string[];
  ports?: string[];
  entrypoint?: string[];
  command?: string[];
  depends_on?: Record<string, { condition: string; required?: boolean }>;
}
interface FullCompose {
  services: Record<string, FullService>;
  volumes: Record<string, { driver?: string; driver_opts?: Record<string, string> } | null>;
}

const compose = parse(readDeployFile('docker-compose.yml'), { merge: true }) as FullCompose;
const litellm = compose.services.litellm!;
const agent = compose.services['litellm-agent']!;
const template = readDeployFile('litellm/config.ctmpl');
// Without comment lines: the comments explain what is left out.
const agentHcl = readDeployFile('litellm/agent.hcl')
  .split('\n')
  .filter((line) => !line.trim().startsWith('#'))
  .join('\n');
const policy = readDeployFile('openbao/bootstrap/policies/litellm.hcl');

/** Paths the template reads with `secret "…"` and lists with `secrets "…"`. */
const secretReads = [...template.matchAll(/\bsecret "([^"]+)"/g)].map((m) => m[1]!);
const secretLists = [...template.matchAll(/\bsecrets "([^"]+)"/g)].map((m) => m[1]!);

/** Anything that looks like a real provider or LiteLLM key. */
const KEY_PATTERN = /\bsk-(ant|proj|or|live)[-_][A-Za-z0-9_-]{8,}|\bsk-[A-Za-z0-9]{20,}/;

describe('AC1: the sidecar (Compose profile "models")', () => {
  it('the profile "models" holds only the sidecar; core is unchanged', () => {
    expect(servicesInProfile(loadCompose(), 'models')).toEqual(['litellm-agent']);
    expect(servicesInProfile(loadCompose(), 'core')).not.toContain('litellm-agent');
  });

  it('uses the pinned OpenBao image (bao agent), no published port', () => {
    expect(agent.image).toBe(compose.services.openbao!.image);
    expect(agent.command?.[0]).toBe('agent');
    expect(agent.ports).toBeUndefined();
    // The OTLP endpoint is not a secret; it only turns on LiteLLM's tracing (A08, ADR-M35).
    expect(agent.environment).toEqual({
      BAO_ADDR: 'http://openbao:8200',
      SDLC_OTEL_ENDPOINT: '${SDLC_OTEL_ENDPOINT:-}',
    });
  });

  it('renders into a tmpfs volume, mode 0600, and fails closed', () => {
    expect(compose.volumes['litellm-config']).toEqual({
      driver: 'local',
      driver_opts: { type: 'tmpfs', device: 'tmpfs', o: 'size=1m,uid=100,gid=1000,mode=0700' },
    });
    expect(agent.volumes).toContain('litellm-config:/run/litellm');
    expect(agentHcl).toMatch(/destination\s*=\s*"\/run\/litellm\/config\.yaml"/);
    expect(agentHcl).toMatch(/perms\s*=\s*"0600"/);
    expect(agentHcl).toMatch(/exit_on_retry_failure\s*=\s*true/);
    expect(agentHcl).toMatch(/error_on_missing_key\s*=\s*true/);
  });

  it('writes no token to disk (no sink) and reads its AppRole credentials from its volume', () => {
    expect(agentHcl).not.toMatch(/\bsink\b/);
    expect(agentHcl).toMatch(/method "approle"/);
    expect(agentHcl).toContain('/openbao/approle/role_id');
    expect(agentHcl).toContain('/openbao/approle/secret_id');
    expect(agent.volumes).toContain('litellm-approle:/openbao/approle');
  });

  it('LiteLLM waits for the sidecar when the profile is on, and reads the file read-only', () => {
    expect(litellm.depends_on?.['litellm-agent']).toEqual({
      condition: 'service_healthy',
      required: false,
    });
    expect(litellm.volumes).toContain('litellm-config:/run/litellm:ro');
    expect(litellm.entrypoint).toEqual(['sh', '/sdlc/start.sh']);
  });
});

describe('AC1: no provider key outside OpenBao', () => {
  it("LiteLLM's environment holds no provider key variable", () => {
    expect(Object.keys(litellm.environment ?? {}).sort()).toEqual([
      'DATABASE_URL',
      'LITELLM_MASTER_KEY',
      'LITELLM_SALT_KEY',
      'REDIS_HOST',
      'REDIS_PASSWORD',
      'REDIS_PORT',
      'STORE_MODEL_IN_DB',
    ]);
  });

  it('.env.example has no provider key variable', () => {
    const names = [...parseEnvFile(readDeployFile('.env.example')).keys()];
    expect(
      names.filter((n) => /ANTHROPIC|OPENAI|GEMINI|MISTRAL|PROVIDER|_API_KEY/.test(n)),
    ).toEqual([]);
  });

  it('no deploy file contains something that looks like a key', () => {
    const files = execFileSync('git', ['ls-files', '-z', '--', 'platform/deploy'], {
      cwd: root,
      encoding: 'utf8',
    })
      .split('\0')
      .filter(Boolean);
    expect(files.length).toBeGreaterThan(10);
    for (const file of files) {
      const text = fs.readFileSync(path.join(root, file), 'utf8');
      expect(KEY_PATTERN.test(text), file).toBe(false);
    }
  });

  it('the development config has no model and no key', () => {
    const dev = parse(readDeployFile('litellm/config.yaml')) as Record<string, unknown>;
    expect(dev.model_list).toEqual([]);
    expect(JSON.stringify(dev)).not.toMatch(/api_key/);
  });
});

describe('AC1: the template', () => {
  it('reads the master key from its one source and the salt key from OpenBao (QUESTIONS #1)', () => {
    expect(template).toMatch(
      /with secret "kv\/data\/cost-controller\/litellm-master-key" }}\n\s+master_key: {{ \.Data\.data\.value \| toJSON }}/,
    );
    expect(template).toMatch(
      /with secret "kv\/data\/litellm\/salt-key" }}\n\s+LITELLM_SALT_KEY: {{ \.Data\.data\.value \| toJSON }}/,
    );
  });

  it('reads provider keys only from kv/litellm/providers/, always through toJSON', () => {
    const providerReads = secretReads.filter((p) => p.includes('/providers/'));
    for (const p of providerReads) expect(p).toMatch(/^kv\/data\/litellm\/providers\/[a-z0-9-]+$/);
    const keyLines = template.split('\n').filter((l) => /api_key:/.test(l));
    for (const line of keyLines)
      expect(line.trim()).toBe('api_key: {{ .Data.data.api_key | toJSON }}');
    expect(secretLists).toEqual(['kv/metadata/litellm/providers/']);
  });

  it('every path the template reads or lists is allowed by the litellm policy', () => {
    const rules = [...policy.matchAll(/path "([^"]+)"\s*\{\s*capabilities\s*=\s*\[([^\]]*)\]/g)];
    const allows = (target: string, cap: string) =>
      rules.some(
        (r) =>
          r[2]!.includes(`"${cap}"`) &&
          (r[1] === target || (r[1]!.endsWith('*') && target.startsWith(r[1]!.slice(0, -1)))),
      );
    for (const p of secretReads) expect(allows(p, 'read'), p).toBe(true);
    for (const p of secretLists) expect(allows(p, 'list'), p).toBe(true);
  });

  it('the Ollama model (developer machines only) is a local tag, self-hosted, low reasoning (#78)', () => {
    const ollama = template.split(/\n\s+- model_name: /).find((m) => m.includes('ollama_chat/'));
    expect(ollama).toBeDefined();
    expect(ollama).toMatch(/model: ollama_chat\/gpt-oss:20b\n/);
    expect(template).not.toMatch(/ollama\S*:cloud|-cloud\b/);
    expect(ollama).toContain('api_base: {{ .Data.data.api_base | toJSON }}');
    expect(ollama).toContain('provider_type: self_hosted');
    expect(ollama).toContain('reasoning_effort: low');
    expect(ollama).toContain('num_ctx: 32768');
    expect(ollama).not.toContain('api_key');
  });

  it('every model declares a provider type; self-hosted models declare a cost above 0 (D-07)', () => {
    const models = template.split(/\n\s+- model_name: /).slice(1);
    expect(models.length).toBeGreaterThan(0);
    for (const model of models) {
      const type = /provider_type: (\S+)/.exec(model)?.[1];
      expect(['api', 'self_hosted'], model.split('\n')[0]).toContain(type);
      if (type === 'self_hosted') {
        for (const field of ['input_cost_per_token', 'output_cost_per_token']) {
          const value = Number(new RegExp(`${field}: (\\S+)`).exec(model)?.[1]);
          expect(value, `${model.split('\n')[0]} ${field}`).toBeGreaterThan(0);
        }
      }
    }
  });
});

describe('the live test template', () => {
  it('is the production template plus the stub model only', () => {
    const test = fs.readFileSync(
      path.join(root, 'platform/tests/integration/litellm/config.test.ctmpl'),
      'utf8',
    );
    const body = (text: string) => text.slice(text.indexOf('{{- $providers'));
    const stubBlock = /\{\{- if in \$providers "stub" \}\}[\s\S]*?\{\{- end \}\}\n\{\{- end \}\}\n/;
    expect(stubBlock.test(test)).toBe(true);
    expect(body(test).replace(stubBlock, '')).toBe(body(template));
  });
});

describe('litellm/start.sh', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-litellm-start-'));
  afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));
  // A fake `litellm` that prints its arguments and whether the keys are still in the environment.
  fs.writeFileSync(
    path.join(tmp, 'litellm'),
    '#!/bin/sh\necho "args=$* master=${LITELLM_MASTER_KEY:-unset}"\n',
    { mode: 0o755 },
  );
  const start = (env: Record<string, string>) =>
    spawnSync('sh', [path.join(deployDir, 'litellm/start.sh'), '--port', '4000'], {
      encoding: 'utf8',
      env: { PATH: `${tmp}:/usr/bin:/bin`, ...env },
    });

  it('without the rendered file and without a master key: refuses to start', () => {
    const r = start({});
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('no LITELLM_MASTER_KEY');
  });

  it('without the rendered file, with a development master key: uses config.yaml', () => {
    const r = start({ LITELLM_MASTER_KEY: 'sk-dev-only' });
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('args=--config /app/config.yaml --port 4000 master=sk-dev-only');
  });

  it('prefers the rendered file and drops the development keys', () => {
    const script = readDeployFile('litellm/start.sh');
    expect(script).toMatch(
      /if \[ -s "\$rendered" \]; then\n\s+unset LITELLM_MASTER_KEY LITELLM_SALT_KEY\n\s+exec litellm --config "\$rendered" "\$@"/,
    );
    expect(script).toContain('rendered=/run/litellm/config.yaml');
  });
});

describe('bootstrap.sh litellm-credentials', () => {
  const bootstrap = readDeployFile('openbao/bootstrap.sh');

  it('is listed in --help', () => {
    const r = spawnSync(path.join(deployDir, 'openbao/bootstrap.sh'), ['--help'], {
      encoding: 'utf8',
      env: { ...process.env, SDLC_ENV_FILE: '/nonexistent/.env' },
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('litellm-credentials');
  });

  it('pipes the credentials into the sidecar volume: no file on the host, nothing printed', () => {
    const body = bootstrap.slice(bootstrap.indexOf('cmd_litellm_credentials() {'));
    const fn = body.slice(0, body.indexOf('\n}\n'));
    expect(fn).toMatch(
      /compose --profile core --profile models run --rm -T --no-deps --user root --entrypoint sh \\\n\s+litellm-agent -c/,
    );
    expect(fn).toMatch(/umask 077/);
    expect(fn).not.toMatch(/\becho "\$(role_id|secret_id|token)"/);
    expect(fn).not.toMatch(/>\s*"?\$deploy_dir/);
  });
});
