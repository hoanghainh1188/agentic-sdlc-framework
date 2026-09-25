#!/bin/sh
# Creates platform/deploy/.env from .env.example with random secrets (task A02).
#
# Usage: platform/deploy/scripts/init-env.sh [output-file]
#   output-file  default: platform/deploy/.env
#
# - Every CHANGEME value is replaced with a random value of the right format.
# - The output file gets mode 600 (owner read/write only).
# - An existing output file is never overwritten.
# - Secrets are never printed. Read them from the file when you need them
#   (for example the Langfuse admin password).
set -eu

deploy_dir="$(cd "$(dirname "$0")/.." && pwd)"
template="$deploy_dir/.env.example"
output="${1:-$deploy_dir/.env}"

if [ -e "$output" ]; then
  echo "init-env: $output already exists; not overwriting. Delete it first to regenerate." >&2
  exit 1
fi
command -v openssl >/dev/null 2>&1 || { echo "init-env: openssl is required" >&2; exit 1; }

hex() { openssl rand -hex "$1"; }

value_for() {
  case "$1" in
    LITELLM_MASTER_KEY) echo "sk-$(hex 24)" ;;
    LANGFUSE_INIT_PROJECT_PUBLIC_KEY) echo "pk-lf-$(hex 16)" ;;
    LANGFUSE_INIT_PROJECT_SECRET_KEY) echo "sk-lf-$(hex 24)" ;;
    LANGFUSE_ENCRYPTION_KEY) echo "$(hex 32)" ;;
    SEAWEEDFS_S3_ACCESS_KEY) echo "sdlc$(hex 8)" ;;
    *) echo "$(hex 24)" ;;
  esac
}

umask 077
tmp="$(mktemp "$output.XXXXXX")"
trap 'rm -f "$tmp"' EXIT

while IFS= read -r line || [ -n "$line" ]; do
  case "$line" in
    *=CHANGEME)
      key="${line%%=*}"
      printf '%s=%s\n' "$key" "$(value_for "$key")" >>"$tmp"
      ;;
    *) printf '%s\n' "$line" >>"$tmp" ;;
  esac
done <"$template"

chmod 600 "$tmp"
mv "$tmp" "$output"
trap - EXIT
echo "init-env: wrote $output (mode 600). Secrets are not printed."
