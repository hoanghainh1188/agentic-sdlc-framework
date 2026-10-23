#!/bin/sh
# Runs the live tests of the index store (task X04 PR 3a, design/ADR-M89 §2.1) on a throw-away
# knowledge-db container: the image of the compose file (by digest), its init script, a random
# superuser password, the port bound to 127.0.0.1. Removed afterwards.
#
# Usage: platform/deploy/scripts/test-knowledge.sh [vitest arguments]
set -eu

repo_root="$(cd "$(dirname "$0")/../../.." && pwd)"
deploy_dir="$repo_root/platform/deploy"

command -v docker >/dev/null 2>&1 || { echo "test-knowledge: docker is required" >&2; exit 1; }
command -v openssl >/dev/null 2>&1 || { echo "test-knowledge: openssl is required" >&2; exit 1; }

# One source for the image: the knowledge-db service of the compose file.
image="$(sed -n 's/^    image: \(pgvector\/pgvector:[^ ]*@sha256:[0-9a-f]*\)$/\1/p' "$deploy_dir/docker-compose.yml" | head -n 1)"
[ -n "$image" ] || { echo "test-knowledge: pgvector image not found in docker-compose.yml" >&2; exit 1; }

name="sdlc-test-knowledge-$$"
superuser_password="$(openssl rand -hex 24)"
cleanup() { docker rm -f "$name" >/dev/null 2>&1 || true; }
trap cleanup EXIT INT TERM

docker run -d --name "$name" \
  -e POSTGRES_USER=postgres \
  -e POSTGRES_PASSWORD="$superuser_password" \
  -v "$deploy_dir/knowledge-db/init:/docker-entrypoint-initdb.d:ro" \
  -p 127.0.0.1::5432 \
  "$image" >/dev/null

timeout="${SDLC_TEST_DB_TIMEOUT:-120}"
waited=0
until docker exec "$name" pg_isready -q -h 127.0.0.1 -U postgres -d knowledge; do
  if [ "$(docker inspect -f '{{.State.Running}}' "$name")" != true ] || [ "$waited" -ge "$timeout" ]; then
    echo "test-knowledge: knowledge-db did not become ready" >&2
    docker logs "$name" >&2 || true
    exit 1
  fi
  sleep 1
  waited=$((waited + 1))
done

port="$(docker port "$name" 5432/tcp | head -n 1 | sed 's/.*://')"
cd "$repo_root"
SDLC_KNOWLEDGE_TEST_URL="postgres://postgres:$superuser_password@127.0.0.1:$port/knowledge" \
  pnpm exec vitest run --config vitest.integration.config.ts platform/tests/integration/knowledge "$@"
