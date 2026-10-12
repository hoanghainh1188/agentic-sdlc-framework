#!/bin/sh
# TLS for the team access proxy (task V09, design/ADR-M67 §2.7). Runs on the host and needs
# OpenSSL 3 and, for `reload`, Docker. Procedure: runbook T11 section 3d.
#
# The certificate folder (SDLC_ACCESS_TLS_DIR in the env file) holds ca.pem, server.pem and
# server-key.pem. The CA's private key is never in it. The names come from SDLC_ACCESS_HOSTNAME
# (required: passkeys refuse an IP address) and SDLC_ACCESS_IPS (optional, space-separated).
#
# Environment:
#   SDLC_ENV_FILE  Compose env file (default: platform/deploy/.env)
set -eu

deploy_dir="$(cd "$(dirname "$0")/.." && pwd)"
repo_dir="$(cd "$deploy_dir" && cd ../.. && pwd)"

SERVER_DAYS=365 # 1 year, like OpenBao's (QUESTIONS #20, #406)
DEV_DAYS=825    # throw-away CA and certificate; macOS refuses TLS certificates that last longer
WARN_DAYS=30    # the operator renews 30 days before the end (runbook T11 section 3d)

usage() {
  cat <<'EOF'
Usage: platform/deploy/access/tls.sh <command> [argument]

Commands:
  dev                A test or developer machine: make a throw-away CA and the proxy's
                     certificate in access-tls/ next to the env file, delete the CA key at
                     once, and set SDLC_ACCESS_TLS_DIR in the env file. Does nothing when the
                     folder already holds a certificate.
  server <ca-folder> The server: issue the proxy's certificate (1 year) with the internal CA of
                     <ca-folder> (openbao/tls.sh ca) into SDLC_ACCESS_TLS_DIR. Also the renewal.
  import <folder>    The server: copy ca.pem, server.pem and server-key.pem issued by the company
                     CA from <folder> into SDLC_ACCESS_TLS_DIR, after checking the chain, the
                     key and the names.
  check              Show when the CA and the certificate end and whether the certificate names
                     SDLC_ACCESS_HOSTNAME and SDLC_ACCESS_IPS. Exit 1 when something is missing,
                     invalid, does not match or ends within 30 days.
  reload             Copy the files into the proxy (job access-tls-init) and make nginx read
                     them again (SIGHUP), without a restart.

Runbook: handbook/03-templates/T11-openbao-runbook.md, section 3d
EOF
}

say() { echo "access-tls: $*"; }
fail() {
  echo "access-tls: $*" >&2
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
  dev | server | import | check | reload) ;;
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

# The value of a setting: from the environment when set there (as in Compose), else the env file.
env_value() {
  if eval "[ -n \"\${$1+x}\" ]"; then
    eval "printf '%s' \"\$$1\""
  else
    sed -n "s/^$1=//p" "$2" | tail -n 1
  fi
}

env_file() {
  ef="${SDLC_ENV_FILE:-$deploy_dir/.env}"
  [ -f "$ef" ] || fail "$ef not found; run scripts/init-env.sh first"
  printf '%s' "$ef"
}

# hostname <env-file>: SDLC_ACCESS_HOSTNAME, checked (a DNS name, never an IP address).
host_name() {
  h="$(env_value SDLC_ACCESS_HOSTNAME "$1")"
  [ -n "$h" ] || fail "SDLC_ACCESS_HOSTNAME is not set in $1 (the name people open, for example sdlc.example.internal)"
  printf '%s' "$h" | grep -Eq '^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$' ||
    fail "SDLC_ACCESS_HOSTNAME must be a DNS name: $h"
  printf '%s' "$h" | grep -Eq '^[0-9.]+$' && fail "SDLC_ACCESS_HOSTNAME must be a name, not an IP address (passkeys refuse IP addresses)"
  printf '%s' "$h"
}

# ip_names <env-file>: SDLC_ACCESS_IPS (space-separated IPv4 addresses), checked.
ip_names() {
  ips="$(env_value SDLC_ACCESS_IPS "$1")"
  for ip in $ips; do
    printf '%s' "$ip" | grep -Eq '^([0-9]{1,3}\.){3}[0-9]{1,3}$' || fail "SDLC_ACCESS_IPS holds something that is not an IPv4 address: $ip"
  done
  printf '%s' "$ips"
}

san() {
  out="DNS:$1"
  for ip in $2; do out="$out,IP:$ip"; done
  printf '%s' "$out"
}

