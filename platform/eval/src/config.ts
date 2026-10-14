// Evaluation configurations (task L02, design/ADR-M78 §2.4). A configuration = agent × model ×
// instructions version. Between two configurations that are compared, one factor changes.
// Providers in this version: `ollama` (a local tag, never `:cloud`) and `stub` (the scripted stub
// model of the live tests, to check the harness itself). API models come later (ADR-M78 §2.2).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { readYamlMapping } from '@sdlc/config';

import { TaskError } from './task.js';

export const PROVIDERS = ['ollama', 'stub'] as const;
export type Provider = (typeof PROVIDERS)[number];

/** Where a provider runs: every provider of this version is self-hosted (ADR-M81 §2.6). */
export function providerTypeOf(provider: Provider): 'self_hosted' {
  void provider;
  return 'self_hosted';
}

export interface EvalModel {
  readonly provider: Provider;
  /** The gateway name the agent asks LiteLLM for (and the name in the report). */
  readonly name: string;
  /** Ollama only: the local tag, for example `gpt-oss:20b`. */
  readonly tag: string | null;
  /** Ollama only: the context size. */
  readonly numCtx: number | null;
  /** Ollama only: `low`, `medium`, `high`, or null. */
  readonly reasoningEffort: string | null;
}

export interface EvalConfiguration {
  readonly id: string;
  readonly agentVersion: string;
  readonly model: EvalModel;
  /** `repo`: the repository's own AGENTS.md; else an instructions file next to the config file. */
  readonly instructions: string;
  /** The text that replaces AGENTS.md, or null for `repo`. */
  readonly instructionsText: string | null;
  /** SHA-256 of the instructions text (the repository's for `repo`, filled in at run time). */
  readonly instructionsSha256: string | null;
  readonly maxIterations: number;
  readonly maxDurationMin: number;
}

const ID = /^[a-z0-9][a-z0-9-]{0,47}$/;
const VERSION = /^[0-9]+\.[0-9]+\.[0-9]+$/;
const MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
// A local Ollama tag: never a `:cloud` or `-cloud` tag, which sends data to ollama.com.
const OLLAMA_TAG = /^[a-z0-9][a-z0-9._-]{0,63}(:[a-z0-9][a-z0-9._-]{0,63})?$/;
const INSTRUCTIONS_FILE = /^[a-z0-9][a-z0-9-]{0,47}\.md$/;
const EFFORTS = ['low', 'medium', 'high'];

function int(value: unknown, min: number, max: number, where: string, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new TaskError(where, `${field} must be an integer from ${String(min)} to ${String(max)}`);
  }
  return value;
}

function only(value: unknown, keys: readonly string[], where: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TaskError(where, 'must be a mapping');
  }
  const record = value as Record<string, unknown>;
  const extra = Object.keys(record).filter((key) => !keys.includes(key));
  if (extra.length > 0) throw new TaskError(where, `unknown field ${extra.join(', ')}`);
  return record;
}

function model(value: unknown, where: string): EvalModel {
  const raw = only(value, ['provider', 'name', 'tag', 'num_ctx', 'reasoning_effort'], where);
  if (!PROVIDERS.includes(raw.provider as Provider)) {
    throw new TaskError(where, 'provider must be ollama or stub');
  }
  const provider = raw.provider as Provider;
  if (typeof raw.name !== 'string' || !MODEL_NAME.test(raw.name)) {
    throw new TaskError(where, 'name is missing or has a wrong format');
  }
  if (provider === 'stub') {
    if (raw.tag !== undefined || raw.num_ctx !== undefined || raw.reasoning_effort !== undefined) {
      throw new TaskError(where, 'a stub model has only a name');
    }
    return { provider, name: raw.name, tag: null, numCtx: null, reasoningEffort: null };
  }
  if (typeof raw.tag !== 'string' || !OLLAMA_TAG.test(raw.tag) || /cloud/.test(raw.tag)) {
    throw new TaskError(where, 'tag must be a local Ollama tag (never a cloud model)');
  }
  const effort = raw.reasoning_effort;
  if (effort !== undefined && !EFFORTS.includes(effort as string)) {
    throw new TaskError(where, 'reasoning_effort must be low, medium or high');
  }
  return {
    provider,
    name: raw.name,
    tag: raw.tag,
    numCtx: raw.num_ctx === undefined ? 32768 : int(raw.num_ctx, 2048, 262144, where, 'num_ctx'),
    reasoningEffort: (effort as string | undefined) ?? null,
  };
}

