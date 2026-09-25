// Errors and warnings found while loading a project configuration. They carry a message key and
// parameters only; text comes from the message catalog (design/D-02 NFR-08).
import { t, type MessageKey } from '@sdlc/messages';

export interface ConfigIssue {
  readonly key: MessageKey;
  /** Location in the configuration, for example `oversight.matrix.G1.low.mode`. Empty for the root. */
  readonly path: string;
  readonly params: Readonly<Record<string, string | number>>;
}

export function issue(
  key: MessageKey,
  path: string,
  params: Readonly<Record<string, string | number>> = {},
): ConfigIssue {
  return { key, path, params };
}

/** Joins path segments: `['holidays', 0]` → `holidays[0]`. */
export function formatPath(segments: readonly PropertyKey[]): string {
  return segments.reduce<string>((acc, segment) => {
    if (typeof segment === 'number') return `${acc}[${segment}]`;
    const name = String(segment);
    return acc === '' ? name : `${acc}.${name}`;
  }, '');
}

/** Renders an issue in the given locale (English by default). */
export function formatIssue(configIssue: ConfigIssue, locale?: string): string {
  const path = configIssue.path === '' ? t('config.path.root', {}, locale) : configIssue.path;
  return t(configIssue.key, { ...configIssue.params, path }, locale);
}
