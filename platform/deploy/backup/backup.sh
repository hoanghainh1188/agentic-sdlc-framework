#!/bin/sh
# Backup of the whole platform (task A10 PR 2, design/ADR-M63 §5, runbook T11 section 6).
#
# Usage: platform/deploy/backup/backup.sh        (pnpm backup)
#
# Writes one folder <SDLC_BACKUP_DIR>/<UTC time>/ with:
#   postgres.sql.age          every database (pg_dumpall), online
#   openbao.snap.age          OpenBao's Raft snapshot, through the AppRole "backup" (backup-agent)
#   volume-<name>.tar.age     seaweedfs-data, openbao-audit and clickhouse-data (when it exists);
#                             SeaweedFS and ClickHouse are stopped for the copy, then started again
#   env.tar.age               the Compose env file (passwords, keys: needed to restore)
#   openbao-tls.tar.age       OpenBao's TLS folder
#   MANIFEST                  SHA-256 and size of every file, the commit, the images; no secret
# Every part is encrypted with age (public key only: the server cannot read its own backups) as it
# streams: no unencrypted copy touches a disk. The folder appears only when every part is done.
# Keeps the newest SDLC_BACKUP_KEEP folders (default 14). Prints no secret.
#
# Settings in the env file: SDLC_BACKUP_DIR (an absolute folder outside the repository, for example
# a mounted NAS), SDLC_BACKUP_AGE_RECIPIENTS (a file with the age public key(s)), SDLC_BACKUP_KEEP.
# Environment: SDLC_ENV_FILE (default: platform/deploy/.env).
set -eu

deploy_dir="$(cd "$(dirname "$0")/.." && pwd)"
repo_dir="$(cd "$deploy_dir" && cd ../.. && pwd)"
env_file="${SDLC_ENV_FILE:-$deploy_dir/.env}"
compose_file="$deploy_dir/docker-compose.yml"

say() { echo "backup: $*"; }
fail() {
  echo "backup: $*" >&2
  exit 1
}

[ "${1:-}" = "" ] || {
  sed -n '2,25p' "$0" | sed 's/^# \{0,1\}//'
  [ "$1" = -h ] || [ "$1" = --help ] || exit 2
  exit 0
}

[ -f "$env_file" ] || fail "$env_file not found"
command -v docker >/dev/null 2>&1 || fail "docker is required"
command -v age >/dev/null 2>&1 || fail "age is required (runbook T11 section 6)"
command -v openssl >/dev/null 2>&1 || fail "openssl is required"

value() { sed -n "s/^$1=//p" "$env_file" | tail -n 1; }
project="$(value COMPOSE_PROJECT_NAME)"
project="${project:-sdlc}"
target="$(value SDLC_BACKUP_DIR)"
recipients="$(value SDLC_BACKUP_AGE_RECIPIENTS)"
keep="$(value SDLC_BACKUP_KEEP)"
keep="${keep:-14}"
tls_folder="$(value SDLC_OPENBAO_TLS_DIR)"

