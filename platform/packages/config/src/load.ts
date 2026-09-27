// Loads a project configuration: the default file (codes table values) merged with a project
// override, then schema validation, mandatory rules, warnings and `config_hash` (D-08 A05).
import { readFileSync } from 'node:fs';
import path from 'node:path';

import type { ProjectConfig, ValidatedProjectConfig } from '@sdlc/contracts';

import { computeConfigHash } from './hash.js';
import type { ConfigIssue } from './issues.js';
import { checkMandatoryRules } from './mandatory-rules.js';
import { projectConfigSchema, toConfigIssues } from './schema.js';
import { loosenedSettings } from './warnings.js';
import { deepMerge, readYamlMapping } from './yaml.js';

/** The default configuration file shipped with the package. */
export const DEFAULT_CONFIG_PATH = path.resolve(
  __dirname,
  '..',
  'defaults',
  'project-config.default.yaml',
);

export type ConfigResult =
  | {
      readonly ok: true;
      readonly config: ValidatedProjectConfig;
      /** SHA-256 (hex) of the RFC 8785 canonical JSON of `config`. */
      readonly configHash: string;
      readonly warnings: readonly ConfigIssue[];
    }
  | { readonly ok: false; readonly errors: readonly ConfigIssue[] };

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

/** The only place that brands a configuration as validated: schema and M1–M18 both passed. */
function validate(raw: unknown): { config: ValidatedProjectConfig } | { errors: ConfigIssue[] } {
  const parsed = projectConfigSchema.safeParse(raw, { reportInput: true });
  if (!parsed.success) return { errors: toConfigIssues(parsed.error.issues) };
  const config: ProjectConfig = parsed.data;
  const violations = checkMandatoryRules(config);
  return violations.length > 0
    ? { errors: violations }
    : { config: config as ValidatedProjectConfig };
}

let defaults: { raw: Record<string, unknown>; config: ValidatedProjectConfig } | undefined;

/** The shipped defaults. Throws if the shipped file itself is invalid (a packaging error). */
function loadDefaults(): { raw: Record<string, unknown>; config: ValidatedProjectConfig } {
  if (defaults === undefined) {
    const read = readYamlMapping(readFileSync(DEFAULT_CONFIG_PATH, 'utf8'));
    const result = read.ok ? validate(read.value) : { errors: read.errors };
    if ('errors' in result) {
      throw new Error(`invalid default configuration: ${JSON.stringify(result.errors)}`);
    }
    defaults = deepFreeze({ raw: read.ok ? read.value : {}, config: result.config });
  }
  return defaults;
}

/**
 * Loads a project configuration. `overrideYaml` is the project's own YAML (a partial override of
 * the defaults); leave it empty for the defaults only. Never throws for bad input: problems come
 * back as catalog-keyed issues.
 */
export function loadProjectConfig(overrideYaml = ''): ConfigResult {
  const base = loadDefaults();
  const override = readYamlMapping(overrideYaml);
  if (!override.ok) return { ok: false, errors: override.errors };

  const result = validate(deepMerge(base.raw, override.value));
  if ('errors' in result) return { ok: false, errors: result.errors };

  const config = deepFreeze(result.config);
  return {
    ok: true,
    config,
    configHash: computeConfigHash(config),
    warnings: loosenedSettings(config, base.config),
  };
}

/** The default configuration (codes table values), validated and frozen. */
export function defaultProjectConfig(): ValidatedProjectConfig {
  return loadDefaults().config;
}
