#!/bin/sh
# Start SeaweedFS with JWT signing keys made at this start (task A12, design/ADR-M52).
#
# The master, volume and filer listen on 127.0.0.1 only (flags in docker-compose.yml); the S3 API
# (8333) is the only way in from the network. The S3 gateway's gRPC port (18333) cannot be bound
# to loopback in SeaweedFS 4.48, so the filer key below is what refuses its unauthenticated IAM
# calls (QUESTIONS #245). The volume and filer read keys are defence in depth.
#
# Four random keys go to /etc/seaweedfs/security.toml (mode 600, owner seaweed: the image's
# entrypoint drops to that user). Only SeaweedFS itself uses them: every component runs in this one
# process, and `docker compose exec seaweedfs weed shell` reads the same file. They are new at every
# start and kept nowhere else (QUESTIONS #246). Never print them.
#
# Fails closed: if any key cannot be made or written, or the file has the wrong owner or mode, the
# script exits non-zero and SeaweedFS does not start.
set -eu

SECURITY_FILE="${SEAWEEDFS_SECURITY_FILE:-/etc/seaweedfs/security.toml}"
SEAWEED_USER=seaweed

fail() {
  echo "seaweedfs-start: $*" >&2
  exit 1
}

[ "$(id -u)" = 0 ] || fail "must start as root (the image's entrypoint drops privileges)"
[ -r /dev/urandom ] || fail "/dev/urandom is not readable"

# 32 random bytes as 64 hex characters.
new_key() {
  key="$(head -c 32 /dev/urandom | od -An -v -tx1 | tr -d ' \n')" || return 1
  [ "${#key}" -eq 64 ] || return 1
  printf '%s' "$key"
}

filer_key="$(new_key)" || fail "could not make the filer signing key"
filer_read_key="$(new_key)" || fail "could not make the filer read key"
volume_key="$(new_key)" || fail "could not make the volume signing key"
volume_read_key="$(new_key)" || fail "could not make the volume read key"

dir="$(dirname "$SECURITY_FILE")"
tmp="$dir/.security.toml.$$"
umask 077
# Old temporary files of an interrupted start, and this one on any exit before the move.
rm -f "$dir"/.security.toml.*
trap 'rm -f "$tmp"' EXIT INT TERM
{
  printf '[jwt.signing]\nkey = "%s"\n\n' "$volume_key"
  printf '[jwt.signing.read]\nkey = "%s"\n\n' "$volume_read_key"
  printf '[jwt.filer_signing]\nkey = "%s"\n\n' "$filer_key"
  printf '[jwt.filer_signing.read]\nkey = "%s"\n' "$filer_read_key"
} >"$tmp" || { rm -f "$tmp"; fail "could not write $SECURITY_FILE"; }
unset filer_key filer_read_key volume_key volume_read_key key
chown "$SEAWEED_USER:$SEAWEED_USER" "$tmp" || { rm -f "$tmp"; fail "could not set the owner of $SECURITY_FILE"; }
chmod 600 "$tmp" || { rm -f "$tmp"; fail "could not set the mode of $SECURITY_FILE"; }
mv -f "$tmp" "$SECURITY_FILE" || { rm -f "$tmp"; fail "could not move $SECURITY_FILE into place"; }

# Check the result before SeaweedFS starts: four keys, mode 600, owner seaweed.
[ "$(stat -c '%a %U %G' "$SECURITY_FILE")" = "600 $SEAWEED_USER $SEAWEED_USER" ] ||
  fail "$SECURITY_FILE has the wrong mode, owner or group"
[ "$(grep -c '^key = "[0-9a-f]\{64\}"$' "$SECURITY_FILE")" -eq 4 ] ||
  fail "$SECURITY_FILE does not hold four keys"

trap - EXIT INT TERM
exec /entrypoint.sh "$@"
