#!/usr/bin/env node
// The version pull request, made mechanical (ADR-M104 §2.3, RELEASING.md §2):
//
//   pnpm release:prepare X.Y.Z [--tasks A01,B02] [--summary "<one sentence>"]
//
// Each pull request that needs an upgrade step writes its bullet under [Unreleased] →
// `### Upgrade notes` when it is made; without those notes this script refuses and changes
// nothing. Otherwise it: sets the root package.json and PLATFORM_VERSION; turns [Unreleased] into
// `## [X.Y.Z] - <today>` (with the summary in bold first) and leaves an empty [Unreleased]; moves
// the release's version in the README, TRIAL and USER-GUIDE; marks the tasks done in this version
// in scripts/generate-backlog.py and runs it; then runs the release gate. The `CLAUDE.md` state
// line and the milestone texts stay a person's (or Claude's) words: it says so.
// Exit 0 done, 1 refused (the reason on stderr), 2 usage.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';

const VERSION = /^(\d+)\.(\d+)\.(\d+)$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

function usage(message) {
  process.stderr.write(
    `release:prepare: ${message}\nUsage: pnpm release:prepare X.Y.Z [--tasks A01,B02] [--summary "<sentence>"]\n`,
  );
  process.exit(2);
}

function refuse(message) {
  process.stderr.write(`release:prepare: ${message}\n`);
  process.exit(1);
}

