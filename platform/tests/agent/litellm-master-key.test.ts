// E07 AC4 (Harry, review of PR #161): `pnpm test:agent-api` reads the LiteLLM master key from the
// configuration the OpenBao sidecar rendered. The rendered configuration holds the master key and
// the provider keys: it is never logged or printed, and no error carries a key, a configuration
// line or the failed command's output.
import { inspect } from 'node:util';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  MasterKeyReadError,
  RENDERED_CONFIG,
  readRenderedMasterKey,
  type ContainerFileReader,
} from '../integration/agent/litellm-master-key.js';

// Fake values, built at run time (never a key-shaped literal in the repository).
const MASTER = `sk-${'m'.repeat(8)}${String(Date.now())}`;
const PROVIDER = `sk-ant-${'p'.repeat(8)}${String(Date.now())}`;
const SALT = `sk-${'s'.repeat(8)}${String(Date.now())}`;
const CONFIG = [
  'model_list:',
  '  - model_name: claude-haiku-4-5-20251001',
  '    litellm_params:',
  '      model: anthropic/claude-haiku-4-5-20251001',
  `      api_key: ${JSON.stringify(PROVIDER)}`,
  'general_settings:',
  `  master_key: ${JSON.stringify(MASTER)}`,
  'environment_variables:',
  `  LITELLM_SALT_KEY: ${JSON.stringify(SALT)}`,
  '',
].join('\n');
const SECRETS = [MASTER, PROVIDER, SALT];

/** Everything written to the console and to stdout/stderr while `fn` runs. */
function captureOutput(fn: () => void): string {
  const out: string[] = [];
  const record = (...args: unknown[]) => {
    out.push(args.map((a) => (typeof a === 'string' ? a : inspect(a))).join(' '));
    return true;
  };
  const spies = [
    vi.spyOn(console, 'log').mockImplementation(record),
    vi.spyOn(console, 'info').mockImplementation(record),
    vi.spyOn(console, 'warn').mockImplementation(record),
    vi.spyOn(console, 'error').mockImplementation(record),
    vi.spyOn(console, 'debug').mockImplementation(record),
    vi.spyOn(process.stdout, 'write').mockImplementation(record),
    vi.spyOn(process.stderr, 'write').mockImplementation(record),
  ];
  try {
    fn();
  } catch {
    // the caller checks the error separately
  } finally {
    for (const spy of spies) spy.mockRestore();
  }
  return out.join('\n');
}

/** Every text a test runner could show for an error: message, stack, own properties, cause. */
function everythingAbout(error: unknown): string {
  return [
    String(error),
    (error as Error).stack ?? '',
    inspect(error, { depth: 5 }),
    JSON.stringify(error),
  ].join('\n');
}

function thrown(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error('expected an error');
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('E07: the LiteLLM master key of test:agent-api', () => {
  it('reads the rendered configuration of the container and returns only the master key, redacted', () => {
    const read = vi.fn<ContainerFileReader>(() => CONFIG);
    const key = readRenderedMasterKey('dev-litellm-1', read);
    expect(read).toHaveBeenCalledWith('dev-litellm-1', RENDERED_CONFIG);
    expect(key.reveal()).toBe(MASTER);
    for (const shown of [String(key), JSON.stringify({ key }), inspect(key), [key].join('')]) {
      for (const secret of SECRETS) expect(shown).not.toContain(secret);
    }
  });

  it('never logs or prints the configuration', () => {
    const output = captureOutput(() => readRenderedMasterKey('c', () => CONFIG));
    expect(output).toBe('');
  });

  it('a failed read: a fixed message, no cause, no output of the command', () => {
    const failure = Object.assign(new Error(`Command failed: docker exec c cat\n${CONFIG}`), {
      stdout: CONFIG,
      stderr: `master_key: ${MASTER}`,
      status: 1,
    });
    let error: unknown;
    const output = captureOutput(() => {
      error = thrown(() =>
        readRenderedMasterKey('c', () => {
          throw failure;
        }),
      );
    });
    expect(error).toBeInstanceOf(MasterKeyReadError);
    expect((error as Error).cause).toBeUndefined();
    const text = everythingAbout(error);
    for (const secret of SECRETS) expect(text).not.toContain(secret);
    expect(text).not.toContain('api_key');
    expect(output).toBe('');
  });

  it('a configuration without a master key: a fixed message that holds no configuration line', () => {
    const withoutMaster = CONFIG.replace(/^ {2}master_key:.*$/m, '');
    const error = thrown(() => readRenderedMasterKey('c', () => withoutMaster));
    expect(error).toBeInstanceOf(MasterKeyReadError);
    const text = everythingAbout(error);
    for (const secret of SECRETS) expect(text).not.toContain(secret);
    expect(text).not.toContain('model_list');
  });

  it('a master key that is not an sk- key is refused, not returned', () => {
    const odd = CONFIG.replace(/master_key: .*/, 'master_key: "plain-value-1234567890"');
    const error = thrown(() => readRenderedMasterKey('c', () => odd));
    expect(error).toBeInstanceOf(MasterKeyReadError);
    expect(everythingAbout(error)).not.toContain('plain-value-1234567890');
  });
});
