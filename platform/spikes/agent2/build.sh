#!/bin/sh
# X01 spike (design/ADR-M68): builds the two agent images FROM the node24 sandbox image.
#   NODE24=<node24 image by digest> platform/spikes/agent2/build.sh
# Prints `aider=<ref>` and `opencode=<ref>` (by digest when the Engine has one).
set -eu
: "${NODE24:?NODE24 must be the node24 image by digest (platform/sandbox-images/build.sh node24 --no-push)}"
case "$NODE24" in *@sha256:*) ;; *) echo "NODE24 must be pinned by digest" >&2; exit 2 ;; esac
here="$(cd "$(dirname "$0")" && pwd)"
# BuildKit resolves a digest reference at the registry; the Engine's local copy is used through a
# local tag instead, after checking that the tag is exactly that digest.
docker tag "$NODE24" sdlc-spike/node24-base:x01
test "$(docker image inspect --format '{{.Id}}' sdlc-spike/node24-base:x01)" = "sha256:${NODE24##*@sha256:}" ||
  { echo "the local node24 copy is not $NODE24" >&2; exit 1; }
for agent in aider opencode; do
  tag="sdlc-spike/agent2-$agent:x01"
  docker build -q --build-arg NODE24=sdlc-spike/node24-base:x01 --label "x01.node24=$NODE24" -t "$tag" "$here/images/$agent" >&2
  echo "$agent=$(docker inspect --format '{{index .RepoDigests 0}}' "$tag")"
done
