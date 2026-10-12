// The GitHub App check (D-08 V07 AC1, QUESTIONS #400): the worker's answer against the manifest.
import { comparePermissions } from '../github-permissions.js';
import type { CheckResult, OperatorFacts } from '../types.js';
import { ok, problem, skipped, text } from './result.js';

const appSettings = text('doctor.fix.readme', { section: 'Create the GitHub App (operator)' });

export function githubChecks(f: OperatorFacts): CheckResult[] {
  const g = f.github;
  if (!f.docker) return [skipped('github.app', 'doctor.skipped.no_docker')];
  if (!f.envFile.exists) return [skipped('github.app', 'doctor.skipped.no_env')];
  if (g === undefined) {
    const running =
      f.services?.some((s) => s.service === 'sdlc-worker' && s.state === 'running') === true;
    if (!running) return [skipped('github.app', 'doctor.skipped.worker_stopped')];
    return [skipped('github.app', 'doctor.skipped.openbao_sealed')];
  }
  if (!g.ok) {
    if (g.error === 'not_built') {
      return [
        problem(
          'github.app',
          'warning',
          text('doctor.github.not_built'),
          text('doctor.fix.rebuild_worker'),
        ),
      ];
    }
    if (g.error === 'openbao_sealed')
      return [skipped('github.app', 'doctor.skipped.openbao_sealed')];
    return [
      problem(
        'github.app',
        'warning',
        text('doctor.github.failed', { code: g.error }),
        appSettings,
      ),
    ];
  }
  const out: CheckResult[] = [];
  const app = comparePermissions(f.manifest, g.app.permissions);
  if (app.missing.length > 0) {
    out.push(
      problem(
        'github.app',
        'failed',
        text('doctor.github.app_missing', { permissions: app.missing.join(', ') }),
        appSettings,
        'app',
      ),
    );
  } else if (app.extra.length > 0) {
    out.push(
      problem(
        'github.app',
        'warning',
        text('doctor.github.app_extra', { permissions: app.extra.join(', ') }),
        appSettings,
        'app',
      ),
    );
  } else {
    out.push(ok('github.app', text('doctor.github.app_ok'), 'app'));
  }
  if (g.repos.length === 0)
    out.push(skipped('github.app', 'doctor.skipped.no_projects', 'repositories'));
  for (const r of g.repos) {
    if (!r.installed) {
      out.push(
        problem(
          'github.app',
          'failed',
          text('doctor.github.not_installed'),
          text('doctor.fix.install_app'),
          r.repo,
        ),
      );
      continue;
    }
    const diff = comparePermissions(f.manifest, r.permissions);
    if (diff.missing.length > 0) {
      out.push(
        problem(
          'github.app',
          'failed',
          text('doctor.github.repo_missing', { permissions: diff.missing.join(', ') }),
          text('doctor.fix.accept_permissions'),
          r.repo,
        ),
      );
    } else if (r.selection === 'all') {
      out.push(
        problem(
          'github.app',
          'warning',
          text('doctor.github.all_repos'),
          text('doctor.fix.install_app'),
          r.repo,
        ),
      );
    } else if (diff.extra.length > 0) {
      out.push(
        problem(
          'github.app',
          'warning',
          text('doctor.github.repo_extra', { permissions: diff.extra.join(', ') }),
          appSettings,
          r.repo,
        ),
      );
    } else {
      out.push(ok('github.app', text('doctor.github.repo_ok'), r.repo));
    }
  }
  return out;
}
