// `pnpm trial:up` (D-08 V02): platform/deploy/README.md "Fresh deployment (operator)", steps 2–13,
// in that order, on a developer machine, with THROW-AWAY keys. Steps 3–7 are the shared steps of
// `pnpm server:setup` and the live test `fresh-deploy.test.ts` (`platform/deploy/steps`, V16); the
// static test `trial-up-static.test.ts` keeps them in step with the README. What differs from the README, and why:
// - the key shares and the root token are kept in this process's memory (`SecretBag`). The root
//   token is used only for `configure`, which revokes it and gives one admin token for steps 4
//   and 5 (D-08 V16), revoked afterwards. The two shares that unseal are also written, encrypted
//   with the person's passphrase, to the key file next to the env file, so `pnpm trial:start` can
//   unseal the stack after a reboot (V08, QUESTIONS #356, design/ADR-M76);
// - Person A is the tenant admin (QUESTIONS #346): `ops bootstrap` makes them the first user, and
//   `ops role grant` gives them `person_a` (nobody grants a role to themselves through the API);
// - Person B's token comes from `ops token issue` (90 days): a token a tenant admin issues for
//   someone else lives at most 7 days (B13), shorter than a trial;
// - each person's token goes only into their own credentials file, through `sdlc login`.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { MessageKey, MessageParams } from '@sdlc/messages';

import { databaseUrl } from '../../steps/dist/env-file.js';
import type { Exec, ExecResult } from '../../steps/dist/exec.js';
import {
  CREDENTIALS_COMMANDS,
  DeployStepError,
  FreshDeployment,
  PROFILES,
} from '../../steps/dist/fresh-deployment.js';

import {
  envSecrets,
  envValue,
  hostPort,
  trialApiUrl,
  trialEnv,
  type ProjectOverride,
} from './env-file.js';
import { encryptKeys, KEY_THRESHOLD, KeyFileError, writeKeyFile } from './keys.js';
import { parseInitOutput, SecretBag } from './secrets.js';
import { MODEL_NAMES, type TrialPerson, type TrialSettings } from './settings.js';
import { TRIAL_AGENT_KEY, TRIAL_AGENT_VERSION, trialProjectConfig } from './trial-config.js';

export { CREDENTIALS_COMMANDS, PROFILES };
export type { Exec, ExecResult };

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
  /**
   * A sandbox image already built, by digest (`SDLC_SANDBOX_IMAGE`); else the release's published
   * image on a release checkout (V04), else build one.
   */
  readonly sandboxImage?: string;
  readonly dockerDesktop: boolean;
  /** The passphrase of the key file (V08), already checked; kept in memory only. */
  readonly passphrase: string;
  /** Where the key file goes (`keyFileFor(envFile)`). */
  readonly keyFile: string;
}

export interface UpResult {
  readonly apiUrl: string;
  readonly project: string;
  readonly composeProject: string;
  readonly model: string;
  readonly sandboxImage: string;
}

/** A step that failed: its README step and the redacted end of its output. */
export { DeployStepError as TrialStepError };

