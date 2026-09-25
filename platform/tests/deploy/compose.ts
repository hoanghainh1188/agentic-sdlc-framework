// Helpers to read platform/deploy files in tests (task A02).
import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';

import { repoRoot } from '../workspace/helpers';

export const root = repoRoot();
export const deployDir = path.join(root, 'platform/deploy');

export interface ComposeService {
  image?: string;
  profiles?: string[];
  restart?: string;
  environment?: Record<string, string>;
  command?: string[] | string;
  entrypoint?: string[] | string;
  ports?: string[];
  volumes?: string[];
  depends_on?: Record<string, { condition: string }>;
  healthcheck?: { test?: string[] | string };
}

export interface ComposeFile {
  services: Record<string, ComposeService>;
}

export function readDeployFile(relative: string): string {
  return fs.readFileSync(path.join(deployDir, relative), 'utf8');
}

/** The compose file as written (merge keys resolved, variables NOT interpolated). */
export function loadCompose(): ComposeFile {
  return parse(readDeployFile('docker-compose.yml'), { merge: true }) as ComposeFile;
}

/** Parses a dotenv file into key/value pairs (surrounding double quotes removed). */
export function parseEnvFile(text: string): Map<string, string> {
  const vars = new Map<string, string>();
  for (const line of text.split('\n')) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (match) vars.set(match[1]!, match[2]!.replace(/^"(.*)"$/, '$1'));
  }
  return vars;
}

/** One-shot jobs: services with restart "no" (they run once and exit 0). */
export function jobNames(compose: ComposeFile): string[] {
  return Object.entries(compose.services)
    .filter(([, s]) => s.restart === 'no')
    .map(([name]) => name)
    .sort();
}

export function servicesInProfile(compose: ComposeFile, profile: string): string[] {
  return Object.entries(compose.services)
    .filter(([, s]) => (s.profiles ?? []).includes(profile))
    .map(([name]) => name)
    .sort();
}

/** Variable names that hold secrets: they must be required (${VAR:?}) and CHANGEME in .env.example. */
export function isSecretName(name: string): boolean {
  return /(PASSWORD|SECRET|_KEY$|_KEY_ID$|SALT|AUTH)/.test(name);
}
