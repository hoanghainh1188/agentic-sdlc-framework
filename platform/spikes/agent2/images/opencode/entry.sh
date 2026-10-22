#!/bin/sh
# X01 spike: start OpenCode's HTTP server like the Agent Server (ADR-M29 §2.3): port 8000, the
# runner's per-run SESSION_API_KEY as the server password (HTTP Basic, user `opencode`). The
# sandbox variables are removed from the environment, so the agent's shell never sees them.
set -eu
[ -n "${SESSION_API_KEY:-}" ] || { echo "entry: SESSION_API_KEY missing" >&2; exit 1; }
export OPENCODE_SERVER_PASSWORD="$SESSION_API_KEY"
unset SESSION_API_KEY OH_SECRET_KEY
cd /workspace
exec opencode serve --hostname 0.0.0.0 --port 8000
