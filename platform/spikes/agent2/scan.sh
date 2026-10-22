#!/bin/sh
# X01 spike (design/ADR-M68), AC3: Trivy 0.74.0 (the CI's version) on node24 and the two agent
# images, vulnerabilities (HIGH, CRITICAL) and licences, with the sandbox images' .trivyignore.
#   X01_IMAGE_NODE24=… X01_IMAGE_AIDER=… X01_IMAGE_OPENCODE=… X01_OUT=<folder> scan.sh
# JSON reports go to $X01_OUT/trivy/ (outside the repository); summarise.mjs counts them.
set -eu
: "${X01_OUT:?}"
repo_root="$(cd "$(dirname "$0")/../../.." && pwd)"
mkdir -p "$X01_OUT/trivy"
for pair in "node24=$X01_IMAGE_NODE24" "aider=$X01_IMAGE_AIDER" "opencode=$X01_IMAGE_OPENCODE"; do
  name="${pair%%=*}"; ref="${pair#*=}"
  docker run --rm -v /var/run/docker.sock:/var/run/docker.sock -v x01-trivy-cache:/root/.cache \
    -v "$repo_root/platform/sandbox-images/.trivyignore:/ignore:ro" \
    aquasec/trivy:0.74.0@sha256:62b1e65e8869bc4b4c6aa4fa2b21595256c7c2f6018a9d9ad61caf87187c1969 image -q --scanners vuln,license --severity HIGH,CRITICAL \
    --ignorefile /ignore --disable-telemetry --skip-version-check --format json "$ref" \
    > "$X01_OUT/trivy/$name.json"
done
