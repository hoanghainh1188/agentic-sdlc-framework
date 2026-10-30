# ADR-M101. Operational alerts: `pnpm alerts` on top of `doctor`

| Item | Value |
|---|---|
| Status | **Accepted** (task O03) |
| Date | 2026-10-30 |
| Decided by | Harry (O03 plan approved with the recommended answers, 2026-10-30; QUESTIONS #636–#639) |
| Related | D-08 task O03; NFR-06; QUESTIONS #363; ADR-M63 §5 (backups, the schedule is the server's); `pnpm doctor` (V07); runbook T11 §6b; `platform/deploy/README.md` "Alerts"; rules R034, R079, R080 |

## 1. Context

A team on a server needs to know when the platform stops working, without watching it. O03 asks for alerts when a service stops being healthy, OpenBao is sealed, the disk or the backup target fills up, a backup did not run, or a TLS certificate nears its end. They go to the operator by e-mail or a chat webhook, never with a secret, and are built on `doctor` (V07), also with the profile `observability` off.

`pnpm doctor` already checks four of the five: `services.health`, `openbao.state`, `host.disk` (also for `SDLC_BACKUP_DIR`), `openbao.tls_expiry` and `access.tls_expiry`. Nothing checked that a backup ran.

## 2. Decision

1. **A new doctor check, `backup.recent`.** It lists `SDLC_BACKUP_DIR` and finds the newest complete backup: a `<UTC time>` folder of `backup.sh` that holds `MANIFEST` (a `.partial` folder or one without `MANIFEST` does not count). It only lists names and tests whether `MANIFEST` exists; it opens no backup file. Warning after `SDLC_BACKUP_WARN_HOURS` (default 26), failed after `SDLC_BACKUP_FAIL_HOURS` (default 50): one missed night is a warning, two a failure (QUESTIONS #639). A value that is not a whole number, or a warning not smaller than the failure, is a warning of its own, never ignored. Skipped without `SDLC_BACKUP_DIR` (a trial or a dev stack). `doctor` stays read only (R080).
2. **A new command, `pnpm alerts [--env <file>] [--dry-run | --test]`** (`platform/deploy/alerts`). It calls doctor's `gatherFacts` and `evaluate` in its own process, so it runs exactly doctor's allowlisted, read-only commands and adds none. Every `warning` and `failed` line is an alert, not only the five of AC1: doctor's other lines (an expired AppRole secret ID, a full Valkey, a missing credential) are problems an operator must fix too.
3. **When it sends** (QUESTIONS #638), per check and subject: a problem when it is new or its status changes; the same problem again after `SDLC_ALERT_REMIND_HOURS` (default 24) while it stays; a "resolved" line when the check gives lines again that are not skipped and that subject is not among its problems. This covers checks that give one line per unhealthy service but one ok line without a subject (`services.health`, `access.ports`). A check whose lines are all skipped (a stopped stack, a sealed OpenBao) keeps every subject it had, because it proves nothing; when the stack is back and the service is still unhealthy, that is not a new problem. A check that is gone from the results is forgotten without a message.
   **The state is kept per channel** (`alerts-state.json` next to the env file, or `SDLC_ALERT_STATE_FILE`): channel names, check IDs, subjects, statuses and times only; mode 600; written to a new file of a random name (`wx`: never an existing file or a link), then moved over the old one. A channel's state changes only when that channel took the message, so a channel that is down is tried again on the next run, and the others do not send again. Before anything is sent, a state folder that cannot be written is refused (exit 2): otherwise the same alert would go out on every run. A state file that cannot be read starts over (every open problem is sent again) and says so.
4. **The message** holds the host name (`SDLC_ALERT_HOST_NAME`, default the machine's name), the check ID, its subject (a service, a certificate, a folder), doctor's text and its fix, all from the message catalog (NFR-08). Never an env value, a secret, a log line or a command's output: doctor's results already hold none (V07 AC3), and the alert adds nothing else.
5. **Channels** (QUESTIONS #636), at least one:
   - **Webhook.** The URL holds a token, so the env file names a file (`SDLC_ALERT_WEBHOOK_FILE`, mode 600) that holds the URL alone, never the URL (R034). The file is opened once, never through a link, and must be a regular file of the account that runs `pnpm alerts`. Only `https://` without a user name; no redirect followed; 10 s timeout; the answer's body is never read; a failure is a code (`webhook_status`, `webhook_unreachable`, …), never a message that could hold the URL. Formats: `text`, `{"text": …}`, which Slack, Google Chat, Mattermost and Rocket.Chat take; and `json`, our own shape (`version`, `host`, `sent_at`, `items`) for any other receiver. Microsoft Teams' new workflow webhooks need an Adaptive Card and are not supported yet; a `json` receiver can relay to them.
   - **E-mail through the server's `sendmail`** (`sendmail -t -oi`, `SDLC_ALERT_SENDMAIL`, default `/usr/sbin/sendmail`). The platform holds no SMTP password and needs no mail library; the server's mail system relays it. Addresses are checked (no space, line break or header character), so no header can be added; the headers are fixed.
6. **The schedule is the server's** (like backups, ADR-M63 §5, R079): a systemd timer example (`sdlc-alerts.service`, `.timer`, every 10 minutes and 5 minutes after boot) or a cron line. The platform never schedules its own alerts: it could not alert while it is down, which is when an alert matters most. `pnpm alerts` needs no running service, no OpenBao token and no profile.
7. **No worker change** (QUESTIONS #637). D-08 lists `platform/apps/worker` in O03's code area, but the worker runs inside the stack: it cannot see Docker, a sealed OpenBao stops it, and it cannot alert while the stack is down. Alerts from inside the platform (for example a run waiting too long) are a later task if the trial asks for them.
8. Exit codes: 0 done (sent, or nothing to send), 1 a channel failed or the state could not be written, 2 a usage error or a bad setting (the line names the key). `--test` sends a test message without running the checks; `--dry-run` prints what would be sent; neither changes the state.

## 3. Consequences

- Eight `SDLC_ALERT_*` keys and two `SDLC_BACKUP_*_HOURS` keys in `.env.example`; `pnpm compose:env --add-missing` appends them on an upgrade. Without a channel, `pnpm alerts` refuses with exit 2; nothing else changes.
- Each run costs one `pnpm doctor`: a few `docker` and `docker compose exec` calls, one `psql` query and one GitHub check by the worker. Every 10 minutes is light on the target host; not yet measured on the company server (A10 PR 3).
- The operator keeps the webhook URL file and the mail relay. A leaked URL is replaced in the chat tool and in the file; nothing else holds it (runbook T11 §6b).
- Tests: `platform/tests/alerts/*.test.ts` (the decision, also for one line per service; the message; the channels with a fake `sendmail` and a recorded POST; the settings; a whole run with one channel down; no env value in any output) and `platform/tests/doctor/backup-facts.test.ts`, `checks.test.ts` (`backup.recent`); all in `pnpm test`.

## 4. Rejected

- **Alerts from the worker or a new service.** Down with the stack, sealed with OpenBao; see §2.7.
- **Prometheus Alertmanager or Grafana alerts.** They need the profile `observability`, which AC2 says must be optional, and they would not see a sealed OpenBao or a missing backup.
- **SMTP from the platform** (a mail library and a password in OpenBao). One more secret and one more dependency; every server already has a way to send mail.
- **The webhook URL in the env file.** It is a credential: R034 keeps credentials in files, never in environment values.

## Version history

| Version | Date | Author | Notes |
|---|---|---|---|
| 1.0 | 2026-10-30 | Claude Code (task O03), approved by Harry | `backup.recent`, `pnpm alerts`, when it sends, webhook and `sendmail`, the schedule of the server, no worker change (QUESTIONS #636–#639) |
