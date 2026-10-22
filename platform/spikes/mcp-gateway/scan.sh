#!/bin/sh
# X14 spike (design/ADR-M87), AC1: Trivy 0.74.0 (the CI's version) on the three gateway images,
# vulnerabilities (HIGH, CRITICAL) and licences. JSON reports go to $X14_OUT/trivy/ (outside the
# repository); summarise.mjs counts them.
set -eu
: "${X14_OUT:?}"
mkdir -p "$X14_OUT/trivy"
for pair in \
  "agentgateway=cr.agentgateway.dev/agentgateway:v1.6.0@sha256:9d3e6044ddcdc0878b1787f77bd401252b95e22684203fb5e874c4c42d2ed90c" \
  "contextforge=ghcr.io/ibm/mcp-context-forge:v1.1.0@sha256:7eb21fb9a8070df59435c03c76c40d8c71230c55ba89f884f2482d2cc81cff1c" \
  "docker=docker/mcp-gateway:v0.44.1@sha256:b0a3876ffbb352813d658cf25c137b8eae29bbe23db5944560a1c9059533bb16"; do
  name="${pair%%=*}"; ref="${pair#*=}"
  docker run --rm -v /var/run/docker.sock:/var/run/docker.sock -v x14-trivy-cache:/root/.cache \
    aquasec/trivy:0.74.0@sha256:62b1e65e8869bc4b4c6aa4fa2b21595256c7c2f6018a9d9ad61caf87187c1969 image -q --scanners vuln,license --severity HIGH,CRITICAL \
    --disable-telemetry --skip-version-check --format json "$ref" \
    > "$X14_OUT/trivy/$name.json"
done
