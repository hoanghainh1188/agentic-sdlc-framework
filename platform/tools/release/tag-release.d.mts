// Types of tag-release.mjs for the tests (ADR-M104 §2.2).
export type TagDecision =
  | { readonly action: 'tag' }
  | { readonly action: 'dispatch' }
  | { readonly action: 'none'; readonly reason: string }
  | { readonly action: 'refuse'; readonly reason: string };

export function decideTag(input: {
  readonly version: string;
  readonly tags: readonly string[];
  readonly releaseRuns: number;
}): TagDecision;

export function bumpCommit(
  history: readonly { readonly sha: string; readonly version: string }[],
  version: string,
): string | null;
