#!/usr/bin/env bash
# K01 spike: sample `docker stats` of the k01-weknora containers every 5 s into $K01_STATE_DIR/stats-<label>.tsv.
set -euo pipefail
: "${K01_STATE_DIR:=${TMPDIR:-/tmp}/k01-weknora}"
label=${1:?label}
while true; do
  docker stats --no-stream --format '{{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}' $(docker ps -q --filter label=com.docker.compose.project=k01-weknora) \
    | sed "s/^/$(date +%s)\t/" >> "$K01_STATE_DIR/stats-$label.tsv"
  sleep 5
done
