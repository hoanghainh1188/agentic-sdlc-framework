#!/bin/sh
# Builds the image of a first-party register tool (task X04 PR 3b, design/ADR-M89, ADR-M69 §2.2)
# and pushes it to the local registry of the Compose profile "sandbox", like the sandbox images
# (runbook T11 §5g). Prints the reference pinned by digest: its name goes into
# `adlc admin tool register --image`, its digest into `--image-digest`.
#
#   pnpm tool-image:build project-docs              # registry localhost:5000
#   pnpm tool-image:build project-docs --no-push    # build only (CI scans it)
#
# A release publishes the same image to GHCR (release-images.yml, `tool-project-docs`); a release
# checkout prints it with `pnpm images get TOOL_PROJECT_DOCS`.
set -eu

tool="${1:-}"
case "$tool" in
  project-docs) ;;
  *) echo "usage: $0 project-docs [--no-push]" >&2; exit 2 ;;
esac
push=1
[ "${2:-}" = "--no-push" ] && push=0

root="$(cd "$(dirname "$0")/../../.." && pwd)"
registry="${SDLC_SANDBOX_REGISTRY:-localhost:${SDLC_REGISTRY_HOST_PORT:-5000}}"
revision="$(git -C "$root" rev-parse --short=12 HEAD 2>/dev/null || echo local)"
repo="$registry/sdlc/tool-$tool"
tag="$repo:$revision"

docker build --pull --label "org.opencontainers.image.revision=$revision" \
  -f "$root/platform/apps/tool-$tool/Dockerfile" -t "$tag" "$root" >&2
if [ "$push" -eq 0 ]; then
  echo "$tag"
  exit 0
fi
docker push -q "$tag" >&2
digest="$(docker inspect --format '{{range .RepoDigests}}{{println .}}{{end}}' "$tag" |
  grep "^$repo@" | head -n 1 | sed 's/.*@//')"
[ -n "$digest" ] || { echo "no digest after the push" >&2; exit 1; }
echo "$repo@$digest"