/** Reads a configuration file; `only` keeps the named configurations (all must exist). */
export function loadConfigurations(file: string, keep?: readonly string[]): EvalConfiguration[] {
  const where = `configuration ${path.basename(file)}`;
  if (!fs.existsSync(file)) throw new TaskError(where, 'file is missing');
  const parsed = readYamlMapping(fs.readFileSync(file, 'utf8'), { maxAliasCount: 0 });
  if (!parsed.ok) throw new TaskError(where, 'not valid YAML');
  const root = only(parsed.value, ['schema', 'configurations'], where);
  if (root.schema !== 1) throw new TaskError(where, 'schema must be 1');
  if (!Array.isArray(root.configurations) || root.configurations.length === 0) {
    throw new TaskError(where, 'configurations must be a non-empty list');
  }
  const configurations = root.configurations.map((value, i): EvalConfiguration => {
    const at = `${where} [${String(i)}]`;
    const raw = only(
      value,
      ['id', 'agent_version', 'model', 'instructions', 'max_iterations', 'max_duration_min'],
      at,
    );
    if (typeof raw.id !== 'string' || !ID.test(raw.id)) throw new TaskError(at, 'id is wrong');
    if (typeof raw.agent_version !== 'string' || !VERSION.test(raw.agent_version)) {
      throw new TaskError(at, 'agent_version must be X.Y.Z');
    }
    const instructions = raw.instructions ?? 'repo';
    let instructionsText: string | null = null;
    if (instructions !== 'repo') {
      if (typeof instructions !== 'string' || !INSTRUCTIONS_FILE.test(instructions)) {
        throw new TaskError(at, 'instructions must be repo or a .md file name');
      }
      const instructionsFile = path.join(path.dirname(file), instructions);
      if (!fs.existsSync(instructionsFile)) throw new TaskError(at, 'instructions file is missing');
      instructionsText = fs.readFileSync(instructionsFile, 'utf8');
    }
    return {
      id: raw.id,
      agentVersion: raw.agent_version,
      model: model(raw.model, `${at} model`),
      instructions,
      instructionsText,
      instructionsSha256:
        instructionsText === null
          ? null
          : crypto.createHash('sha256').update(instructionsText).digest('hex'),
      maxIterations: int(raw.max_iterations ?? 30, 1, 200, at, 'max_iterations'),
      maxDurationMin: int(raw.max_duration_min ?? 20, 1, 120, at, 'max_duration_min'),
    };
  });
  const ids = configurations.map((c) => c.id);
  if (new Set(ids).size !== ids.length) throw new TaskError(where, 'configuration ids repeat');
  if (keep === undefined) return configurations;
  const unknown = keep.filter((id) => !ids.includes(id));
  if (unknown.length > 0) throw new TaskError(where, `unknown configuration ${unknown.join(', ')}`);
  return configurations.filter((c) => keep.includes(c.id));
}

/** The LiteLLM model list (YAML) for the Ollama configurations, as `config.ctmpl` writes it. */
export function litellmModelList(
  configurations: readonly EvalConfiguration[],
  apiBase: string,
): string {
  const seen = new Set<string>();
  const entries: string[] = [];
  for (const { model: m } of configurations) {
    if (m.provider !== 'ollama' || seen.has(m.name)) continue;
    seen.add(m.name);
    entries.push(
      [
        `  - model_name: ${m.name}`,
        '    litellm_params:',
        `      model: ollama_chat/${m.tag ?? ''}`,
        `      api_base: ${JSON.stringify(apiBase)}`,
        `      num_ctx: ${String(m.numCtx)}`,
        ...(m.reasoningEffort === null ? [] : [`      reasoning_effort: ${m.reasoningEffort}`]),
        // Internal cost above 0, so budgets keep working for a self-hosted model (D-07 §3).
        '      input_cost_per_token: 0.0000001',
        '      output_cost_per_token: 0.0000004',
        '    model_info:',
        '      provider_type: self_hosted',
      ].join('\n'),
    );
  }
  return `model_list:\n${entries.join('\n')}\n`;
}