export async function trialUp(settings: TrialSettings, deps: UpDeps): Promise<UpResult> {
  const bag = new SecretBag();
  bag.keep(deps.passphrase);
  const deployDir = path.join(deps.repoRoot, 'platform/deploy');
  const step = (n: keyof typeof STEP_MESSAGES) => deps.progress(STEP_MESSAGES[n]);
  const run = (
    cmd: string,
    args: readonly string[],
    input = '',
    env: Record<string, string> = {},
  ) => deps.exec(cmd, args, { input, env: { SDLC_ENV_FILE: deps.envFile, ...env } });

  // Step 2: the settings file, in the trial's own Compose project.
  step('2');
  const initEnv = await run(path.join(deployDir, 'scripts/init-env.sh'), [deps.envFile]);
  if (initEnv.status !== 0) throw new DeployStepError('compose:env', bag.redact(initEnv.stderr));
  const envText = trialEnv(fs.readFileSync(deps.envFile, 'utf8'), deps.override);
  fs.writeFileSync(deps.envFile, envText, { mode: 0o600 });
  const apiUrl = trialApiUrl(envText);
  for (const value of envSecrets(envText)) bag.keep(value);
  // Always with `-p`: the project of the trial's env file, never one of the shell (review V02).
  const composeProject = envValue(envText, 'COMPOSE_PROJECT_NAME') ?? '';
  const deploy = new FreshDeployment({
    repoRoot: deps.repoRoot,
    envFile: deps.envFile,
    composeProject,
    exec: deps.exec,
    bag,
    bootstrapEnv: { SDLC_OPENBAO_THROWAWAY: '1' },
  });
  const ok = (r: ExecResult, what: string): ExecResult => deploy.ok(r, what);

  // Step 3: OpenBao with throw-away keys, in memory only.
  step('3');
  await deploy.startStores();
  const init = ok(await deploy.bootstrap(['init', '--stdout-not-tty']), 'openbao:init');
  // Kept before anything else reads the output, so a failure below never shows a share.
  for (const m of init.stdout.matchAll(/^(?:Unseal Key \d+|Initial Root Token): (\S+)$/gm))
    bag.keep(m[1]!);
  const { shares, rootToken } = parseInitOutput(init.stdout);
  let adminToken = '';
  try {
    try {
      await deploy.unseal(shares.slice(0, KEY_THRESHOLD));
      // V08: the two shares that unseal, encrypted in memory with the passphrase; only the
      // ciphertext reaches the disk. Written now, so a later failure still leaves a usable file.
      try {
        const record = {
          project: composeProject,
          createdAt: new Date().toISOString(),
          shares: shares.slice(0, KEY_THRESHOLD),
        };
        writeKeyFile(deps.keyFile, await encryptKeys(record, deps.passphrase));
      } catch (error) {
        if (error instanceof KeyFileError) throw new DeployStepError('key-file', error.code);
        throw error;
      }
      deps.progress('trial.keys.saved', { path: deps.keyFile });
    } finally {
      // Gone from memory: from now on only the key file holds them, encrypted (V08).
      for (const share of shares) bag.drop(share);
      shares.length = 0;
    }
    // The root token is used only for `configure`, which revokes it (V16).
    adminToken = await deploy.configure(rootToken);
  } finally {
    // Also when a step failed: no root token stays valid once trial:up has stopped.
    if (!adminToken) await deploy.revoke(rootToken);
    bag.drop(rootToken);
  }

  try {
    // Step 4: the shared secrets, on stdin (never on a command line).
    step('4');
    const appKey = fs.readFileSync(settings.appKeyFile, 'utf8');
    await deploy.storeGithubApp(adminToken, settings.appClientId, appKey);
    await deploy.storeLitellmKeys(adminToken);
    await deploy.storeProvider(
      adminToken,
      settings.model.provider === 'anthropic'
        ? {
            provider: 'anthropic',
            apiKey: fs.readFileSync(settings.model.apiKeyFile, 'utf8'),
          }
        : { provider: 'ollama', apiBase: settings.model.ollamaUrl },
    );

    // Step 5: the credentials of every process; then the admin token is revoked and forgotten.
    step('5');
    for (const command of CREDENTIALS_COMMANDS) await deploy.credentials(adminToken, command);
  } finally {
    await deploy.revoke(adminToken);
    bag.drop(adminToken);
  }

  // Step 6: the database, the owner's URL on stdin.
  step('6');
  await deploy.migrate(databaseUrl(envText, 'platform'));
  const opsUrl = bag.keep(databaseUrl(envText, 'platform_app'));

  // Step 7: the platform.
  step('7');
  await deploy.up(PROFILES);

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
  // A release checkout uses the release's published image by digest (V04, V15, design/ADR-M94 §2.4).
  const images = path.join(deployDir, 'scripts/images.sh');
  if (!image && ok(await run(images, ['mode']), 'images mode').stdout.trim() === 'published') {
    image = ok(await run(images, ['get', 'SANDBOX_NODE24']), 'images get').stdout.trim();
  }
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
