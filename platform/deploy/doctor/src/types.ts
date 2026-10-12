// The facts `pnpm doctor` gathers and the results its checks give (D-08 V07 AC1). Facts hold codes,
// counts, dates, names of services and variables, and repository names: never a secret value
// (`env-facts.ts` keeps only whether a secret is set), never a log line or a command's output.
import type { MessageKey, MessageParams } from '@sdlc/messages';

export type CheckStatus = 'ok' | 'warning' | 'failed' | 'skipped';

export interface Text {
  readonly key: MessageKey;
  readonly params?: MessageParams;
}

export interface CheckResult {
  readonly id: CheckId;
  /** What the line is about when one check gives several lines (a service, a project, a repo). */
  readonly subject?: string;
  readonly status: CheckStatus;
  readonly text: Text;
  /** The command or README / runbook section that fixes it; set for `warning` and `failed`. */
  readonly fix?: Text;
}

export const CHECK_IDS = [
  'host.docker',
  'host.memory',
  'host.disk',
  'env.file',
  'env.secrets',
  'services.health',
  'openbao.state',
  'openbao.tls_files',
  'openbao.tls_expiry',
  'db.migrations',
  'credentials.approle',
  'credentials.logs',
  'models.litellm',
  'valkey.memory',
  'sandbox.image',
  'github.app',
  'images.mode',
] as const;
export type CheckId = (typeof CHECK_IDS)[number];

export type SecretState = 'set' | 'empty' | 'placeholder' | 'missing';

export interface EnvFacts {
  /** Allowlisted, non-secret settings only (`env-facts.ts` `ENV_ALLOWLIST`). */
  readonly values: Readonly<Record<string, string>>;
  /** Whether each required secret is set; never its value. */
  readonly secrets: Readonly<Record<string, SecretState>>;
}

export interface ServiceState {
  readonly service: string;
  /** Docker's state: `running`, `exited`, `restarting`, `created`, `paused`, `dead`. */
  readonly state: string;
  /** `healthy`, `unhealthy`, `starting`, or empty without a health check. */
  readonly health: string;
  readonly exitCode: number;
}

export type OpenBaoState = 'uninitialised' | 'sealed' | 'unsealed' | 'unreachable';

export interface CertFact {
  readonly name: 'ca' | 'server';
  /** ISO time; null when the file is missing or not a certificate. */
  readonly notAfter: string | null;
}

export interface AppRoleFact {
  readonly service: string;
  /** `credentials` of `pnpm openbao:bootstrap <credentials>`. */
  readonly credentials: string;
  readonly state: 'ok' | 'missing' | 'unreadable' | 'not_running';
  /** Age of the secret ID file in days (state `ok`). */
  readonly ageDays?: number;
}

export interface LogFindings {
  /** Event codes found (one each), already mapped to their fix (`logs.ts`). */
  readonly events: readonly string[];
  /** Services whose start event (`*.started`) is in the window. */
  readonly started: readonly string[];
}

export interface GitHubAppFact {
  readonly permissions: Readonly<Record<string, string>>;
}

export type RepoFact =
  | {
      readonly repo: string;
      readonly installed: true;
      readonly selection: 'all' | 'selected';
      readonly permissions: Readonly<Record<string, string>>;
    }
  | { readonly repo: string; readonly installed: false };

export type GitHubFact =
  | { readonly ok: true; readonly app: GitHubAppFact; readonly repos: readonly RepoFact[] }
  | { readonly ok: false; readonly error: string };

export interface ProjectImageFact {
  readonly project: string;
  /** The effective `sandbox.image`; null when the stored configuration is not valid. */
  readonly image: string | null;
  /** Present in the local Docker image store; null when not asked. */
  readonly present: boolean | null;
}

export interface OperatorFacts {
  readonly now: Date;
  readonly envFile: {
    readonly path: string;
    readonly exists: boolean;
    readonly mode: number | null;
    readonly facts?: EnvFacts;
  };
  /** null: no Docker, or the daemon does not answer. */
  readonly docker: {
    readonly serverVersion: string | null;
    readonly composeVersion: string | null;
    readonly memoryBytes: number | null;
  } | null;
  readonly disk: readonly { readonly path: string; readonly freeBytes: number | null }[];
  /** null: `docker compose ps` failed; empty: nothing of the project runs. */
  readonly services?: readonly ServiceState[] | null;
  readonly openbao?: OpenBaoState;
  readonly tls?: {
    readonly dir: string | null;
    readonly missing: readonly string[];
    readonly certs: readonly CertFact[];
  };
  /** `applied` null: the table could not be read. */
  readonly migrations?: {
    readonly expected: readonly string[];
    readonly applied: readonly string[] | null;
  };
  readonly approles?: readonly AppRoleFact[];
  /** null: the logs could not be read. */
  readonly logs?: LogFindings | null;
  /** null: could not be read. */
  readonly valkey?: { readonly usedBytes: number; readonly maxBytes: number } | null;
  readonly github?: GitHubFact;
  /** The App manifest's `default_permissions`. */
  readonly manifest: Readonly<Record<string, string>>;
  /** null: could not be read. */
  readonly projects?: readonly ProjectImageFact[] | null;
  readonly imagesMode?: 'local' | 'published' | 'failed';
}
