# ADR-M36. CLI: API client and credentials

| Item | Value |
|---|---|
| Status | **Proposed** (task B04, for review) |
| Date | 2026-10-03 |
| Decided by | Harry (plan approved 2026-10-03: decisions 1–5; notes on `sdlc logout` and on plain-text storage) |
| Related | D-02 FR-20, NFR-03, NFR-08; D-03 section 5.1; D-08 tasks B04, B13; handbook Ch.18 §18.8b, Ch.19 §19.8b–§19.8c; ADR-M18, ADR-M26, ADR-M28 §2.7, ADR-M32 §2.4; QUESTIONS #77 |

## 1. Context

Until B04, `sdlc` had only operator commands (`sdlc audit verify`, `sdlc admin …`). They run on the server and use the database directly. B04 adds the **user commands**: a person logs in with a personal API token (ADR-M26 §2.3) and works through the API.

Points to settle:

- where the API address and the token are kept on the person's machine;
- how the token is typed in;
- TLS and redirects;
- how CI runs the commands;
- what the output looks like and what the exit codes mean;
- whether a CLI library is needed.

## 2. Decision

### 2.1. The saved login

- `sdlc login` saves `{ version: 1, api_url, token }` in `<config>/sdlc/credentials.json`. `<config>` is `$XDG_CONFIG_HOME` when it is an absolute path, otherwise `~/.config`.
- The folder is mode 700, the file mode 600. The file is written to a temporary file opened with mode 600 (`O_EXCL`), synced, then renamed over the old file: it is never readable by others, not even for a moment.
- On every read the CLI refuses the file (exit 2, with the fix) when it is not a regular file (for example a symbolic link), when it belongs to another user, when group or others can read it, or when its content is not the expected shape. This is the rule ssh uses for private keys.
- **The token is stored in plain text** in that file, like `gh` and `docker` do by default. The file mode is the only protection. An OS keychain (macOS Keychain, Secret Service) may come later; it would replace the file behind the same `readSavedLogin` / `writeSavedLogin` functions.
- `sdlc logout` deletes the file only. **It does not revoke the token on the server**: the message says so. Revocation stays with the operator command `sdlc admin token revoke` until B13 (§4).

### 2.2. Typing the token

- The token is never a command-line argument (it would stay in the shell history and in process listings). There is no `--token` flag.
- On a terminal, `sdlc login` asks with a hidden prompt (raw mode, no echo). In a pipe, `--token-stdin` reads standard input. Without a terminal and without `--token-stdin`, the command stops (exit 2).
- The shape (`sdlc_pat_` + 43 base64url characters) is checked before anything is sent. A wrong value is never echoed back: it may be another secret pasted in the wrong place.
- The token is checked with `GET /v1/me` **before** it is saved. A refused token is not saved.
- The token never appears in any output, error message or `--json` body. The HTTP client never puts request headers into its errors. Tests sweep the output of every command for the token.

### 2.3. Address, TLS, redirects, CI

- The API address must be `https://`. `http://` is accepted only for this machine (`127.0.0.1`, `localhost`, `[::1]`), where the Compose API listens on `127.0.0.1:8090`. An address with a user name, a password, a query or a fragment is refused.
- TLS is verified by Node's `fetch`. There is no flag to skip it. A company CA is added with Node's standard `NODE_EXTRA_CA_CERTS`. The CLI refuses to run when `NODE_TLS_REJECT_UNAUTHORIZED=0` is set.
- Redirects are refused (`redirect: 'manual'`, any 3xx is an error): the token is never sent to another address.
- Each request has a 30-second time-out. A response body larger than 4 MiB is refused.
- **CI:** `SDLC_API_URL` and `SDLC_API_TOKEN` are read once at start-up and replace the saved login; both or neither must be set. They are meant **for CI only**: environment variables can leak through process listings, crash reports and CI logs. People use `sdlc login`. `sdlc login` warns when `SDLC_API_TOKEN` is set in the same shell.

### 2.4. Output

