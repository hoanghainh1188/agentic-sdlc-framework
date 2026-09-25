#!/bin/sh
# Applies the OpenBao configuration (task A03, design/ADR-M19). Safe to run again: it creates
# what is missing, re-applies policies and roles from this folder, and never deletes, rotates or
# re-creates keys, mounts or roles.
#
# Runs INSIDE the openbao container. Called by platform/deploy/openbao/bootstrap.sh configure.
#
# Usage: configure.sh <secret-id-bound-cidrs> [--keep-token]
#   stdin: one line with a root token. Never an argument or environment variable of the caller.
#   --keep-token  do not revoke the token at the end (default: revoke it, D-03 section 10.2)
set -eu

dir=/openbao/bootstrap
settings="$dir/bootstrap.conf"

say() { echo "configure: $*"; }
fail() {
  echo "configure: $*" >&2
  exit 1
}
setting() {
  value="$(sed -n "s/^$1=//p" "$settings" | tail -n 1)"
  [ -n "$value" ] || fail "setting $1 missing in bootstrap.conf"
  printf '%s' "$value"
}

[ "$#" -ge 1 ] || fail "usage: configure.sh <secret-id-bound-cidrs> [--keep-token]"
cidrs="$1"
keep_token=no
[ "${2:-}" = --keep-token ] && keep_token=yes

IFS= read -r BAO_TOKEN || true
[ -n "${BAO_TOKEN:-}" ] || fail "no token on stdin"
export BAO_TOKEN

policies="$(bao read -field=policies auth/token/lookup-self 2>/dev/null)" ||
  fail "the token is not valid (expired, revoked or mistyped)"
case "$policies" in
  *root*) ;;
  *) fail "a root token is required (see runbook T11 section 5: bootstrap.sh root-token)" ;;
esac

transit_key="$(setting TRANSIT_KEY)"
transit_type="$(setting TRANSIT_KEY_TYPE)"
roles="$(setting APPROLE_ROLES)"
token_ttl="$(setting APPROLE_TOKEN_TTL)"
token_max_ttl="$(setting APPROLE_TOKEN_MAX_TTL)"
secret_id_ttl="$(setting APPROLE_SECRET_ID_TTL)"
admin_max_ttl="$(setting ADMIN_TOKEN_MAX_TTL)"

# --- Audit: the file device is declared in openbao.hcl; refuse to go on without it. ----------
bao audit list -format=json | grep -q '"type": "file"' ||
  fail "no file audit device; check the audit block in openbao.hcl"
say "audit device: file (openbao.hcl)"

# --- Secrets engines ----------------------------------------------------------------------
# ensure_mount <path> <type> <expected options or ->
ensure_mount() {
  if bao read sys/mounts/"$1" >/dev/null 2>&1; then
    type="$(bao read -field=type sys/mounts/"$1")"
    [ "$type" = "$2" ] || fail "mount $1/ exists with type $type, expected $2; not changed"
    say "mount $1/ ($2) already exists"
  else
    case "$2" in
      kv) bao secrets enable -path="$1" -version=2 kv >/dev/null ;;
      *) bao secrets enable -path="$1" "$2" >/dev/null ;;
    esac
    say "mount $1/ ($2) enabled"
  fi
}
ensure_mount kv kv
options="$(bao read -field=options sys/mounts/kv)"
case "$options" in
  *version:2*) ;;
  *) fail "mount kv/ is not KV version 2 ($options); not changed" ;;
esac
ensure_mount transit transit

# --- Transit key for Run Contracts ---------------------------------------------------------
key_path="transit/keys/$transit_key"
if bao read "$key_path" >/dev/null 2>&1; then
  say "transit key $transit_key already exists; not changed"
else
  bao write -f "$key_path" type="$transit_type" exportable=false allow_plaintext_backup=false >/dev/null
  say "transit key $transit_key ($transit_type) created"
fi
[ "$(bao read -field=type "$key_path")" = "$transit_type" ] ||
  fail "transit key $transit_key is not $transit_type"
[ "$(bao read -field=exportable "$key_path")" = false ] ||
  fail "transit key $transit_key is exportable"
[ "$(bao read -field=allow_plaintext_backup "$key_path")" = false ] ||
  fail "transit key $transit_key allows plaintext backup"
[ "$(bao read -field=deletion_allowed "$key_path")" = false ] ||
  fail "transit key $transit_key allows deletion"

# --- Policies (the files in policies/ are the source of truth) -------------------------------
for file in "$dir"/policies/*.hcl; do
  name="$(basename "$file" .hcl)"
  bao policy write "$name" "$file" >/dev/null
  say "policy $name written"
done

# --- AppRole login ---------------------------------------------------------------------------
if bao read sys/auth/approle >/dev/null 2>&1; then
  say "auth approle/ already enabled"
else
  bao auth enable approle >/dev/null
  say "auth approle/ enabled"
fi

# Writing a role again keeps its role_id and the secret IDs already issued.
for role in $roles; do
  [ -f "$dir/policies/$role.hcl" ] || fail "no policy file policies/$role.hcl for AppRole $role"
  bao write auth/approle/role/"$role" \
    token_policies="$role" \
    token_type=service \
    token_ttl="$token_ttl" \
    token_max_ttl="$token_max_ttl" \
    secret_id_ttl="$secret_id_ttl" \
    secret_id_num_uses=0 \
    secret_id_bound_cidrs="$cidrs" \
    bind_secret_id=true >/dev/null
  say "approle $role written (secret IDs bound to $cidrs)"
done

# --- Token role for daily admin work ----------------------------------------------------------
bao write auth/token/roles/platform-admin \
  allowed_policies=platform-admin \
  orphan=true \
  renewable=false \
  token_explicit_max_ttl="$admin_max_ttl" >/dev/null
say "token role platform-admin written (max $admin_max_ttl)"

# --- Root token: revoke after use (D-03 section 10.2) -------------------------------------------
if [ "$keep_token" = yes ]; then
  say "done; the token was NOT revoked (--keep-token). Revoke it as soon as you finish"
else
  bao token revoke -self >/dev/null
  say "done; the root token is revoked"
fi
