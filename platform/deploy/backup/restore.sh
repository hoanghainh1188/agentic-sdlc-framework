#!/bin/sh
# Restore of a backup made by backup.sh (task A10 PR 2, design/ADR-M63 §5, runbook T11 section 7).
#
# Usage: platform/deploy/backup/restore.sh <backup folder> <age identity file>   (pnpm restore …)
#
# On a machine with an EMPTY stack (no env file, no volumes of the project): the recovery drill on
# a test machine, or a new server after a loss. It
#   1. checks every file against MANIFEST (SHA-256);
#   2. writes the env file (SDLC_ENV_FILE, default platform/deploy/.env) and OpenBao's TLS folder
#      next to it, from the backup;
#   3. fills the volumes seaweedfs-data, openbao-audit (and clickhouse-data);
#   4. starts PostgreSQL and loads every database;
#   5. starts OpenBao, initialises it with a throw-away key (kept in this process only) and restores
#      the Raft snapshot over it. OpenBao is then SEALED WITH THE ORIGINAL KEYS.
# Then two key holders unseal with their ORIGINAL shares (pnpm openbao:bootstrap unseal), the
# operator delivers the credentials of every process again and starts the rest (runbook T11 §7).
# The age identity (the private key) stays offline with the key shares; it is read, never copied.
# Prints no secret.
set -eu

deploy_dir="$(cd "$(dirname "$0")/.." && pwd)"
env_file="${SDLC_ENV_FILE:-$deploy_dir/.env}"
compose_file="$deploy_dir/docker-compose.yml"

say() { echo "restore: $*"; }
fail() {
  echo "restore: $*" >&2
  exit 1
}

[ "$#" -eq 2 ] || {
  sed -n '2,23p' "$0" | sed 's/^# \{0,1\}//'
  exit 2
}
backup="$(cd "$1" && pwd)" || fail "no folder $1"
identity="$2"
[ -s "$backup/MANIFEST" ] || fail "$backup has no MANIFEST: not a complete backup"
[ -s "$identity" ] || fail "no age identity file $identity"
command -v docker >/dev/null 2>&1 || fail "docker is required"
command -v age >/dev/null 2>&1 || fail "age is required (runbook T11 section 7)"
command -v openssl >/dev/null 2>&1 || fail "openssl is required"
[ -e "$env_file" ] && fail "$env_file exists: restore only into an empty stack (move it away first)"

umask 077
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# 1. Every file is the one the backup wrote (read from a file: no pipe subshell, so fail stops).
grep '^file ' "$backup/MANIFEST" >"$work/files" || fail "MANIFEST lists no file"
while read -r _ name hash size; do
  [ -f "$backup/$name" ] || fail "$name is missing"
  [ "$(openssl dgst -sha256 -r "$backup/$name" | cut -d' ' -f1)" = "$hash" ] || fail "$name: SHA-256 differs from MANIFEST"
  [ "$(wc -c <"$backup/$name" | tr -d ' ')" = "$size" ] || fail "$name: size differs from MANIFEST"
done <"$work/files"
for part in postgres.sql openbao.snap env.tar openbao-tls.tar; do
  grep -q "^file $part.age " "$work/files" || fail "MANIFEST has no $part.age: not a complete backup"
done
say "every file matches MANIFEST"
rm -f "$work/files"

decrypt() { age -d -i "$identity" "$backup/$1.age"; }

# 2. The env file and the TLS folder.
decrypt env.tar | tar -C "$work" -xf - || fail "could not decrypt env.tar (wrong identity?)"
[ "$(ls -A "$work" | wc -l | tr -d ' ')" = 1 ] || fail "env.tar must hold exactly one file"
env_dir="$(cd "$(dirname "$env_file")" && pwd)"
tls_folder="$env_dir/openbao-tls"
[ -e "$tls_folder" ] && fail "$tls_folder exists: restore only into an empty stack"
project="$(sed -n 's/^COMPOSE_PROJECT_NAME=//p' "$work"/* "$work"/.[!.]* 2>/dev/null | tail -n 1)"
project="${project:-sdlc}"
for volume in postgres-data openbao-data seaweedfs-data; do
  docker volume inspect "${project}_$volume" >/dev/null 2>&1 &&
    fail "the volume ${project}_$volume exists: restore only into an empty stack (docker compose … down -v on a test machine)"