- Human output comes from the message catalog only (`cli.*` keys, ADR-M18, NFR-08).
- API errors are shown from the same catalog: `api.error.<code>` and `gate.reason.<reason>` (`@sdlc/core` `refusalReasonMessage`). The server's text is used only for a code this CLI does not know yet (a newer API).
- Text from the server (intent titles, slugs) is cleaned before it is printed: C0 and C1 control characters, DEL and Unicode bidirectional controls become a space. A crafted title cannot send escape sequences to the terminal.
- `--json` prints the validated response body. C1 and bidirectional controls are escaped there too (`JSON.stringify` escapes C0 already). A failure in `--json` mode prints the API error envelope as JSON on standard error, with the same exit code.
- Every response is validated with zod (`apps/cli/src/api/schemas.ts`). A body that does not match is refused (exit 3). A test checks these schemas against the API's own presenters, so they cannot drift apart.

### 2.5. Exit codes

| Code | Meaning |
|---|---|
| 0 | Success |
| 1 | Refused by the platform: HTTP 403, 404, 409, 422, 429 (and a failed check, for `sdlc audit verify`) |
| 2 | Usage or setup: bad arguments, not logged in, unsafe saved login, bad address, HTTP 400 |
| 3 | Unexpected: HTTP 5xx, network failure, time-out, redirect, malformed answer |
| 4 | Authentication: HTTP 401 (missing, expired or revoked token). The message says to log in again |

### 2.6. No CLI library

- Arguments are parsed with `node:util` `parseArgs` (strict), like the operator commands. HTTP is Node's `fetch`. The hidden prompt uses raw mode on standard input.
- The only new package dependency is `zod` 4.6.5, already pinned in the workspace (`@sdlc/api`, `@sdlc/config`; MIT). No new third-party package, so no licence review.

### 2.7. Commands

| Command | API |
|---|---|
| `sdlc login [--api-url <url>] [--token-stdin]`, `sdlc logout`, `sdlc whoami` | `GET /v1/me` |
| `sdlc intent create\|list\|show` | `POST`, `GET /v1/intents`, `GET /v1/intents/:code` |
| `sdlc gate approve\|reject\|request-changes <G> <INT>` `[--reason-code] [--reason-ref]` | `POST /v1/intents/:code/gates/:gate/decisions` |
| `sdlc escalation list\|show\|ack\|decide` | ADR-M28 §2.7. The decision words are those of `/decide` (`roll-back`, `escalate`) |
| `sdlc ai-record show\|set --project <slug>` | `GET`, `PUT /v1/projects/:project/ai-record`; the same flags as `sdlc admin ai-record set` (shared module) |

- Decisions take codes and one `https://` link only, like the API (ADR-M20). There is no `--reason` text flag and no `--scope` flag: G1–G4 approvals take no scope (`scope_not_allowed`). E01 and E03 add scope flags for G7 and G8.
- The operator commands keep their direct database access and stay separate (`sdlc admin …`, `sdlc audit verify`).

## 3. Alternatives considered

- **A CLI library (commander, yargs, oclif).** Rejected: `parseArgs` covers the needs, and each library adds a dependency to review.
- **OS keychain now.** Deferred: it needs a native module or per-OS tools (`security`, `secret-tool`), and a fallback anyway on servers without a keychain.
- **Allow `http://` for any host on a "trusted" internal network.** Rejected: a token in plain HTTP can be read on the network. Internal hosts get a certificate from the internal CA (QUESTIONS #20).
- **Follow redirects to the same host only.** Rejected: simpler and safer to refuse all; the API never redirects.

## 4. Consequences

- People can do every gate, escalation and AI record action of M-B without database access.
- A stolen laptop with a saved login exposes the token until it expires (90 days by default). Mitigation: revoke it with `sdlc admin token revoke` (operator).
- **Follow-up for B13:** add token revocation through the API (`DELETE /v1/me/tokens/current` or similar) and let `sdlc logout` call it before it deletes the file; then update §2.1 and the `cli.logout.done` message.
- Follow-up when a keychain is wanted: store the token there and keep only the address in the file.

## Version history

| Version | Date | Author | Notes |
|---|---|---|---|
| 0.1 | 2026-10-03 | Claude (task B04) | First version |
