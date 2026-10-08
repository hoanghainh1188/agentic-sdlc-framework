#!/usr/bin/env bash
# K01 spike: Trivy (the CI's pinned version) on the WeKnora stack images: vulnerabilities and licences.
# Reports go to $K01_STATE_DIR/trivy/ (outside the repository); summarise them into results/trivy.json by hand.
set -euo pipefail
: "${K01_STATE_DIR:=${TMPDIR:-/tmp}/k01-weknora}"
mkdir -p "$K01_STATE_DIR/trivy"
for i in wechatopenai/weknora-app:v0.8.2 wechatopenai/weknora-docreader:v0.8.2 pgvector/pgvector:0.8.1-pg17 \
  qdrant/qdrant:v1.16.2 \
  valkey/valkey:8.1.10-alpine3.24
do
  n=$(echo "$i" | tr '/:' '__')
  docker run --rm -v /var/run/docker.sock:/var/run/docker.sock -v k01-weknora-trivy-cache:/root/.cache \
    aquasec/trivy:0.74.0 image -q --scanners vuln,license --format json "$i" > "$K01_STATE_DIR/trivy/$n.json"
done
