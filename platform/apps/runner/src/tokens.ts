// Short-lived GitHub tokens end right after their use (task C11, ADR-M42 §2.4; ADR-M38 §2.3 open
// item). GitHub revokes an installation token only with the token itself, and only the runner holds
// the run's tokens, so the runner revokes them: the clone token when the clone ended, the push
// token when the push ended, whatever the outcome. A kill then finds no GitHub token to revoke
// except during a clone, which revokes its own when it ends. A failed revocation is recorded and
// never blocks the run: the token expires by itself within the hour.
//
// A single-use wrapping token that cannot be opened while its run's contract is still valid was
// probably opened by someone else (ADR-M25 §2.11): `wrap_token_reused` sends the run's escalation
// to the security route (core `finishRun`, `stopPublish`).
import { GitHostError, type GitHostAdapter, type RedactedSecret } from '@sdlc/contracts';
import type { TenantScope } from '@sdlc/core';
import { SecretsError } from '@sdlc/secrets';

/** What the runner needs from the Git host adapter: no App key (`GitHubAdapter` token-only). */
export type GitTokenRevoker = Pick<GitHostAdapter, 'revokeShortLivedToken'>;

export type RunToken = 'clone' | 'push';

/** Revokes `token` and records the outcome as a run event. Never throws. */
export async function revokeAfterUse(
  revoker: GitTokenRevoker | undefined,
  scope: TenantScope,
  runId: string,
  token: RedactedSecret,
  which: RunToken,
): Promise<void> {
  if (!revoker) return;
  try {
    await revoker.revokeShortLivedToken(token);
    await scope.runEvents.append(runId, 'token_revoked', { token: which });
  } catch (error) {
    const reason = error instanceof GitHostError ? error.code : 'unexpected';
    await scope.runEvents
      .append(runId, 'token_revoke_failed', { token: which, reason })
      .catch(() => undefined);
  }
}

/**
 * True when OpenBao refused the wrapping token itself (unknown, expired, used, or not made by
 * `sys/wrapping/wrap`); an unreachable or sealed OpenBao is not a security signal (code review).
 */
export function isRefusedWrapToken(error: unknown): boolean {
  return (
    error instanceof SecretsError &&
    (error.key === 'secrets.wrapping.invalid_token' ||
      error.key === 'secrets.wrapping.wrong_origin')
  );
}

/** Records that a wrapping token of the run could not be opened (a security signal). */
export async function recordWrapTokenReused(
  scope: TenantScope,
  runId: string,
  which: RunToken | 'virtual_key',
): Promise<void> {
  await scope.runEvents.append(runId, 'wrap_token_reused', { token: which }).catch(() => undefined);
}
