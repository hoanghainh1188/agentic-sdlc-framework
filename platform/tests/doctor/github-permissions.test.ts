// The GitHub App's permissions against the manifest (D-08 V07 AC1, QUESTIONS #400): the manifest is
// the one source; missing or lower permissions are listed, and so are wider ones.
import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  comparePermissions,
  manifestPermissions,
} from '../../deploy/doctor/src/github-permissions.js';
import { repoRoot } from '../workspace/helpers';

const manifest = manifestPermissions(
  fs.readFileSync(path.join(repoRoot(), 'platform/deploy/github-app/manifest.json'), 'utf8'),
);

describe('GitHub App permissions against the manifest', () => {
  it('reads the manifest of the repository', () => {
    expect(manifest).toMatchObject({ contents: 'write', pull_requests: 'write', metadata: 'read' });
  });

  it('equal permissions: nothing missing, nothing extra', () => {
    expect(comparePermissions(manifest, { ...manifest })).toEqual({ missing: [], extra: [] });
  });

  it('a missing and a lower permission are missing; admin and unknown ones are extra', () => {
    const rest = Object.fromEntries(Object.entries(manifest).filter(([k]) => k !== 'issues'));
    expect(
      comparePermissions(manifest, {
        ...rest,
        contents: 'read',
        checks: 'admin',
        administration: 'read',
      }),
    ).toEqual({
      missing: ['contents:write', 'issues:write'],
      extra: ['administration:read', 'checks:admin'],
    });
  });

  it('refuses a malformed manifest', () => {
    expect(() => manifestPermissions('{"default_permissions": {"contents": "all"}}')).toThrow(
      'manifest_invalid',
    );
    expect(() => manifestPermissions('{}')).toThrow('manifest_invalid');
  });
});
