#!/bin/sh
# TLS for OpenBao's listener 8200 (task A10, design/ADR-M63, QUESTIONS #20). Runs on the host and
# needs OpenSSL 3 and, for `reload`, Docker. Procedure: runbook T11 section 3c.
#
# The certificate folder (SDLC_OPENBAO_TLS_DIR in the env file) holds ca.pem, server.pem and
# server-key.pem. The CA's private key is never in it: on a development machine it is deleted at
# once; on the server it stays in the offline folder of `ca` (the safe, with the key shares).
#
# Environment:
#   SDLC_ENV_FILE  Compose env file (default: platform/deploy/.env)
set -eu

deploy_dir="$(cd "$(dirname "$0")/.." && pwd)"
repo_dir="$(cd "$deploy_dir" && cd ../.. && pwd)"

CA_DAYS=1826    # 5 years (QUESTIONS #20)
SERVER_DAYS=365 # 1 year (QUESTIONS #20)
DEV_DAYS=825    # throw-away CA and certificate of a development machine or a test
WARN_DAYS=30    # the operator renews 30 days before the end (runbook T11 section 3c)
SAN='DNS:openbao,IP:127.0.0.1'

usage() {
  cat <<'EOF'
Usage: platform/deploy/openbao/tls.sh <command> [argument]

Commands:
  dev [env-file]     Development machines and tests: make a throw-away CA and a server
                     certificate in the folder next to the env file (openbao-tls/), delete the
                     CA key at once, and set SDLC_OPENBAO_TLS_DIR in the env file. Does nothing
                     when the folder already holds a certificate. pnpm compose:env runs it.
  ca <ca-folder>     The server: make the internal CA (5 years) in <ca-folder>, a folder
                     outside the repository that goes offline afterwards (the safe). Refuses
                     an existing CA or a folder inside the repository.
  server <ca-folder> The server: issue OpenBao's certificate (1 year, names openbao and
                     127.0.0.1) with the CA of <ca-folder> into SDLC_OPENBAO_TLS_DIR, then
                     run `reload`. Also the renewal.
  check              Show when the CA and the server certificate end. Exit 1 when one is
                     missing, invalid or ends within 30 days.
  reload             Copy the certificates into OpenBao (job openbao-tls-init) and make it
                     read them again (SIGHUP). OpenBao stays unsealed.

Runbook: handbook/03-templates/T11-openbao-runbook.md, section 3c
EOF
}

say() { echo "tls: $*"; }
fail() {
  echo "tls: $*" >&2
  exit 1
}

[ "$#" -ge 1 ] || {
  usage >&2
  exit 2
}
command="$1"
shift
case "$command" in
  -h | --help | help)
    usage
    exit 0
    ;;
  dev | ca | server | check | reload) ;;
  *)
    usage >&2
    exit 2
    ;;
esac

need_openssl() {
  command -v openssl >/dev/null 2>&1 || fail "openssl (OpenSSL 3 or later) is required"
  case "$(openssl version 2>/dev/null)" in
    'OpenSSL '[3-9]*) ;;
    *) fail "OpenSSL 3 or later is required, not LibreSSL (macOS: brew install openssl@3, then put it first in PATH)" ;;
  esac
}

# The value of a variable in the env file, or nothing.
env_value() { sed -n "s/^$1=//p" "$2" | tail -n 1; }

