// `pnpm trial:up` (D-08 V02): platform/deploy/README.md "Fresh deployment (operator)", steps 2–13,
// in that order, on a developer machine, with THROW-AWAY keys. The same steps as the live test
// `fresh-deploy.test.ts`; the static test `trial-up-static.test.ts` keeps both in step with the
// README. What differs from the README, and why:
// - the key shares and the root token are kept in this process's memory (`SecretBag`) and dropped
//   once the credentials commands ran; the root token is revoked (QUESTIONS #345: the trial stack
//   cannot be unsealed again after a reboot, it is wiped and set up again);
// - Person A is the tenant admin (QUESTIONS #346): `ops bootstrap` makes them the first user, and
//   `ops role grant` gives them `person_a` (nobody grants a role to themselves through the API);
// - Person B's token comes from `ops token issue` (90 days): a token a tenant admin issues for
//   someone else lives at most 7 days (B13), shorter than a trial;
// - each person's token goes only into their own credentials file, through `sdlc login`.
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { MessageKey, MessageParams } from '@sdlc/messages';

import {
  envSecrets,
  envValue,
  hostPort,
  trialApiUrl,
  trialEnv,
  type ProjectOverride,
} from './env-file.js';
import { parseInitOutput, SecretBag } from './secrets.js';
import { MODEL_NAMES, type TrialPerson, type TrialSettings } from './settings.js';
import { TRIAL_AGENT_KEY, TRIAL_AGENT_VERSION, trialProjectConfig } from './trial-config.js';

/** README step 5, in its order: the credentials of every process. */
export const CREDENTIALS_COMMANDS = [
  'litellm-credentials',
  'api-credentials',
  'worker-credentials',
  'runner-credentials',
  'runner-evidence-credentials',
  'api-evidence-credentials',
  'worker-evidence-credentials',
  'worker-purge-credentials',
  'worker-anchor-credentials',
  'backup-credentials',
] as const;

/** README step 7: every profile of the server except `observability` (heavy; optional). */
export const PROFILES = ['core', 'models', 'platform', 'sandbox'] as const;

/** The progress message of each README step. */
const STEP_MESSAGES = {
  '2': 'trial.step.2',
  '3': 'trial.step.3',
  '4': 'trial.step.4',
  '5': 'trial.step.5',
  '6': 'trial.step.6',
  '7': 'trial.step.7',
  '8': 'trial.step.8',
  '9': 'trial.step.9',
  '10': 'trial.step.10',
  '11': 'trial.step.11',
  '12': 'trial.step.12',
  '13': 'trial.step.13',
} as const satisfies Record<string, MessageKey>;

/** The agent's tools (handbook Ch.20; ADR-M29: the only tools the adapter allows). */
const AGENT_TOOLS = 'file_editor,task_tracker,terminal';

export interface ExecResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export type Exec = (
  cmd: string,
  args: readonly string[],
  opts?: { readonly input?: string; readonly env?: Readonly<Record<string, string>> },
) => Promise<ExecResult>;

/** One `sdlc …` command in this process (`runCli`); stdout is its `--json` answer. */
export type Sdlc = (
  argv: readonly string[],
  env: Readonly<Record<string, string>>,
  stdin?: string,
) => Promise<ExecResult>;

export interface UpDeps {
  readonly repoRoot: string;
  readonly envFile: string;
  readonly override?: ProjectOverride;
  readonly exec: Exec;
  readonly sdlc: Sdlc;
  readonly progress: (key: MessageKey, params?: MessageParams) => void;
  /** A sandbox image already built, by digest (`SDLC_SANDBOX_IMAGE`), or build one. */
  readonly sandboxImage?: string;
  readonly dockerDesktop: boolean;
}

export interface UpResult {
  readonly apiUrl: string;
  readonly project: string;
  readonly composeProject: string;
  readonly model: string;
  readonly sandboxImage: string;
}

/** A step that failed: its README step and the redacted end of its output. */
export class TrialStepError extends Error {
  constructor(
    readonly step: string,
    readonly detail: string,
  ) {
    super(`trial:up step ${step} failed`);
  }
}

