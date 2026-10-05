#!/bin/sh
# OpenBao bootstrap (task A03, design/ADR-M19). Procedure and custody rules:
# handbook/03-templates/T11-openbao-runbook.md.
#
# Runs on the host and uses the bao command inside the Compose "openbao" container, so the host
# needs only Docker. Key shares and tokens are read from a hidden prompt (or stdin when stdin is
# not a terminal), passed to the container on stdin, and never written to a file, a command
# line or an environment variable of the host.
#
# Environment:
#   SDLC_ENV_FILE  Compose env file (default: platform/deploy/.env)
set -eu

deploy_dir="$(cd "$(dirname "$0")/.." && pwd)"
settings="$deploy_dir/openbao/bootstrap/bootstrap.conf"
in_container=/openbao/bootstrap

usage() {
  cat <<'EOF'
Usage: platform/deploy/openbao/bootstrap.sh <command> [options]

Commands:
  status               Show whether OpenBao is uninitialised, sealed or unsealed.
  init                 Initialise OpenBao once. Prints the key shares and the first root
                       token ONE time, to the terminal only. Refuses when output is not a
                       terminal and when OpenBao is already initialised.
  unseal               Ask for key shares (hidden) until OpenBao is unsealed.
  configure [--keep-token]
                       Ask for a root token (hidden) and apply the configuration: KV v2,
                       Transit key, policies, AppRoles, admin token role. Safe to run again.
                       Revokes the root token at the end unless --keep-token is given.
  root-token           Ask for key shares (hidden) and create a new root token. Prints it
                       ONE time, to the terminal only. Revoke it after use.
  litellm-credentials  Ask for an admin token (hidden), issue a new secret ID for the AppRole
                       "litellm" and write it with the role ID into the volume of the LiteLLM
                       sidecar (Compose profile "models"). Prints no secret. Run it again to
                       rotate the secret ID, then restart litellm-agent (runbook T11).
  api-credentials      Ask for an admin token (hidden). Store the platform_app database password
                       (PLATFORM_APP_DB_PASSWORD from the env file) at kv/api/database, issue a
                       new secret ID for the AppRole "api" and write it with the role ID into the
                       volume of sdlc-api (Compose profile "platform"). Prints no secret. Run it
                       again to rotate, then restart sdlc-api (runbook T11).
  worker-credentials   The same for the worker: kv/worker/database, AppRole "worker", volume of
                       sdlc-worker. Also the AppRole "cost-controller" into the volume
                       worker-cost-approle: the worker runs the Cost Controller (C06, ADR-M33).
                       Run it again to rotate, then restart sdlc-worker (runbook T11).
  runner-credentials   The same for the runner: kv/runner/database, AppRole "runner", volume of
                       sdlc-runner (Compose profile "sandbox"). Run it again to rotate, then
                       restart sdlc-runner (runbook T11 §5g).
  runner-evidence-credentials
                       Ask for an admin token (hidden). Create a new SeaweedFS key pair for the
                       runner's L1 proposals and run diffs, store it at kv/runner/evidence and
                       apply it to SeaweedFS as the identity "runner-evidence", limited to
                       Write:evidence/proposals/*, Write:evidence/diffs/* and Read:evidence/diffs/*
                       (C06, ADR-M33 §2.9; C07, ADR-M34 §2.2; C08, ADR-M38 §2.2: the push reads
                       the checked diff back). The old key stops working.
                       Prints no secret. Run it again to rotate, then restart sdlc-runner.
  api-evidence-credentials
                       Ask for an admin token (hidden). Create a new SeaweedFS key pair for the
                       api's Evidence Packs, store it at kv/api/evidence and apply it to SeaweedFS
                       as the identity "api-evidence", limited to Read:evidence/proposals/*,
                       Read:evidence/diffs/* (the hash re-check), Read:evidence/packs/* and
                       Write:evidence/packs/* (E02, ADR-M48). The old key stops working.
                       Prints no secret. Run it again to rotate, then restart sdlc-api.
  worker-evidence-credentials
                       The same for the worker's release packs at G8: kv/worker/evidence, the
                       identity "worker-evidence" with the same four rights (E03, ADR-M49). The
                       old key stops working. Prints no secret. Run it again to rotate, then
                       restart sdlc-worker.
  worker-purge-credentials
                       The worker's evidence retention loop (E05, ADR-M51): kv/worker/purge, the
                       identity "worker-purge": List:evidence, and on evidence/proposals/*,
                       evidence/diffs/*, evidence/packs/*: Write (delete), BypassGovernanceRetention,
                       PutObjectLegalHold, PutObjectRetention, GetObjectRetention. No read. The old
                       key stops working. Prints no secret. Run it again to rotate, then restart
                       sdlc-worker.
  worker-anchor-credentials
                       The worker's daily audit anchor (E05 PR 2, ADR-M51 §2.9): kv/worker/anchor,
                       the identity "worker-anchor": Write, Read, List and GetObjectRetention on
                       the bucket audit-anchors (object lock COMPLIANCE) only. The old key stops
                       working. Prints no secret. Run it again to rotate, then restart sdlc-worker.

Runbook: handbook/03-templates/T11-openbao-runbook.md
EOF
}

say() { echo "bootstrap: $*"; }
fail() {
  echo "bootstrap: $*" >&2
  exit 1
}
setting() {
  value="$(sed -n "s/^$1=//p" "$settings" | tail -n 1)"
  [ -n "$value" ] || fail "setting $1 missing in $settings"
  printf '%s' "$value"
}

# --- Arguments (parsed before anything touches Docker) ----------------------------------------
[ "$#" -ge 1 ] || {
  usage >&2
  exit 2
}
command="$1"
shift
keep_token=no
allow_non_tty=no
for arg in "$@"; do
  case "$arg" in
    --keep-token)
      [ "$command" = configure ] || fail "unknown option: $arg"
      keep_token=yes
      ;;
    # Test hook only: lets the live test keep the printed secrets in memory. Accepted only when
    # SDLC_OPENBAO_TEST=1; never documented in --help.
    --stdout-not-tty)
      [ "${SDLC_OPENBAO_TEST:-}" = 1 ] || fail "unknown option: $arg"
      allow_non_tty=yes
      ;;
    *) fail "unknown option: $arg" ;;
  esac
done
case "$command" in
  -h | --help | help)
    usage
    exit 0
    ;;
  status | init | unseal | configure | root-token | litellm-credentials | api-credentials | worker-credentials | runner-credentials | runner-evidence-credentials | api-evidence-credentials | worker-evidence-credentials | worker-purge-credentials | worker-anchor-credentials) ;;
  *)
    usage >&2
    exit 2
    ;;
esac

env_file="${SDLC_ENV_FILE:-$deploy_dir/.env}"
[ -f "$env_file" ] || fail "$env_file not found; run scripts/init-env.sh first"
command -v docker >/dev/null 2>&1 || fail "docker is required"

compose() { docker compose -f "$deploy_dir/docker-compose.yml" --env-file "$env_file" "$@"; }
# "docker compose exec" reads stdin until it ends. Only calls that pass a secret get stdin;
# every other call gets /dev/null, so it cannot swallow the next key share or token.
bao_exec() { compose exec -T openbao "$@"; }
bao_exec_no_input() { compose exec -T openbao "$@" </dev/null; }

# Prints uninitialised, sealed or unsealed. Fails when the container or API is not reachable.
state() {
  out="$(bao_exec_no_input wget -q -O - http://127.0.0.1:8200/v1/sys/seal-status 2>/dev/null)" ||
    fail "OpenBao is not reachable; start it with: pnpm compose:core"
  case "$out" in
    *'"initialized":false'*) echo uninitialised ;;
    *'"sealed":true'*) echo sealed ;;
    *'"sealed":false'*) echo unsealed ;;
    *) fail "unexpected answer from OpenBao seal-status" ;;
  esac
}

require_unsealed() {
  case "$(state)" in
    unsealed) ;;
    sealed) fail "OpenBao is sealed; unseal it first: bootstrap.sh unseal (runbook T11 section 4)" ;;
    uninitialised) fail "OpenBao is not initialised; run: bootstrap.sh init (runbook T11 section 3)" ;;
  esac
}

# Secrets go to the terminal only (AC1: printed once, never to a file).
require_terminal_output() {
  [ -t 1 ] || [ "$allow_non_tty" = yes ] ||
    fail "output is not a terminal; secrets are printed only to a terminal. Do not redirect or pipe this command"
}

restore_echo() { [ -t 0 ] && stty echo 2>/dev/null || true; }

# read_secret <prompt>: hidden prompt on a terminal, plain line from stdin otherwise.
read_secret() {
  if [ -t 0 ]; then
    printf '%s: ' "$1" >&2
    trap 'restore_echo; exit 130' INT TERM
    stty -echo
    IFS= read -r secret || secret=""
    restore_echo
    trap - INT TERM
    echo >&2
  else
    IFS= read -r secret || secret=""
  fi
  printf '%s' "$secret"
}

cmd_status() {
  say "OpenBao is $(state)"
}

cmd_init() {
  require_terminal_output
  [ "$(state)" = uninitialised ] || fail "OpenBao is already initialised; nothing printed"
  shares="$(setting BAO_KEY_SHARES)"
  threshold="$(setting BAO_KEY_THRESHOLD)"
  cat <<EOF
================================================================================
 OpenBao initialisation: $shares key shares, any $threshold unseal.
 The shares and the root token below are shown ONCE. They are not stored anywhere.
 Give each share to a different key holder (runbook T11 section 3).
 Never paste them into chat, email, issues, files or logs.
================================================================================
EOF
  bao_exec_no_input bao operator init -key-shares="$shares" -key-threshold="$threshold"
  cat <<EOF
================================================================================
 Next: bootstrap.sh unseal ($threshold shares), then bootstrap.sh configure (root token).
 configure revokes the root token when it finishes.
================================================================================
EOF
}

cmd_unseal() {
  case "$(state)" in
    unsealed)
      say "OpenBao is already unsealed"
      return 0
      ;;
    uninitialised) fail "OpenBao is not initialised; run: bootstrap.sh init" ;;
  esac
  while [ "$(state)" = sealed ]; do
    share="$(read_secret 'Unseal key share (hidden)')"
    [ -n "$share" ] || fail "no key share given; OpenBao is still sealed"
    progress="$(printf '%s' "$share" | bao_exec bao write -field=progress sys/unseal key=- 2>/dev/null)" ||
      fail "the key share was rejected; OpenBao is still sealed"
    [ "$(state)" = sealed ] && say "share accepted ($progress of $(setting BAO_KEY_THRESHOLD))"
  done
  say "OpenBao is unsealed"
}

# Subnet(s) of the Compose network the openbao container is on, WITHOUT the gateway address:
# on a Linux host every host process reaches containers from the gateway (QUESTIONS #37).
network_cidrs() {
  container="$(compose ps -q openbao </dev/null)"
  [ -n "$container" ] || fail "the openbao container is not running"
  network="$(docker inspect -f '{{range $name, $_ := .NetworkSettings.Networks}}{{$name}} {{end}}' "$container")"
  cidrs=""
  for n in $network; do
    for pair in $(docker network inspect -f '{{range .IPAM.Config}}{{.Subnet}}|{{.Gateway}} {{end}}' "$n"); do
      subnet="${pair%%|*}"
      gateway="${pair#*|}"
      [ -n "$gateway" ] || fail "the Compose network has no fixed gateway (SDLC_NETWORK_GATEWAY in .env)"
      blocks="$("$deploy_dir/openbao/cidr-exclude.sh" "$subnet" "$gateway")" ||
        fail "cannot exclude the gateway $gateway from $subnet"
      cidrs="${cidrs:+$cidrs,}$blocks"
    done
  done
  [ -n "$cidrs" ] || fail "cannot read the subnet of the Compose network"
  printf '%s' "$cidrs"
}

cmd_configure() {
  require_unsealed
  cidrs="$(setting SECRET_ID_BOUND_CIDRS)"
  [ "$cidrs" = compose-network ] && cidrs="$(network_cidrs)"
  token="$(read_secret 'Root token (hidden)')"
  [ -n "$token" ] || fail "no root token given"
  set -- "$cidrs"
  [ "$keep_token" = yes ] && set -- "$@" --keep-token
  printf '%s\n' "$token" | bao_exec sh "$in_container/configure.sh" "$@"
}

cmd_root_token() {
  require_terminal_output
  require_unsealed
  threshold="$(setting BAO_KEY_THRESHOLD)"
  input=""
  i=1
  while [ "$i" -le "$threshold" ]; do
    share="$(read_secret "Key share $i of $threshold (hidden)")"
    [ -n "$share" ] || fail "no key share given"
    input="$input$share
"
    i=$((i + 1))
  done
  echo "New root token (shown ONCE; revoke it after use, record the use in the operations log):"
  printf '%s' "$input" | bao_exec sh "$in_container/root-token.sh"
}

# Prints the role ID, a new secret ID and the new secret ID's accessor, one per line, from the
# openbao container. The accessor comes from the same create response, never from a list. The
# admin token comes on stdin. issue_secret_id <AppRole>
issue_secret_id() {
  printf '%s\n' "$token" |
    bao_exec sh -c 'IFS= read -r BAO_TOKEN && export BAO_TOKEN &&
      bao read -field=role_id "auth/approle/role/$1/role-id" && echo &&
      bao write -f -format=table "auth/approle/role/$1/secret-id" |
        awk '"'"'$1 == "secret_id" { s = $2 } $1 == "secret_id_accessor" { a = $2 }
          END { if (s == "" || a == "") exit 1; print s; print a }'"'"'' sh "$1"
}

# Destroys every secret ID of an AppRole except the one with the given accessor, so a rotation
# cuts off the previous secret ID at once (QUESTIONS #140). Runs only after the new secret ID is
# written to the service's volume. One process per AppRole: a second instance of a service would
# lose its secret ID here (ADR-M19). Tokens already issued from an old secret ID stay valid until
# their TTL (runbook T11 section 8). revoke_other_secret_ids <AppRole> <accessor to keep>
revoke_other_secret_ids() {
  case "$2" in
    '' | *[!0-9a-f-]*) fail "no valid accessor for the new $1 secret ID; old secret IDs NOT revoked" ;;
  esac
  printf '%s\n%s\n' "$token" "$2" |
    bao_exec sh -c 'IFS= read -r BAO_TOKEN && export BAO_TOKEN && IFS= read -r keep || exit 1
      accessors="$(bao list -format=json "auth/approle/role/$1/secret-id" | tr -d "[]\", ")" || exit 1
      printf "%s\n" "$accessors" | grep -qxF "$keep" || { echo "new secret ID not listed" >&2; exit 1; }
      for a in $accessors; do
        [ "$a" = "$keep" ] && continue
        bao write "auth/approle/role/$1/secret-id-accessor/destroy" secret_id_accessor="$a" >/dev/null || exit 1
      done' sh "$1" ||
    fail "the new $1 credentials are delivered, but old secret IDs could NOT be revoked; run the command again (runbook T11 section 8)"
}

# The role ID and a new secret ID go from the openbao container straight into the sidecar's volume
# through a pipe: never a host file, a command line or an environment variable. The admin token
# goes to the openbao container on stdin. The old secret IDs are revoked afterwards.
cmd_litellm_credentials() {
  require_unsealed
  token="$(read_secret 'Admin or root token (hidden)')"
  [ -n "$token" ] || fail "no token given"
  accessor="$(issue_secret_id litellm |
    compose --profile core --profile models run --rm -T --no-deps --user root --entrypoint sh \
      litellm-agent -c '
      set -e
      umask 077
      IFS= read -r role_id || role_id=""
      IFS= read -r secret_id || secret_id=""
      IFS= read -r accessor || accessor=""
      [ -n "$role_id" ] && [ -n "$secret_id" ] && [ -n "$accessor" ] ||
        { echo "no role ID or secret ID received" >&2; exit 1; }
      printf "%s\n" "$role_id" >/openbao/approle/role_id
      printf "%s\n" "$secret_id" >/openbao/approle/secret_id
      chown -R openbao:openbao /openbao/approle
      chmod 700 /openbao/approle
      printf "%s\n" "$accessor"')" ||
    fail "could not deliver the litellm credentials (token valid? OpenBao configured with the litellm AppRole?)"
  revoke_other_secret_ids litellm "$accessor"
  say "litellm AppRole credentials written to the litellm-approle volume, old secret IDs revoked; restart litellm-agent to use them"
}

# Writes the role ID and a new secret ID of an AppRole straight into a volume of a platform
# service: from the openbao container through a pipe, never a host file, a command line or an
# environment variable. The platform services drop every capability; this one-shot root container
# gets back only what it needs to write the files and give them to the user node. It prints the
# new accessor only after the files are written; then the old secret IDs are revoked. Needs $token.
# deliver_approle <AppRole> <Compose service> <directory in the service> <profile>
deliver_approle() {
  accessor="$(issue_secret_id "$1" |
    compose --profile core --profile "$4" run --rm -T --no-deps --user root \
      --cap-add CHOWN --cap-add DAC_OVERRIDE --cap-add FOWNER --entrypoint sh "$2" -c '
      set -e
      umask 077
      IFS= read -r role_id || role_id=""
      IFS= read -r secret_id || secret_id=""
      IFS= read -r accessor || accessor=""
      [ -n "$role_id" ] && [ -n "$secret_id" ] && [ -n "$accessor" ] ||
        { echo "no role ID or secret ID received" >&2; exit 1; }
      printf "%s\n" "$role_id" >"$0/role_id"
      printf "%s\n" "$secret_id" >"$0/secret_id"
      chown -R node:node "$0"
      chmod 700 "$0"
      printf "%s\n" "$accessor"' "$3")" ||
    fail "could not deliver the $1 credentials (token valid? OpenBao configured with the $1 AppRole?)"
  revoke_other_secret_ids "$1" "$accessor"
}

# The database password goes from the env file to the openbao container on stdin, after the admin
# token; the AppRole credentials go into the service's volume (deliver_approle).
# platform_credentials <AppRole and KV prefix: api | worker | runner> <Compose service> [profile]
# The profile is "platform" by default; the runner lives in the profile "sandbox" (C04).
platform_credentials() {
  role="$1"
  service="$2"
  require_unsealed
  password="$(sed -n 's/^PLATFORM_APP_DB_PASSWORD=//p' "$env_file" | tail -n 1)"
  case "$password" in
    '' | CHANGEME) fail "PLATFORM_APP_DB_PASSWORD is not set in $env_file" ;;
  esac
  token="$(read_secret 'Admin or root token (hidden)')"
  [ -n "$token" ] || fail "no token given"
  printf '%s\n%s' "$token" "$password" |
    bao_exec sh -c 'IFS= read -r BAO_TOKEN && export BAO_TOKEN &&
      bao kv put -mount=kv "$1/database" password=- >/dev/null' sh "$role" ||
    fail "could not store kv/$role/database (token valid? OpenBao configured?)"
  deliver_approle "$role" "$service" /run/sdlc/approle "${3:-platform}"
  say "kv/$role/database stored; $role AppRole credentials written to the $role-approle volume, old secret IDs revoked; restart $service to use them"
}

# The worker also holds the Cost Controller capability (C06, ADR-M33 §2.5, QUESTIONS #112): the
# AppRole "cost-controller" goes into the volume worker-cost-approle. Uses the admin token read
# by platform_credentials.
cost_controller_credentials() {
  deliver_approle cost-controller sdlc-worker /run/sdlc/cost-approle platform
  say "cost-controller AppRole credentials written to the worker-cost-approle volume, old secret IDs revoked; restart sdlc-worker to use them"
}

cmd_api_credentials() { platform_credentials api sdlc-api; }
cmd_worker_credentials() {
  platform_credentials worker sdlc-worker
  cost_controller_credentials
}
cmd_runner_credentials() { platform_credentials runner sdlc-runner sandbox; }

# The runner's write-only SeaweedFS identity for L1 proposals (C06 session 2b, ADR-M33 §2.9) and
# run diffs (C07, ADR-M34 §2.2).
# The openbao container makes the key pair, stores it at kv/runner/evidence (JSON on stdin) and
# prints the two `s3.configure` lines, which go through a pipe to `weed shell` on its stdin: the
# keys are never a host file, a command line or an environment variable. `weed shell` prints the
# identities with their secrets, so its output is discarded; the check reads names only. The old
# identity is deleted first, so a rotation leaves one key (that call fails harmlessly when there is
# none yet: `weed shell` exits 1 after any failed command, so it runs on its own).
cmd_runner_evidence_credentials() {
  require_unsealed
  token="$(read_secret 'Admin or root token (hidden)')"
  [ -n "$token" ] || fail "no token given"
  weed="weed shell -master=127.0.0.1:9333"
  # The KV version (no secret) tells whether the new key pair was stored: `weed shell` exits 0 even
  # when it received nothing.
  kv_version() {
    printf '%s\n' "$token" | bao_exec sh -c 'IFS= read -r BAO_TOKEN && export BAO_TOKEN &&
      bao read -field=current_version kv/metadata/runner/evidence 2>/dev/null || echo 0'
  }
  before="$(kv_version)"
  echo "s3.configure -user runner-evidence -delete -apply" |
    compose exec -T seaweedfs $weed >/dev/null 2>&1 || true
  printf '%s\n' "$token" |
    bao_exec sh -c 'set -e
      IFS= read -r BAO_TOKEN && export BAO_TOKEN
      access="sdlcrunner$(od -An -N10 -tx1 /dev/urandom | tr -d " \n")"
      secret="$(od -An -N30 -tx1 /dev/urandom | tr -d " \n")"
      [ "${#access}" -eq 30 ] || exit 1
      [ "${#secret}" -eq 60 ] || exit 1
      printf "{\"access_key\":\"%s\",\"secret_key\":\"%s\"}" "$access" "$secret" |
        bao kv put -mount=kv runner/evidence - >/dev/null
      printf "s3.configure -user runner-evidence -access_key %s -secret_key %s -actions Write:evidence/proposals/*,Write:evidence/diffs/*,Read:evidence/diffs/* -apply\n" "$access" "$secret"' |
    compose exec -T seaweedfs $weed >/dev/null 2>&1 ||
    fail "could not create the runner evidence credentials (token valid? OpenBao configured? SeaweedFS running?)"
  [ "$(kv_version)" = "$((before + 1))" ] ||
    fail "kv/runner/evidence was not stored (token valid? OpenBao configured?); run the command again"
  echo "s3.configure" | compose exec -T seaweedfs sh -c "$weed 2>/dev/null | grep -q '\"name\": *\"runner-evidence\"'" ||
    fail "SeaweedFS has no identity runner-evidence; run the command again"
  say "kv/runner/evidence stored; SeaweedFS identity runner-evidence (Write:evidence/proposals/*, Write:evidence/diffs/*, Read:evidence/diffs/*) applied; restart sdlc-runner to use it"
}

# SeaweedFS identities of the platform processes, made the same way: the keys are made inside the
# openbao container, stored at kv/<role>/<name> (JSON on stdin), piped to `weed shell` on its
# stdin, its output discarded; the old identity is deleted first, so a rotation leaves one key.
# The AppRoles "api" and "worker" already read kv/data/<role>/*: no policy change.
# s3_credentials <role: api | worker> <kv name> <access key prefix, 9 characters> <actions> <service>
# The identity is "<role>-<kv name>".
s3_credentials() {
  role="$1"
  name="$2"
  key_prefix="$3"
  actions="$4"
  service="$5"
  identity="$role-$name"
  require_unsealed
  token="$(read_secret 'Admin or root token (hidden)')"
  [ -n "$token" ] || fail "no token given"
  weed="weed shell -master=127.0.0.1:9333"
  kv_version() {
    printf '%s\n' "$token" | bao_exec sh -c 'IFS= read -r BAO_TOKEN && export BAO_TOKEN &&
      bao read -field=current_version "kv/metadata/$1/$2" 2>/dev/null || echo 0' sh "$role" "$name"
  }
  before="$(kv_version)"
  echo "s3.configure -user $identity -delete -apply" |
    compose exec -T seaweedfs $weed >/dev/null 2>&1 || true
  printf '%s\n' "$token" |
    bao_exec sh -c 'set -e
      IFS= read -r BAO_TOKEN && export BAO_TOKEN
      access="$3$(od -An -N10 -tx1 /dev/urandom | tr -d " \n")"
      secret="$(od -An -N30 -tx1 /dev/urandom | tr -d " \n")"
      [ "${#access}" -eq 29 ] || exit 1
      [ "${#secret}" -eq 60 ] || exit 1
      printf "{\"access_key\":\"%s\",\"secret_key\":\"%s\"}" "$access" "$secret" |
        bao kv put -mount=kv "$1/$2" - >/dev/null
      printf "s3.configure -user %s-%s -access_key %s -secret_key %s -actions %s -apply\n" "$1" "$2" "$access" "$secret" "$4"' \
      sh "$role" "$name" "$key_prefix" "$actions" |
    compose exec -T seaweedfs $weed >/dev/null 2>&1 ||
    fail "could not create the $identity credentials (token valid? OpenBao configured? SeaweedFS running?)"
  [ "$(kv_version)" = "$((before + 1))" ] ||
    fail "kv/$role/$name was not stored (token valid? OpenBao configured?); run the command again"
  echo "s3.configure" | compose exec -T seaweedfs sh -c "$weed 2>/dev/null | grep -q '\"name\": *\"$identity\"'" ||
    fail "SeaweedFS has no identity $identity; run the command again"
  say "kv/$role/$name stored; SeaweedFS identity $identity ($actions) applied; restart $service to use it"
}

# The SeaweedFS identities that build Evidence Packs: the api's (E02, ADR-M48 §2.2) and the
# worker's for G8's release pack (E03, ADR-M49 §2.2). Each reads proposals and diffs to re-check
# their hashes (a deliberate widening: read only, those two prefixes) and reads and writes packs/.
# pack_evidence_credentials <role: api | worker> <access key prefix, 9 characters> <service>
pack_evidence_credentials() {
  s3_credentials "$1" evidence "$2" \
    'Read:evidence/proposals/*,Read:evidence/diffs/*,Read:evidence/packs/*,Write:evidence/packs/*' "$3"
}

# The worker's purge identity (E05, ADR-M51 §2.3): deletes every version of evidence files whose
# retention is over (SeaweedFS `Write` includes delete), lists the bucket (versions, the orphan
# sweep), bypasses the GOVERNANCE lock (archived projects, orphan pack files), and sets legal holds
# and locks. It never reads a file. Stored at kv/worker/purge.
PURGE_ACTIONS=''
for prefix in proposals diffs packs; do
  for action in Write BypassGovernanceRetention PutObjectLegalHold PutObjectRetention GetObjectRetention; do
    PURGE_ACTIONS="$PURGE_ACTIONS,$action:evidence/$prefix/*"
  done
done
PURGE_ACTIONS="List:evidence$PURGE_ACTIONS"
cmd_worker_purge_credentials() { s3_credentials worker purge sdlcwrkpg "$PURGE_ACTIONS" sdlc-worker; }

# The worker's audit anchor identity (E05 PR 2, ADR-M51 §2.9): writes, reads and lists the daily
# anchors in the bucket `audit-anchors` (object lock COMPLIANCE: its write can never delete a
# version) and reads their lock. Nothing in `evidence`. Stored at kv/worker/anchor.
ANCHOR_ACTIONS='Write:audit-anchors,Read:audit-anchors,List:audit-anchors,GetObjectRetention:audit-anchors'
cmd_worker_anchor_credentials() { s3_credentials worker anchor sdlcwrkan "$ANCHOR_ACTIONS" sdlc-worker; }

cmd_api_evidence_credentials() { pack_evidence_credentials api sdlcapiev sdlc-api; }
cmd_worker_evidence_credentials() { pack_evidence_credentials worker sdlcwrkev sdlc-worker; }

case "$command" in
  status) cmd_status ;;
  init) cmd_init ;;
  unseal) cmd_unseal ;;
  configure) cmd_configure ;;
  root-token) cmd_root_token ;;
  litellm-credentials) cmd_litellm_credentials ;;
  api-credentials) cmd_api_credentials ;;
  worker-credentials) cmd_worker_credentials ;;
  runner-credentials) cmd_runner_credentials ;;
  runner-evidence-credentials) cmd_runner_evidence_credentials ;;
  api-evidence-credentials) cmd_api_evidence_credentials ;;
  worker-evidence-credentials) cmd_worker_evidence_credentials ;;
  worker-purge-credentials) cmd_worker_purge_credentials ;;
  worker-anchor-credentials) cmd_worker_anchor_credentials ;;
esac
