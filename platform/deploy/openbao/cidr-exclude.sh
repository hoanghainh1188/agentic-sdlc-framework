#!/bin/sh
# Prints an IPv4 subnet minus one address, as a comma-separated list of CIDR blocks (task A11,
# design/QUESTIONS.md #37, ADR-M19 section 2.5). bootstrap.sh uses it to bind AppRole secret IDs
# and tokens to the Compose network WITHOUT its gateway: on a Linux host, every host process
# reaches containers from the gateway address.
#
# Usage: cidr-exclude.sh <subnet/prefix> <address>
# Example: cidr-exclude.sh 172.30.0.0/24 172.30.0.1
#   → 172.30.0.0/32,172.30.0.2/31,172.30.0.4/30,172.30.0.8/29,172.30.0.16/28,172.30.0.32/27,
#     172.30.0.64/26,172.30.0.128/25
set -eu

fail() {
  printf 'cidr-exclude: %s\n' "$*" >&2
  exit 1
}

# Dotted quad → integer. Fails on anything that is not four numbers 0–255.
to_int() {
  case "$1" in
    *[!0-9.]* | *..* | .* | *.) fail "not an IPv4 address: $1" ;;
  esac
  old_ifs="$IFS"
  IFS=.
  # shellcheck disable=SC2086 # split on dots on purpose
  set -- $1
  IFS="$old_ifs"
  [ "$#" -eq 4 ] || fail "not an IPv4 address"
  value=0
  for octet in "$@"; do
    [ -n "$octet" ] && [ "$octet" -le 255 ] || fail "not an IPv4 address"
    value=$((value * 256 + octet))
  done
  printf '%s' "$value"
}

to_quad() {
  printf '%s.%s.%s.%s' $(($1 >> 24 & 255)) $(($1 >> 16 & 255)) $(($1 >> 8 & 255)) $(($1 & 255))
}

[ "$#" -eq 2 ] || fail "usage: cidr-exclude.sh <subnet/prefix> <address>"
case "$1" in
  */*) ;;
  *) fail "subnet needs a prefix length: $1" ;;
esac
prefix="${1#*/}"
case "$prefix" in
  '' | *[!0-9]*) fail "bad prefix length: $1" ;;
esac
[ "$prefix" -ge 1 ] && [ "$prefix" -le 31 ] || fail "prefix length must be 1 to 31: $1"

base="$(to_int "${1%/*}")"
address="$(to_int "$2")"
size=$((1 << (32 - prefix)))
[ $((base % size)) -eq 0 ] || fail "subnet has host bits set: $1"
[ "$address" -ge "$base" ] && [ "$address" -lt $((base + size)) ] ||
  fail "$2 is not inside $1"

# For each prefix length from /32 up to /(prefix+1), the sibling block of the one holding the
# address is fully outside the address and inside the subnet. Together they cover the rest.
out=""
bits=32
while [ "$bits" -gt "$prefix" ]; do
  block=$((1 << (32 - bits)))
  sibling=$(((address / block) * block ^ block))
  out="${out:+$out,}$(to_quad "$sibling")/$bits"
  bits=$((bits - 1))
done
printf '%s\n' "$out"
