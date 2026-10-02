#!/bin/sh
# Starts the platform infrastructure and waits until it is ready (task A02).
#
# Usage: platform/deploy/scripts/up.sh <profile>...
#   e.g. up.sh core
#        up.sh core observability
#
# Environment:
#   SDLC_ENV_FILE      env file (default: platform/deploy/.env, created by init-env.sh)
#   SDLC_WAIT_TIMEOUT  seconds to wait for health (default: 300)
#
# "docker compose up --wait" reports one-shot jobs that exit 0 as failures, so this
# script waits for long-running services to be healthy and, separately, checks that
# every one-shot job exited with code 0.
set -eu

# One-shot jobs (restart: "no"). A static test keeps this list in sync with docker-compose.yml.
JOBS="temporal-schema temporal-namespace seaweedfs-init"

[ "$#" -gt 0 ] || { echo "usage: $0 <profile>..." >&2; exit 2; }

deploy_dir="$(cd "$(dirname "$0")/.." && pwd)"
env_file="${SDLC_ENV_FILE:-$deploy_dir/.env}"
[ -f "$env_file" ] || { echo "up: $env_file not found; run scripts/init-env.sh first" >&2; exit 1; }

# Tracing (A08, design/ADR-M35 §2.4): with the profile observability, the platform processes and
# LiteLLM send traces to the collector, unless SDLC_OTEL_ENDPOINT is set in the environment or the
# env file. The profiles that use it (platform, models) must be started in the same call.
case " $* " in
  *" observability "*)
    if [ -z "${SDLC_OTEL_ENDPOINT:-}" ] && ! grep -Eq '^SDLC_OTEL_ENDPOINT=.+' "$env_file"; then
      SDLC_OTEL_ENDPOINT=http://otel-collector:4318
      export SDLC_OTEL_ENDPOINT
    fi
    ;;
esac

set -- $(for p in "$@"; do printf -- '--profile %s ' "$p"; done)
compose() { docker compose -f "$deploy_dir/docker-compose.yml" --env-file "$env_file" "$@"; }

services="$(compose "$@" config --services)"
long_running=""
jobs=""
for s in $services; do
  case " $JOBS " in
    *" $s "*) jobs="$jobs $s" ;;
    *) long_running="$long_running $s" ;;
  esac
done

compose "$@" up -d
# shellcheck disable=SC2086
compose "$@" up -d --wait --wait-timeout "${SDLC_WAIT_TIMEOUT:-300}" $long_running

# Jobs have finished by now when a long-running service depends on them; otherwise poll.
failed=0
for job in $jobs; do
  tries=0
  while :; do
    line="$(compose "$@" ps -a --format '{{.State}} {{.ExitCode}}' "$job")" || {
      echo "up: cannot read the state of job $job (docker compose ps failed)" >&2
      exit 1
    }
    case "$line" in exited*) break ;; esac
    tries=$((tries + 1))
    if [ "$tries" -ge "${SDLC_WAIT_TIMEOUT:-300}" ]; then line="timeout"; break; fi
    sleep 1
  done
  if [ "$line" != "exited 0" ]; then
    echo "up: job $job did not complete (${line:-no container}); see: docker compose logs $job" >&2
    failed=1
  fi
done
[ "$failed" -eq 0 ] || exit 1
echo "up: all services healthy, all jobs completed"
