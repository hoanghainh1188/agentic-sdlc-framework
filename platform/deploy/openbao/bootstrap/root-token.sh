#!/bin/sh
# Creates a new root token from unseal key shares (task A03, runbook T11 section 5).
# Runs INSIDE the openbao container. Called by platform/deploy/openbao/bootstrap.sh root-token.
#
# Usage: root-token.sh
#   stdin: one key share per line (as many as the unseal threshold).
#   stdout: the new root token, once. Nothing is written to disk.
#
# Uses the key-share endpoints sys/generate-root/* (no token needed), which only the key-holder
# listener 127.0.0.1:8210 accepts (openbao.hcl). Shares reach bao on stdin ("key=-"), never as
# command-line arguments.
set -eu

export BAO_ADDR=http://127.0.0.1:8210
unset BAO_TOKEN

fail() {
  echo "root-token: $*" >&2
  exit 1
}

[ "$(bao read -field=started sys/generate-root/attempt)" = false ] ||
  fail "a root token generation is already in progress; cancel it first (runbook T11 section 9)"

# One-time password: base62 random of the length the server asks for (what
# "bao operator generate-root -generate-otp" does; that flag needs a token in OpenBao 2.5+).
otp_length="$(bao read -field=otp_length sys/generate-root/attempt)"
otp="$(tr -dc 'A-Za-z0-9' </dev/urandom | head -c "$otp_length")"
[ "${#otp}" -eq "$otp_length" ] || fail "could not create a one-time password"
nonce="$(bao write -field=nonce sys/generate-root/attempt otp="$otp")"
[ -n "$nonce" ] || fail "could not start root token generation"
# Cancel the attempt if anything below fails, so no half-finished attempt stays open.
trap 'bao delete sys/generate-root/attempt >/dev/null 2>&1 || true' EXIT

encoded=""
while IFS= read -r share; do
  [ -n "$share" ] || continue
  out="$(printf '%s' "$share" | bao write -format=json sys/generate-root/update key=- nonce="$nonce" 2>/dev/null)" ||
    fail "a key share was rejected"
  encoded="$(printf '%s\n' "$out" | sed -n 's/^ *"encoded_token": "\([^"]*\)".*/\1/p')"
  [ -n "$encoded" ] && break
done
[ -n "$encoded" ] || fail "not enough key shares"
# OpenBao returns unpadded base64; busybox base64 needs the padding.
while [ $((${#encoded} % 4)) -ne 0 ]; do encoded="$encoded="; done

trap - EXIT
# Decode: the encoded token is base64(token XOR otp). Done here because
# "bao operator generate-root -decode" also needs a token in OpenBao 2.5+.
token="$(
  {
    printf '%s' "$otp" | od -An -v -tu1
    echo -
    printf '%s' "$encoded" | base64 -d | od -An -v -tu1
  } | awk '
    $1 == "-" { second = 1; next }
    { for (i = 1; i <= NF; i++) if (second) enc[m++] = $i; else key[n++] = $i }
    END { for (i = 0; i < m; i++) printf "%c", xor(enc[i], key[i]) }'
)"
[ -n "$token" ] || fail "could not decode the new root token"
printf '%s\n' "$token"
