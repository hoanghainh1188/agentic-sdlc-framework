// X03 (ADR-M68 §5, ADR-M88 §2.2; QUESTIONS #522, #524): static checks of the sandbox image
// node24-opencode (no Docker needed), and of its licence check of OpenCode's dependency tree.
// - Built FROM node24 by digest; the OpenCode binary pinned by sha512 integrity for both
//   architectures; one version everywhere (the binary, the label, the licence check).
// - The image contract of ADR-M25 §2.3, the labels of ADR-M68 §7, no secret baked in.
// - The entry script makes the session key the server password and removes the Agent Server's
//   variables; the configuration file allows no provider but LiteLLM and holds no key.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

import { root } from './compose';

const DIR = 'platform/sandbox-images/node24-opencode';
const read = (relative: string) => fs.readFileSync(path.join(root, relative), 'utf8');
const dockerfile = read(`${DIR}/Dockerfile`);
const code = dockerfile
  .split('\n')
  .filter((line) => !line.trim().startsWith('#'))
  .join('\n');

interface LicenceModule {
  VERSION: string;
  allowedExpression(expression: string): boolean;
  parseBunLock(text: string): unknown;
  runtimeTree(
    lock: unknown,
    workspace: string,
  ): { packages: { name: string; version: string }[]; unresolved: string[] };
  licenceOf(manifest: unknown): string | undefined;
  ancestors(key: string): string[];
}
let licences: LicenceModule;
beforeAll(async () => {
  licences = (await import(
    pathToFileURL(path.join(root, DIR, 'licences.mjs')).href
  )) as LicenceModule;
});

describe('sandbox image node24-opencode', () => {
  it('builds FROM the node24 image given by the build (no default)', () => {
    expect(code).toMatch(/^ARG NODE24$/m);
    expect(code).toMatch(/^FROM \$\{NODE24\}$/m);
    expect(code.match(/^FROM /gm)).toHaveLength(1);
  });

  it('pins the OpenCode binary by sha512 integrity for amd64 and arm64, one version', () => {
    expect(code).toMatch(/amd64\) pkg=opencode-linux-x64; sri='[A-Za-z0-9+/]{86}=='/);
    expect(code).toMatch(/arm64\) pkg=opencode-linux-arm64; sri='[A-Za-z0-9+/]{86}=='/);
    expect(code).toContain(
      'test "$(openssl dgst -sha512 -binary /tmp/oc.tgz | base64 -w0)" = "$sri"',
    );
    expect(code).toContain(`-${licences.VERSION}.tgz"`);
    expect(code).toContain(`opencode --version)" = ${licences.VERSION}`);
    expect(code).toMatch(
      new RegExp(`sdlc\\.agent\\.version=${licences.VERSION.replace(/\./g, '\\.')}$`, 'm'),
    );
    expect(code).toMatch(/LABEL sdlc\.agent\.adapter=opencode /);
  });

  it('honours the image contract: user 10001, a health check, its own entry script', () => {
    expect(code).toMatch(/^USER 10001:10001$/m);
    expect(code).toMatch(/^HEALTHCHECK /m);
    expect(code).toMatch(/127\.0\.0\.1:8000/);
    expect(code).toMatch(/^ENTRYPOINT \["tini", "--", "\/opt\/sdlc\/entry\.sh"\]$/m);
  });

  it('turns off every download and telemetry switch; bakes in no secret', () => {
    for (const name of [
      'OPENCODE_DISABLE_AUTOUPDATE',
      'OPENCODE_DISABLE_MODELS_FETCH',
      'OPENCODE_DISABLE_LSP_DOWNLOAD',
      'OPENCODE_DISABLE_DEFAULT_PLUGINS',
      'OPENCODE_DISABLE_CLAUDE_CODE',
      'OPENCODE_DISABLE_SHARE',
    ]) {
      expect(code).toContain(`${name}=true`);
    }
    expect(code).not.toMatch(/ARG .*(PASSWORD|TOKEN|SECRET|KEY)|_KEY=|PASSWORD=/);
    expect(code).not.toMatch(/NPM_CONFIG_REGISTRY|COREPACK_NPM_REGISTRY/); // set by the runner
  });

  it('entry.sh makes the session key the server password and drops the sandbox variables', () => {
    const entry = read(`${DIR}/entry.sh`);
    expect(entry).toContain('export OPENCODE_SERVER_PASSWORD="$SESSION_API_KEY"');
    expect(entry).toMatch(/^unset SESSION_API_KEY OH_SECRET_KEY /m);
    // The image's settings rank above a repository's opencode.json.
    expect(entry).toContain('OPENCODE_CONFIG_CONTENT="$(cat /opt/sdlc/opencode.json)"');
    expect(entry).toMatch(/^export OPENCODE_CONFIG_CONTENT$/m);
    expect(entry).toMatch(/^exec opencode serve --hostname 0\.0\.0\.0 --port 8000$/m);
    expect(entry).toMatch(/^cd \/workspace$/m);
  });

  it('opencode.json: LiteLLM is the only provider, no key, no web fetch, no update, no sharing', () => {
    const config = JSON.parse(read(`${DIR}/opencode.json`)) as Record<string, unknown>;
    expect(config.enabled_providers).toEqual(['litellm']);
    expect(config.provider).toBeUndefined();
    expect(config.autoupdate).toBe(false);
    expect(config.share).toBe('disabled');
    expect(config.permission).toMatchObject({
      webfetch: 'deny',
      websearch: 'deny',
      doom_loop: 'deny',
    });
    expect(config.mcp).toEqual({});
  });

  it('opencode.json: no permission asks (nobody answers a question in a run)', () => {
    const config = JSON.parse(read(`${DIR}/opencode.json`)) as {
      permission: Record<string, unknown>;
    };
    expect(JSON.stringify(config.permission)).not.toContain('"ask"');
    expect(config.permission.external_directory).toMatchObject({ '*': 'deny' });
  });

  it('build.sh needs NODE24 for an image built on node24, pinned by digest when it pushes', () => {
    const build = read('platform/sandbox-images/build.sh');
    expect(build).toContain("grep -q '^ARG NODE24$'");
    expect(build).toContain('NODE24 must be pinned by digest');
    expect(build).toContain('--build-arg "NODE24=$base"');
  });
});

