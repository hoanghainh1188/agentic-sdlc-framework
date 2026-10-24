#!/bin/sh
# Runs the live tests of the index store (task X04 PR 3a, design/ADR-M89 §2.1) on a throw-away
# knowledge-db container: the image of the compose file (by digest), its init script, a random
# superuser password, the port bound to 127.0.0.1. Removed afterwards.
# X04 PR 3b: also a throw-away OpenBao in dev mode (the compose file's image, a random root token,
# in memory) on a network of its own with knowledge-db, for the per-run logins of a tool.
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

openbao_image="$(sed -n 's/^    image: \(openbao\/openbao:[^ ]*\)$/\1/p' "$deploy_dir/docker-compose.yml" | head -n 1)"
[ -n "$openbao_image" ] || { echo "test-knowledge: openbao image not found in docker-compose.yml" >&2; exit 1; }

name="sdlc-test-knowledge-$$"
bao="sdlc-test-knowledge-bao-$$"
network="sdlc-test-knowledge-net-$$"
superuser_password="$(openssl rand -hex 24)"
root_token="$(openssl rand -hex 24)"
cleanup() {
  docker rm -f "$name" "$bao" >/dev/null 2>&1 || true
  docker network rm "$network" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

docker network create "$network" >/dev/null
docker run -d --name "$bao" --network "$network" \
  -e SKIP_SETCAP=true \
  -e BAO_DEV_ROOT_TOKEN_ID="$root_token" \
  -e BAO_DEV_LISTEN_ADDRESS=0.0.0.0:8200 \
  -p 127.0.0.1::8200 \
  "$openbao_image" server -dev >/dev/null

docker run -d --name "$name" --network "$network" --network-alias knowledge-db \
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
bao_port="$(docker port "$bao" 8200/tcp | head -n 1 | sed 's/.*://')"
waited=0
until curl -fsS "http://127.0.0.1:$bao_port/v1/sys/health" >/dev/null 2>&1; do
  if [ "$waited" -ge "$timeout" ]; then
    echo "test-knowledge: OpenBao did not become ready" >&2
    exit 1
  fi
  sleep 1
  waited=$((waited + 1))
done
cd "$repo_root"
# One file at a time: each sets the password of the role `knowledge` in its own set-up.
SDLC_KNOWLEDGE_TEST_URL="postgres://postgres:$superuser_password@127.0.0.1:$port/knowledge" \
SDLC_KNOWLEDGE_TEST_OPENBAO="http://127.0.0.1:$bao_port" \
SDLC_KNOWLEDGE_TEST_OPENBAO_TOKEN="$root_token" \
  pnpm exec vitest run --config vitest.integration.config.ts --no-file-parallelism \
  platform/tests/integration/knowledge "$@"
