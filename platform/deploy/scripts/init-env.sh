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
# - OpenBao's TLS (A10, design/ADR-M63): a throw-away CA and server certificate in openbao-tls/
#   next to the output file, made by openbao/tls.sh dev (the CA key is deleted at once). The
#   server replaces them with the company CA's certificate (runbook T11 section 3c).
set -eu

deploy_dir="$(cd "$(dirname "$0")/.." && pwd)"
template="$deploy_dir/.env.example"
output="${1:-$deploy_dir/.env}"

if [ -e "$output" ]; then
  echo "init-env: $output already exists; not overwriting. Delete it first to regenerate." >&2
  exit 1
fi
command -v openssl >/dev/null 2>&1 || { echo "init-env: openssl is required" >&2; exit 1; }
case "$(openssl version 2>/dev/null)" in
  'OpenSSL '[3-9]*) ;;
  *) echo "init-env: OpenSSL 3 or later is required, not LibreSSL (platform/deploy/README.md, Requirements)" >&2; exit 1 ;;
esac

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

# Group of the Docker socket, for the socket proxy of the profile "sandbox" (design/ADR-M25 §2.5).
# Linux: the group of /var/run/docker.sock. Docker Desktop: the socket inside its VM is root:root.
docker_gid() {
  if [ "$(uname -s)" = Linux ] && [ -S /var/run/docker.sock ]; then
    stat -c %g /var/run/docker.sock
  else
    echo 0
  fi
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
    SDLC_DOCKER_GID=) printf 'SDLC_DOCKER_GID=%s\n' "$(docker_gid)" >>"$tmp" ;;
    *) printf '%s\n' "$line" >>"$tmp" ;;
  esac
done <"$template"

chmod 600 "$tmp"
mv "$tmp" "$output"
trap - EXIT
echo "init-env: wrote $output (mode 600). Secrets are not printed."
"$deploy_dir/openbao/tls.sh" dev "$output"
