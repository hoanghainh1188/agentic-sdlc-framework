# CLAUDE.md — Deployment: secrets, TLS, storage, tools

Rules for `platform/deploy` (Compose, OpenBao, TLS, backups, `doctor`, `trial`, the access proxy, the GitHub App) and its tests. The root `CLAUDE.md` still applies. Never break a rule here; the detail is in the linked ADR. Each rule ends with its IDs in `design/RULES.md` (ADR-M84).

## Secrets and TLS
- OpenBao speaks TLS on 8200 everywhere; certificate verification can never be turned off. Never bind-mount host TLS files, never add a plain listener or `SDLC_OPENBAO_ALLOW_PLAINTEXT` to the compose file (ADR-M63). OpenBao "healthy" = API reachable, not unsealed. [R076]

## Storage
- SeaweedFS: only the S3 API is reachable; never publish or open another SeaweedFS port, never turn Iceberg or Lance on, never store its JWT keys anywhere else; admin work only with `docker compose exec seaweedfs weed shell -master=127.0.0.1:9333` (never the service name as the master address). Never run `weed shell s3.config.show`; never pass S3 keys as process arguments (ADR-M52, ADR-M33 §2.9). [R074]

## Tools
- `pnpm compose:env` never overwrites; add `-v` to `compose down` only to wipe data on a dev machine. [R078]
- Backups: every part is encrypted with age as it streams; never write an unencrypted backup part to disk; the schedule is the server's, never the platform's (ADR-M63 §5). [R079]
- `doctor` is read only: every command through the allowlist of `commands.ts`; never add a command that writes; the option is `--env`, never `--env-file`; it prints no secret. Every README "Troubleshooting" row needs an entry in `troubleshooting.ts`. [R080]
- `trial:up` / `trial:start` are for developer machines only, never a server; every `docker compose` call passes `-p` and children never inherit the shell's `COMPOSE_PROJECT_NAME`; the passphrase never comes from an argument or an environment variable (ADR-M76). A change of a README "Fresh deployment" step changes `trial/src/up.ts` and `test:fresh-deploy` too. [R081]
- Team access: the proxy is never on the `sdlc` network and never sends a CSP; keep the body limit equal to the api's; every throw-away Compose project gets its own `access` subnet (ADR-M67). A host name is required, never only an IP (passkeys); the proxy logs no header and no query string. [R082]
- `pnpm github-app:create`: `manifest.json` is the one source of the App's permissions (keep it equal to the README table); the client and webhook secrets are dropped, never stored or printed. [R083]

## Commands
Run from the repo root.
- Compose (ADR-M17, `platform/deploy/README.md` "Profiles", "Start and stop"): `pnpm compose:env` (once; never overwrites), `compose:core`, `compose:obs`, `compose:models`, `compose:platform`, `compose:sandbox`, `compose:access`, `compose:down` (volumes kept). Dev stack from scratch: `platform/GETTING-STARTED.md` Step 11b; restart after a break and pilot preparation: Steps 13–14 (point the owner there).
- OpenBao (ADR-M19, ADR-M21, runbook T11): `pnpm openbao:bootstrap init|unseal|configure|root-token|status|<name>-credentials` (each credentials command: runbook T11 §5b–§5n), `pnpm openbao:tls dev|ca|server|check|reload` (ADR-M63, T11 §3c).
- Backups (ADR-M63 §5, T11 §6–§7): `pnpm backup`, `pnpm restore <folder> <age key>` (into an empty stack only).
- Deployment helpers: `pnpm doctor [--env <file>] [--json]` (deploy README "Doctor"), `pnpm access:tls …` (ADR-M67, T11 §3d), `pnpm github-app:create --out <file outside the repo>` (deploy README "Create the GitHub App"; owner's terminal only).
- Trial on a developer machine (`TRIAL.md`, ADR-M76, T11 §3.1b): `pnpm trial:up --settings <file outside the repo>`, `pnpm trial:start`, `pnpm trial:down [--wipe]`.