# tls_dir <env-file>: the certificate folder named by the env file.
tls_dir() {
  tls_folder="$(env_value SDLC_ACCESS_TLS_DIR "$1")"
  [ -n "$tls_folder" ] || fail "SDLC_ACCESS_TLS_DIR is not set in $1 (test machine: access/tls.sh dev)"
  case "$tls_folder" in /*) ;; *) fail "SDLC_ACCESS_TLS_DIR must be an absolute path" ;; esac
  printf '%s' "$tls_folder"
}

# inside_repo <folder>: true when the folder is the repository or below it (absolute path).
inside_repo() {
  case "$1/" in "$repo_dir"/*) return 0 ;; *) return 1 ;; esac
}

# server_tls_dir <env-file>: the certificate folder of a server, which must be outside the repo.
server_tls_dir() {
  d="$(tls_dir "$1")"
  inside_repo "$d" && fail "on a server SDLC_ACCESS_TLS_DIR must be outside the repository: $d"
  printf '%s' "$d"
}

# install <work-folder> <out-folder>: ca.pem, server.pem, server-key.pem into the folder, atomically.
install_files() {
  mkdir -p "$2"
  chmod 700 "$2"
  cp "$1/ca.pem" "$2/ca.pem.new"
  cp "$1/server.pem" "$2/server.pem.new"
  (umask 077 && cp "$1/server-key.pem" "$2/server-key.pem.new")
  chmod 644 "$2/ca.pem.new" "$2/server.pem.new"
  chmod 600 "$2/server-key.pem.new"
  mv "$2/ca.pem.new" "$2/ca.pem"
  mv "$2/server.pem.new" "$2/server.pem"
  mv "$2/server-key.pem.new" "$2/server-key.pem"
}

# issue <ca-folder> <work-folder> <days> <san>: the proxy's key and certificate, signed by the CA.
issue() {
  openssl ecparam -name prime256v1 -genkey -noout -out "$2/server-key.pem" 2>/dev/null
  openssl req -new -key "$2/server-key.pem" -subj '/CN=sdlc-access' -out "$2/server.csr" 2>/dev/null
  printf 'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=serverAuth\nsubjectAltName=%s\n' \
    "$4" >"$2/ext.cnf"
  openssl x509 -req -in "$2/server.csr" -CA "$1/ca.pem" -CAkey "$1/ca-key.pem" -CAcreateserial \
    -CAserial "$2/ca.srl" -sha256 -days "$3" -extfile "$2/ext.cnf" -out "$2/server.pem" 2>/dev/null
  cp "$1/ca.pem" "$2/ca.pem"
}

# verify <folder> <hostname> <ips>: chain, key and names; prints the first problem and returns 1.
verify() {
  for vf in ca.pem server.pem server-key.pem; do
    [ -s "$1/$vf" ] || {
      echo "access-tls: $vf is missing in $1" >&2
      return 1
    }
  done
  openssl verify -CAfile "$1/ca.pem" "$1/server.pem" >/dev/null 2>&1 || {
    echo "access-tls: server.pem is not signed by ca.pem" >&2
    return 1
  }
  cert_key="$(openssl x509 -in "$1/server.pem" -noout -pubkey 2>/dev/null | openssl sha256)"
  key_key="$(openssl pkey -in "$1/server-key.pem" -pubout 2>/dev/null | openssl sha256)"
  [ "$cert_key" = "$key_key" ] || {
    echo "access-tls: server-key.pem does not belong to server.pem" >&2
    return 1
  }
  openssl x509 -in "$1/server.pem" -noout -checkhost "$2" 2>/dev/null | grep -q 'does match' || {
    echo "access-tls: server.pem does not name $2 (SDLC_ACCESS_HOSTNAME)" >&2
    return 1
  }
  for ip in $3; do
    openssl x509 -in "$1/server.pem" -noout -checkip "$ip" 2>/dev/null | grep -q 'does match' || {
      echo "access-tls: server.pem does not name $ip (SDLC_ACCESS_IPS)" >&2
      return 1
    }
  done
}

cmd_dev() {
  need_openssl
  f="$(env_file)"
  h="$(host_name "$f")"
  ips="$(ip_names "$f")"
  env_dir="$(cd "$(dirname "$f")" && pwd)"
  tls_folder="$(env_value SDLC_ACCESS_TLS_DIR "$f")"
  [ -n "$tls_folder" ] || tls_folder="$env_dir/access-tls"
  if [ -s "$tls_folder/server.pem" ] && [ -s "$tls_folder/server-key.pem" ] && [ -s "$tls_folder/ca.pem" ]; then
    say "$tls_folder already holds a certificate; nothing changed"
  else
    work="$(mktemp -d)"
    trap 'rm -rf "$work"' EXIT
    openssl ecparam -name prime256v1 -genkey -noout -out "$work/ca-key.pem" 2>/dev/null
    openssl req -x509 -new -key "$work/ca-key.pem" -sha256 -days "$DEV_DAYS" \
      -subj '/CN=Throw-away team access CA (test only)' \
      -addext 'basicConstraints=critical,CA:TRUE,pathlen:0' \
      -addext 'keyUsage=critical,keyCertSign,cRLSign' -out "$work/ca.pem" 2>/dev/null
    mkdir "$work/out"
    issue "$work" "$work/out" "$DEV_DAYS" "$(san "$h" "$ips")"
    verify "$work/out" "$h" "$ips" || fail "the new certificate does not verify"
    install_files "$work/out" "$tls_folder"
    rm -rf "$work"
    trap - EXIT
    say "made a throw-away CA and the proxy's certificate in $tls_folder (the CA key is deleted)"
  fi
  if [ -z "$(env_value SDLC_ACCESS_TLS_DIR "$f")" ]; then
    tmp="$(mktemp "$f.XXXXXX")"
    if grep -q '^SDLC_ACCESS_TLS_DIR=' "$f"; then
      sed "s|^SDLC_ACCESS_TLS_DIR=.*|SDLC_ACCESS_TLS_DIR=$tls_folder|" "$f" >"$tmp"
    else
      cat "$f" >"$tmp"
      printf 'SDLC_ACCESS_TLS_DIR=%s\n' "$tls_folder" >>"$tmp"
    fi
    chmod 600 "$tmp"
    mv "$tmp" "$f"
    say "set SDLC_ACCESS_TLS_DIR in $f"
  fi
}

cmd_server() {
  need_openssl
  [ "$#" -eq 1 ] || fail "usage: access/tls.sh server <ca-folder>"
  ca_dir="$(cd "$1" && pwd)"
  [ -s "$ca_dir/ca-key.pem" ] && [ -s "$ca_dir/ca.pem" ] || fail "$ca_dir holds no CA (openbao/tls.sh ca)"
  f="$(env_file)"
  h="$(host_name "$f")"
  ips="$(ip_names "$f")"
  tls_folder="$(server_tls_dir "$f")"
  [ "$tls_folder" = "$ca_dir" ] && fail "the certificate folder and the CA folder must differ"
  work="$(mktemp -d)"
  trap 'rm -rf "$work"' EXIT
  issue "$ca_dir" "$work" "$SERVER_DAYS" "$(san "$h" "$ips")"
  verify "$work" "$h" "$ips" || fail "the new certificate does not verify"
  install_files "$work" "$tls_folder"
  say "issued the proxy's certificate in $tls_folder (1 year). Now: access/tls.sh reload (if the proxy runs)"
}

cmd_import() {
  need_openssl
  [ "$#" -eq 1 ] || fail "usage: access/tls.sh import <folder>"
  src="$(cd "$1" && pwd)"
  f="$(env_file)"
  h="$(host_name "$f")"
  ips="$(ip_names "$f")"
  tls_folder="$(server_tls_dir "$f")"
  [ "$tls_folder" = "$src" ] && fail "the source folder and SDLC_ACCESS_TLS_DIR must differ"
  [ -e "$src/ca-key.pem" ] && fail "$src holds a CA key: never put a CA key next to the proxy's files"
  verify "$src" "$h" "$ips" || fail "the files in $src cannot be used; nothing changed"
  install_files "$src" "$tls_folder"
  say "copied the company CA's certificate into $tls_folder. Now: access/tls.sh reload (if the proxy runs)"
}

# show <label> <file>: the end date; returns 1 when missing, invalid or ending within WARN_DAYS.
show() {
  if [ ! -s "$2" ]; then
    echo "access-tls: $1: missing ($2)" >&2
    return 1
  fi
  end="$(openssl x509 -in "$2" -noout -enddate 2>/dev/null)" || {
    echo "access-tls: $1: not a certificate ($2)" >&2
    return 1
  }
  if openssl x509 -in "$2" -noout -checkend $((WARN_DAYS * 86400)) >/dev/null 2>&1; then
    say "$1: ${end#notAfter=}"
  else
    echo "access-tls: $1: ${end#notAfter=}: ends within $WARN_DAYS days or has ended; renew it (runbook T11 section 3d)" >&2
    return 1
  fi
}

cmd_check() {
  need_openssl
  f="$(env_file)"
  h="$(host_name "$f")"
  ips="$(ip_names "$f")"
  tls_folder="$(tls_dir "$f")"
  status=0
  show 'CA' "$tls_folder/ca.pem" || status=1
  show 'proxy certificate' "$tls_folder/server.pem" || status=1
  if [ "$status" -eq 0 ]; then
    verify "$tls_folder" "$h" "$ips" || status=1
  fi
  return "$status"
}

cmd_reload() {
  command -v docker >/dev/null 2>&1 || fail "docker is required"
  f="$(env_file)"
  compose() { docker compose -f "$deploy_dir/docker-compose.yml" --env-file "$f" --profile core --profile platform --profile access "$@"; }
  compose run --rm --no-deps access-tls-init >/dev/null
  compose kill -s SIGHUP sdlc-access >/dev/null
  say "the proxy reads the new certificate. People need the new ca.pem only when the CA changed (runbook T11 section 3d)"
}

"cmd_$command" "$@"
