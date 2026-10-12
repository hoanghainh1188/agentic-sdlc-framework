# ADR-M67. Team access from other machines: a TLS reverse proxy

| Item | Value |
|---|---|
| Status | **Accepted** (Harry, 2026-10-12; PR #301 merged). Built by task V09 PR 2; version 1.0 records the names as built (§2.2b) |
| Date | 2026-10-12 |
| Decided by | Harry (V09 plan approved 2026-10-12 with the answers to QUESTIONS #405–#409, plus two changes: the proxy allows `/health/ready`, and the upgrade step for the fixed proxy address is written down) |
| Related | D-08 task V09 (AC1–AC4); D-03 §9, §10, §10.1, §12 (version 1.41); ADR-M26 §2.7 (the api's per-address limits and `trustProxy`); ADR-M36 (the CLI's TLS rules); ADR-M54 (the dashboard, 127.0.0.1 only); ADR-M63 (OpenBao TLS, the internal CA); ADR-M73 (the dashboard's actions, `SDLC_API_PUBLIC_ORIGIN`, `__Host-` cookies); ADR-M66 (published images); D-08 V07 (`doctor`), U05–U07, O01, O03; QUESTIONS #405–#409 |

## 1. Context

The API and the dashboard listen on `127.0.0.1:8090` of the server only (ADR-M26, ADR-M54). People on other machines cannot use the CLI or the dashboard; `platform/deploy/README.md` says "Access from other machines: not supported yet", and D-03 §9 (dashboard row) says exposing it to other machines is out of scope.

A team on a server needs both from their own machines (QUESTIONS #355). The dashboard's actions (ADR-M73) also need a real HTTPS origin: `__Host-` cookies need `Secure`, WebKit keeps no `Secure` cookie on `http://localhost`, and passkeys refuse an IP address as their site name.

D-08 V09 asks for a Compose profile `access` with a pinned reverse proxy that publishes the API and the dashboard on one LAN port over TLS, security headers, request limits, a rate limit per client, and doctor checks.

## 2. Decision

### 2.1. The proxy: nginx (QUESTIONS #405)

- **nginx**, image `nginxinc/nginx-unprivileged:<stable>-alpine` (BSD-2-Clause), pinned by tag and digest like the other third-party images (the sandbox profile). Task V09 PR 2 picks a stable version at least two weeks old and records its Trivy result at the thresholds of `ci.yml` (CRITICAL blocks).
- Why: per-client rate limits are built in (`limit_req`, `limit_conn`); the configuration is plain and easy to check in a static test; the image runs as uid 101 on an unprivileged port, so the container runs `read_only`, `cap_drop: [ALL]`, `no-new-privileges`, with tmpfs for its cache, run and `conf.d` folders.
- The image is **not** in `platform/deploy/images.lock` and not in the release workflow: the lock holds the images the project builds (ADR-M66). A static test checks the pin in the compose file.
- The configuration is a template in the repository (`platform/deploy/access/nginx.conf.template`), filled at start from `SDLC_ACCESS_*` settings only (the image's `envsubst` step, with a filter on that prefix).

### 2.2. What is published

- **One port**: `${SDLC_ACCESS_BIND_ADDR:?}:${SDLC_ACCESS_PORT:-8443}:8443`, on the service `sdlc-access` in the profile `access`. The bind address has **no default** (QUESTIONS #409): the operator sets the server's LAN address. `0.0.0.0` is accepted, and `pnpm doctor` warns about it.
- Nothing else changes: every other published port stays on `${SDLC_BIND_ADDR:-127.0.0.1}`, the api included (`127.0.0.1:8090`, for the operator on the server). A static test fails when another service uses the access bind address or a non-loopback address.
- The server still accepts no connection from the internet (D-03 §9): the port is for the company LAN. The firewall stays the operator's job; the README says so.
- **Plain HTTP is refused, never redirected** (QUESTIONS #407): there is no listener on port 80; plain HTTP sent to the TLS port (nginx status 497) answers `400` with a fixed text. A redirect would come after the token was already sent in clear. The CLI refuses an `http://` address that is not on its own machine anyway (ADR-M36).
- TLS 1.2 and 1.3 only, the Mozilla "intermediate" cipher list, session tickets off, `server_tokens off`.
- A request whose `Host` is not `SDLC_ACCESS_HOSTNAME` (with or without the port) or one of `SDLC_ACCESS_IPS` answers `421` (this also blocks DNS rebinding).

### 2.2b. As built (task V09, PR 2)

- The port setting is `SDLC_ACCESS_HOST_PORT` (default 8443), like every other `*_HOST_PORT`, so the live tests' port offsets move it too.
- The bind address has no default in `.env.example`; up.sh refuses the profile without it, and the compose file falls back to `127.0.0.1`, so a direct `docker compose --profile access up` never publishes on the LAN by mistake.
- The rate settings: `SDLC_ACCESS_RATE_PER_SECOND` (10), `SDLC_ACCESS_RATE_BURST` (40), `SDLC_ACCESS_SIGNIN_RATE_PER_MINUTE` (30), `SDLC_ACCESS_SIGNIN_BURST` (10), `SDLC_ACCESS_CONN_PER_ADDR` (20).
- The image: `nginxinc/nginx-unprivileged:1.30.4-alpine`, pinned by digest (Trivy: no CRITICAL finding; three HIGH findings in Alpine packages with fixes upstream, recorded in the PR).
- The settings are checked by `platform/deploy/access/check-settings.sh`, which `up.sh` runs before it starts the profile.
- The api always joins `access` (§2.5), so every throw-away Compose project of the live tests and of `trial:up`'s live test gets its own `access` subnet (a /29 in `172.28.0.0/16`, derived from its `sdlc` subnet), or two projects would share one.

### 2.3. Routes

An allow-list; everything else answers `404`:

| Path | Goes to | Why |
|---|---|---|
| `= /` | `308` to `/dashboard/` | People open the bare address |
| `/dashboard/` | `sdlc-api:8080` | The dashboard's files (ADR-M54) |
| `/v1/` | `sdlc-api:8080` | The API: the CLI, the dashboard, sign-in (ADR-M73) |
| `= /health/live` | `sdlc-api:8080` | `sdlc doctor` (V07) |
| `= /health/ready` | `sdlc-api:8080` | `sdlc doctor` (V07, `cli.api_ready`); status only, no data. Blocking it would give people on other machines a false warning |

- The proxy's own health check answers on `127.0.0.1:8081` inside the container; that port is never published.

### 2.4. Headers, limits, timeouts

- **Response headers** added by the proxy: `Strict-Transport-Security: max-age=31536000` (no `includeSubDomains`, no preload: the host name is internal and other company hosts must not be affected), `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, a small `Permissions-Policy`.
- **The proxy never sets or removes a Content-Security-Policy.** The api's CSP for the dashboard (ADR-M54 §2.3) passes through unchanged; a static test checks the configuration and the live test compares the header.
- **The token** travels only in the `Authorization` header, as today. The proxy's access log is JSON with the time, client address, method, path without the query string, status, bytes and duration: never a header, never a query string.
- **Rate limits per client address** (settings with these defaults): `/v1/` and the rest 10 requests a second, burst 40; `/v1/auth/` (sign-in start and callback) 30 a minute, burst 10; at most 20 connections per address; over the limit `429`. The api's own limits (ADR-M26 §2.7, ADR-M73 §2.2b) stay.
- **Request limits**: `client_max_body_size 64k`, equal to the api's body limit (a test keeps them equal); header and body timeouts 10 s, send 30 s, keep-alive 30 s; to the api: connect 5 s, read 120 s (an evidence pack build, a proposal download; PR 2 checks the longest endpoint); `large_client_header_buffers 4 8k`.

### 2.5. Forwarded addresses (QUESTIONS #408)

- The proxy **overwrites** `X-Forwarded-For` with the TCP peer's address (`$remote_addr`) and clears `Forwarded`, so a client cannot choose the address the api sees.
- **A small network of its own** (Harry, PR #301 review): a new Compose network `access` (name `<project>-access`), with its own subnet `SDLC_ACCESS_NETWORK_SUBNET` (default `172.30.1.0/29`, which does not overlap the default `sdlc` subnet `172.30.0.0/24`) and an allocation range `SDLC_ACCESS_NETWORK_IP_RANGE` (default `172.30.1.0/30`: the gateway and the api only). **Only `sdlc-api` and `sdlc-access` join it.** The proxy is **not** on the `sdlc` network: it talks to the api only (`proxy_pass http://sdlc-api:8080` on `access`), so it cannot reach PostgreSQL, OpenBao, SeaweedFS or any other service.
- The network is a normal bridge, not `internal`: Docker publishes a container's port only through a network that is not internal, and the proxy's port is its only reason to exist.
- The proxy has a **fixed address in that network**, outside the allocation range: `SDLC_ACCESS_PROXY_IP` (default `172.30.1.6`). Docker gives the api an address from the range, so it never takes the proxy's.
- The api trusts `X-Forwarded-For` **only from that address**: a new setting `SDLC_API_TRUSTED_PROXY` (one IPv4 address, empty by default) becomes Fastify's `trustProxy`. The proxy is the only other container on `access`. Without the setting, `trustProxy` stays `false` (ADR-M26 §2.7). The api's per-address limits then count each real client, not the proxy. Requests from the `sdlc` network and from the host (`127.0.0.1:8090`) are never trusted.
- **`sdlc-api` joins `access` always**, not only with the profile. A Compose service cannot change its networks by profile without a second compose file, and the network is harmless: Compose creates it only when a service that uses it starts, it holds only the api until the proxy starts, and it changes nothing on the `sdlc` network. So the api's networks are the same with and without the profile; turning access on or off changes only two api settings (`SDLC_API_TRUSTED_PROXY`, `SDLC_API_PUBLIC_ORIGIN`).
- `X-Forwarded-Proto` and `X-Forwarded-Host` are never used: the public origin is the configured `SDLC_API_PUBLIC_ORIGIN` (ADR-M73), never derived from a request.
- **Limit:** the proxy sees the real client address only when Docker keeps it. Docker on Linux with its default iptables port publishing keeps it; Docker Desktop and some rootless port drivers (O01) show one shared address, so every client would share one limit. The README names this; `pnpm doctor` cannot detect it.

### 2.6. Existing stacks

- **No network step.** The `sdlc` network does not change (subnet, gateway, no allocation range), so an existing stack needs no `down`, no new network and no unseal for V09. After updating to the release, the operator follows README "Upgrade" as usual; Compose creates the new network `<project>-access` when `sdlc-api` starts again with its new configuration.
- The AppRole secret IDs bound to the `sdlc` subnet (ADR-M19 §2.5) stay valid: the api reaches OpenBao over `sdlc`, as before.
- `up.sh` refuses to start when `SDLC_ACCESS_PROXY_IP` is outside `SDLC_ACCESS_NETWORK_SUBNET`, inside its allocation range or equal to its gateway, or when the access subnet overlaps `SDLC_NETWORK_SUBNET`. An operator who set their own `sdlc` subnet checks that `172.30.1.0/29` is free, or sets the access settings.
- PR 2's CHANGELOG "Upgrade notes" say this: new settings, no network step; volumes are never touched.

### 2.7. Certificates (QUESTIONS #406)

- **A host name is required**: `SDLC_ACCESS_HOSTNAME`, the DNS name people open. Passkeys refuse an IP address as their site name, and the dashboard's public origin is `https://<host name>[:port]`. `SDLC_ACCESS_IPS` adds IP names for the CLI (optional).
- Certificate rules: names in the SAN only, extended key usage `serverAuth`.
- `platform/deploy/access/tls.sh`, built like `openbao/tls.sh` (ADR-M63):
  - `import <folder>`: the server, with `ca.pem`, `server.pem` and `server-key.pem` issued by the **company CA**;
  - `server <ca-folder>`: the server, a certificate from the **A10 internal CA** (kept offline with the key shares), valid 1 year;
  - `dev`: a test or developer machine, a **throw-away CA** whose key is deleted at once, valid at most 825 days (macOS refuses longer TLS certificates, also from a CA a person added);
  - `check`: the end dates, exit 1 within 30 days; `reload`: copy the files again and make nginx read them (SIGHUP), without a restart.
- The files live in `SDLC_ACCESS_TLS_DIR`, an absolute folder **outside the repository** (refused inside it), keys mode 600. A one-shot job `access-tls-init` (root, no network) copies them into the volume `access-tls` (owner uid 101, key 600), like `openbao-tls-init`; the proxy mounts that volume read-only and never the host folder.
- `up.sh` warns within 30 days of the end; `pnpm doctor` checks it (§2.8).
- Each client machine must trust the CA: company machines usually trust the company CA already; a throw-away CA is imported by hand in the browser, and the CLI uses `NODE_EXTRA_CA_CERTS` (ADR-M36).

### 2.8. With the rest of the platform

- **The dashboard's actions (ADR-M73):** with the profile `access`, `SDLC_API_PUBLIC_ORIGIN` must be the proxy's origin, `https://<host name>[:port]`; `up.sh` and `pnpm doctor` check it. There is **one** public origin (QUESTIONS #409): while access is on, the GitHub sign-in on `http://localhost:8090` stops working. The GitHub App lists `https://<host name>[:port]/v1/auth/github/callback` (`pnpm github-app:create --callback-url` for a new App, added by hand in the App's settings for an existing one). `__Host-` cookies work over the HTTPS origin, in WebKit too. Passkeys use the host name: people register them again there. Actions stay off until the operator turns them on.
- **The CLI:** `SDLC_API_URL=https://<host name>[:port]` and `NODE_EXTRA_CA_CERTS=<ca.pem>`; the CLI's rules do not change. `sdlc doctor` names `NODE_EXTRA_CA_CERTS` when it sees a CA error.
- **`pnpm doctor` (V07)** adds: the proxy healthy (skipped when the profile is not configured), the certificate files, their end date (warning within 30 days), the host name in the certificate, the published ports (only `sdlc-access` on a non-loopback address, every other port on `127.0.0.1`), the public origin, and `SDLC_API_TRUSTED_PROXY` equal to the proxy's address.
- **The trial stack** (`pnpm trial:up`) never turns access on.

### 2.9. Tests

- `pnpm test`: a static test of the compose file and the configuration template (one published service in the profile, its bind address, the pin, the hardening, the volume, TLS versions, no port 80, the headers, no CSP, `X-Forwarded-For` set to the peer, the zones, the body limit equal to the api's, the route allow-list including `/health/ready`; the network `access`: its own subnet, only `sdlc-api` and `sdlc-access` on it, the proxy not on `sdlc`, its fixed address outside the allocation range); the api settings; the doctor checks with fake facts; the CLI probe's CA hint.
- `pnpm test:access` (live, throw-away Compose project, throw-away OpenBao keys and CA), in the existing CI job `compose`: from a container on another Docker network, only the proxy answers; TLS verified with the CA and refused without it; plain HTTP refused; the routes (including `/health/ready`) and a `404` for others; the headers and the api's CSP unchanged; `413`, `429`, `421`; a spoofed `X-Forwarded-For` does not escape the api's limit; `sdlc whoami` through the proxy; a certificate renewal without a restart; a missing certificate stops the proxy; from the proxy container, PostgreSQL, OpenBao and SeaweedFS are unreachable.

## 3. Alternatives considered

| Option | Why not |
|---|---|
| Caddy (Apache-2.0), as D-08 V09 suggests | No rate limit in the standard image: the `caddy-ratelimit` plugin needs a custom `xcaddy` build, which the project would then build, scan, sign and pin in the release workflow; its automatic HTTPS would be turned off anyway (our own CA) |
| Envoy (Apache-2.0) | Its local rate limit can key on the client address, but the configuration is large and hard to review; a heavier image |
| HAProxy | GPL; the configuration is harder to read for this small job |
| TLS in the api itself (Fastify `https`) | Puts certificate files and renewal into the api process, which holds OpenBao credentials; no per-client limit before the api; the api would listen on the LAN |
| A redirect from HTTP to HTTPS | The request, and its token, already went in clear (§2.2) |
| An IP address only, no host name | Passkeys refuse it (ADR-M73 §2.4) |
| Trust `X-Forwarded-For` from any peer, or the whole subnet | Any container or host process could choose the address the api limits by |
| The proxy on the `sdlc` network with a fixed address, kept free by an allocation range (`ip_range`) on `sdlc` (the first version of PR #301) | Changing `sdlc`'s configuration forces every existing stack to recreate its network (`down`, start again, unseal), for a feature most stacks do not use; the proxy would also reach every service on `sdlc` |
| A list of public origins (localhost and the proxy) | The origin check of ADR-M73 §2.3 stays one exact comparison; operators on the server use the proxy's host name too |

## 4. Consequences and gaps

- A new way in from the LAN: the firewall and the bind address are the operator's job, and the README says the server must never be reachable from the internet.
- The real client address depends on Docker's port publishing (§2.5); on Docker Desktop or some rootless set-ups every client shares one limit.
- One more small Docker network, with a fixed address in it; existing stacks need no network step (§2.6).
- Passkeys registered on `localhost` do not work behind the proxy (ADR-M73 §4).
- Diagram D11 (D-03 §4) does not show the proxy; it stays as it is.
- Exposure to the internet, company single sign-on and more than one api process stay out of scope.

## Version history

| Version | Date | Author | Notes |
|---|---|---|---|
| 1.0 | 2026-10-12 | Claude (task V09, PR 2) | Accepted (PR #301 merged, Harry 2026-10-12). §2.2b: the names as built (`SDLC_ACCESS_HOST_PORT` instead of `SDLC_ACCESS_PORT`, the rate settings, nginx-unprivileged 1.30.4, the throw-away projects' own network `access`); meaning unchanged |
| 0.2 | 2026-10-12 | Claude (task V09, PR 1), after Harry's review of PR #301 | §2.5: a small network `access` for the proxy and the api only (its own subnet, the proxy's fixed address there, the api always on it), the proxy not on `sdlc`; §2.6: existing stacks need no network step, `up.sh` checks; §3: the `ip_range` option rejected; §4 |
| 0.1 | 2026-10-12 | Claude (task V09, PR 1) | First version: nginx, one LAN port, routes (with `/health/ready`), headers and limits, the trusted forwarded address and the network's allocation range with its upgrade step (replaced in 0.2), certificates, ADR-M73, the CLI and doctor, tests (QUESTIONS #405–#409) |
