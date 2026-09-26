#!/bin/sh
# OpenBao bootstrap (task A03, design/ADR-M19). Procedure and custody rules:
# handbook/03-templates/T11-openbao-runbook.md.
#
# Runs on the host and uses the bao command inside the Compose "openbao" container, so the host
# needs only Docker. Key shares and tokens are read from a hidden prompt (or stdin when stdin is
# not a terminal), passed to the container on stdin, and never written to a file, a command
# line or an environment variable of the host.
#
# Environment:
#   SDLC_ENV_FILE  Compose env file (default: platform/deploy/.env)
set -eu

deploy_dir="$(cd "$(dirname "$0")/.." && pwd)"
settings="$deploy_dir/openbao/bootstrap/bootstrap.conf"
in_container=/openbao/bootstrap

usage() {
  cat <<'EOF'
Usage: platform/deploy/openbao/bootstrap.sh <command> [options]

Commands:
  status               Show whether OpenBao is uninitialised, sealed or unsealed.
  init                 Initialise OpenBao once. Prints the key shares and the first root
                       token ONE time, to the terminal only. Refuses when output is not a
                       terminal and when OpenBao is already initialised.
  unseal               Ask for key shares (hidden) until OpenBao is unsealed.
  configure [--keep-token]
                       Ask for a root token (hidden) and apply the configuration: KV v2,
                       Transit key, policies, AppRoles, admin token role. Safe to run again.
                       Revokes the root token at the end unless --keep-token is given.
  root-token           Ask for key shares (hidden) and create a new root token. Prints it
                       ONE time, to the terminal only. Revoke it after use.

Runbook: handbook/03-templates/T11-openbao-runbook.md
EOF
}

say() { echo "bootstrap: $*"; }
fail() {
  echo "bootstrap: $*" >&2
  exit 1
}
setting() {
  value="$(sed -n "s/^$1=//p" "$settings" | tail -n 1)"
  [ -n "$value" ] || fail "setting $1 missing in $settings"
  printf '%s' "$value"
}

# --- Arguments (parsed before anything touches Docker) ----------------------------------------
[ "$#" -ge 1 ] || {
  usage >&2
  exit 2
}
command="$1"
shift
keep_token=no
allow_non_tty=no
for arg in "$@"; do
  case "$arg" in
    --keep-token)
      [ "$command" = configure ] || fail "unknown option: $arg"
      keep_token=yes
      ;;
    # Test hook only: lets the live test keep the printed secrets in memory. Accepted only when
    # SDLC_OPENBAO_TEST=1; never documented in --help.
    --stdout-not-tty)
      [ "${SDLC_OPENBAO_TEST:-}" = 1 ] || fail "unknown option: $arg"
      allow_non_tty=yes
      ;;
    *) fail "unknown option: $arg" ;;
  esac
done
case "$command" in
  -h | --help | help)
    usage
    exit 0
    ;;
  status | init | unseal | configure | root-token) ;;
  *)
    usage >&2
    exit 2
    ;;
esac

env_file="${SDLC_ENV_FILE:-$deploy_dir/.env}"
[ -f "$env_file" ] || fail "$env_file not found; run scripts/init-env.sh first"
command -v docker >/dev/null 2>&1 || fail "docker is required"

compose() { docker compose -f "$deploy_dir/docker-compose.yml" --env-file "$env_file" "$@"; }
# "docker compose exec" reads stdin until it ends. Only calls that pass a secret get stdin;
# every other call gets /dev/null, so it cannot swallow the next key share or token.
bao_exec() { compose exec -T openbao "$@"; }
bao_exec_no_input() { compose exec -T openbao "$@" </dev/null; }

# Prints uninitialised, sealed or unsealed. Fails when the container or API is not reachable.
state() {
  out="$(bao_exec_no_input wget -q -O - http://127.0.0.1:8200/v1/sys/seal-status 2>/dev/null)" ||
    fail "OpenBao is not reachable; start it with: pnpm compose:core"
  case "$out" in
    *'"initialized":false'*) echo uninitialised ;;
    *'"sealed":true'*) echo sealed ;;
    *'"sealed":false'*) echo unsealed ;;
    *) fail "unexpected answer from OpenBao seal-status" ;;
  esac
}

require_unsealed() {
  case "$(state)" in
    unsealed) ;;
    sealed) fail "OpenBao is sealed; unseal it first: bootstrap.sh unseal (runbook T11 section 4)" ;;
    uninitialised) fail "OpenBao is not initialised; run: bootstrap.sh init (runbook T11 section 3)" ;;
  esac
}

# Secrets go to the terminal only (AC1: printed once, never to a file).
require_terminal_output() {
  [ -t 1 ] || [ "$allow_non_tty" = yes ] ||
    fail "output is not a terminal; secrets are printed only to a terminal. Do not redirect or pipe this command"
}

