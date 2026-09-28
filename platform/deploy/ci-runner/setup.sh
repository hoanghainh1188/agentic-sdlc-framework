#!/usr/bin/env bash
# Self-hosted GitHub Actions runner for this repository's CI (design/ADR-M34, runbook README.md).
#
# Run on a DEDICATED Ubuntu 24.04 x86_64 VM, as root:
#   sudo bash setup.sh install    Docker, the runner user, the runner (pinned, SHA-256 checked),
#                                 the job hooks and the daily prune timer. Safe to run again.
#   sudo bash setup.sh register   asks for a registration token (hidden input), registers the
#                                 runner on the repository and starts it as a systemd service.
#   sudo bash setup.sh remove     asks for a removal token, stops and unregisters the runner.
#   sudo bash setup.sh status     service state, Docker, free disk.
#
# The VM holds no secrets: no OpenBao access, no GitHub token of its own, no client data.
# Tokens are created by an admin in their own terminal and pasted here; never through a chat tool.
set -euo pipefail

RUNNER_VERSION=2.337.0
# SHA-256 of actions-runner-linux-x64-<version>.tar.gz (release notes and the asset digest).
RUNNER_SHA256=70920811a4f8ad4328818682bca5c6469c1c942fab52448868071d0063816613
# Docker's apt signing key (https://docs.docker.com/engine/install/ubuntu/).
DOCKER_KEY_FINGERPRINT=9DC858229FC7DD38854AE2D88D81803C0EBFCD88

RUNNER_USER=ghrunner
RUNNER_HOME=/home/${RUNNER_USER}
RUNNER_DIR=${RUNNER_HOME}/actions-runner
# Repository level on purpose: an organization runner could serve the public pilot repository.
REPO_URL=https://github.com/harryforge/agentic-sdlc-framework
# Must equal the repository variable CI_RUNNER (ci.yml: runs-on).
RUNNER_LABEL=sdlc-ci
LIB_DIR=/usr/local/lib/sdlc-ci-runner

here=$(cd "$(dirname "$0")" && pwd)

die() {
  echo "ci-runner: $*" >&2
  exit 1
}

need_root() {
  [ "$(id -u)" -eq 0 ] || die "run as root: sudo bash $0 $1"
}

check_host() {
  # shellcheck disable=SC1091 # present on every Ubuntu host
  . /etc/os-release
  [ "${ID:-}" = ubuntu ] && [ "${VERSION_ID:-}" = 24.04 ] ||
    die "Ubuntu 24.04 only (found ${ID:-?} ${VERSION_ID:-?})"
  [ "$(uname -m)" = x86_64 ] || die "x86_64 only (found $(uname -m))"
}

install_packages() {
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -q
  # jq, openssl, zstd, git: used by ci.yml and the test scripts (the hosted image has them too).
  apt-get install -y -q ca-certificates curl git gnupg jq openssl tar gzip zstd coreutils \
    unattended-upgrades

  # Docker Engine from Docker's signed apt repository, with the buildx and compose plugins.
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc.new
  fpr=$(gpg --show-keys --with-colons /etc/apt/keyrings/docker.asc.new | awk -F: '/^fpr/ { print $10; exit }')
  [ "$fpr" = "$DOCKER_KEY_FINGERPRINT" ] || die "unexpected Docker signing key: $fpr"
  mv /etc/apt/keyrings/docker.asc.new /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  # shellcheck disable=SC1091
  . /etc/os-release
  echo "deb [arch=amd64 signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu ${VERSION_CODENAME} stable" \
    >/etc/apt/sources.list.d/docker.list
  apt-get update -q
  apt-get install -y -q docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  systemctl enable --now docker
}

create_user() {
  id "$RUNNER_USER" >/dev/null 2>&1 || useradd --create-home --shell /bin/bash "$RUNNER_USER"
  # The docker group is root on this VM. The VM is the trust boundary (ADR-M34 §2.2).
  # No sudo rule is ever added for this user.
  usermod -aG docker "$RUNNER_USER"
}

