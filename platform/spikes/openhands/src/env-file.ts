// Reads values from the Git-ignored platform/deploy/.env (C01 spike). Values are returned to the
// caller only; they are never logged or written anywhere.
import { readFileSync } from 'node:fs';

export function parseEnvFile(text: string): ReadonlyMap<string, string> {
  const values = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (value.length >= 2 && /^(['"]).*\1$/.test(value)) value = value.slice(1, -1);
    values.set(key, value);
  }
  return values;
}

export function readEnvFile(path: string): ReadonlyMap<string, string> {
  return parseEnvFile(readFileSync(path, 'utf8'));
}

export function requireValue(values: ReadonlyMap<string, string>, key: string): string {
  const value = values.get(key);
  if (!value) throw new Error(`${key} is missing in the environment file`);
  return value;
}
