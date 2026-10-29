// Reading and checking the project file of `adlc admin project apply` (task V17 AC1, AC3). Every
// check here runs before the first API call that writes; a problem is a `Refusal` (a catalog key
// and its values), and all of them are printed together.
import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';
import path from 'node:path';

import { projectFileSchema, PROJECT_FILE_MAX_BYTES, type ProjectFile } from '@sdlc/api-schemas';
import { formatIssue, loadProjectConfig, readYamlMapping } from '@sdlc/config';
import { PROJECT_ROLES } from '@sdlc/contracts';
import type { MessageKey } from '@sdlc/messages';
import { stringify } from 'yaml';

/** Largest instructions file hashed (an AGENTS.md is a few KiB). */
const MAX_INSTRUCTIONS_BYTES = 1024 * 1024;

export interface Refusal {
  readonly key: MessageKey;
  readonly params: Readonly<Record<string, string>>;
}

export interface CheckedFile {
  readonly file: ProjectFile;
  /** The `config` part as YAML for `PUT …/config`; undefined when the file has none. */
  readonly configYaml: string | undefined;
  /** The SHA-256 of the agent's instructions file; undefined without an agent. */
  readonly instructionsSha256: string | undefined;
}

export type FileResult =
  | { readonly ok: true; readonly checked: CheckedFile }
  | { readonly ok: false; readonly refusals: readonly Refusal[] };

const refusal = (key: MessageKey, params: Record<string, string> = {}): Refusal => ({
  key,
  params,
});

/** Reads a regular file of at most `max` bytes, as UTF-8; undefined when it cannot. */
async function readSmallFile(file: string, max: number): Promise<Buffer | undefined> {
  try {
    const handle = await open(file, 'r');
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > max) return undefined;
      return await handle.readFile();
    } finally {
      await handle.close();
    }
  } catch {
    return undefined;
  }
}

export async function readProjectFile(file: string): Promise<FileResult> {
  const raw = await readSmallFile(file, PROJECT_FILE_MAX_BYTES);
  if (raw === undefined) {
    return {
      ok: false,
      refusals: [
        refusal('cli.admin.api.file_unreadable', {
          path: file,
          max: String(PROJECT_FILE_MAX_BYTES),
        }),
      ],
    };
  }
  // No YAML alias: a project file is short and written by hand (ADR-M40 §2.2 does the same).
  const yaml = readYamlMapping(raw.toString('utf8'), { maxAliasCount: 0 });
  if (!yaml.ok) {
    return {
      ok: false,
      refusals: yaml.errors.map((e) =>
        refusal('cli.admin.apply.yaml', { problem: formatIssue(e) }),
      ),
    };
  }
  const parsed = projectFileSchema.safeParse(yaml.value);
  if (!parsed.success) {
    return {
      ok: false,
      // An unknown key (for example a token pasted in by mistake) is named by its key.
      refusals: parsed.error.issues.flatMap((issue) =>
        (issue.code === 'unrecognized_keys' ? issue.keys : ['']).map((key) =>
          refusal('cli.admin.apply.field', {
            field: [...issue.path, ...(key === '' ? [] : [key])].join('.') || '-',
          }),
        ),
      ),
    };
  }
  const checked = parsed.data;
  const refusals = checkTeam(checked);
  const configYaml = checked.config === undefined ? undefined : stringify(checked.config);
  if (configYaml !== undefined) {
    const config = loadProjectConfig(configYaml);
    if (!config.ok) {
      refusals.push(
        ...config.errors.map((e) => refusal('cli.admin.apply.config', { problem: formatIssue(e) })),
      );
    }
  }
  const instructionsSha256 = await instructionsHash(file, checked, refusals);
  return refusals.length > 0
    ? { ok: false, refusals }
    : { ok: true, checked: { file: checked, configYaml, instructionsSha256 } };
}

/** People appear once, every role exists, the agent's owner is in the team. */
function checkTeam(file: ProjectFile): Refusal[] {
  const refusals: Refusal[] = [];
  const emails = new Set<string>();
  const logins = new Set<string>();
  for (const person of file.team) {
    const email = person.email.toLowerCase();
    const login = person.github_login.toLowerCase();
    if (emails.has(email)) refusals.push(refusal('cli.admin.apply.duplicate_email', { email }));
    if (logins.has(login)) {
      refusals.push(refusal('cli.admin.apply.duplicate_login', { login: person.github_login }));
    }
    emails.add(email);
    logins.add(login);
    for (const role of person.roles) {
      if (!(PROJECT_ROLES as readonly string[]).includes(role)) {
        refusals.push(refusal('cli.admin.apply.unknown_role', { email: person.email, role }));
      }
    }
  }
  if (file.agent && !emails.has(file.agent.owner.toLowerCase())) {
    refusals.push(refusal('cli.admin.apply.owner_not_in_team', { email: file.agent.owner }));
  }
  return refusals;
}

/** The SHA-256 of the instructions file, relative to the project file. */
async function instructionsHash(
  projectFile: string,
  file: ProjectFile,
  refusals: Refusal[],
): Promise<string | undefined> {
  if (!file.agent) return undefined;
  const target = path.resolve(path.dirname(projectFile), file.agent.instructions_file);
  const content = await readSmallFile(target, MAX_INSTRUCTIONS_BYTES);
  if (content === undefined) {
    refusals.push(
      refusal('cli.admin.api.file_unreadable', {
        path: file.agent.instructions_file,
        max: String(MAX_INSTRUCTIONS_BYTES),
      }),
    );
    return undefined;
  }
  return createHash('sha256').update(content).digest('hex');
}
