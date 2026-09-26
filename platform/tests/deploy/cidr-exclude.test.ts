// Task A11 (design/QUESTIONS.md #37): OpenBao AppRoles are bound to the Compose subnet WITHOUT its
// gateway, because every host process reaches containers from the gateway. cidr-exclude.sh
// computes "subnet minus one address"; this test checks its output with an independent model.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { deployDir } from './compose';

const SCRIPT = path.join(deployDir, 'openbao/cidr-exclude.sh');

const exclude = (subnet: string, address: string) =>
  spawnSync(SCRIPT, [subnet, address], { encoding: 'utf8' });

const toInt = (quad: string): number =>
  quad.split('.').reduce((acc, octet) => acc * 256 + Number(octet), 0);

/** A CIDR block as a half-open range [start, end). */
function range(cidr: string): [number, number] {
  const [quad, bits] = cidr.split('/');
  const size = 2 ** (32 - Number(bits));
  const start = toInt(quad!);
  expect(start % size, `${cidr} is aligned`).toBe(0);
  return [start, start + size];
}

describe('cidr-exclude.sh: subnet minus one address', () => {
  it('gives the known list for the default network (172.30.0.0/24 without 172.30.0.1)', () => {
    const r = exclude('172.30.0.0/24', '172.30.0.1');
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe(
      '172.30.0.0/32,172.30.0.2/31,172.30.0.4/30,172.30.0.8/29,' +
        '172.30.0.16/28,172.30.0.32/27,172.30.0.64/26,172.30.0.128/25',
    );
  });

  it.each([
    ['172.30.0.0/24', '172.30.0.1'],
    ['172.30.0.0/24', '172.30.0.254'],
    ['172.30.0.0/24', '172.30.0.77'],
    ['10.8.0.0/16', '10.8.0.1'],
    ['10.8.0.0/16', '10.8.3.254'],
    ['192.168.5.16/28', '192.168.5.17'],
    ['192.168.5.16/28', '192.168.5.30'],
    ['192.168.5.16/28', '192.168.5.16'],
    ['0.0.0.0/1', '127.255.255.255'],
    ['172.30.0.0/31', '172.30.0.1'],
  ])('%s without %s: covers every other address exactly once', (subnet, address) => {
    const r = exclude(subnet, address);
    expect(r.status, r.stderr).toBe(0);
    const [netStart, netEnd] = range(subnet);
    const excluded = toInt(address);
    const blocks = r.stdout
      .trim()
      .split(',')
      .map(range)
      .sort((a, b) => a[0] - b[0]);
    expect(blocks.length).toBe(32 - Number(subnet.split('/')[1])); // one block per bit
    // Sorted, disjoint, inside the subnet, and the only gap is the excluded address.
    let next = netStart;
    for (const [start, end] of blocks) {
      if (start !== next) {
        expect([next, start]).toEqual([excluded, excluded + 1]);
      }
      expect(start).toBeGreaterThanOrEqual(netStart);
      expect(end).toBeLessThanOrEqual(netEnd);
      next = end;
    }
    if (next !== netEnd) expect([next, netEnd]).toEqual([excluded, excluded + 1]);
    const covered = blocks.reduce((sum, [start, end]) => sum + (end - start), 0);
    expect(covered).toBe(netEnd - netStart - 1);
    expect(blocks.some(([start, end]) => excluded >= start && excluded < end)).toBe(false);
  });

  it.each([
    ['172.30.0.0/24', '172.31.0.1', /is not inside/],
    ['172.30.0.1/24', '172.30.0.1', /host bits set/],
    ['172.30.0.0', '172.30.0.1', /needs a prefix length/],
    ['172.30.0.0/32', '172.30.0.0', /prefix length must be 1 to 31/],
    ['172.30.0.0/0', '172.30.0.1', /prefix length must be 1 to 31/],
    ['172.30.0.0/x', '172.30.0.1', /bad prefix length/],
    ['172.300.0.0/24', '172.30.0.1', /not an IPv4 address/],
    ['172.30.0.0/24', '172.30.0', /not an IPv4 address/],
    ['172.30.0.0/24', 'gateway', /not an IPv4 address/],
  ])('refuses %s without %s', (subnet, address, message) => {
    const r = exclude(subnet, address);
    expect(r.status).not.toBe(0);
    expect(r.stdout).toBe('');
    expect(r.stderr).toMatch(message);
  });
});