case "$target" in
  /*) ;;
  '') fail "SDLC_BACKUP_DIR is not set in $env_file (runbook T11 section 6)" ;;
  *) fail "SDLC_BACKUP_DIR must be an absolute path" ;;
esac
case "$target/" in "$repo_dir"/*) fail "SDLC_BACKUP_DIR must be outside the repository" ;; esac
[ -d "$target" ] && [ -w "$target" ] || fail "SDLC_BACKUP_DIR $target is not a writable folder"
[ -s "$recipients" ] || fail "SDLC_BACKUP_AGE_RECIPIENTS does not name a file with an age public key"
grep -q '^age1' "$recipients" || fail "$recipients holds no age public key (age1…)"
case "$keep" in '' | *[!0-9]* | 0) fail "SDLC_BACKUP_KEEP must be a whole number of 1 or more" ;; esac
[ -n "$tls_folder" ] && [ -d "$tls_folder" ] || fail "SDLC_OPENBAO_TLS_DIR is not a folder"

compose() { docker compose -f "$compose_file" --env-file "$env_file" "$@"; }
image="$(sed -n 's/^    image: \(openbao\/openbao:[^ ]*\)$/\1/p' "$compose_file" | head -n 1)"
[ -n "$image" ] || fail "no openbao image in $compose_file"

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
out="$target/$stamp"
partial="$out.partial"
[ -e "$out" ] || [ -e "$partial" ] && fail "$out exists already"
umask 077
mkdir "$partial"
work="$(mktemp -d)"
stopped=""

cleanup() {
  status=$?
  # Services stopped for the volume copy start again, whatever happened.
  # shellcheck disable=SC2086
  [ -z "$stopped" ] || compose --profile core --profile observability start $stopped >/dev/null 2>&1 || true
  rm -rf "$work"
  [ -d "$partial" ] && rm -rf "$partial"
  [ "$status" -eq 0 ] || echo "backup: FAILED; no backup folder was written" >&2
}
trap cleanup EXIT
trap 'exit 130' INT TERM

# encrypt <file name> <command…>: the command's stdout, encrypted to <partial>/<file name>.age.
# A failure of the command or of age fails the backup (POSIX sh has no pipefail: a marker file).
encrypt() {
  name="$1"
  shift
  { "$@" || : >"$work/$name.failed"; } | age -R "$recipients" -o "$partial/$name.age" ||
    fail "could not encrypt $name"
  [ ! -e "$work/$name.failed" ] || fail "could not read $name"
  [ -s "$partial/$name.age" ] || fail "$name is empty"
}

volume_exists() { docker volume inspect "${project}_$1" >/dev/null 2>&1; }
tar_volume() {
  docker run --rm --network none -v "${project}_$1:/v:ro" --user root --entrypoint tar "$image" -C /v -cf - .
}
running() { compose --profile core --profile observability ps --status running --services 2>/dev/null | grep -qx "$1"; }

say "writing $out"
encrypt postgres.sql compose exec -T postgres pg_dumpall -U postgres --clean --if-exists
say "databases: done"
encrypt openbao.snap compose --profile core --profile backup run --rm -T --no-deps backup-agent
say "OpenBao snapshot: done"
encrypt env.tar tar -C "$(dirname "$env_file")" -cf - "$(basename "$env_file")"
encrypt openbao-tls.tar tar -C "$tls_folder" -cf - .

# Volumes: stop the services that write to them, copy, start them again (QUESTIONS #329).
for service in seaweedfs clickhouse; do
  if running "$service"; then
    stopped="$stopped $service"
  fi
done
if [ -n "$stopped" ]; then
  say "stopping$stopped for the volume copy"
  # shellcheck disable=SC2086
  compose --profile core --profile observability stop $stopped >/dev/null 2>&1 || fail "could not stop$stopped"
fi
for volume in seaweedfs-data openbao-audit clickhouse-data; do
  volume_exists "$volume" || continue
  encrypt "volume-$volume.tar" tar_volume "$volume"
  say "volume $volume: done"
done
if [ -n "$stopped" ]; then
  # shellcheck disable=SC2086
  compose --profile core --profile observability up -d --wait --no-deps $stopped >/dev/null 2>&1 ||
    fail "could not start$stopped again (healthy)"
  say "started$stopped again"
  stopped=""
fi

# The manifest: what a restore checks first. Names, hashes, sizes, versions; never a secret.
{
  echo "backup $stamp"
  echo "project $project"
  echo "commit $(git -C "$repo_dir" rev-parse HEAD 2>/dev/null || echo unknown)"
  sed -n 's/^    image: \([^ ]*\)$/image \1/p' "$compose_file" | sort -u
  for file in "$partial"/*.age; do
    name="$(basename "$file")"
    hash="$(openssl dgst -sha256 -r "$file" | cut -d' ' -f1)"
    size="$(wc -c <"$file" | tr -d ' ')"
    echo "file $name $hash $size"
  done
} >"$partial/MANIFEST"
mv "$partial" "$out"
say "done: $out ($(ls "$out" | wc -l | tr -d ' ') files)"

# Keep the newest SDLC_BACKUP_KEEP complete backups.
ls -1 "$target" | grep -E '^[0-9]{8}T[0-9]{6}Z$' | sort -r | tail -n +"$((keep + 1))" |
  while IFS= read -r old; do
    rm -rf "${target:?}/$old"
    say "removed the old backup $old (SDLC_BACKUP_KEEP=$keep)"
  done
