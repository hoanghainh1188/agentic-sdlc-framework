#!/bin/sh
# Remove what a CI job left in Docker (design/ADR-M34 §2.3). One runner per VM, so nothing that
# still exists belongs to another job. Images and build cache stay until the daily prune.
set -eu

# Containers that bind-mount the workspace (Semgrep) can leave root-owned files there, and the
# next checkout could not delete them. Give the workspace back to the runner user.
BUSYBOX_IMAGE=busybox:1.37.0@sha256:bdf57e528e45e4433820e045b29b4597825a1c9e38353532d90a01445013f82e
if [ -n "${GITHUB_WORKSPACE:-}" ] && [ -d "$GITHUB_WORKSPACE" ]; then
  docker run --rm --network none -v "$GITHUB_WORKSPACE:/w" "$BUSYBOX_IMAGE" \
    chown -R "$(id -u):$(id -g)" /w
fi

containers=$(docker ps -aq)
if [ -n "$containers" ]; then
  # shellcheck disable=SC2086 # a list of IDs
  docker rm -f $containers >/dev/null
fi
docker network prune -f >/dev/null
docker volume prune -af >/dev/null
