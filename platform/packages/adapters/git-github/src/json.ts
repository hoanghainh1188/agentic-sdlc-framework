// Checked reads of GitHub JSON. Answers from the Git host are external data: every field the
// adapter uses is checked, and a wrong shape is `invalid_response` (never a guess).
import { GitHostError, type GitActor, type RepoRef } from '@sdlc/contracts';

export type Json = Readonly<Record<string, unknown>>;

function invalid(field: string): never {
  throw new GitHostError('invalid_response', { field });
}

export function obj(value: unknown, field: string): Json {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) invalid(field);
  return value as Json;
}

export function arr(value: unknown, field: string): readonly unknown[] {
  if (!Array.isArray(value)) invalid(field);
  return value;
}

export function str(value: unknown, field: string): string {
  if (typeof value !== 'string') invalid(field);
  return value;
}

export function optStr(value: unknown, field: string): string | null {
  return value === null || value === undefined ? null : str(value, field);
}

export function bool(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') invalid(field);
  return value;
}

export function int(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) invalid(field);
  return value;
}

/** A GitHub object ID (number) as a decimal string. */
export function id(value: unknown, field: string): string {
  return String(int(value, field));
}

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

/** A GitHub timestamp, returned as ISO 8601 UTC with milliseconds. */
export function time(value: unknown, field: string): string {
  const s = str(value, field);
  if (!ISO_UTC.test(s)) invalid(field);
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) invalid(field);
  return d.toISOString();
}

const SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

export function sha(value: unknown, field: string): string {
  const s = str(value, field);
  if (!SHA.test(s)) invalid(field);
  return s;
}

export function isSha(value: string): boolean {
  return SHA.test(value);
}

export function url(value: unknown, field: string): string {
  const s = str(value, field);
  if (!s.startsWith('https://') && !s.startsWith('http://')) invalid(field);
  return s;
}

export function actor(value: unknown, field: string): GitActor {
  const u = obj(value, field);
  const login = str(u.login, `${field}.login`);
  const type = str(u.type, `${field}.type`);
  return {
    id: id(u.id, `${field}.id`),
    login,
    type: type === 'Bot' || login.endsWith('[bot]') ? 'bot' : 'user',
  };
}

const NAME = /^[A-Za-z0-9._-]{1,100}$/;

/** Checks a repository reference before it goes into a URL path. */
export function checkRepo(ref: RepoRef): RepoRef {
  if (
    !NAME.test(ref.owner) ||
    !NAME.test(ref.name) ||
    ref.owner === '.' ||
    ref.owner === '..' ||
    ref.name === '.' ||
    ref.name === '..'
  ) {
    throw new GitHostError('invalid_input', { field: 'repo' });
  }
  return { owner: ref.owner, name: ref.name };
}

export function repoPath(ref: RepoRef): string {
  const r = checkRepo(ref);
  return `repos/${r.owner}/${r.name}`;
}

export function checkNumber(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new GitHostError('invalid_input', { field });
  }
  return value;
}