install_runner() {
  if [ -f "$RUNNER_DIR/.runner" ]; then
    echo "runner already registered in $RUNNER_DIR: keeping its files (it updates itself)"
  else
    archive="actions-runner-linux-x64-${RUNNER_VERSION}.tar.gz"
    tmp=$(mktemp -d)
    curl -fsSLo "$tmp/$archive" \
      "https://github.com/actions/runner/releases/download/v${RUNNER_VERSION}/${archive}"
    echo "$RUNNER_SHA256  $tmp/$archive" | sha256sum -c -
    install -d -o "$RUNNER_USER" -g "$RUNNER_USER" -m 0750 "$RUNNER_DIR"
    tar -xzf "$tmp/$archive" -C "$RUNNER_DIR"
    chown -R "$RUNNER_USER:$RUNNER_USER" "$RUNNER_DIR"
    rm -rf "$tmp"
    "$RUNNER_DIR/bin/installdependencies.sh"
  fi
}

install_hooks() {
  # Owned by root; the runner reads their paths from its .env file.
  install -d -m 0755 "$LIB_DIR"
  for f in clean-docker.sh job-started.sh job-completed.sh; do
    install -m 0755 "$here/$f" "$LIB_DIR/$f"
  done
  envfile="$RUNNER_DIR/.env"
  touch "$envfile"
  sed -i '/^ACTIONS_RUNNER_HOOK_JOB_\(STARTED\|COMPLETED\)=/d' "$envfile"
  {
    echo "ACTIONS_RUNNER_HOOK_JOB_STARTED=$LIB_DIR/job-started.sh"
    echo "ACTIONS_RUNNER_HOOK_JOB_COMPLETED=$LIB_DIR/job-completed.sh"
  } >>"$envfile"
  chown "$RUNNER_USER:$RUNNER_USER" "$envfile"

  # Daily: remove unused images and build cache (kept between jobs to limit Docker Hub pulls).
  install -m 0644 "$here/sdlc-ci-prune.service" /etc/systemd/system/sdlc-ci-prune.service
  install -m 0644 "$here/sdlc-ci-prune.timer" /etc/systemd/system/sdlc-ci-prune.timer
  systemctl daemon-reload
  systemctl enable --now sdlc-ci-prune.timer
}

read_token() {
  printf '%s token (input hidden): ' "$1" >&2
  IFS= read -rs token
  echo >&2
  [ -n "$token" ] || die "empty token"
}

cmd_install() {
  need_root install
  check_host
  install_packages
  create_user
  install_runner
  install_hooks
  echo "Installed. Next: sudo bash $0 register (runbook step 3)."
}

cmd_register() {
  need_root register
  [ -x "$RUNNER_DIR/config.sh" ] || die "run 'install' first"
  [ ! -f "$RUNNER_DIR/.runner" ] || die "already registered; run 'remove' first to register again"
  read_token Registration
  (cd "$RUNNER_DIR" && sudo -u "$RUNNER_USER" ./config.sh --unattended \
    --url "$REPO_URL" --token "$token" \
    --name "${RUNNER_NAME:-$(hostname -s)}" --labels "$RUNNER_LABEL" --work _work)
  unset token
  (cd "$RUNNER_DIR" && ./svc.sh install "$RUNNER_USER" && ./svc.sh start)
  echo "Registered with label '$RUNNER_LABEL'. Next: runbook step 4 (set CI_RUNNER)."
}

cmd_remove() {
  need_root remove
  [ -f "$RUNNER_DIR/.runner" ] || die "no registered runner in $RUNNER_DIR"
  read_token Removal
  (cd "$RUNNER_DIR" && ./svc.sh stop || true)
  (cd "$RUNNER_DIR" && ./svc.sh uninstall || true)
  (cd "$RUNNER_DIR" && sudo -u "$RUNNER_USER" ./config.sh remove --token "$token")
  unset token
  echo "Removed. Delete the repository variable CI_RUNNER if it is still set (runbook step 7)."
}

cmd_status() {
  if [ -x "$RUNNER_DIR/svc.sh" ] && [ -f "$RUNNER_DIR/.runner" ]; then
    (cd "$RUNNER_DIR" && ./svc.sh status) || true
  else
    echo "runner: not registered"
  fi
  docker info --format 'docker: {{.ServerVersion}}, containers: {{.Containers}}, images: {{.Images}}' || true
  df -h /
}

case "${1:-}" in
  install) cmd_install ;;
  register) cmd_register ;;
  remove) cmd_remove ;;
  status) cmd_status ;;
  *) die "usage: sudo bash $0 install|register|remove|status" ;;
esac
