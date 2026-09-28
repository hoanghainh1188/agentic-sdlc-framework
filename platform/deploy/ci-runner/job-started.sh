#!/bin/sh
# Runner hook before every job (design/ADR-M34 §2.3). A failure here fails the job: better than
# running on a Docker that is down or still holds another job's containers.
set -eu

here=$(dirname "$0")
docker info >/dev/null
sh "$here/clean-docker.sh"

# Less than 10 GiB free on /: remove unused images and build cache now, not at the daily prune.
avail_kib=$(df --output=avail -k / | tail -n 1 | tr -d ' ')
if [ "$avail_kib" -lt 10485760 ]; then
  echo "ci-runner: low disk ($((avail_kib / 1048576)) GiB free), pruning images and build cache"
  docker system prune -af >/dev/null
  docker builder prune -af >/dev/null
fi
