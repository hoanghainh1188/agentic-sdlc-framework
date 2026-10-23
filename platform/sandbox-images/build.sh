#!/bin/sh
# Builds a sandbox image (design/ADR-M25 §2.9) and pushes it to the local registry of the Compose
# profile "sandbox" (QUESTIONS #54: no GHCR for now). Prints the reference pinned by digest, which
# goes into the project configuration as `sandbox.image`.
#
#   platform/sandbox-images/build.sh node24                     # registry localhost:5000
#   SDLC_SANDBOX_REGISTRY=localhost:5123 platform/sandbox-images/build.sh node24
#   platform/sandbox-images/build.sh node24 --no-push           # build only (CI scans it)
#   NODE24=<node24 by digest> platform/sandbox-images/build.sh node24-opencode
#
# An image built on another one (`ARG NODE24` in its Dockerfile: node24-opencode, task X03) needs
# NODE24, the node24 image pinned by digest. With --no-push NODE24 may also be a local tag (CI
# builds node24 just before and does not push it); the build then uses the Engine's local copy.
#
# --no-push prints the local reference by digest when the Engine has one for this tag's repository
# (containerd image store, for example Docker Desktop, where the Engine cannot push to a port
# published on the host), and the tag otherwise. A digest of another repository (an earlier push of
# the same image to another registry) is never printed: it names an image that may differ.
#
# The registry listens on 127.0.0.1 only and has no authentication (runbook T11 §7): run this on
# the server as an operator. Images are always used by digest, never by tag.
set -eu

toolchain="${1:-}"
case "$toolchain" in
  '' | *[!a-z0-9-]*) echo "usage: $0 <toolchain> [--no-push]" >&2; exit 2 ;;
esac
push=1
[ "${2:-}" = "--no-push" ] && push=0

here="$(cd "$(dirname "$0")" && pwd)"
context="$here/$toolchain"
[ -f "$context/Dockerfile" ] || { echo "no Dockerfile for toolchain $toolchain" >&2; exit 2; }

registry="${SDLC_SANDBOX_REGISTRY:-localhost:${SDLC_REGISTRY_HOST_PORT:-5000}}"
revision="$(git -C "$here" rev-parse --short=12 HEAD 2>/dev/null || echo local)"
tag="$registry/sdlc/sandbox-$toolchain:$revision"

set -- --pull
if grep -q '^ARG NODE24$' "$context/Dockerfile"; then
  : "${NODE24:?NODE24 must be the node24 image (pinned by digest) for $toolchain}"
  case "$NODE24" in
    *@sha256:*) ;;
    *) [ "$push" -eq 0 ] || { echo "NODE24 must be pinned by digest" >&2; exit 2; } ;;
  esac
  if [ "$push" -eq 0 ]; then
    # BuildKit resolves a reference by digest at its registry; a local build uses the Engine's
    # copy through a local tag instead (the registry may not have it).
    base="sdlc/sandbox-base-local:$revision"
    docker tag "$NODE24" "$base"
    set --
  else
    base="$NODE24"
  fi
  set -- "$@" --build-arg "NODE24=$base" --label "sdlc.sandbox.base=$NODE24"
fi

docker build "$@" --label "org.opencontainers.image.revision=$revision" -t "$tag" "$context" >&2
if [ "$push" -eq 0 ]; then
  local_digest="$(docker inspect --format '{{range .RepoDigests}}{{println .}}{{end}}' "$tag" |
    grep "^$registry/sdlc/sandbox-$toolchain@sha256:" | head -n 1 || true)"
  echo "${local_digest:-$tag}"
  exit 0
fi
docker push -q "$tag" >&2
digest="$(docker inspect --format '{{range .RepoDigests}}{{println .}}{{end}}' "$tag" |
  grep "^$registry/sdlc/sandbox-$toolchain@" | head -n 1 | sed 's/.*@//')"
[ -n "$digest" ] || { echo "no digest after the push" >&2; exit 1; }
echo "$registry/sdlc/sandbox-$toolchain@$digest"
