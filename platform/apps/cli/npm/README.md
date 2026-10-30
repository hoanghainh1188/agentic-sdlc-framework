# @hoanghainh/governed-adlc

The `adlc` command of [governed-adlc-fw](https://github.com/hoanghainh1188/governed-adlc-fw), a self-hosted platform that runs AI coding agents through eight checkpoints (gates G1–G8) with the right people approving each one. With `adlc` you create intents, decide gates, handle escalations, and read evidence and cost.

**`adlc` is a client: it needs a running platform.** Installing it does not install the platform.

- **No platform yet, and you want to try it?** Set one up on your own machine with one command: [TRIAL.md](https://github.com/hoanghainh1188/governed-adlc-fw/blob/main/TRIAL.md) (Docker, about 20–40 minutes; fictional data only).
- **Your team runs a platform?** Ask its operator for the address and ask a tenant admin for your account (steps 2 and 3 below).
- **You deploy it on a server?** Follow [Fresh deployment](https://github.com/hoanghainh1188/governed-adlc-fw/blob/main/platform/deploy/README.md#fresh-deployment-operator).

## 1. Install

You need Node.js 24 (`node --version` prints `v24.…`).

```bash
npm install -g @hoanghainh/governed-adlc
adlc --version
```

Use the **same version as your platform**. If it runs an older release, install that one: `npm install -g @hoanghainh/governed-adlc@<its version>` (a platform older than v0.9.0: `agentic-sdlc-cli@<its version>`) (ask its operator; `adlc doctor` compares the two for you in step 4).

## 2. Find your platform's address

| Where the platform runs | Address to use | Who tells you |
|---|---|---|
| On your own machine (`pnpm trial:up`, or a development stack) | `http://127.0.0.1:8090` | Nobody: this is the default. After `pnpm trial:up` you are already logged in, so skip step 3 |
| On the server itself (you are logged in to it) | `http://127.0.0.1:8090` | The operator, if they changed the port |
| On a team server, from your own computer | `https://<server name>:8443`, for example `https://sdlc.example.internal:8443` | The operator. If the server's certificate comes from your company's own certificate authority (CA), they also give you its `ca.pem` |

- Plain `http://` works only for this machine (`127.0.0.1`, `localhost`). Any other address must be `https://`, and the certificate is always checked.
- With a company or test CA, tell Node.js to trust it, in your shell profile: `export NODE_EXTRA_CA_CERTS=<path to ca.pem>`.

## 3. Log in

You need a personal API token. It starts with `sdlc_pat_` and a tenant admin of your platform gives you the first one (they create your user and your roles; you cannot give roles to yourself). Keep it in your password manager, never in a chat or a ticket.

```bash
adlc login --api-url <address from step 2>
```

`adlc login` asks for the token and does not show it while you type. It checks the token with the platform before it saves the login (in `~/.config/adlc/`, readable by you only). Never put the token on the command line.

The first token a tenant admin issues for you lives at most 7 days. Once logged in, create your own (`adlc token create --name laptop`), log in again with it, then revoke the first one (`adlc token list`, `adlc token revoke --id <ID>`).

## 4. Check, then start

```bash
adlc whoami
adlc doctor
```

`adlc doctor` checks the address, the certificate, your token and when it ends, your roles per project, and that your `adlc` matches the platform's version. For every problem it prints what to do.

Then, for example:

```bash
adlc intent list
adlc next INT-2026-0001
```

`adlc next` tells you where an intent is and what you can do now. The [user guide](https://github.com/hoanghainh1188/governed-adlc-fw/blob/main/platform/USER-GUIDE.md) explains the whole path from an intent to a release.

## Good to know

- The operator commands (`adlc ops …`) work only on the platform server, with `SDLC_DB_URL`.
- Every release from v0.9.1 on is published from a tag of the repository by GitHub Actions, with npm provenance (npm shows the commit and the workflow that built it). Version 0.9.0, the first of this package, was published by hand, without provenance. The old package `agentic-sdlc-cli` had provenance from v0.2.0 to v0.8.0; its 0.1.1 was published by hand.
- The platform's web dashboard is at `<address from step 2>/dashboard/`; on the platform machine itself use `http://localhost:8090/dashboard/` (`localhost`, not `127.0.0.1`, for the GitHub sign-in).
- To update: `npm install -g @hoanghainh/governed-adlc@<new version>`. To remove: `npm uninstall -g @hoanghainh/governed-adlc`.
- **Coming from `agentic-sdlc-cli`** (the name up to v0.8.0, command `sdlc`): run `npm uninstall -g agentic-sdlc-cli`, then install this package. You stay logged in: `adlc` reads the login that `sdlc` saved in `~/.config/sdlc/` until it saves its own in `~/.config/adlc/`. Versions 0.9.x also installed `sdlc`; from 0.10.0 the command is `adlc` only, so change your scripts.

MIT licence. The bundled third-party packages and their licences are listed in `THIRD-PARTY-NOTICES`.