done
for f in "$work"/* "$work"/.[!.]*; do [ -f "$f" ] && cp "$f" "$env_file.restore"; done
sed "s|^SDLC_OPENBAO_TLS_DIR=.*|SDLC_OPENBAO_TLS_DIR=$tls_folder|" "$env_file.restore" >"$env_file"
rm -f "$env_file.restore"
chmod 600 "$env_file"
mkdir -m 700 "$tls_folder"
decrypt openbao-tls.tar | tar -C "$tls_folder" -xf - || fail "could not restore the TLS folder"
say "wrote $env_file and $tls_folder (project $project)"

compose() { docker compose -f "$compose_file" --env-file "$env_file" "$@"; }
image="$(sed -n 's/^    image: \(openbao\/openbao:[^ ]*\)$/\1/p' "$compose_file" | head -n 1)"

# 3. The volumes (created by Compose, so they carry its labels).
compose --profile core up --no-start >/dev/null 2>&1 || fail "could not create the containers and volumes"
for name in seaweedfs-data openbao-audit clickhouse-data; do
  [ -f "$backup/volume-$name.tar.age" ] || continue
  docker volume inspect "${project}_$name" >/dev/null 2>&1 ||
    docker volume create --label "com.docker.compose.project=$project" \
      --label "com.docker.compose.volume=$name" "${project}_$name" >/dev/null
  decrypt "volume-$name.tar" |
    docker run --rm -i --network none -v "${project}_$name:/v" --user root --entrypoint tar "$image" -C /v -xf - ||
    fail "could not restore the volume $name"
  say "volume $name: restored"
done

# 4. The databases. The init scripts create the roles and databases on the empty volume; the dump
# drops and recreates them (pg_dumpall --clean --if-exists).
compose --profile core up -d --wait postgres >/dev/null 2>&1 || fail "PostgreSQL did not start"
# The superuser postgres runs the load and exists already: its own DROP and CREATE are left out.
decrypt postgres.sql |
  sed -e '/^DROP ROLE IF EXISTS postgres;$/d' -e '/^CREATE ROLE postgres;$/d' |
  compose exec -T postgres psql -q -v ON_ERROR_STOP=1 -U postgres -d postgres >/dev/null ||
  fail "could not load the databases"
say "databases: restored"

# 5. OpenBao: a throw-away initialisation, then the snapshot over it. The throw-away key and token
# stay in shell variables of this process; the snapshot brings back the original keys.
compose --profile core up -d --wait openbao >/dev/null 2>&1 || fail "OpenBao did not start"
init="$(compose exec -T openbao bao operator init -key-shares=1 -key-threshold=1 -format=json </dev/null)" ||
  fail "OpenBao is not empty: restore only into an empty stack"
temp_key="$(printf '%s' "$init" | tr -d ' \n' | sed -n 's/.*"unseal_keys_b64":\["\([^"]*\)".*/\1/p')"
temp_token="$(printf '%s' "$init" | tr -d ' \n' | sed -n 's/.*"root_token":"\([^"]*\)".*/\1/p')"
init=""
[ -n "$temp_key" ] && [ -n "$temp_token" ] || fail "could not read the throw-away initialisation"
printf '%s' "$temp_key" | compose exec -T openbao bao write sys/unseal key=- >/dev/null ||
  fail "could not unseal with the throw-away key"
temp_key=""
{
  printf '%s\n' "$temp_token"
  decrypt openbao.snap
} | compose exec -T openbao sh -c 'IFS= read -r BAO_TOKEN && export BAO_TOKEN &&
  cat >/tmp/restore.snap && bao operator raft snapshot restore -force /tmp/restore.snap; rc=$?;
  rm -f /tmp/restore.snap; exit $rc' || fail "could not restore the OpenBao snapshot"
temp_token=""
say "OpenBao: snapshot restored; it is sealed with the ORIGINAL keys"

cat <<'EOF'
restore: next (runbook T11 section 7):
  1. Two key holders unseal with their ORIGINAL shares: pnpm openbao:bootstrap unseal
  2. Deliver the credentials of every process again (platform/deploy/README.md, Fresh deployment
     step 5; their volumes are not in the backup), then start the rest: platform/deploy/scripts/up.sh core models platform sandbox
  3. Check: pnpm sdlc ops audit verify, curl -s http://127.0.0.1:8090/health/ready
EOF
