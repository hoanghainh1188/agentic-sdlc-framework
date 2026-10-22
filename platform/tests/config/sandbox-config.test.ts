// Sandbox image of a project (QUESTIONS #59 option A, ADR-M25): referenced by digest in the project
// configuration, never by a tag alone, so the runner always starts the image that CI scanned.
import { formatIssue } from '@sdlc/config';
import { sandboxImageFor } from '@sdlc/contracts';
import { describe, expect, it } from 'vitest';

import { keysAndPaths, loadErrors, loadValid } from './helpers';

const DIGEST = `sha256:${'a'.repeat(64)}`;
const sandbox = (image: string) => `sandbox:\n  image: ${image}\n`;

describe('sandbox.image', () => {
  it('defaults to the pinned OpenHands agent-server base (ADR-M10 §2.1)', () => {
    expect(loadValid().config.sandbox.image).toBe(
      'ghcr.io/openhands/agent-server:1.48.0-python-slim@sha256:8fcfab2dedb4b41b6aef219b9fa9b1f2588033fad3d998ae6aa11fe8c4fcf8b7',
    );
  });

  it.each([
    `registry.internal:5000/sdlc-sandbox-node24@${DIGEST}`,
    `localhost:5000/sdlc/sandbox-node24:2026-09-27@${DIGEST}`,
    `ghcr.io/harryforge/sdlc-sandbox-node24:1.0.0@${DIGEST}`,
  ])('accepts %s', (image) => {
    expect(loadValid(sandbox(image)).config.sandbox.image).toBe(image);
  });

  it.each([
    'ghcr.io/openhands/agent-server:1.48.0-python-slim',
    'agent-server@sha256:abc',
    `Registry.Internal/sandbox@${DIGEST}`,
    `sandbox@${DIGEST}`,
    `registry/sandbox@sha512:${'a'.repeat(128)}`,
    `registry/sandbox:tag@${DIGEST} --privileged`,
  ])('refuses %s (not pinned by a SHA-256 digest)', (image) => {
    const errors = loadErrors(sandbox(JSON.stringify(image)));
    expect(keysAndPaths(errors)).toEqual([['config.schema.image_not_pinned', 'sandbox.image']]);
    expect(formatIssue(errors[0]!)).toContain('must be pinned by digest');
  });
});

// X03 (QUESTIONS #522, #528): one image per adapter. `sandbox.image` stays the OpenHands image.
describe('sandbox.images', () => {
  const OH = `registry.internal:5000/sdlc/sandbox-node24@${DIGEST}`;
  const OC = `registry.internal:5000/sdlc/sandbox-node24-opencode@sha256:${'b'.repeat(64)}`;
  const images = (lines: string) => `sandbox:\n  image: ${OH}\n  images:\n${lines}`;

  it('is optional: a project without it runs OpenHands only', () => {
    const { sandbox: s } = loadValid(sandbox(OH)).config;
    expect(s.images).toBeUndefined();
    expect(sandboxImageFor(s, 'openhands')).toBe(OH);
    expect(sandboxImageFor(s, 'opencode')).toBeUndefined();
  });

  it('gives the image of each adapter', () => {
    const { sandbox: s } = loadValid(images(`    opencode: ${OC}\n    openhands: ${OH}\n`)).config;
    expect(sandboxImageFor(s, 'opencode')).toBe(OC);
    expect(sandboxImageFor(s, 'openhands')).toBe(OH);
  });

  it('refuses an OpenHands entry that differs from sandbox.image', () => {
    const errors = loadErrors(images(`    openhands: ${OC}\n`));
    expect(keysAndPaths(errors)).toEqual([['config.schema.sandbox_images_conflict', 'sandbox']]);
  });

  it('refuses an image that is not pinned and an unknown adapter', () => {
    expect(keysAndPaths(loadErrors(images(`    opencode: registry/oc:1.18.35\n`)))).toEqual([
      ['config.schema.image_not_pinned', 'sandbox.images.opencode'],
    ]);
    expect(keysAndPaths(loadErrors(images(`    aider: ${OC}\n`)))).toEqual([
      ['config.schema.unknown_key', 'sandbox.images'],
    ]);
  });
});