function newer(a, b) {
  const [x, y] = [VERSION.exec(a).slice(1).map(Number), VERSION.exec(b).slice(1).map(Number)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
}

function replaceAll(text, pairs, file) {
  let out = text;
  for (const [pattern, replacement] of pairs) {
    if (!pattern.test(out)) refuse(`${file}: ${pattern} not found; update it by hand`);
    out = out.replace(pattern, replacement);
  }
  return out;
}

const { values, positionals } = (() => {
  try {
    return parseArgs({
      args: process.argv.slice(2),
      allowPositionals: true,
      options: {
        tasks: { type: 'string' },
        summary: { type: 'string' },
        root: { type: 'string' },
        date: { type: 'string' },
        'no-generate': { type: 'boolean' },
      },
    });
  } catch (error) {
    return usage(error.message);
  }
})();
const version = positionals[0];
if (positionals.length !== 1 || !VERSION.test(version ?? ''))
  usage('give the new version as X.Y.Z');
const root = path.resolve(values.root ?? path.join(import.meta.dirname, '..', '..', '..'));
const date = values.date ?? new Date().toISOString().slice(0, 10);
if (!DATE.test(date)) usage('--date must be YYYY-MM-DD');
const tasks = values.tasks ? values.tasks.split(',').map((t) => t.trim()) : [];
if (tasks.some((t) => !/^[A-Z][A-Z0-9]*\d+[a-z]?$/.test(t)))
  usage('--tasks: task IDs such as O04,H03a');
if (values.summary !== undefined && /[\n*]/.test(values.summary))
  usage('--summary: one line, no *');

const file = (name) => path.join(root, name);
const read = (name) => fs.readFileSync(file(name), 'utf8');
const pkg = JSON.parse(read('package.json'));
const current = pkg.version;
if (!newer(version, current)) usage(`${version} is not above the current version ${current}`);

// The CHANGELOG first: everything else waits until the notes are there.
const changelog = read('CHANGELOG.md');
const head = '## [Unreleased]\n';
const start = changelog.indexOf(head);
if (start < 0) refuse('CHANGELOG.md has no ## [Unreleased] section');
const next = changelog.indexOf('\n## [', start + head.length);
const body = changelog.slice(start + head.length, next < 0 ? changelog.length : next + 1).trim();
const notes = /### Upgrade notes\n+- \S/.test(body);
if (!notes) {
  refuse(
    'CHANGELOG.md [Unreleased] has no "### Upgrade notes" with a first bullet. Each pull request writes its upgrade step there; write them, then run this again',
  );
}
const section = [
  `## [${version}] - ${date}`,
  ...(values.summary ? [`**${values.summary}**`] : []),
  body,
].join('\n\n');
const writes = new Map();
writes.set(
  'CHANGELOG.md',
  `${changelog.slice(0, start)}${head}\n${section}\n\n${next < 0 ? '' : changelog.slice(next + 1)}`,
);
writes.set('package.json', `${JSON.stringify({ ...pkg, version }, null, 2)}\n`);
writes.set(
  'platform/packages/api-schemas/src/version.ts',
  replaceAll(
    read('platform/packages/api-schemas/src/version.ts'),
    [[/PLATFORM_VERSION = '[^']+'/, `PLATFORM_VERSION = '${version}'`]],
    'version.ts',
  ),
);
const v = (s) => s.replaceAll('.', '\\.');
writes.set(
  'README.md',
  replaceAll(
    read('README.md'),
    [
      [new RegExp(`release-v${v(current)}-blue`), `release-v${version}-blue`],
      [
        new RegExp(`\\*\\*Status \\(\\d{4}-\\d{2}-\\d{2}\\): v${v(current)} is released`),
        `**Status (${date}): v${version} is released`,
      ],
      [new RegExp(`git checkout v${v(current)}`, 'g'), `git checkout v${version}`],
      [new RegExp(`Supported today \\(v${v(current)}\\)`), `Supported today (v${version})`],
    ],
    'README.md',
  ),
);
writes.set(
  'TRIAL.md',
  replaceAll(
    read('TRIAL.md'),
    [
      [
        new RegExp(
          `\\*\\*Status \\(\\d{4}-\\d{2}-\\d{2}\\):\\*\\* the latest release is \\*\\*v${v(current)}\\*\\*`,
        ),
        `**Status (${date}):** the latest release is **v${version}**`,
      ],
      [new RegExp(`\`git checkout v${v(current)}\``, 'g'), `\`git checkout v${version}\``],
    ],
    'TRIAL.md',
  ),
);
writes.set(
  'platform/USER-GUIDE.md',
  replaceAll(
    read('platform/USER-GUIDE.md'),
    [[new RegExp(`for example \`@${v(current)}\``), `for example \`@${version}\``]],
    'USER-GUIDE.md',
  ),
);
if (tasks.length > 0) {
  const backlog = read('scripts/generate-backlog.py');
  const done = /(\*\*\{t:"v[^"]+" for t in \([^)]*\)\})\}/;
  if (!done.test(backlog))
    refuse('scripts/generate-backlog.py: the DONE map was not found; mark the tasks by hand');
  const list = tasks.map((t) => `"${t}"`).join(',') + (tasks.length === 1 ? ',' : '');
  writes.set(
    'scripts/generate-backlog.py',
    backlog.replace(done, `$1,\n      **{t:"v${version}" for t in (${list})}}`),
  );
}

for (const [name, text] of writes) fs.writeFileSync(file(name), text);
// From here a failure leaves the files changed: say so, since a second run would refuse the
// version as "not above the current one".
const late = (message) =>
  refuse(
    `${message}\nThe files are changed already: fix the cause, then \`git checkout -- .\` and run this again`,
  );
if (tasks.length > 0 && !values['no-generate']) {
  const gen = spawnSync('python3', [file('scripts/generate-backlog.py')], {
    cwd: root,
    encoding: 'utf8',
  });
  if (gen.status !== 0) late(`generate-backlog.py failed: ${gen.stderr.trim()}`);
}
const gate = spawnSync(
  'node',
  [path.join(import.meta.dirname, 'release-check.mjs'), 'tag', `v${version}`, '--root', root],
  { encoding: 'utf8' },
);
process.stdout.write(gate.stdout);
if (gate.status !== 0) late(`the release gate refused v${version}:\n${gate.stderr}`);
process.stdout.write(
  `release:prepare: v${version} is ready. By hand: the CLAUDE.md state line ("v${version} in release") and, when the release closes a milestone, its text in scripts/generate-backlog.py (MS and the mermaid line); then the version pull request.\n`,
);
