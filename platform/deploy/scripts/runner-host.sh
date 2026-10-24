#!/bin/sh
# The runner on its own Docker Engine (task O01, design/ADR-M91): starts and stops the runner host's
# Compose project. Runs on the runner host, against its own Engine (DOCKER_HOST, or the default
# socket of the user that runs it). Deploy README "The runner on its own Docker Engine".
#
# Usage: platform/deploy/scripts/runner-host.sh env              # once: runner-host/.env
#        platform/deploy/scripts/runner-host.sh up [knowledge] [vm]
#        platform/deploy/scripts/runner-host.sh down
#        platform/deploy/scripts/runner-host.sh ps
#        platform/deploy/scripts/runner-host.sh restart   # the runner, after runner-credentials
#   knowledge  also the knowledge-db relay (the platform runs the profile knowledge)
#   vm         also the registry relay (a separate VM only)
#
# Environment:
#   SDLC_RUNNER_HOST_ENV_FILE  env file (default: platform/deploy/runner-host/.env)
#   SDLC_WAIT_TIMEOUT          seconds to wait for health (default: 300)
#   SDLC_IMAGES                published | local (default: scripts/images.sh mode)
set -eu

deploy_dir="$(cd "$(dirname "$0")/.." && pwd)"
host_dir="$deploy_dir/runner-host"
env_file="${SDLC_RUNNER_HOST_ENV_FILE:-$host_dir/.env}"

fail() {
  echo "runner-host: $*" >&2
  exit 1
}

command="${1:-}"
[ -n "$command" ] || fail "usage: runner-host.sh env | up [knowledge] [vm] | down | ps | restart"
shift

if [ "$command" = env ]; then
  [ "$#" -eq 0 ] || fail "env takes no argument"
  [ -e "$env_file" ] && fail "$env_file already exists; not overwriting"
  cp "$host_dir/.env.example" "$env_file"
  chmod 600 "$env_file"
  echo "runner-host: $env_file written; set SDLC_RUNNER_LINK_ADDR, SDLC_DOCKER_SOCKET and SDLC_OPENBAO_CA_FILE"
  exit 0
fi

[ -f "$env_file" ] || fail "$env_file not found; run: pnpm runner-host:env"
link_addr="$(sed -n 's/^SDLC_RUNNER_LINK_ADDR=//p' "$env_file" | tail -n 1)"
[ -n "$link_addr" ] || fail "SDLC_RUNNER_LINK_ADDR is empty in $env_file"

profiles="--profile sandbox"
for p in "$@"; do
  case "$p" in
    knowledge | vm) profiles="$profiles --profile $p" ;;
    *) fail "unknown profile: $p (knowledge or vm)" ;;
  esac
done
[ "$command" = down ] && profiles="--profile sandbox --profile knowledge --profile vm"

# Published images (V04, ADR-M66 §2.5): on a release checkout, the runner image of images.lock.
images_mode="$("$deploy_dir/scripts/images.sh" mode)"
if [ "$images_mode" = published ]; then
  for line in $("$deploy_dir/scripts/images.sh" export); do
    export "${line?}"
  done
fi

# The runner host never runs a platform service: refuse an Engine that holds the platform's
# volumes (ADR-M91 §2.1).
project="$(sed -n 's/^COMPOSE_PROJECT_NAME=//p' "$env_file" | tail -n 1)"
if [ -n "$(docker volume ls -q --filter "label=com.docker.compose.project=${project:-sdlc}" \
  --filter label=com.docker.compose.volume=postgres-data 2>/dev/null || true)" ]; then
  fail "this Docker Engine holds the platform's data (volume postgres-data): the runner needs its own Engine (ADR-M91)"
fi

# shellcheck disable=SC2086
# The group of the Engine's socket as the Engine's containers see it: the socket proxy reads the
# socket with it, and the runner reaches the proxy with it. A rootless Engine maps the host's
# `docker` group, when one exists, into its namespace. Empty SDLC_DOCKER_GID in the env file: read
# it here, with a throw-away container of the pinned relay image (no network, read-only socket).
RELAY_IMAGE="haproxy:3.2.26-alpine@sha256:dfba86f031bd4c9039f10f8cc5de75991d1b6766d5460f0335b980408503baad"
if [ "$command" = up ] && [ -z "$(sed -n 's/^SDLC_DOCKER_GID=//p' "$env_file" | tail -n 1)" ]; then
  socket="$(sed -n 's/^SDLC_DOCKER_SOCKET=//p' "$env_file" | tail -n 1)"
  SDLC_DOCKER_GID="$(docker run --rm --network none --read-only --cap-drop ALL \
    -v "${socket:-/var/run/docker.sock}:/s:ro" --entrypoint stat "$RELAY_IMAGE" -c %g /s)" ||
    fail "cannot read the group of the Docker socket ${socket:-/var/run/docker.sock}"
  export SDLC_DOCKER_GID
  echo "runner-host: the Docker socket's group is $SDLC_DOCKER_GID"
fi

compose() {
  if [ "$images_mode" = published ]; then
    set -- -f "$host_dir/docker-compose.images.yml" --env-file "$env_file" $profiles "$@"
  else
    set -- --env-file "$env_file" $profiles "$@"
  fi
  docker compose -f "$host_dir/docker-compose.yml" "$@"
}
wait_up() { compose up -d --wait --wait-timeout "${SDLC_WAIT_TIMEOUT:-300}" "$@"; }

case "$command" in
  up)
    wait_up docker-socket-proxy npm-proxy litellm sdlc-runner
    state="$(compose ps -a --format '{{.State}} {{.ExitCode}}' openbao-ca-init)"
    [ "$state" = "exited 0" ] || fail "job openbao-ca-init did not complete ($state)"
    for p in "$@"; do
      case "$p" in
        knowledge) wait_up knowledge-db ;;
        vm) wait_up registry ;;
      esac
    done
    echo "runner-host: all services healthy"
    ;;
  down | ps) compose "$command" ;;
  restart) compose restart sdlc-runner ;;
  *) fail "unknown command: $command" ;;
esac