restore_echo() { [ -t 0 ] && stty echo 2>/dev/null || true; }

# read_secret <prompt>: hidden prompt on a terminal, plain line from stdin otherwise.
read_secret() {
  if [ -t 0 ]; then
    printf '%s: ' "$1" >&2
    trap 'restore_echo; exit 130' INT TERM
    stty -echo
    IFS= read -r secret || secret=""
    restore_echo
    trap - INT TERM
    echo >&2
  else
    IFS= read -r secret || secret=""
  fi
  printf '%s' "$secret"
}

cmd_status() {
  say "OpenBao is $(state)"
}

cmd_init() {
  require_terminal_output
  [ "$(state)" = uninitialised ] || fail "OpenBao is already initialised; nothing printed"
  shares="$(setting BAO_KEY_SHARES)"
  threshold="$(setting BAO_KEY_THRESHOLD)"
  cat <<EOF
================================================================================
 OpenBao initialisation: $shares key shares, any $threshold unseal.
 The shares and the root token below are shown ONCE. They are not stored anywhere.
 Give each share to a different key holder (runbook T11 section 3).
 Never paste them into chat, email, issues, files or logs.
================================================================================
EOF
  bao_exec_no_input bao operator init -key-shares="$shares" -key-threshold="$threshold"
  cat <<EOF
================================================================================
 Next: bootstrap.sh unseal ($threshold shares), then bootstrap.sh configure (root token).
 configure revokes the root token when it finishes.
================================================================================
EOF
}

cmd_unseal() {
  case "$(state)" in
    unsealed)
      say "OpenBao is already unsealed"
      return 0
      ;;
    uninitialised) fail "OpenBao is not initialised; run: bootstrap.sh init" ;;
  esac
  while [ "$(state)" = sealed ]; do
    share="$(read_secret 'Unseal key share (hidden)')"
    [ -n "$share" ] || fail "no key share given; OpenBao is still sealed"
    progress="$(printf '%s' "$share" | bao_exec bao write -field=progress sys/unseal key=- 2>/dev/null)" ||
      fail "the key share was rejected; OpenBao is still sealed"
    [ "$(state)" = sealed ] && say "share accepted ($progress of $(setting BAO_KEY_THRESHOLD))"
  done
  say "OpenBao is unsealed"
}

# Subnet(s) of the Compose network the openbao container is on, WITHOUT the gateway address:
# on a Linux host every host process reaches containers from the gateway (QUESTIONS #37).
network_cidrs() {
  container="$(compose ps -q openbao </dev/null)"
  [ -n "$container" ] || fail "the openbao container is not running"
  network="$(docker inspect -f '{{range $name, $_ := .NetworkSettings.Networks}}{{$name}} {{end}}' "$container")"
  cidrs=""
  for n in $network; do
    for pair in $(docker network inspect -f '{{range .IPAM.Config}}{{.Subnet}}|{{.Gateway}} {{end}}' "$n"); do
      subnet="${pair%%|*}"
      gateway="${pair#*|}"
      [ -n "$gateway" ] || fail "the Compose network has no fixed gateway (SDLC_NETWORK_GATEWAY in .env)"
      blocks="$("$deploy_dir/openbao/cidr-exclude.sh" "$subnet" "$gateway")" ||
        fail "cannot exclude the gateway $gateway from $subnet"
      cidrs="${cidrs:+$cidrs,}$blocks"
    done
  done
  [ -n "$cidrs" ] || fail "cannot read the subnet of the Compose network"
  printf '%s' "$cidrs"
}

cmd_configure() {
  require_unsealed
  cidrs="$(setting SECRET_ID_BOUND_CIDRS)"
  [ "$cidrs" = compose-network ] && cidrs="$(network_cidrs)"
  token="$(read_secret 'Root token (hidden)')"
  [ -n "$token" ] || fail "no root token given"
  set -- "$cidrs"
  [ "$keep_token" = yes ] && set -- "$@" --keep-token
  printf '%s\n' "$token" | bao_exec sh "$in_container/configure.sh" "$@"
}

cmd_root_token() {
  require_terminal_output
  require_unsealed
  threshold="$(setting BAO_KEY_THRESHOLD)"
  input=""
  i=1
  while [ "$i" -le "$threshold" ]; do
    share="$(read_secret "Key share $i of $threshold (hidden)")"
    [ -n "$share" ] || fail "no key share given"
    input="$input$share
"
    i=$((i + 1))
  done
  echo "New root token (shown ONCE; revoke it after use, record the use in the operations log):"
  printf '%s' "$input" | bao_exec sh "$in_container/root-token.sh"
}

case "$command" in
  status) cmd_status ;;
  init) cmd_init ;;
  unseal) cmd_unseal ;;
  configure) cmd_configure ;;
  root-token) cmd_root_token ;;
esac
