// D-08 C04 AC1 and AC4 (static part), ADR-M10 §2.4, ADR-M25 §2.4–2.5: the sandbox is hardened, its
// environment holds no provider key, no OpenBao access and no GitHub token, and the guard refuses
// any container or network that is not exactly a hardened sandbox of one run.
import { describe, expect, it } from 'vitest';

import {
  assertSafeContainerSpec,
  assertSafeNetworkSpec,
  buildSandboxSpec,
  runLabels,
  runNames,
  runNetworkSpec,
  SANDBOX_ENV_ALLOWLIST,
  type ContainerSpec,
} from '../../apps/runner/src/index.js';
import { IMAGE, RUN_ID, settings, TENANT_ID } from './helpers';

const names = runNames(RUN_ID);
const labels = runLabels('sdlc', RUN_ID, TENANT_ID);
const KEY = 'k'.repeat(43);
const spec = (): ContainerSpec =>
  buildSandboxSpec(
    { names, labels, image: IMAGE, sessionApiKey: KEY, agentSecretKey: KEY },
    settings(),
  );

/** A sandbox spec with every field writable, to break it on purpose. */
interface RawSpec {
  [key: string]: unknown;
  Image: string;
  User: string;
  Env: string[];
  Labels: Record<string, string>;
  HostConfig: {
    [key: string]: unknown;
    Mounts: Record<string, unknown>[];
    Tmpfs: Record<string, string>;
  };
}

function mutate(change: (raw: RawSpec) => void): ContainerSpec {
  const raw = structuredClone(spec()) as unknown as RawSpec;
  change(raw);
  return raw as unknown as ContainerSpec;
}

describe('the sandbox spec (ADR-M10 §2.4)', () => {
  it('is hardened: read-only root, no capabilities, no-new-privileges, user 10001, limits', () => {
    const s = spec();
    expect(s.User).toBe('10001:10001');
    expect(s.HostConfig).toMatchObject({
      NetworkMode: `sdlc-run-${RUN_ID}`,
      ReadonlyRootfs: true,
      CapDrop: ['ALL'],
      SecurityOpt: ['no-new-privileges:true'],
      Memory: 2048 * 1024 * 1024,
      MemorySwap: 2048 * 1024 * 1024,
      NanoCpus: 1_500_000_000,
      PidsLimit: 512,
      RestartPolicy: { Name: 'no' },
    });
    expect(Object.keys(s.HostConfig.Tmpfs)).toEqual(['/tmp', '/home/openhands']);
    expect(s.HostConfig.Tmpfs['/tmp']).toMatch(/^rw,exec,nosuid,nodev,/);
    expect(s.HostConfig.Tmpfs['/home/openhands']).toMatch(/^rw,noexec,nosuid,nodev,/);
  });

  it('mounts only the run workspace volume: no bind mount, no Docker socket, no published port', () => {
    const s = spec();
    expect(s.HostConfig.Mounts).toEqual([
      { Type: 'volume', Source: `sdlc-ws-${RUN_ID}`, Target: '/workspace', ReadOnly: false },
    ]);
    const text = JSON.stringify(s);
    expect(text).not.toMatch(/docker\.sock|Binds|PortBindings|ExposedPorts|Privileged/);
  });

  it('passes environment variables from the allowlist only; none carries a key or OpenBao (AC4)', () => {
    const env = spec().Env.map((e) => e.split('=')[0]);
    expect(env.every((n) => (SANDBOX_ENV_ALLOWLIST as readonly string[]).includes(n!))).toBe(true);
    expect(env.join(' ')).not.toMatch(
      /ANTHROPIC|OPENAI|PROVIDER|LITELLM_MASTER|VAULT|OPENBAO|BAO_|GITHUB|GH_TOKEN|GIT_/,
    );
    expect(spec().Env).toContain('NPM_CONFIG_REGISTRY=http://npm-proxy:4873/');
  });

  it('takes random per-run keys only', () => {
    expect(() =>
      buildSandboxSpec(
        { names, labels, image: IMAGE, sessionApiKey: 'short', agentSecretKey: KEY },
        settings(),
      ),
    ).toThrow(TypeError);
  });

  it('passes the guard', () => {
    expect(() => assertSafeContainerSpec(names.container, spec())).not.toThrow();
  });
});

