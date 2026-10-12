// Checks of the machine and the env file (D-08 V07 AC1). Pure: facts in, results out.
import type { CheckResult, OperatorFacts } from '../types.js';
import { GIB, ok, problem, skipped, text } from './result.js';

/** `docker compose` 2.24 or later (platform/deploy/README.md, Requirements). */
const MIN_COMPOSE: readonly [number, number] = [2, 24];
/** Docker's memory for the platform and one sandbox (TRIAL.md §1, trial preflight). */
export const MIN_DOCKER_MEMORY_GIB = 8;
export const DISK_WARNING_GIB = 20;
export const DISK_FAILED_GIB = 5;

function composeTooOld(version: string): boolean {
  const m = /(\d+)\.(\d+)/.exec(version);
  if (!m) return true;
  const [major, minor] = [Number(m[1]), Number(m[2])];
  return major < MIN_COMPOSE[0] || (major === MIN_COMPOSE[0] && minor < MIN_COMPOSE[1]);
}

const requirements = text('doctor.fix.readme', { section: 'Requirements' });

export function hostChecks(f: OperatorFacts): CheckResult[] {
  const out: CheckResult[] = [];
  if (!f.docker) {
    out.push(problem('host.docker', 'failed', text('doctor.docker.none'), requirements));
  } else if (!f.docker.composeVersion || composeTooOld(f.docker.composeVersion)) {
    out.push(
      problem(
        'host.docker',
        'failed',
        text('doctor.docker.compose_old', { version: f.docker.composeVersion ?? '-' }),
        requirements,
      ),
    );
  } else {
    out.push(
      ok(
        'host.docker',
        text('doctor.docker.ok', {
          docker: f.docker.serverVersion ?? '-',
          compose: f.docker.composeVersion,
        }),
      ),
    );
  }

  const memory = f.docker?.memoryBytes ?? null;
  if (memory === null) {
    out.push(skipped('host.memory', 'doctor.skipped.no_docker'));
  } else if (memory < MIN_DOCKER_MEMORY_GIB * GIB) {
    out.push(
      problem(
        'host.memory',
        'warning',
        text('doctor.memory.low', { gib: (memory / GIB).toFixed(1), min: MIN_DOCKER_MEMORY_GIB }),
        requirements,
      ),
    );
  } else {
    out.push(ok('host.memory', text('doctor.memory.ok', { gib: (memory / GIB).toFixed(1) })));
  }

  for (const d of f.disk) {
    if (d.freeBytes === null) {
      out.push(skipped('host.disk', 'doctor.skipped.disk_unknown', d.path));
      continue;
    }
    const gib = (d.freeBytes / GIB).toFixed(1);
    if (d.freeBytes < DISK_FAILED_GIB * GIB) {
      out.push(
        problem(
          'host.disk',
          'failed',
          text('doctor.disk.low', { gib }),
          text('doctor.fix.disk'),
          d.path,
        ),
      );
    } else if (d.freeBytes < DISK_WARNING_GIB * GIB) {
      out.push(
        problem(
          'host.disk',
          'warning',
          text('doctor.disk.low', { gib }),
          text('doctor.fix.disk'),
          d.path,
        ),
      );
    } else {
      out.push(ok('host.disk', text('doctor.disk.ok', { gib }), d.path));
    }
  }

  const env = f.envFile;
  if (!env.exists) {
    out.push(
      problem(
        'env.file',
        'failed',
        text('doctor.env.missing', { path: env.path }),
        text('doctor.fix.compose_env'),
      ),
    );
    out.push(skipped('env.secrets', 'doctor.skipped.no_env'));
    return out;
  }
  if (env.mode !== null && (env.mode & 0o077) !== 0) {
    out.push(
      problem(
        'env.file',
        'failed',
        text('doctor.env.mode', { path: env.path, mode: (env.mode & 0o777).toString(8) }),
        text('doctor.fix.chmod', { path: env.path }),
      ),
    );
  } else {
    out.push(ok('env.file', text('doctor.env.ok', { path: env.path })));
  }
  const bad = Object.entries(env.facts?.secrets ?? {})
    .filter(([, state]) => state !== 'set')
    .map(([key]) => key)
    .sort();
  out.push(
    bad.length > 0
      ? problem(
          'env.secrets',
          'failed',
          text('doctor.env.secrets_unset', { names: bad.join(', ') }),
          text('doctor.fix.compose_env_secrets'),
        )
      : ok('env.secrets', text('doctor.env.secrets_ok')),
  );
  return out;
}
