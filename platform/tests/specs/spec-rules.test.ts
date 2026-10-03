// B08 (ADR-M39 §2.3, QUESTIONS #163): what a spec file may be, and how it is read and hashed.
// `readSpec` runs through the real GitHub adapter against the in-process GitHub stub.
import { createHash } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  isSpecPath,
  readSpec,
  SPEC_MAX_BYTES,
  specContentSha256,
} from '../../packages/core/src/specs/index.js';
import { startHarness, type Harness } from '../git-github/helpers';
import { REPO, SHA_A } from '../git-github/stub-github';

describe('isSpecPath', () => {
  it.each(['docs/specs/T07.md', 'SPEC.MD', 'a b/c.markdown', 'docs/specs/T06 tax.md'])(
    'accepts %j',
    (path) => expect(isSpecPath(path)).toBe(true),
  );

  it.each([
    '',
    '.md',
    'docs/specs/',
    'docs/specs/T07.txt',
    'docs/spec.md/',
    '/etc/spec.md',
    '../spec.md',
    'docs/./spec.md',
    'docs\\spec.md',
    `docs/${'a'.repeat(1030)}.md`,
  ])('refuses %j', (path) => expect(isSpecPath(path)).toBe(false));
});

describe('readSpec through the GitHub adapter', () => {
  let h: Harness;
  const PATH = '/repos/acme/shop/contents/docs/specs/T06%20tax.md';
  const raw = (bytes: Buffer) => ({
    raw: bytes,
    headers: { 'content-type': 'application/vnd.github.raw+json' },
  });

  beforeEach(async () => {
    h = await startHarness();
  });

  afterEach(async () => {
    await h.stub.stop();
  });

  it('hashes the file byte for byte (BOM and CRLF kept): the SHA-256 of the file', async () => {
    const bytes = Buffer.from('﻿# T06 消費税計算\r\nAC1: 10% / 8%\r\n', 'utf8');
    h.stub.on('GET', PATH, raw(bytes));
    const read = await readSpec(h.adapter(), REPO, 'docs/specs/T06 tax.md', SHA_A);
    const expected = createHash('sha256').update(bytes).digest('hex');
    expect(read).toEqual({ kind: 'ok', sha256: expected });
    expect(specContentSha256(bytes.toString('utf8'))).toBe(expected);
  });

  it('a missing file, a directory, a file that is not UTF-8 or too large: unreadable, with the cause', async () => {
    await expect(readSpec(h.adapter(), REPO, 'nope.md', SHA_A)).resolves.toEqual({
      kind: 'unreadable',
      cause: 'missing',
    });
    h.stub.on('GET', '/repos/acme/shop/contents/docs', { body: [{ name: 'a', type: 'file' }] });
    await expect(readSpec(h.adapter(), REPO, 'docs', SHA_A)).resolves.toEqual({
      kind: 'unreadable',
      cause: 'not_a_file',
    });
    h.stub.on('GET', PATH, raw(Buffer.from([0xff, 0xfe, 0x00, 0x41])));
    await expect(readSpec(h.adapter(), REPO, 'docs/specs/T06 tax.md', SHA_A)).resolves.toEqual({
      kind: 'unreadable',
      cause: 'not_utf8',
    });
    // Larger than the platform limit (256 KiB) but within the adapter's 1 MiB.
    h.stub.on('GET', PATH, raw(Buffer.alloc(SPEC_MAX_BYTES + 1, 0x61)));
    await expect(readSpec(h.adapter(), REPO, 'docs/specs/T06 tax.md', SHA_A)).resolves.toEqual({
      kind: 'unreadable',
      cause: 'too_large',
    });
    h.stub.on('GET', PATH, raw(Buffer.alloc(2 * 1024 * 1024, 0x61)));
    await expect(readSpec(h.adapter(), REPO, 'docs/specs/T06 tax.md', SHA_A)).resolves.toEqual({
      kind: 'unreadable',
      cause: 'too_large',
    });
    h.stub.on('GET', PATH, raw(Buffer.alloc(SPEC_MAX_BYTES, 0x61)));
    await expect(
      readSpec(h.adapter(), REPO, 'docs/specs/T06 tax.md', SHA_A),
    ).resolves.toMatchObject({ kind: 'ok' });
  });

  it('a Git host failure is not a fact about the file: it is thrown (the caller waits)', async () => {
    h.stub.on('GET', PATH, { status: 502, body: {} });
    await expect(
      readSpec(h.adapter({ maxRetries: 0 }), REPO, 'docs/specs/T06 tax.md', SHA_A),
    ).rejects.toMatchObject({ name: 'GitHostError', code: 'server_error' });
  });
});
