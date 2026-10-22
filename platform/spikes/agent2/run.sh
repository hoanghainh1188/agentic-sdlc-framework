#!/bin/sh
# X01 spike (design/ADR-M68). DEVELOPER MACHINE ONLY, never in CI. No secret is involved.
#
#   X01_MODE=checks|compare X01_OUT=<folder outside the repo> platform/spikes/agent2/run.sh
#
# Needs: the images of build.sh (X01_IMAGE_AIDER, X01_IMAGE_OPENCODE, X01_IMAGE_NODE24, all by
# digest), Docker, Ollama with `gpt-oss:20b`. Optional: X01_AGENTS=opencode,aider, X01_N=2.
# Starts a throw-away PostgreSQL like platform/deploy/scripts/test-db.sh (same image and init
# scripts, random passwords, 127.0.0.1 only) and removes it afterwards.
set -eu
repo_root="$(cd "$(dirname "$0")/../../.." && pwd)"
deploy_dir="$repo_root/platform/deploy"
image="$(sed -n 's/^    image: \(postgres:[^ ]*\)$/\1/p' "$deploy_dir/docker-compose.yml" | head -n 1)"
[ -n "$image" ] || { echo "run: postgres image not found" >&2; exit 1; }
name="x01-db-$$"
password="$(openssl rand -hex 24)"
cleanup() { docker rm -f "$name" >/dev/null 2>&1 || true; }
trap cleanup EXIT INT TERM
docker run -d --name "$name" \
  -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD="$password" \
  -e PLATFORM_DB_PASSWORD="$(openssl rand -hex 24)" \
  -e PLATFORM_APP_DB_PASSWORD="$(openssl rand -hex 24)" \
  -e TEMPORAL_DB_PASSWORD="$(openssl rand -hex 24)" \
  -e LITELLM_DB_PASSWORD="$(openssl rand -hex 24)" \
  -e LANGFUSE_DB_PASSWORD="$(openssl rand -hex 24)" \
  -v "$deploy_dir/postgres/init:/docker-entrypoint-initdb.d:ro" \
  -p 127.0.0.1::5432 "$image" >/dev/null
waited=0
until docker exec "$name" pg_isready -q -h 127.0.0.1 -U postgres -d postgres; do
  [ "$waited" -lt 120 ] || { echo "run: PostgreSQL did not become ready" >&2; exit 1; }
  sleep 1; waited=$((waited + 1))
done
port="$(docker port "$name" 5432/tcp | head -n 1 | sed 's/.*://')"
cd "$repo_root"
X01=1 SDLC_REQUIRE_DB=1 SDLC_TEST_DATABASE_URL="postgres://postgres:$password@127.0.0.1:$port/postgres" \
  pnpm exec vitest run --config platform/spikes/agent2/vitest.config.mjs
