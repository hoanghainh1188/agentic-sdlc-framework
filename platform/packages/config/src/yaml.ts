// Safe YAML reading: YAML 1.2 core schema (no custom or YAML 1.1 tags, no dates), duplicate keys refused,
// alias expansion capped. Any YAML warning is treated as an error.
import { parseDocument, type YAMLError } from 'yaml';

import { issue, type ConfigIssue } from './issues.js';

const MAX_ALIAS_COUNT = 100;

export type YamlResult =
  | { readonly ok: true; readonly value: Readonly<Record<string, unknown>> }
  | { readonly ok: false; readonly errors: readonly ConfigIssue[] };

function fromYamlError(error: YAMLError): ConfigIssue {
  const [position] = error.linePos ?? [];
  const params = { line: position?.line ?? 0, column: position?.col ?? 0, code: error.code };
  return error.code === 'DUPLICATE_KEY'
    ? issue('config.yaml.duplicate_key', '', params)
    : issue('config.yaml.syntax', '', params);
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Parses a YAML text into a mapping. An empty text is an empty mapping. `maxAliasCount: 0`
 * refuses every alias (B09: plan files, ADR-M40 §2.2).
 */
export function readYamlMapping(
  text: string,
  options: { readonly maxAliasCount?: number } = {},
): YamlResult {
  const maxAliasCount = options.maxAliasCount ?? MAX_ALIAS_COUNT;
  const document = parseDocument(text, {
    schema: 'core',
    strict: true,
    uniqueKeys: true,
    merge: false,
    // No YAML 1.1 extras such as !!timestamp or !!binary: only JSON-like values.
    resolveKnownTags: false,
    prettyErrors: true,
  });
  const problems = [...document.errors, ...document.warnings];
  if (problems.length > 0) return { ok: false, errors: problems.map(fromYamlError) };

  let value: unknown;
  try {
    value = document.toJS({ maxAliasCount });
  } catch {
    return {
      ok: false,
      errors: [issue('config.yaml.too_many_aliases', '', { maximum: maxAliasCount })],
    };
  }
  if (value === null || value === undefined) return { ok: true, value: {} };
  if (!isPlainObject(value)) return { ok: false, errors: [issue('config.yaml.not_a_mapping', '')] };
  return { ok: true, value };
}

/** Durations and deadlines (`{ value, unit }`, `{ kind }`) are single values, never merged. */
function isValueObject(value: unknown): boolean {
  return isPlainObject(value) && ('unit' in value || 'kind' in value);
}

/**
 * Deep merge: mappings merge key by key. Lists, scalars, durations and deadlines in `override`
 * replace the value in `base`.
 */
export function deepMerge(
  base: Readonly<Record<string, unknown>>,
  override: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const current = Object.hasOwn(merged, key) ? merged[key] : undefined;
    const mergeable =
      isPlainObject(current) &&
      isPlainObject(value) &&
      !isValueObject(current) &&
      !isValueObject(value);
    // defineProperty, not `merged[key] =`: a `__proto__` key must stay an own (unknown) setting,
    // so the schema refuses it, instead of replacing the prototype.
    Object.defineProperty(merged, key, {
      value: mergeable ? deepMerge(current, value) : value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return merged;
}
