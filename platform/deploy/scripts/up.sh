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
#   SDLC_IMAGES        published | local: the platform images (default: scripts/images.sh mode)
#
# "docker compose up --wait" reports one-shot jobs that exit 0 as failures, so this
# script waits for long-running services to be healthy and, separately, checks that
# every one-shot job exited with code 0.
set -eu

# One-shot jobs (restart: "no"). A static test keeps this list in sync with docker-compose.yml.
JOBS="backup-agent openbao-tls-init temporal-schema temporal-namespace seaweedfs-init"

[ "$#" -gt 0 ] || { echo "usage: $0 <profile>..." >&2; exit 2; }

deploy_dir="$(cd "$(dirname "$0")/.." && pwd)"
env_file="${SDLC_ENV_FILE:-$deploy_dir/.env}"
[ -f "$env_file" ] || { echo "up: $env_file not found; run scripts/init-env.sh first" >&2; exit 1; }

# Tracing (A08, design/ADR-M35 §2.4): with the profile observability, the platform processes and
# LiteLLM send traces to the collector, unless SDLC_OTEL_ENDPOINT is set in the environment or the
# env file. The profiles that use it (platform, models) must be started in the same call.
# The Langfuse purge (E08, design/ADR-M53): with the profile observability, or when Langfuse's
# ClickHouse volume exists, the worker purges the traces of purged intents in Langfuse, unless
# SDLC_WORKER_LANGFUSE_URL is set elsewhere.
case " $* " in
  *" observability "*)
    if [ -z "${SDLC_OTEL_ENDPOINT:-}" ] && ! grep -Eq '^SDLC_OTEL_ENDPOINT=.+' "$env_file"; then
      SDLC_OTEL_ENDPOINT=http://otel-collector:4318
      export SDLC_OTEL_ENDPOINT
    fi
    langfuse_on=yes
    ;;
  *)
    # Without observability in this call, Langfuse may still hold traces from an earlier start:
    # its ClickHouse volume exists. Then the worker keeps purging (or waits until Langfuse runs),
    # and never records `not_deployed` for data that is still there (review of E08).
    project="$(sed -n 's/^COMPOSE_PROJECT_NAME=//p' "$env_file" | tail -n 1)"
    if [ -n "$(docker volume ls -q \
      --filter "label=com.docker.compose.project=${project:-deploy}" \
      --filter label=com.docker.compose.volume=clickhouse-data 2>/dev/null || true)" ]; then
      langfuse_on=yes
    fi
    ;;
esac
if [ "${langfuse_on:-no}" = yes ] && [ -z "${SDLC_WORKER_LANGFUSE_URL:-}" ] &&
  ! grep -Eq '^SDLC_WORKER_LANGFUSE_URL=.+' "$env_file"; then
  SDLC_WORKER_LANGFUSE_URL=http://langfuse-web:3000
  export SDLC_WORKER_LANGFUSE_URL
fi

# OpenBao's TLS certificates (A10, design/ADR-M63): warn 30 days before they end; never block.
if ! SDLC_ENV_FILE="$env_file" "$deploy_dir/openbao/tls.sh" check >/dev/null 2>&1; then
  SDLC_ENV_FILE="$env_file" "$deploy_dir/openbao/tls.sh" check >&2 || true
  echo "up: warning: OpenBao's TLS certificate is missing or ends soon (runbook T11 section 3c)" >&2
fi

# Published images (V04, design/ADR-M66 §2.5): on a release checkout, the images of
# images.lock.env pinned by digest (overlay docker-compose.images.yml); everywhere else they are
# built locally from the checkout. SDLC_IMAGES=published|local overrides it (scripts/images.sh).
images_mode="$("$deploy_dir/scripts/images.sh" mode)"
if [ "$images_mode" = published ]; then
  for line in $("$deploy_dir/scripts/images.sh" export); do
    export "${line?}"
  done
  echo "up: using the published images of v$SDLC_IMAGES_VERSION (platform/deploy/images.lock.env)" >&2
fi

set -- $(for p in "$@"; do printf -- '--profile %s ' "$p"; done)
compose() {
  if [ "$images_mode" = published ]; then
    docker compose -f "$deploy_dir/docker-compose.yml" -f "$deploy_dir/docker-compose.images.yml" \
      --env-file "$env_file" "$@"
  else
    docker compose -f "$deploy_dir/docker-compose.yml" --env-file "$env_file" "$@"
  fi
}

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
