#!/usr/bin/env bash
# K01 spike: start the throw-away WeKnora stack. Never touches the platform's dev stack or `sdlc_*` volumes.
# State (secrets, WeKnora source checkout) lives in $K01_STATE_DIR, outside the repository.
set -euo pipefail
cd "$(dirname "$0")"
: "${K01_STATE_DIR:=${TMPDIR:-/tmp}/k01-weknora}"
mkdir -p "$K01_STATE_DIR"; chmod 700 "$K01_STATE_DIR"

# Pinned versions ("<digest> <tag>" per line in results/images.txt, written by this script).
export K01_APP_IMAGE=wechatopenai/weknora-app:v0.8.2
export K01_DOCREADER_IMAGE=wechatopenai/weknora-docreader:v0.8.2
export K01_POSTGRES_IMAGE=pgvector/pgvector:0.8.1-pg17
export K01_QDRANT_IMAGE=qdrant/qdrant:v1.16.2
export K01_VALKEY_IMAGE=valkey/valkey:8.1.10-alpine3.24
export K01_LITELLM_IMAGE=ghcr.io/berriai/litellm:v1.104.0
export K01_NETSHOOT_IMAGE=nicolaka/netshoot:v0.14

# Pin by digest: resolve each tag once, then run by digest.
: > results/images.txt
for v in K01_APP_IMAGE K01_DOCREADER_IMAGE K01_POSTGRES_IMAGE K01_QDRANT_IMAGE K01_VALKEY_IMAGE K01_LITELLM_IMAGE K01_NETSHOOT_IMAGE; do
  ref=${!v}
  digest=$(docker image inspect --format '{{index .RepoDigests 0}}' "$ref")
  echo "$digest $ref" >> results/images.txt
  export "$v=$digest"
done

# WeKnora's own config.yaml at the pinned tag (not copied into this repository).
export K01_WEKNORA_SRC="$K01_STATE_DIR/weknora-src"
[ -d "$K01_WEKNORA_SRC" ] || git clone -q --depth 1 --branch v0.8.2 https://github.com/Tencent/WeKnora.git "$K01_WEKNORA_SRC"

# Throw-away secrets, made once, mode 600, never printed.
SECRETS="$K01_STATE_DIR/secrets.env"
if [ ! -f "$SECRETS" ]; then
  umask 077
  {
    echo "K01_DB_PASSWORD=$(openssl rand -hex 24)"
    echo "K01_VALKEY_PASSWORD=$(openssl rand -hex 24)"
    echo "K01_AES_KEY=$(openssl rand -hex 16)"
    echo "K01_SIGNING_KEY=$(openssl rand -hex 32)"
    echo "K01_JWT_SECRET=$(openssl rand -hex 32)"
    echo "K01_LITELLM_KEY=sk-$(openssl rand -hex 24)"
    echo "K01_USER_PASSWORD=$(openssl rand -hex 12)"
  } > "$SECRETS"
fi
set -a; . "$SECRETS"; set +a
docker compose -f compose.spike.yaml up -d --wait app litellm gateway
docker compose -f compose.spike.yaml up -d capture-app capture-docreader
echo "k01-weknora up: API http://127.0.0.1:32080, LiteLLM http://127.0.0.1:32040"
