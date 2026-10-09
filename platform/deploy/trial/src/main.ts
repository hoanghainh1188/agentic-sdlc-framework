#!/usr/bin/env node
// `pnpm trial:up --settings <file>` and `pnpm trial:down [--wipe] [--settings <file>] [--yes]`
// (D-08 V02, QUESTIONS #342): the community trial's whole set-up on a developer machine, with
// throw-away keys. Never for a server: an operator follows platform/deploy/README.md (A10).
//
// Test-only overrides (the live test `trial-up.test.ts`, never documented for testers):
// SDLC_TRIAL_ENV_FILE, SDLC_TRIAL_PROJECT, SDLC_TRIAL_SUBNET, SDLC_TRIAL_GATEWAY,
// SDLC_TRIAL_PORT_OFFSET. SDLC_SANDBOX_IMAGE reuses a sandbox image already built.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';

import { t, type MessageKey, type MessageParams } from '@sdlc/messages';

import { downRefusal, trialDown } from './down.js';
import { TRIAL_PROJECT, trialApiUrl } from './env-file.js';
import { exec, gatherFacts, isDockerDesktop, sdlc } from './host.js';
import { projectOverride, trialEnvFile } from './override.js';
import { preflight } from './preflight.js';
import { SecretBag } from './secrets.js';
import { credentialsFile, parseSettings, SettingsError, type TrialSettings } from './settings.js';
import { TrialStepError, trialUp } from './up.js';

const EXIT = { ok: 0, failed: 1, usage: 2 } as const;
const repoRoot = path.resolve(import.meta.dirname, '../../../..');

const say = (key: MessageKey, params?: MessageParams) =>
  process.stdout.write(`${t(key, params)}\n`);
const sayError = (key: MessageKey, params?: MessageParams) =>
  process.stderr.write(`${t(key, params)}\n`);

const DEFAULT_ENV_FILE = path.join(repoRoot, 'platform/deploy/.env');

const override = () => projectOverride(process.env, DEFAULT_ENV_FILE);
const envFile = () => trialEnvFile(process.env, DEFAULT_ENV_FILE);

function readSettings(file: string): TrialSettings | undefined {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    sayError('trial.settings.unreadable', { path: file });
    return undefined;
  }
  try {
    return parseSettings(text, os.homedir());
  } catch (error) {
    if (!(error instanceof SettingsError)) throw error;
    sayError('trial.settings.invalid', { field: error.field, path: file });
    return undefined;
  }
}

async function up(args: string[]): Promise<number> {
  const { values } = parseArgs({ args, options: { settings: { type: 'string' } } });
  if (!values.settings) {
    sayError('trial.usage');
    return EXIT.usage;
  }
  const settings = readSettings(path.resolve(values.settings));
  if (!settings) return EXIT.usage;
  const target = override();
  const project = target?.project ?? TRIAL_PROJECT;
  const refusals = preflight(
    settings,
    await gatherFacts(settings, envFile(), project, target === undefined),
  );
  if (refusals.length > 0) {
    for (const r of refusals) sayError(r.key, r.params);
    return EXIT.failed;
  }
  say('trial.throwaway_warning');
  try {
    const result = await trialUp(settings, {
      repoRoot,
      envFile: envFile(),
      override: target,
      exec,
      sdlc,
      progress: (key, params) => say(key, params),
      sandboxImage: process.env.SDLC_SANDBOX_IMAGE,
      dockerDesktop: await isDockerDesktop(),
    });
    say('trial.done', {
      api_url: result.apiUrl,
      project: result.project,
      model: result.model,
      compose_project: result.composeProject,
      person_a: credentialsFile(settings.personA),
      person_b: credentialsFile(settings.personB),
      config_b: settings.personB.configHome,
    });
    return EXIT.ok;
  } catch (error) {
    if (error instanceof TrialStepError) {
      sayError('trial.step_failed', { step: error.step });
      process.stderr.write(`${error.detail}\n`);
    } else {
      // Never the message: it may quote output that held a secret (a JSON parse error does).
      sayError('trial.unexpected', { kind: error instanceof Error ? error.name : 'unknown' });
    }
    sayError('trial.failed_hint');
    return EXIT.failed;
  }
}

async function confirm(project: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(t('trial.down.confirm', { project }));
    return answer.trim() === project;
  } finally {
    rl.close();
  }
}

async function down(args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    options: {
      wipe: { type: 'boolean', default: false },
      yes: { type: 'boolean', default: false },
      settings: { type: 'string' },
    },
  });
  const project = override()?.project ?? TRIAL_PROJECT;
  const file = envFile();
  const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : undefined;
  const refusal = downRefusal(text, project);
  if (refusal) {
    const key = refusal === 'no_env' ? 'trial.down.refused.no_env' : 'trial.down.refused.not_trial';
    sayError(key, { path: file, project });
    return refusal === 'no_env' ? EXIT.ok : EXIT.failed;
  }
  const settings = values.settings ? readSettings(path.resolve(values.settings)) : undefined;
  if (values.settings && !settings) return EXIT.usage;
  if (values.wipe && !values.yes && !(await confirm(project))) {
    sayError('trial.down.not_confirmed');
    return EXIT.failed;
  }
  const r = await trialDown({
    repoRoot,
    envFile: file,
    project,
    wipe: values.wipe === true,
    credentialsFiles: settings ? [settings.personA, settings.personB].map(credentialsFile) : [],
    apiUrl: trialApiUrl(text ?? ''),
    exec,
  });
  for (const kept of r.keptLogins) sayError('trial.down.kept_login', { path: kept });
  if (r.status !== 0) {
    sayError('trial.down.failed');
    const tail = r.stderr.trim().split('\n').slice(-20).join('\n');
    process.stderr.write(`${new SecretBag().redact(tail)}\n`);
    return EXIT.failed;
  }
  say(values.wipe ? 'trial.down.wiped' : 'trial.down.stopped', { project });
  return EXIT.ok;
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  try {
    if (command === 'up') return await up(rest);
    if (command === 'down') return await down(rest);
  } catch (error) {
    if (
      error instanceof TypeError &&
      'code' in error &&
      String(error.code).startsWith('ERR_PARSE_ARGS')
    ) {
      sayError('trial.usage');
      return EXIT.usage;
    }
    throw error;
  }
  sayError('trial.usage');
  return EXIT.usage;
}

process.exitCode = await main(process.argv.slice(2));
