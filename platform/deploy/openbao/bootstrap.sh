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
  litellm-credentials  Ask for an admin token (hidden), issue a new secret ID for the AppRole
                       "litellm" and write it with the role ID into the volume of the LiteLLM
                       sidecar (Compose profile "models"). Prints no secret. Run it again to
                       rotate the secret ID, then restart litellm-agent (runbook T11).
  api-credentials      Ask for an admin token (hidden). Store the platform_app database password
                       (PLATFORM_APP_DB_PASSWORD from the env file) at kv/api/database, issue a
                       new secret ID for the AppRole "api" and write it with the role ID into the
                       volume of sdlc-api (Compose profile "platform"). Prints no secret. Run it
                       again to rotate, then restart sdlc-api (runbook T11).

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
  status | init | unseal | configure | root-token | litellm-credentials | api-credentials) ;;
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

# The role ID and a new secret ID go from the openbao container straight into the sidecar's volume
# through a pipe: never a host file, a command line or an environment variable. The admin token
# goes to the openbao container on stdin.
cmd_litellm_credentials() {
  require_unsealed
  token="$(read_secret 'Admin or root token (hidden)')"
  [ -n "$token" ] || fail "no token given"
  printf '%s\n' "$token" |
    bao_exec sh -c 'IFS= read -r BAO_TOKEN && export BAO_TOKEN &&
      bao read -field=role_id auth/approle/role/litellm/role-id && echo &&
      bao write -f -field=secret_id auth/approle/role/litellm/secret-id && echo' |
    compose --profile core --profile models run --rm -T --no-deps --user root --entrypoint sh \
      litellm-agent -c '
      umask 077
      IFS= read -r role_id || role_id=""
      IFS= read -r secret_id || secret_id=""
      [ -n "$role_id" ] && [ -n "$secret_id" ] || { echo "no role ID or secret ID received" >&2; exit 1; }
      printf "%s\n" "$role_id" >/openbao/approle/role_id
      printf "%s\n" "$secret_id" >/openbao/approle/secret_id
      chown -R openbao:openbao /openbao/approle
      chmod 700 /openbao/approle' ||
    fail "could not deliver the litellm credentials (token valid? OpenBao configured with the litellm AppRole?)"
  say "litellm AppRole credentials written to the litellm-approle volume; restart litellm-agent to use them"
}

# The database password goes from the env file to the openbao container on stdin, after the admin
# token; the role ID and a new secret ID go from the openbao container straight into the volume
# of sdlc-api through a pipe. Never a host file, a command line or an environment variable.
# sdlc-api drops every capability; this one-shot root container gets back only what it needs to
# write the files and give them to the user node.
cmd_api_credentials() {
  require_unsealed
  password="$(sed -n 's/^PLATFORM_APP_DB_PASSWORD=//p' "$env_file" | tail -n 1)"
  case "$password" in
    '' | CHANGEME) fail "PLATFORM_APP_DB_PASSWORD is not set in $env_file" ;;
  esac
  token="$(read_secret 'Admin or root token (hidden)')"
  [ -n "$token" ] || fail "no token given"
  printf '%s\n%s' "$token" "$password" |
    bao_exec sh -c 'IFS= read -r BAO_TOKEN && export BAO_TOKEN &&
      bao kv put -mount=kv api/database password=- >/dev/null' ||
    fail "could not store kv/api/database (token valid? OpenBao configured?)"
  printf '%s\n' "$token" |
    bao_exec sh -c 'IFS= read -r BAO_TOKEN && export BAO_TOKEN &&
      bao read -field=role_id auth/approle/role/api/role-id && echo &&
      bao write -f -field=secret_id auth/approle/role/api/secret-id && echo' |
    compose --profile core --profile platform run --rm -T --no-deps --user root \
      --cap-add CHOWN --cap-add DAC_OVERRIDE --cap-add FOWNER --entrypoint sh sdlc-api -c '
      set -e
      umask 077
      IFS= read -r role_id || role_id=""
      IFS= read -r secret_id || secret_id=""
      [ -n "$role_id" ] && [ -n "$secret_id" ] || { echo "no role ID or secret ID received" >&2; exit 1; }
      printf "%s\n" "$role_id" >/run/sdlc/approle/role_id
      printf "%s\n" "$secret_id" >/run/sdlc/approle/secret_id
      chown -R node:node /run/sdlc/approle
      chmod 700 /run/sdlc/approle' ||
    fail "could not deliver the api credentials (token valid? OpenBao configured with the api AppRole?)"
  say "kv/api/database stored; api AppRole credentials written to the api-approle volume; restart sdlc-api to use them"
}

case "$command" in
  status) cmd_status ;;
  init) cmd_init ;;
  unseal) cmd_unseal ;;
  configure) cmd_configure ;;
  root-token) cmd_root_token ;;
  litellm-credentials) cmd_litellm_credentials ;;
  api-credentials) cmd_api_credentials ;;
esac