# tls_dir <env-file>: the certificate folder named by the env file.
tls_dir() {
  tls_folder="$(env_value SDLC_OPENBAO_TLS_DIR "$1")"
  [ -n "$tls_folder" ] || fail "SDLC_OPENBAO_TLS_DIR is not set in $1 (development machine: tls.sh dev)"
  case "$tls_folder" in /*) ;; *) fail "SDLC_OPENBAO_TLS_DIR must be an absolute path" ;; esac
  printf '%s' "$tls_folder"
}

# make_ca <folder> <days> <name>: a CA key (EC P-256) and a self-signed CA certificate.
make_ca() {
  openssl ecparam -name prime256v1 -genkey -noout -out "$1/ca-key.pem" 2>/dev/null
  chmod 600 "$1/ca-key.pem"
  openssl req -x509 -new -key "$1/ca-key.pem" -sha256 -days "$2" -subj "/CN=$3" \
    -addext 'basicConstraints=critical,CA:TRUE,pathlen:0' \
    -addext 'keyUsage=critical,keyCertSign,cRLSign' \
    -out "$1/ca.pem" 2>/dev/null
}

# issue_server <ca-folder> <out-folder> <days>: OpenBao's key and certificate, signed by the CA.
issue_server() {
  work="$(mktemp -d)"
  openssl ecparam -name prime256v1 -genkey -noout -out "$work/server-key.pem" 2>/dev/null
  openssl req -new -key "$work/server-key.pem" -subj '/CN=openbao' -out "$work/server.csr" 2>/dev/null
  printf 'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=serverAuth\nsubjectAltName=%s\n' \
    "$SAN" >"$work/ext.cnf"
  openssl x509 -req -in "$work/server.csr" -CA "$1/ca.pem" -CAkey "$1/ca-key.pem" -CAcreateserial \
    -CAserial "$work/ca.srl" -sha256 -days "$3" -extfile "$work/ext.cnf" -out "$work/server.pem" 2>/dev/null
  openssl verify -CAfile "$1/ca.pem" "$work/server.pem" >/dev/null || fail "the new certificate does not verify"
  mkdir -p "$2"
  chmod 700 "$2"
  cp "$1/ca.pem" "$2/ca.pem.new"
  cp "$work/server.pem" "$2/server.pem.new"
  (umask 077 && cp "$work/server-key.pem" "$2/server-key.pem.new")
  chmod 644 "$2/ca.pem.new" "$2/server.pem.new"
  chmod 600 "$2/server-key.pem.new"
  mv "$2/ca.pem.new" "$2/ca.pem"
  mv "$2/server.pem.new" "$2/server.pem"
  mv "$2/server-key.pem.new" "$2/server-key.pem"
  rm -rf "$work"
}

# inside_repo <folder>: true when the folder is the repository or below it (absolute path).
inside_repo() {
  case "$1/" in "$repo_dir"/*) return 0 ;; *) return 1 ;; esac
}

cmd_dev() {
  need_openssl
  env_file="${1:-${SDLC_ENV_FILE:-$deploy_dir/.env}}"
  [ -f "$env_file" ] || fail "$env_file not found; run scripts/init-env.sh first"
  env_dir="$(cd "$(dirname "$env_file")" && pwd)"
  tls_folder="$(env_value SDLC_OPENBAO_TLS_DIR "$env_file")"
  [ -n "$tls_folder" ] || tls_folder="$env_dir/openbao-tls"
  if [ -s "$tls_folder/server.pem" ] && [ -s "$tls_folder/server-key.pem" ] && [ -s "$tls_folder/ca.pem" ]; then
    say "$tls_folder already holds a certificate; nothing changed"
  else
    work="$(mktemp -d)"
    trap 'rm -rf "$work"' EXIT
    make_ca "$work" "$DEV_DAYS" 'Throw-away OpenBao CA (development)'
    issue_server "$work" "$tls_folder" "$DEV_DAYS"
    rm -rf "$work"
    trap - EXIT
    say "made a throw-away CA and a server certificate in $tls_folder (the CA key is deleted)"
  fi
  if [ -z "$(env_value SDLC_OPENBAO_TLS_DIR "$env_file")" ]; then
    tmp="$(mktemp "$env_file.XXXXXX")"
    if grep -q '^SDLC_OPENBAO_TLS_DIR=' "$env_file"; then
      sed "s|^SDLC_OPENBAO_TLS_DIR=.*|SDLC_OPENBAO_TLS_DIR=$tls_folder|" "$env_file" >"$tmp"
    else
      cat "$env_file" >"$tmp"
      printf 'SDLC_OPENBAO_TLS_DIR=%s\n' "$tls_folder" >>"$tmp"
    fi
    chmod 600 "$tmp"
    mv "$tmp" "$env_file"
    say "set SDLC_OPENBAO_TLS_DIR in $env_file"
  fi
}

cmd_ca() {
  need_openssl
  [ "$#" -eq 1 ] || fail "usage: tls.sh ca <ca-folder>"
  case "$1" in /*) ca_dir="$1" ;; *) ca_dir="$PWD/$1" ;; esac
  inside_repo "$ca_dir" && fail "the CA folder must be outside the repository: $ca_dir"
  mkdir -p "$ca_dir"
  ca_dir="$(cd "$ca_dir" && pwd)"
  inside_repo "$ca_dir" && fail "the CA folder must be outside the repository: $ca_dir"
  [ -e "$ca_dir/ca-key.pem" ] && fail "$ca_dir already holds a CA; a new CA means every client gets a new ca.pem"
  chmod 700 "$ca_dir"
  make_ca "$ca_dir" "$CA_DAYS" 'Internal OpenBao CA'
  say "made the CA in $ca_dir (ca.pem, ca-key.pem; 5 years)"
  say "next: tls.sh server $ca_dir, then take the folder offline (runbook T11 section 3c)"
}

cmd_server() {
  need_openssl
  [ "$#" -eq 1 ] || fail "usage: tls.sh server <ca-folder>"
  ca_dir="$(cd "$1" && pwd)"
  [ -s "$ca_dir/ca-key.pem" ] && [ -s "$ca_dir/ca.pem" ] || fail "$ca_dir holds no CA (tls.sh ca)"
  env_file="${SDLC_ENV_FILE:-$deploy_dir/.env}"
  [ -f "$env_file" ] || fail "$env_file not found"
  tls_folder="$(tls_dir "$env_file")"
  [ "$tls_folder" = "$ca_dir" ] && fail "the certificate folder and the CA folder must differ"
  issue_server "$ca_dir" "$tls_folder" "$SERVER_DAYS"
  say "issued OpenBao's certificate in $tls_folder (1 year). Now: tls.sh reload (if OpenBao runs)"
}

# show <label> <file>: the end date; returns 1 when missing, invalid or ending within WARN_DAYS.
show() {
  if [ ! -s "$2" ]; then
    echo "tls: $1: missing ($2)" >&2
    return 1
  fi
  end="$(openssl x509 -in "$2" -noout -enddate 2>/dev/null)" || {
    echo "tls: $1: not a certificate ($2)" >&2
    return 1
  }
  if openssl x509 -in "$2" -noout -checkend $((WARN_DAYS * 86400)) >/dev/null 2>&1; then
    say "$1: ${end#notAfter=}"
  else
    echo "tls: $1: ${end#notAfter=}: ends within $WARN_DAYS days or has ended; renew it (runbook T11 section 3c)" >&2
    return 1
  fi
}

cmd_check() {
  need_openssl
  env_file="${SDLC_ENV_FILE:-$deploy_dir/.env}"
  [ -f "$env_file" ] || fail "$env_file not found"
  tls_folder="$(tls_dir "$env_file")"
  status=0
  show 'CA' "$tls_folder/ca.pem" || status=1
  show 'server certificate' "$tls_folder/server.pem" || status=1
  if [ "$status" -eq 0 ] && ! openssl verify -CAfile "$tls_folder/ca.pem" "$tls_folder/server.pem" >/dev/null 2>&1; then
    echo "tls: the server certificate is not signed by ca.pem" >&2
    status=1
  fi
  [ -s "$tls_folder/server-key.pem" ] || {
    echo "tls: server-key.pem is missing" >&2
    status=1
  }
  return "$status"
}

cmd_reload() {
  command -v docker >/dev/null 2>&1 || fail "docker is required"
  env_file="${SDLC_ENV_FILE:-$deploy_dir/.env}"
  [ -f "$env_file" ] || fail "$env_file not found"
  compose() { docker compose -f "$deploy_dir/docker-compose.yml" --env-file "$env_file" --profile core "$@"; }
  compose run --rm --no-deps openbao-tls-init >/dev/null
  compose kill -s SIGHUP openbao >/dev/null
  say "OpenBao reads the new certificate. Restart the clients only when ca.pem changed (runbook T11 section 3c)"
}

"cmd_$command" "$@"
