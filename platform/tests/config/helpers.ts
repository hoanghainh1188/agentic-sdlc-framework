import { formatIssue, loadProjectConfig, type ConfigIssue } from '@sdlc/config';
import type { ProjectConfig } from '@sdlc/contracts';

/** Loads a configuration that must be valid; fails the test with the rendered errors otherwise. */
export function loadValid(yaml = ''): {
  config: ProjectConfig;
  configHash: string;
  warnings: readonly ConfigIssue[];
} {
  const result = loadProjectConfig(yaml);
  if (!result.ok) throw new Error(result.errors.map((e) => formatIssue(e)).join('\n'));
  return result;
}

/** Loads a configuration that must be invalid and returns its errors. */
export function loadErrors(yaml: string): readonly ConfigIssue[] {
  const result = loadProjectConfig(yaml);
  if (result.ok) throw new Error('expected the configuration to be refused');
  return result.errors;
}

/** `[key, path]` pairs, for compact assertions. */
export function keysAndPaths(issues: readonly ConfigIssue[]): [string, string][] {
  return issues.map((i) => [i.key, i.path]);
}
