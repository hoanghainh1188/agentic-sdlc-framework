# ADR-M102. Key rotation: the Run Contract signing key and the processes' secret IDs

| Item | Value |
|---|---|
| Status | **Accepted** (task O05) |
| Date | 2026-10-30 |
| Decided by | Harry (O05 plan approved with the recommended answers, 2026-10-30; QUESTIONS #641–#643) |
| Related | D-08 task O05; NFR-03; QUESTIONS #440; ADR-M22 §2.4 (verifying with the signature's key version); ADR-M19 (OpenBao bootstrap); ADR-M21 (the OpenBao client); ADR-M101 (alerts); runbook T11 §8.1, §8.4; rules R035, R132 |

## 1. Context

D-03 §8 left the rotation and revocation of keys for later, and QUESTIONS #440 made it task O05. Two kinds of keys matter:

- **The Transit key `run-contract`** (Ed25519). The worker signs every Run Contract with it, and the runner checks the signature through Transit. The key never leaves OpenBao. ADR-M22 §2.4 already makes rotation safe: every signature names its key version, so a contract signed before a rotation keeps verifying until it expires (minutes). But nothing rotated the key, and nothing said how to revoke a version.
- **The AppRole secret IDs** of the processes (api, worker, cost-controller, runner, the LiteLLM sidecar, the backup job). They end after 90 days (`APPROLE_SECRET_ID_TTL=2160h`). Each has its own credentials command, run with an admin token. `pnpm doctor` warned only 10 days before the end.

A check on OpenBao 2.7.1 (the pinned image, a throw-away container) confirmed two things. First, `auto_rotate_period` rotates a Transit key by itself. Second, `min_decryption_version` both removes the older public keys from the key's read and makes Transit refuse an older signature ("too old").

## 2. Decision

1. **The signing key rotates by itself every 90 days** (QUESTIONS #641). `configure` sets `auto_rotate_period` on `transit/keys/run-contract` from `TRANSIT_AUTO_ROTATE_PERIOD` in `bootstrap.conf` (default `2160h`: whole hours, at least 1h). It does this on a new key and on an existing one, then reads the value back and fails if it differs. OpenBao rotates the key; the platform schedules nothing. New contracts use the newest version. Older contracts verify until they expire. No policy of a process may change the key (unchanged); only a root token can.
2. **Secret IDs are not renewed automatically** (QUESTIONS #642). Renewing them without a person would need a credential on the server that can make a secret ID for every process. That is the power the two key holders and the short-lived admin token protect (ADR-M19). Instead:
   - `pnpm doctor` warns **14 days** before a secret ID ends (`SDLC_APPROLE_WARN_DAYS`, 1–89; a value outside that range is a warning of its own and the default is used). It fails at 90 days. `pnpm alerts` (ADR-M101) sends the warning to the operator.
   - **`pnpm openbao:bootstrap rotate-credentials`** asks for the admin token **once** and runs `api-credentials`, `worker-credentials` (worker and cost-controller), `runner-credentials`, `litellm-credentials` and `backup-credentials`. These are the five that `doctor` watches. An AppRole with no secret ID yet (OpenBao answers `{}`) is skipped, because its profile or feature is not set up here. Any other answer (a token without the right, a missing role) stops the pass and names what was renewed so far, and a pass that renews nothing fails: "renewed" is never claimed for nothing. The token is checked first. A failing command stops the pass with its own message. The S3, ClickHouse and database credentials do not expire and are not touched. Like every credentials command, it runs only in the owner's terminal; the Claude Code hook refuses it (R035, `action.endsWith('-credentials')`).
3. **Revoking a key version is a person's step with a root token** (QUESTIONS #643). Rotate, then set `min_decryption_version` to the new version. Transit then refuses every older signature, and the runner refuses those contracts (`bad_signature`, ADR-M22 §2.4). The same key signs evaluation and task-check contracts (L04, L07), so they are refused too. A run or an evaluation whose contract was issued before does not start, and it is started again. No code path or policy raises `min_decryption_version`: `configure` never sets it, and a static test checks this. Runbook T11 §8.4 gives the steps and a read-only query of `run_contracts`, `evaluation_run_contracts` and `evaluation_task_check_contracts` that shows which key versions unexpired contracts still use.
4. The worker and `@sdlc/secrets` do not change. The verifier already takes the key version from the signature, and the runner verifies through Transit, so a revocation applies at once without a restart.

## 3. Consequences

- A deployment set up before O05 runs `configure` once more (a root token, two key holders) to set the rotation period. The v0.11.0 upgrade notes say so.
- An AppRole secret ID still needs a person every 90 days, with one command and one admin token instead of five. The warning comes two weeks before, by `doctor` and by alerts.
- Tests:
  - `platform/tests/deploy/openbao-static.test.ts`: the period setting; `configure` sets and checks it, and never sets `min_decryption_version`; `rotate-credentials` asks for the token once and runs exactly the five commands, after a token check.
  - `platform/tests/deploy/rotate-credentials.test.ts`: the command run for real against a stub `docker` (the token read once and only on stdin, a skip, a stop on a list it cannot read, nothing renewed, a bad token).
  - `platform/tests/doctor/checks.test.ts`: the warning days.
  - `platform/tests/workspace/claude-hook.test.ts`: the hook refuses `rotate-credentials`.
  - `platform/tests/integration/openbao/run-contract-signing.test.ts` (`pnpm test:openbao`): the period after `configure`, also on an existing key; a contract signed before a rotation and verified after; a revoked version refused while the new one verifies.

## 4. Rejected

- **Automatic secret ID renewal** by a server timer with a stored token: see §2.2.
- **Rotating the signing key from the worker or a timer of the platform.** OpenBao's own `auto_rotate_period` needs no credential outside OpenBao and works while the platform is down.
- **A minimum key version enforced by the platform** in `verifyRunContract`. Transit's `min_decryption_version` already does it in the one place that verifies, and keeps one source of truth.

## Version history

| Version | Date | Author | Notes |
|---|---|---|---|
| 1.0 | 2026-10-30 | Claude Code (task O05), approved by Harry | Auto-rotation of the signing key, the 14-day warning and `rotate-credentials`, revocation with `min_decryption_version` (QUESTIONS #641–#643) |
