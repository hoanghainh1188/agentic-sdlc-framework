#!/usr/bin/env bash
# K01 spike: remove the throw-away stack and ONLY its own volumes (project k01-weknora).
# Never `docker volume prune`, never an `sdlc_*` volume.
set -euo pipefail
cd "$(dirname "$0")"
docker compose -p k01-weknora -f compose.spike.yaml down -v --remove-orphans 2>/dev/null \
  || docker compose -p k01-weknora down -v --remove-orphans
: "${K01_STATE_DIR:=${TMPDIR:-/tmp}/k01-weknora}"
docker volume rm k01-weknora-trivy-cache trivy-k01-cache 2>/dev/null || true
rm -rf "$K01_STATE_DIR"