export async function trialUp(settings: TrialSettings, deps: UpDeps): Promise<UpResult> {
  const bag = new SecretBag();
  const deployDir = path.join(deps.repoRoot, 'platform/deploy');
  const step = (n: keyof typeof STEP_MESSAGES) => deps.progress(STEP_MESSAGES[n]);

  const ok = (r: ExecResult, what: string): ExecResult => {
    if (r.status !== 0) {
      const tail = bag.redact(`${r.stderr}\n${r.stdout}`).trim().split('\n').slice(-30).join('\n');
      throw new TrialStepError(what, tail);
    }
    return r;
  };
  const run = (
    cmd: string,
    args: readonly string[],
    input = '',
    env: Record<string, string> = {},
  ) => deps.exec(cmd, args, { input, env: { SDLC_ENV_FILE: deps.envFile, ...env } });
  // Always with `-p`: the project of the trial's env file, never one of the shell (review V02).
  let composeProject = '';
  const compose = (input: string, ...args: string[]) =>
    run(
      'docker',
      [
        'compose',
        '-p',
        composeProject,
        '-f',
        path.join(deployDir, 'docker-compose.yml'),
        '--env-file',
        deps.envFile,
        ...args,
      ],
      input,
    );
  const bootstrap = (args: readonly string[], input = '') =>
    run(path.join(deployDir, 'openbao/bootstrap.sh'), args, input, { SDLC_OPENBAO_THROWAWAY: '1' });

  // Step 2: the settings file, in the trial's own Compose project.
  step('2');
  ok(await run(path.join(deployDir, 'scripts/init-env.sh'), [deps.envFile]), 'compose:env');
  const envText = trialEnv(fs.readFileSync(deps.envFile, 'utf8'), deps.override);
  fs.writeFileSync(deps.envFile, envText, { mode: 0o600 });
  const appDbPassword = bag.keep(envValue(envText, 'PLATFORM_APP_DB_PASSWORD') ?? '');
  const ownerDbPassword = bag.keep(envValue(envText, 'PLATFORM_DB_PASSWORD') ?? '');
  const pgPort = hostPort(envText, 'POSTGRES_HOST_PORT', 5432);
  const apiUrl = trialApiUrl(envText);
  for (const value of envSecrets(envText)) bag.keep(value);
  composeProject = envValue(envText, 'COMPOSE_PROJECT_NAME') ?? '';

  // Step 3: OpenBao with throw-away keys, in memory only.
  step('3');
  ok(
    await compose(
      '',
      '--profile',
      'core',
      'up',
      '-d',
      '--wait',
      'openbao',
      'postgres',
      'seaweedfs',
    ),
    'openbao',
  );
  const init = ok(await bootstrap(['init', '--stdout-not-tty']), 'openbao:init');
  // Kept before anything else reads the output, so a failure below never shows a share.
  for (const m of init.stdout.matchAll(/^(?:Unseal Key \d+|Initial Root Token): (\S+)$/gm))
    bag.keep(m[1]!);
  const { shares, rootToken } = parseInitOutput(init.stdout);
  try {
    ok(await bootstrap(['unseal'], `${shares[0]}\n${shares[1]}\n`), 'openbao:unseal');
  } finally {
    // Never needed again: the trial stack is never unsealed a second time (QUESTIONS #345).
    for (const share of shares) bag.drop(share);
    shares.length = 0;
  }
  /** An admin command in the OpenBao container: the root token and the values come on stdin. */
  const admin = async (script: string, input: string, what: string) =>
    ok(
      await compose(
        `${rootToken}\n${input}`,
        'exec',
        '-T',
        'openbao',
        'sh',
        '-c',
        `IFS= read -r t; export BAO_TOKEN="$t"; ${script}`,
      ),
      what,
    );

  let rootRevoked = false;
  try {
    ok(await bootstrap(['configure', '--keep-token'], `${rootToken}\n`), 'openbao:configure');

    // Step 4: the shared secrets, on stdin (never on a command line).
    step('4');
    const appKey = bag.keep(fs.readFileSync(settings.appKeyFile, 'utf8').trim());
    await admin(
      'IFS= read -r CLIENT_ID; bao kv put -mount=kv shared/github-app client_id="$CLIENT_ID" private_key=- >/dev/null',
      `${settings.appClientId}\n${appKey}\n`,
      'secrets:github-app',
    );
    const random = () => bag.keep(`sk-${randomBytes(24).toString('hex')}`);
    await admin(
      'IFS= read -r m; IFS= read -r s; ' +
        'printf %s "$m" | bao kv put -mount=kv cost-controller/litellm-master-key value=- >/dev/null && ' +
        'printf %s "$s" | bao kv put -mount=kv litellm/salt-key value=- >/dev/null',
      `${random()}\n${random()}\n`,
      'secrets:litellm',
    );
    if (settings.model.provider === 'anthropic') {
      const key = bag.keep(fs.readFileSync(settings.model.apiKeyFile, 'utf8').trim());
      await admin(
        'IFS= read -r p; printf %s "$p" | bao kv put -mount=kv litellm/providers/anthropic api_key=- >/dev/null',
        `${key}\n`,
        'secrets:anthropic',
      );
    } else {
      await admin(
        'IFS= read -r u; bao kv put -mount=kv litellm/providers/ollama api_base="$u" >/dev/null',
        `${settings.model.ollamaUrl}\n`,
        'secrets:ollama',
      );
    }

    // Step 5: the credentials of every process; then the root token is revoked and forgotten.
    step('5');
    for (const command of CREDENTIALS_COMMANDS) {
      ok(await bootstrap([command], `${rootToken}\n`), command);
    }
    await admin('bao token revoke -self >/dev/null', '', 'openbao:revoke-root');
    rootRevoked = true;
  } finally {
    // Also when a step failed: no root token stays valid once trial:up has stopped.
    if (!rootRevoked) {
      await compose(
        `${rootToken}\n`,
        'exec',
        '-T',
        'openbao',
        'sh',
        '-c',
        'IFS= read -r t; BAO_TOKEN="$t" bao token revoke -self >/dev/null 2>&1',
      ).catch(() => undefined);
    }
    bag.drop(rootToken);
  }

  // Step 6: the database.
  step('6');
  const pgUrl = (user: string, password: string) =>
    `postgres://${user}:${encodeURIComponent(password)}@127.0.0.1:${pgPort}/platform`;
  bag.keep(pgUrl('platform', ownerDbPassword));
  ok(
    await run(
      'node',
      [path.join(deps.repoRoot, 'platform/packages/core/dist/db/migrate-cli.js'), 'latest'],
      '',
      {
        SDLC_DB_MIGRATION_URL: pgUrl('platform', ownerDbPassword),
      },
    ),
    'db:migrate',
  );
  const opsUrl = bag.keep(pgUrl('platform_app', appDbPassword));

  // Step 7: the platform.
  step('7');
  ok(
    await run(path.join(deployDir, 'scripts/up.sh'), [...PROFILES], '', {
      SDLC_WAIT_TIMEOUT: '900',
    }),
    'up.sh',
  );

  // Steps 8–9: the tenant, Person A as its first admin, the project and its team.
  step('8');
  const sdlcJson = async (argv: readonly string[], env: Record<string, string>, what: string) => {
    const r = ok(await deps.sdlc([...argv, '--json'], env), what);
    return JSON.parse(r.stdout) as Record<string, unknown>;
  };
  const ops = (argv: readonly string[]) =>
    sdlcJson(['ops', ...argv], { SDLC_DB_URL: opsUrl }, `sdlc ops ${argv[0]}`);
  const tokens = { a: '', b: '' };
  const asA = (argv: readonly string[]) =>
    sdlcJson(
      argv,
      { SDLC_API_URL: apiUrl, SDLC_API_TOKEN: tokens.a },
      `sdlc ${argv.slice(0, 3).join(' ')}`,
    );
  const asB = (argv: readonly string[]) =>
    sdlcJson(
      argv,
      { SDLC_API_URL: apiUrl, SDLC_API_TOKEN: tokens.b },
      `sdlc ${argv.slice(0, 3).join(' ')}`,
    );
  const { personA: a, personB: b, tenant, project } = settings;

  const boot = await ops([
    'bootstrap',
    '--tenant',
    tenant,
    '--tenant-name',
    'Trial',
    '--email',
    a.email,
    '--name',
    a.name,
  ]);
  tokens.a = bag.keep(String(boot.token));
  step('9');
  await asA([
    'admin',
    'project',
    'create',
    '--slug',
    project,
    '--name',
    'Pilot (trial)',
    '--repo',
    settings.forkRepo,
  ]);
  await ops([
    'role',
    'grant',
    '--tenant',
    tenant,
    '--project',
    project,
    '--email',
    a.email,
    '--role',
    'person_a',
  ]);
  await asA([
    'admin',
    'identity',
    'link',
    '--user',
    a.email,
    '--github-id',
    a.githubId,
    '--github-login',
    a.githubLogin,
  ]);
  await asA(['admin', 'user', 'create', '--email', b.email, '--name', b.name]);
  await asA([
    'admin',
    'identity',
    'link',
    '--user',
    b.email,
    '--github-id',
    b.githubId,
    '--github-login',
    b.githubLogin,
  ]);
  await asA([
    'admin',
    'role',
    'grant',
    '--project',
    project,
    '--user',
    b.email,
    '--role',
    'person_b',
  ]);
  const issued = await ops([
    'token',
    'issue',
    '--tenant',
    tenant,
    '--email',
    b.email,
    '--name',
    'trial',
    '--days',
    '90',
  ]);
  tokens.b = bag.keep(String(issued.token));

  // Step 10: the sandbox image, by digest.
  step('10');
  let image = deps.sandboxImage ?? '';
  if (!image) {
    const built = ok(
      await run(
        path.join(deps.repoRoot, 'platform/sandbox-images/build.sh'),
        ['node24', ...(deps.dockerDesktop ? ['--no-push'] : [])],
        '',
        {
          SDLC_SANDBOX_REGISTRY: `localhost:${hostPort(envText, 'SDLC_REGISTRY_HOST_PORT', 5050)}`,
        },
      ),
      'sandbox-image:build',
    );
    image = built.stdout.trim().split('\n').pop() ?? '';
  }

  // Step 11: the agent, with the instructions file of the fork's `main`; owner Person A.
  step('11');
  const model = MODEL_NAMES[settings.model.provider];
  const instructions = ok(
    await deps.exec('git', ['-C', settings.forkClone, 'show', 'main:AGENTS.md']),
    'git show main:AGENTS.md',
  );
  const head = ok(
    await deps.exec('git', ['-C', settings.forkClone, 'rev-parse', '--short=12', 'main']),
    'git rev-parse main',
  );
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'sdlc-trial-'));
  try {
    const agentsMd = path.join(work, 'AGENTS.md');
    fs.writeFileSync(agentsMd, instructions.stdout);
    await asA([
      'admin',
      'agent',
      'register',
      '--key',
      TRIAL_AGENT_KEY,
      '--version',
      TRIAL_AGENT_VERSION,
      '--owner',
      a.email,
      '--model',
      model,
      '--instructions',
      `AGENTS.md@main-${head.stdout.trim()}`,
      '--instructions-file',
      agentsMd,
      '--tools',
      AGENT_TOOLS,
      '--max-autonomy',
      'L2',
      '--environments',
      'sandbox',
    ]);
    await asA([
      'admin',
      'agent',
      'approve',
      '--key',
      TRIAL_AGENT_KEY,
      '--purpose',
      'activate',
      '--as',
      'owner',
    ]);
    await asB([
      'admin',
      'agent',
      'approve',
      '--key',
      TRIAL_AGENT_KEY,
      '--purpose',
      'activate',
      '--as',
      'person_b',
    ]);

    // Step 12: the trial configuration (M-E-TRIAL-PLAN §6).
    step('12');
    const shown = await asA(['admin', 'config', 'show', '--project', project]);
    const config = path.join(work, `${project}.yaml`);
    fs.writeFileSync(config, trialProjectConfig(image));
    await asA([
      'admin',
      'config',
      'set',
      '--project',
      project,
      '--file',
      config,
      '--expected-version',
      String(shown.version),
    ]);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }

  // Step 13: the project AI record, by Person A (the project is fictional: `internal`).
  step('13');
  await asA([
    'ai-record',
    'set',
    '--project',
    project,
    '--expected-version',
    '0',
    '--ai-allowed',
    'yes',
    '--classes',
    'public,internal',
    '--prod-logs',
    'no',
    '--disclosure',
    'standard_note',
  ]);
  // Last: the logins, so a failure above never leaves a credentials file behind (review V02).
  await login(a, tokens.a);
  await login(b, tokens.b);
  return { apiUrl, project, composeProject, model, sandboxImage: image };

  /** `sdlc login --token-stdin` into the person's own config folder (mode 600, by the CLI). */
  async function login(p: TrialPerson, token: string): Promise<void> {
    fs.mkdirSync(p.configHome, { recursive: true, mode: 0o700 });
    ok(
      await deps.sdlc(
        ['login', '--api-url', apiUrl, '--token-stdin', '--json'],
        { XDG_CONFIG_HOME: p.configHome },
        token,
      ),
      'sdlc login',
    );
  }
}
