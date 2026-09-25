// C04 input without Docker: the hardening flags and parsers of the spike sandbox.
import { describe, expect, it } from 'vitest';

import { parseEnvFile, requireValue } from '../src/env-file.ts';
import {
  AGENT_SERVER_IMAGE,
  buildRelayRunArgs,
  buildSandboxRunArgs,
  parseProcNetTcp,
  parseStats,
  POC_SANDBOX_LIMITS,
  SANDBOX_NETWORK,
  type SandboxEnvName,
} from '../src/sandbox.ts';
import { loadSpikeSettings, realRunBudgetUsd } from '../src/spike-settings.ts';

const base = {
  name: 'sdlc-poc-x',
  runId: 'r1',
  env: { SESSION_API_KEY: 's', DO_NOT_TRACK: '1' },
  limits: POC_SANDBOX_LIMITS,
  readOnlyRoot: true,
};

function flagValue(args: string[], flag: string): string[] {
  return args.flatMap((a, i) => (a === flag ? [args[i + 1] ?? ''] : []));
}

describe('sandbox docker run arguments', () => {
  const args = buildSandboxRunArgs(base);

  it('uses the pinned image by digest', () => {
    expect(args.at(-1)).toBe(AGENT_SERVER_IMAGE);
    expect(AGENT_SERVER_IMAGE).toMatch(/:1\.48\.0-python-slim@sha256:[0-9a-f]{64}$/);
  });

  it('joins only the internal sandbox network and publishes no port', () => {
    expect(flagValue(args, '--network')).toEqual([SANDBOX_NETWORK]);
    expect(args).not.toContain('--publish');
    expect(args).not.toContain('-p');
  });

  it('drops all capabilities, blocks privilege gain, runs as the image user, sets limits', () => {
    expect(flagValue(args, '--cap-drop')).toEqual(['ALL']);
    expect(flagValue(args, '--security-opt')).toEqual(['no-new-privileges:true']);
    expect(flagValue(args, '--user')).toEqual(['10001:10001']);
    expect(flagValue(args, '--memory')).toEqual([POC_SANDBOX_LIMITS.memory]);
    expect(flagValue(args, '--pids-limit')).toEqual([String(POC_SANDBOX_LIMITS.pids)]);
  });

  it('never mounts the Docker socket or host directories', () => {
    expect(args).not.toContain('--volume');
    expect(args).not.toContain('-v');
    expect(args.join(' ')).not.toContain('docker.sock');
  });

  it('read-only root: tmpfs for /tmp (with exec), /workspace and the home directory', () => {
    expect(args).toContain('--read-only');
    const tmpfs = flagValue(args, '--tmpfs');
    expect(tmpfs.find((t) => t.startsWith('/tmp:'))).toContain('exec');
    expect(tmpfs.some((t) => t.startsWith('/workspace:'))).toBe(true);
    expect(tmpfs.some((t) => t.startsWith('/home/openhands:'))).toBe(true);
    expect(buildSandboxRunArgs({ ...base, readOnlyRoot: false })).not.toContain('--read-only');
  });

  it('passes only allowlisted environment variables (FR-33)', () => {
    expect(flagValue(args, '--env')).toEqual(['SESSION_API_KEY=s', 'DO_NOT_TRACK=1']);
    const bad = {
      ...base,
      env: { ANTHROPIC_API_KEY: 'x' } as Partial<Record<SandboxEnvName, string>>,
    };
    expect(() => buildSandboxRunArgs(bad)).toThrow(/not allowed/);
  });

  it('relay publishes the API port on 127.0.0.1 only', () => {
    const relay = buildRelayRunArgs('relay', 'sdlc-poc-x', '/src');
    expect(flagValue(relay, '--publish')).toEqual(['127.0.0.1::8000']);
    expect(flagValue(relay, '--env')).toEqual(['RELAY_TARGET=sdlc-poc-x:8000']);
    expect(relay).toContain('--read-only');
  });
});

describe('parsers', () => {
  it('reads listening sockets from /proc/net/tcp', () => {
    const text = [
      '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode',
      '   0: 0B00007F:A065 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 1 1',
      '   1: 00000000:1F40 00000000:0000 0A 00000000:00000000 00:00000000 00000000 10001        0 2 1',
      '   2: 0100007F:1F40 0100007F:D000 01 00000000:00000000 00:00000000 00000000 10001        0 3 1',
    ].join('\n');
    expect(parseProcNetTcp(text)).toEqual([
      { address: '127.0.0.11', port: 41061, uid: 0 },
      { address: '0.0.0.0', port: 8000, uid: 10001 },
    ]);
  });

  it('reads docker stats output', () => {
    expect(parseStats('512MiB / 2GiB|1.50%')).toEqual({
      memoryBytes: 512 * 1024 ** 2,
      cpuPercent: 1.5,
    });
  });

  it('reads the environment file without exposing it', () => {
    const values = parseEnvFile('# comment\nA=1\nB="two"\n\nC=\n');
    expect(values.get('A')).toBe('1');
    expect(values.get('B')).toBe('two');
    expect(() => requireValue(values, 'C')).toThrow(/C is missing/);
  });
});

describe('spike settings', () => {
  it('takes handbook values from config and caps the real run at USD 1.00', () => {
    const settings = loadSpikeSettings();
    expect(settings.identicalToolCallsMax).toBe(3);
    expect(settings.budgetWarnPercent).toBe(80);
    expect(realRunBudgetUsd(settings)).toBeLessThanOrEqual(1);
  });
});
