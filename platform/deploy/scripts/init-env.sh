#!/bin/sh
# Creates platform/deploy/.env from .env.example with random secrets (task A02).
#
# Usage: platform/deploy/scripts/init-env.sh [output-file]
#        platform/deploy/scripts/init-env.sh --add-missing [output-file]
#   output-file  default: platform/deploy/.env
#
# --add-missing (the upgrade, O02, QUESTIONS #582): the output file must exist. Appends every key of
# .env.example that it lacks (a CHANGEME value replaced as below) and prints the names of the added
# keys. A line that is there is never changed or removed. No TLS step.
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
mode=create
if [ "${1:-}" = --add-missing ]; then
  mode=add
  shift
fi
output="${1:-$deploy_dir/.env}"

if [ "$mode" = add ] && [ ! -f "$output" ]; then
  echo "init-env: $output does not exist; run it without --add-missing first." >&2
  exit 1
fi
if [ "$mode" = create ] && [ -e "$output" ]; then
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

# One line of the template, as it goes into the output file.
render() {
  case "$1" in
    *=CHANGEME)
      key="${1%%=*}"
      printf '%s=%s\n' "$key" "$(value_for "$key")"
      ;;
    SDLC_DOCKER_GID=) printf 'SDLC_DOCKER_GID=%s\n' "$(docker_gid)" ;;
    *) printf '%s\n' "$1" ;;
  esac
}

umask 077
tmp="$(mktemp "$output.XXXXXX")"
trap 'rm -f "$tmp"' EXIT

if [ "$mode" = add ]; then
  cat "$output" >"$tmp"
  # A last line without its newline would run into the first added key.
  [ -z "$(tail -c 1 "$output")" ] || echo >>"$tmp"
  added=""
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
      [A-Z]*=*) key="${line%%=*}" ;;
      *) continue ;;
    esac
    grep -q "^$key=" "$output" && continue
    if [ -z "$added" ]; then
      printf '\n# Added by init-env.sh --add-missing on %s (keys new in .env.example).\n' "$(date -u +%Y-%m-%d)" >>"$tmp"
    fi
    render "$line" >>"$tmp"
    added="$added $key"
  done <"$template"
  if [ -z "$added" ]; then
    echo "init-env: $output has every key of .env.example; nothing added."
    exit 0
  fi
  chmod 600 "$tmp"
  mv "$tmp" "$output"
  trap - EXIT
  echo "init-env: added to $output (mode 600):$added. Secrets are not printed."
  exit 0
fi

while IFS= read -r line || [ -n "$line" ]; do
  render "$line" >>"$tmp"
done <"$template"

chmod 600 "$tmp"
mv "$tmp" "$output"
trap - EXIT
echo "init-env: wrote $output (mode 600). Secrets are not printed."
"$deploy_dir/openbao/tls.sh" dev "$output"
