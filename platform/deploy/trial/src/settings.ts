// The settings file of `pnpm trial:up` (D-08 V02 AC1): one YAML file outside the repository that
// names the fork, the GitHub App, the model and the two people of the trial. It holds paths to
// the secret files, never a secret itself. Pure: the caller reads the file.
import path from 'node:path';

import { parse } from 'yaml';

export type ModelProvider = 'ollama' | 'anthropic';

export interface TrialPerson {
  readonly email: string;
  readonly name: string;
  /** Numeric GitHub account ID (QUESTIONS #45): never the login. */
  readonly githubId: string;
  readonly githubLogin: string;
  /** The person's `XDG_CONFIG_HOME`: their credentials file is `<configHome>/sdlc/credentials.json`. */
  readonly configHome: string;
}

export interface TrialSettings {
  readonly tenant: string;
  readonly project: string;
  /** The fork of the sample repository, `owner/name`. */
  readonly forkRepo: string;
  /** A local clone of the fork: the agent's instructions are read from its `main` branch. */
  readonly forkClone: string;
  readonly appClientId: string;
  readonly appKeyFile: string;
  readonly model:
    | { readonly provider: 'ollama'; readonly ollamaUrl: string }
    | { readonly provider: 'anthropic'; readonly apiKeyFile: string };
  readonly personA: TrialPerson;
  readonly personB: TrialPerson;
}

/** The gateway model name of each provider (`platform/deploy/litellm/config.ctmpl`). */
export const MODEL_NAMES: Readonly<Record<ModelProvider, string>> = {
  ollama: 'gpt-oss-20b',
  anthropic: 'claude-haiku-4-5-20251001',
};

/** Ollama as LiteLLM sees it on Docker Desktop (runbook T11 §5d). */
export const DEFAULT_OLLAMA_URL = 'http://host.docker.internal:11434';

/** A field that is missing or malformed: `field` is its path in the file, never its value. */
export class SettingsError extends Error {
  constructor(readonly field: string) {
    super(`invalid settings field: ${field}`);
  }
}

const SLUG = /^[a-z][a-z0-9-]{1,38}$/;
const REPO = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/;
const EMAIL = /^[^\s@-][^\s@]*@[^\s@]+\.[^\s@]+$/;
const GITHUB_ID = /^[1-9][0-9]{0,19}$/;
const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const CLIENT_ID = /^[A-Za-z0-9._-]{4,64}$/;
const URL = /^https?:\/\/[A-Za-z0-9.-]+(?::\d{1,5})?\/?$/;

type Mapping = Readonly<Record<string, unknown>>;

function mapping(value: unknown, field: string): Mapping {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new SettingsError(field);
  }
  return value as Mapping;
}

function text(map: Mapping, key: string, field: string, pattern?: RegExp): string {
  const value = map[key];
  // YAML reads an unquoted numeric ID as a number: accept it as its digits.
  const s = typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : value;
  if (typeof s !== 'string' || s.trim() === '' || s.length > 500) throw new SettingsError(field);
  // Never read as a command-line option, never a control character (review V02).
  // eslint-disable-next-line no-control-regex
  if (s.startsWith('-') || /[\u0000-\u001f\u007f]/.test(s)) throw new SettingsError(field);
  if (pattern && !pattern.test(s)) throw new SettingsError(field);
  return s;
}

function absolutePath(map: Mapping, key: string, field: string, home: string): string {
  const raw = text(map, key, field);
  const expanded = raw === '~' ? home : raw.startsWith('~/') ? path.join(home, raw.slice(2)) : raw;
  if (!path.isAbsolute(expanded)) throw new SettingsError(field);
  return path.normalize(expanded);
}

function person(map: Mapping, key: string, home: string): TrialPerson {
  const p = mapping(map[key], `people.${key}`);
  const at = (f: string) => `people.${key}.${f}`;
  return {
    email: text(p, 'email', at('email'), EMAIL),
    name: text(p, 'name', at('name')),
    githubId: text(p, 'github_id', at('github_id'), GITHUB_ID),
    githubLogin: text(p, 'github_login', at('github_login'), GITHUB_LOGIN),
    configHome: absolutePath(p, 'config_home', at('config_home'), home),
  };
}

/** Parses and checks the settings file. Throws `SettingsError` naming the first bad field. */
export function parseSettings(yamlText: string, home: string): TrialSettings {
  let doc: unknown;
  try {
    doc = parse(yamlText);
  } catch {
    throw new SettingsError('(file)');
  }
  const root = mapping(doc, '(file)');
  const fork = mapping(root.fork, 'fork');
  const app = mapping(root.github_app, 'github_app');
  const model = mapping(root.model, 'model');
  const people = mapping(root.people, 'people');

  const provider = text(model, 'provider', 'model.provider');
  let modelSettings: TrialSettings['model'];
  if (provider === 'ollama') {
    const url =
      model.ollama_url === undefined
        ? DEFAULT_OLLAMA_URL
        : text(model, 'ollama_url', 'model.ollama_url', URL);
    modelSettings = { provider, ollamaUrl: url.replace(/\/$/, '') };
  } else if (provider === 'anthropic') {
    modelSettings = {
      provider,
      apiKeyFile: absolutePath(model, 'api_key_file', 'model.api_key_file', home),
    };
  } else {
    throw new SettingsError('model.provider');
  }

  const personA = person(people, 'person_a', home);
  const personB = person(people, 'person_b', home);
  // Two people (QUESTIONS #341): never the same account, address or credentials file.
  if (personA.email.toLowerCase() === personB.email.toLowerCase())
    throw new SettingsError('people.person_b.email');
  if (personA.githubId === personB.githubId) throw new SettingsError('people.person_b.github_id');
  if (personA.configHome === personB.configHome)
    throw new SettingsError('people.person_b.config_home');

  return {
    tenant: root.tenant === undefined ? 'trial' : text(root, 'tenant', 'tenant', SLUG),
    project: root.project === undefined ? 'pilot' : text(root, 'project', 'project', SLUG),
    forkRepo: text(fork, 'repo', 'fork.repo', REPO),
    forkClone: absolutePath(fork, 'clone', 'fork.clone', home),
    appClientId: text(app, 'client_id', 'github_app.client_id', CLIENT_ID),
    appKeyFile: absolutePath(app, 'private_key_file', 'github_app.private_key_file', home),
    model: modelSettings,
    personA,
    personB,
  };
}

/** The credentials file the CLI writes for a person (`apps/cli/src/credentials/store.ts`). */
export function credentialsFile(p: TrialPerson): string {
  return path.join(p.configHome, 'sdlc', 'credentials.json');
}

/** The files that hold secrets: they must exist and be readable by their owner only. */
export function secretFiles(s: TrialSettings): string[] {
  return [s.appKeyFile, ...(s.model.provider === 'anthropic' ? [s.model.apiKeyFile] : [])];
}
