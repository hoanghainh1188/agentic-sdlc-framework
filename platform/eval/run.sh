#!/bin/sh
# `pnpm eval` (task L02, design/ADR-M78 §2.2). Developer machines only, never in CI.
#
# Usage: pnpm eval --out <folder outside the repo> [--config <file>] [--configurations a,b]
#                  [--tasks t1,t2] [--n <runs>] [--tasks-dir <folder>]
#        pnpm eval --check [--tasks t1,t2] [--tasks-dir <folder>]
# Results: one JSON file per run under --out; numbers and codes only. A stopped evaluation
# continues where it stopped (existing results are skipped).
set -eu
repo_root="$(cd "$(dirname "$0")/../.." && pwd)"
SDLC_EVAL_MODE=evaluate
while [ $# -gt 0 ]; do
  case "$1" in
    --out) SDLC_EVAL_OUT="$2"; export SDLC_EVAL_OUT; shift 2 ;;
    --config) SDLC_EVAL_CONFIG="$2"; export SDLC_EVAL_CONFIG; shift 2 ;;
    --configurations) SDLC_EVAL_CONFIGURATIONS="$2"; export SDLC_EVAL_CONFIGURATIONS; shift 2 ;;
    --tasks) SDLC_EVAL_TASKS="$2"; export SDLC_EVAL_TASKS; shift 2 ;;
    --tasks-dir) SDLC_EVAL_TASKS_DIR="$2"; export SDLC_EVAL_TASKS_DIR; shift 2 ;;
    --n) SDLC_EVAL_N="$2"; export SDLC_EVAL_N; shift 2 ;;
    --check) SDLC_EVAL_MODE=check; shift ;;
    *) echo "eval: unknown option $1 (see platform/eval/run.sh)" >&2; exit 2 ;;
  esac
done
if [ "$SDLC_EVAL_MODE" = evaluate ] && [ -z "${SDLC_EVAL_OUT:-}" ]; then
  echo "eval: --out <folder outside the repo> is required" >&2
  exit 2
fi
export SDLC_EVAL=1 SDLC_EVAL_MODE
export SDLC_TEST_DB_DIR=platform/tests/integration/eval/eval-run.test.ts
cd "$repo_root"
exec platform/deploy/scripts/test-db.sh
