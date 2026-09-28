#!/bin/sh
# Runner hook after every job (design/ADR-M34 §2.3). Best effort: the next job-started hook
# cleans again and fails the job if Docker is unusable.
here=$(dirname "$0")
sh "$here/clean-docker.sh" || echo "ci-runner: clean-up after the job failed" >&2
exit 0
