// ADR-M104 §2.2: what release-tag.yml does on a push to main, decided from the state of the
// repository (the version, the tags, the release runs), never from the last commit alone: a
// pending run that GitHub cancels, or a push of several commits, still tags the version, and a
// run that failed after the tag starts the release when it runs again.
import { describe, expect, it } from 'vitest';

import { bumpCommit, decideTag } from '../../tools/release/tag-release.mjs';

describe('decideTag', () => {
  const tags = ['v0.9.1', 'v0.10.0', 'v0.11.0'];

  it('a version above every tag and not tagged: tag it', () => {
    expect(decideTag({ version: '0.12.0', tags, releaseRuns: 0 })).toEqual({ action: 'tag' });
  });

  it('tagged, with a release run already: nothing to do', () => {
    expect(decideTag({ version: '0.11.0', tags, releaseRuns: 1 })).toMatchObject({
      action: 'none',
    });
  });

  it('tagged, but no release run (the dispatch failed, or nobody started it): start the release', () => {
    expect(decideTag({ version: '0.11.0', tags, releaseRuns: 0 })).toEqual({ action: 'dispatch' });
  });

  it('a version below the highest tag and not tagged is refused, never released', () => {
    expect(decideTag({ version: '0.10.5', tags, releaseRuns: 0 })).toMatchObject({
      action: 'refuse',
    });
  });

  it('ignores tags that are not vX.Y.Z; with no tag at all, the version is tagged', () => {
    expect(decideTag({ version: '0.1.0', tags: ['design-v1.0'], releaseRuns: 0 })).toEqual({
      action: 'tag',
    });
  });
});

describe('bumpCommit: the commit that set the version, newest history first', () => {
  it('the oldest commit of the newest run of that version', () => {
    const history = [
      { sha: 'c', version: '0.12.0' }, // a later change to package.json (a dependency)
      { sha: 'b', version: '0.12.0' }, // the version pull request
      { sha: 'a', version: '0.11.0' },
    ];
    expect(bumpCommit(history, '0.12.0')).toBe('b');
  });

  it('null when the newest commit does not hold the version', () => {
    expect(bumpCommit([{ sha: 'a', version: '0.11.0' }], '0.12.0')).toBeNull();
  });
});
