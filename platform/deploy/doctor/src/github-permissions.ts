// Compares the GitHub App's permissions with the App manifest (D-08 V07 AC1, QUESTIONS #400).
// `platform/deploy/github-app/manifest.json` `default_permissions` is the one source of the
// permissions (V03): the README's table and this check both follow it.

const RANK: Readonly<Record<string, number>> = { read: 1, write: 2, admin: 3 };

export interface PermissionDiff {
  /** Permissions the manifest asks for that are absent or lower: `name:level` (wanted). */
  readonly missing: readonly string[];
  /** Permissions above what the manifest asks for (or not in it): `name:level` (granted). */
  readonly extra: readonly string[];
}

export function comparePermissions(
  wanted: Readonly<Record<string, string>>,
  granted: Readonly<Record<string, string>>,
): PermissionDiff {
  const missing: string[] = [];
  const extra: string[] = [];
  for (const [name, level] of Object.entries(wanted)) {
    if ((RANK[granted[name] ?? ''] ?? 0) < (RANK[level] ?? 0)) missing.push(`${name}:${level}`);
  }
  for (const [name, level] of Object.entries(granted)) {
    if ((RANK[level] ?? 0) > (RANK[wanted[name] ?? ''] ?? 0)) extra.push(`${name}:${level}`);
  }
  return { missing: missing.sort(), extra: extra.sort() };
}

/** The manifest's `default_permissions`, checked; throws on a malformed manifest. */
export function manifestPermissions(manifestText: string): Record<string, string> {
  const parsed = JSON.parse(manifestText) as { default_permissions?: unknown };
  const perms = parsed.default_permissions;
  if (typeof perms !== 'object' || perms === null || Array.isArray(perms)) {
    throw new Error('manifest_invalid');
  }
  const out: Record<string, string> = {};
  for (const [name, level] of Object.entries(perms)) {
    if (typeof level !== 'string' || RANK[level] === undefined) throw new Error('manifest_invalid');
    out[name] = level;
  }
  return out;
}
