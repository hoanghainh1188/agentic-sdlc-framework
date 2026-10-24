// O02: reads the "Upgrade notes" of `CHANGELOG.md` (RELEASING.md §1). The first bullet of a
// section's notes holds what every running stack must do ("On a running stack: …", or "No
// migration, …"); later bullets are optional or explain each change. The live test
// `pnpm test:upgrade` runs the credentials commands of the first bullets between two releases; the
// static test `upgrade-readme.test.ts` keeps every first bullet readable by this parser.

/** A release section of the CHANGELOG: `0.6.0`, or `Unreleased`. */
export interface ReleaseSection {
  readonly version: string;
  readonly body: string;
}

/** The sections `## [Unreleased]` and `## [X.Y.Z] - YYYY-MM-DD`, newest first (the release gate's format). */
export function releaseSections(changelog: string): ReleaseSection[] {
  const heads = [...changelog.matchAll(/^## [^\n]*$/gm)];
  return heads.flatMap((m, i) => {
    const version = /^## \[(Unreleased|\d+\.\d+\.\d+)\](?: - \d{4}-\d{2}-\d{2})?$/.exec(m[0])?.[1];
    if (!version) return [];
    const end = heads[i + 1]?.index ?? changelog.length;
    return [{ version, body: changelog.slice(m.index + m[0].length, end) }];
  });
}

/** The bullets of the section's `### Upgrade notes`, each joined into one line. */
export function upgradeBullets(body: string): string[] {
  const start = body.indexOf('### Upgrade notes');
  if (start < 0) return [];
  const rest = body.slice(start + '### Upgrade notes'.length);
  const end = rest.search(/^### /m);
  const list = end < 0 ? rest : rest.slice(0, end);
  return list
    .split(/^- /m)
    .slice(1)
    .map((b) => b.replace(/\s+/g, ' ').trim());
}

/** The `pnpm openbao:bootstrap <command>` of one bullet, in their order. */
export function bootstrapCommands(bullet: string): string[] {
  return [...bullet.matchAll(/pnpm openbao:bootstrap ([a-z][a-z-]*)/g)].map((m) => m[1]!);
}

/** `0.6.0` → [0, 6, 0]; refuses anything that is not `X.Y.Z`. */
function parts(version: string): [number, number, number] {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!m) throw new Error(`not a version: ${version}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

export function compareVersions(a: string, b: string): number {
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i]! - y[i]!;
  return 0;
}

/**
 * The sections an upgrade from `from` (a tag `vX.Y.Z`) to `to` (a tag, or `HEAD` for this
 * checkout: its `[Unreleased]` too) must follow, oldest first.
 */
export function sectionsBetween(changelog: string, from: string, to: string): ReleaseSection[] {
  const sections = releaseSections(changelog);
  const released = sections.filter(
    (s) =>
      s.version !== 'Unreleased' &&
      compareVersions(s.version, from) > 0 &&
      (to === 'HEAD' || compareVersions(s.version, to) <= 0),
  );
  const unreleased = sections.filter((s) => s.version === 'Unreleased' && to === 'HEAD');
  return [...released.reverse(), ...unreleased];
}

/** The credentials commands (and `configure`) every running stack runs, in order, without repeats. */
export function requiredBootstrapCommands(sections: readonly ReleaseSection[]): string[] {
  const all = sections.flatMap((s) => bootstrapCommands(upgradeBullets(s.body)[0] ?? ''));
  return [...new Set(all)];
}
