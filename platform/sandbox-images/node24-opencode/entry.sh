#!/bin/sh
# Starts OpenCode's HTTP server like the Agent Server (design/ADR-M29 §2.3, ADR-M68 §4): port 8000,
# the runner's per-run SESSION_API_KEY as the server password (HTTP Basic, user `opencode`). The
# sandbox variables of the Agent Server are removed from the environment.
#
# OpenCode keeps the password in its own environment, so the agent's shell can read it (ADR-M68
# §6 gap 1). The adapter does not trust anything the agent could change through its server: it
# enforces the cap and fails the run on any change of the configuration or the tools. Before real
# client work an authenticating proxy will hold the password instead (QUESTIONS #523).
set -eu
[ -n "${SESSION_API_KEY:-}" ] || { echo "entry: SESSION_API_KEY missing" >&2; exit 1; }
export OPENCODE_SERVER_PASSWORD="$SESSION_API_KEY"
# The image's settings as the configuration of the highest precedence: a repository's own
# `opencode.json` cannot loosen the permissions. No permission is `ask`, because nobody answers a
# question in a run (OpenCode's own defaults ask before a third identical call, outside the
# workspace and for `.env` files, and the session would wait for ever).
OPENCODE_CONFIG_CONTENT="$(cat /opt/sdlc/opencode.json)"
export OPENCODE_CONFIG_CONTENT
unset SESSION_API_KEY OH_SECRET_KEY OH_ENABLE_VSCODE OH_TELEMETRY_EXPORTER OPENHANDS_SUPPRESS_BANNER
cd /workspace
exec opencode serve --hostname 0.0.0.0 --port 8000