describe('licences.mjs (QUESTIONS #524)', () => {
  it('allows permissive licences and MPL-2.0; never the GPL family, AGPL, SSPL or none', () => {
    for (const ok of [
      'MIT',
      'apache-2.0',
      '(MIT OR CC0-1.0)',
      'BSD-3-Clause AND ISC',
      '(AFL-2.1 OR BSD-3-Clause)',
      'MPL-2.0',
    ]) {
      expect(licences.allowedExpression(ok), ok).toBe(true);
    }
    for (const bad of [
      'GPL-3.0',
      'AGPL-3.0-only',
      'SSPL-1.0',
      'MIT AND GPL-2.0',
      'UNLICENSED',
      '',
      'MIT OR',
      '(MIT',
      'SEE LICENSE IN x',
    ]) {
      expect(licences.allowedExpression(bad), bad).toBe(false);
    }
  });

  it('reads the licence field in its old and new shapes', () => {
    expect(licences.licenceOf({ license: 'MIT' })).toBe('MIT');
    expect(licences.licenceOf({ license: { type: 'ISC' } })).toBe('ISC');
    expect(licences.licenceOf({ licenses: [{ type: 'MIT' }, { type: 'Apache-2.0' }] })).toBe(
      'MIT OR Apache-2.0',
    );
    expect(licences.licenceOf({})).toBeUndefined();
  });

  it('walks the runtime tree: nested versions, workspaces, optional deps; no dev deps', () => {
    const lock = licences.parseBunLock(`{
      "workspaces": {
        "packages/opencode": { "name": "opencode", "dependencies": { "a": "1", "@x/lib": "workspace:*" }, "devDependencies": { "dev": "1" } },
        "packages/lib": { "name": "@x/lib", "dependencies": { "c": "1" }, "optionalDependencies": { "opt": "1" } },
      },
      "packages": {
        "a": ["a@1.0.0", "", { "dependencies": { "b": "^2" } }, "sha512-x"],
        "b": ["b@3.0.0", "", {}, "sha512-x"],
        "a/b": ["b@2.0.0", "", {}, "sha512-x"],
        "c": ["c@1.0.0", "", { "dependencies": { "b": "^3" } }, "sha512-x"],
        "opt": ["opt@1.0.0", "", {}, "sha512-x"],
        "dev": ["dev@1.0.0", "", {}, "sha512-x"],
        "@x/lib": ["@x/lib@workspace:packages/lib"],
      },
    }`);
    const tree = licences.runtimeTree(lock, 'packages/opencode');
    expect(tree.packages.map((p) => `${p.name}@${p.version}`).sort()).toEqual([
      'a@1.0.0',
      'b@2.0.0',
      'b@3.0.0',
      'c@1.0.0',
      'opt@1.0.0',
    ]);
    expect(tree.unresolved).toEqual([]);
  });

  it('walks up a scoped name as one step (review of X03 PR 2)', () => {
    expect(licences.ancestors('a/@s/b')).toEqual(['a/@s/b', 'a', '']);
    const lock = licences.parseBunLock(`{
      "workspaces": { "w": { "name": "w", "dependencies": { "@s/p": "1" } } },
      "packages": {
        "@s/p": ["@s/p@1.0.0", "", { "dependencies": { "foo": "1" } }, "sha512-x"],
        "@s/foo": ["@s/foo@9.0.0", "", {}, "sha512-x"],
        "foo": ["foo@1.0.0", "", {}, "sha512-x"],
      },
    }`);
    expect(
      licences
        .runtimeTree(lock, 'w')
        .packages.map((p) => `${p.name}@${p.version}`)
        .sort(),
    ).toEqual(['@s/p@1.0.0', 'foo@1.0.0']);
  });

  it('keeps every reviewed exception documented with its source', () => {
    const exceptions = JSON.parse(read(`${DIR}/licence-exceptions.json`)) as Record<
      string,
      { licence: string; source: string; reviewed: string }
    >;
    for (const [spec, entry] of Object.entries(exceptions)) {
      expect(spec).toMatch(/^.+@\d+\.\d+\.\d+.*$/);
      expect(licences.allowedExpression(entry.licence)).toBe(true);
      expect(entry.source).toMatch(/^https:\/\/github\.com\//);
      expect(entry.reviewed).toMatch(/^\d{4}-\d{2}-\d{2}/);
    }
  });
});
