// D-08 C02 AC1: the signed form of a Run Contract (ADR-M22 section 2.2): RFC 8785 canonical JSON,
// stable across key order and a jsonb round trip; set-like lists are sorted and unique.
import { createHash } from 'node:crypto';

import { canonicalJson } from '@sdlc/config';
import type { RunContract } from '@sdlc/contracts';
import { describe, expect, it } from 'vitest';

import {
  allowedTools,
  runContractBytes,
  runContractSha256,
  sortedUnique,
} from '../../packages/core/src/run-contract/index.js';
import { SAMPLE_CONTRACT } from './helpers';

const text = (c: RunContract) => new TextDecoder().decode(runContractBytes(c));

describe('canonical bytes (AC1)', () => {
  it('are the RFC 8785 canonical JSON of the contract', () => {
    expect(text(SAMPLE_CONTRACT)).toBe(canonicalJson(SAMPLE_CONTRACT));
    expect(text(SAMPLE_CONTRACT)).toMatch(/^\{"agent_id":"6{8}-/);
    expect(text(SAMPLE_CONTRACT)).not.toMatch(/\s"/);
  });

  it('do not depend on key order', () => {
    const reversed = Object.fromEntries(Object.entries(SAMPLE_CONTRACT).reverse()) as RunContract;
    expect(text(reversed)).toBe(text(SAMPLE_CONTRACT));
  });

  it('survive a round trip through JSON text (jsonb stores strings, integers and arrays)', () => {
    const roundTrip = JSON.parse(JSON.stringify(SAMPLE_CONTRACT, null, 2)) as RunContract;
    expect(runContractSha256(roundTrip)).toBe(runContractSha256(SAMPLE_CONTRACT));
  });

  it('change when any field changes', () => {
    expect(runContractSha256({ ...SAMPLE_CONTRACT, max_iterations: 41 })).not.toBe(
      runContractSha256(SAMPLE_CONTRACT),
    );
  });

  it('hash to contract_sha256 (SHA-256, lowercase hex)', () => {
    const expected = createHash('sha256').update(canonicalJson(SAMPLE_CONTRACT)).digest('hex');
    expect(runContractSha256(SAMPLE_CONTRACT)).toBe(expected);
  });
});

describe('set-like lists', () => {
  it('sortedUnique sorts and removes duplicates', () => {
    expect(sortedUnique(['github.com', 'api.github.com', 'github.com'])).toEqual([
      'api.github.com',
      'github.com',
    ]);
  });

  it('allowed_tools is the intersection of the agent and plan task tools (QUESTIONS #34)', () => {
    expect(
      allowedTools(['shell:test', 'git', 'editor', 'browser'], ['editor', 'git', 'deploy']),
    ).toEqual(['editor', 'git']);
    expect(allowedTools(['git'], [])).toEqual([]);
  });
});