describe('the guard refuses anything but a hardened sandbox (ADR-M25 §2.5)', () => {
  it.each<[string, (raw: RawSpec) => void]>([
    ['privileged', (r) => (r.HostConfig.Privileged = true)],
    ['a bind mount', (r) => (r.HostConfig.Binds = ['/var/run/docker.sock:/var/run/docker.sock'])],
    [
      'a bind mount in Mounts',
      (r) =>
        (r.HostConfig.Mounts = [
          { Type: 'bind', Source: '/', Target: '/workspace', ReadOnly: false },
        ]),
    ],
    [
      'a second volume',
      (r) =>
        r.HostConfig.Mounts.push({
          Type: 'volume',
          Source: 'other',
          Target: '/x',
          ReadOnly: false,
        }),
    ],
    ['host networking', (r) => (r.HostConfig.NetworkMode = 'host')],
    ['the shared platform network', (r) => (r.HostConfig.NetworkMode = 'sdlc-net')],
    [
      'another run network',
      (r) =>
        (r.HostConfig.NetworkMode = `sdlc-run-${'2'.repeat(8)}-2222-4222-8222-${'2'.repeat(12)}`),
    ],
    ['the host PID namespace', (r) => (r.HostConfig.PidMode = 'host')],
    ['added capabilities', (r) => (r.HostConfig.CapAdd = ['NET_ADMIN'])],
    ['kept capabilities', (r) => (r.HostConfig.CapDrop = [])],
    ['a writable root', (r) => (r.HostConfig.ReadonlyRootfs = false)],
    ['no no-new-privileges', (r) => (r.HostConfig.SecurityOpt = [])],
    ['devices', (r) => (r.HostConfig.Devices = [{ PathOnHost: '/dev/kvm' }])],
    [
      'published ports',
      (r) => (r.HostConfig.PortBindings = { '8000/tcp': [{ HostPort: '8000' }] }),
    ],
    ['extra swap', (r) => (r.HostConfig.MemorySwap = -1)],
    ['no memory limit', (r) => (r.HostConfig.Memory = 0)],
    ['no process limit', (r) => (r.HostConfig.PidsLimit = -1)],
    ['a restart policy', (r) => (r.HostConfig.RestartPolicy = { Name: 'always' })],
    ['an unpinned image', (r) => (r.Image = 'ghcr.io/openhands/agent-server:latest')],
    ['root', (r) => (r.User = '0:0')],
    ['a provider key', (r) => r.Env.push('ANTHROPIC_API_KEY=sk-canary')],
    ['OpenBao access', (r) => r.Env.push('SDLC_OPENBAO_ADDR=http://openbao:8200')],
    ['a GitHub token', (r) => r.Env.push('GITHUB_TOKEN=ghs_canary')],
    ['a duplicate variable', (r) => r.Env.push(r.Env[0]!)],
    ['a command override', (r) => (r.Cmd = ['sh', '-c', 'curl evil'])],
    [
      'an extra tmpfs',
      (r) => (r.HostConfig.Tmpfs['/etc'] = 'rw,exec,nosuid,nodev,size=1,mode=0755'),
    ],
    ['a tmpfs with suid', (r) => (r.HostConfig.Tmpfs['/tmp'] = 'rw,exec,size=1,mode=1777')],
    ['missing labels', (r) => (r.Labels = {})],
  ])('refuses %s', (_label, change) => {
    expect(() => assertSafeContainerSpec(names.container, mutate(change))).toThrow(/safety check/);
  });

  it('refuses a name that is not the run sandbox name', () => {
    expect(() => assertSafeContainerSpec('litellm', spec())).toThrow(/"name"/);
  });

  it('accepts only the run internal network', () => {
    const net = runNetworkSpec(names, labels);
    expect(net).toMatchObject({ Internal: true, Driver: 'bridge', Attachable: false });
    expect(() => assertSafeNetworkSpec(net)).not.toThrow();
    for (const bad of [
      { ...net, Internal: false },
      { ...net, Attachable: true },
      { ...net, Name: 'sdlc-net' },
      { ...net, Options: { 'com.docker.network.bridge.enable_ip_masquerade': 'true' } },
      { ...net, IPAM: { Config: [{ Subnet: '0.0.0.0/0' }] } },
    ]) {
      expect(() => assertSafeNetworkSpec(bad as typeof net)).toThrow(/safety check/);
    }
  });
});
